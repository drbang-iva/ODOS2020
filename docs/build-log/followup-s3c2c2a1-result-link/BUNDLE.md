# S3c-2c-2a-1 — sealed author bundle

Status: needs-review. NOT EVALUATED. Do not merge.

## Summary

Server-only explicit imaging-result/order linking is implemented on `drbang-iva/followup-s3c2c2a1-result-link`.
Base: `f1ef67991f85f69d7179f089e965b0bd03c4c3c8`; refreshed origin/main remains this base. PR #647 remains open; its index edits are outside the new route region. The PR supplies the final commit identity.
Optional capture basedOn, conditional link/unlink, and additive queue results/hints are covered by guards and persisted Medplum proof.
R1 live smoke/integration passed 12/12 and 218/218. R2 live authorization passed 78/78. All have zero failures/skips in the successful runs.
The pre-existing Binary-create authorization gap remains a separate follow-up, explicitly accepted for this slice by R2.
Independent evaluator: Claude Opus 5. No merge or self-evaluation.

## R1/R2 rulings and live proof

R1: MEDPLUM_BASE_URL must byte-match configured Medplum baseUrl. The corrected localhost:18123 run passed smoke 12/12 and integration 218/218 (wrapper exit 0). No tests were changed to accommodate hostname differences.
R2: the disposable stack moved to `http://localhost:18103/`, byte-identical to config; storageBaseUrl is `http://localhost:18103/storage/`. Port 18103 was free. Only `repair-practice-roles` received GITHUB_ACTIONS=true, as explicitly authorized; policy sync then succeeded. The live-authz invocation sourced/exported the ignored operator environment exactly as CI does: 78 tests, 78 pass, 0 fail, 0 skip, wrapper exit 0.

The proof calls actual handlers with real Medplum FHIR clients and PostgreSQL BinaryAttemptStore. It injects authenticated identities, so it proves persisted FHIR/AccessPolicy behavior, not full odos-core HTTP authentication/rate-limit middleware. G13 pins the production route/dependencies.

Identity split: all three successful uploads use a disposable project-admin ClientApplication with ProjectMembership.admin=true and no practice-role policy. The project's policy-constrained login also encountered the existing Binary 403; a separate project-admin upload identity was therefore created on this synthetic stack. Accept, queue GET, ServiceRequest reads, PDF Media read, link, unlink, signed encounter update, category-mismatch refusal, and signed-link refusal use the disposable provider client bound to the stored synced canonical provider policy with patient/provider membership parameters. Fixture setup uses the privileged operator seeder. Aggregate before/after Binary/Media counts are read directly from the disposable PostgreSQL tables because Medplum refuses Binary search with 400; no clinical business operation uses SQL.

The synthetic encounter is shaped with glaucoma + macula-retina. Synthetic fee fixtures enable #653 Accept; no clinical billing code or fee seed is changed.

Exact row/output quotes are in `live-proof.json`. The runnable proof is `live-proof.ts` (credentials come only from environment; synthetic resources only). Successful proof exit: 0.

| Step | Observed output |
|---|---|
| 1 | VF `state: already-ordered`, `result.status: interpreted`, one linked JPEG item |
| 2 before link | retina `none`, zero items, one candidate; optic nerve `for-review`, `unreviewedResult: true` |
| 2 link | retina `needs-interpretation`, one item, zero candidates; optic nerve remains `for-review`, hint omitted |
| 2 unlink | retina `none`, zero items, candidate restored; optic nerve `for-review`, hint true |
| 3 | PDF capture 200; stored Media contentType application/pdf and basedOn the VF ServiceRequest |
| 4 mismatch | provider 409, `result-order-mismatch`; Binary 8 → 8, Media 8 → 8 |
| 4 signed | provider 409, `Signed encounter cannot be edited.` |

Follow-up: **Binary-create authorization gap on main**. Production `resolveAuthenticatedStaffRoute` in payment-endpoint.ts supplies the caller bearer token as staff.binaryAuth; imaging-endpoint.ts passes it to raw Binary upload. authz/roles.ts includes Binary only in the read list and grants no role Binary create. R1 real-provider upload returned 403 before Media creation. R2 authorizes project-admin uploads for this proof; it does not repair or prove provider uploads. Policy and authentication source remain unchanged and outside §4.

Setup diagnostics retained honestly: R1 CI bootstrap refused off-CI; local repair returned User 404. R2's first authorization invocation omitted the seeder environment and failed setup, then the correctly configured invocation passed 78/78 without source/test changes. Proof-harness corrections included using the canonical NamingSystem identifier, project-admin authority for disposable-client creation, and SQL counts for unsupported Binary search. These are harness/setup corrections, not weakened production assertions.

## P1–P8 re-verification

All premises were inspected at the exact base before implementation:

- P1: capture had no basedOn or Encounter read; existing report/Media behavior confirmed.
- P2: three helpers private; completed Media query and eligibility filtering confirmed.
- P3: active ServiceRequest with code.text orderable, bodySite focus, materialized action ref confirmed.
- P4: service/staff split in readQueue and actionIds confirmed.
- P5: UI parser accepts additive fields and rejects unknown state confirmed.
- P6: route inventory 108, dependencies 50/6, UI caller inventory 59 confirmed.
- P7: derived union contains exactly the 16 specified orderable/focus keys.
- P8: existing Accept eligibility refusal is 409; added tests pin it without a lasting protocol edit.

## Tracked scope and grants

| File | Before → after |
|---|---|
| mcp/src/clinical-graph/follow-up-result-kinds.ts | absent → 16-key registry with focus fallback |
| mcp/src/clinical-graph/imaging-endpoint.ts | no order link → optional strict link, pre-upload validation, Media/report basedOn, three helper exports |
| mcp/src/clinical-graph/follow-up-queue-endpoint.ts | no result derivation → additive result/hint fields and conditional link/unlink handler |
| mcp/src/index.ts | no results route → one route block after Accept; capture block unchanged |
| mcp/tests/followUpResults.test.ts | absent → new result guards |
| mcp/tests/imagingEndpoint.test.ts | existing tests → appended capture guards only |
| mcp/tests/followUpQueueEndpoint.test.ts | unchanged |
| mcp/tests/followUpAccept.test.ts | existing tests → appended G10/G12 guards only |
| mcp/tests/findingDefinitionStore.test.ts | 108 → 109 and one comment; 50/6 unchanged |
| ui/tests/followUpQueue.test.tsx | existing tests → appended additive-payload rendering guard |
| docs/build-log/followup-s3c2c2a1-result-link/ | absent → summarized evidence |

Temporary mutation grants were restored byte-for-byte. `git diff f1ef6799 -- mcp/src/clinical-graph/protocol-endpoint.ts ui/src/lib/follow-up-queue.ts` is empty. The final committed-range diff for these two temporary-grant paths must also remain empty; verified at commit. No changes to ui/src, policy, scripts, data, billing, fee seeds, or lock acquisition.

## Full verification counts

All MCP runs used task-prefixed dedicated Postgres with ODOS_POSTGRES_URL set. Full suites used the existing package test commands.

| Command | Base | Working diff |
|---|---|---|
| npm --prefix ui test | 1844 tests, 1844 pass, 0 fail, 0 skip; exit 0 | 1845 tests, 1845 pass, 0 fail, 0 skip; exit 0 |
| npm --prefix mcp test | 6268 tests, 6213 pass, 0 fail, 55 skip; wrapper exit 1 for unconfigured live lane | with ODOS_ALLOW_UNGATED_MCP=1: 6282 tests, 6227 pass, 0 fail, 55 skip; exit 0; NOT live authorization proof |
| focused MCP | — | 79/79 |
| focused UI | — | 15/15 |

Deltas: +14 MCP tests, +1 UI test. Full logs are excluded; summary lines are in suite-summaries.json.
Commands: `npm --prefix mcp run build`, `npm --prefix ui run build`, `npm run typecheck:scripts`, `npm run preflight`.

Three checks: MCP build/typecheck exit 0 (R2 final rerun after restored G2 mutation), UI build/typecheck exit 0 (bundle size warning), scripts typecheck exit 0. Preflight: 0 warnings, 0 hard blocks, no missing FHIR read grant. git diff --check: clean.

## Guard mutations

Every row below records observed targeted test output (tests/pass/fail). Source restored before green. See suite-summaries.json for exact TAP summary lines.

- G1: **red** tests 3, pass 2, fail 1; restored **green** tests 3, pass 3, fail 0.

- G2: **red** tests 1, pass 0, fail 1; restored **green** tests 1, pass 1, fail 0.

- G3: **red** tests 1, pass 0, fail 1; restored **green** tests 1, pass 1, fail 0.

- G4: **red** tests 1, pass 0, fail 1; restored **green** tests 1, pass 1, fail 0.

- G5: **red** tests 1, pass 0, fail 1; restored **green** tests 1, pass 1, fail 0.

- G6: **red** tests 1, pass 0, fail 1; restored **green** tests 1, pass 1, fail 0.

- G7: **red** tests 1, pass 0, fail 1; restored **green** tests 1, pass 1, fail 0.

- G8: **red** tests 1, pass 0, fail 1; restored **green** tests 1, pass 1, fail 0.

- G9: **red** tests 1, pass 0, fail 1; restored **green** tests 1, pass 1, fail 0.

- G10: **red** tests 1, pass 0, fail 1; restored **green** tests 1, pass 1, fail 0.

- G11: **red** tests 1, pass 0, fail 1; restored **green** tests 1, pass 1, fail 0.

- G12a allow-any-row: **red** tests 1, pass 0, fail 1; G12b return400: **red** tests 1, pass 0, fail 1; restored **green** tests 1, pass 1, fail 0.

- G13: **red** tests 1, pass 0, fail 1; restored **green** tests 1, pass 1, fail 0.

- G14: **red** tests 1, pass 0, fail 1; restored **green** tests 1, pass 1, fail 0.

G1 selection also matched G10/G11 by name (3 tests). G8 mutation changed the query to patient AND removed defensive encounter filtering; the query-only mutation would still be defended by that filter. G2 category-comparison mutation is recorded; its separate return400 mutation also produced red: tests 1, pass 0, fail 1; restored green: tests 1, pass 1, fail 0. All G1–G14 mutation obligations are recorded, with the G8 defensive-filter detail above.

## Shutdown and follow-ups

All task containers are stopped. docker-ps-final.txt quotes the final running inventory:

```
NAMES               STATUS      PORTS
vf-prac1b-walk-db   Up 2 days   127.0.0.1:55481->5432/tcp
```

Outside §4 follow-up: a separate Binary-create authorization slice. R2 resolves this proof contract and live-authz setup; no out-of-scope source edit was made. No new design decision or Mandate 14 ledger entry was created; no new clinical code was introduced. No cross-repo edits.

Not done: UI changes; billing interpretation gate; finding-recorded tests (gonioscopy, pachymetry, dry-eye); new row state; diagnosis-center write-up; ServiceRequest completed status; tasks; DICOM; device folder-watch; legacy import.

Remaining: exact-head bot review and Claude Opus 5 independent evaluation, recorded on the PR. Full suite summaries are not a substitute for independent evaluation.

⚠️ NOT EVALUATED — hand to Claude Opus 5 for independent evaluation before merge. Codex wrote this diff and cannot evaluate it.

needs-review
