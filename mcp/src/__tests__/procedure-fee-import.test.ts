import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, ChargeItemDefinition, Resource } from "@medplum/fhirtypes";
import {
  createProcedureFeeScheduleItem,
  ensureProcedureFeeSchedule,
  listActiveCodedNonVisitProcedureFees,
  listProcedureFeeScheduleSnapshot,
  saveProcedureFeeScheduleItem,
} from "../clinical-graph/procedure-fee-schedule.js";
import {
  commitProcedureFeeImport,
  inspectProcedureFeeCsv,
  proposeProcedureFeeImport,
  type FeeImportProposal,
} from "../clinical-graph/procedure-fee-import.js";
import {
  handleProcedureFeeImportCommitRequest,
  handleProcedureFeeImportPreviewRequest,
} from "../clinical-graph/procedure-fee-import-endpoint.js";

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

function reviewedProposal(overrides: Partial<FeeImportProposal> & Pick<FeeImportProposal, "proposalId" | "display">): FeeImportProposal {
  const { display, ...rest } = overrides;
  return {
    sourceRows: [2],
    decision: "create",
    display,
    category: "procedure",
    routing: "insurance-billable",
    active: true,
    flags: [],
    reasons: [],
    ...rest,
  };
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
  assert.equal(proposal.display, "Synthetic side imaging");
  assert.equal(proposal.modifier, undefined);
  assert.equal(proposal.billingCode, "SYNTHSIDE");
  assert.equal(proposal.flags.filter((flag) => flag.class === "laterality-dropped").length, 1);
  assert.ok(proposal.reasons.includes("Laterality rows collapsed; side comes from the charge."));
});

test("laterality rows with different non-side modifiers remain separate", () => {
  // Omitting the stored modifier from collapse identity must discard one reviewed modifier.
  const preview = proposeProcedureFeeImport({
    csvText: [
      "Label,Group,Code,Fee,Route,Modifier",
      "Synthetic modified side RT,Procedure,SYNTHMOD.RT,11.11,Insurance,25",
      "Synthetic modified side LT,Procedure,SYNTHMOD.LT,11.11,Insurance,59",
    ].join("\n"),
    mapping: {
      display: "Label",
      category: "Group",
      billingCode: "Code",
      price: "Fee",
      routing: "Route",
      modifier: "Modifier",
    },
    existing: [],
  });

  assert.equal(preview.proposals.length, 2);
  assert.deepEqual(preview.proposals.map((row) => row.modifier), ["25", "59"]);
  assert.deepEqual(preview.proposals.map((row) => row.sourceRows), [[2], [3]]);
});

test("a plain side-bearing display stays separate from a coded-laterality row", () => {
  // Stripping a side-like display from a row without detected laterality must merge distinct source meanings.
  const preview = proposeProcedureFeeImport({
    csvText: [
      "Label,Group,Code,Fee,Route",
      "Synthetic contrast RT,Procedure,SYNTHCOL.RT,11.11,Insurance",
      "Synthetic contrast RT,Procedure,SYNTHCOL,11.11,Insurance",
    ].join("\n"),
    mapping: {
      display: "Label",
      category: "Group",
      billingCode: "Code",
      price: "Fee",
      routing: "Route",
    },
    existing: [],
  });

  assert.equal(preview.proposals.length, 2);
  assert.deepEqual(preview.proposals.map((row) => row.display), ["Synthetic contrast", "Synthetic contrast RT"]);
  assert.deepEqual(preview.proposals.map((row) =>
    row.flags.some((flag) => flag.class === "laterality-dropped")
  ), [true, false]);
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

test("an unrecognized mapped active value defaults inactive for explicit operator review", () => {
  // Falling back to active for an invalid mapped status must silently chart an obsolete concept.
  const preview = proposeProcedureFeeImport({
    csvText: "Label,Group,Route,Status\nSynthetic uncertain status,Procedure,Insurance,maybe\n",
    mapping: { display: "Label", category: "Group", routing: "Route", active: "Status" },
    existing: [],
  });

  assert.equal(preview.proposals[0]?.active, false);
  assert.equal(preview.proposals[0]?.flags.some((flag) => flag.class === "invalid-source-boolean"), true);
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

test("duplicate collapse leaves semantically different rows for operator review", () => {
  // Omitting reviewed category, routing, active, or decision from duplicate identity must hide a source row.
  const preview = proposeProcedureFeeImport({
    csvText: [
      "Label,Group,Code,Fee,Route,Status",
      "Synthetic semantic conflict,Procedure,SYNTHSEM,14.14,Insurance,yes",
      "Synthetic semantic conflict,Exam,SYNTHSEM,14.14,Insurance,yes",
      "Synthetic semantic conflict,Procedure,SYNTHSEM,14.14,Self pay,yes",
      "Synthetic semantic conflict,Procedure,SYNTHSEM,14.14,Insurance,no",
      "Synthetic semantic conflict,Procedure,SYNTHSEM,14.14,Scheduling only,yes",
    ].join("\n"),
    mapping: {
      display: "Label",
      category: "Group",
      billingCode: "Code",
      price: "Fee",
      routing: "Route",
      active: "Status",
    },
    existing: [],
  });

  assert.equal(preview.proposals.length, 5);
  assert.deepEqual(preview.proposals.map((row) => row.category), [
    "procedure", "exam", "procedure", "procedure", "procedure",
  ]);
  assert.deepEqual(preview.proposals.map((row) => row.routing), [
    "insurance-billable", "insurance-billable", "self-pay", "insurance-billable", "scheduling-only",
  ]);
  assert.deepEqual(preview.proposals.map((row) => row.active), [true, true, true, false, true]);
  assert.deepEqual(preview.proposals.map((row) => row.decision), [
    "create", "create", "create", "create", "skip",
  ]);
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

test("preview inspect and propose are practice-admin only and perform zero FHIR writes", async () => {
  // Removing role enforcement or calling the write-seeding schedule list must make this test red.
  const fhir = new CountingFhir();
  const csvText = "Service,Group,Route\nSynthetic preview service,Procedure,Insurance\n";
  const depsFor = (role: "practice-admin" | "clinician" | null) => ({
    authenticate: async () => role ? {
      staffReference: "Practitioner/synthetic",
      actorRole: role,
      fhir,
    } : null,
  });
  assert.equal((await handleProcedureFeeImportPreviewRequest(depsFor(null), {
    authHeader: undefined,
    body: { action: "inspect", csvText },
  })).status, 401);
  assert.equal((await handleProcedureFeeImportPreviewRequest(depsFor("clinician"), {
    authHeader: "Bearer clinician",
    body: { action: "inspect", csvText },
  })).status, 403);
  const inspected = await handleProcedureFeeImportPreviewRequest(depsFor("practice-admin"), {
    authHeader: "Bearer admin",
    body: { action: "inspect", csvText },
  });
  assert.equal(inspected.status, 200);
  const proposed = await handleProcedureFeeImportPreviewRequest(depsFor("practice-admin"), {
    authHeader: "Bearer admin",
    body: {
      action: "propose",
      csvText,
      mapping: { display: "Service", category: "Group", routing: "Route" },
    },
  });
  assert.equal(proposed.status, 200);
  assert.equal(fhir.createCount, 0);
  assert.equal(fhir.updateCount, 0);
  assert.deepEqual(fhir.resources, []);
});

test("commit reports create match skip failure and later success without hiding partial results", async () => {
  // Replacing sequential per-row handling with fail-fast or a transaction must hide the final success and make this test red.
  const fhir = new CountingFhir();
  fhir.resources.push({
    id: "existing-practice-fee",
    ...createDefinition("synthetic-practice-match", "Synthetic practice match"),
  });
  const secretOriginalCode = "SYNTHETIC-TRANSIENT-SECRET";
  const result = await commitProcedureFeeImport(fhir, [
    reviewedProposal({ proposalId: "p-create-one", display: "Synthetic created one", billingCode: "SYNTHC1" }),
    reviewedProposal({
      proposalId: "p-match",
      display: "Synthetic practice match",
      decision: "match",
      matchProcedureConceptKey: "synthetic-practice-match",
      billingCode: "SYNTHM1",
    }),
    reviewedProposal({ proposalId: "p-skip", display: "Synthetic skipped", decision: "skip" }),
    reviewedProposal({
      proposalId: "p-fail",
      display: "Synthetic rejected modifier",
      modifier: "RT",
      originalCode: secretOriginalCode,
    }),
    reviewedProposal({ proposalId: "p-create-two", display: "Synthetic created two", billingCode: "SYNTHC2" }),
  ]);
  assert.deepEqual(result.outcomes.map((outcome) => outcome.status), [
    "created", "matched", "skipped", "failed", "created",
  ]);
  assert.deepEqual(result.counts, { created: 2, matched: 1, skipped: 1, failed: 1 });
  assert.ok(fhir.resources.some((row) => JSON.stringify(row).includes("synthetic-created-two")));
  assert.equal(JSON.stringify(result).includes(secretOriginalCode), false);
  assert.equal(JSON.stringify(fhir.resources).includes(secretOriginalCode), false);
});

test("scheduling-only commit is always a no-write skip even with a stale create decision", async () => {
  // Trusting a stale create decision over scheduling routing must make this test red with a FHIR write.
  const fhir = new CountingFhir();
  const result = await commitProcedureFeeImport(fhir, [reviewedProposal({
    proposalId: "p-scheduling",
    display: "Synthetic scheduling slot",
    decision: "create",
    routing: "scheduling-only",
  })]);
  assert.equal(result.outcomes[0]?.status, "skipped");
  assert.equal(fhir.createCount, 0);
  assert.equal(fhir.updateCount, 0);
});

test("seeded match inherits immutable display and category and never supplies them to save", async () => {
  // Supplying reviewed display/category to the seeded save must trigger the prerequisite guard and make this test red.
  const fhir = new CountingFhir();
  const result = await commitProcedureFeeImport(fhir, [reviewedProposal({
    proposalId: "p-seed",
    display: "Attempted seed rename",
    category: "procedure",
    decision: "match",
    matchProcedureConceptKey: "refraction",
    billingCode: "SYNTHSEED",
    routing: "self-pay",
  })]);
  assert.equal(result.outcomes[0]?.status, "matched");
  const snapshot = await listProcedureFeeScheduleSnapshot(fhir);
  const seed = snapshot.find((item) => item.procedureConceptKey === "refraction");
  assert.equal(seed?.display, "Refraction");
  assert.equal(seed?.category, "refraction");
});

test("committing the same reviewed proposals twice creates no duplicate concepts", async () => {
  // Bypassing existing-key-to-match resolution must attempt a duplicate create and make this test red.
  const fhir = new CountingFhir();
  await ensureProcedureFeeSchedule(fhir);
  fhir.createCount = 0;
  const proposal = reviewedProposal({ proposalId: "p-repeat", display: "Synthetic repeated service" });
  const first = await commitProcedureFeeImport(fhir, [proposal]);
  const createsAfterFirst = fhir.createCount;
  const second = await commitProcedureFeeImport(fhir, [proposal]);
  assert.equal(first.outcomes[0]?.status, "created");
  assert.equal(second.outcomes[0]?.status, "matched");
  assert.equal(fhir.createCount, createsAfterFirst);
  assert.equal((await listProcedureFeeScheduleSnapshot(fhir)).filter((item) =>
    item.procedureConceptKey === "synthetic-repeated-service"
  ).length, 1);
});

test("two conflicting creates in one batch cannot overwrite the first row", async () => {
  // Treating a key created earlier in this batch as an implicit match must overwrite its reviewed values.
  const fhir = new CountingFhir();
  const result = await commitProcedureFeeImport(fhir, [
    reviewedProposal({
      proposalId: "p-conflict-one",
      display: "Synthetic same-key conflict",
      billingCode: "SYNTHFIRST",
      priceCents: 1111,
    }),
    reviewedProposal({
      proposalId: "p-conflict-two",
      display: "Synthetic same-key conflict",
      billingCode: "SYNTHSECOND",
      priceCents: 2222,
    }),
  ]);

  assert.deepEqual(result.outcomes.map((outcome) => outcome.status), ["created", "failed"]);
  const saved = (await listProcedureFeeScheduleSnapshot(fhir)).find((item) =>
    item.procedureConceptKey === "synthetic-same-key-conflict"
  );
  assert.equal(saved?.billingCode, "SYNTHFIRST");
  assert.equal(saved?.priceCents, 1111);
});

test("a second preview resolves the previously created concept as a match", async () => {
  // Generating proposal identity independently of the server concept key must leave the second preview as create.
  const fhir = new CountingFhir();
  const csvText = "Label,Group,Route\nSynthetic preview repeat,Procedure,Insurance\n";
  const mapping = { display: "Label", category: "Group", routing: "Route" };
  const first = proposeProcedureFeeImport({ csvText, mapping, existing: await listProcedureFeeScheduleSnapshot(fhir) });
  assert.equal(first.proposals[0]?.decision, "create");
  await commitProcedureFeeImport(fhir, first.proposals);
  const second = proposeProcedureFeeImport({ csvText, mapping, existing: await listProcedureFeeScheduleSnapshot(fhir) });
  assert.equal(second.proposals[0]?.decision, "match");
  assert.equal(second.proposals[0]?.matchProcedureConceptKey, "synthetic-preview-repeat");
});

test("uncoded import stays out of the unchanged selector until a code is saved", async () => {
  // Altering the selector contract or treating an uncoded active concept as chartable must make this test red.
  const fhir = new CountingFhir();
  const created = await commitProcedureFeeImport(fhir, [reviewedProposal({
    proposalId: "p-uncoded",
    display: "Synthetic uncoded service",
  })]);
  const key = created.outcomes[0]?.procedureConceptKey;
  assert.ok(key);
  assert.equal((await listActiveCodedNonVisitProcedureFees(fhir)).some((item) =>
    item.procedureConceptKey === key
  ), false);
  await commitProcedureFeeImport(fhir, [reviewedProposal({
    proposalId: "p-coded",
    display: "Synthetic uncoded service",
    decision: "match",
    matchProcedureConceptKey: key,
    billingCode: "SYNTHCODED",
  })]);
  assert.equal((await listActiveCodedNonVisitProcedureFees(fhir)).filter((item) =>
    item.procedureConceptKey === key
  ).length, 1);
});

test("commit endpoint rejects malformed batches before writes and returns row outcomes", async () => {
  // Removing top-level validation must allow malformed input to reach FHIR.
  const fhir = new CountingFhir();
  const unauthenticated = await handleProcedureFeeImportCommitRequest({ authenticate: async () => null }, {
    authHeader: undefined,
    body: { proposals: [] },
  });
  assert.equal(unauthenticated.status, 401);
  const forbidden = await handleProcedureFeeImportCommitRequest({ authenticate: async () => ({
    staffReference: "Practitioner/clinician",
    actorRole: "clinician" as const,
    fhir,
  }) }, {
    authHeader: "Bearer clinician",
    body: { proposals: [] },
  });
  assert.equal(forbidden.status, 403);
  const deps = {
    authenticate: async () => ({
      staffReference: "Practitioner/admin",
      actorRole: "practice-admin" as const,
      fhir,
    }),
  };
  const malformed = await handleProcedureFeeImportCommitRequest(deps, {
    authHeader: "Bearer admin",
    body: { proposals: "not-an-array" },
  });
  assert.equal(malformed.status, 400);
  assert.equal(fhir.createCount, 0);
  const committed = await handleProcedureFeeImportCommitRequest(deps, {
    authHeader: "Bearer admin",
    body: { proposals: [reviewedProposal({ proposalId: "p-endpoint", display: "Synthetic endpoint service" })] },
  });
  assert.equal(committed.status, 200);
  assert.match(JSON.stringify(committed.body), /created/);
});

function createDefinition(procedureConceptKey: string, display: string): ChargeItemDefinition {
  return {
    resourceType: "ChargeItemDefinition",
    url: `https://odos.test/fees/${procedureConceptKey}`,
    version: "1",
    status: "active",
    title: display,
    code: { coding: [{
      system: "https://odos2020.com/fhir/CodeSystem/procedure-concept",
      code: procedureConceptKey,
      display,
    }] },
  };
}
