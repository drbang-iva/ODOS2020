import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, ChargeItemDefinition, Resource } from "@medplum/fhirtypes";
import {
  createProcedureFeeScheduleItem,
  listActiveCodedNonVisitProcedureFees,
  listProcedureFeeScheduleSnapshot,
  saveProcedureFeeScheduleItem,
} from "../clinical-graph/procedure-fee-schedule.js";
import {
  inspectProcedureFeeCsv,
  proposeProcedureFeeImport,
} from "../clinical-graph/procedure-fee-import.js";

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
    Boolean(row.code?.coding?.some((coding) => coding.code === selfPay.procedureConceptKey))
  );
  assert.ok(definition);
  assert.match(JSON.stringify(definition), /odos-procedure-fee-routing/);
});

test("CSV inspection uses strict legacy-import conventions and operator-overridable suggestions", () => {
  // Removing BOM handling, strict CSV parsing, or generic alias scoring must make this test red.
  const result = inspectProcedureFeeCsv(
    "\uFEFFOffering title,Group bucket,Charge token,Fee amount\r\n" +
    '"Synthetic, quoted service",Procedure,SYNTHA,12.34\r\n',
  );
  assert.deepEqual(result.headers, ["Offering title", "Group bucket", "Charge token", "Fee amount"]);
  assert.equal(result.rowCount, 1);
  assert.equal(result.suggestedMapping.display, "Offering title");
  assert.equal(result.suggestedMapping.category, "Group bucket");
  assert.equal(result.suggestedMapping.billingCode, "Charge token");
  assert.equal(result.suggestedMapping.price, "Fee amount");
});

test("inspection rejects duplicate headers and malformed quoting without leaking row contents", () => {
  // Allowing duplicate headers or relaxed quoting must make one of these assertions red.
  assert.throws(() => inspectProcedureFeeCsv("Name,Name\nOne,Two\n"), /duplicate CSV header/i);
  const secretCell = "SYNTHETIC-SECRET-CELL";
  assert.throws(
    () => inspectProcedureFeeCsv(`Name,Fee\n"${secretCell},12.00\n`),
    (error: unknown) => error instanceof Error &&
      /CSV could not be parsed/i.test(error.message) && !error.message.includes(secretCell),
  );
});

test("inspection allows no display suggestion so the operator can map an arbitrary column", () => {
  const result = inspectProcedureFeeCsv("Alpha,Beta\nSynthetic service,Procedure\n");
  assert.equal(result.suggestedMapping.display, undefined);
});

const SYNTHETIC_FEE_IMPORT_CSV = [
  "Label bucket,Group bucket,Charge token,Fee amount,Route bucket,State flag,Zero marker,Extra modifier",
  "Synthetic side imaging RT,Procedure,SYNTHSIDE.RT,11.11,Insurance,yes,no,",
  "Synthetic side imaging LT,Procedure,SYNTHSIDE.LT,11.11,Insurance,yes,no,",
  "Synthetic duplicate service,Procedure,SYNTHDUP,22.22,Self pay,yes,no,",
  "Synthetic duplicate service,Procedure,SYNTHDUP,22.22,Self pay,yes,no,",
  "Synthetic tier basic,Procedure,SYNTHTIER.1,33.33,Insurance,yes,no,",
  "Synthetic tier advanced,Procedure,SYNTHTIER.2,44.44,Insurance,yes,no,",
  "Synthetic booking slot,Procedure,,0,Scheduling only,yes,yes,",
  "Synthetic RGP bifocal tier,CL fitting,SYNTHRGP,55.55,Self pay,yes,no,",
  "Invalid procedure code,Procedure,SYNTHBAD,66.66,Insurance,yes,no,",
  "Synthetic zero contradiction,Procedure,SYNTHZERO,77.77,Insurance,yes,yes,",
  "Synthetic obsolete service,Procedure,SYNTHOLD,88.88,Insurance,no,no,",
  "Synthetic missing category,,SYNTHCAT,99.99,Insurance,yes,no,",
  "Synthetic invalid price,Procedure,SYNTHPRICE,12.345,Insurance,yes,no,",
  "Synthetic invalid boolean,Procedure,SYNTHBOOL,10.10,Insurance,maybe,perhaps,",
  "Synthetic bilateral heuristic,Procedure,SYNTHBILAT.50,13.13,Insurance,yes,no,",
].join("\n");

const SYNTHETIC_MAPPING = {
  display: "Label bucket",
  category: "Group bucket",
  billingCode: "Charge token",
  price: "Fee amount",
  routing: "Route bucket",
  active: "State flag",
  zeroPrice: "Zero marker",
  modifier: "Extra modifier",
} as const;

test("proposal rejects a missing display mapping or any blank mapped display with row numbers", () => {
  // Removing whole-preview display validation must return partial proposals and make this test red.
  assert.throws(
    () => proposeProcedureFeeImport({ csvText: "Arbitrary\nSynthetic\n", mapping: {}, existing: [] }),
    /display column mapping is required/i,
  );
  const secretCell = "SYNTHETIC-PRIVATE-CELL";
  assert.throws(
    () => proposeProcedureFeeImport({
      csvText: `Name,Notes\n,${secretCell}\nSynthetic service,ok\n`,
      mapping: { display: "Name" },
      existing: [],
    }),
    (error: unknown) => error instanceof Error && /CSV row 2/i.test(error.message) &&
      !error.message.includes(secretCell),
  );
});

test("laterality rows collapse once and drop concept laterality with the charge-side reason", () => {
  // Disabling fixed-side normalization or collapse must produce two proposals or retain concept laterality.
  const preview = proposeProcedureFeeImport({
    csvText: SYNTHETIC_FEE_IMPORT_CSV,
    mapping: SYNTHETIC_MAPPING,
    existing: [],
  });
  const proposal = preview.proposals.find((row) => row.sourceRows.includes(2));
  assert.ok(proposal);
  assert.deepEqual(proposal.sourceRows, [2, 3]);
  assert.equal(proposal.modifier, undefined);
  assert.equal(proposal.billingCode, "SYNTHSIDE");
  assert.equal(proposal.flags.filter((flag) => flag.class === "laterality-dropped").length, 1);
  assert.ok(proposal.reasons.includes("Laterality rows collapsed; side comes from the charge."));
});

test("local price tiers remain separate concepts sharing one derived billing code", () => {
  // Collapsing by billing code alone must make this test red by hiding one price tier.
  const preview = proposeProcedureFeeImport({
    csvText: SYNTHETIC_FEE_IMPORT_CSV,
    mapping: SYNTHETIC_MAPPING,
    existing: [],
  });
  const tiers = preview.proposals.filter((row) => row.billingCode === "SYNTHTIER");
  assert.equal(tiers.length, 2);
  assert.notEqual(tiers[0]?.display, tiers[1]?.display);
  assert.equal(tiers.some((row) => row.flags.some((flag) => flag.class === "laterality-dropped")), false);
});

test("every required integrity class flags its row without failing proposal generation", () => {
  // Dropping any integrity check must make the exact flag-class inventory red.
  const preview = proposeProcedureFeeImport({
    csvText: SYNTHETIC_FEE_IMPORT_CSV,
    mapping: SYNTHETIC_MAPPING,
    existing: [],
  });
  const classes = new Set(preview.proposals.flatMap((row) => row.flags.map((flag) => flag.class)));
  for (const expected of [
    "invalid-active-code-name",
    "zero-price-contradiction",
    "obsolete-or-superseded",
    "category-required",
    "laterality-dropped",
    "invalid-price",
    "invalid-source-boolean",
  ] as const) {
    assert.equal(classes.has(expected), true, expected);
  }
  assert.ok(preview.proposals.length > 0);
});

test("an available unmapped active column is visible on affected proposals", () => {
  // Silently defaulting active when a status-like column exists must make this test red.
  const withoutActive = proposeProcedureFeeImport({
    csvText: SYNTHETIC_FEE_IMPORT_CSV,
    mapping: { ...SYNTHETIC_MAPPING, active: undefined },
    existing: [],
  });
  assert.equal(withoutActive.proposals.every((row) =>
    row.flags.some((flag) => flag.class === "active-column-unmapped")
  ), true);
  const withActive = proposeProcedureFeeImport({
    csvText: SYNTHETIC_FEE_IMPORT_CSV,
    mapping: SYNTHETIC_MAPPING,
    existing: [],
  });
  assert.equal(withActive.proposals.some((row) =>
    row.flags.some((flag) => flag.class === "active-column-unmapped")
  ), false);
  assert.equal(withActive.proposals.find((row) => row.sourceRows.includes(12))?.active, false);
});

test("routing required and concept-key conflict flags remain row-visible", () => {
  // Defaulting missing routing or silently accepting duplicate generated keys must make this test red.
  const preview = proposeProcedureFeeImport({
    csvText: [
      "Service label,Group,Code,Fee,Route,Status",
      "Synthetic conflicting service,Procedure,SYNTHCONFLICTA,14.14,,yes",
      "Synthetic conflicting service,Procedure,SYNTHCONFLICTB,15.15,Insurance,yes",
    ].join("\n"),
    mapping: {
      display: "Service label",
      category: "Group",
      billingCode: "Code",
      price: "Fee",
      routing: "Route",
      active: "Status",
    },
    existing: [],
  });
  assert.equal(preview.proposals[0]?.flags.some((flag) => flag.class === "routing-required"), true);
  assert.equal(preview.proposals.every((row) =>
    row.flags.some((flag) => flag.class === "concept-key-conflict")
  ), true);
});

test("seeded matches inherit display and category without category-required", () => {
  // Requiring source category on a seeded match must make this test red.
  const existing = [{
    id: "refraction",
    procedureConceptKey: "refraction",
    display: "Refraction",
    category: "refraction" as const,
    active: true,
    version: "1",
  }];
  const preview = proposeProcedureFeeImport({
    csvText: "Anything,Route\nRefraction,Insurance\n",
    mapping: { display: "Anything", routing: "Route" },
    existing,
  });
  assert.equal(preview.proposals[0]?.decision, "match");
  assert.equal(preview.proposals[0]?.matchSeeded, true);
  assert.equal(preview.proposals[0]?.category, "refraction");
  assert.equal(preview.proposals[0]?.flags.some((flag) => flag.class === "category-required"), false);
  assert.equal(preview.matchOptions[0]?.seeded, true);
});

test("RGP bifocal and scheduling-only rows default to explicit skip", () => {
  // Removing either skip ruling must make one row default to create.
  const preview = proposeProcedureFeeImport({
    csvText: SYNTHETIC_FEE_IMPORT_CSV,
    mapping: SYNTHETIC_MAPPING,
    existing: [],
  });
  const scheduling = preview.proposals.find((row) => row.sourceRows.includes(8));
  const rgp = preview.proposals.find((row) => row.sourceRows.includes(9));
  assert.equal(scheduling?.decision, "skip");
  assert.equal(rgp?.decision, "skip");
  assert.match(scheduling?.reasons.join(" ") ?? "", /scheduling-only/i);
  assert.match(rgp?.reasons.join(" ") ?? "", /RGP bifocal/i);
  assert.deepEqual(
    preview.proposals.flatMap((row) => row.sourceRows).sort((a, b) => a - b),
    Array.from({ length: 15 }, (_, index) => index + 2),
  );
});
