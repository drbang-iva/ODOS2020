import assert from "node:assert/strict";
import type {
  Basic,
  Bundle,
  Condition,
  Encounter,
  Observation,
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
    findingDefinitions: () => [
      definition("entrance:cvf", "entrance:cvf", "Confrontation visual fields"),
      definition("entrance:visual-field-defect", "entrance:visual-field-defect", "Visual Field"),
      definition("entrance:pupils", "entrance:pupils", "Pupils"),
      definition("entrance:dilation", "entrance:dilation", "Dilation"),
      definition("hpi_ros", "hpi", "History narrative and review of systems"),
      definition("intraocular_pressure", "tonometry", "Intraocular pressure"),
      definition("ocular-health:anterior:cornea", "ocular-health:anterior:cornea", "Cornea"),
      definition("ocular-health:anterior:lens", "ocular-health:anterior:lens", "Lens"),
    ],
    now: () => NOW,
  };
  return { deps, fhir };
}

export class MemoryFhir {
  readonly baseUrl = "memory://fhir";
  private resources: Resource[] = [];
  readonly transactions: Bundle[] = [];
  beforeTransaction?: () => void;
  /** `ResourceType/id` → status code the next read of it throws with (503 for an outage, 404 for a dangling reference). */
  readonly failedReads = new Map<string, number>();
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
      if (params["status:not"] && (resource as Observation).status === params["status:not"]) return false;
      return true;
    });
    return { resourceType: "Bundle", type: "searchset", entry: rows.map((resource) => ({ resource: structuredClone(resource) as T })) };
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
    return { resourceType: "Bundle", type: "transaction-response", entry: staged.map((apply) => apply()) };
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

