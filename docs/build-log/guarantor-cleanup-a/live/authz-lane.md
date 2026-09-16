# Canonical live-authorization lane: local setup blocked

Requested named suite: `mcp/tests/clinicalWriteAuthzLive.test.ts`; broader command: `npm run test:live-authz` (four files). Neither test command executed locally: setup stopped first.

Read `.github/workflows/ci.yml` and `mcp/tests/integration-helpers.ts`. Created a separate synthetic project and project-admin principal, plus one ContractSearch synthetic patient, on the existing isolated loopback 28860 fixture. Existing operation-proof principals and policies were not changed. Created the canonical privileged operator seeder with `scripts/operator-identity.ts --project <new-project>`; exit 0. All credentials remain private.

Two canonical repair attempts:

1. CI bootstrap mode correctly refused: `MEDPLUM_CONTRACT_BOOTSTRAP practice-role repair requires GitHub Actions.` Its further guard also pins localhost18103. No bypass attempted.
2. Normal local repair correctly reached its target project but failed: `FHIR GET /fhir/R4/User/:id [User] 404 Not Found: Not found`. The synthetic project-admin cannot read the global User. Exit 1; stopped without broadening privileges or introducing a custom repair.

Thus this local lane is **BLOCKED / NOT EXECUTED**, not a test failure or a green suite. Canonical final-head CI supplies the four-file authorization lane. The separately executed O10 live raw-staff Person.active PUT403 proof remains valid and is recorded in operation-proof.json.

`authz-lane.mjs` preserves the attempted setup and intended subprocess invocation. `authz-lane-results.json` records sanitized actual output from the normal local attempt. Private authz credentials and canonical operator files are under `.odos/guarantor-cleanup-a-live/` and not committed. Synthetic setup resources and fixture containers retained for inspection; no other environment touched.
