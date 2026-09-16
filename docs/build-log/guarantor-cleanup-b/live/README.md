# Cleanup B R1 live policy proof — 2575055875bb7d7590c572025f62da8a5565d030

Synthetic local Medplum 5.1.8 only. Compose project `odos-cleanup-b-live` at `127.0.0.1:18103`, with separate project-scoped Postgres/Redis/binary volumes and Postgres/Redis loopback ports 25432/26379. The fixture worktree and disposable mutation worktree were both detached at the exact SHA above. No application changes or commits were made in the fixture worktree.

The base bootstrap at `0255cc5ba1d8e097ee5b129c3219e7030fd49802` passed `test:live-integration` (12/12 bootstrap plus 218/218 remaining, no skips), then operator identity, role repair, and initial policy sync. Its `test:live-authz` passed 59/59 with no skips.

At `25750558`, the initial policy dry run found one stale Staff `Basic` create/update grant for the coded age-of-majority singleton. A disposable Provider+Staff composite policy was then seeded from the mutant canonical policy writer, with a JSON roundtrip, to exercise the no-Admin composite case. The exact dry run in `policy-dry-run-staff-and-noadmin-composite-25750558.txt` showed Staff's combined create/update rule and the Provider+Staff composite's separate create and update rules as unexpected. Provider, Admin, and Provider+Staff+Admin matched; Admin's grant remains valid through its explicit rule.

The repository's CI-style `--bootstrap-service-identity` apply refused the stale Staff AccessPolicy PATCH with HTTP 403 and zero updates. The separate operator seeder can read and write AccessPolicy but receives HTTP 403 for ProjectMembership reads, so the unmodified sync CLI cannot perform this post-repair update by itself. The task-only adapter read both resource types with the admin session, then used the operator seeder token for conditional FHIR PATCH of `/resource` on only the two drifted AccessPolicies. It refused policy creation, membership writes, and any other policy drift. The canonical apply updated exactly two policies; a subsequent dry run reported all five policies MATCH and zero membership drift. This fixture adaptation is evidence for the synthetic proof, not a production migration path.

The full canonical `test:live-authz` passed 65/65, zero failures/skips. In the disposable mutation worktree, the age-of-majority write rule was restored to the shared scheduling rules, and its duplicate explicit Admin entry was removed so Admin's effective grant stayed the same. The mutant policy apply updated Staff and Provider+Staff only. The full live suite then failed as intended: 65 tests, 61 pass, 4 TAP failures (two direct Staff assertions plus their parent subtests), zero skips. Staff create returned HTTP 201 instead of expected 403; Staff update returned HTTP 200 instead of expected 403. Provider and Admin subtests passed. The exact mutant diff and TAP output are saved here.

The mutation source was restored; `git status --short` in the mutation worktree was empty. Original `25750558` policies were reapplied, exactly two policy updates. The post-restore dry run reported all five policies MATCH, zero membership drift, and the full live suite passed 65/65, zero failures/skips. The synthetic stack is healthy and remains running for final-head proof.

## Evidence

- `policy-dry-run-25750558.txt`: initial Staff-only drift.
- `policy-dry-run-staff-and-noadmin-composite-25750558.txt`: exact Staff and no-Admin composite diff.
- `policy-apply-ci-bootstrap-403-25750558.txt` and `policy-dry-run-seeder-403-25750558.txt`: constrained identity limits.
- `policy-apply-canonical-25750558.txt` and `policy-after-canonical-25750558.txt`: canonical apply and MATCH verification.
- `live-authz-canonical-25750558.txt`: first GREEN.
- `R1-live-mutant.diff`, `policy-dry-run-mutant-25750558.txt`, `policy-apply-mutant-25750558.txt`, `live-authz-mutant-25750558.txt`: mutation and RED.
- `policy-apply-restored-25750558.txt`, `policy-after-restored-25750558.txt`, `live-authz-restored-25750558.txt`: restoration and GREEN.
- `sync-policy-hybrid.mjs`, `run-policy-hybrid.sh`: task-only reproducibility adapter; credentials are supplied through ignored local env files and never embedded. The adapter calls the repository `LivePracticeRolePolicyRuleSyncAdapter.patchPolicy`, which sets `If-Match: W/"<versionId>"` on each FHIR PATCH. The evidence wrapper takes target checkout, `dry-run` or `apply`, and the original synthetic fixture checkout path as its three arguments.

All text logs in this directory were scanned for the local admin password and operator client secret; no matches. The credential-bearing env files remain ignored, mode 0600, under the fixture worktree's `.odos/` directory.

Safe final-head suite invocation (replace target checkout):

```bash
/Users/ericr.bang/GitHub/ODOS2020/.worktrees/guarantor-cleanup-b-live/.odos/cleanup-b/run-live-authz.sh /ABSOLUTE/TARGET/CHECKOUT
```
