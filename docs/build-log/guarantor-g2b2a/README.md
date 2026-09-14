# Guarantor G-2b-2a — author evidence, NOT EVALUATED

Staff can search existing guarantors, move this patient's responsible-party link, join duplicate guarantor records by choosing the survivor, and undo a completed operation from history. New guarantors are created before the zero-write draft; the Person id is reused after a stale confirmation. The confirmation names affected patients and requires a reason.

## Boundaries and promises

- Orphan zero-link Persons are possible after cancellation, a refused draft or an unknown creation response. Search excludes them; no sweep is implemented.
- History considers only the 50 most recently updated guarantor operations practice-wide. Older Tasks remain and the correct endpoint remains available.
- This is A1–A5 only. No attach/unlink, registration, insurance, statements, comms, transaction-bundles, Run, validate, record, role-policy expression, editor save/repair or pending-button change.
- The UUID mechanic is extracted from the existing correct client for its second caller, without changing Correct's request behavior. The 23 shipped UI guarantor tests remain green.
- Existing test edits are solely the two assertions of the same service-write count, 37 to 38, in the contract-named test file.
- PerformanceOD is read-only. No new architecture decision, INDEX change, clinical code, or audit event type was added.

## Evidence

- `mandate14.md`, `person-name-searchparameter.json`, `e1-http.json`: E1 supports name narrowing by family and given, case-insensitive prefixes in the tested cases.
- `guard-table.md`, `mutations/`: 19 named mutation variants plus K10 skip-draft, registry deletion, and the review-added empty-draft guard, with failing test names and restored results. K6's prescribed route-only control is explicitly decorative; its real revoked-membership behavior is proved separately.
- `live-proof.json`, `live-fhir-http.json`: real HTTP K1–K7 on the disposable pinned server, two Projects, actual service identity and synced staff policies; no transaction-bundles.
- `final-browser/live-proof.json`: current source hashes, actual patient-route Chromium Move existing, Move new, Join keeping found, stale confirmation, and history Undo. Screenshots are in the same directory. The source hashes bind the proof to application bytes even when later commits contain only evidence.
- `final-browser/live-fhir-http.json`: fresh FHIR re-reads. L7: six protected-field comparisons across four distinct minor children (including both Join children again after Undo). Uses shipped consent/primary/court-order keys and contrasting active values. L9: one real competing RelatedPerson edit, 409, exactly one create call, explicit Review again.
- `canonical-sentinels/`: earlier corroborating browser pass with the same canonical sentinel keys. Top-level screenshots are an earlier pass and supplemental only; final-browser is primary.

## Checks

Baseline: MCP 4798 total / 4732 pass / 6 fail / 60 skip; UI 1500 pass; preflight zero warnings/blocks.

Current recorded full run: MCP 4810 total / 4744 pass / the same 6 fail / 60 skip. All failures are claimReadModelStore.test.ts hooks: ECONNREFUSED 127.0.0.1:5433. UI 1513 pass / 0 fail / 0 skip. UI build and MCP build pass. Registry tests 14 pass. Focused UI 36 pass (23 shipped + 13 new); backend additions now 13 pass (including the review-added empty-draft guard). Proxy census: all 25 backend route families have entries among 28 proxies (advisory).

Named shipped baselines remain operation 38, routes 2, policy 5, Person 11, editor 9 and UI operations 14. No existing body was altered to obtain those results. CI and final-head bot status are reported in the PR; no independent evaluator marker is posted by the author.

## Canon sentences that will go stale on merge

The read-only kickoff's status says this slice is READY FOR CODEX and describes the build in future tense. The contract-owning Claude session should update its status and index after merge; this author has not changed PerformanceOD. The shipped engine contract's statement that G-2b-2 is next also needs a scope-aware update distinguishing 2a from unbuilt 2b.

## Remaining review

NOT EVALUATED. A separate Claude session must independently evaluate the final head before merge. K6's route-only mutation limitation is specifically called out, not disguised as a demonstrated red. Unit transport fixtures do not establish policy enforcement; the real server captures supply that evidence. Synthetic fixture lifecycle status is recorded in the delivery bundle.

## Bot review fixback

CodeRabbit reproduced an empty consolidation draft returning 200 despite the shipped create schema refusing its empty child list. The new draft branch now refuses 422 with the shipped input-error message; Run/validate/record and shipped handlers are unchanged. The added test failed 200 versus 422 before the fix, then passed; deleting the new check produced red again, and restoration passed all 13 backend additions. All five Chromium flows were rerun against the resulting application bytes. E1 now asserts every case is HTTP 200 and was rerun successfully. Committed TAP evidence paths are repository-relative; only path prefixes were normalized, preserving prior outcomes.

The suggested non-409 draft retry and resetting the A2 attempt are not adopted: revision 2 explicitly permits a refused-draft orphan and forbids a second A2 within a move. The suggested persistent retry identifiers are deferred: uncertain-write replay is not promised by A5, and the shipped correction client behavior is preserved. Staff must reload an uncertain operation result; no automatic retry is introduced. These scope dispositions are recorded on the PR for the independent evaluator.
