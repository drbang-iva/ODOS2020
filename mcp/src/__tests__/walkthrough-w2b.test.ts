import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, Condition, Encounter, Resource } from "@medplum/fhirtypes";
import { handleVisitChargeMutationRequest } from "../clinical-graph/protocol-endpoint.js";
import type { ChargeProposal } from "../clinical-graph/protocol-types.js";
import { ICD10_CM_CODE_SYSTEM } from "../clinical-graph/glaucoma-suspect.js";
class MemoryFhir {
  readonly baseUrl = "http://localhost:8103/";
  resources: Resource[] = [];
  next = 1;

  async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
    const resource = this.resources.find((row) => row.resourceType === resourceType && row.id === id);
    if (!resource) {
      const error = new Error(`${resourceType}/${id} not found`);
      (error as Error & { status?: number }).status = 404;
      throw error;
    }
    return structuredClone(resource) as T;
  }

  async search<T extends Resource>(
    resourceType: T["resourceType"],
    params: Record<string, string> = {},
  ): Promise<Bundle<T>> {
    let rows = this.resources.filter((row) => row.resourceType === resourceType);
    const code = params.code?.split("|");
    if (code?.[1]) {
      rows = rows.filter((row) => resourceCodings(row).some((coding) =>
        coding.system === code[0] && coding.code === code[1]
      ));
    }
    const identifier = params.identifier?.split("|");
    if (identifier?.[1]) {
      rows = rows.filter((row) => resourceIdentifiers(row).some((value) =>
        value.system === identifier[0] && value.value === identifier[1]
      ));
    }
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: rows.map((resource) => ({ resource: structuredClone(resource) as T })),
    };
  }

  async searchUrl<T extends Resource>(): Promise<Bundle<T>> {
    return { resourceType: "Bundle", type: "searchset", entry: [] };
  }

  async create<T extends Resource>(resource: T, headers?: Record<string, string>): Promise<T> {
    const conditional = headers?.["If-None-Exist"]?.replace(/^identifier=/, "").split("|");
    if (conditional?.[1] && "identifier" in resource) {
      const existing = this.resources.find((row) => resourceIdentifiers(row).some((value) =>
        value.system === conditional[0] && value.value === conditional[1]
      ));
      if (existing) return structuredClone(existing) as T;
    }
    const saved = { ...structuredClone(resource), id: resource.id ?? `resource-${this.next++}` } as T;
    this.resources.push(saved);
    return structuredClone(saved);
  }

  async update<T extends Resource>(
    resourceType: T["resourceType"],
    id: string,
    resource: T,
  ): Promise<T> {
    const saved = { ...structuredClone(resource), id } as T;
    const index = this.resources.findIndex((row) => row.resourceType === resourceType && row.id === id);
    if (index < 0) throw new Error(`${resourceType}/${id} not found for update`);
    this.resources[index] = saved;
    return structuredClone(saved);
  }
}

function resourceIdentifiers(resource: Resource): Array<{ system?: string; value?: string }> {
  if (!("identifier" in resource) || !resource.identifier) return [];
  return Array.isArray(resource.identifier) ? resource.identifier : [resource.identifier];
}

function resourceCodings(resource: Resource): Array<{ system?: string; code?: string }> {
  const code = (resource as Resource & { code?: unknown }).code;
  if (!code || typeof code !== "object" || !("coding" in code)) return [];
  const coding = (code as { coding?: unknown }).coding;
  return Array.isArray(coding) ? coding : [];
}


type Diagnosis = { id: string; rank: number; code?: string; missing?: boolean };
async function pointers(procedureConceptKey: string, diagnoses: Diagnosis[]) {
  const fhir = new MemoryFhir();
  fhir.resources.push({ resourceType: "Encounter", id: "visit", status: "in-progress",
    class: { code: "AMB" }, subject: { reference: "Patient/synthetic" },
    diagnosis: diagnoses.map(({ id, rank }) => ({ condition: { reference: `Condition/${id}` }, rank })),
  } satisfies Encounter);
  for (const dx of diagnoses) if (!dx.missing) fhir.resources.push({
    resourceType: "Condition", id: dx.id, subject: { reference: "Patient/synthetic" },
    encounter: { reference: "Encounter/visit" },
    code: dx.code ? { coding: [{ system: ICD10_CM_CODE_SYSTEM, code: dx.code }] } : { text: "Synthetic diagnosis" },
  } satisfies Condition);
  const result = await handleVisitChargeMutationRequest({ authenticate: async () => ({
    staffReference: "Practitioner/provider", actorRole: "provider" as const, fhir,
  }) }, { authHeader: "Bearer synthetic", params: { encounterId: "visit" }, body: { procedureConceptKey } });
  assert.equal(result.status, 200);
  return (result.body as { proposal: ChargeProposal }).proposal.dxPointers;
}
const myopia = { id: "myopia", rank: 1, code: "H52.13" };
const medical = { id: "glaucoma", rank: 2, code: "H40.023" };
test("W2b G1 eye code prefers medical", async () => {
  assert.deepEqual(await pointers("comprehensive-exam-new", [myopia, medical]), ["Condition/glaucoma"]);
});
test("W2b G2 E/M prefers medical", async () => {
  assert.deepEqual(await pointers("office-visit-new-low", [myopia, medical]), ["Condition/glaucoma"]);
});
test("W2b G3 G6 eye code falls back to the lowest-ranked refractive diagnosis", async () => {
  const presbyopia = { id: "presbyopia", rank: 2, code: "H52.4" };
  assert.deepEqual(await pointers("comprehensive-exam-new", [presbyopia, myopia]), ["Condition/myopia"]);
  assert.deepEqual(await pointers("comprehensive-exam-new", [{ ...myopia, rank: 3 }, presbyopia]), ["Condition/presbyopia"]);
});
test("W2b G4a vision plan prefers refractive", async () => {
  assert.deepEqual(await pointers("routine-vision-exam-new", [{ ...medical, rank: 1 }, { ...myopia, rank: 2 }]), ["Condition/myopia"]);
});
test("W2b G4b vision plan with only medical has no default", async () => {
  assert.deepEqual(await pointers("routine-vision-exam-new", [{ ...medical, rank: 1 }]), []);
});
test("W2b G5 irregular astigmatism and aniseikonia are medical", async () => {
  for (const code of ["H52.213", "H52.32"]) assert.deepEqual(await pointers("routine-vision-exam-new", [{ id: "medical", rank: 1, code }]), []);
});
test("W2b G5 other and unspecified refraction are refractive", async () => {
  for (const code of ["H52.6", "H52.7"]) assert.deepEqual(await pointers("routine-vision-exam-new", [{ ...medical, rank: 1 }, { id: "refraction", rank: 2, code }]), ["Condition/refraction"]);
});
test("W2b G7 unclassified text and unreadable Conditions preserve rank one", async () => {
  for (const missing of [false, true]) for (const family of ["comprehensive-exam-new", "office-visit-new-low", "routine-vision-exam-new"]) {
    assert.deepEqual(await pointers(family, [{ id: "unknown", rank: 1, missing }]), ["Condition/unknown"]);
    assert.deepEqual(await pointers(family, [{ id: "unknown", rank: 1, missing }, { ...myopia, rank: 2 }]), ["Condition/myopia"]);
    assert.deepEqual(await pointers(family, [{ id: "unknown", rank: 2, missing }]), []);
  }
});
