import { randomUUID } from "node:crypto";
import type { Basic, Bundle, Resource, Observation } from "@medplum/fhirtypes";
import type { HpiEndpointDeps } from "../../src/clinical-graph/hpi-endpoint.js";
import { buildHpiFindingDefinition } from "../../src/clinical-graph/hpi-definition.js";
const patientReference = "Patient/ros-test";
const earlier = "2026-09-05T12:00:00Z";
export function historyRosFixture(rows: Resource[] = []) {
  const transactions: Bundle[] = [];
  const searches: Record<string, string>[] = [];
  const events: string[] = [];
  let now = earlier;
  let conflictStatus = "412";
  let thrownConflict = false;
  let beforeTransaction: (() => void) | undefined;
  let transactionAttempts = 0;
  let transactionFailureAt: number | undefined;
  const baseUrl = "http://localhost:18103/";
  function page<T extends Resource>(type: T["resourceType"], params: Record<string, string>): Bundle<T> {
    searches.push(params);
    const matches = rows.filter((resource): resource is Observation => resource.resourceType === type).filter(row =>
      (!params._id || row.id === params._id) &&
      (!params.subject || row.subject?.reference === params.subject) &&
      (!params.encounter || row.encounter?.reference === params.encounter) &&
      (!params.identifier || row.identifier?.some(c => `${c.system}|${c.value}` === params.identifier)) &&
      (!params.code || row.code.coding?.some(c => `${c.system}|${c.code}` === params.code)) &&
      (!params["category:not"] || !row.category?.some(c => c.coding?.some(v => `${v.system}|${v.code}` === params["category:not"])))
    );
    const count = Number(params._count ?? 20), start = Number(params._offset ?? 0);
    return { resourceType: "Bundle", type: "searchset", entry: matches.slice(start, start + count).map(resource => ({ resource: structuredClone(resource) as unknown as T })),
      ...(start + count < matches.length ? { link: [{ relation: "next", url: `${baseUrl}fhir/R4/${type}?${new URLSearchParams({ ...params, _offset: String(start + count) })}` }] } : {}) };
  }
  const fhir = {
    baseUrl,
    read: async <T extends Resource>(type: T["resourceType"], id: string) => (type === "Encounter" ? { resourceType: "Encounter", id, status: "in-progress", period: { start: earlier }, subject: { reference: patientReference } } : structuredClone(rows.find(row => row.resourceType === type && row.id === id))) as T,
    search: async <T extends Resource>(type: T["resourceType"], params: Record<string, string> = {}) => page<T>(type, params),
    searchUrl: async <T extends Resource>(url: string, type: T["resourceType"]) => page<T>(type, Object.fromEntries(new URL(url, baseUrl).searchParams)),
    create: async (row: Basic, headers?: Record<string, string>) => {
      events.push(`create:${row.resourceType}`);
      const identifier = new URLSearchParams(headers?.["If-None-Exist"] ?? "").get("identifier");
      const existing = rows.find(resource => resource.resourceType === "Basic" && identifier && resource.identifier?.some(value => `${value.system}|${value.value}` === identifier));
      if (existing) return structuredClone(existing) as Basic;
      const saved = { ...structuredClone(row), id: row.id ?? randomUUID(), meta: { versionId: randomUUID() } };
      rows.push(saved); return structuredClone(saved);
    },
    update: async (_type: "Basic" | "Encounter", id: string, row: Basic) => {
      events.push(`update:${row.resourceType}`);
      const existing = rows.find(resource => resource.resourceType === row.resourceType && resource.id === id);
      const saved = { ...structuredClone(row), id, meta: { ...row.meta, versionId: randomUUID() } };
      if (existing) rows.splice(rows.indexOf(existing), 1, saved); else rows.push(saved);
      return structuredClone(saved);
    },
    executeTransaction: async (bundle: Bundle): Promise<Bundle> => {
      transactionAttempts += 1; events.push("transaction");
      beforeTransaction?.(); beforeTransaction = undefined;
      if (transactionAttempts === transactionFailureAt) throw new Error("Synthetic transaction failure");
      transactions.push(structuredClone(bundle));
      const entries: NonNullable<Bundle["entry"]> = [];
      for (const entry of bundle.entry ?? []) {
        if (!entry.resource) {
          entries.push({ response: { status: "201", location: `Provenance/${randomUUID()}/_history/1` } }); continue;
        }
        const resource = structuredClone(entry.resource);
        const query = entry.request?.ifNoneExist
          ? new URLSearchParams(entry.request.ifNoneExist).get("identifier")
          : new URL(entry.request!.url!, baseUrl).searchParams.get("identifier");
        const existing = rows.find(row => query ? (row as Observation).identifier?.some(v => `${v.system}|${v.value}` === query) : Boolean(resource.id) && row.id === resource.id && row.resourceType === resource.resourceType);
        if (existing && entry.request?.ifMatch && entry.request.ifMatch !== `W/"${existing.meta?.versionId}"`) {
          if (thrownConflict) throw Object.assign(new Error("Synthetic transaction conflict"), { status: Number(conflictStatus) });
          return { resourceType: "Bundle", type: "transaction-response", entry: [{ response: { status: conflictStatus } }] };
        }
        const saved = entry.request?.ifNoneExist && existing
          ? existing
          : { ...resource, id: existing?.id ?? resource.id ?? randomUUID(), meta: { versionId: randomUUID() } };
        if (saved !== existing) { if (existing) rows.splice(rows.indexOf(existing), 1, saved); else rows.push(saved); }
        entries.push({ resource: structuredClone(saved), response: { status: existing ? "200" : "201", location: `${saved.resourceType}/${saved.id}/_history/${saved.meta.versionId}` } });
      }
      return { resourceType: "Bundle", type: "transaction-response", entry: entries };
    },
  };
  const definition = buildHpiFindingDefinition({ source: "manual", recordedAt: earlier, actorReference: "Practitioner/test" });
  (definition.valueSchema.fields.reviewOfSystems as any).options.push({ code: "headache", display: "Headache", category: "general", active: true });
  const deps: HpiEndpointDeps = { findingDefinitions: () => [definition], authenticate: async () => ({ staffReference: "Practitioner/test", actorRole: "provider", fhir }), now: () => now };
  return { deps, rows, transactions, searches, events,
    failTransactionAt: (attempt?: number) => { transactionFailureAt = attempt; },
    transactionAttempts: () => transactionAttempts,
    conflictStatus: (value: string, throws = false) => { conflictStatus = value; thrownConflict = throws; },
    time: (value: string) => { now = value; }, race: (fn: () => void) => { beforeTransaction = fn; } };
}
