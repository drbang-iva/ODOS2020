# Disposable CL-A bootstrap

Compose project: `guarantor-cleanup-a-live`; private Docker subnet `10.249.61.0/24` was absent from Docker network inventory before startup. All six loopback ports were free (lsof plus helper bind check).

Ports: Medplum 28860, PostgreSQL 28861, Redis 28862. Ports reserved for parent proof: ODOS 28863, UI 28864, proof 28865.

Helper copied from `docs/build-log/guarantor-g2b1/live-fixture.mjs`, with isolated project, port, subnet, environment-variable names, private/evidence paths and source-root changes. Source runtime resolves to sibling `guarantor-cleanup-a` worktree. Each endpoint is synthetic loopback only. No Iris or other fixture was modified.

Executed with `node --import tsx docs/build-log/guarantor-cleanup-a/live/live-fixture.mjs <action>`:

- `up`: exit 0, Medplum 5.1.30-9b1bd92 healthy; PostgreSQL and Redis healthy.
- `seed`: exit 0, three projects including service project; staff and composite principals.
- `sync`: canonical sync process exit 0 and policies applied. The helper's final token refresh then hit Medplum's five-login/minute rate limit (429). Waited 55 seconds; subsequent auth and status commands passed. No policy workaround.
- `auth-smoke`: exit 0, 2 authenticated principals, both with guarantor.link.
- `audit-smoke`: exit 0, one noop audit row persisted.
- `status`: exit 0.
- `schema-check`: exit 0, 6 tests passed, 0 failed, 0 skipped against this fixture only.

Private fixture files remain in the UI worktree `.odos/guarantor-cleanup-a-live` (not committed). When importing the cherry-picked helper from another worktree, set `GUARANTOR_CLEANUP_A_LIVE_DIR` to that existing private directory, and optionally set `GUARANTOR_CLEANUP_A_EVIDENCE_DIR` for parent proof output. Do not invoke `up` again.

Containers left running for parent proof as requested. Parent stops (does not remove) them at final delivery. This is author bootstrap evidence, not an independent evaluation or an operation-level live proof.
