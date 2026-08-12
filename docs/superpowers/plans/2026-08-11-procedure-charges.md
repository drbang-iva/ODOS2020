# Encounter Procedure Charges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add independently managed manual procedure charges to an Encounter while making FHIR `ChargeItem.bodysite` the only source of professional-claim laterality.

**Architecture:** Keep the existing single visit proposal and protocol proposal machinery intact. Add one focused FHIR laterality helper, one focused manual-procedure endpoint, a read-only active-and-coded fee-option filter, and a sibling React list that writes manual `ChargeProposal` rows; all accepted rows still materialize through sign cleanup. The claim path consumes only stored FHIR bodysite and removes the synthetic laterality override seam.

**Tech Stack:** TypeScript, Node test runner, Zod, FHIR R4 via `@medplum/fhirtypes`, Express routing, React, Vite, react-test-renderer.

## Global Constraints

- Base is `main` at `137c742c`; work only on `drbang-iva/procedure-charges`.
- No CPT value or descriptor may enter source, tests, documentation examples, or runtime seeds.
- No code-binding ledger, diagnosis catalog, diagnosis ledger, `FAMILY_RESOLUTION_MODES`, or `mcp/src/__tests__/protocol-phase5.test.ts` change.
- No coverage, frequency, duplicate-billing, recommendation, auto-charge, superbill, checkout, or unrelated claim behavior.
- `saveProcedureFeeScheduleItem` remains unchanged; Amendment 2 is a read-side active-and-coded selector filter only.
- A concept is offered for new manual procedure charting only when it is active, has a nonblank `billingCode`, and is not one of the twelve visit concepts.
- Claim laterality comes only from `ChargeItem.bodysite`, never from a linked diagnosis or a synthetic request-only property.
- Unset procedure laterality and empty diagnosis pointer are valid and never block add or sign.
- One manual procedure has zero or one diagnosis pointer selected from that Encounter's diagnoses; no scoring or recommendation.
- Visit and protocol proposal identities are immutable through the procedure routes; procedure identities are immutable through the visit route.
- Preserve zero dismissal cost: no automatic row, modal, toast, required selection, focus steal, or sign gate.
- Production code changes require a focused failing test first, an observed expected failure, minimal implementation, and a focused green rerun.
- Codex authors but does not evaluate; exact-head Fable/Opus evaluation is required before merge.

---

## File Map

### Create

- `mcp/src/fhir/charge-item-laterality.ts` — build and parse the ODOS FHIR `ChargeItem.bodysite` representation.
- `mcp/src/clinical-graph/manual-procedure-charge-endpoint.ts` — active coded option read, Encounter diagnosis read, manual proposal create, patch, remove, and revive.
- `mcp/src/__tests__/procedure-charge-laterality.test.ts` — independently reviewable proposal → ChargeItem → Claim laterality tests and mutation target.
- `mcp/src/__tests__/procedure-charges.test.ts` — endpoint authorization, active-coded filtering, identity isolation, lifecycle, and behavioral acceptance fixture.
- `ui/src/components/charting/ProcedureChargeList.tsx` — passive add row and editable active procedure rows.
- `ui/tests/procedureCharges.test.tsx` — rendered component behavior and zero-dismissal-cost evidence.

### Modify

- `mcp/src/clinical-graph/protocol-types.ts` — make `ChargeProposal.laterality` optional.
- `mcp/src/clinical-graph/procedure-fee-schedule.ts` — export the active-coded non-visit read helper and project proposal laterality to ChargeItem bodysite.
- `mcp/src/claims/claim-draft.ts` — remove diagnosis-derived laterality and repurpose the conflict warning to conflicting ChargeItem bodysite.
- `mcp/src/claims/claimmd-fhir.ts` — remove synthetic `laterality` from the input intersection and build Claim bodySite from ChargeItem bodysite.
- `mcp/src/claims/claimmd-handlers.ts` — remove request-only laterality override and preserve stored bodysite for persisted ChargeItems.
- `mcp/tests/claimDraft.test.ts` — correct the two dx-derived expectations and add explicit ChargeItem bodysite cases.
- `mcp/tests/claimmdFhir.test.ts` — convert the existing transport assertion to FHIR bodysite.
- `mcp/tests/claimHandlers.test.ts` — convert persisted/idless transport tests and prove persisted stored bodysite cannot be overridden.
- `mcp/src/index.ts` — register GET/POST/PATCH procedure-charge routes with existing chart permissions.
- `ui/src/lib/clinical-graph-client.ts` — add typed procedure-charge read/create/patch client.
- `ui/src/lib/submit-claims.ts` — convert draft display laterality to/from FHIR bodysite instead of a synthetic server field.
- `ui/src/components/charting/EncounterHeader.tsx` — render the new list beside the unchanged visit selector.
- `ui/tests/submitClaims.test.tsx` — convert the existing transport assertion to FHIR bodysite.

---

### Task 1: FHIR Laterality Helper and Proposal Projection

**Files:**
- Create: `mcp/src/fhir/charge-item-laterality.ts`
- Create: `mcp/src/__tests__/procedure-charge-laterality.test.ts`
- Modify: `mcp/src/clinical-graph/protocol-types.ts`
- Modify: `mcp/src/clinical-graph/procedure-fee-schedule.ts`

**Interfaces:**
- Produces: `ChargeLaterality`, `ODOS_CHARGE_LATERALITY_SYSTEM`, `chargeItemBodysite(laterality)`, and `chargeItemLaterality(chargeItem)`.
- Produces: optional `ChargeProposal.laterality?: ChargeLaterality`.
- Consumes: existing `materializeAcceptedChargeProposals` and its sole `buildChargeItem` projection.

- [ ] **Step 1: Write focused failing projection tests**

Create `procedure-charge-laterality.test.ts` with a minimal in-memory Encounter/ChargeItemDefinition client and real `materializeAcceptedChargeProposals` invocation. Cover all three existing laterality values in one table while keeping assertions independent:

```ts
function rowStore<T extends { id: string }>(seed: T[]) {
  const rows = new Map(seed.map((row) => [row.id, structuredClone(row)]));
  return {
    async list(): Promise<T[]> { return [...rows.values()].map((row) => structuredClone(row)); },
    async save(value: T): Promise<T> {
      rows.set(value.id, structuredClone(value));
      return structuredClone(value);
    },
    async get(id: string): Promise<T | undefined> {
      const value = rows.get(id);
      return value ? structuredClone(value) : undefined;
    },
  };
}

function acceptedManualProposal(overrides: Partial<ChargeProposal> = {}): ChargeProposal {
  return {
    id: "proposal-1",
    encounterId: "enc-1",
    planActionRef: "manual-procedure-charge:proposal-1",
    procedureConceptKey: "gonioscopy",
    units: 1,
    laterality: "OU",
    dxPointers: ["Condition/dx-1"],
    evidenceRefs: [],
    coverageEvaluations: [],
    state: "accepted",
    provenance: {
      source: "clinician-entered",
      actor: "Practitioner/clinician",
      at: "2026-08-11T20:00:00.000Z",
    },
    ...overrides,
  };
}

function lateralityFixture(proposal: ChargeProposal) {
  const charges = rowStore([proposal]);
  const applications = rowStore<ProtocolApplication>([]);
  const createdChargeItems: ChargeItem[] = [];
  const definition = {
    ...buildProcedureFeeDefinition({
      procedureConceptKey: proposal.procedureConceptKey,
      display: "Synthetic procedure",
      billingCode: "SYNTHA",
      active: true,
    }),
    id: "definition-1",
  };
  const chargeFhir = {
    async read() {
      return {
        resourceType: "Encounter",
        id: "enc-1",
        status: "in-progress",
        class: {},
        subject: { reference: "Patient/patient-1" },
      } satisfies Encounter;
    },
    async create(resource: ChargeItem) {
      const saved = { ...structuredClone(resource), id: `charge-${createdChargeItems.length + 1}` };
      createdChargeItems.push(saved);
      return structuredClone(saved);
    },
  };
  const feeScheduleFhir = {
    async search<T extends Resource>(): Promise<Bundle<T>> {
      return { resourceType: "Bundle", type: "searchset", entry: [{ resource: definition as T }] };
    },
    async searchUrl<T extends Resource>(): Promise<Bundle<T>> {
      return { resourceType: "Bundle", type: "searchset", entry: [] };
    },
    async read<T extends Resource>(): Promise<T> { throw new Error("not used"); },
    async create<T extends Resource>(): Promise<T> { throw new Error("not used"); },
    async update<T extends Resource>(): Promise<T> { throw new Error("not used"); },
  };
  return {
    createdChargeItems,
    charges,
    input: {
      fhir: chargeFhir,
      feeScheduleFhir,
      encounterId: "enc-1",
      actorReference: "Practitioner/clinician",
      charges,
      applications,
      now: () => "2026-08-11T20:00:00.000Z",
    },
  };
}

for (const [laterality, expected] of [
  ["OD", "OD"],
  ["OS", "OS"],
  ["OU", "OU"],
] as const) {
  test(`materializes ${laterality} proposal laterality into ChargeItem bodysite`, async () => {
    const proposal = acceptedManualProposal({
      id: `proposal-${laterality}`,
      laterality,
    });
    const fixture = lateralityFixture(proposal);
    await materializeAcceptedChargeProposals(fixture.input);
    const created = fixture.createdChargeItems[0];
    assert.equal(created?.bodysite?.[0]?.coding?.[0]?.system, expected ? ODOS_CHARGE_LATERALITY_SYSTEM : undefined);
    assert.equal(created?.bodysite?.[0]?.coding?.[0]?.code, expected);
    assert.equal(created?.bodysite?.[0]?.text, expected);
    assert.equal((await fixture.charges.get(proposal.id))?.state, "finalized");
  });
}
```

Add a protocol-linked accepted proposal with an active confirmed `ProtocolApplication`; assert the proposal remains protocol-linked and the resulting ChargeItem carries its existing laterality.

- [ ] **Step 2: Run the focused test and record the expected red state**

Run:

```bash
cd mcp
node --import tsx --test --test-concurrency=1 src/__tests__/procedure-charge-laterality.test.ts
```

Expected: OD/OS/OU assertions fail because `ChargeItem.bodysite` is absent.

- [ ] **Step 3: Add the focused FHIR helper**

Create `mcp/src/fhir/charge-item-laterality.ts` with this public contract:

```ts
import type { ChargeItem, CodeableConcept } from "@medplum/fhirtypes";

export type ChargeLaterality = "OD" | "OS" | "OU";
export const ODOS_CHARGE_LATERALITY_SYSTEM =
  "https://odos2020.com/fhir/CodeSystem/laterality";

export interface ChargeItemLateralityResult {
  laterality?: ChargeLaterality;
  conflict: boolean;
}

export function chargeItemBodysite(laterality: ChargeLaterality): CodeableConcept[] {
  return [{
    coding: [{ system: ODOS_CHARGE_LATERALITY_SYSTEM, code: laterality }],
    text: laterality,
  }];
}

export function chargeItemLaterality(
  chargeItem: Pick<ChargeItem, "bodysite">,
): ChargeItemLateralityResult {
  const values = new Set<ChargeLaterality>();
  for (const site of chargeItem.bodysite ?? []) {
    for (const coding of site.coding ?? []) {
      if (coding.system === ODOS_CHARGE_LATERALITY_SYSTEM && isChargeLaterality(coding.code)) {
        values.add(coding.code);
      }
    }
    const text = site.text?.trim().toUpperCase();
    if (isChargeLaterality(text)) values.add(text);
  }
  return values.size === 1
    ? { laterality: [...values][0], conflict: false }
    : { conflict: values.size > 1 };
}

function isChargeLaterality(value: string | undefined): value is ChargeLaterality {
  return value === "OD" || value === "OS" || value === "OU";
}
```

- [ ] **Step 4: Project existing proposal laterality once**

In `buildChargeItem`, add only this projection:

```ts
...(input.proposal.laterality
  ? { bodysite: chargeItemBodysite(input.proposal.laterality) }
  : {}),
```

Do not add diagnosis access, defaults, extensions, or a second ChargeItem builder.

- [ ] **Step 5: Run the three projection cases green**

Run:

```bash
cd mcp
node --import tsx --test --test-concurrency=1 src/__tests__/procedure-charge-laterality.test.ts
```

Expected: OD, OS, and OU each pass with one matching bodysite.

- [ ] **Step 6: Add the unset type-contract and runtime test**

Add a fourth test whose proposal genuinely omits the property:

```ts
test("materializes an unset proposal without ChargeItem bodysite", async () => {
  const { laterality: _laterality, ...withoutLaterality } = acceptedManualProposal({
    id: "proposal-unset",
  });
  const proposal: ChargeProposal = withoutLaterality;
  const fixture = lateralityFixture(proposal);
  await materializeAcceptedChargeProposals(fixture.input);
  assert.equal(fixture.createdChargeItems[0]?.bodysite, undefined);
});
```

Run `npm run build` in `mcp`. Expected red: TypeScript reports that `laterality` is required on `ChargeProposal`.

- [ ] **Step 7: Make proposal laterality optional and run all materialization tests green**

In `protocol-types.ts`, replace the required union with:

```ts
laterality?: ChargeLaterality;
```

Import the type from the new FHIR helper. The projection already added in Step 4 needs no further change. Add the protocol-linked accepted-proposal case now; it compiles with its existing laterality and must preserve its application identity.

Run:

```bash
cd mcp
node --import tsx --test --test-concurrency=1 src/__tests__/procedure-charge-laterality.test.ts tests/procedureChargeMaterialization.test.ts src/__tests__/visit-billing-codes.test.ts
```

Expected: all focused cases pass; existing visit and protocol materialization behavior remains green.

- [ ] **Step 8: Commit the projection checkpoint**

```bash
git add mcp/src/fhir/charge-item-laterality.ts mcp/src/clinical-graph/protocol-types.ts mcp/src/clinical-graph/procedure-fee-schedule.ts mcp/src/__tests__/procedure-charge-laterality.test.ts
git commit -m "fix: project charge laterality to FHIR"
```

---

### Task 2: Bodysite-Only Professional Claim Path

**Files:**
- Modify: `mcp/src/__tests__/procedure-charge-laterality.test.ts`
- Modify: `mcp/src/claims/claim-draft.ts`
- Modify: `mcp/src/claims/claimmd-fhir.ts`
- Modify: `mcp/src/claims/claimmd-handlers.ts`
- Modify: `mcp/tests/claimDraft.test.ts`
- Modify: `mcp/tests/claimmdFhir.test.ts`
- Modify: `mcp/tests/claimHandlers.test.ts`
- Modify: `ui/src/lib/submit-claims.ts`
- Modify: `ui/tests/submitClaims.test.tsx`

**Interfaces:**
- Consumes: `chargeItemBodysite` and `chargeItemLaterality` from Task 1.
- Produces: `ProfessionalClaimChargeItemInput = ChargeItem & { diagnosisSequence?: number[] }` with no synthetic laterality.
- Preserves: the UI `ChargeLine.laterality?: string` only as a display/edit-draft field translated to FHIR bodysite.

- [ ] **Step 1: Add focused failing claim-source tests**

Extend the focused laterality test file with real claim assertions:

```ts
function signedClaimFixture(input: {
  diagnosisBodySite: "OD" | "OS" | "OU";
  chargeBodySite?: ChargeItem["bodysite"];
}) {
  const encounter: Encounter = {
    resourceType: "Encounter",
    id: "enc-claim",
    status: "finished",
    class: {},
    subject: { reference: "Patient/patient-1" },
    period: { start: "2026-08-11T20:00:00.000Z" },
    diagnosis: [{ condition: { reference: "Condition/dx-1" }, rank: 1 }],
  };
  const condition: Condition = {
    resourceType: "Condition",
    id: "dx-1",
    subject: { reference: "Patient/patient-1" },
    encounter: { reference: "Encounter/enc-claim" },
    verificationStatus: { coding: [{ code: "confirmed" }] },
    category: [{ coding: [{ code: "encounter-diagnosis" }] }],
    code: { coding: [{ system: "https://example.test/diagnosis", code: "DX-A" }] },
    bodySite: [{ text: input.diagnosisBodySite }],
  };
  const charge: ChargeItem = {
    resourceType: "ChargeItem",
    id: "charge-1",
    status: "billable",
    code: { coding: [{ system: "https://example.test/procedure", code: "PROC-A" }] },
    subject: { reference: "Patient/patient-1" },
    context: { reference: "Encounter/enc-claim" },
    supportingInformation: [{ reference: "Condition/dx-1" }],
    priceOverride: { value: 10, currency: "USD" },
    ...(input.chargeBodySite ? { bodysite: input.chargeBodySite } : {}),
  };
  const coverage: Coverage = {
    resourceType: "Coverage",
    id: "coverage-1",
    status: "active",
    beneficiary: { reference: "Patient/patient-1" },
    order: 1,
    payor: [{ reference: "Organization/payer", identifier: { value: "SYNTHETIC" } }],
  };
  const resources = new Map<string, Resource>([
    ["Encounter/enc-claim", encounter],
    ["Condition/dx-1", condition],
  ]);
  const fhir = {
    async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
      const resource = resources.get(`${resourceType}/${id}`);
      if (!resource) throw new Error(`${resourceType}/${id} not found`);
      return structuredClone(resource) as T;
    },
    async search<T extends Resource>(resourceType: T["resourceType"]): Promise<Bundle<T>> {
      const rows = resourceType === "ChargeItem" ? [charge] : resourceType === "Coverage" ? [coverage] : [];
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: rows.map((resource) => ({ resource: resource as T })),
      };
    },
  };
  return {
    fhir,
    encounter,
    charge,
    professionalInput(draft: EncounterClaimDraft): ProfessionalClaimInput {
      return {
        created: "2026-08-11",
        serviceDate: draft.serviceDate,
        patientReference: draft.patientReference,
        providerReference: "Practitioner/clinician",
        insurerReference: "Organization/payer",
        coverageReference: "Coverage/coverage-1",
        patientAccountNumber: "SYNTHETIC",
        payerId: "SYNTHETIC",
        billingProvider: { name: "Synthetic practice", npi: "1111111112" },
        renderingProvider: { name: "Synthetic clinician", npi: "1111111112" },
        subscriber: { firstName: "Test", lastName: "Patient", dateOfBirth: "1980-01-01", sex: "U" },
        patient: { firstName: "Test", lastName: "Patient", dateOfBirth: "1980-01-01", sex: "U" },
        diagnoses: draft.diagnoses.map((row) => ({ system: row.system, code: row.code })),
        chargeItems: [{ ...charge, diagnosisSequence: draft.charges[0]!.diagnosisSequence }],
      };
    },
  };
}

test("uses performed OD bodysite when the linked diagnosis is bilateral", async () => {
  const fixture = signedClaimFixture({
    diagnosisBodySite: "OU",
    chargeBodySite: chargeItemBodysite("OD"),
  });
  const draft = await buildClaimDraft(fixture.fhir, fixture.encounter.id!);
  assert.equal(draft.charges[0]?.laterality, "OD");
  const claim = buildProfessionalClaim(fixture.professionalInput(draft));
  assert.equal(claim.item?.[0]?.bodySite?.text, "OD");
});

test("does not inherit diagnosis laterality when ChargeItem bodysite is absent", async () => {
  const fixture = signedClaimFixture({ diagnosisBodySite: "OS" });
  const draft = await buildClaimDraft(fixture.fhir, fixture.encounter.id!);
  assert.equal(draft.charges[0]?.laterality, undefined);
  assert.equal(draft.warnings, undefined);
});

test("warns only when ChargeItem bodysite contains conflicting laterality values", async () => {
  const fixture = signedClaimFixture({
    diagnosisBodySite: "OU",
    chargeBodySite: [...chargeItemBodysite("OD"), ...chargeItemBodysite("OS")],
  });
  const draft = await buildClaimDraft(fixture.fhir, fixture.encounter.id!);
  assert.equal(draft.charges[0]?.laterality, undefined);
  assert.deepEqual(draft.warnings, [
    `ChargeItem/${fixture.charge.id} omitted laterality because bodysite contains conflicting laterality values.`,
  ]);
});
```

- [ ] **Step 2: Run the focused tests and verify the diagnosis-derived failure**

Run:

```bash
cd mcp
node --import tsx --test --test-concurrency=1 src/__tests__/procedure-charge-laterality.test.ts
```

Expected: OD-vs-OU returns OU or no value through the current synthetic path; the absent-bodysite case incorrectly inherits OS; the new ChargeItem conflict warning is absent.

- [ ] **Step 3: Replace diagnosis-derived logic in claim draft**

In `claim-draft.ts`, delete the `linkedConditions` laterality collection from `Condition.bodySite`. Keep `linkedConditions` only for `diagnosisSequence`. Resolve the FHIR charge value once:

```ts
const chargeLaterality = chargeItemLaterality(chargeItem);
if (chargeLaterality.conflict) {
  warnings.push(
    `ChargeItem/${chargeItem.id} omitted laterality because bodysite contains conflicting laterality values.`,
  );
}
```

Return `laterality` only when `chargeLaterality.laterality` is present. Remove the old warning text about linked confirmed diagnosis body sites.

- [ ] **Step 4: Remove the synthetic server input seam**

In `claimmd-fhir.ts`, define:

```ts
export type ProfessionalClaimChargeItemInput = ChargeItem & {
  diagnosisSequence?: number[];
};
```

Inside `buildProfessionalClaim`, resolve `const { laterality } = chargeItemLaterality(chargeItem)` and emit Claim `bodySite` from that value. Do not read a non-FHIR property.

In `claimmd-handlers.ts`:

- for persisted ids, merge only the request's validated `diagnosisSequence` into the stored ChargeItem;
- for idless inputs, destructure only `diagnosisSequence`, leaving `bodysite` on the FHIR candidate;
- remove every local `laterality` carry variable and spread.

This makes the stored ChargeItem authoritative when an id is present.

- [ ] **Step 5: Translate the UI draft through FHIR bodysite**

In `ui/src/lib/submit-claims.ts`, remove synthetic laterality from `ProfessionalClaimChargeItemInput`. Add local helpers using the same exact representation:

```ts
const ODOS_CHARGE_LATERALITY_SYSTEM =
  "https://odos2020.com/fhir/CodeSystem/laterality";

function chargeLineBodysite(value: string | undefined): ChargeItem["bodysite"] {
  return value === "OD" || value === "OS" || value === "OU"
    ? [{ coding: [{ system: ODOS_CHARGE_LATERALITY_SYSTEM, code: value }], text: value }]
    : undefined;
}

function chargeLineLaterality(chargeItem: ChargeItem): string | undefined {
  const coded = chargeItem.bodysite
    ?.flatMap((site) => site.coding ?? [])
    .find((coding) => coding.system === ODOS_CHARGE_LATERALITY_SYSTEM)?.code;
  const value = coded ?? chargeItem.bodysite
    ?.map((site) => site.text?.trim().toUpperCase())
    .find((candidate) => candidate === "OD" || candidate === "OS" || candidate === "OU");
  return value === "OD" || value === "OS" || value === "OU" ? value : undefined;
}
```

`buildProfessionalClaimInput` writes `bodysite`; `claimDraftFromProfessionalClaimInput` reads it back into the flat UI `ChargeLine.laterality` display field.

- [ ] **Step 6: Correct the six named existing tests**

Change the two dx-derived expectations in `claimDraft.test.ts`:

- `buildClaimDraft reads ranked confirmed diagnoses and real per-charge pointers from a signed encounter` expects no laterality and no diagnosis-conflict warning when both ChargeItems lack bodysite.
- `claim draft expands one bilateral eyelid Condition into two sequenced diagnoses and binds its charge to both` expects no laterality when the ChargeItem lacks bodysite.

Convert these four transport tests from `.laterality = "OS"` to `bodysite: chargeItemBodysite("OS")` or the identical inline FHIR structure:

- `buildProfessionalClaim and Claim.MD preserve real per-line diagnosis pointers`
- `submit reuses a stored ChargeItem without dropping its draft diagnosis pointers`
- `submit persists idless ChargeItems once while keeping the Claim.MD payload on the original input shape`
- `encounter-prefilled lines preserve persisted ids, coding systems, diagnosis pointers, and laterality`

Add a handler assertion that a persisted ChargeItem with OD bodysite stays OD even if the request body includes a conflicting extra non-FHIR `laterality: "OS"` through an `unknown` cast.

- [ ] **Step 7: Run the independently reviewable claim group green**

Run:

```bash
cd mcp
node --import tsx --test --test-concurrency=1 src/__tests__/procedure-charge-laterality.test.ts tests/claimDraft.test.ts tests/claimmdFhir.test.ts tests/claimHandlers.test.ts
cd ../ui
node --import tsx --test tests/submitClaims.test.tsx
```

Expected: all claim-path tests pass; no test derives laterality from Condition bodySite; no persisted request override remains.

- [ ] **Step 8: Commit the claim-path checkpoint**

```bash
git add mcp/src/claims/claim-draft.ts mcp/src/claims/claimmd-fhir.ts mcp/src/claims/claimmd-handlers.ts mcp/src/__tests__/procedure-charge-laterality.test.ts mcp/tests/claimDraft.test.ts mcp/tests/claimmdFhir.test.ts mcp/tests/claimHandlers.test.ts ui/src/lib/submit-claims.ts ui/tests/submitClaims.test.tsx
git commit -m "fix: source claim laterality from ChargeItem"
```

---

### Task 3: Active-and-Coded Non-Visit Option Filter

**Files:**
- Modify: `mcp/src/clinical-graph/procedure-fee-schedule.ts`
- Create: `mcp/src/__tests__/procedure-charges.test.ts`

**Interfaces:**
- Produces: `listActiveCodedNonVisitProcedureFees(fhir): Promise<Array<ProcedureFeeScheduleItem & { billingCode: string }>>`.
- Consumes: persisted `ChargeItemDefinition` resources only; does not call `ensureProcedureFeeSchedule` and does not mutate fee settings.

- [ ] **Step 1: Write the Amendment 2 filter test first**

Build four synthetic definitions without real procedure codes:

```ts
const definitions = [
  buildProcedureFeeDefinition({ procedureConceptKey: "gonioscopy", display: "Gonioscopy", billingCode: "SYNTHA", active: true }),
  buildProcedureFeeDefinition({ procedureConceptKey: "corneal-pachymetry", display: "Corneal pachymetry", active: true }),
  buildProcedureFeeDefinition({ procedureConceptKey: "fundus-photography", display: "Fundus photography", billingCode: "SYNTHB", active: false }),
  buildProcedureFeeDefinition({ procedureConceptKey: "comprehensive-exam-new", display: "Visit", billingCode: "SYNTHC", active: true }),
];
```

Assert the result contains only `gonioscopy`, includes `billingCode: "SYNTHA"`, and makes no create/update call.

- [ ] **Step 2: Run the focused filter test red**

Run:

```bash
cd mcp
node --import tsx --test --test-concurrency=1 --test-name-pattern="active.*coded" src/__tests__/procedure-charges.test.ts
```

Expected: import/function-not-defined failure.

- [ ] **Step 3: Implement the read-only filter**

Export a narrowed option type and helper from `procedure-fee-schedule.ts`:

```ts
export type CodedProcedureFeeScheduleItem = ProcedureFeeScheduleItem & {
  billingCode: string;
};

export async function listActiveCodedNonVisitProcedureFees(
  fhir: Pick<ProcedureFeeScheduleFhir, "search" | "searchUrl">,
): Promise<CodedProcedureFeeScheduleItem[]> {
  return (await listProcedureFeeDefinitions(fhir))
    .map(procedureFeeScheduleItem)
    .filter((item): item is CodedProcedureFeeScheduleItem =>
      item.active &&
      typeof item.billingCode === "string" && item.billingCode.length > 0 &&
      !isVisitProcedureConceptKey(item.procedureConceptKey)
    )
    .sort((left, right) => left.display.localeCompare(right.display));
}
```

Do not call `listProcedureFeeSchedule`, which can seed definitions. Do not change `saveProcedureFeeScheduleItem`.

- [ ] **Step 4: Run the focused filter and existing fee tests green**

Run:

```bash
cd mcp
node --import tsx --test --test-concurrency=1 --test-name-pattern="active.*coded|fee schedule" src/__tests__/procedure-charges.test.ts src/__tests__/visit-billing-codes.test.ts tests/procedureChargeMaterialization.test.ts
```

Expected: active-coded non-visit filtering passes; fee schedule write behavior remains unchanged.

- [ ] **Step 5: Commit the filter checkpoint**

```bash
git add mcp/src/clinical-graph/procedure-fee-schedule.ts mcp/src/__tests__/procedure-charges.test.ts
git commit -m "feat: filter chartable procedure options"
```

---

### Task 4: Manual Procedure Charge Endpoint and Isolation

**Files:**
- Create: `mcp/src/clinical-graph/manual-procedure-charge-endpoint.ts`
- Modify: `mcp/src/__tests__/procedure-charges.test.ts`

**Interfaces:**
- Consumes: `ProtocolBasicStore<ChargeProposal>`, `PROTOCOL_BASIC_CODES.chargeProposal`, and `listActiveCodedNonVisitProcedureFees`.
- Produces: `handleProcedureChargesRequest`, `handleProcedureChargeCreateRequest`, and `handleProcedureChargePatchRequest`.
- Produces: `MANUAL_PROCEDURE_CHARGE_ID_PREFIX = "manual-procedure-charge:"`.

- [ ] **Step 1: Add authorization and response-shape tests**

Test all three handlers with null authentication and a role lacking `chart.read`/`chart.write`. Expect 401 for null, 403 for unauthorized, and no FHIR mutation. For an allowed read, assert this shape:

```ts
{
  options: [{ procedureConceptKey: "gonioscopy", display: "Gonioscopy", billingCode: "SYNTHA" }],
  diagnoses: [
    { reference: "Condition/principal", display: "Principal diagnosis", rank: 1 },
    { reference: "Condition/secondary", display: "Secondary diagnosis", rank: 2 },
  ],
  proposals: [],
}
```

- [ ] **Step 2: Add failing create and principal-default tests**

Inject `id: () => "synthetic-1"` and `now: () => "2026-08-11T20:00:00.000Z"`. Assert create returns:

```ts
{
  id: "manual-procedure-charge:synthetic-1",
  encounterId: "enc-1",
  planActionRef: "manual-procedure-charge:synthetic-1",
  procedureConceptKey: "gonioscopy",
  units: 1,
  dxPointers: ["Condition/principal"],
  evidenceRefs: [],
  coverageEvaluations: [],
  state: "accepted",
  provenance: {
    source: "clinician-entered",
    actor: "Practitioner/clinician",
    at: "2026-08-11T20:00:00.000Z",
  },
}
```

Assert `laterality` and `protocolApplicationId` are absent. A fixture with zero or two rank-1 diagnoses must default to `dxPointers: []`.

- [ ] **Step 3: Add failing active-coded creation boundary tests**

POST each of these and expect 400 with no saved proposal:

- active uncoded non-visit concept;
- inactive coded non-visit concept;
- active coded visit concept;
- unknown concept.

This uses the exact same option helper as GET; no duplicated eligibility predicate.

- [ ] **Step 4: Add failing patch, remove, and revive tests**

Exercise this exact sequence on one stable proposal:

```ts
const patch = (body: {
  laterality?: "OD" | "OS" | "OU" | null;
  dxPointer?: string | null;
  state?: "accepted" | "removed";
}) => handleProcedureChargePatchRequest(deps, {
  authHeader: "Bearer clinician",
  params: { encounterId: "enc-1", proposalId: "manual-procedure-charge:synthetic-1" },
  body,
});

await patch({ laterality: "OD", dxPointer: "Condition/secondary" });
await patch({ laterality: null, dxPointer: null });
await patch({ state: "removed" });
await patch({ state: "accepted" });
```

Assert each response preserves id, concept, units, evidence, coverage evaluations, and absent protocol application. Assert the final revive preserves the last stored laterality/pointer values rather than re-defaulting.

- [ ] **Step 5: Add failing isolation and conflict tests**

Seed the same Encounter with:

- stable visit proposal `manual-visit-code:enc-1`;
- one valid manual procedure proposal;
- one protocol proposal with `protocolApplicationId: "application-1"`;
- one procedure proposal for another Encounter;
- one finalized manual procedure proposal.

Deep-clone all rows before every rejected mutation. Assert PATCH rejects:

- visit id;
- protocol id;
- foreign-Encounter id;
- malformed manual id/planActionRef mismatch;
- finalized proposal;
- foreign diagnosis reference;
- empty patch.

After each response, assert every stored row is deep-equal to the snapshot.

- [ ] **Step 6: Implement the endpoint with exact schemas**

Use these Zod boundaries:

```ts
const encounterParamsSchema = z.object({ encounterId: z.string().min(1) }).strict();
const proposalParamsSchema = encounterParamsSchema.extend({ proposalId: z.string().min(1) }).strict();
const createSchema = z.object({ procedureConceptKey: z.string().min(1) }).strict();
const patchSchema = z.object({
  laterality: z.enum(["OD", "OS", "OU"]).nullable().optional(),
  dxPointer: z.string().regex(/^Condition\/[A-Za-z0-9.-]+$/).nullable().optional(),
  state: z.enum(["accepted", "removed"]).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "At least one procedure charge change is required.");
```

Define a narrow FHIR interface extending the Basic store, fee-definition search, Encounter read, and Condition read methods. Instantiate one `ProtocolBasicStore<ChargeProposal>` per request.

Use `assertBusinessActionAllowed` through a local `may()` helper for `chart.read` and `chart.write`, matching `protocol-endpoint.ts` behavior.

Use this identity predicate before any patch save:

```ts
function isManualProcedureProposal(proposal: ChargeProposal, encounterId: string): boolean {
  return proposal.id.startsWith(MANUAL_PROCEDURE_CHARGE_ID_PREFIX) &&
    proposal.encounterId === encounterId &&
    (proposal.protocolApplicationId === undefined || proposal.protocolApplicationId === null) &&
    proposal.planActionRef === proposal.id &&
    !isVisitProcedureConceptKey(proposal.procedureConceptKey);
}
```

For `laterality: null`, omit the property with destructuring rather than persisting `undefined`. For `dxPointer: null`, persist `dxPointers: []`. Validate nonnull pointers against the current Encounter diagnosis reference set.

- [ ] **Step 7: Run endpoint tests green**

Run:

```bash
cd mcp
node --import tsx --test --test-concurrency=1 src/__tests__/procedure-charges.test.ts src/__tests__/visit-billing-codes.test.ts src/__tests__/protocol-phase5.test.ts
```

Expected: procedure endpoint, unchanged visit behavior, and untouched Phase 5 suite all pass.

- [ ] **Step 8: Commit the endpoint checkpoint**

```bash
git add mcp/src/clinical-graph/manual-procedure-charge-endpoint.ts mcp/src/__tests__/procedure-charges.test.ts
git commit -m "feat: manage encounter procedure charges"
```

---

### Task 5: REST Registration, Typed Client, and Compact Encounter UI

**Files:**
- Modify: `mcp/src/index.ts`
- Modify: `ui/src/lib/clinical-graph-client.ts`
- Create: `ui/src/components/charting/ProcedureChargeList.tsx`
- Modify: `ui/src/components/charting/EncounterHeader.tsx`
- Create: `ui/tests/procedureCharges.test.tsx`

**Interfaces:**
- Consumes: the three endpoint handlers from Task 4.
- Produces: `ProcedureChargeApi` with `read`, `create`, and `patch` methods.
- Produces: `<ProcedureChargeList encounterId disabled api?>`.

- [ ] **Step 1: Write typed client request tests first**

In `procedureCharges.test.tsx`, use a fetch spy and the real `procedureChargeApi(fetchImpl)` to assert:

- GET uses `/clinical-graph/protocols/encounters/enc-1/procedure-charges`;
- POST sends `{ "procedureConceptKey": "gonioscopy" }`;
- PATCH percent-encodes `manual-procedure-charge:synthetic-1` and sends only the changed fields;
- all requests carry the existing authorization and JSON headers;
- non-2xx errors use `clinicalGraphResponseError`.

- [ ] **Step 2: Define the client types and implementation**

Add these shapes to `clinical-graph-client.ts`:

```ts
export interface ProcedureChargeOption {
  procedureConceptKey: string;
  display: string;
  billingCode: string;
}

export interface ProcedureChargeDiagnosis {
  reference: string;
  display: string;
  rank?: number;
}

export interface ManualProcedureCharge {
  id: string;
  procedureConceptKey: string;
  laterality?: "OD" | "OS" | "OU";
  dxPointers: string[];
  state: "accepted" | "removed" | "finalized";
}

export interface ProcedureChargesResponse {
  options: ProcedureChargeOption[];
  diagnoses: ProcedureChargeDiagnosis[];
  proposals: ManualProcedureCharge[];
}

export interface ProcedureChargeApi {
  read(encounterId: string): Promise<ProcedureChargesResponse>;
  create(encounterId: string, procedureConceptKey: string): Promise<{ proposal: ManualProcedureCharge }>;
  patch(
    encounterId: string,
    proposalId: string,
    change: { laterality?: "OD" | "OS" | "OU" | null; dxPointer?: string | null; state?: "accepted" | "removed" },
  ): Promise<{ proposal: ManualProcedureCharge }>;
}
```

Use the existing API base, auth headers, JSON parsing, and response-error helper.

- [ ] **Step 3: Register the Express routes**

Import the three handlers in `mcp/src/index.ts`. Register:

```ts
app.route("/clinical-graph/protocols/encounters/:encounterId/procedure-charges")
  .get(/* chart.read handler */)
  .post(/* chart.write handler */);

app.patch(
  "/clinical-graph/protocols/encounters/:encounterId/procedure-charges/:proposalId",
  /* chart.write handler */,
);
```

Pass `authenticateStaffRouteForAction("chart.read")` or `("chart.write")` exactly as the visit routes do. Use procedure-specific error messages and never log request bodies.

- [ ] **Step 4: Write the passive-render UI test red**

Render `ProcedureChargeList` with a stub API returning one coded option, three diagnoses, and no proposals. Assert:

- the procedure selector starts blank;
- no procedure row exists;
- there is no `Code unset` text;
- clicking nothing makes zero write calls;
- `Add procedure` is disabled until a concept is selected.

- [ ] **Step 5: Write add/edit/remove and inline-error UI tests red**

Use `act()` to select the coded option and add it. Return a proposal with no laterality and the principal pointer. Assert the row renders:

```text
Gonioscopy · SYNTHA · Laterality unset · Principal diagnosis · Remove
```

Then change laterality to OD, change the pointer to the third diagnosis, clear the pointer, and remove. Assert each action sends one narrow PATCH and no call touches the visit API. Reject one PATCH and assert the error appears inside `data-testid="procedure-charge-error"` while controls outside the failed row remain available.

- [ ] **Step 6: Implement `ProcedureChargeList` minimally**

The component owns `options`, `diagnoses`, `proposals`, `selectedConcept`, `loading`, `savingIds`, and one inline `error`. On read, retain removed rows in state but render only `state === "accepted"`.

The add selector includes only the server-returned options, so active-but-uncoded concepts cannot appear. Every rendered row obtains its option by `procedureConceptKey`; if an already-persisted proposal has no matching current option, show the proposal key and do not invent a billing code. This fallback is for existing state display only and does not add it to the selector.

Use explicit select options:

```tsx
<option value="">Laterality unset</option>
<option value="OD">OD</option>
<option value="OS">OS</option>
<option value="OU">OU</option>
```

and:

```tsx
<option value="">No diagnosis selected</option>
{diagnoses.map((diagnosis) => (
  <option key={diagnosis.reference} value={diagnosis.reference}>
    {diagnosis.display}
  </option>
))}
```

Do not add a modal, toast, confirmation step, recommendation, or sign integration.

- [ ] **Step 7: Mount the sibling list without changing the visit selector**

In `EncounterHeader.tsx`, leave the existing line byte-for-byte and add the sibling directly after it:

```tsx
<VisitCodeSelector encounterId={encounterId} disabled={migrated} />
<ProcedureChargeList encounterId={encounterId} disabled={migrated} />
```

- [ ] **Step 8: Run client/component and build checks green**

Run:

```bash
cd ui
node --import tsx --test tests/procedureCharges.test.tsx tests/visitBillingCodes.test.tsx tests/submitClaims.test.tsx
npm run build
cd ../mcp
npm run build
```

Expected: new list behavior passes; existing visit component passes untouched; both TypeScript builds succeed.

- [ ] **Step 9: Commit the UI checkpoint**

```bash
git add mcp/src/index.ts ui/src/lib/clinical-graph-client.ts ui/src/components/charting/ProcedureChargeList.tsx ui/src/components/charting/EncounterHeader.tsx ui/tests/procedureCharges.test.tsx
git commit -m "feat: show encounter procedure charges"
```

---

### Task 6: Behavioral Acceptance Fixture and Required Mutation Proofs

**Files:**
- Modify: `mcp/src/__tests__/procedure-charges.test.ts`
- Modify only if a genuine acceptance defect is exposed: production files from Tasks 1–5, with a new failing assertion before each correction.

**Interfaces:**
- Consumes: real visit handlers, real procedure handlers, real `ProtocolBasicStore`, real materializer, and real claim builder.
- Produces: one synthetic evidence test covering all eight runtime behaviors plus separate Phase 5/CPT gate commands.

- [ ] **Step 1: Add the four-charge acceptance fixture**

Seed one synthetic Encounter with three ranked local Conditions, one carrying OU bodySite. Seed active coded fee definitions using non-procedure synthetic strings. Seed one protocol proposal in `staged` state and snapshot it.

Through real handlers:

1. create one visit proposal;
2. create three manual procedure proposals;
3. set one procedure to OD and point it to the OU Condition;
4. point another procedure to exactly one of the other two diagnoses;
5. remove and revive the third procedure;
6. change the visit concept;
7. run sign cleanup.

Assert before sign there are exactly four accepted manual proposals: one visit and three procedures. Assert after sign there are exactly four new ChargeItems. Assert the protocol proposal is deep-equal to its snapshot throughout.

- [ ] **Step 2: Assert isolation after each mutation**

Capture byte-equivalent snapshots and assert:

- procedure removal changes only the targeted procedure;
- procedure revival changes only that procedure's state;
- visit change changes only the visit proposal;
- protocol proposal never changes;
- the selected one-of-three pointer produces one proposal with exactly one reference.

- [ ] **Step 3: Assert actual FHIR and Claim evidence**

For the OD procedure linked to the OU Condition, assert and retain the synthetic objects for PR evidence:

```ts
assert.equal(odCharge.bodysite?.[0]?.coding?.[0]?.code, "OD");
assert.deepEqual(odCharge.supportingInformation, [{ reference: "Condition/bilateral" }]);
assert.equal(claim.item?.find((item) =>
  item.extension?.some((extension) =>
    extension.valueReference?.reference === `ChargeItem/${odCharge.id}`
  )
)?.bodySite?.text, "OD");
```

Assert no accepted manual proposal or materialized manual ChargeItem uses an uncoded option.

- [ ] **Step 4: Run the acceptance test green**

Run:

```bash
cd mcp
node --import tsx --test --test-concurrency=1 --test-name-pattern="visit.*three procedure|four charge|behavioral acceptance" src/__tests__/procedure-charges.test.ts
```

Expected: one visit plus three procedures, four ChargeItems, OD claim laterality against OU diagnosis, one chosen pointer, and unchanged protocol state all pass.

- [ ] **Step 5: Perform mutation proof A — remove bodysite projection**

Temporarily remove only this production spread from `buildChargeItem`:

```ts
...(input.proposal.laterality
  ? { bodysite: chargeItemBodysite(input.proposal.laterality) }
  : {}),
```

Run:

```bash
cd mcp
node --import tsx --test --test-concurrency=1 --test-name-pattern="performed OD|materializes OD" src/__tests__/procedure-charge-laterality.test.ts
```

Expected red: actual Claim/ChargeItem laterality is absent where OD is required. Save the exact failing assertion and count for the PR body. Restore the spread with `apply_patch`, rerun the same command, and record green.

- [ ] **Step 6: Perform mutation proof B — weaken procedure identity**

Temporarily replace the full `isManualProcedureProposal` predicate with only the same-Encounter/manual-application checks, thereby allowing the visit proposal through the procedure PATCH path.

Run:

```bash
cd mcp
node --import tsx --test --test-concurrency=1 --test-name-pattern="visit proposal.*unchanged|rejects visit identity" src/__tests__/procedure-charges.test.ts
```

Expected red: the visit proposal is removed or the expected 409 becomes 200. Save the exact failing assertion and count for the PR body. Restore the complete predicate with `apply_patch`, rerun the same command, and record green.

- [ ] **Step 7: Run untouched protocol and CPT gates**

Run:

```bash
cd mcp
node --import tsx --test --test-concurrency=1 src/__tests__/protocol-phase5.test.ts tests/procedureChargeMaterialization.test.ts
cd ..
npm run guard:cpt
```

Expected: Phase 5 and existing protocol charge tests pass with no file change to `protocol-phase5.test.ts`; the CPT guard reports clean.

- [ ] **Step 8: Commit acceptance tests or TDD corrections**

```bash
git add mcp/src/__tests__/procedure-charges.test.ts
git commit -m "test: prove procedure charge isolation"
```

If production files changed because the acceptance test exposed a defect, include only those focused corrections in this commit after their own red/green cycle.

---

### Task 7: Full Verification, Evidence, Publication, and Handoff

**Files:**
- Inspect: every changed path.
- Do not create committed output logs or screenshots containing secrets, PHI, or local credentials.

**Interfaces:**
- Consumes: final branch head after Tasks 1–6.
- Produces: non-draft PR against `main`, exact-head bot status, and sealed bundle marked not independently evaluated.

- [ ] **Step 1: Audit scope and forbidden paths**

Run:

```bash
git status --short --branch
git diff 137c742c...HEAD --stat
git diff --check
git diff --name-only 137c742c...HEAD
git diff -- mcp/src/__tests__/protocol-phase5.test.ts data/code-bindings
```

Expected: no Phase 5 test diff, no code-binding diff, no unrelated files, and no whitespace error.

- [ ] **Step 2: Run every required full gate fresh**

Run exactly:

```bash
npm run preflight
cd mcp && npm run build
cd mcp && npm test
cd ui && npm run build
cd ui && npm test
```

Record actual exit status, duration, total, passed, failed, and skipped. Any red result remains a defect until reproduced and corrected.

- [ ] **Step 3: Collect rendered and resource evidence**

Use only the local synthetic app. If an already-authenticated local chart is available without credential or account mutation, render:

- blank procedure add row;
- active-and-coded options only;
- three accepted rows with code, unset/OD laterality, and distinct diagnosis choices;
- the visit selector still present and unchanged.

If no safe local chart is available, use the deterministic React renderer result and state that boundary in the PR. Preserve synthetic JSON for the four proposals, four ChargeItems, OD bodysite, one selected pointer, unchanged protocol row, and resulting Claim item.

- [ ] **Step 4: Re-run the independently reviewable claim group**

Run:

```bash
cd mcp
node --import tsx --test --test-concurrency=1 src/__tests__/procedure-charge-laterality.test.ts tests/claimDraft.test.ts tests/claimmdFhir.test.ts tests/claimHandlers.test.ts
```

The PR's `Claim laterality correctness fix` section must list:

- no-bodysite charges now produce no claim laterality instead of inheriting diagnosis laterality;
- diagnosis conflicts no longer emit the dead warning;
- conflicting recognized ChargeItem bodysites emit the repurposed warning;
- OD ChargeItem bodysite remains OD against an OU diagnosis;
- persisted ChargeItem state cannot be overridden by synthetic request laterality;
- the two dx-derived test expectation changes and four transport-test updates by exact test name;
- mutation proof A red and green output.

- [ ] **Step 5: Commit any final verified correction**

If verification required a correction, run its focused red/green test and all affected gates, then:

Stage only the corrected tracked paths with `git add -u`, inspect `git diff --cached --name-only`, and commit:

```bash
git add -u
git diff --cached --name-only
git commit -m "fix: preserve procedure charge contract"
```

If no correction was needed, do not create an empty commit.

- [ ] **Step 6: Push and open a non-draft PR**

Use the `github:yeet` skill. Push `drbang-iva/procedure-charges` without force and open a ready PR against `main`. The PR body includes:

- summary and scope fences;
- Amendment 2 active-and-coded selector proof;
- standalone claim-laterality behavior inventory;
- all real full-gate counts;
- nine behavioral acceptance results;
- both mutation proofs;
- synthetic proposal, ChargeItem, Claim, and UI evidence;
- explicit statement: `Codex authored this change and did not evaluate it.`

- [ ] **Step 7: Adjudicate present findings and poll exact-head state**

At the final PR head:

```bash
gh pr checks
```

Read every existing Greptile and PR-Agent thread, fix or reply to each actionable finding, and rerun affected gates after any push. Re-poll the final head; an in-progress check with zero threads is pending, not clean. Do not trigger, wait for, or mention CodeRabbit.

- [ ] **Step 8: Return the sealed bundle**

Report:

- plain-language summary;
- files touched;
- commit hashes and branch;
- exact commands and real counts;
- Amendment 2 read-side filter proof;
- all behavior evidence and mutation red/green results;
- decisions/INDEX status: no new ODOS decision entry because the controlling decision lives in PerformanceOD;
- Mandate 14 status: no codes or ledger rows added;
- cross-repo follow-up: PerformanceOD Amendment 2 is the controlling source;
- PR URL and exact-head bot/thread state;
- risks and blockers;
- status: `NEEDS REVIEW`;
- `⚠️ NOT EVALUATED — hand to Fable/Opus in Claude for the independent exact-head evaluation before merge. I wrote it; I can't be the judge.`
