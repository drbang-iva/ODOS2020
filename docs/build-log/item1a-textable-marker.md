# Item 1a implementation evidence

Status: author verification complete. NOT EVALUATED — awaiting independent evaluation.

Branch: `item1a-textable-marker`. Base: `5b72b1a1002d754f4874c1f4d6d4c9e4b3331f59`. The PR records the final reviewed head and bot dispositions.

## Scope implemented

- `ui/src/lib/patient-registration.ts`: display and save fallbacks exclude obsolete contacts. Current contacts retain metadata and position; obsolete-only nonblank saves append a home contact.
- `data/canonical-extensions/odos-no-textable-number.json` and `registry.json`: singular Patient marker with required boolean fixed true.
- `mcp/src/comms/suppression-gate.ts`: shared candidate selection, separate SMS and voice entry points, voice wrapper and distinct marker-refusal errors.
- Education and conversation production code remain unchanged and delegate to the SMS resolver. RelatedPerson selection uses the recipient resource itself.
- Tests changed: `ui/tests/patientRegistration.test.tsx`; `mcp/tests/commsSuppression.test.ts`, `commsApi.test.ts`, `commsConfig.test.ts`, and `commsProfileBindings.test.ts`.
- `data/code-bindings/native-comms-slice2-ledger.md`: two verification rows added.

## Required-phone boundary

H14 proves that blank and whitespace-only phones are rejected with the existing `Phone number is required.` message, before persistence. Removing the required-phone guard would be out of scope. The mutation reached persistence with `telecom: []` and failed the zero-write assertion. The identical helper branch is exercised through email removal by H14, H1/H2, and the existing G5/G13 tests. Phone clearing is closed by design, not an unproven path.

An imported Patient without a phone cannot save demographics under the existing validation rule. This predates item 1a and remains unchanged. The savable-state decision belongs to item 1b with its second phone and Neither answer; item 1a does not solve it.

## Runner inventory

Each cell is tests / passed / failed / skipped.

| File | Before | After |
|---|---|---|
| commsSuppression | 28/28/0/0 | 33/33/0/0 |
| commsApi | 91/91/0/0 | 93/93/0/0 |
| commsConfig | 27/27/0/0 | 28/28/0/0 |
| patientRegistration | 16/16/0/0 | 20/20/0/0 |
| demographicsConcurrency | 3/3/0/0 | 3/3/0/0 |
| patientRegistrationEndpoint | 4/4/0/0 | 4/4/0/0 |
| registrationCommunicationPreferences | 8/8/0/0 | 8/8/0/0 |
| commsProfileBindings | 7/7/0/0 | 9/9/0/0 |
| Full UI | 1428/1428/0/0 | 1432/1432/0/0 |

Commands: MCP files used `npm --prefix mcp test -- tests/<file>.test.ts`; UI files used `node --import tsx --test tests/<file>.test.tsx` from `ui/`; full UI used `npm --prefix ui test`. The baseline full UI ran in a separate checkout at the pinned base. The final full UI run includes H14. The four targeted MCP files passed 163/163 with zero skips.

`npm --prefix mcp run build`: exit 0 (`tsc`). `npm --prefix ui run build`: exit 0; Vite reported `built in 2.49s`, with bundle-size warnings. `git diff --check`: exit 0.

## Mutation results

Each test-runner row records actual `# tests / # pass / # fail`; red exit 1, restored green exit 0. Mutants were restored before subsequent edits.

| Guard | Deliberate break | RED | GREEN |
|---|---|---|---|
| H1 | Restore obsolete fallback in both selectors | 1/0/1 | 1/1/0 |
| H2 | Restore obsolete fallback only in save | 1/0/1 | 1/1/0 |
| H3 | Force append instead of editing the home entry | 1/0/1 | 1/1/0 |
| H4 | Ignore marker in resolver | 1/0/1 | 1/1/0 |
| H5 | Route calls through SMS wrapper | 1/0/1 | 1/1/0 |
| H6 | Return explicit SMS before checking marker | 1/0/1 | 1/1/0 |
| H7 | Replace education delegation with divergent second marker check | 1/0/1 | 1/1/0 |
| H8 | Replace conversation delegation with divergent second marker check | 1/0/1 | 1/1/0 |
| H9 | Delete registry entry | 1/0/1 | 1/1/0 |
| H10 | Rename definition to a non-JSON suffix | Expected 1, actual 0; assertion FAIL | Expected 1, actual 1; assertion PASS |
| H11 | Collapse both refusal messages | 1/0/1 | 1/1/0 |
| H12 | Refuse when marker is absent | 1/0/1 | 1/1/0 |
| H13 | Resolve the patient rather than the RelatedPerson | 1/0/1 | 1/1/0 |
| H14 | Remove required-phone validation (out of scope) | 1/0/1; blank phone persisted as `[]` | 1/1/0; zero writes, email removal passes |

H9 red output includes `severity: hard-block` and `code: odos-extension-url-shape`.

H10 ran the unchanged `scripts/install-profiles.ts` against a newly created, disposable local Medplum server and synthetic project. Both installer executions exited 0; the assertion failed when the filename was skipped, then passed when restored. The restored run reported:

```text
H10 RED: installer exit 0; expected 1 definition, actual 0; installation assertion FAIL
created https://odos2020.com/fhir/StructureDefinition/odos-no-textable-number (382cffc7-4e86-4d13-ad5d-0be0d6d65df6)
H10 GREEN: installer exit 0; expected 1 definition, actual 1; installation assertion PASS
```

H7 and H13 use a marker-only Patient extension list, excluding the fixture default opt-out. Both mutations were rerun after that isolation: each remained RED 1/0/1 and GREEN 1/1/0. H7 asserts the expected HTTP 409.

H13 exercises the HTTP education dispatch and asserts the RelatedPerson number reaches the fake sending adapter while the marked Patient resolves no SMS number. No external message was sent.

## Browser and persistence proof

Two Vite servers ran the pinned base and proposed revision on separate loopback ports, with the same synthetic Patient data and 1440x1050 viewport. Playwright opened the actual `/clinic?patientId=...` route and clicked Edit demographics. Screenshots capture the Contact information fieldset; no page styling was altered. All four Patient saves returned HTTP 200 and were checked by reading the resource back from the disposable local Medplum server. No browser page errors occurred.

| Case | Before | After |
|---|---|---|
| Obsolete phone only | Displays obsolete number; save changes its value and leaves it obsolete | Displays blank; save appends home entry and leaves obsolete entry untouched |
| Obsolete then work | Displays and edits obsolete entry | Displays work; save changes work value in place, retaining rank and obsolete entry |
| Blank phone after change | Not applicable | Existing validation message; zero PUT requests |

Artifacts are in `docs/build-log/item1a-textable-marker/`: four screenshots and `browser-results.json` with displayed values, persisted telecom, HTTP statuses, and the zero-write assertion.

Limits: role lookup, overview summary, opt-out and preference reads used explicit browser fixtures; other ancillary services returned unavailable. Patient GET/PUT requests reached the actual disposable FHIR server. This proves the app-route editor and persistence behavior, not production role or AccessPolicy enforcement. Communications send assertions use fake provider adapters; no external message was sent.

## Delivery state

Independent evaluation remains required at the final PR head. The author has not posted an evaluation verdict or applied an evaluated label. Bot completion and comment dispositions are recorded on the PR, separately from this author evidence.

No new architectural decision was made; no decision-index update or cross-repository change was performed.


## Fixback: history lookup, prescription phone, and marker value

This section supersedes the original H8 behavior and presence-only marker interpretation above. Starting head: `96b725d8a4d2bb9b916b57e0407e5886d36b348e`; base remains `5b72b1a1002d754f4874c1f4d6d4c9e4b3331f59`.

- F1: GHL history uses a separate lookup resolver wired to the existing `resolveVoiceNumber`. SMS keeps its marker-aware resolver. The shared Patient lookup accepts the selection function, preserving reference validation and avoiding another selector. H8 now requires a provider history lookup while the same marked Patient's SMS is refused.
- F2: WENO's shared phone helper excludes obsolete and blank entries. Both obsolete/home and obsolete/mobile Patient shapes emit the current number. The adult XML golden is unchanged; existing prescriber expectations pass. Period filtering remains unchanged.
- F3: The marker refuses SMS only when `valueBoolean === true`. False and missing values resolve normally.

No other adapter uses `resolvePatientPhone` for a read. No UI source, suppression state, preference cells, RelatedPerson semantics, or phone validation changed. The existing GHL adapter history fixture now supplies the new lookup dependency.

### Fixback guard proof

Each command ran from `mcp/`: `node --import tsx --test --test-name-pattern=FBn tests/<file>.test.ts`. Counts below are the runner's actual `# tests / # pass / # fail`; exit statuses were captured separately. Each production mutation was restored before GREEN and before the next guard.

| Guard | Deliberate break | Mutated counts; exit | Restored counts; exit |
|---|---|---|---|
| FB1 | Remove the lookup's `resolveVoiceNumber` argument, restoring SMS selection | 1 / 0 / 1; 1 | 1 / 1 / 0; 0 |
| FB2 | Send through the lookup dependency | 1 / 0 / 1; 1 | 1 / 1 / 0; 0 |
| FB3 | Substitute the SMS refusal message for the accurate no-phone lookup error | 1 / 0 / 1; 1 | 1 / 1 / 0; 0 |
| FB4 | Restore the original unfiltered WENO find (old/home) | 1 / 0 / 1; 1 | 1 / 1 / 0; 0 |
| FB5 | Restore the original unfiltered WENO find (old/mobile) | 1 / 0 / 1; 1 | 1 / 1 / 0; 0 |
| FB6 | Restore presence-only marker matching; true is the control | 1 / 1 / 0; 0 | 1 / 1 / 0; 0 |
| FB7 | Restore presence-only marker matching; false | 1 / 0 / 1; 1 | 1 / 1 / 0; 0 |
| FB8 | Restore presence-only marker matching; missing value | 1 / 0 / 1; 1 | 1 / 1 / 0; 0 |

FB2's mutant completed a synthetic adapter send (`Missing expected rejection`), proving the zero-provider-request boundary. FB1's mutant threw the prior false no-phone error. FB4/FB5 selected the obsolete number. FB7/FB8 returned undefined instead of the current number. An initial marker fixture import omission was corrected before recording these mutation results; that setup failure is not claimed as guard evidence.

### Fixback regression inventory

Baseline numbers are the supplied independently run inventory at the starting head. Every after count below was run on the restored fixback code. MCP commands: `npm --prefix mcp test -- tests/<file>.test.ts`. Individual UI commands, from `ui/`: `node --import tsx --test tests/<file>.test.tsx`.

| File / suite | Starting count | Fixback tests | Pass | Fail | Skipped | Exit |
|---|---:|---:|---:|---:|---:|---:|
| commsSuppression | 33 | 36 | 36 | 0 | 0 | 0 |
| commsApi | 93 | 93 | 93 | 0 | 0 | 0 |
| commsConfig | 28 | 30 | 30 | 0 | 0 | 0 |
| commsProfileBindings | 9 | 9 | 9 | 0 | 0 | 0 |
| wenoSwitchNewRx | 35 | 37 | 37 | 0 | 0 | 0 |
| ghlAdapter (additional affected suite) | — | 17 | 17 | 0 | 0 | 0 |
| patientRegistration | 20 | 20 | 20 | 0 | 0 | 0 |
| demographicsConcurrency | 3 | 3 | 3 | 0 | 0 | 0 |
| patientRegistrationEndpoint | 4 | 4 | 4 | 0 | 0 | 0 |
| registrationCommunicationPreferences | 8 | 8 | 8 | 0 | 0 | 0 |
| full UI (`npm --prefix ui test`) | 1432 | 1432 | 1432 | 0 | 0 | 0 |

Build commands: `npm --prefix mcp run build` exited 0; `npm --prefix ui run build` exited 0 (typecheck and Vite bundle; existing bundle-size warning). `git diff --check` exited 0.

H1–H9 and H11–H14 pass in those suites, with H8 rewritten. H10 was also rerun against a fresh synthetic project on the disposable local server: `installer exit 0; expected 1 definition, actual 1; installation assertion PASS`. Its first retry encountered an expired token; a fresh disposable identity resolved that setup issue. The installer and artifact remain unchanged.

### Limits and handoff

Provider calls are synthetic fetch fixtures; no real GHL service or pharmacy received a request. Existing browser evidence covers the unchanged demographics surface. This fixback adds no visible UI and makes no claim of live provider behavior. The no-phone demographics limitation and SMS-as-voice policy question remain outside scope. No new clinical code or FHIR artifact URL was introduced, so no additional verification-ledger rows are required.

**NOT EVALUATED — awaiting independent evaluation of the fixback head.** Author test evidence is not an independent verdict.
