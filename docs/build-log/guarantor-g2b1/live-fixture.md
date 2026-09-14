# Disposable live fixture

This fixture supports the G-2b-1 implementation proof. It is author-side infrastructure evidence, not an independent evaluation or proof that the link operation is correct.

## Verified substrate

- Compose project: `g2b1-build-live`.
- Medplum: `5.1.30-9b1bd92`, image digest `sha256:358ab425b29390067b6cb82bfbaeee48580a703f7cc5b730bed2b2ba7184c1de`.
- Loopback ports: Medplum `28760`, PostgreSQL `28761`, Redis `28762`; `28763` and `28764` were checked free and reserved for the application and browser proof.
- Separate Docker subnet `10.249.60.0/24`, checked against existing Docker networks. Docker's default address pools were exhausted; no existing network was altered.
- The initial seed was killed by the shared Docker VM's memory pressure. This fixture alone uses a 384 MiB Node heap and a 768 MiB container limit. Initialization then completed and health reports PostgreSQL and Redis available.
- Two synthetic practice Projects and the separate bootstrap service Project all lack `transaction-bundles`.
- The service is the real server-configured ODOS service account. The staff principals are actual Practitioner users, with one staff membership and one provider/staff/admin composite membership; neither is a project administrator.

The bootstrap created canonical baseline policies at `a13fc1ea6322d29fa38216fbc06d03dffd079175`. The repository's `scripts/sync-practice-role-policy-rules.ts` then applied policy contribution `d0cb07d81f22624f7c616105222271f3bcb8f759`: two policies and one composite membership updated. No S8 expression was constructed in probe memory. Both users authenticated through the real `authenticateStaffRoute()` and received `guarantor.link`.

## Evidence and limits

| Artifact | What it establishes |
|---|---|
| `live-runtime.json` | Image, base head, and live health |
| `live-bootstrap-http.json` | Synthetic resource creation and conditional membership writes |
| `live-policy-sync.json` | Actual repository sync command and output at the policy SHA |
| `live-fixture-state.json` | Fresh Project features, membership bindings, Person/Task policy rules |
| `live-staff-auth.json` | Actual route-authentication results for both users |
| `live-membership-compartments.json`, `live-membership-http.json` | Both memberships read and conditionally update RelatedPersons for two distinct patients; four PUTs returned 200 |
| `live-audit-bootstrap.json` | A `noop` row persisted through the real audit runtime and was read back |
| `live-audit-schema-tests.json` | Six existing schema tests executed against disposable databases on this fixture's PostgreSQL |

The schema test result is **2 passed, 4 failed, 0 skipped** at the policy SHA. The runtime event-type manifest test passes. Each failure is the unchanged test's expected ledger list omitting `2026-09-14-guarantor-link-events.sql` and its validation file. No existing test was edited in this contribution.

AccessPolicy trace bodies retain only Person/Task rules and a digest of the full resource. Authentication request/response bodies are omitted. Tokens, passwords, signing material, and database URLs remain in the gitignored private directory with restricted permissions. A second pass removes known secret values from serialized evidence and replaces workstation paths with placeholders.

This bootstrap does not satisfy the operation concurrency schedules, browser proof, or all L17/L18 cases. Run those against the final integrated source and resync its policies before claiming final-head live proof.

## Run and reuse

The helper runs from the checkout containing this file and uses its root `tsx` dependency. On a fresh fixture, run these commands in order:

```sh
node --import tsx docs/build-log/guarantor-g2b1/live-fixture.mjs up
node --import tsx docs/build-log/guarantor-g2b1/live-fixture.mjs seed
node --import tsx docs/build-log/guarantor-g2b1/live-fixture.mjs sync
node --import tsx docs/build-log/guarantor-g2b1/live-fixture.mjs auth-smoke
node --import tsx docs/build-log/guarantor-g2b1/live-fixture.mjs audit-smoke
```

`up` refuses to overwrite an existing fixture. `start` starts only this named Compose project. `status` performs fresh health, Project, membership, and policy reads. `schema-check` executes the existing live audit schema file using unique disposable databases. It currently exits nonzero for the recorded fixture-list failures.

For the retained fixture, set `G2B1_LIVE_DIR` to its absolute `.odos/g2b1-build-live` path and `G2B1_SOURCE_ROOT` to the final implementation checkout. `G2B1_EVIDENCE_DIR` chooses the receiving evidence directory. No credential is supplied on a command line.

The module exports `loadPrivateFixture`, `refreshFixtureTokens`, `http`, `successfulHttp`, `grantPatients`, `createLiveClients`, `saveHttpTrace`, and `writeEvidence` for operation schedules. `createLiveClients` returns the real audited service FHIR client and audit runtime; close the audit runtime after each schedule. `grantPatients` changes only an explicitly named synthetic staff membership and preserves its policy selection. Existing unexpired tokens are reused to respect the fixture login limit; `sync` gets fresh staff sessions after updating policies.

The round-5 contract instruments were read for API context. None were copied into this helper. Shared application code, existing tests, lab code, and other agents' services were not changed.
