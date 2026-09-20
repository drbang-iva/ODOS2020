> Resolved by the operator ruling at companion commit `cb1e2368`. Historical blocked-state record; see [HANDOFF.md](HANDOFF.md) for the completed implementation and evidence.

# E1a blocked handoff

Status: **BLOCKED — partial implementation, uncommitted, NOT EVALUATED**.

## Summary

- All eight explicitly enumerated kickoff premises were confirmed against fetched origin/main.
- An additional factual premise in Build §1 is false: the item title is not currently recorded in dispatch Provenance.
- The unchanged Provenance records item ID and version, channel, lane and recipient.
- Communication retains the item title inside its frozen dispatch context; this assertion passes.
- Stopped as instructed when the additional false premise was confirmed. No persistence change was invented.
- Partial envelope, classification guards and confirm-step disclosure are preserved in this worktree.
- No commit, push, PR, merge, independent evaluation, live send or external account change occurred.

## Location and exact base

Worktree: `/Users/ericr.bang/.codex/worktrees/email-e1a-envelope/ODOS2020`

Branch: `codex/email-e1a-envelope`

Base and current HEAD: `f2ef2c325e36d756759a525339431d70c7bcfde1`.

PerformanceOD reference checkout: `/Users/ericr.bang/GitHub/performance-od`.
Read the three required decisions with `git show origin/main:<path>` after fetching;
reference origin/main was `0239a54576a4ed8e57506619a4b00ad1de3dd64e`.
Its active checkout and existing edits were not changed.

## Blocking contradiction and required ruling

Build §1 says: "The item title continues to be recorded on the chart Communication and
Provenance exactly as today."

At the unchanged base, `mcp/src/comms/comms-api.ts:2509-2553`,
`persistEducationSendProvenance` writes:

```ts
{ role: "source", display: `Education content: ${input.item.id}@${input.item.version}` }
```

There is no title field or title-bearing entity in this function. The common
`buildProvenance` helper only copies the supplied entity displays; it does not look up titles.
In the partial working tree the same unchanged persistence function starts at line 2523,
with the ID/version entity at line 2550.

The new route-to-adapter integration test `E1a a neutral MIME envelope keeps the item title on the chart`
passes its neutral subject, complete footer and Communication title assertions, then fails:

```text
The expression evaluated to a falsy value:
  assert.ok(JSON.stringify(f.provenances).includes(E1A_ITEM.title))
expected: true
actual: false
```

Resolve one of these interpretations before continuing:

1. Preserve Provenance exactly as it exists: ID/version only; retain the title in Communication.
2. Add item title to dispatch Provenance as an explicit additional E1a change.

The second choice changes current persistence behavior. Neither was silently selected.

## Enumerated premise verification

All locations below refer to the exact base SHA above.

| Premise | Evidence | Result |
| --- | --- | --- |
| Email subject uses item title | `mcp/src/comms/comms-api.ts:1348` | Confirmed |
| Recorded marketing-consent check is SMS-only | same file, line 1087 | Confirmed |
| Staff override requires transactional class | same file, line 1343 | Confirmed |
| Successful staff override writes education/email ON | same file, lines 1372-1377 | Confirmed |
| Marketing/email defaults true | `mcp/src/comms/suppression-gate.ts:44` | Confirmed |
| Catalog fields match kickoff | `mcp/src/comms/education-catalog.ts:6-21` | Confirmed |
| Plain-text MIME with one From | `mcp/src/comms/adapters/google-workspace-adapter.ts:126-142` | Confirmed |
| UI withheld detection and post-send message | `ui/src/components/comms/EngageSheet.tsx:134-135,275-282` | Confirmed |

Additional existing UI behavior: a pre-send note already appears on the item card at base
line 364. The requested exact wording was added inside the confirmation step, preserving
the existing post-send success and failure messages.

## Practice settings choice in the partial implementation

- Display name: reuse existing `ODOS_PRACTICE_NAME`.
- Postal address: new `ODOS_PRACTICE_POSTAL_ADDRESS`.
- Phone: new `ODOS_PRACTICE_PHONE`.
- Optional subject: new `ODOS_COMMS_EMAIL_SUBJECT`; defaults to `Information from <practice name>`.
- Future capability: `ODOS_COMMS_EMAIL_UNSUBSCRIBE_ENDPOINT`; absent from production configuration.

These follow the existing communications environment-config convention. Billing identity has
address/optional phone, but is a claims-specific structure requiring NPI, tax ID and taxonomy;
the partial implementation does not make patient email dependent on claims setup.
No real environment/account settings were edited. All test settings are synthetic.

## Files touched

- `.env.example`
- `data/education-catalog.json`
- `mcp/src/comms/adapters/google-workspace-adapter.ts`
- `mcp/src/comms/comms-api.ts`
- `mcp/src/comms/comms-config.ts`
- `mcp/src/comms/comms-provider.ts`
- `mcp/src/comms/education-catalog.ts`
- `mcp/src/comms/suppression-gate.ts`
- `mcp/src/index.ts`
- `mcp/tests/commsApi.test.ts`
- `mcp/tests/educationCatalog.test.ts`
- `mcp/tests/googleWorkspaceAdapter.test.ts`
- `ui/src/components/comms/EngageSheet.tsx`
- `ui/tests/engageCommunicationPreferences.test.tsx`

Evidence-only additions: this file and the seven `.log` files alongside it.
No PerformanceOD changes; no new decision or decisions/INDEX.md edit. No new medical code,
regulatory assertion or FHIR artifact identifier was introduced; no Mandate 14 ledger rows added.
Existing placeholder marketing catalog entries now explicitly declare `offerClass: "eyecare"`.

## Checks and real results

Commands below ran from this isolated worktree (not the root reader checkout).

1. Baseline, before source/test edits, from `mcp/`:
   `npm test -- tests/commsApi.test.ts tests/commsSuppression.test.ts tests/googleWorkspaceAdapter.test.ts tests/educationCatalog.test.ts`
   Result: **163 tests, 163 pass, 0 fail, 0 skipped**. `baseline.log`.
2. New envelope/catalog tests against unchanged product code, from `mcp/`:
   `npm test -- tests/googleWorkspaceAdapter.test.ts tests/educationCatalog.test.ts`
   Result: **17 tests, 7 pass, 10 fail, 0 skipped**. `envelope-catalog-red.log`.
3. New API cases against unchanged product code, after correcting the test fixture's generic
   provider-identifier lookup and too-short SMS idempotency key, from repo root:
   `npm --prefix mcp test -- --test-name-pattern=E1a tests/commsApi.test.ts`
   Result: **10 tests, 3 pass, 7 fail, 0 skipped**. `api-red.log`.
4. Disclosure test before UI change, from `ui/`:
   `node --import tsx --test tests/engageCommunicationPreferences.test.tsx`
   Result: **14 tests, 13 pass, 1 fail, 0 skipped**. `ui-red.log`.
5. Current focused MCP suites, from repo root:
   `npm --prefix mcp test -- tests/commsApi.test.ts tests/commsSuppression.test.ts tests/googleWorkspaceAdapter.test.ts tests/educationCatalog.test.ts`
   Result: **182 tests, 181 pass, 1 fail, 0 skipped**. Sole failure: item title absent from
   Provenance, described above. `focused-current.log`.
6. Current UI suites, from `ui/`:
   `node --import tsx --test tests/engageCommunicationPreferences.test.tsx tests/engageSheet.test.tsx`
   Result: **35 tests, 35 pass, 0 fail, 0 skipped**. `ui-current.log`.
7. MCP build, from `mcp/`: `npm run build`
   Result: **exit 2**, four TypeScript errors in `../scripts/access-policy-rules.ts`:
   TS2307 missing root `@medplum/fhirtypes`, plus three TS7006 implicit-any errors.
   Only mcp/ui dependencies were installed; root dependency setup remains incomplete.
   `mcp-build.log`.

## Six requested mutation demonstrations

**None of the six required deliberate break/restore pairs has been completed.** The test-first
red runs above are recorded as such, not substituted for post-implementation mutation proof.

| Guard | Current assertion result | Broken/restored mutation proof |
| --- | --- | --- |
| a: neutral subject, footer, chart title | MIME/footer/Communication pass; Provenance-title assertion fails | Not run; blocked |
| b: missing address/phone, zero provider calls | Both API cases pass; adapter missing/unresolved cases pass | Not run |
| c: cosmetic email/SMS/print refusal with reason | All three API cases pass | Not run |
| d: marketing email capability refusal, preserve SMS/print | API case passes with/without recorded SMS marketing consent | Not run |
| e: email exempt from recorded consent, explicit marketing off enforced | Both API cases pass through real suppression and adapter | Not run |
| f: transactional staff override and preference ON | API case passes through real suppression and adapter | Not run |

The API integration fixtures exercise the production Express routes, suppression wrapper,
configuration loader and Gmail MIME adapter with fake FHIR storage and intercepted provider HTTP.
They are not proof of real stored AccessPolicy enforcement.

## Remaining work / risks

- Resolve the Provenance contract contradiction first.
- Treat every source change as unfinished. Full regression suite, root dependency setup, builds,
  deliberate mutations, role-scoped browser proof, screenshots and PR packaging remain outstanding.
- The UI component checks pass but the requested live web-tier proof with staff credentials has
  not run. No admin-token proof is being substituted.
- Shared wrapper propagation, all published-catalog consumers/fixtures, scheduled/prepared dispatch,
  unresolved templates and missing-settings handling still need full verification.
- `mcp/tests/commsSuppression.test.ts` was run but has not been extended yet.
- A synthetic capability URL appears only in tests for existing preference behavior; E1c is still
  required before promotional email can be enabled for an actual practice.
- No live Google, Iris, DNS, AWS or account configuration was touched.
- There is no PR to evaluate yet. Once implementation/proof is complete, open the requested non-draft
  PR with `Coded-by: Codex` alone on its first body line, then hand to Fable/Opus for independent review.

**NOT EVALUATED. No readiness, merge, deployment or live-delivery claim.**
