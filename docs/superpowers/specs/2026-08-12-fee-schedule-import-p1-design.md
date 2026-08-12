# Fee Schedule Import P1 Design

**Status:** Approved architecture with Amendment 1 incorporated  
**Base:** `main` at `6ec4b94d`  
**Branch:** `drbang-iva/fee-schedule-import-p1`

## Purpose

Add a practice-admin fee-schedule import lane that accepts an arbitrary prior-PMS CSV, lets the operator map columns, produces a fully editable no-write proposal, and applies the reviewed rows in one explicit commit action. Re-importing the same source must resolve existing concept keys as matches instead of creating duplicates.

This slice also closes two P0 write-boundary defects before the importer can introduce data:

1. A fee-schedule concept may not store fixed-side modifiers `RT`, `LT`, or `50`. Side comes from each charge's `ChargeItem.bodysite`.
2. A save request may not submit a display or category for an ODOS-seeded concept and have the value silently ignored.

## Non-negotiable boundaries

- The import is an accelerator for the existing guided worksheet, not an alternate fee-schedule model.
- Only practice-admin users may inspect, preview, or commit imports.
- Preview is read-only. Parsing, mapping, proposal generation, editing, and abandonment cause zero FHIR writes.
- The practice's real CSV stays outside this repository. Committed tests use synthetic codes and synthetic prices only.
- No payer allowance, coverage rule, frequency rule, automatic approval, or automatic commit is added.
- No original-PMS-code schema field is added. Original values exist only in the transient review model.
- No materialization, claim assembly, `ChargeItem` shape, or claim behavior changes.
- `listActiveCodedNonVisitProcedureFees` remains byte-identical.
- Existing seeded concepts and fee history are never rewritten during preview and are changed during commit only through the existing fee-schedule save contract.
- The CPT guard must remain green.

## Two recorded-only fields

The worksheet will contain two fields whose values are deliberately inert in this slice:

- **Modifier** remains storage-only. It does not reach `ChargeItem`, Claim, or Claim.MD today. Fixed-side values are rejected now so unsafe latent data cannot become claim behavior later.
- **Routing** is persisted as operator triage but is not enforced. Both `insurance-billable` and `self-pay` concepts remain chartable under the existing active, coded, non-visit selector. `scheduling-only` rows create no fee definition.

The import UI and pull-request body must say that both fields are recorded but do not currently bill or route a claim. A later slice may wire concept modifiers, routing, and charge laterality into wire behavior together. P1 must not quietly make either field behavioral.

## Prerequisite write guards

### Laterality modifier guard

`normalizeModifier` continues to trim, uppercase, and accept legitimate alphanumeric concept modifiers up to ten characters. After normalization it rejects `RT`, `LT`, and `50` with this reason:

> Laterality modifier RT is not allowed on a fee-schedule concept. Side comes from the charge (ChargeItem.bodysite), not the concept.

The named value changes in the message. The same production validator is reached by:

- direct `createProcedureFeeScheduleItem`;
- direct `saveProcedureFeeScheduleItem`;
- the ordinary create and save endpoints;
- import commit create and match paths; and
- `buildProcedureFeeDefinition` when called directly.

A legitimate synthetic component or post-operative modifier continues to round-trip through its FHIR extension. No modifier is projected to a charge or claim.

### Seeded immutable-field guard

When `saveProcedureFeeScheduleItem` receives an own `display` or `category` property for a key in `PROCEDURE_FEE_SEEDS`, it rejects the request before any update, even if the submitted value equals the seed. This makes the API contract unambiguous and prevents accepted-but-ignored writes.

The endpoint converts both prerequisite validation failures to HTTP 400 with the production reason. The seeded definition is byte-equivalent before and after rejection.

These guards form the first independently verifiable commit and have a dedicated pull-request section.

## Stored routing representation

`ChargeItemDefinition` receives one ODOS extension for recorded routing:

- URL: `https://odos2020.com/fhir/StructureDefinition/odos-procedure-fee-routing`
- allowed persisted values: `insurance-billable` and `self-pay`

`scheduling-only` is valid on a transient import proposal but is never persisted because that proposal produces no definition.

The existing definition builder preserves unrelated extensions, replaces only the ODOS category, modifier, and routing extensions it owns, and exposes routing on `ProcedureFeeScheduleItem`. Create and save accept optional routing. No read path filters, sorts, materializes, or claims from routing.

## Server import API

### Preview endpoint

`POST /clinical-graph/fee-schedule/import/preview` is a read-only, practice-admin endpoint with two actions.

#### Inspect

Request:

```ts
{
  action: "inspect";
  csvText: string;
}
```

Response:

```ts
{
  headers: string[];
  rowCount: number;
  suggestedMapping: FeeImportColumnMapping;
}
```

It parses the CSV, returns its actual columns, and suggests mappings using normalized generic header aliases. It never requires an IVA-specific header. Duplicate or blank headers, malformed CSV, and no data rows return clear HTTP 400 errors. If no display suggestion is possible, inspection still succeeds with that suggestion empty so the operator can choose any actual column; proposal generation is the point that requires the chosen column to produce a display for every row.

#### Propose

Request:

```ts
{
  action: "propose";
  csvText: string;
  mapping: FeeImportColumnMapping;
}
```

The required operator-facing mapping fields are:

```ts
type FeeImportColumnMapping = {
  display?: string;
  category?: string;
  billingCode?: string;
  modifier?: string;
  price?: string;
  routing?: string;
  active?: string;
  zeroPrice?: string;
};
```

`active` and `zeroPrice` are optional source-check mappings used only for integrity flags. Every selected mapping value must name an actual parsed header. `display` is required before proposal generation. A mapped display column with any blank row produces a rejected preview with row-specific reasons and no partial proposal.

The endpoint reads the current fee schedule to resolve matches, but it never creates or updates a FHIR resource.

### Commit endpoint

`POST /clinical-graph/fee-schedule/import/commit` accepts the operator-reviewed proposals. It validates the top-level request, then processes rows sequentially. Each row produces one outcome:

```ts
type FeeImportCommitOutcome = {
  proposalId: string;
  status: "created" | "matched" | "skipped" | "failed";
  procedureConceptKey?: string;
  message: string;
};
```

The response includes every outcome and counts by status. A failed row does not roll back prior successful rows and does not prevent later rows from being attempted. Partial success is visible, never collapsed into a generic success.

Commit uses only `createProcedureFeeScheduleItem` and `saveProcedureFeeScheduleItem` for FHIR writes. It does not introduce a bulk transaction or a second fee-definition builder.

## CSV parsing and header suggestions

The server uses the repository's existing `csv-parse` dependency with headers enabled and strict column counts. It accepts quoted commas, embedded newlines, CRLF or LF, and a UTF-8 byte-order mark. It rejects malformed quoting and duplicate header names rather than guessing.

Header suggestions normalize case, punctuation, and whitespace and score generic aliases for:

- display/name/description/service/procedure;
- category/group/type;
- billing/code/procedure code/service code;
- modifier;
- price/fee/amount/charge;
- routing/route/purpose;
- active/status; and
- zero-price indicators.

Suggestions are conveniences only. The operator can replace or clear every mapping before proposal generation.

## Transient proposal model

Every source row is accounted for exactly once. When collapse rules combine rows, their source row numbers are attached to one canonical proposal and the collapsed rows remain visible through reasons rather than becoming hidden writes.

```ts
type FeeImportRouting = "insurance-billable" | "self-pay" | "scheduling-only";
type FeeImportDecision = "match" | "create" | "skip";

type FeeImportProposal = {
  proposalId: string;
  sourceRows: number[];
  originalCode?: string;
  decision: FeeImportDecision;
  matchProcedureConceptKey?: string;
  display: string;
  category?: ProcedureFeeCategory;
  billingCode?: string;
  modifier?: string;
  priceCents?: number;
  routing?: FeeImportRouting;
  active: boolean;
  flags: FeeImportFlag[];
  reasons: string[];
};
```

`originalCode` is returned only to the active review session. It is not written to FHIR, a file, logs, or provenance.

Proposal IDs are deterministic from source row numbers. Concept identity is authoritative on the server and uses `procedureConceptKeyFromDisplay`.

## Normalization and proposal rules

### Basic field normalization

- Display trims and collapses whitespace while preserving operator-facing capitalization.
- Billing code and modifier trim and uppercase.
- Prices accept plain decimal dollars, optional currency punctuation, and parenthesized negatives. Negative, non-finite, or fractional-cent inputs are flagged and left unresolved for operator correction.
- Category values are mapped only when they unambiguously name one of the existing four worksheet categories. Unknown or blank source values do not default to `procedure`.
- Routing values are mapped only when they unambiguously name one of the three import routes. Unknown or blank values remain unresolved for operator correction.
- Common explicit true/false values are recognized for active and zero-price source checks. An absent active source-check mapping means `active: true`, matching a fee-schedule import's create default; an explicitly mapped but unknown value is flagged rather than coerced.

### Compound and tiered code handling

The mapped billing-code cell is retained transiently as `originalCode`.

- A final `.RT`, `.LT`, or `.50` suffix is treated as a fixed-side modifier, removed from the billing code, dropped from the concept modifier, and flagged with the charge-side reason.
- A final numeric local suffix other than `.50` is treated as a local price-tier suffix. The suffix is removed from the payer billing code while the row remains a separate concept. Rows in the tier therefore derive the worksheet's existing family solely by sharing one billing code.
- A separate mapped modifier column follows the same laterality-drop rule.

No original-code field or explicit family identifier is stored.

### Collapse order

Rules run in this order so every input row has one visible disposition:

1. Normalize compound codes and drop fixed-side modifiers.
2. Collapse rows that share a billing code and are otherwise equal except for a fixed-side modifier. The surviving proposal names all source rows and says: `Laterality rows collapsed; side comes from the charge.`
3. Collapse rows with the same billing code, same price, and the same normalized display meaning. The surviving proposal names all source rows and says that the duplicate was collapsed.
4. Preserve distinct price-tier meanings as separate proposals sharing the derived base billing code. The existing P0 family renderer groups them; no new family storage is added.

Normalized display meaning uses the existing display-to-concept-key transformation after removing only explicit fixed-side suffix words. It does not perform clinical synonym inference.

### Default decisions

- A row whose mapped routing is `scheduling-only` defaults to `skip` and never produces a definition.
- A display that clearly names the operator-excluded RGP bifocal tier defaults to `skip` with the ruling reason.
- Otherwise, an exact generated concept-key match against a seeded or practice-created concept defaults to `match`.
- Otherwise the row defaults to `create`.

The operator can change match/create/skip, choose a match target, and edit every imported field before commit. Changing routing to `scheduling-only` forces a no-write skip at commit even if a stale client submits another decision.

## Integrity flags

Flags are attached to their proposal and never make the entire import fail:

- `invalid-active-code-name`: the source explicitly says active and the display declares an invalid service or procedure code;
- `zero-price-contradiction`: the source zero-price flag is true and the parsed price is non-zero;
- `obsolete-or-superseded`: the display declares the row obsolete or superseded;
- `category-required`: the mapped category source is absent, blank, or unrecognized;
- `routing-required`: routing is absent, blank, or unrecognized;
- `laterality-dropped`: a mapped or compound modifier is `RT`, `LT`, or `50` and was dropped because side comes from the charge;
- `invalid-price`: the mapped price cannot be represented as nonnegative whole cents;
- `invalid-source-boolean`: an active or zero-price source check is present but unrecognized; and
- `concept-key-conflict`: two non-collapsible proposals generate the same concept key.

The count labeled `flagged` is the number of proposals with at least one flag, not the total number of flag instances. The dry-run report additionally breaks down flag instances by class.

## Review UI

`FeeScheduleSettings` remains the worksheet home. A practice-admin-only import panel opens above the existing `CatalogEditor`; read-only users see neither upload nor commit controls.

The workflow has three visible stages:

1. **Upload or paste** — choose a `.csv` file or paste CSV text, then inspect it.
2. **Map columns** — one select per ODOS field plus the two optional source checks. Suggested values are visibly marked as suggestions and always editable. The operator explicitly continues to proposal generation.
3. **Review proposals** — one editable row per canonical proposal with source-row accounting, flags, collapse reasons, and commit outcome.

Every proposal exposes editable controls for:

- display;
- category;
- billing code;
- modifier;
- price;
- routing;
- decision; and
- match target when decision is `match`.

The header reports `N create · N match · N skip · N flagged`. Rows with flags remain committable after required fields are resolved; flags are warnings and evidence, not silent exclusion.

The panel states:

> Modifier and routing are recorded only in this version. They do not currently change chart selection or claims. Side comes from each charge.

`Abandon review` clears the transient CSV, mapping, proposals, and outcomes without an API mutation call. After commit, each row renders its returned status and message, including mixed success and failure.

## Commit semantics

### Create

For a reviewed `create` proposal, commit generates the key from the edited display immediately before the write.

- If the key does not exist, it calls `createProcedureFeeScheduleItem` with the reviewed fields.
- If the key already exists, including because the same file was previously committed, it treats the row as a match instead of issuing a second create.

This closes both ordinary re-import duplication and a stale-review race. The existing conditional-create outcome remains the final concurrency guard.

### Match

A reviewed `match` requires an existing target key.

- For a seeded target, commit never supplies display or category to save. The reviewed category must equal the immutable seed category; otherwise that row fails visibly. Billing code, allowed modifier, price, active state, and recorded routing may be saved.
- For a practice-created target, commit supplies the operator-reviewed display and category as well as billing code, allowed modifier, price, active state, and recorded routing.

No commit rewrites a seeded display or category.

### Skip

Skip produces an outcome but no FHIR call. `scheduling-only` always follows this path. An operator may also skip any other row.

### Required review values

Create and match require a nonblank display, a valid category, and an explicit non-scheduling routing. Create additionally requires a display that generates a valid concept key. Match requires a valid target. A billing code and price may remain absent, preserving the existing worksheet behavior; an uncoded active concept remains unchartable through the unchanged selector.

## Idempotency and existing data

- Preview against the same current fee schedule changes a previously created key from `create` to `match`.
- Committing the same reviewed payload twice creates at most one definition per key.
- An uncoded imported definition is absent from `listActiveCodedNonVisitProcedureFees`; saving a synthetic billing code makes it present through the existing unmodified filter.
- Preview performs no update, version bump, seed materialization, or create.
- Seeded definitions and unrelated historical versions are byte-equivalent unless the operator explicitly commits an allowed match update to that target.

## Error handling

- Authentication and role failures return the same 401/403 practice-admin language as the existing fee-schedule surface.
- CSV structure and mapping failures return 400 before proposal generation.
- A missing display column or any blank mapped display row rejects the whole preview with specific row numbers.
- Commit returns 200 for a syntactically valid batch even when individual rows fail; the body carries mixed outcomes and counts.
- A top-level malformed commit request returns 400 without writes.
- Per-row validation and FHIR failures are converted to that row's `failed` outcome. Processing then continues.
- Errors never include an entire CSV row or the CSV payload in server logs or response diagnostics.

## Test design

### Prerequisite group

Focused server tests invoke the real create/save functions and endpoint handlers. They prove:

- `RT`, `LT`, and `50` fail on create and save with a charge-side reason and zero writes;
- one legitimate synthetic modifier round-trips;
- seeded display and category submissions return 400 with no update; and
- the modifier extension remains absent from materialized ChargeItems and claims, documenting storage-only behavior without changing those paths.

The laterality mutation changes the denylist so `RT` is accepted. The focused test must emit literal TAP red, then return to green after restoration.

### Parser and proposal group

A synthetic CSV corpus exercises:

- arbitrary headers and suggested-but-overridable mappings;
- quoted CSV values and structural rejection;
- missing display-column rejection;
- laterality collapse with a visible reason;
- one duplicate collapse;
- separate local price tiers sharing one base synthetic billing code;
- scheduling-only no-definition routing;
- the excluded RGP bifocal default skip;
- every integrity flag class;
- category and routing remaining unresolved rather than silently defaulted; and
- exact match/create/skip/flagged counts.

Tests name the production behavior that would have to break for each load-bearing assertion to go red. They invoke the real parser and proposal builder rather than stubbing either function.

### Preview and commit group

Server tests use a write-counting in-memory FHIR client and real fee-schedule functions. They prove:

- inspect and propose make zero create/update calls;
- abandoning UI review makes zero mutation requests and zero FHIR writes;
- commit creates, matches, skips, and reports a forced mid-batch failure while later rows still run;
- a second proposal pass changes the created key to match;
- a repeated commit creates no duplicate concepts;
- scheduling-only never creates a definition;
- routing persists but changes no selector behavior;
- seeded display/category and existing seed definitions remain unchanged;
- an uncoded import is absent from the existing selector until coded; and
- practice-admin authorization protects preview and commit.

The idempotency mutation bypasses the existing-key-to-match branch and permits a second create attempt. The re-import test must emit literal TAP red, then green after restoration.

### UI group

Rendered React tests exercise the real import component and client adapter. They prove:

- upload and paste both reach inspection;
- mapping suggestions are visible and editable;
- missing display prevents proposal generation with a clear reason;
- every proposal field and decision are editable;
- counts and every row flag render;
- the recorded-only warning renders;
- abandon performs no commit request;
- commit occurs only from the explicit review action; and
- mixed per-row outcomes remain visible.

### Protected regressions

The following existing files must pass unchanged by name and count:

- `mcp/src/__tests__/visit-billing-codes.test.ts`
- `mcp/src/__tests__/procedure-charges.test.ts`
- `mcp/src/__tests__/procedure-charge-laterality.test.ts`

`listActiveCodedNonVisitProcedureFees` is checked byte-for-byte against the base commit before publication.

## Verification and publication

Required gates are run without output-truncating pipelines. Each command's own exit status and total/passed/failed/skipped counts are recorded:

```bash
npm run preflight
cd mcp && npm run build && npm test
cd ui && npm run build && npm test
```

The handoff reports whether Medplum credentials were present because credentialed MCP totals include additional environment-gated tests.

After all synthetic gates, the real off-git corpus at `performance-od/.context/iva-fee-schedule-2026-08-11/in-scope-codes.csv` is dry-run only. The report contains only:

- rows parsed;
- proposed create, match, skip, and flagged counts;
- counts by flag class; and
- laterality collapse count.

It contains no source code values, prices, names, or row contents.

The non-draft pull request has separate sections for the prerequisite, import flow, scope fences, real gate output, behavioral evidence, both literal mutation proofs, counts-only real-corpus dry run, and the two recorded-only fields. It states that Codex authored the slice and did not evaluate it. Independent Fable/Opus evaluation at the exact final head is required before merge.

## Acceptance inventory

1. `RT`, `LT`, and `50` are rejected on create and save with a reason naming the charge as the source of side; a legitimate modifier round-trips.
2. A seeded concept receiving display or category on save returns 400 and is unchanged.
3. Two synthetic rows differing only by laterality collapse to one proposal, drop laterality, and show the reason.
4. Synthetic price-tier rows remain separate concepts sharing one billing code and render as one P0-derived family.
5. A zero-price scheduling row routes to scheduling-only and produces no definition.
6. Every required flag class appears on its row without failing the import.
7. Abandoning review produces zero FHIR writes.
8. Re-import and repeated commit produce no duplicate concepts.
9. An uncoded imported concept is absent from the unchanged active-coded-non-visit selector until given a code.
10. Seeded concepts and existing fee history remain unchanged throughout preview and all disallowed writes.
11. The CPT guard remains green.
