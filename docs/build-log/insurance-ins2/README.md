# Insurance subscriber isolation — author evidence

NOT EVALUATED. Merge before INS-1.

Base: `33f68adfa841e9122c2228c974b6ec7cf08d0f09`. Branch: `drbang-iva/insurance-ins2`.
The premise diff against origin/main was empty and all three code anchors matched. No open PRs overlapped when work began.

## Change

The insurance reuse list excludes RelatedPersons carrying either registration role extension, regardless of the extension's boolean value. Saving a legacy Coverage linked to a guardian creates a subscriber-only RelatedPerson and redirects that Coverage to it. The new subscriber has its own identity, is active, and receives only subscriber fields; no guardian metadata, roles, phone or period are copied. Existing subscriber-only updates retain their active value and version precondition. Coverage activity continues to control Coverage. An unloaded or mismatched RelatedPerson reference refuses the save with the required reload message, before emitting any bundle.

## Files and checks

- `ui/src/lib/patient-insurance.ts`: shared guardian predicate, copy boundary, unloaded-reference refusal, independent subscriber activity.
- `ui/src/scenes/insurance/PatientInsurance.tsx`: reuse-list filter using that predicate.
- `ui/tests/patientInsurance.test.tsx`: five appended guards; every original test body byte-equivalent to base.
- `ui/tests/fixtures/insurance-ins2-live.{html,tsx}`: production PatientInsurance mounting fixture for the browser proof.
- This directory: command output, mutation runner, reproduction instruments, synthetic request/read captures and screenshots.

| Command | Baseline | Final |
|---|---:|---:|
| `npm --prefix ui test` | 1,480 pass / 0 fail | 1,485 pass / 0 fail |
| `cd ui && node --import tsx --test tests/patientInsurance.test.tsx` | 10 pass / 0 fail | 15 pass / 0 fail |
| `npm --prefix ui run build` | not required | exit 0; TypeScript and Vite build succeed |
| Proxy census | not required | 24 backend route families; all covered; advisory |

The Vite build reports its existing large-chunk warning. `npm ci` completed in isolated UI and MCP directories; UI audit reported zero vulnerabilities, MCP reported 7 moderate and 2 high. No dependency changes were made. No source/config/test under `mcp/` differs from base; no claims, eligibility, guarantor, statements, or communications implementation changed.

## Mandate 17

All five guards first failed against the unchanged base (10 existing tests passed, 5 new tests failed). Each mutation below then ran separately against green code and was restored before the next. All restored runs: 15 pass, 0 fail. No guard was decorative.

| Guard and failing test name | Deliberate break | Green | Red | Restored |
|---|---|---:|---:|---:|
| INS2 U1 reuse offers only subscriber-only records | Remove reuse filter | pass | fail | pass |
| INS2 U2 legacy guardian subscriber becomes a new record without a guardian write | Allow guardian into existing-subscriber PUT | pass | fail | pass |
| INS2 U3 subscriber activity is independent of Coverage activity | Restore `active: draft.active` | pass | fail | pass |
| INS2 U4 unloaded or mismatched subscriber refuses to emit a bundle | Replace refusal with unversioned PUT emission | pass | fail | pass |
| INS2 U5 primary extension alone excludes reuse and prevents guardian writes | Recognize consent-authority only | pass | fail | pass |

`guards/mutations.json` records each failing test, exit code and restored outcome. U3 covers stored false, true and absent activity. U4 includes an absent loaded record and a different loaded record. U5 uses the primary extension with value false, proving classification depends on presence.

## Real-server result

A new Docker project, volume and loopback server at `127.0.0.1:19713` were created for this task. Health reports Medplum `5.1.30-9b1bd92`; project features are empty, so `transaction-bundles` is absent. No existing stack/database was modified. The staff user is a disposable Practitioner, bound using `buildProjectMembershipAccess` to `buildMedplumAccessPolicy(getRoleDeclaration('staff'))` without changing the declaration. The captured staff policy is in each JSON result.

The instrument mounts the production PatientInsurance screen and uses its actual HTTP client through the production `registerPatientInsuranceRoutes`, handlers, `authenticateStaffRoute`, and staff FHIR client. It does not intercept or replace the insurance response. Audit rows are collected by the proof server locally. This is an isolated route composition, not a full odos-core process boot or whole-App navigation proof. Base and fixed UI sources run from separate worktrees on ports 19709 and 19710, proxying the same proof route process on 19711. Both use the production build's compiled stylesheet; no CSS source is changed. Viewport: 1440×1200.

| Scenario | Save | Fresh guardian GET | Coverage subscriber |
|---|---|---|---|
| Base: add Coverage, reuse guardian, edit subscriber name/address, uncheck Active | 200 | Version changed, active false, name Insurance, address 2 Subscriber Way | Original guardian |
| Fixed: edit a seeded legacy Coverage referencing a fresh guardian; same subscriber edits and inactive Coverage | 200 | Serialized JSON byte-identical, same version, active true | Newly created active subscriber with typed details |

The fixed bundle has POST RelatedPerson with a urn:uuid fullUrl, Coverage.subscriber references that urn, and zero entries targeting the guardian id. Fresh reads confirm the resolved new subscriber reference. Its guardian extensions, telecom and period are absent; the original guardian retains all of them. The real `resolveSmsNumber` returns `864-555-0101` from the untouched guardian. That resolver also returns the phone on the inactive base record; this proof does not claim it implements the upstream active-recipient filter. Statements and Engage recipient selection were not exercised.

The fixed UI cannot reuse a guardian; the legacy-edit scenario exercises S2 while the option inventory verifies S1. Each scenario receives fresh, equivalent synthetic records rather than repairing the damaged base guardian.

See `live/base.json`, `live/fixed.json`, and corresponding editor/saved PNGs. These are author evidence, not an independent verdict.

## Reproduction

Install locked MCP and UI dependencies. Build UI. Create a detached base worktree at `/private/tmp/odos-ins2-base` at the base SHA, install its UI dependencies, and copy the two insurance fixture files into its `ui/tests/fixtures/` directory. Copy `live/reproduction/*` into ignored `.odos/insurance-ins2/`, dropping `.txt` suffixes.

On unused loopback ports, run `node .odos/insurance-ins2/provision.mjs`, then `docker-compose -f .odos/insurance-ins2/compose.json up -d`. The provisioner generates private local configuration and bootstrap credentials; do not commit those outputs. Wait for `/healthcheck` to report the pinned version. Run setup.ts and staff.ts with `./mcp/node_modules/.bin/tsx`. Start serve.ts with that same runner, and vite.mjs with plain Node. Run live.ts base. Run setup.ts and staff.ts again for fresh synthetic records, then live.ts fixed. All entrypoints assert the exact disposable loopback URL. Provisioning is for a fresh volume, not a reset of existing data.

To repeat guards, copy `guards/mutations.py.txt` to ignored local storage and run from the worktree root with Python 3. It restores production files in a finally block. Do not run mutations concurrently with regressions or live proof.

## Follow-ups and limits

- INS-1 supplies the independent server-side fence and honest failed-save handling. This UI change does not prevent old clients or API callers from writing a guardian. Merge before INS-1.
- Historical damage is not repaired here. A read-only census can page `GET /fhir/R4/Coverage?_count=100`, follow every Bundle next link, collect distinct `subscriber.reference` values naming RelatedPerson, then `GET /fhir/R4/RelatedPerson/{id}`. Classify guardians by either exported registration-role constant, and report linked Coverage ids, guardian id/version, active value, and current name/address for local operator review. Include missing/unreadable references explicitly. For suspected overwrites, inspect `GET /fhir/R4/RelatedPerson/{id}/_history` and local audit chronology; current active=false alone does not establish insurance damage. Records whose role extensions were already erased cannot be discovered by the current-extension predicate alone and require history/audit review. No census was run against a practice server.
- No new clinical terminology, FHIR canonical URL, or regulatory claim was introduced: existing constants are reused. Mandate 14 ledger additions: none.
- No new decision was made. PerformanceOD and its decisions/INDEX.md remain read-only and unchanged.
- Independent evaluation remains required at the exact PR head. No Evaluated-by marker or evaluated label is posted by this author.
