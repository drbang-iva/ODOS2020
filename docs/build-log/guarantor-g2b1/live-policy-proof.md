# L17 and L18 live policy capture

Author development capture: **58 positive assertions passed, zero unexpected failures**. The unchanged guards produced **12 expected failing assertions** across three fixture-policy mutations. Each mutation also ran the captured HTTP results through the status guard in a separate Node process, which exited **1**. Restored-policy assertions passed afterward.

Source HEAD was `dba65485ba74b9d02fbe51c3be68725148a94431`, with the operation service still uncommitted. `live-policy-proof.json` records the SHA-256 of each loaded service, route, policy, audit, sync, and editor file. Those digests and the HEAD were unchanged between the beginning and end of the capture. Final integrated-head repetition and independent evaluation remain outstanding.

| Case | Live observation |
|---|---|
| Genuine operation fixture | Actual service function created and claimed the operation. A staff name edit to S made its detach PUT return 412; the service recorded `in-progress` / `detach-pending`. |
| L17(i) | A Task actually authored by staff was created during a temporary fixture constraint removal. After policy restoration, actual S4 preview ignored its claim. |
| L17(ii) | Staff copied the genuine service Task's claim onto an unlisted child. Actual S4 preview ignored that claim. |
| L17(iii)–(vi) | Staff and composite membership: setting `failed`, changing `input`, removing the operation code, and creating a completed operation Task each returned 403. Ordinary Task creation/update remained available. |
| L17(vii) | Actual Correct returned 403 for the staff-authored Task, with no Task/Person/RelatedPerson write. |
| L18 | Staff and composite membership: link change 403; linked name edit 200; empty-link name edit 200; create-with-link 403; create-without-link 201. |
| L18 G-2a | Actual integrated editor load/save ran against real Medplum for both memberships. Each save returned `saved`, with its child `updated`. |

| Fixture mutation | Broken unchanged guard | Restore |
|---|---|---|
| Remove Task write constraint | Six PUTs became 200 and two completed-Task POSTs became 201; eight 403 assertions failed; guard process exit 1 | Repository sync restored constraints; all eight 403 assertions passed |
| Remove Person write constraint | Both link changes became 200; two 403 assertions failed; guard process exit 1 | Repository sync restored the constraint; both link guards passed |
| Restore revision-1 Person expression | Both empty-link name edits became 403; two 200 assertions failed; guard process exit 1 | Repository sync restored the current expression; both empty-link edits passed |

The capture contains **364 actual HTTP exchanges and 63 audit rows**, including the operation's real `guarantor.link.started` and `guarantor.link.pending` rows. The full HTTP trace is compact JSON in `live-policy-http.json`; AccessPolicy bodies and patches retain Person/Task rules plus hashes of their full values. `live-policy-restore-verification.json` records a final dry run of the actual repository sync: four canonical policies, zero policy drift, and zero membership drift.

The script uses actual `authenticateStaffRoute()`, `handleGuarantorOperation()`, and the integrated editor. Browser-relative FHIR URLs are forwarded to the disposable Medplum origin; resources and responses are not stubbed. S4 source predicates were not mutated in this instrument. A rendered browser workflow and the remaining concurrency schedules belong to the broader proof.

Run with the retained fixture and chosen implementation checkout through `G2B1_LIVE_DIR` and `G2B1_SOURCE_ROOT`:

```sh
node --import tsx docs/build-log/guarantor-g2b1/live-policy-proof.mjs
```

This command temporarily mutates only the two fixture constraints. It requires exclusive use of the fixture policies and restores them through `syncPracticeRolePolicyRules()` from the repository script, including on failure. It leaves its uniquely identified synthetic subjects and operation histories available for inspection.
