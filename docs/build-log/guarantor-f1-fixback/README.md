# Guarantor generation fence: author evidence

NOT EVALUATED. Base: d56b198068166e00e2d36fc0ef3a51903cd9ad9c.

Save checks the accepted Person generation before each child write. Repair checks its starting Person generation after the fresh child GET and before the child PUT. A moved generation stops this and later child submissions; an unreadable generation stops submissions as no-response. Neither path retries or compensates. Superseded results reload the party section, retaining a newer-edit notice and offering Repair only for currently mismatched children. Linked child 404/410 reads refuse editing as dangling and identify both resource references; other failures remain unknown.

## Promise and limit

The check prevents writes when it observes a moved generation. It is not a lock or atomic cross-resource transaction: a competitor may still land between the Person check and child PUT. Child If-Match remains enforced; save uses loaded child versions, repair uses fresh child versions. Verification still reads Person last and retains the existing child classifications. One explicit Repair converges the recorded residual when there is no further competitor. Continuous competing edits have no liveness guarantee.

## Checks

- Baseline `npm --prefix ui test`: 1472 passed, 0 failed.
- Final `npm --prefix ui test`: 1480 passed, 0 failed (`guards/final-ui.log`).
- Focused `node --import tsx --test tests/guarantorEditor.test.tsx tests/guarantorPropagation.test.tsx tests/demographicsConcurrency.test.tsx` from ui/: 34 passed, 0 failed. Editor 8 → 9; propagation 15 → 22; concurrency 3 → 3. All existing test bodies are unchanged.
- `npm --prefix ui run build`: exit 0; TypeScript and Vite succeed (`guards/build.log`). Vite reports its existing large-chunk advisory.
- No MCP or protected insurance/FHIR/policy files changed. No Patient writes in the recorded editor write sets.
- No new medical codes, terminology URLs, or regulatory claims: no Mandate 14 ledger additions apply.

## Deliberate breaks

Every row starts green, fails with the named mutation, and passes after restoring it. Full TAP logs and exact failing names are in `guards/`; `mutations.json` records exit codes. No listed guard is decorative.

| Guard | Deliberate break | Red | Restored |
|---|---|---|---|
| F1a/F1b | Remove repair generation check | Both race tests fail | Pass |
| F1a | Move check before fresh child GET | F1a fails | Pass |
| F1c | Remove save generation check | F1c fails | Pass |
| F1d | Treat failed check as pass | F1d fails | Pass |
| F1e UI | Omit automatic reload | Repair offer test fails | Pass |
| F1e message | Restore promise of Repair | Message test fails | Pass |
| F1f | Map 410 to unknown | Dangling test fails | Pass |
| F1f | Map all errors to dangling | 403 case fails | Pass |

An additional regression test proves an observed moved generation stays superseded even if trailing verification subsequently fails. Its pre-fix red and restored green are recorded separately.

## Real server proof

The isolated F1 stack reports Medplum `5.1.30-9b1bd92` and no project features. It runs at `127.0.0.1:19613`; its browser fixture runs at `127.0.0.1:19610`. Its database was copied from the existing disposable synthetic G-2a stack into a distinct Docker volume; all scenario writes target only the new stack. No practice endpoint is used.

The existing fixture renders production PatientRoute → PatientOverview → demographics editor → ResponsiblePartiesControl. The staff policy is generated from the unchanged staff declaration. The interceptor forwards every FHIR request and adds only the named competing writes. New synthetic records are created per run. Each Person links one child for these live scenarios; unit transport tests cover the two-child stop behavior and ownership transfer.

| Run | Editor writes | Fresh persisted state |
|---|---|---|
| F1a, repair fence removed | Child PUT 200 with Edited | Person Newest / child Edited: diagnostic reproduces the defect |
| F1a, fence restored | No child PUT | Person Newest / child Newest |
| F1e save residual | Person 200 / child 200 | Person Third / child Edited; automatic reload shows Repair for Sam Synthetic |
| F1e explicit Repair | Child PUT 200 only | Person Third / child Third; zero Person writes |

Serialized requests, If-Match versions, statuses, fresh reads and screenshots are in `live/`. Authorization headers and runtime credentials are excluded. The screenshots are author-side proof, not independent evaluation.

## Reproduction

Install locked root, MCP and UI dependencies. Copy `live/reproduction/*` into ignored `.odos/guarantor-f1/`, removing `.txt`. Provision an isolated synthetic Medplum at the loopback target above. Provide mode-0600 runtime.json containing baseUrl, email and password for that disposable administrator. Never substitute a practice endpoint.

Before provisioning or logging in, run `node --import tsx .odos/guarantor-f1/setup-guard.mjs` from the repository root. The guard supplies its own non-loopback fixture, then the documented loopback fixture. It restores the original `runtime.json` bytes in `finally`, or removes the fixture if no file existed. Both controls replace fetch; neither sends a real request. Expected output:

```text
Invalid endpoint refused before login; network requests: 0
Loopback endpoint passed URL guard and reached network stub; real network requests: 0
```

Run setup.ts with `./mcp/node_modules/.bin/tsx`, then serve.mjs with Node. Run `node .odos/guarantor-f1/live-proof.mjs F1e`. For F1a, temporarily replace only `halted = await checkGeneration(current.person);` with `halted = undefined;`, run `F1a-unfenced`, restore the line, then run `F1a-fenced`. The harness asserts the different outcomes; a green unfenced run means the unsafe outcome was reproduced, not that the writer is correct.

The mutation runner snapshot at `guards/mutations.py.txt` writes only the two production files temporarily and restores them in a finally block. Run from the task root after copying it to an ignored working file. Never run mutations concurrently with the full regression suite or a different live experiment.

## Bot review fixback

CodeRabbit's loopback finding is addressed by an exact baseUrl assertion before the reproduction setup invokes login. The setup guard replaces fetch with a request counter and rejects a non-loopback runtime with zero requests; removing the assertion makes that guard red, and restoring it makes it green. Logs are `guards/setup-loopback-{green,red,restored}.log`; the guard source is included with the reproduction files. The approved local setup still succeeds.

Save and Repair callbacks now return the operation promise. The new F1e UI test awaits both inside act, so completion includes reload and repair. Existing test bodies remain unchanged. F1e live proof and the focused/full UI checks were repeated after this callback change.

The request for an atomic server-side precondition was adjudicated as the documented limitation: transaction bundles and new server/policy changes are outside this slice, and the PR does not claim atomicity. The generation GET-to-child-PUT gap remains stated above.
