import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, ChargeItemDefinition, Resource } from "@medplum/fhirtypes";
import {
  PROCEDURE_FEE_SEEDS,
  buildProcedureFeeDefinition,
  listProcedureFeeSchedule,
  saveProcedureFeeScheduleItem,
} from "../clinical-graph/procedure-fee-schedule.js";

class MemoryFhir {
  resources: Resource[] = [];
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

const VISIT_KEYS = [
  "comprehensive-exam-new",
  "comprehensive-exam-established",
  "intermediate-exam-new",
  "intermediate-exam-established",
  "office-visit-new-straightforward",
  "office-visit-new-low",
  "office-visit-new-moderate",
  "office-visit-established-straightforward",
  "office-visit-established-low",
  "office-visit-established-moderate",
  "routine-vision-exam-new",
  "routine-vision-exam-established",
] as const;

test("the shipped fee schedule contains 12 visit concepts and settings-only refraction", () => {
  assert.equal(PROCEDURE_FEE_SEEDS.length, 18);
  assert.deepEqual(
    PROCEDURE_FEE_SEEDS.slice(5).map((row) => row.procedureConceptKey),
    [...VISIT_KEYS, "refraction"],
  );
  assert.deepEqual(
    PROCEDURE_FEE_SEEDS.flatMap((row) => row.billingCode
      ? [[row.procedureConceptKey, row.billingCode] as const]
      : []),
    [
      ["routine-vision-exam-new", "S0620"],
      ["routine-vision-exam-established", "S0621"],
    ],
  );
});

test("billing coding is positionally first while the ODOS concept remains system-addressable", () => {
  const definition = buildProcedureFeeDefinition({
    procedureConceptKey: "routine-vision-exam-new",
    display: "Routine vision exam — new patient",
    billingCode: "S0620",
  });
  assert.deepEqual(definition.code?.coding, [
    {
      system: "https://bluebutton.cms.gov/resources/codesystem/hcpcs",
      code: "S0620",
      display: "Routine vision exam — new patient",
    },
    {
      system: "https://odos2020.com/fhir/CodeSystem/procedure-concept",
      code: "routine-vision-exam-new",
      display: "Routine vision exam — new patient",
    },
  ]);
});

test("billing code save normalizes, preserves on omission, and removes on blank", async () => {
  const fhir = new MemoryFhir();
  assert.equal((await listProcedureFeeSchedule(fhir)).length, 18);
  assert.equal(fhir.resources.filter((row) => row.resourceType === "ChargeItemDefinition").length, 5);
  const normalized = await saveProcedureFeeScheduleItem(fhir, {
    procedureConceptKey: "comprehensive-exam-new",
    billingCode: "  a1b2  ",
    priceCents: 18_500,
    active: true,
  });
  assert.equal(normalized.billingCode, "A1B2");
  assert.equal(normalized.priceCents, 18_500);

  const preserved = await saveProcedureFeeScheduleItem(fhir, {
    procedureConceptKey: "comprehensive-exam-new",
    priceCents: 19_000,
    active: false,
  });
  assert.equal(preserved.billingCode, "A1B2");
  assert.equal(preserved.priceCents, 19_000);
  assert.equal(preserved.active, false);

  const removed = await saveProcedureFeeScheduleItem(fhir, {
    procedureConceptKey: "comprehensive-exam-new",
    billingCode: "   ",
    active: true,
  });
  assert.equal(removed.billingCode, undefined);
  assert.equal(removed.priceCents, 19_000);

  const definitions = fhir.resources.filter((row): row is ChargeItemDefinition =>
    row.resourceType === "ChargeItemDefinition"
  );
  assert.equal(definitions.length, 6);
});
