import assert from "node:assert/strict";
import { buildFindingDefinitionSeeds } from "../src/clinical-graph/finding-definition-store.js";
import { materializeAtomicFindingCatalog } from "../src/clinical-graph/diagnosis-findings-endpoint.js";
import { executeFindingCommand, type FindingCommandTarget } from "../src/clinical-graph/current-finding-writer.js";
import { randomUUID } from "node:crypto";
import type {
  Basic,
  Bundle,
  Condition,
  Encounter,
  Observation,
  OperationOutcome,
  Resource,
} from "@medplum/fhirtypes";
import type { PracticeRoleId } from "../src/authz/roles.js";
import type { EncounterVoidEndpointDeps } from "../src/clinical-graph/encounter-void-endpoint.js";
import { buildEncounterComplaintResource } from "../src/clinical-graph/encounter-complaint-store.js";
import type { ClinicalFindingDefinition } from "../src/clinical-graph/glaucoma-suspect.js";
import { ODOS_OPHTHALMOLOGY_CODE_SYSTEM } from "../src/fhir/ophthalmology/codeBindings.js";
import { ODOS_EXTENSION_URLS } from "../src/fhir/ophthalmology/extensions.js";
import { clinicalStatusConcept, verificationStatusConcept } from "../src/fhir/condition.js";

/**
 * Shared fixture for the pre-finalization void / undo endpoint suites.
 *
 * The in-memory FHIR fake is DELIBERATELY PERMISSIVE: its `search()` does not honour the
 * `encounter` parameter, so every encounter-boundary guard in these suites can only pass
 * through the endpoint's own check. See the note on `search()` below and the PR #499/#500
 * evaluation records for why that matters.
 */

export const AUTH = "Bearer good";
export const NOW = "2026-09-01T15:00:00.000Z";
export const ENCOUNTER = "Encounter/e1";
export const PATIENT = "Patient/p1";

export type VoidBody = {
  voided: string[];
  count: number;
  sections: Array<{ sectionKey: string; label: string; count: number }>;
  preview: boolean;
  voidActionId?: string;
  error?: string;
};

export function fixture(options: {
  role?: PracticeRoleId;
  encounterStatus?: Encounter["status"];
  diagnoses?: string[];
  reasonText?: string;
} = {}) {
  const fhir = new MemoryFhir();
  fhir.add({
    resourceType: "Encounter",
    id: "e1",
    status: options.encounterStatus ?? "in-progress",
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
    subject: { reference: PATIENT },
    meta: { versionId: "1" },
    ...(options.diagnoses ? { diagnosis: options.diagnoses.map((reference) => ({ condition: { reference } })) } : {}),
    ...(options.reasonText ? { reasonCode: [{ text: options.reasonText }] } : {}),
  } satisfies Encounter);
  const deps: EncounterVoidEndpointDeps = {
    authenticate: async (header) => header === AUTH ? {
      staffReference: "Practitioner/doc1",
      actorRole: options.role ?? "provider",
      fhir,
    } : null,
    findingDefinitions: () => buildFindingDefinitionSeeds(),
    now: () => NOW,
  };
  return { deps, fhir };
}

export class MemoryFhir {
  readonly baseUrl = "memory://fhir";
  private resources: Resource[] = [];
  readonly transactions: Bundle[] = [];
  beforeTransaction?: () => void;
  readonly writes: Array<{ method: string; resource: Resource }> = [];
  beforeWrite?: (resource: Resource) => void;
  /** `ResourceType/id` → status code the next read of it throws with (503 for an outage, 404 for a dangling reference). */
  readonly failedReads = new Map<string, number>();
  /**
   * Medplum WITHOUT the `transaction-bundles` project feature (this stack): an entry this
   * returns a refusal for comes back with that status and outcome INSIDE the
   * transaction-response, while every other entry is applied. Nothing is rolled back.
   */
  refuse?: (entry: NonNullable<Bundle["entry"]>[number], index: number) => { status: string; outcome?: OperationOutcome } | undefined;
  private sequence = 0;

  add<T extends Resource>(resource: T): T {
    const stored = structuredClone(resource);
    if (!stored.meta?.versionId) stored.meta = { ...stored.meta, versionId: "1" };
    this.resources.push(stored);
    return stored;
  }

  replace<T extends Resource>(resource: T): void {
    const index = this.resources.findIndex((row) => row.resourceType === resource.resourceType && row.id === resource.id);
    assert.ok(index >= 0, `replace: missing ${resource.resourceType}/${resource.id}`);
    this.resources[index] = structuredClone(resource);
  }

  get<T extends Resource>(resourceType: T["resourceType"], id: string): T {
    const resource = this.resources.find((row) => row.resourceType === resourceType && row.id === id);
    assert.ok(resource, `missing ${resourceType}/${id}`);
    return structuredClone(resource as T);
  }

  all<T extends Resource>(resourceType: T["resourceType"]): T[] {
    return this.resources.filter((row): row is T => row.resourceType === resourceType).map((row) => structuredClone(row));
  }

  async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
    const failure = this.failedReads.get(`${resourceType}/${id}`);
    if (failure) throw Object.assign(new Error(`FHIR ${failure} reading ${resourceType}/${id}`), { status: failure });
    const resource = this.resources.find((row) => row.resourceType === resourceType && row.id === id);
    if (!resource) throw Object.assign(new Error(`Missing ${resourceType}/${id}`), { status: 404 });
    return structuredClone(resource as T);
  }

  /** Every search the endpoint issued, so a test can pin the parameters it relies on. */
  readonly searches: Array<{ resourceType: string; params: Record<string, string> }> = [];

  async search<T extends Resource>(resourceType: T["resourceType"], params: Record<string, string> = {}): Promise<Bundle<T>> {
    this.searches.push({ resourceType, params: { ...params } });
    // Deliberately permissive: this fake does NOT honour the `encounter` parameter. The encounter
    // boundary is the endpoint's own responsibility (its in-memory check), and guard 5 must fail
    // when that check is dropped. A fake that filtered by encounter here would be doing the
    // endpoint's job for it and turned guard 5 decorative — which is exactly what happened at
    // 3192a0ba. Real Medplum does filter; the endpoint's check is the defence in depth this
    // test exists to protect.
    const rows = this.resources.filter((resource) => {
      if (resource.resourceType !== resourceType) return false;
      if (params.code) {
        const [system, code] = params.code.split("|");
        const coded = (resource as Basic | Condition | Observation).code?.coding?.some((coding) =>
          coding.system === system && coding.code === code
        );
        if (!coded) return false;
      }
      if (params.subject && (resource as Basic | Condition | Observation).subject?.reference !== params.subject) return false;
      if (params.identifier && !(resource as Observation).identifier?.some(i => params.identifier.split(",").includes(`${i.system}|${i.value}`))) return false;
      if (params._tag && !resource.meta?.tag?.some(t => params._tag.split(",").includes(`${t.system}|${t.code}`))) return false;
      if (params["status:not"] && (resource as Observation).status === params["status:not"]) return false;
      return true;
    });
    return { resourceType: "Bundle", type: "searchset", entry: rows.map((resource) => ({ resource: structuredClone(resource) as T })) };
  }

  async createWithOutcome<T extends Resource>(resource: T, headers: Record<string,string> = {}): Promise<{resource:T;created:boolean}> {
    this.writes.push({method:"POST",resource:structuredClone(resource)});
    this.beforeWrite?.(resource);
    if (headers["If-None-Exist"]) {
      const found=(await this.search<T>(resource.resourceType,Object.fromEntries(new URLSearchParams(headers["If-None-Exist"])))).entry ?? [];
      if(found.length > 1) throw Object.assign(new Error("FHIR 412"),{status:412});
      if(found.length) return {resource:found[0].resource!,created:false};
    }
    return {resource:this.add({...resource,id:resource.id ?? `${resource.resourceType.toLowerCase()}-${++this.sequence}`,meta:{...resource.meta,versionId:"1"}}),created:true};
  }

  async update<T extends Resource>(type:T["resourceType"],id:string,resource:T,headers:Record<string,string> = {}):Promise<T> {
    this.writes.push({method:"PUT",resource:structuredClone(resource)});
    this.beforeWrite?.(resource);
    const current=await this.read<T>(type,id);
    if(headers["If-Match"] && headers["If-Match"]!==`W/"${current.meta?.versionId}"`) throw Object.assign(new Error("FHIR 412"),{status:412});
    const next={...resource,id,meta:{...resource.meta,versionId:String(Number(current.meta?.versionId ?? "0")+1)}};
    this.replace(next);
    return structuredClone(next);
  }

  async executeTransaction(bundle: Bundle): Promise<Bundle> {
    this.beforeTransaction?.();
    this.beforeTransaction = undefined;
    // Validate every entry before applying any, so a conflict leaves the store untouched (atomic).
    const staged: Array<() => NonNullable<Bundle["entry"]>[number]> = [];
    for (const entry of bundle.entry ?? []) {
      const resource = structuredClone(entry.resource);
      const request = entry.request;
      if (!resource || !request) throw new Error("transaction entry without resource/request");
      if (request.method === "PUT") {
        const match = request.url?.match(/^([A-Za-z]+)\/([^/?]+)$/);
        if (!match) throw new Error(`unsupported PUT url ${request.url}`);
        const [, resourceType, id] = match;
        const index = this.resources.findIndex((row) => row.resourceType === resourceType && row.id === id);
        if (index < 0) throw Object.assign(new Error(`Missing ${resourceType}/${id}`), { status: 404 });
        const currentVersion = this.resources[index]!.meta?.versionId;
        if (request.ifMatch && request.ifMatch !== `W/"${currentVersion}"`) {
          throw Object.assign(new Error("FHIR 412 Precondition Failed"), { status: 412 });
        }
        staged.push(() => {
          const versionId = String(Number(currentVersion ?? "0") + 1);
          this.resources[index] = { ...resource, id, meta: { ...resource.meta, versionId } } as Resource;
          return { response: { status: "200 OK", location: `${resourceType}/${id}/_history/${versionId}` } };
        });
        continue;
      }
      if (request.method === "POST") {
        staged.push(() => {
          const id = `${resource.resourceType.toLowerCase()}-${++this.sequence}`;
          this.resources.push({ ...resource, id, meta: { versionId: "1" } } as Resource);
          return { response: { status: "201 Created", location: `${resource.resourceType}/${id}/_history/1` } };
        });
        continue;
      }
      throw new Error(`unsupported method ${request.method}`);
    }
    this.transactions.push(structuredClone(bundle));
    return {
      resourceType: "Bundle",
      type: "transaction-response",
      entry: staged.map((apply, index) => {
        const refusal = this.refuse?.((bundle.entry ?? [])[index]!, index);
        return refusal
          ? { response: { status: refusal.status, ...(refusal.outcome ? { outcome: refusal.outcome } : {}) } }
          : apply();
      }),
    };
  }
}

export function definition(stableKey: string, sectionKey: string, display: string): ClinicalFindingDefinition {
  return {
    id: `finding-def-${stableKey}`,
    stableKey,
    display,
    sectionKey,
    anatomyTarget: "eye",
    valueSchema: {},
    normalSemantics: {},
    sourceStatus: "verified-seed",
    allowDiagnosisMapping: false,
    notBillReady: true,
    active: true,
    provenance: { source: "manual", recordedAt: NOW, actorReference: "Practitioner/pr1" },
  };
}

export function observation(id: string, code: string, eye: "OD" | "OS" | "UNKNOWN", extra: Partial<Observation> = {}): Observation {
  return {
    resourceType: "Observation",
    id,
    status: "final",
    code: { coding: [{ system: ODOS_OPHTHALMOLOGY_CODE_SYSTEM, code }] },
    subject: { reference: PATIENT },
    encounter: { reference: ENCOUNTER },
    effectiveDateTime: "2026-09-01T12:00:00.000Z",
    ...(eye === "UNKNOWN" ? {} : {
      extension: [{ url: ODOS_EXTENSION_URLS.eyeLaterality, valueCodeableConcept: { coding: [{ code: eye }] } }],
    }),
    component: [{ code: { coding: [{ code: `${eye}_CUSTOM_CVF` }] }, valueString: "full" }],
    ...extra,
  };
}

export function cvf(id: string, eye: "OD" | "OS", extra: Partial<Observation> = {}): Observation {
  return observation(id, "entrance:cvf", eye, extra);
}

export function condition(id: string, extra: Partial<Condition> = {}): Condition {
  return {
    resourceType: "Condition",
    id,
    subject: { reference: PATIENT },
    encounter: { reference: ENCOUNTER },
    code: { coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: "H52.13" }] },
    clinicalStatus: clinicalStatusConcept("active"),
    verificationStatus: verificationStatusConcept("confirmed"),
    ...extra,
  };
}

export function complaintResource(id: string, ordinal: number, status: "active" | "removed" = "active"): Basic {
  return {
    ...buildEncounterComplaintResource({
      id,
      encounterId: "e1",
      patientId: "p1",
      ordinal,
      complaintKey: "dry-eye",
      conditions: [],
      eyeLocation: "OU",
      qualities: [],
      treatmentsTried: [],
      additionalHistory: "",
      narrative: { mode: "automated" },
      resolvedDx: [],
      status,
      provenance: { source: "manual", recordedAt: "2026-09-01T09:00:00.000Z", actorReference: "Practitioner/doc1" },
      provenanceHistory: [],
    }),
    id: `basic-${id}`,
    meta: { versionId: "1" },
  };
}

export function administration(id: string, status: "completed" | "entered-in-error" = "completed") {
  return {
    resourceType: "MedicationAdministration" as const,
    id,
    status,
    subject: { reference: PATIENT },
    context: { reference: ENCOUNTER },
    medicationCodeableConcept: { text: "Tropicamide 1%" },
    effectiveDateTime: "2026-09-01T12:00:00.000Z",
  };
}


export async function writeFinding(fhir:MemoryFhir, target:FindingCommandTarget, definitions=buildFindingDefinitionSeeds()) {
  return executeFindingCommand({fhir,definitions,catalog:materializeAtomicFindingCatalog(definitions),staffReference:"Practitioner/doc1",now:()=>NOW},
    {commandId:randomUUID(),patientReference:PATIENT,encounterReference:ENCOUNTER,surface:"void-fixture",targets:[target]});
}

export async function seedCanonical(fhir:MemoryFhir,id:string,stableKey:string,eye:"OD"|"OS",optionIndex=0) {
  const catalog=materializeAtomicFindingCatalog(buildFindingDefinitionSeeds());
  const row=catalog.filter(r=>r.findingDefinitionKey===stableKey)[optionIndex];
  assert.ok(row,"real fixture option exists");
  const key={v:1 as const,patientId:"p1",encounterId:"e1",stableKey,fieldCode:row.fieldCode,optionCode:row.optionCode,eye};
  const isolated=new MemoryFhir();
  const result=await writeFinding(isolated,{kind:"fact",key,baseline:{kind:"absent",key},state:{status:"live",presence:"present",qualifiers:{},homes:[]}});
  assert.equal(result.complete,true,"real writer builds canonical fixture");
  const owner=isolated.all<Observation>("Observation")[0];
  // Preserve caller IDs for old scope assertions; markerless canonical owners are valid historical input.
  const canonical={...owner,id,component:owner.component?.filter(c=>!c.code.coding?.some(x=>x.code==="R10_OPERATION"))};
  return fhir.add(canonical);
}
