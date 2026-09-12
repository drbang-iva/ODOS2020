# Item 1b-i: textable ContactPoint marker

Status: **NOT EVALUATED**. Author verification only. Base:
`fb14704637d51dcb098c611903492becfde6200a`; branch `drbang-iva/textable-number`.

## Result and scope

An active phone/sms ContactPoint with `odos-textable-number=true` now outranks
imported sms, mobile, and first-active fallback. SMS sends still honor the
Patient refusal marker. Conversation history uses the same candidate ordering
while ignoring refusal. Voice retains its original candidate ordering and output.

Three entry points share one active-candidate filter. `resolveSmsNumber` delegates
to the new `resolveSmsHistoryNumber` after refusal; history delegates directly to
it. `resolveVoiceNumber` uses only the shared legacy preference helper. The active
filter was extracted and verified before the new ordering was introduced. A final
source audit found exactly one affirmative marker read, in the history selector;
there is no duplicate read in education, configuration, or UI.

The StructureDefinition has ContactPoint datatype context (`type: element` in R4),
root 0..1, valueBoolean 1..1 fixed true, and no nested extensions. Registry namespace
is `communications`, consumer `item-1b-i`. Five Mandate 14 rows record agreeing HL7
R4 sources, accessed 2026-09-12. The installer is unchanged.

No UI, validation, registration endpoint, suppression policy, preference grid,
education override, or WENO code changed. No dependency changes. The existing editor
still matches phone ContactPoints; WENO still requires a non-old `system: phone`.

## Guard evidence

Counts are runner output in **tests/pass/fail** order. Each red run exited 1;
each restored run exited 0. Full count excerpts and durations are in
[item1bi-textable-number/verification.txt](item1bi-textable-number/verification.txt),
with machine-readable [mutation results](item1bi-textable-number/mutations.json).

| Guard | Deliberate break | RED | Restored GREEN |
|---|---|---|---|
| J1 | Remove affirmative marker preference | 1/0/1 | 1/1/0 |
| J2 | Read marker presence, ignoring false/missing value | 2/0/2 | 2/2/0 |
| J3 | Bypass refusal before candidate selection | 1/0/1 | 1/1/0 |
| J4 | Select marked old entry before active filtering | 1/0/1 | 1/1/0 |
| J5 | Bypass active filtering: expired, future, blank, email | 4/0/4 | 4/4/0 |
| J6 | Take first marked entry even when obsolete | 1/0/1 | 1/1/0 |
| J7 | Route voice through the affirmative preference | 1/0/1 | 1/1/0 |
| J8 | Remove unmarked fallback | 1/0/1 | 1/1/0 |
| J9 | Remove imported sms preference | 1/0/1 | 1/1/0 |
| J10 | Delete registry entry | 2/0/2 | 2/2/0 |
| J11 | Rename definition to a skipped suffix | 1/0/1 | 1/1/0 |
| J12 | Duplicate an education marker check that bypasses active filtering | 6/4/2 | 6/6/0 |
| J13 | Wire history to voice: work contact missed, history empty | 1/0/1 | 1/1/0 |
| J14 + FB1 | Wire history to SMS refusal | 2/0/2 | 2/2/0 |

J10 calls the real preflight canonical-shape pass: **0 hard blocks → 1 hard block →
0 restored**, code `odos-extension-url-shape`. The count is for the focused resolver
source input, not a whole-repository preflight claim.

J11 ran `scripts/install-profiles.ts` against a newly created synthetic project on
an isolated Medplum 5.1.30 Docker stack, loopback port 19213, with separate databases,
volumes and signing keys. Both installer processes exited 0. The assertion found
zero definitions while skipped, then one with matching context/differential and a
hydrated snapshot after restoration:

```text
created https://odos2020.com/fhir/StructureDefinition/odos-textable-number (5724e2ef-9bf5-47a7-a5df-1629e0630eca)
```

The prior H10 refusal-definition installation guard was also rerun on that project:
`# tests 1 / # pass 1 / # fail 0`, installer exit 0. This proves actual installation;
it does not claim live patient validation of every profile constraint.

J12 runs real education HTTP dispatch for Patient and RelatedPerson, asserting the
provider destination, persisted frozen recipient, and provenance. Its six fixtures
cover active, false and expired markers. J13/J14 run the real configured GHL adapter
against a fake external HTTP boundary containing only the work-number contact and
its history; wrong-number lookup therefore returns an empty list naturally. No
external message was sent.

Initial new-test runs against the base failed as expected for marker preference and
history. One new RelatedPerson fixture initially failed at request validation because
it used the wrong fixture option and omitted the required override contact field;
it was corrected to the existing `relatedPeople`/email-only override pattern before
mutation evidence was collected. Its final red/green proof reaches number selection.

## Regression gate

All existing H1–H14 and FB1–FB8 guards retained. No existing test expectations changed.
The required per-file results are recorded in
[regressions.json](item1bi-textable-number/regressions.json).

| Command/suite | tests | pass | fail | exit |
|---|---:|---:|---:|---:|
| `npm --prefix mcp test -- tests/commsSuppression.test.ts` | 49 | 49 | 0 | 0 |
| `npm --prefix mcp test -- tests/commsApi.test.ts` | 99 | 99 | 0 | 0 |
| `npm --prefix mcp test -- tests/commsConfig.test.ts` | 32 | 32 | 0 | 0 |
| `npm --prefix mcp test -- tests/commsProfileBindings.test.ts` | 11 | 11 | 0 | 0 |
| `npm --prefix mcp test -- tests/wenoSwitchNewRx.test.ts` | 37 | 37 | 0 | 0 |
| `npm --prefix mcp test -- tests/ghlAdapter.test.ts` | 17 | 17 | 0 | 0 |
| UI `patientRegistration` | 20 | 20 | 0 | 0 |
| UI `demographicsConcurrency` | 3 | 3 | 0 | 0 |
| UI `patientRegistrationEndpoint` | 4 | 4 | 0 | 0 |
| UI `registrationCommunicationPreferences` | 8 | 8 | 0 | 0 |
| `npm --prefix ui test` | 1432 | 1432 | 0 | 0 |

UI per-file command: from `ui/`,
`node --import tsx --test tests/<suite>.test.tsx`.
All above report zero skipped tests. The endpoint suite is in UI; an initial attempt
to address it under MCP found no file and was replaced with the correct command.

`node --import tsx docs/build-log/item1bi-textable-number/voice-parity.mjs`
compares the real current resolver with the actual voice function extracted from the
pinned base: **2,160 voice comparisons, 720 unmarked SMS comparisons, 0 mismatches**.
The voice comparisons vary system, use, value, period, affirmative value and refusal.
J7 additionally exercises actual `initiateCall` destination with both refusal states.

`npm --prefix mcp run build`: exit 0 (`tsc`).
`npm --prefix ui run build`: exit 0; existing Vite chunk-size advisory remains.
`git diff --check`: exit 0.
Proxy census: 24 backend route families, 27 proxy entries, every family covered
(advisory only; no new route family in this slice).

## Reproduction and limits

Run `python3 docs/build-log/item1bi-textable-number/mutations.py` from a dedicated
worktree with dependencies installed. It runs sequential mutations and restores exact
bytes in `finally`; do not run other checks or edits concurrently with mutations.
J11's separate `install-proof.test.mjs` takes `MEDPLUM_BASE_URL` and
`MEDPLUM_ACCESS_TOKEN` for a fresh local synthetic project. Run once with the new
JSON file renamed to `.json.skipped` (expected test exit 1), restore it, and run again
(expected exit 0). It executes the unchanged generic installer, not a replacement
loader. Access material is local and untracked.

Two operator-ruled behaviors need independent challenge: inactive marked numbers
fall through rather than refusing; history follows the current texting number and
may not discover older threads under a previous number. Multi-number history lookup
and the form that writes the marker remain outside this slice. No new decision was
made here; the supplied accepted contract was implemented. The companion checkout
was read-only, so no decision index change was needed or made.

No live AccessPolicy change or claim: selection was exercised through real application
paths with synthetic FHIR/provider boundaries. This slice has no visible UI surface;
the before/after evidence is the measured guard behavior above.
