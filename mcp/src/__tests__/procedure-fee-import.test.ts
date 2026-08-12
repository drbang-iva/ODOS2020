import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, ChargeItemDefinition, Resource } from "@medplum/fhirtypes";
import {
  createProcedureFeeScheduleItem,
  listActiveCodedNonVisitProcedureFees,
  listProcedureFeeScheduleSnapshot,
  saveProcedureFeeScheduleItem,
} from "../clinical-graph/procedure-fee-schedule.js";

class CountingFhir {
  resources: Resource[] = [];
  createCount = 0;
  updateCount = 0;
  next = 1;

  async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
    const resource = this.resources.find((row) => row.resourceType === resourceType && row.id === id);
    if (!resource) throw new Error(`${resourceType}/${id} not found`);
    return structuredClone(resource) as T;
  }

  async search<T extends Resource>(
    resourceType: T["resourceType"],
    params: Record<string, string> = {},
  ): Promise<Bundle<T>> {
    let rows = this.resources.filter((row) => row.resourceType === resourceType);
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

  async create<T extends Resource>(resource: T): Promise<T> {
    this.createCount += 1;
    const saved = { ...structuredClone(resource), id: resource.id ?? `resource-${this.next++}` } as T;
    this.resources.push(saved);
    return structuredClone(saved);
  }

  async createWithOutcome<T extends Resource>(resource: T): Promise<{ resource: T; created: boolean }> {
    return { resource: await this.create(resource), created: true };
  }

  async update<T extends Resource>(
    resourceType: T["resourceType"],
    id: string,
    resource: T,
  ): Promise<T> {
    this.updateCount += 1;
    const index = this.resources.findIndex((row) => row.resourceType === resourceType && row.id === id);
    if (index < 0) throw new Error(`${resourceType}/${id} not found for update`);
    const saved = { ...structuredClone(resource), id } as T;
    this.resources[index] = saved;
    return structuredClone(saved);
  }
}

function resourceIdentifiers(resource: Resource): Array<{ system?: string; value?: string }> {
  if (!("identifier" in resource) || !resource.identifier) return [];
  return Array.isArray(resource.identifier) ? resource.identifier : [resource.identifier];
}

test("search-only fee schedule snapshot returns all virtual seeds without FHIR writes", async () => {
  const fhir = new CountingFhir();

  const snapshot = await listProcedureFeeScheduleSnapshot(fhir);

  assert.equal(snapshot.length, 18);
  assert.equal(snapshot.filter((item) => item.category === "exam").length, 12);
  assert.equal(snapshot.find((item) => item.procedureConceptKey === "refraction")?.category, "refraction");
  assert.equal(fhir.createCount, 0);
  assert.equal(fhir.updateCount, 0);
  assert.deepEqual(fhir.resources, []);
});

test("insurance and self-pay routing round-trip as recorded data and both remain chartable", async () => {
  const fhir = new CountingFhir();
  const insurance = await createProcedureFeeScheduleItem(fhir, {
    display: "Synthetic insured imaging",
    category: "procedure",
    billingCode: "SYNTH1",
    routing: "insurance-billable",
    active: true,
  });
  const selfPay = await createProcedureFeeScheduleItem(fhir, {
    display: "Synthetic self pay treatment",
    category: "procedure",
    billingCode: "SYNTH2",
    routing: "self-pay",
    active: true,
  });

  assert.equal(insurance.routing, "insurance-billable");
  assert.equal(selfPay.routing, "self-pay");
  assert.deepEqual(
    (await listActiveCodedNonVisitProcedureFees(fhir)).map((item) => item.procedureConceptKey),
    [insurance.procedureConceptKey, selfPay.procedureConceptKey],
  );

  const saved = await saveProcedureFeeScheduleItem(fhir, {
    procedureConceptKey: selfPay.procedureConceptKey,
    routing: "insurance-billable",
    active: true,
  });
  assert.equal(saved.routing, "insurance-billable");

  const definition = fhir.resources.find((row): row is ChargeItemDefinition =>
    row.resourceType === "ChargeItemDefinition" &&
    row.code?.coding?.some((coding) => coding.code === selfPay.procedureConceptKey)
  );
  assert.ok(definition);
  assert.match(JSON.stringify(definition), /odos-procedure-fee-routing/);
});
