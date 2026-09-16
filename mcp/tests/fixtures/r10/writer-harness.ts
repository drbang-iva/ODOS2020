import { randomUUID } from "node:crypto";
import type { Bundle, Condition, Observation, Resource } from "@medplum/fhirtypes";
import type { MedplumClient } from "../../../src/fhir-client.js";
import { currentFindingIdentifier, type CurrentFindingKey } from "../../../src/clinical-graph/current-finding-identity.js";
import { projectCurrentFindings, type FindingBaseline } from "../../../src/clinical-graph/current-finding-reader.js";
import { atomic, catalog, comp, definitions, lens, lensField, nuclear, state } from "./factories.js";

export const keyFor = (eye: "OD" | "OS" = "OD", optionCode = nuclear.optionCode): CurrentFindingKey =>
  ({ v: 1, patientId: "p1", encounterId: "e1", stableKey: lens.stableKey, fieldCode: lensField, optionCode, eye });
export const endState = (extra = {}) => ({ status: "live" as const, presence: "present" as const, qualifiers: {}, homes: [], ...extra });
export const factTarget = (key = keyFor(), baseline: unknown = { kind: "absent", key }, value = endState()) =>
  ({ kind: "fact" as const, key, baseline, state: value });
export const command = (targets: unknown[], commandId = randomUUID()) =>
  ({ commandId, patientReference: "Patient/p1", encounterReference: "Encounter/e1", surface: "r10-test", targets });
export function canonicalFact(id = "canonical", eye: "OD" | "OS" = "OD"): Observation {
  const key = keyFor(eye);
  return { ...atomic(id, eye), identifier: [currentFindingIdentifier(key)], component: [comp("R10_CURRENT_META", JSON.stringify(key))] };
}
export function factBaseline(observations: Observation[], eye = "OD", conditions: Condition[] = []): FindingBaseline {
  const fact = projectCurrentFindings(state(observations, { conditions })).currentFacts.find(f => f.eye === eye);
  if (!fact?.baseline) throw new Error("Fixture has no actionable baseline.");
  return fact.baseline;
}
export const httpError = (status: number) => Object.assign(new Error(`Synthetic HTTP ${status}`), { status });
type Write = { method: "POST" | "PUT"; resource: Resource; headers: Record<string, string> };
export function memoryFhir(initial: Resource[] = []) {
  const resources = new Map(initial.map(r => [`${r.resourceType}/${r.id}`, structuredClone(r)]));
  const writes: Write[] = [];
  const searches: Array<{ type: string; params: Record<string, string> }> = [];
  const hooks: {
    beforeWrite?: (write: Write) => void | Promise<void>;
    afterWrite?: (write: Write, stored: Resource) => void | Promise<void>;
    beforeRead?: (type: string, id: string) => void;
    beforeSearch?: (type: string, params: Record<string, string>) => void;
  } = {};
  const all = <T extends Resource>(type: T["resourceType"]) => [...resources.values()].filter(r => r.resourceType === type) as T[];
  const matching = (r: Resource, params: Record<string, string>) => Object.entries(params).every(([name, value]) => {
    if (name.startsWith("_") && name !== "_tag") return true;
    if (name === "encounter") return (r as Observation).encounter?.reference === value;
    if (name === "subject" || name === "patient") return (r as Observation).subject?.reference === value;
    const tokens = name === "_tag" ? r.meta?.tag?.map(t => `${t.system}|${t.code}`) : (r as Observation).identifier?.map(i => `${i.system}|${i.value}`);
    return value.split(",").some(v => tokens?.includes(v));
  });
  const save = <T extends Resource>(r: T): T => {
    const stored = { ...structuredClone(r), id: r.id ?? randomUUID(), meta: { ...r.meta, versionId: randomUUID() } };
    resources.set(`${stored.resourceType}/${stored.id}`, stored);
    return structuredClone(stored);
  };
  const fhir: Pick<MedplumClient, "baseUrl" | "read" | "search" | "searchUrl" | "createWithOutcome" | "update"> = {
    baseUrl: "http://localhost:8103/",
    async read<T extends Resource>(type: T["resourceType"], id: string): Promise<T> {
      hooks.beforeRead?.(type, id);
      const result = resources.get(`${type}/${id}`);
      if (!result) throw httpError(404);
      return structuredClone(result) as T;
    },
    async search<T extends Resource>(type: T["resourceType"], params: Record<string, string> = {}): Promise<Bundle<T>> {
      searches.push({ type, params }); hooks.beforeSearch?.(type, params);
      return { resourceType: "Bundle", type: "searchset", entry: all<T>(type).filter(r => matching(r, params)).map(resource => ({ resource: structuredClone(resource) })) };
    },
    async createWithOutcome<T extends Resource>(resource: T, headers = {}) {
      const write: Write = { method: "POST", resource: structuredClone(resource), headers };
      writes.push(write); await hooks.beforeWrite?.(write);
      const query = headers["If-None-Exist"];
      if (query) {
        const found = all<T>(resource.resourceType).filter(r => matching(r, Object.fromEntries(new URLSearchParams(query))));
        if (found.length > 1) throw httpError(412);
        if (found.length) return { resource: structuredClone(found[0]), created: false };
      }
      const stored = save(resource); await hooks.afterWrite?.(write, stored);
      return { resource: stored, created: true };
    },
    async update<T extends Resource>(type: T["resourceType"], id: string, resource: T, headers = {}): Promise<T> {
      const write: Write = { method: "PUT", resource: structuredClone(resource), headers };
      writes.push(write); await hooks.beforeWrite?.(write);
      const current = resources.get(`${type}/${id}`);
      if (!current) throw httpError(404);
      if (headers["If-Match"] && headers["If-Match"] !== `W/"${current.meta?.versionId}"`) throw httpError(412);
      const stored = save({ ...resource, id }); await hooks.afterWrite?.(write, stored);
      return stored;
    },
  };
  return { fhir, resources, all, writes, searches, hooks, save };
}
export const writerContext = (memory: ReturnType<typeof memoryFhir>) => ({ fhir: memory.fhir, definitions, catalog,
  staffReference: "Practitioner/synthetic", now: () => "2026-09-16T12:00:00.000Z" });
