# G-2b-1 guard evidence

Author proof at application head `82fc66de6cb04f74bcbbe7805c7934c934f932e6`. All 81 local controls below were green, red after the named mutation, and green after restoration. Detailed counts, source hashes and failures are in [guard-results.json](guard-results.json); actual command output is in [guard-transcripts.txt](guard-transcripts.txt). The core runner is [mutate-guards.py](mutate-guards.py), which changes only its disposable source copy. [UI review evidence](ui-review/README.md) retains the two additional regressions and three controls.

Browser controls and actual policy-engine controls are separate: [browser/browser-mutations.json](browser/browser-mutations.json), [live-policy-proof.md](live-policy-proof.md). Neither a fake FHIR store nor a green unit suite is presented as policy or route proof.

| Lane / removed guard | Green / red / restored exit | Failing test or enforced check |
|---|---|---|
| core-and-registries / S9-transaction-resource-reference | 0 / 1 / 0 | S9 transaction reasons omit an unassigned Task id and retain assigned resource references |
| core-and-registries / L1-claim-required | 0 / 1 / 0 | L1: two admitted starters produce one source detach and one completed operation |
| core-and-registries / L2-sorted-claims | 0 / 1 / 0 | L2: sorted claims give a winner with two shared children and opposed request orders |
| core-and-registries / L3a-pending-after-detach | 0 / 1 / 0 | L3: detach-first leaves an unowned claimed child and Complete projects current D |
| core-and-registries / L3b-detach-first | 0 / 1 / 0 | L3: detach-first leaves an unowned claimed child and Complete projects current D |
| core-and-registries / L5-generation | 0 / 1 / 0 | L5: D changes after r1 projection so no stale r2 projection is submitted |
| core-and-registries / L6-destination-details | 0 / 1 / 0 | L6/L7/L8: consolidate retains S, D wins, moved child fields and write set are fenced |
| core-and-registries / L6-retain-source | 0 / 1 / 0 | L6/L7/L8: consolidate retains S, D wins, moved child fields and write set are fenced |
| core-and-registries / L7-child-extension-fence | 0 / 1 / 0 | L6/L7/L8: consolidate retains S, D wins, moved child fields and write set are fenced |
| core-and-registries / L7-child-active-fence | 0 / 1 / 0 | L6/L7/L8: consolidate retains S, D wins, moved child fields and write set are fenced |
| core-and-registries / L8-write-set | 0 / 1 / 0 | L6/L7/L8: consolidate retains S, D wins, moved child fields and write set are fenced |
| core-and-registries / L9-expected-version | 0 / 1 / 0 | L9: stale confirmation refuses before any Task or resource write |
| core-and-registries / L10-complete-consolidation-set | 0 / 1 / 0 | L10: consolidate subset refuses before any write |
| core-and-registries / L11-practice-scope | 0 / 1 / 0 | L11: foreign D and separately foreign child Patient refuse without writes |
| core-and-registries / L12-landed-intent | 0 / 1 / 0 | L12/L14: landed and unsent detach intents use the expected-version fence classifier |
| core-and-registries / L13-interference | 0 / 1 / 0 | L13: an unresolved changed child intent is interference with no further domain writes |
| core-and-registries / L14a-full-old-comparator | 0 / 1 / 0 | L12/L14: landed and unsent detach intents use the expected-version fence classifier |
| core-and-registries / L14b-epoch-in-comparison | 0 / 1 / 0 | L12/L14: landed and unsent detach intents use the expected-version fence classifier |
| core-and-registries / L14c-classify-before-fence | 0 / 1 / 0 | L12/L14: landed and unsent detach intents use the expected-version fence classifier |
| core-and-registries / L15a-person-fence | 0 / 1 / 0 | L15: correction fences a paused Complete before its already-intended destination PUT |
| core-and-registries / L15b-cancel-last | 0 / 1 / 0 | L15/L24a/L25: partial takeover fails while original stays live and descends the orphaned claim |
| core-and-registries / L15-fresh-retry-correction-check | 0 / 1 / 0 | L15 pre-takeover retry: the correction record stops a fresh retry even before its first claim lands |
| core-and-registries / L16-release-required | 0 / 1 / 0 | L16/L20: another claim or name edit after verification refuses release and completion audit |
| core-and-registries / L17-moved-set-binding | 0 / 1 / 0 | L17: a genuine claim copied to an unlisted child is inert; an untrusted Task needs no readable plan |
| core-and-registries / L19-action-required | 0 / 1 / 0 | L19: a revoked business action refuses before any read or write |
| core-and-registries / L20-completed-audit-after-release | 0 / 1 / 0 | L16/L20: another claim or name edit after verification refuses release and completion audit |
| core-and-registries / L21-idempotency | 0 / 1 / 0 | L21: repeated operation identifier returns one Task and performs no second writes |
| core-and-registries / L24-code-filter | 0 / 1 / 0 | L24 step 0: foreign-code based-on lab Tasks and foreign-author operations are excluded |
| core-and-registries / L24-service-authorship | 0 / 1 / 0 | L24 step 0: foreign-code based-on lab Tasks and foreign-author operations are excluded |
| core-and-registries / L24a-claim-descent | 0 / 1 / 0 | L15/L24a/L25: partial takeover fails while original stays live and descends the orphaned claim |
| core-and-registries / L24b-step-zero-before-writes | 0 / 1 / 0 | L24b: a live service-authored correction stops Complete before every write |
| core-and-registries / L24c-completed-correction | 0 / 1 / 0 | L24c: completed correction causes one cancel attempt, never an attempted fence intent |
| core-and-registries / L25-live-correction-never-self-cancels | 0 / 1 / 0 | L15/L24a/L25: partial takeover fails while original stays live and descends the orphaned claim |
| core-and-registries / L26-correction-detaches-current-owner | 0 / 1 / 0 | L26: pending Correct detaches a landed attachment before returning children to retained S |
| core-and-registries / L27-terminal-rule-at-ownership-check | 0 / 1 / 0 | L27/L29: one or two descent refusals resolve each intent; a later Complete is live |
| core-and-registries / L28-reclaim-checkpointed-claim | 0 / 1 / 0 | L28: a missing checkpointed claim is reclaimed only on an unowned child without another live claim |
| core-and-registries / L29-definite-response-intent-rule | 0 / 1 / 0 | L27/L29: one or two descent refusals resolve each intent; a later Complete is live; L29: double re-claim refusals and a lost successful descent retry remain resumable; S3 intent rule: a definite server error is rejected history, not an unresolved response |
| core-and-registries / S6-cancel-attempt-bound | 0 / 1 / 0 | S6 bounded cancellation: three fresh versions and intents, then pending; later Complete finishes |
| core-and-registries / S6-pending-takeover-prefix | 0 / 1 / 0 | S6 crash prefix: Complete finishes a partial takeover after a lost or unsent claim response |
| core-and-registries / S3-post-release-activity | 0 / 1 / 0 | S3 released children: Complete preserves later transfers after partial release or an unsent terminal write |
| core-and-registries / S3-no-checkpoint-replay | 0 / 1 / 0 | S3 checkpoint refusal stops immediately without replaying a stale Task version |
| core-and-registries / S5-fresh-claim-classification | 0 / 1 / 0 | S5 retry classification: a fresh foreign live claim stops a recovery Person retry |
| core-and-registries / S3-terminal-journal-checkpoint | 0 / 1 / 0 | L15: correction fences a paused Complete before its already-intended destination PUT |
| core-and-registries / S3-terminal-response-stops-runner | 0 / 1 / 0 | S3 late successful release checkpoints its result without completing or auditing twice |
| core-and-registries / S3-terminal-checkpoint-refusal | 0 / 1 / 0 | S3 terminal response checkpoint refusal is reported and never replayed |
| core-and-registries / S1-rate-limit | 0 / 1 / 0 | S1 rate limit: all five routes share a budget before service or staff authentication |
| core-and-registries / Registry-service-write | 0 / 1 / 0 | preflight: missing exact registered entry |
| core-and-registries / Registry-audit-event | 0 / 1 / 0 | the latest audit migration pair matches the TypeScript union and separates validation |
| core-and-registries / Registry-canonical-extension | 0 / 1 / 0 | preflight: canonical extension missing from registry |
| policy-audit-client / L17-task-fence-removed | 0 / 1 / 0 | L17 staff: the Task fence refuses operation creation, mutation and code laundering; L17 composite: the Task fence refuses operation creation, mutation and code laundering |
| policy-audit-client / L18-person-fence-removed | 0 / 1 / 0 | L18 staff: the Person fence preserves name edits and refuses link mutations; L18 composite: the Person fence preserves name edits and refuses link mutations; P7 declaration: staff Person writes are practice-scoped create/update only |
| policy-audit-client / L18-revision1-empty-link-refusal | 0 / 1 / 0 | L18 staff: the Person fence preserves name edits and refuses link mutations; L18 composite: the Person fence preserves name edits and refuses link mutations; P7 declaration: staff Person writes are practice-scoped create/update only |
| policy-audit-client / L19-action-added-to-baseline | 0 / 1 / 0 | the baseline is the explicit eight-action intersection of the three role declarations; L19: each role grants guarantor.link and a membership revocation removes it |
| policy-audit-client / S9-typescript-event-started-removed | 0 / 1 / 0 | S9: guarantor.link.started produces a patient-attributed audit row and projection; the latest audit migration pair matches the TypeScript union and separates validation |
| policy-audit-client / S9-sql-event-started-removed | 0 / 1 / 0 | the latest audit migration pair matches the TypeScript union and separates validation |
| policy-audit-client / S9-typescript-event-completed-removed | 0 / 1 / 0 | S9: guarantor.link.completed produces a patient-attributed audit row and projection; the latest audit migration pair matches the TypeScript union and separates validation |
| policy-audit-client / S9-sql-event-completed-removed | 0 / 1 / 0 | the latest audit migration pair matches the TypeScript union and separates validation |
| policy-audit-client / S9-typescript-event-pending-removed | 0 / 1 / 0 | S9: guarantor.link.pending produces a patient-attributed audit row and projection; the latest audit migration pair matches the TypeScript union and separates validation |
| policy-audit-client / S9-sql-event-pending-removed | 0 / 1 / 0 | the latest audit migration pair matches the TypeScript union and separates validation |
| policy-audit-client / S9-typescript-event-failed-removed | 0 / 1 / 0 | S9: guarantor.link.failed produces a patient-attributed audit row and projection; the latest audit migration pair matches the TypeScript union and separates validation |
| policy-audit-client / S9-sql-event-failed-removed | 0 / 1 / 0 | the latest audit migration pair matches the TypeScript union and separates validation |
| policy-audit-client / S9-typescript-event-interfered-removed | 0 / 1 / 0 | S9: guarantor.link.interfered produces a patient-attributed audit row and projection; the latest audit migration pair matches the TypeScript union and separates validation |
| policy-audit-client / S9-sql-event-interfered-removed | 0 / 1 / 0 | the latest audit migration pair matches the TypeScript union and separates validation |
| policy-audit-client / S9-runtime-migration-removed | 0 / 1 / 0 | the latest audit migration pair matches the TypeScript union and separates validation |
| policy-audit-client / S9-runtime-validation-removed | 0 / 1 / 0 | the latest audit migration pair matches the TypeScript union and separates validation |
| policy-audit-client / extended-header-removed | 0 / 1 / 0 | extended read requests author and project metadata while ordinary reads keep their header behavior |
| policy-audit-client / profile-returned-as-wrong-identity | 0 / 1 / 0 | authenticated profile reference comes from the current session for client and practitioner identities |
| scanner / service-annotation-discovery-removed | 0 / 1 / 0 | a service-write annotation scans the actual attributed transaction once per resource type; annotated transactions need exact service registry entries despite existing staff write grants; an annotated transaction registry entry remains bound to path, line, callee and resource type; a service-write annotation stays on its statement and does not annotate later calls; malformed service transaction annotations fail instead of dropping declared resource types |
| scanner / service-exact-registration-requirement-removed | 0 / 1 / 0 | annotated transactions need exact service registry entries despite existing staff write grants |
| scanner / service-resource-type-binding-removed | 0 / 1 / 0 | annotated transactions need exact service registry entries despite existing staff write grants; an annotated transaction registry entry remains bound to path, line, callee and resource type |
| editor / l3-pending-before-missing | 0 / 1 / 0 | L3 S7: unowned claimed child is pending, names every patient, and Complete reloads the editor |
| editor / l4-repair-claim-check | 0 / 1 / 0 | L4 S7: Repair sees a claim in its fresh read and submits no child PUT |
| editor / save-claim-check | 0 / 1 / 0 | S7: Save fresh-checks claims after the Person save and stops every remaining child |
| editor / save-loaded-version | 0 / 1 / 0 | S7: Save keeps the loaded child version after its fresh claim-only read |
| editor / copied-claim-membership | 0 / 1 / 0 | S7: inert, missing, and copied claims do not suppress ordinary classification |
| editor / pending-complete-wiring | 0 / 1 / 0 | L3 S7: unowned claimed child is pending, names every patient, and Complete reloads the editor |
| editor / pending-correct-wiring | 0 / 1 / 0 | S7: Correct requires a reason, sends one new operation id, and reloads after a refusal |
| editor / l23-drift-classification | 0 / 1 / 0 | L23 S7: an edit after release is ordinary drift and Repair converges to current D |
| editor / review-matching-claim-shortcut | 0 / 1 / 0 | S7: Repair stops at a newly claimed matching child before repairing a mismatched sibling |
| editor / review-draft-task-reset | 0 / 1 / 0 | S7: a correction reason survives same-Task refusal and clears when another Task takes over |
| editor / review-draft-same-task-preservation | 0 / 1 / 0 | S7: a correction reason survives same-Task refusal and clears when another Task takes over |

## Contract cases and limits

- L1–L21 and L24–L29 use the named persistent-state and transport-list guards above. L4 is the S7 fresh-read repair guard. L17 includes both service trust/moved-set guards and the live Task fence. L18 is the live Person fence. L7 also executes the actual statement recipient and consent-guardian readers before and after a transfer.
- L22 is the contract's explicitly non-mutation/decorative insurance regression: the existing write handler still refuses a moved RelatedPerson as a Coverage subscriber with 422. Its existing insurance handler is unchanged.
- L23's post-verification D edit is documented later drift, as the contract specifies. The editor classification/repair control is red when mismatch detection is removed; the child-after-verification race is guarded separately by L16.
- L26 detach removal is red because the operation refuses the still-owned child; the additional ownership guard prevents two owners. Both detach paths must be removed for the intended control; removing only one would leave the other active. The evidence does not claim that this mutant produces two owners.
- L5 asserts the absence of the stale r2 write. Task status alone would be decorative. L24(c) asserts the kind of attempted Task write, not merely its count.
- Source provenance for contribution-lane controls is retained. Policy, audit, client, final editor and component contribution bytes match the integrated application. Scanner registration line-number updates are separately guarded by the integrated preflight deletion control.
- The Mandate 14 ledger is documentary evidence, not an enforced registry. The service-write registry, migration event set and canonical extension registry each have an executed deletion control.
