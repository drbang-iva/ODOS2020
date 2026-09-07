import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  Basic,
  Bundle,
  ChargeItem,
  Condition,
  Coverage,
  Encounter,
  Resource,
} from "@medplum/fhirtypes";
import { buildClaimDraft } from "../src/claims/claim-draft.js";
import { handleDiagnosisPickRequest } from "../src/clinical-graph/diagnosis-pick-endpoint.js";

interface DemotionImpact {
  strandedCharges: Array<{
    reference: string;
    display: string;
    amount?: { value?: number; currency?: string };
  }>;
  unaffectedChargeCount: number;
  strandedChargesComputed: boolean;
}

const EXPECTED_EXCLUSION_WARNING =
  "ChargeItem/charge-1 was excluded because it has no linked confirmed encounter diagnosis.";

test("A: a charge retaining another confirmed diagnosis is unaffected and remains in the claim draft", async () => {
  const fhir = diagnosisPickFhir();
  const first = await pick(fhir, "presbyopia", "confirm");
  const second = await pick(fhir, "diplopia", "confirm");
  const firstReference = conditionReference(first);
  const secondReference = conditionReference(second);
  const charge = addCharge(fhir, [firstReference, secondReference]);

  const result = await pick(fhir, "presbyopia", "possible");

  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(impact(result), {
    strandedCharges: [],
    unaffectedChargeCount: 1,
    strandedChargesComputed: true,
  });
  assert.deepEqual(await fhir.read<ChargeItem>("ChargeItem", charge.id!), charge);
  await signEncounter(fhir);
  const draft = await buildClaimDraft(fhir, "e1");
  assert.deepEqual(draft.charges.map(({ id }) => id), ["charge-1"]);
  assert.equal(draft.warnings, undefined);
});

test("B: possible reports a sole-pointer charge as stranded without changing it or hiding the successful pick", async () => {
  const fhir = diagnosisPickFhir();
  const confirmed = await pick(fhir, "presbyopia", "confirm");
  await pick(fhir, "diplopia", "confirm");
  const reference = conditionReference(confirmed);
  const charge = addCharge(fhir, [reference]);

  const result = await pick(fhir, "presbyopia", "possible");

  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(impact(result), {
    strandedCharges: [{
      reference: "ChargeItem/charge-1",
      display: "Synthetic procedure",
      amount: { value: 70.25, currency: "USD" },
    }],
    unaffectedChargeCount: 0,
    strandedChargesComputed: true,
  });
  assert.deepEqual(await fhir.read<ChargeItem>("ChargeItem", charge.id!), charge);
  const encounter = await fhir.read<Encounter>("Encounter", "e1");
  assert.equal(encounter.diagnosis?.some((entry) => entry.condition.reference === reference), true);
  await signEncounter(fhir);
  const draft = await buildClaimDraft(fhir, "e1");
  assert.deepEqual(draft.charges, []);
  assert.deepEqual(draft.warnings, [EXPECTED_EXCLUSION_WARNING]);
});

test("C: demoting a diagnosis with no linked charge returns the complete empty impact shape", async () => {
  const fhir = diagnosisPickFhir();
  await pick(fhir, "presbyopia", "confirm");

  const result = await pick(fhir, "presbyopia", "possible");

  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(impact(result), {
    strandedCharges: [],
    unaffectedChargeCount: 0,
    strandedChargesComputed: true,
  });
});

test("a sole-pointer charge on a later search page is still reported as stranded", async () => {
  const fhir = diagnosisPickFhir(new PagedImpactFhir());
  const confirmed = await pick(fhir, "presbyopia", "confirm");
  const charge = addCharge(fhir, [conditionReference(confirmed)]);
  fhir.chargeFirstPageIds = new Set();
  fhir.paginateImpact = true;

  const result = await pick(fhir, "presbyopia", "possible");

  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(impact(result), {
    strandedCharges: [{
      reference: "ChargeItem/charge-1",
      display: "Synthetic procedure",
      amount: { value: 70.25, currency: "USD" },
    }],
    unaffectedChargeCount: 0,
    strandedChargesComputed: true,
  });
  assert.deepEqual(await fhir.read<ChargeItem>("ChargeItem", charge.id!), charge);
});

test("a confirmed diagnosis on a later search page keeps a multi-pointer charge unaffected", async () => {
  const fhir = diagnosisPickFhir(new PagedImpactFhir());
  const first = await pick(fhir, "presbyopia", "confirm");
  const second = await pick(fhir, "diplopia", "confirm");
  addCharge(fhir, [conditionReference(first), conditionReference(second)]);
  fhir.conditionFirstPageIds = new Set([(first.body as { condition: Condition }).condition.id!]);
  fhir.paginateImpact = true;

  const result = await pick(fhir, "presbyopia", "possible");

  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(impact(result), {
    strandedCharges: [],
    unaffectedChargeCount: 1,
    strandedChargesComputed: true,
  });
});

test("D: discard reports a sole-pointer charge as stranded under the same contract", async () => {
  const fhir = diagnosisPickFhir();
  const confirmed = await pick(fhir, "presbyopia", "confirm");
  await pick(fhir, "diplopia", "confirm");
  const charge = addCharge(fhir, [conditionReference(confirmed)]);

  const result = await pick(fhir, "presbyopia", "discard");

  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(impact(result), {
    strandedCharges: [{
      reference: "ChargeItem/charge-1",
      display: "Synthetic procedure",
      amount: { value: 70.25, currency: "USD" },
    }],
    unaffectedChargeCount: 0,
    strandedChargesComputed: true,
  });
  assert.deepEqual(await fhir.read<ChargeItem>("ChargeItem", charge.id!), charge);
});

test("E: re-confirming a demoted diagnosis returns the unchanged charge to the claim draft", async () => {
  const fhir = diagnosisPickFhir();
  const confirmed = await pick(fhir, "presbyopia", "confirm");
  await pick(fhir, "diplopia", "confirm");
  const charge = addCharge(fhir, [conditionReference(confirmed)]);
  await pick(fhir, "presbyopia", "possible");

  const reconfirmed = await pick(fhir, "presbyopia", "confirm");

  assert.equal(reconfirmed.status, 200, JSON.stringify(reconfirmed.body));
  assert.deepEqual(impact(reconfirmed), {
    strandedCharges: [],
    unaffectedChargeCount: 0,
    strandedChargesComputed: true,
  });
  assert.deepEqual(await fhir.read<ChargeItem>("ChargeItem", charge.id!), charge);
  await signEncounter(fhir);
  const draft = await buildClaimDraft(fhir, "e1");
  assert.deepEqual(draft.charges.map(({ id }) => id), ["charge-1"]);
  assert.equal(draft.warnings, undefined);
});

test("a failed post-transaction charge read preserves pick success and marks impact unavailable", async () => {
  class FailedImpactReadFhir extends MemoryFhir {
    failChargeSearch = false;

    override async search<T extends Resource>(
      resourceType: T["resourceType"],
      params: Record<string, string> = {},
    ): Promise<Bundle<T>> {
      if (resourceType === "ChargeItem" && this.failChargeSearch) {
        throw new Error("injected post-transaction ChargeItem search failure");
      }
      return super.search(resourceType, params);
    }
  }

  const fhir = diagnosisPickFhir(new FailedImpactReadFhir());
  await pick(fhir, "presbyopia", "confirm");
  fhir.failChargeSearch = true;
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => errors.push(values.map(String).join(" "));
  try {
    const result = await pick(fhir, "presbyopia", "possible");

    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(impact(result), {
      strandedCharges: [],
      unaffectedChargeCount: 0,
      strandedChargesComputed: false,
    });
    const condition = (result.body as { condition: Condition }).condition;
    assert.equal(condition.verificationStatus?.coding?.[0]?.code, "provisional");
    assert.equal(errors.some((message) => message.includes("injected post-transaction ChargeItem search failure")), true);
  } finally {
    console.error = originalError;
  }
});

function impact(result: { body: unknown }): DemotionImpact {
  const body = result.body as Partial<DemotionImpact>;
  return {
    strandedCharges: body.strandedCharges!,
    unaffectedChargeCount: body.unaffectedChargeCount!,
    strandedChargesComputed: body.strandedChargesComputed!,
  };
}

function conditionReference(result: { body: unknown }): string {
  const condition = (result.body as { condition: Condition }).condition;
  assert.ok(condition.id);
  return `Condition/${condition.id}`;
}

async function pick(
  fhir: MemoryFhir,
  diagnosisKey: string,
  action: "possible" | "confirm" | "discard",
): Promise<{ status: number; body: unknown }> {
  return handleDiagnosisPickRequest({
    authenticate: async () => ({
      staffReference: "Practitioner/doctor-1",
      actorRole: "provider",
      fhir,
    }),
    diagnosisVisitStatusStore: {
      upsert: async () => {
        throw new Error("visit status is outside this witness");
      },
    },
    now: () => "2026-09-07T12:00:00.000Z",
  }, {
    authHeader: "Bearer synthetic",
    params: { encounterId: "e1" },
    body: { diagnosisKey, action, source: "catalog-search" },
  });
}

function addCharge(fhir: MemoryFhir, diagnosisReferences: string[]): ChargeItem {
  const charge: ChargeItem = {
    resourceType: "ChargeItem",
    id: "charge-1",
    status: "billable",
    code: { coding: [{ system: "urn:odos:test", code: "synthetic-procedure" }], text: "Synthetic procedure" },
    subject: { reference: "Patient/p1" },
    context: { reference: "Encounter/e1" },
    supportingInformation: diagnosisReferences.map((reference) => ({ reference })),
    quantity: { value: 3 },
    priceOverride: { value: 70.25, currency: "USD" },
  };
  fhir.resources.push(structuredClone(charge));
  return charge;
}

async function signEncounter(fhir: MemoryFhir): Promise<void> {
  const encounter = await fhir.read<Encounter>("Encounter", "e1");
  await fhir.update("Encounter", "e1", {
    ...encounter,
    status: "finished",
    period: { start: "2026-09-07T12:00:00.000Z", end: "2026-09-07T12:30:00.000Z" },
  });
}

function diagnosisPickFhir<T extends MemoryFhir>(fhir: T = new MemoryFhir() as T): T {
  fhir.resources.push({
    resourceType: "Encounter",
    id: "e1",
    status: "in-progress",
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
    subject: { reference: "Patient/p1" },
  } as Encounter, {
    resourceType: "Coverage",
    id: "coverage-1",
    status: "active",
    beneficiary: { reference: "Patient/p1" },
    order: 1,
    payor: [{ reference: "Organization/payer-1", identifier: { value: "SYNTHETIC-PAYER" } }],
  } as Coverage);
  return fhir;
}

class MemoryFhir {
  readonly baseUrl = "http://synthetic.invalid";
  readonly resources: Resource[] = [];

  async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
    const resource = this.resources.find((row) => row.resourceType === resourceType && row.id === id);
    if (!resource) throw new Error(`Missing ${resourceType}/${id}`);
    return structuredClone(resource as T);
  }

  async search<T extends Resource>(
    resourceType: T["resourceType"],
    params: Record<string, string> = {},
  ): Promise<Bundle<T>> {
    const resources = this.resources.filter((resource) => resource.resourceType === resourceType).filter((resource) => {
      if (resourceType === "Basic") {
        const basic = resource as Basic;
        if (params.code && !basic.code?.coding?.some((coding) => `${coding.system}|${coding.code}` === params.code)) return false;
        if (params.identifier && !basic.identifier?.some((identifier) => `${identifier.system}|${identifier.value}` === params.identifier)) return false;
      }
      if (resourceType === "Condition" && params.encounter) {
        return (resource as Condition).encounter?.reference === params.encounter;
      }
      if (resourceType === "ChargeItem" && params.context) {
        return (resource as ChargeItem).context?.reference === params.context;
      }
      if (resourceType === "Coverage" && params.beneficiary) {
        return (resource as Coverage).beneficiary?.reference === params.beneficiary;
      }
      return true;
    });
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: resources.map((resource) => ({ resource: structuredClone(resource as T) })),
    };
  }

  async create<T extends Resource>(resource: T, headers?: Record<string, string>): Promise<T> {
    const conditionalIdentifier = headers?.["If-None-Exist"]?.match(/^identifier=([^|]+)\|(.+)$/);
    if (conditionalIdentifier) {
      const existing = this.resources.find((candidate) => candidate.resourceType === resource.resourceType &&
        "identifier" in candidate && candidate.identifier?.some((identifier) =>
          identifier.system === conditionalIdentifier[1] && identifier.value === conditionalIdentifier[2]
        ));
      if (existing) return structuredClone(existing as T);
    }
    const id = resource.id ?? `${resource.resourceType.toLowerCase()}-${this.resources.length + 1}`;
    const persisted = {
      ...resource,
      id,
      meta: { ...(resource.meta ?? {}), versionId: "1", lastUpdated: "2026-09-07T12:00:00.000Z" },
    } as T;
    this.resources.push(persisted);
    return structuredClone(persisted);
  }

  async update<T extends Resource>(
    resourceType: T["resourceType"],
    id: string,
    resource: T,
    headers?: Record<string, string>,
  ): Promise<T> {
    const index = this.resources.findIndex((candidate) => candidate.resourceType === resourceType && candidate.id === id);
    if (index < 0) throw new Error(`Missing ${resourceType}/${id}`);
    const current = this.resources[index]!;
    const ifMatch = headers?.["If-Match"]?.match(/\"(.+)\"/)?.[1];
    if (ifMatch && ifMatch !== current.meta?.versionId) {
      throw Object.assign(new Error("FHIR 412 Precondition Failed"), { status: 412 });
    }
    const persisted = {
      ...resource,
      id,
      meta: { ...(resource.meta ?? {}), versionId: String(Number(current.meta?.versionId ?? "0") + 1) },
    } as T;
    this.resources[index] = persisted;
    return structuredClone(persisted);
  }

  async executeTransaction(
    bundle: Bundle,
    headers?: Record<string, string>,
    _options?: { autoRollbackCreatedEntries?: boolean },
  ): Promise<Bundle> {
    const resourcesBefore = structuredClone(this.resources);
    const references = new Map<string, string>();
    try {
      const responseEntries = [];
      for (const entry of bundle.entry ?? []) {
        if (!entry.request || !entry.resource) throw new Error("Synthetic transaction entry is incomplete.");
        const resource = replaceTransactionReferences(structuredClone(entry.resource), references);
        if (entry.request.method === "POST") {
          const countBefore = this.resources.length;
          const persisted = await this.create(resource, {
            ...headers,
            ...(entry.request.ifNoneExist ? { "If-None-Exist": entry.request.ifNoneExist } : {}),
          });
          if (entry.fullUrl && persisted.id) references.set(entry.fullUrl, `${persisted.resourceType}/${persisted.id}`);
          responseEntries.push({
            resource: persisted,
            response: { status: this.resources.length === countBefore ? "200 OK" : "201 Created" },
          });
        } else if (entry.request.method === "PUT") {
          const [resourceType, id] = entry.request.url.split("/");
          if (!resourceType || !id || resource.resourceType !== resourceType) {
            throw new Error(`Synthetic transaction PUT mismatch for ${entry.request.url}.`);
          }
          const persisted = await this.update(resource.resourceType, id, resource, {
            ...headers,
            ...(entry.request.ifMatch ? { "If-Match": entry.request.ifMatch } : {}),
          });
          responseEntries.push({ resource: persisted, response: { status: "200 OK" } });
        } else {
          throw new Error(`Synthetic transaction does not support ${entry.request.method}.`);
        }
      }
      return { resourceType: "Bundle", type: "transaction-response", entry: responseEntries };
    } catch (error) {
      this.resources.splice(0, this.resources.length, ...resourcesBefore);
      throw error;
    }
  }
}

class PagedImpactFhir extends MemoryFhir {
  paginateImpact = false;
  conditionFirstPageIds?: Set<string>;
  chargeFirstPageIds?: Set<string>;

  override async search<T extends Resource>(
    resourceType: T["resourceType"],
    params: Record<string, string> = {},
  ): Promise<Bundle<T>> {
    const bundle = await super.search<T>(resourceType, params);
    if (!this.paginateImpact) return bundle;
    const isImpactSearch = (resourceType === "Condition" && params.encounter) ||
      (resourceType === "ChargeItem" && params.context);
    if (!isImpactSearch) return bundle;
    const firstPageIds = resourceType === "Condition" ? this.conditionFirstPageIds : this.chargeFirstPageIds;
    if (firstPageIds === undefined) return bundle;
    const firstEntries = (bundle.entry ?? []).filter((entry) => entry.resource?.id && firstPageIds.has(entry.resource.id));
    const hasLaterPage = firstEntries.length < (bundle.entry ?? []).length;
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: firstEntries,
      ...(hasLaterPage ? {
        link: [{
          relation: "next",
          url: `${this.baseUrl}/fhir/R4/${resourceType}?impact-page=2`,
        }],
      } : {}),
    };
  }

  async searchUrl<T extends Resource>(url: string, resourceType: T["resourceType"]): Promise<Bundle<T>> {
    assert.equal(new URL(url, this.baseUrl).searchParams.get("impact-page"), "2");
    const params = resourceType === "Condition" ? { encounter: "Encounter/e1" } : { context: "Encounter/e1" };
    const bundle = await super.search<T>(resourceType, params);
    const firstPageIds = resourceType === "Condition" ? this.conditionFirstPageIds : this.chargeFirstPageIds;
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: (bundle.entry ?? []).filter((entry) => entry.resource?.id && !firstPageIds?.has(entry.resource.id)),
    };
  }
}

function replaceTransactionReferences<T extends Resource>(
  resource: T,
  references: ReadonlyMap<string, string>,
): T {
  return JSON.parse(JSON.stringify(resource), (_key, value) =>
    typeof value === "string" ? references.get(value) ?? value : value
  ) as T;
}
