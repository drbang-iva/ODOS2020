# Fee Schedule Import P1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a practice-admin CSV map/propose/review/commit fee-schedule importer with prerequisite modifier and seeded-write guards, recorded-only routing, no-write preview, visible partial success, and duplicate-safe re-import.

**Architecture:** Keep parsing, proposal construction, and review transient. Add a search-only fee-schedule snapshot for preview, then commit reviewed rows sequentially through the existing create/save functions. Persist routing as an inert `ChargeItemDefinition` extension; leave chart selection, materialization, claims, and `listActiveCodedNonVisitProcedureFees` unchanged.

**Tech Stack:** TypeScript, Node test runner/TAP, Zod, `csv-parse/sync`, FHIR R4 `ChargeItemDefinition`, Express, React 18, Vite, react-test-renderer.

## Global Constraints

- Base is `main` at `6ec4b94d`; work only in `/Users/ericr.bang/GitHub/ODOS2020-fee-schedule-import-p1` on `drbang-iva/fee-schedule-import-p1`.
- No real CPT or HCPCS value and no real fee may enter source, tests, documentation examples, logs, or fixtures.
- Verify `RT`, `LT`, and `50` against at least two primary sources with access date `2026-08-12` before committing the denylist; add the Mandate 14 ledger evidence in the prerequisite commit.
- Modifier and routing are recorded-only. Neither affects `ChargeItem`, claim assembly, Claim.MD, chart selection, or any other behavior in P1.
- `listActiveCodedNonVisitProcedureFees` must remain byte-identical to `6ec4b94d`.
- Scheduling-only proposals never create or update a definition. Insurance-billable and self-pay concepts remain equally chartable when active, coded, and non-visit.
- Preview inspection and proposal generation make zero FHIR create/update calls, including zero implicit seed materialization.
- Original source codes remain transient and never reach FHIR, a committed file, server logs, provenance, or error messages.
- Seeded match display/category are inherited and read-only; commit omits both properties. Create and practice-created match require editable display/category.
- If an active/status-like header exists but is unmapped, attach `active-column-unmapped` visibly; only files without such a header default active to true without that flag.
- `.50` laterality handling is labeled a heuristic and remains operator-overridable in review.
- Reuse `csv-parse/sync` with `bom: true`, a `columns` callback, and `skip_empty_lines: true`; deliberately do not use `relax_quotes: true`.
- No package changes, import ledger, original-code schema, payer allowances, coverage/frequency rules, auto-commit, claim changes, materialization changes, or `ChargeItem` shape changes.
- Production code changes require a focused failing test, observed expected failure, minimal implementation, and focused green rerun.
- Codex authors but does not evaluate; exact-head Fable/Opus evaluation is required before merge.

---

## File Map

### Create

- `data/code-bindings/fee-schedule-import-p1-ledger.md` — two-primary-source verification for fixed-side modifier semantics and the local `.50` heuristic boundary.
- `mcp/src/__tests__/procedure-fee-prerequisite.test.ts` — independently reviewable modifier and seeded-write guards plus storage-only proof.
- `mcp/src/clinical-graph/procedure-fee-import.ts` — strict CSV inspection, mapping, proposals, collapse/flag rules, search-only snapshot consumption, and sequential commit.
- `mcp/src/clinical-graph/procedure-fee-import-endpoint.ts` — practice-admin preview and commit boundary.
- `mcp/src/__tests__/procedure-fee-import.test.ts` — parser, proposal, endpoint, no-write, partial-success, routing, selector, and idempotency evidence.
- `ui/src/lib/procedure-fee-import.ts` — typed preview/commit client and import types.
- `ui/src/scenes/settings/FeeScheduleImport.tsx` — upload/paste, mapping, editable review, abandon, commit, and row outcomes.
- `ui/tests/feeScheduleImport.test.tsx` — rendered mapping/review/no-write/partial-outcome tests.

### Modify

- `mcp/src/clinical-graph/procedure-fee-schedule.ts` — input-error class, modifier denylist, seeded immutable-field guard, routing extension, and search-only snapshot helper.
- `mcp/src/clinical-graph/procedure-fee-schedule-endpoint.ts` — return 400 for focused fee-schedule input errors.
- `mcp/src/index.ts` — register preview and commit routes.
- `ui/src/scenes/settings/FeeScheduleSettings.tsx` — mount import lane for practice-admin users and refresh the worksheet after commit.

### Protected and untouched

- `mcp/src/__tests__/visit-billing-codes.test.ts`
- `mcp/src/__tests__/procedure-charges.test.ts`
- `mcp/src/__tests__/procedure-charge-laterality.test.ts`
- `mcp/src/claims/**`
- `mcp/src/legacy-import/import-ledger.ts`

---

### Task 1: Prerequisite Modifier and Seeded-Write Guards

**Files:**
- Create: `data/code-bindings/fee-schedule-import-p1-ledger.md`
- Create: `mcp/src/__tests__/procedure-fee-prerequisite.test.ts`
- Modify: `mcp/src/clinical-graph/procedure-fee-schedule.ts`
- Modify: `mcp/src/clinical-graph/procedure-fee-schedule-endpoint.ts`

**Interfaces:**
- Produces: `ProcedureFeeScheduleInputError` for operator-correctable 400 responses.
- Produces: `isSeededProcedureFeeConceptKey(key: string): boolean` for importer and UI metadata.
- Preserves: legitimate alphanumeric modifiers and existing category/price/code behavior.

- [ ] **Step 1: Verify modifier semantics from two primary sources**

Browse official primary documentation only. Record direct URLs and access date `2026-08-12` showing that `RT` is right side, `LT` is left side, and `50` is bilateral. If two primary sources do not agree, stop and mark the code provisional rather than implementing it.

Create the ledger with this exact shape after verification:

```md
# Fee Schedule Import P1 Verification Ledger

Access date: 2026-08-12

| Artifact | ODOS use | Primary source 1 | Primary source 2 | Status |
|---|---|---|---|---|
| RT / LT | Rejected from concept-level modifier storage because side is charge-specific | https://www.cms.gov/Regulations-and-Guidance/Guidance/Manuals/Downloads/clm104c04.pdf | https://www.cms.gov/medicare-coverage-database/view/article.aspx?articleStatus=all&articleid=56869 | verified |
| 50 | Rejected from concept-level modifier storage because bilateral performance is charge-specific | https://www.cms.gov/Regulations-and-Guidance/Guidance/Manuals/Downloads/clm104c04.pdf | https://www.cms.gov/medicare-coverage-database/view/article.aspx?articleid=56670 | verified |

The importer treatment of a final `.50` suffix is a visible, operator-overridable heuristic. The sources verify modifier 50 semantics; they do not prove that every legacy `.50` suffix is a modifier.
```

- [ ] **Step 2: Read the good-test rules before changing tests**

Run:

```bash
sed -n '1,320p' /Users/ericr.bang/.codex/plugins/cache/superpowers-marketplace/superpowers/6.2.0/skills/test-driven-development/writing-good-tests.md
```

For every load-bearing test below, add a one-line comment naming the production mutation that makes it red.

- [ ] **Step 3: Write failing modifier and seed-immutability tests**

Create `procedure-fee-prerequisite.test.ts` using a write-counting in-memory FHIR client and real production functions. Add these named tests:

```ts
test("fee concept create rejects RT LT and 50 because side comes from the charge", async () => {
  for (const modifier of ["RT", "LT", "50"]) {
    const fhir = new MemoryFhir();
    await assert.rejects(
      () => createProcedureFeeScheduleItem(fhir, {
        display: `Synthetic ${modifier} procedure`,
        category: "procedure",
        modifier,
        active: true,
      }),
      new RegExp(`${modifier}.*Side comes from the charge.*ChargeItem\\.bodysite`, "i"),
    );
    assert.equal(fhir.createCount, 0);
    assert.equal(fhir.updateCount, 0);
  }
});

test("fee concept save rejects RT LT and 50 before any seed materialization or update", async () => {
  for (const modifier of ["RT", "LT", "50"]) {
    const fhir = seededMemoryFhir();
    const before = structuredClone(fhir.resources);
    await assert.rejects(() => saveProcedureFeeScheduleItem(fhir, {
      procedureConceptKey: "gonioscopy",
      modifier,
      active: true,
    }), /Side comes from the charge.*ChargeItem\.bodysite/i);
    assert.deepEqual(fhir.resources, before);
    assert.equal(fhir.updateCount, 0);
  }
});

test("a legitimate synthetic concept modifier round-trips while remaining absent from ChargeItem and claim", async () => {
  const fhir = feeAndEncounterFhir();
  const created = await createProcedureFeeScheduleItem(fhir, {
    display: "Synthetic component service",
    category: "procedure",
    billingCode: "SYNTHCOMP",
    modifier: "SYNTHMOD",
    active: true,
  });
  assert.equal(created.modifier, "SYNTHMOD");
  const charges = rowStore([acceptedProposal(created.procedureConceptKey)]);
  await materializeAcceptedChargeProposals(materializationInput(fhir, charges));
  const chargeItem = fhir.resources.find((row) => row.resourceType === "ChargeItem") as ChargeItem;
  assert.equal(JSON.stringify(chargeItem).includes("SYNTHMOD"), false);
  const claim = buildProfessionalClaim(professionalClaimInput([chargeItem]));
  assert.equal(JSON.stringify(claim).includes("SYNTHMOD"), false);
});

test("seeded display or category save returns 400 and leaves the definition byte-equivalent", async () => {
  for (const attempted of [{ display: "Ignored name" }, { category: "exam" as const }]) {
    const fhir = seededMemoryFhir();
    const before = structuredClone(fhir.resources);
    const result = await handleProcedureFeeScheduleMutationRequest(authenticatedDeps(fhir), {
      authHeader: "Bearer admin",
      params: { procedureConceptKey: "gonioscopy" },
      body: { action: "save", ...attempted, priceCents: null, active: true },
    });
    assert.equal(result.status, 400);
    assert.match(JSON.stringify(result.body), /seeded/i);
    assert.deepEqual(fhir.resources, before);
    assert.equal(fhir.updateCount, 0);
  }
});
```

The test file defines these local helpers rather than mocking production behavior: `seededMemoryFhir()` returns a counting client with one persisted gonioscopy definition; `feeAndEncounterFhir()` adds a synthetic Encounter; `rowStore()` persists proposals in memory; `acceptedProposal()` returns one accepted manual proposal; `materializationInput()` supplies the real materializer dependencies; `professionalClaimInput()` supplies the existing required claim demographics around the created ChargeItem; and `authenticatedDeps()` returns a practice-admin staff result using that same FHIR client.

- [ ] **Step 4: Run the prerequisite test and confirm expected red**

Run:

```bash
cd mcp
node --import tsx --test src/__tests__/procedure-fee-prerequisite.test.ts
```

Expected: failures show laterality values are currently accepted, seeded values are silently ignored, and the endpoint does not yet return focused 400 responses.

- [ ] **Step 5: Implement minimal production guards**

Add to `procedure-fee-schedule.ts`:

```ts
const DISALLOWED_CONCEPT_LATERALITY_MODIFIERS = new Set(["RT", "LT", "50"]);

export class ProcedureFeeScheduleInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProcedureFeeScheduleInputError";
  }
}

export function isSeededProcedureFeeConceptKey(value: string): boolean {
  return PROCEDURE_FEE_SEEDS.some((seed) => seed.procedureConceptKey === value);
}
```

In `normalizeModifier`, after uppercase/blank normalization and format validation:

```ts
if (DISALLOWED_CONCEPT_LATERALITY_MODIFIERS.has(normalized)) {
  throw new ProcedureFeeScheduleInputError(
    `Laterality modifier ${normalized} is not allowed on a fee-schedule concept. ` +
    "Side comes from the charge (ChargeItem.bodysite), not the concept.",
  );
}
```

At the start of `saveProcedureFeeScheduleItem`, before `ensureProcedureFeeSchedule`:

```ts
if (isSeededProcedureFeeConceptKey(input.procedureConceptKey)) {
  if (Object.hasOwn(input, "display")) {
    throw new ProcedureFeeScheduleInputError("Display cannot be changed for an ODOS-seeded fee concept.");
  }
  if (Object.hasOwn(input, "category")) {
    throw new ProcedureFeeScheduleInputError("Category cannot be changed for an ODOS-seeded fee concept.");
  }
}
```

Catch only `ProcedureFeeScheduleInputError` in both ordinary create/save endpoint handlers and return `{ status: 400, body: { error: error.message } }`. Preserve conflict 409 and rethrow unexpected failures.

- [ ] **Step 6: Run focused green and protected prerequisite regressions**

Run:

```bash
cd mcp
node --import tsx --test \
  src/__tests__/procedure-fee-prerequisite.test.ts \
  src/__tests__/visit-billing-codes.test.ts \
  src/__tests__/procedure-charges.test.ts \
  src/__tests__/procedure-charge-laterality.test.ts
```

Expected: all focused and protected tests pass. Record file-by-file counts.

- [ ] **Step 7: Commit the independently verifiable prerequisite**

```bash
git add data/code-bindings/fee-schedule-import-p1-ledger.md \
  mcp/src/__tests__/procedure-fee-prerequisite.test.ts \
  mcp/src/clinical-graph/procedure-fee-schedule.ts \
  mcp/src/clinical-graph/procedure-fee-schedule-endpoint.ts
git commit -m "fix: guard fee concept modifiers"
```

---

### Task 2: Recorded-Only Routing and Search-Only Schedule Snapshot

**Files:**
- Modify: `mcp/src/clinical-graph/procedure-fee-schedule.ts`
- Test: `mcp/src/__tests__/procedure-fee-import.test.ts`

**Interfaces:**
- Produces: `PROCEDURE_FEE_ROUTINGS`, `ProcedureFeeRouting`.
- Produces: `listProcedureFeeScheduleSnapshot(fhir)` that performs searches only and merges virtual seeds.
- Extends: `ProcedureFeeScheduleItem.routing?: ProcedureFeeRouting`, create/save/builder routing inputs.
- Does not modify: `listActiveCodedNonVisitProcedureFees`.

- [ ] **Step 1: Capture the protected selector function from base**

Run and retain the output for final comparison:

```bash
git show 6ec4b94d:mcp/src/clinical-graph/procedure-fee-schedule.ts \
  | sed -n '/export async function listActiveCodedNonVisitProcedureFees/,/^}/p' \
  > /tmp/fee-selector-base.txt
```

- [ ] **Step 2: Write failing routing and no-write snapshot tests**

Add to `procedure-fee-import.test.ts`:

```ts
test("search-only fee snapshot returns persisted definitions and virtual seeds with zero writes", async () => {
  const fhir = new CountingFhir();
  const items = await listProcedureFeeScheduleSnapshot(fhir);
  assert.equal(items.length, PROCEDURE_FEE_SEEDS.length);
  assert.equal(fhir.createCount, 0);
  assert.equal(fhir.updateCount, 0);
});

test("insurance and self-pay routing round-trip as inert definition metadata", async () => {
  for (const routing of ["insurance-billable", "self-pay"] as const) {
    const fhir = new CountingFhir();
    const created = await createProcedureFeeScheduleItem(fhir, {
      display: `Synthetic ${routing} service`,
      category: "procedure",
      billingCode: routing === "self-pay" ? "SYNTHSELF" : "SYNTHINS",
      routing,
      active: true,
    });
    assert.equal(created.routing, routing);
    assert.equal((await listActiveCodedNonVisitProcedureFees(fhir)).some(
      (item) => item.procedureConceptKey === created.procedureConceptKey,
    ), true);
  }
});
```

- [ ] **Step 3: Run focused tests and confirm expected red**

```bash
cd mcp
node --import tsx --test src/__tests__/procedure-fee-import.test.ts
```

Expected: missing routing types/snapshot helper and absent routing persistence.

- [ ] **Step 4: Implement routing and snapshot**

Add:

```ts
const FEE_ROUTING_EXTENSION_URL = `${BASE}/StructureDefinition/odos-procedure-fee-routing`;
export const PROCEDURE_FEE_ROUTINGS = ["insurance-billable", "self-pay"] as const;
export type ProcedureFeeRouting = (typeof PROCEDURE_FEE_ROUTINGS)[number];
```

Extend item, create, save, and builder input types with `routing`. In the builder, filter and replace the routing extension alongside category and modifier. In save, preserve existing routing when the input property is absent. Parse only allowed values from definitions.

Extract the virtual-seed merge from `listProcedureFeeSchedule` into a pure helper, then add:

```ts
export async function listProcedureFeeScheduleSnapshot(
  fhir: Pick<ProcedureFeeScheduleFhir, "search" | "searchUrl">,
): Promise<ProcedureFeeScheduleItem[]> {
  return mergeProcedureFeeSchedule(
    (await listProcedureFeeDefinitions(fhir)).map(procedureFeeScheduleItem),
  );
}
```

Keep the existing `listProcedureFeeSchedule` behavior by calling `ensureProcedureFeeSchedule` before the same merge. Do not edit the selector function.

- [ ] **Step 5: Run green and compare selector byte-for-byte**

```bash
cd mcp
node --import tsx --test src/__tests__/procedure-fee-import.test.ts
cd ..
sed -n '/export async function listActiveCodedNonVisitProcedureFees/,/^}/p' \
  mcp/src/clinical-graph/procedure-fee-schedule.ts > /tmp/fee-selector-head.txt
cmp /tmp/fee-selector-base.txt /tmp/fee-selector-head.txt
```

Expected: tests pass and `cmp` exits 0.

- [ ] **Step 6: Commit routing and snapshot**

```bash
git add mcp/src/clinical-graph/procedure-fee-schedule.ts \
  mcp/src/__tests__/procedure-fee-import.test.ts
git commit -m "feat: record fee import routing"
```

---

### Task 3: Strict CSV Inspection and Proposal Builder

**Files:**
- Create: `mcp/src/clinical-graph/procedure-fee-import.ts`
- Modify: `mcp/src/__tests__/procedure-fee-import.test.ts`

**Interfaces:**
- Produces: `FeeImportColumnMapping`, `FeeImportFlag`, `FeeImportProposal`, `FeeImportMatchOption`, `FeeImportPreview`.
- Produces: `inspectProcedureFeeCsv(csvText)` and `proposeProcedureFeeImport({ csvText, mapping, existing })`.
- Consumes: `procedureConceptKeyFromDisplay`, seed metadata, current snapshot items.

- [ ] **Step 1: Write failing strict-inspection tests**

Add tests using arbitrary synthetic headers:

```ts
test("CSV inspection uses strict legacy-import conventions and operator-overridable suggestions", () => {
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
  assert.throws(() => inspectProcedureFeeCsv("Name,Name\nOne,Two\n"), /duplicate CSV header/i);
  assert.throws(() => inspectProcedureFeeCsv('Name,Fee\n"Synthetic,12.00\n'), /CSV could not be parsed/i);
});

test("inspection allows no display suggestion so the operator can map an arbitrary column", () => {
  const result = inspectProcedureFeeCsv("Alpha,Beta\nSynthetic service,Procedure\n");
  assert.equal(result.suggestedMapping.display, undefined);
});
```

- [ ] **Step 2: Run inspection tests and confirm red**

```bash
cd mcp
node --import tsx --test --test-name-pattern="CSV inspection|inspection rejects|inspection allows" \
  src/__tests__/procedure-fee-import.test.ts
```

- [ ] **Step 3: Implement strict inspection**

Use:

```ts
import { parse } from "csv-parse/sync";

type CsvRows = { headers: string[]; rows: Array<Record<string, string>> };

function parseFeeCsv(csvText: string): CsvRows {
  let headers: string[] = [];
  try {
    const rows = parse(csvText, {
      bom: true,
      columns: (incoming: string[]) => {
        headers = incoming.map((header) => header.trim());
        assertUniqueNonblankHeaders(headers);
        return headers;
      },
      skip_empty_lines: true,
    }) as Array<Record<string, string>>;
    if (headers.length === 0 || rows.length === 0) {
      throw new ProcedureFeeImportInputError("CSV must contain a header and at least one data row.");
    }
    return { headers, rows };
  } catch (error) {
    if (error instanceof ProcedureFeeImportInputError) throw error;
    throw new ProcedureFeeImportInputError("CSV could not be parsed with strict quoting and column counts.");
  }
}
```

Implement deterministic header scoring from normalized generic aliases. Return suggestions only; do not reject an empty display suggestion.

- [ ] **Step 4: Write failing proposal-rule tests with one synthetic corpus**

Build `SYNTHETIC_FEE_IMPORT_CSV` that includes:

- an RT/LT pair with a shared synthetic base code;
- two equivalent duplicate rows;
- two `.1`/`.2` local price-tier rows sharing one synthetic base code;
- a zero-price scheduling row;
- an RGP bifocal row;
- active invalid-name, zero-price contradiction, obsolete, superseded, missing category, invalid price, invalid boolean, and `.50` heuristic rows;
- an active/status header that can be deliberately left unmapped.

Use only `SYNTH...` codes and invented prices. Assert exact proposal counts, source-row reconciliation, reasons, and every flag class. Add these separate tests with the named assertions:

| Test name | Required assertions |
|---|---|
| `proposal rejects a missing display mapping or any blank mapped display with row numbers` | missing mapping throws before proposals; one blank cell reports its 1-based CSV row; no source cell content appears in the error |
| `laterality rows collapse once and drop concept laterality with the charge-side reason` | two source rows map to one proposal; `sourceRows` contains both; modifier is absent; one `laterality-dropped` flag and the exact charge-side reason render |
| `local price tiers remain separate concepts sharing one derived billing code` | two proposals survive; concept keys differ; billing codes are identical; neither has a laterality flag |
| `every required integrity class flags its row without failing proposal generation` | the returned flag-class set equals the declared synthetic matrix and proposals still return |
| `an available unmapped active column is visible on affected proposals` | every proposal has `active-column-unmapped`; mapping that header removes the flag and respects false rows |
| `seeded matches inherit display and category without category-required` | decision is match; target is seeded; match option supplies immutable display/category; the proposal has no category-required flag |
| `RGP bifocal and scheduling-only rows default to explicit skip` | both decisions are skip with distinct visible reasons; source-row accounting remains complete |

- [ ] **Step 5: Run proposal tests and confirm red**

```bash
cd mcp
node --import tsx --test src/__tests__/procedure-fee-import.test.ts
```

- [ ] **Step 6: Implement normalization, flags, collapse, and default decisions**

Define exact public unions:

```ts
export const FEE_IMPORT_ROUTINGS = ["insurance-billable", "self-pay", "scheduling-only"] as const;
export type FeeImportRouting = (typeof FEE_IMPORT_ROUTINGS)[number];
export type FeeImportDecision = "match" | "create" | "skip";
export type FeeImportFlagClass =
  | "invalid-active-code-name"
  | "zero-price-contradiction"
  | "obsolete-or-superseded"
  | "category-required"
  | "routing-required"
  | "active-column-unmapped"
  | "laterality-dropped"
  | "invalid-price"
  | "invalid-source-boolean"
  | "concept-key-conflict";
```

Implement one mapped-row pass, then laterality collapse, duplicate collapse, concept-key conflict marking, and default decision resolution. Use `procedureConceptKeyFromDisplay` for meaning and identity. Preserve `sourceRows` and transient `originalCode`. Treat `.50` as a flagged heuristic, never as verified source truth.

For exact seeded matches, set `decision: "match"`, `matchProcedureConceptKey`, and `matchSeeded: true`; suppress `category-required` and include seed metadata in top-level match options. Do not require source category.

- [ ] **Step 7: Run focused green and commit parser/proposal**

```bash
cd mcp
node --import tsx --test src/__tests__/procedure-fee-import.test.ts
cd ..
git add mcp/src/clinical-graph/procedure-fee-import.ts \
  mcp/src/__tests__/procedure-fee-import.test.ts
git commit -m "feat: propose mapped fee imports"
```

---

### Task 4: Sequential Commit and Practice-Admin Endpoints

**Files:**
- Modify: `mcp/src/clinical-graph/procedure-fee-import.ts`
- Create: `mcp/src/clinical-graph/procedure-fee-import-endpoint.ts`
- Modify: `mcp/src/__tests__/procedure-fee-import.test.ts`
- Modify: `mcp/src/index.ts`

**Interfaces:**
- Produces: `commitProcedureFeeImport(fhir, proposals)` with per-row outcomes.
- Produces: `handleProcedureFeeImportPreviewRequest` and `handleProcedureFeeImportCommitRequest`.
- Routes: `POST /clinical-graph/fee-schedule/import/preview` and `/commit`.

- [ ] **Step 1: Write failing no-write, authorization, and commit tests**

Add the following named tests and exact outcome assertions:

| Test name | Required assertions |
|---|---|
| `preview inspect and propose are practice-admin only and perform zero FHIR writes` | unauthenticated 401; clinician 403; admin 200; `createCount === 0`; `updateCount === 0`; seed count unchanged |
| `commit reports create match skip failure and later success without hiding partial results` | statuses equal `created, matched, skipped, failed, created`; counts match; final row exists despite prior failure |
| `scheduling-only commit is always a no-write skip even with a stale create decision` | status skipped; create/update counts unchanged |
| `seeded match inherits immutable display and category and never supplies them to save` | captured save input has no own display/category; seed resource retains exact title/category |
| `committing the same reviewed proposals twice creates no duplicate concepts` | one key after both commits; second create count does not increase; returned second status is matched |
| `a second preview resolves the previously created concept as a match` | first decision create; after commit the same CSV/mapping returns match to the same generated key |
| `uncoded import stays out of the unchanged selector until a code is saved` | selector excludes after uncoded create and includes exactly once after coded match |
| `routing persists while both insurance and self-pay remain chartable` | both values round-trip; selector returns both; no ChargeItem/claim file is touched |

The partial-success fixture makes the second row fail through the real modifier guard and asserts the third row still writes. Count create/update calls and inspect all returned outcome statuses.

- [ ] **Step 2: Run endpoint/commit tests and confirm red**

```bash
cd mcp
node --import tsx --test src/__tests__/procedure-fee-import.test.ts
```

- [ ] **Step 3: Implement sequential commit**

Use a per-row Zod `safeParse`, current search-only snapshot, and this control flow:

```ts
for (const raw of proposals) {
  const parsed = commitProposalSchema.safeParse(raw);
  if (!parsed.success) {
    outcomes.push(failedOutcome(proposalId(raw), parsed.error.issues[0]?.message));
    continue;
  }
  const proposal = parsed.data;
  if (proposal.decision === "skip" || proposal.routing === "scheduling-only") {
    outcomes.push(skippedOutcome(proposal.proposalId));
    continue;
  }
  try {
    const snapshot = await listProcedureFeeScheduleSnapshot(fhir);
    const target = resolveCommitTarget(proposal, snapshot);
    if (target) {
      const seeded = isSeededProcedureFeeConceptKey(target.procedureConceptKey);
      const item = await saveProcedureFeeScheduleItem(fhir, {
        procedureConceptKey: target.procedureConceptKey,
        ...(!seeded ? { display: proposal.display, category: proposal.category } : {}),
        billingCode: proposal.billingCode ?? null,
        modifier: proposal.modifier ?? null,
        priceCents: proposal.priceCents ?? null,
        routing: proposal.routing,
        active: proposal.active,
      });
      outcomes.push(matchedOutcome(proposal.proposalId, item.procedureConceptKey));
    } else {
      const item = await createProcedureFeeScheduleItem(fhir, {
        display: proposal.display,
        category: proposal.category,
        billingCode: proposal.billingCode ?? null,
        modifier: proposal.modifier ?? null,
        priceCents: proposal.priceCents ?? null,
        routing: proposal.routing,
        active: proposal.active,
      });
      outcomes.push(createdOutcome(proposal.proposalId, item.procedureConceptKey));
    }
  } catch (error) {
    outcomes.push(failedOutcome(proposal.proposalId, safeCommitMessage(error)));
  }
}
```

`safeCommitMessage` may return known validation/conflict messages but never source row content, original code, CSV text, or a serialized proposal.

- [ ] **Step 4: Implement endpoint schemas and authorization**

Use the same staff/practice-admin pattern as the existing fee-schedule endpoint. Preview action `inspect` calls only the CSV inspector. Preview action `propose` calls `listProcedureFeeScheduleSnapshot` and the proposal builder. Commit validates the collection wrapper, then lets the core return per-row failures.

Register both POST routes in `mcp/src/index.ts` with `identity.manage` route dependencies and generic route-level 500 messages that contain no request body.

- [ ] **Step 5: Run green, build, and route regressions**

```bash
cd mcp
node --import tsx --test src/__tests__/procedure-fee-import.test.ts \
  src/__tests__/procedure-fee-prerequisite.test.ts
npm run build
```

- [ ] **Step 6: Commit server import flow**

```bash
git add mcp/src/clinical-graph/procedure-fee-import.ts \
  mcp/src/clinical-graph/procedure-fee-import-endpoint.ts \
  mcp/src/__tests__/procedure-fee-import.test.ts \
  mcp/src/index.ts
git commit -m "feat: commit reviewed fee imports"
```

---

### Task 5: Typed UI Client

**Files:**
- Create: `ui/src/lib/procedure-fee-import.ts`
- Create/Modify: `ui/tests/feeScheduleImport.test.tsx`

**Interfaces:**
- Produces: UI copies of preview/proposal/match/outcome types.
- Produces: `procedureFeeImportApi(fetchImpl)` with `inspect`, `propose`, and `commit`.

- [ ] **Step 1: Write failing client request tests**

Add `fee import client sends inspect propose and commit only to server-mediated endpoints`: capture three requests through injected fetch, return minimal typed synthetic bodies, and assert URLs are exactly `/clinical-graph/fee-schedule/import/preview`, `/preview`, and `/commit`; every method is POST; preview bodies carry `action: inspect` then `action: propose`; commit carries only reviewed proposals; all have JSON/auth headers.

Add `fee import client surfaces safe server errors without echoing the CSV`: make injected fetch return `400 { error: "CSV could not be parsed with strict quoting and column counts." }`, call inspect with a unique secret-like synthetic cell, and assert the thrown message equals the server error and excludes that cell.

- [ ] **Step 2: Run UI client tests and confirm red**

```bash
cd ui
node --import tsx --test tests/feeScheduleImport.test.tsx
```

- [ ] **Step 3: Implement the typed client**

Use `authHeaders()` and `clinicalGraphApiBase()` from `clinical-graph-client.ts`. Define:

```ts
export interface ProcedureFeeImportApi {
  inspect(csvText: string): Promise<FeeImportInspection>;
  propose(csvText: string, mapping: FeeImportColumnMapping): Promise<FeeImportPreview>;
  commit(proposals: FeeImportProposal[]): Promise<FeeImportCommitResult>;
}
```

POST inspect/propose to `/clinical-graph/fee-schedule/import/preview` and commit to `/commit`. Parse server error bodies and never concatenate `csvText` into an error.

- [ ] **Step 4: Run green and commit client**

```bash
cd ui
node --import tsx --test tests/feeScheduleImport.test.tsx
cd ..
git add ui/src/lib/procedure-fee-import.ts ui/tests/feeScheduleImport.test.tsx
git commit -m "feat: add fee import client"
```

---

### Task 6: Upload, Mapping, Editable Review, and Commit UI

**Files:**
- Create: `ui/src/scenes/settings/FeeScheduleImport.tsx`
- Modify: `ui/src/scenes/settings/FeeScheduleSettings.tsx`
- Modify: `ui/tests/feeScheduleImport.test.tsx`
- Modify: `ui/tests/feeScheduleSettings.test.tsx` only if the mount/refresh assertion cannot live in the import test; do not rewrite existing assertions.

**Interfaces:**
- Produces: `FeeScheduleImport({ api, onCommitted })`.
- Consumes: server proposals and match options without reimplementing parser/collapse logic.

- [ ] **Step 1: Write failing rendered workflow tests**

Use an injected memory API and `react-test-renderer`. Implement this rendered matrix:

| Test name | Required rendered/action assertions |
|---|---|
| `fee import upload and paste both inspect before mapping and make no commit` | paste calls inspect once; a synthetic `File.text()` upload replaces text and calls inspect; commit call count stays zero |
| `mapping suggestions are visible operator-overridable and missing display blocks proposal` | suggested selects render; changing display select changes propose mapping; clearing it disables review/build and shows display reason |
| `review renders create match skip flagged counts and every mutable field` | exact count text renders; display/category/code/modifier/price/routing/decision/match controls exist where mutable; all flag messages render |
| `seeded match inherits read-only display and category while practice match stays editable` | seeded row has text and no enabled display/category controls; changing target to a practice item enables them |
| `recorded-only modifier and routing warning is visible` | exact approved warning text occurs once |
| `abandon review clears transient state without a commit request` | review table disappears; upload stage returns; commit calls remain zero |
| `one explicit commit renders mixed created matched skipped and failed row outcomes` | one button click calls commit once; all four statuses/messages remain visible per proposal id |
| `read-only fee settings render no import upload or commit controls` | `canWrite={false}` output has neither file input nor import action buttons |
| `price tiers committed into the worksheet render as one existing derived family` | existing `CatalogEditor` renders one family code input and both distinct concept displays |

The abandon test's load-bearing failure is any `api.commit` invocation. The family test uses the existing `feeScheduleDescriptor`/`CatalogEditor`, not a new family implementation.

- [ ] **Step 2: Run UI tests and confirm expected red**

```bash
cd ui
node --import tsx --test tests/feeScheduleImport.test.tsx
```

- [ ] **Step 3: Implement the three-stage component**

State:

```ts
const [csvText, setCsvText] = useState("");
const [inspection, setInspection] = useState<FeeImportInspection | null>(null);
const [mapping, setMapping] = useState<FeeImportColumnMapping>({});
const [preview, setPreview] = useState<FeeImportPreview | null>(null);
const [outcomes, setOutcomes] = useState<Record<string, FeeImportCommitOutcome>>({});
const [busy, setBusy] = useState(false);
const [error, setError] = useState<string | null>(null);
```

File selection reads `await file.text()` into the same transient `csvText` state as paste. `Inspect CSV` calls inspect; `Build review` calls propose; `Abandon review` resets all transient state without calling the API; `Commit reviewed proposals` calls commit exactly once.

Render one mapping select for display, category, billing code, modifier, price, routing, active, and zero-price. Render the suggestion as selected state but allow empty/any real header.

Render review counts from current edited proposals. For a seeded match target, resolve its match option and show immutable display/category text; otherwise render text/select inputs. Always render billing code, modifier, price, routing, decision, and match target controls where applicable. Scheduling-only remains visible as skip.

Show exactly:

```txt
Modifier and routing are recorded only in this version. They do not currently change chart selection or claims. Side comes from each charge.
```

- [ ] **Step 4: Mount the importer and refresh worksheet after commit**

In `FeeScheduleSettings`, create an adapter and refresh revision. Render `<FeeScheduleImport>` only when `canWrite`, before `CatalogEditor`. Give `CatalogEditor` a revision key or equivalent reload trigger after any successful commit outcome so newly imported rows appear in the existing worksheet/family view. Preserve the read-only banner and existing descriptor.

- [ ] **Step 5: Run focused green and UI build**

```bash
cd ui
node --import tsx --test tests/feeScheduleImport.test.tsx tests/feeScheduleSettings.test.tsx
npm run build
```

- [ ] **Step 6: Commit UI workflow**

```bash
git add ui/src/scenes/settings/FeeScheduleImport.tsx \
  ui/src/scenes/settings/FeeScheduleSettings.tsx \
  ui/tests/feeScheduleImport.test.tsx \
  ui/tests/feeScheduleSettings.test.tsx
git commit -m "feat: review fee schedule imports"
```

---

### Task 7: Acceptance Matrix and Protected Regression Proof

**Files:**
- Modify tests only where a named acceptance gap remains.
- Do not modify protected test files.

**Interfaces:**
- Produces: named evidence for all eleven acceptance items and storage-only behavior.

- [ ] **Step 1: Map every acceptance item to a real test**

Create a temporary checklist (not committed) listing acceptance items 1–11, the exact test name, and the production mutation that makes it red. If an item lacks direct evidence, add the smallest test to `procedure-fee-prerequisite.test.ts`, `procedure-fee-import.test.ts`, or `feeScheduleImport.test.tsx` using TDD.

- [ ] **Step 2: Run all focused acceptance tests**

```bash
cd mcp
node --import tsx --test \
  src/__tests__/procedure-fee-prerequisite.test.ts \
  src/__tests__/procedure-fee-import.test.ts \
  src/__tests__/visit-billing-codes.test.ts \
  src/__tests__/procedure-charges.test.ts \
  src/__tests__/procedure-charge-laterality.test.ts
cd ../ui
node --import tsx --test tests/feeScheduleImport.test.tsx tests/feeScheduleSettings.test.tsx
```

Record total/pass/fail/skip per file.

- [ ] **Step 3: Prove protected files and selector are unchanged**

```bash
git diff --exit-code 6ec4b94d -- \
  mcp/src/__tests__/visit-billing-codes.test.ts \
  mcp/src/__tests__/procedure-charges.test.ts \
  mcp/src/__tests__/procedure-charge-laterality.test.ts
sed -n '/export async function listActiveCodedNonVisitProcedureFees/,/^}/p' \
  mcp/src/clinical-graph/procedure-fee-schedule.ts > /tmp/fee-selector-head.txt
cmp /tmp/fee-selector-base.txt /tmp/fee-selector-head.txt
```

- [ ] **Step 4: Commit any test-only acceptance additions**

If files changed in Step 1:

```bash
git add mcp/src/__tests__/procedure-fee-prerequisite.test.ts \
  mcp/src/__tests__/procedure-fee-import.test.ts \
  ui/tests/feeScheduleImport.test.tsx
git commit -m "test: prove fee import acceptance"
```

If nothing changed, do not create an empty commit.

---

### Task 8: Full Gates, Literal Mutations, Real-Corpus Dry Run, and PR

**Files:**
- No production edits unless a gate exposes a bug; any bug fix starts with a failing regression.

- [ ] **Step 1: Read and apply verification-before-completion skill**

Read `/Users/ericr.bang/.codex/plugins/cache/superpowers-marketplace/superpowers/6.2.0/skills/verification-before-completion/SKILL.md` completely before claiming success.

- [ ] **Step 2: Record credential presence without values**

Check the exact environment key names used by MCP integration gates and report only present/absent. Do not print `.env` values.

- [ ] **Step 3: Run full gates with owned exit codes and untruncated logs**

Use separate commands and redirect each to a temporary file:

```bash
npm run preflight > /tmp/fee-p1-preflight.log 2>&1
preflight_status=$?

(cd mcp && npm run build) > /tmp/fee-p1-mcp-build.log 2>&1
mcp_build_status=$?
(cd mcp && npm test) > /tmp/fee-p1-mcp-test.log 2>&1
mcp_test_status=$?

(cd ui && npm run build) > /tmp/fee-p1-ui-build.log 2>&1
ui_build_status=$?
(cd ui && npm test) > /tmp/fee-p1-ui-test.log 2>&1
ui_test_status=$?
```

Inspect logs and report each runner's total/passed/failed/skipped counts plus each captured status. Do not treat a grep/tail pipeline as the gate.

- [ ] **Step 4: Mutation proof A — laterality denylist**

Use `apply_patch` to remove `RT` from `DISALLOWED_CONCEPT_LATERALITY_MODIFIERS`. Run:

```bash
cd mcp
node --import tsx --test src/__tests__/procedure-fee-prerequisite.test.ts \
  > /tmp/fee-p1-mutation-a-red.tap 2>&1
mutation_a_red_status=$?
```

Require nonzero status and literal `not ok` for the RT guard test. Restore using `apply_patch`, rerun to `/tmp/fee-p1-mutation-a-green.tap`, require status 0 and literal `ok`, then `git diff --check`.

- [ ] **Step 5: Mutation proof B — re-import idempotency**

Use `apply_patch` to bypass the current-key-to-match branch so a reviewed create attempts `createProcedureFeeScheduleItem` again. Run the focused import test to `/tmp/fee-p1-mutation-b-red.tap`; require nonzero status and literal `not ok` for the re-import test. Restore, rerun green, and require a clean diff from the final implementation.

- [ ] **Step 6: Counts-only real-corpus dry run**

If readable, load `/Users/ericr.bang/GitHub/performance-od/.context/iva-fee-schedule-2026-08-11/in-scope-codes.csv` through the production inspector/proposal builder. Use only the suggested mapping plus explicit operator-approved mapping corrections needed for the known corpus. Do not print or save rows.

Report only:

```txt
rows parsed: N
proposed create: N
proposed match: N
proposed skip: N
flagged proposals: N
flag invalid-active-code-name: N
flag zero-price-contradiction: N
flag obsolete-or-superseded: N
flag category-required: N
flag routing-required: N
flag active-column-unmapped: N
flag laterality-dropped: N
flag invalid-price: N
flag invalid-source-boolean: N
flag concept-key-conflict: N
laterality collapses: N
```

Do not emit codes, prices, names, headers, or row contents. If unreadable, state that and skip.

- [ ] **Step 7: Final worktree and diff checks**

```bash
git diff --check
git status --short --branch
git log --oneline 6ec4b94d..HEAD
git diff --stat 6ec4b94d...HEAD
```

Require no uncommitted files before publication. Re-run the protected selector/test-file comparisons at the final head.

- [ ] **Step 8: Publish non-draft PR**

Push `drbang-iva/fee-schedule-import-p1` and open a non-draft PR against `main`. The body must contain:

- prerequisite section with storage-only modifier statement;
- routing section stating recorded-only, inert, and no selector/claim behavior;
- upload/map/propose/review/commit behavior;
- scope fences;
- real gate commands, exits, and counts;
- eleven-item behavioral evidence;
- literal TAP red/green for both mutations;
- counts-only real-corpus report;
- files and commits;
- risks/follow-ups, including future modifier/routing/laterality wire work and deferred import-ledger traceability; and
- `⚠️ NOT EVALUATED — hand to Fable/Opus in Claude for the independent eval before merge. I wrote it; I can't be the judge.`

Adjudicate every Greptile and PR-Agent finding already present at the final head. Re-poll both bots at the final head; zero threads while a check is in progress is pending, not clean. Do not trigger or mention CodeRabbit.
