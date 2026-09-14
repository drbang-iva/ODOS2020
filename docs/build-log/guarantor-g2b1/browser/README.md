# G-2b-1 patient-route browser evidence

Author proof passed against the disposable local Medplum stack. Chromium opened the real `/clinic?patientId=...` route, clicked **Edit demographics**, and used the actual Responsible parties controls. The full application was served from `ui/index.html` through `main.tsx`, `App`, `RouteSwitch`, `PatientRoute`, `PatientOverview`, and `PatientDemographicsEditor`.

The capture used backend source at `82fc66de6cb04f74bcbbe7805c7934c934f932e6` and UI source at `e16b524e6402a6c333b8af459794b0387e4978e5`. The runner requires the guarantor editor, component, and operation API helper to match the integrated source byte for byte. [browser-proof.json](browser-proof.json) records individual source hashes, strict ports, PID, screenshot hashes, requests, writes, and checks. This is a Vite development-server capture, with the normal application styles and disposable proxy targets.

The final wave checked the backend commit, operation-file SHA256 `c7854febcbf8707f3f306f781646bad02b4f13c5f7debebc84e14e944ea5daab`, and routes-file SHA256 `c39e04ea3a42e8f1edaa2ec93d48556efca77682b320edffd10395d80d55c4a5` before and after each mutation and the restored run. The entire `ui/` directory was identical between the UI checkout and final core: `git diff --exit-code e16b524e6402a6c333b8af459794b0387e4978e5 82fc66de6cb04f74bcbbe7805c7934c934f932e6 -- ui` returned exit 0 with no output. This includes the Task-bound correction reason and Repair claim-order fixes. The final wave used the integrated fixture helper unchanged, after the parent released the shared staff principal.

## Results

| Check | Observed result |
| --- | --- |
| Real pending setup | Two transfers reached `attach-pending` after a real conditional staff edit of D landed between source detach and destination attach. Each rejected attach intent records HTTP 412. |
| Claim precedes missing classification | All four moved children had no Person owner at capture time and appeared pending with the operation ID and both affected patient names. |
| Pending write controls | Save and Repair were disabled; four forced pointer attempts produced no direct browser FHIR PUT. Correct was disabled for empty and whitespace-only reasons. |
| Complete click | Actual POST to `/guarantors/link-operations/:id/complete`, with no body, returned HTTP 200. Original Task completed, both children moved to D, and the editor reloaded D's current demographics. |
| Correct click | Actual POST to `/guarantors/link-operations/:id/correct` carried a new UUID and the entered reason and returned HTTP 200. A correction Task completed, the original Task was cancelled, both children returned to S, and the editor reloaded S's demographics. |
| Child preservation | All four RelatedPerson IDs, patient references, relationship, active state, period, consent authority, primary flag, and unrelated extension sentinel remained unchanged; claims were released. |
| Runtime | Two recovery clicks; 84 operation write attempts; 14 operation audit calls completed through the live audit runtime; zero page exceptions; zero direct browser FHIR PUTs. |
| Mutation proof | Disabling the served Complete handler made the Chromium POST wait fail; disabling the served Correct handler made its POST wait fail. Restored run passed both clicks. |

The FHIR resource and conditional-write trace is [browser-fhir-trace.json](browser-fhir-trace.json). All records and demographics are synthetic. Credential values were checked against every generated evidence file and none were present.

[browser-mutations.json](browser-mutations.json) records both expected exit-1 failures, the modified component source hashes, and the restored pass. The mutation switch changes the component through a proof-only Vite transform; repository source files remain unchanged. Mutation screenshots and full logs stay ignored.

## Scope and limitations

The harness mounts the actual guarantor, clinic, and desk route registrars with actual staff token verification and live FHIR/audit clients. Its sole operation hook makes the competing D edit through real HTTP after the source detach succeeds. It serves the unchanged full application; no component fixture or browser response interception is used.

Office, communications preference/opt-out, Series Tracker, and clinical graph routes are outside this harness. Their background requests returned HTTP 404, as recorded in the report, and the whole-route screenshot shows some resulting background notices. The browser's guarantor requests and FHIR reads succeeded. This capture proves the patient-route wiring and resulting FHIR state. It is author evidence, not an independent evaluation or a complete policy verdict.

The five PNGs are previews of the new pending surface and the results of clicking its controls. They are different workflow states at the same implementation, not a base-revision comparison. The scoped pending previews are the primary PR images; the whole-route image supplies context.

## Re-run

Use the already-created synthetic fixture, with exclusive ownership of backend port 28763, UI port 28764, and the fixture's `staff` principal. The runner replaces that principal's patient grants with its own four fresh synthetic patients. It leaves the fixture's policies and other principals alone. It closes its own two servers and audit client on completion.

From the task checkout, set `G2B1_SOURCE_ROOT` to the checkout containing the integrated backend and `G2B1_FIXTURE_HELPER` to `live-fixture.mjs`. Set `G2B1_LIVE_DIR` only if the helper's private fixture directory is elsewhere. Credentials remain in that ignored directory.

```sh
node --import ./mcp/node_modules/tsx/dist/loader.mjs docs/build-log/guarantor-g2b1/browser-proof.mjs
```

For the two guard mutations, additionally set `G2B1_BROWSER_MUTATION` to `complete-click` or `correct-click` and point `G2B1_EVIDENCE_DIR` beneath the proof checkout's ignored `.odos/` directory. Each mutation must fail waiting for the corresponding actual POST response. Unset the mutation variable and run again for the normal pass.

Expected final output:

```text
Disposable actual routes ready on 28763; full app on strict port 28764.
PASS: actual patient-route Complete and Correct clicks, reloads, disabled pending writes, real 412s, and four preserved child identities.
```

For PR insertion, use `.claude/skills/before-and-after/scripts/format.mjs` with after-only previews, verify the committed and pushed PNG bytes, replace local references with commit-pinned GitHub URLs, and pass the generated block and freshly read PR body to `pr-body.mjs`. Preserve unrelated PR text. The checked-in images have been visually inspected; publishing and rendered-PR inspection remain with the parent task.
