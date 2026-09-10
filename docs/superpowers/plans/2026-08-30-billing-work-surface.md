> Historical bot guidance below is superseded by AGENTS.md: poll CodeRabbit and PR-Agent at the final head; do not trigger or wait for the former bot. Adjudicate all existing findings.

# Billing Work Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the routed per-item claims worklist with one health-gated, reason-grouped Work surface that makes batch follow-up the primary action while preserving ERA resolution capabilities.

**Architecture:** The existing claim read-model route remains the authoritative source for live claim groups and projection health. A new atomic batch-touch route composes the existing per-claim touch transactions into one FHIR transaction; the UI combines the healthy claim projection with the existing ERA Task projection, classifies both into seven Work lanes, and keeps legacy remits isolated in Unmatched. The existing `ClaimsWorklist.tsx` ERA components remain reusable by the Work drawer and Remittance Queue, but `/billing/claims/worklist` routes only to the new Work surface.

**Tech Stack:** TypeScript, Express, FHIR R4 transaction Bundles, React 18, Vite, Node test runner, react-test-renderer.

**Spec:** `/Users/ericr.bang/GitHub/performance-od/decisions/2026-08-30-odos-financial-claims-reporting-design.md` §§4.2, 7.7, 15.2, and 17, with the operator correction that Q13a removes pre-migration claims.

## Global Constraints

- Work from `origin/main` commit `703deac8` on `drbang-iva/work-surface-2b`; PR targets `main` and is never self-merged.
- Group-by-reason is the default; a repeated reason is one job and batch is its primary verb.
- Every expanded claim row shows days since billed and days since touched independently, last worker, and a sourced money-state chip.
- A stale, failed, or uninitialized claim projection renders no counts or groups as current.
- Legacy remits remain visibly separate in Unmatched, never enter live claim groups, and never become claim-watch inputs.
- Do not implement §7.8 remit-to-claim reconstruction, W2-W7, Week, Scorecard, the five-tab Billing shell, Ask, remittance posting, or auto-posting.
- Do not change the claim-touch ledger or claim read-model internals; reuse their exported builders and shapes.
- No medical terminology is added; Mandate 14 ledger changes are not required.

---

### Task 1: Atomic batch touch and legacy ERA disposition

**Files:**
- Modify: `mcp/src/claims/claim-follow-up-routes.ts`
- Modify: `mcp/src/claims/era-worklist.ts`
- Modify: `mcp/tests/claimFollowUpRoutes.test.ts`
- Modify: `mcp/tests/claimHandlers.test.ts`

**Interfaces:**
- Consumes: `buildClaimTouchTransaction`, `claimTouchRequestFingerprint`, and existing authenticated `ClaimFollowUpStaff`.
- Produces: `POST /claims/touches/batch` accepting `{ claimReferences, action, detail?, reasonCode?, idempotencyKey }`; response `{ requested, touched, items, readModelSynced }`.
- Produces: `EraWorklistDisposition` value `legacy`, valid only for `era-unmatched`, projected from resolved Task output.

- [ ] **Step 1: Write the failing 15-claim atomic batch test**

```ts
test("one batch resolution stamps all 15 claims through one FHIR transaction", async () => {
  const staff = fixtureBatchStaff(15);
  const response = await batchRequest(staff, {
    claimReferences: Array.from({ length: 15 }, (_, index) => `Claim/claim-${index + 1}`),
    action: "resolution",
    detail: "Added the missing procedure code and resubmitted",
    reasonCode: "missing-procedure-code",
    idempotencyKey: "batch-missing-procedure-001",
  });
  const unstamped = staff.claims().filter((claim) => claimTouchState(claim).touchCount !== 1).map((claim) => claim.id);
  assert.deepEqual(unstamped, [], `Unstamped claims: ${unstamped.join(", ")}`);
  assert.equal(staff.transactionWrites(), 1);
  assert.equal(staff.provenanceWrites(), 15);
  assert.deepEqual(await response.json(), assertBatchResponse(15));
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cd mcp && node --import tsx --test tests/claimFollowUpRoutes.test.ts`

Expected: FAIL because `/claims/touches/batch` and the batch fixture do not exist.

- [ ] **Step 3: Extract the existing single-touch preparation into a shared route helper**

```ts
interface PreparedClaimTouch {
  claimReference: string;
  committedClaim: Claim;
  entries: NonNullable<Bundle["entry"]>;
  idempotentReplay: boolean;
}

async function prepareClaimTouch(
  staff: ClaimFollowUpStaff,
  deps: ClaimFollowUpRouteDeps,
  input: ParsedClaimTouch,
): Promise<PreparedClaimTouch>;
```

The helper must call the existing `buildClaimTouchTransaction`; it must not duplicate extension or Provenance construction.

- [ ] **Step 4: Implement the atomic batch route**

Validate 1–100 unique `Claim/<id>` references and all request content before writing. Read and prepare every claim first, concatenate all non-replay Claim/Provenance entries into one `Bundle.type = "transaction"`, call `executeTransaction` once, then refresh each read-model row. If any refresh fails, invalidate projection health and return `readModelSynced: false`; never present the Work projection as healthy afterward.

- [ ] **Step 5: Add retry and rollback tests**

For `batch validation failure writes none of 15 claims`, send fourteen valid references plus `not-a-claim`, then assert HTTP 400, `transactionWrites() === 0`, and every fixture Claim still has `touchCount === 0`.

For `lost batch response replays the idempotency key without duplicate touches`, submit the same 15-reference request twice with one idempotency key, then assert every Claim has `touchCount === 1`, exactly 15 Provenance resources were written, and the second response marks every item as an idempotent replay.

- [ ] **Step 6: Add and test the `legacy` ERA disposition**

```ts
assert.equal(resolveEraWorklistTask(unmatched, { disposition: "legacy" }, AT).status, "completed");
assert.throws(
  () => resolveEraWorklistTask(denial, { disposition: "legacy" }, AT),
  /legacy is only valid for an era-unmatched Task/,
);
```

Expose the stored disposition on `EraWorklistAttentionItem` so a resolved legacy remit can remain visible in Work without becoming a Claim.

- [ ] **Step 7: Run focused MCP tests and commit**

Run: `cd mcp && node --import tsx --test tests/claimFollowUpRoutes.test.ts tests/claimHandlers.test.ts`

Expected: PASS with zero failures.

Commit: `git commit -m "Add atomic claims batch touch"`

---

### Task 2: Work projection client and lane classifier

**Files:**
- Create: `ui/src/lib/claim-work.ts`
- Modify: `ui/src/lib/claims-worklist.ts`
- Create: `ui/tests/claimWork.test.tsx`

**Interfaces:**
- Consumes: `ClaimWorklistGroup` response fields from `/claims/follow-up-worklist` and `ClaimsWorklistItem[]` from `/claims/worklist`.
- Produces: `WorkProjection = WorkDegradedProjection | WorkHealthyProjection`.
- Produces: `buildWorkLanes(groups, eraItems): WorkLane[]` and `batchTouchClaims(input, options)`.

- [ ] **Step 1: Write failing projection tests for all seven lanes**

```ts
test("reason groups stay batched while absolute aging and untouched remain independent lanes", () => {
  const lanes = buildWorkLanes([missingProcedureGroup(15), cobGroup(25)], []);
  assert.equal(lane(lanes, "holds").groups[0].count, 15);
  assert.equal(lane(lanes, "aging").groups.some((group) => group.count === 15), true);
  assert.equal(lane(lanes, "untouched").groups.some((group) => group.count === 15), true);
});
```

- [ ] **Step 2: Write failing twin-column and legacy-separation tests**

```ts
assert.deepEqual(rowFacts(agingTouched), { daysSinceBilled: 62, daysSinceTouched: 2 });
assert.deepEqual(rowFacts(agingUntouched), { daysSinceBilled: 62, daysSinceTouched: null });
assert.equal(lane(lanes, "unmatched").groups[0].kind, "legacy-remit");
assert.equal(lane(lanes, "unmatched").groups[0].claimWatchEligible, false);
assert.equal(lanes.flatMap((value) => value.groups).some((group) => group.kind === "claim" && group.claimReferences.includes("Claim/legacy")), false);
```

- [ ] **Step 3: Write the failing 503 health-gate client test**

```ts
const projection = await loadClaimWork({ request: staleResponseWithGroups });
assert.deepEqual(projection, {
  status: "degraded",
  reason: "stale",
  lastSuccessfulAt: "2026-08-30T11:30:00.000Z",
});
```

The stale fixture deliberately includes groups in the body; the client must discard them.

- [ ] **Step 4: Implement typed response parsing and lane classification**

Lane rules:
- `aging`: every open claim whose server-projected aging bucket is not `current`.
- `holds`: reason-coded open claims not already in denial, underpaid, or rejected status.
- `denials`: claim status `denied` plus live `era-denial` Tasks.
- `underpaid`: claim status `underpaid` plus live `era-underpayment` Tasks.
- `unmatched`: live `era-unmatched`, `era-line-linkage`, and `claim-rejected` Tasks; resolved `legacy` remits form a separate labelled group.
- `untouched`: every open claim with `touchCount === 0`, independent of aging.
- `hygiene`: live `era-integrity` Tasks; no unmapped-plan UI is fabricated in this slice.

Within each lane, claim rows regroup by typed reason and sort by max untouched-ranking days, then oldest billed day, then display. Legacy Tasks never enter claim groups.

- [ ] **Step 5: Implement the batch client with response completeness validation**

```ts
if (body.requested !== input.claimReferences.length || body.touched !== input.claimReferences.length) {
  throw new Error(`Batch touch incomplete: ${body.touched} of ${input.claimReferences.length} claims were stamped.`);
}
```

- [ ] **Step 6: Run UI projection tests and commit**

Run: `cd ui && node --import tsx --test tests/claimWork.test.tsx tests/claimsWorklist.test.tsx`

Expected: PASS with zero failures.

Commit: `git commit -m "Project claims into Work lanes"`

---

### Task 3: Authoritative Work surface and ERA absorption

**Files:**
- Create: `ui/src/scenes/claims/BillingWork.tsx`
- Modify: `ui/src/scenes/claims/ClaimsWorklist.tsx`
- Modify: `ui/src/scenes/claims/RemittanceQueue.tsx`
- Modify: `ui/src/App.tsx`
- Modify: `ui/src/components/AppShell.tsx`
- Create: `ui/tests/billingWork.test.tsx`
- Modify: `ui/tests/claimsWorklist.test.tsx`
- Modify: `ui/tests/remittanceQueue.test.tsx`
- Modify: `ui/tests/appRoutes.test.tsx`

**Interfaces:**
- Consumes: `WorkProjection`, `WorkLane`, `WorkGroup`, and `batchTouchClaims` from `claim-work.ts`.
- Reuses: the renamed `EraWorklistBoard` and `ClaimsWorklistPanel` from `ClaimsWorklist.tsx`.
- Produces: `BillingWork` at `/billing/claims/worklist`.

- [ ] **Step 1: Write the failing collapsed-group render test**

```tsx
const html = renderToStaticMarkup(<BillingWork initialProjection={healthyWorkFixture()} />);
assert.equal(html.match(/Missing procedure code for item OTH/g)?.length, 1);
assert.match(html, /15 claims/);
assert.match(html, /\$4,210/);
assert.match(html, /oldest 62d/);
assert.match(html, /Fix codes/);
```

- [ ] **Step 2: Write failing lane-count, zero-state, and degraded-state tests**

Assert every lane and count is present, zero lanes state that they are being watched, and degraded output contains no lane counts, group titles, or reassuring empty state.

- [ ] **Step 3: Implement the Work frame**

Render a two-column desktop layout: persistent lane rail and main reason accordion. Use existing theme tokens (`--odos-page-ground`, `--odos-surface`, `--odos-line`, `--odos-text`, `--odos-muted`, `--odos-faint`) and reserve red/amber for attention only.

- [ ] **Step 4: Implement expanded claim rows**

```tsx
<th>Days billed</th>
<th>Days touched</th>
<th>Last worked by</th>
<th>Money state</th>
```

Render `Never` for a null touched day; never copy billed age into the touched column. Money-state chips are limited to states the current read model can source: `charged` before payer adjudication and `adjudicated` for payer-response states. Do not invent `contracted_allowable` or `collected`.

- [ ] **Step 5: Absorb the older worklist without breaking remittance drill-in**

Rename the old six-lane board export to `EraWorklistBoard`; remove `ClaimsWorklist` as a routed scene; preserve its ERA panel and Stedi resolution controls. Point App routing and navigation copy to `BillingWork` / `Work`, while Remittance Queue continues to reuse `EraWorklistBoard` for a selected ERA.

- [ ] **Step 6: Render legacy remits as a separate Unmatched subgroup**

Label the group `Legacy — belongs to the prior system`, retain payer/ERA evidence, and expose only the existing ERA review flow plus the new `legacy` disposition. State in the UI that it stays outside ODOS claim work and claim-watch alerts. Do not offer reconstruction.

- [ ] **Step 7: Run focused UI tests and commit**

Run: `cd ui && node --import tsx --test tests/billingWork.test.tsx tests/claimsWorklist.test.tsx tests/remittanceQueue.test.tsx tests/appRoutes.test.tsx`

Expected: PASS with zero failures.

Commit: `git commit -m "Make Work the biller home"`

---

### Task 4: Batch drawer and keyboard workflow

**Files:**
- Modify: `ui/src/scenes/claims/BillingWork.tsx`
- Modify: `ui/tests/billingWork.test.tsx`

**Interfaces:**
- Consumes: `batchTouchClaims` and existing ERA panel callbacks.
- Produces: one typed-resolution drawer per claim reason group, with complete batch verification before collapse.

- [ ] **Step 1: Write failing action-drawer tests**

Use `react-test-renderer` to select the 15-claim group, assert the drawer is prefilled from `reason.resolutionPath`, invoke one submit, and verify one client call contains all 15 references. After a complete response the group collapses and projection reloads; after an incomplete response it remains open and reports the missing count.

- [ ] **Step 2: Implement the right-side action drawer**

Use `action: "resolution"`, the group reason code, the editable typed detail, and a generated idempotency key stable for retries while the drawer remains open. Disable submission while busy.

- [ ] **Step 3: Write failing keyboard tests**

```ts
for (const key of ["ArrowDown", "j"]) assert.equal(nextGroupIndex(0, key, 3), 1);
for (const key of ["ArrowUp", "k"]) assert.equal(nextGroupIndex(1, key, 3), 0);
assert.equal(groupKeyAction(" "), "toggle");
assert.equal(groupKeyAction("Enter"), "open-action");
```

- [ ] **Step 4: Implement focus movement and visible guidance**

Arrow keys are primary; Space toggles disclosure; Enter opens the batch action; j/k are aliases. Render the hint in the lane header and keep every operation available through visible buttons.

- [ ] **Step 5: Run focused tests and commit**

Run: `cd ui && node --import tsx --test tests/billingWork.test.tsx tests/claimWork.test.tsx`

Expected: PASS with zero failures.

Commit: `git commit -m "Add Work batch and keyboard flow"`

---

### Task 5: Mandate 17 mutations, UI evidence, and final gates

**Files:**
- Modify only if a test defect is discovered in files already listed above.
- Create local, uncommitted screenshots under `.odos/evidence/work-surface-2b/`.

**Interfaces:**
- Produces: four recorded RED/GREEN demonstrations, three deterministic UI screenshots, and the final sealed-bundle evidence.

- [ ] **Step 1: Demonstrate batch completeness mutation**

Temporarily prepare only `claimReferences.slice(0, 1)`. Run the focused MCP test and capture the failure naming 14 unstamped claim IDs. Restore and capture the pass.

- [ ] **Step 2: Demonstrate twin-column mutation**

Temporarily render `daysSinceBilled` in both columns. Run the focused UI test and capture the touched-versus-untouched failure. Restore and capture the pass.

- [ ] **Step 3: Demonstrate health-gate mutation**

Temporarily treat a stale response as healthy. Run the focused UI test and capture stale groups/counts appearing. Restore and capture the pass.

- [ ] **Step 4: Demonstrate legacy-remit separation mutation**

Temporarily classify resolved `legacy` Tasks as live claim groups. Run the focused UI test and capture the failure showing legacy work mixed into live lanes or claim-watch eligibility. Restore and capture the pass.

- [ ] **Step 5: Capture deterministic UI evidence**

Render fixtures showing: (a) one collapsed 15-claim reason row with its batch verb, (b) expanded twin-day columns, and (c) the degraded state with all counts hidden. Save screenshots outside tracked source and inspect each image.

- [ ] **Step 6: Run all five verification gates**

```bash
cd mcp && npm run build
cd mcp && npm test
cd ui && npm run build
cd ui && npm test
npm run preflight
```

Record exact test totals, skips, build module count, and preflight findings.

- [ ] **Step 7: Run verification-before-completion, commit final repairs, and open the PR**

Push `drbang-iva/work-surface-2b`; open a non-draft PR against `main`. Wait for PR-Agent and Greptile at the exact final head, inspect and adjudicate every review thread, rerun affected checks after fixes, then re-poll both checks and unresolved-thread count. Do not merge.
