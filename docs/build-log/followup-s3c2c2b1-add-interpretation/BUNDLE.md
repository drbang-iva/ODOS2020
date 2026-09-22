# S3c-2c-2b-1 Add interpretation — R4 sealed author bundle

NOT EVALUATED. Coded-by: Codex. No commit, push, PR, or merge. Branch: drbang-iva/followup-s3c2c2b1-add-interpretation. Base and current committed HEAD: 0ebc8b11fa4933a83292022cb21711133662bd0e; all changes are an uncommitted diff.

Final read-only refresh: git fetch origin exited 0 and origin/main remained 0ebc8b11fa4933a83292022cb21711133662bd0e. The open-PR query found no PR for this task branch.

## Summary

The Follow-up tab now lets a doctor interpret an imaging result already linked to the visit. A final, amended, or corrected report marks both photo rows Interpreted by concept; a preliminary conclusion is a prefill and does not count. Capture with an interpretation requires clinical.sign and creates preliminary, then conditionally updates to final before Provenance. The live smoke, integration, authorization, browser, MCP, UI, TypeScript, and preflight lanes below completed. Independent evaluation remains required.

## Files touched

- Server: mcp/src/clinical-graph/follow-up-queue-endpoint.ts; mcp/src/clinical-graph/imaging-endpoint.ts.
- MCP tests and R2 registry: mcp/tests/followUpResults.test.ts; mcp/tests/imagingEndpoint.test.ts; mcp/tests/fixtures/r10/finding-write-exclusions.json.
- UI and tests: ui/src/components/charting/FollowUpQueue.tsx; ui/src/components/charting/ImagingSection.tsx; ui/src/lib/follow-up-queue.ts; ui/src/styles/charting.css; ui/tests/followUpQueue.test.tsx; ui/tests/imagingSection.test.tsx.
- This build-log directory contains the bundle and synthetic browser screenshots/observations. Ignored .odos/s3c2c2b1-r3/ holds task-only environment, scripts, and check logs.

Forbidden files remained untouched: mcp/src/index.ts, authz/*, policy/*, finding-write-paths.json, finding checker/scripts, EncounterCharting.tsx, clinical-graph-client.ts, billing/claims code, decisions, INDEX, and Mandate 14 ledgers. No billing code, fee, orderable, procedure concept, charge, or proposal changed.

## P1–P6 premises and decisions

- P1: At base, the existing POST results route calls handleFollowUpResultRequest with chart.write, strict link/unlink input, caller FHIR writes, finished-encounter refusal, live ServiceRequest checks, and refreshed queue/committed acknowledgment. The interpret action extends that same route; no new route or index edit.
- P2: At base, withImagingResults counted a non-error, non-cancelled report with a conclusion, including preliminary, against each row's own order. It now accepts only final/amended/corrected for Interpreted by photo concept; row completion remains per row. A preliminary conclusion becomes draftConclusion.
- P3: At base, capture required chart.write and built a preliminary DiagnosticReport. The signer check was added before reads/uploads. R3 preserved preliminary create, then added a version-guarded update to final before Provenance.
- P4: The kickoff's claim that provider policy allowed final on CREATE was wrong. The synced provider policy requires preliminary CREATE and permits clinician preliminary-to-final UPDATE. Live provider interpretation below proves that transition; no authz or policy source changed.
- P5: At base, FollowUpQueue had 0 clinicalGraphApiBase() calls, row-scoped status/errors, and canAccept. The UI lib validates additive result fields. New requests remain in ui/src/lib/follow-up-queue.ts, and routing inventory stays 59.
- P6: The class sweep found only the granted changed assertions below. Preserved unchanged and green in the final suites: “S3c2c2a1 G5 linking one fundus image completes only the chosen photo order”; “S3c2c2a2 G1 dead links recover as candidates, review hints and relinkable results”; “S3c2c2a2 G7 completion labels preserve the unreviewed row's working Accept”; and the existing preliminary-report capture test. The photo sibling with no linked image stays none until the concept is Interpreted (R1).

The Follow-up interpret writer uses two sequential transactions. Medplum's live same-bundle placeholder POST/PUT probe returned entry statuses 201/400/201; sequential create preliminary and version-guarded attest final plus Provenance returned 201, then 200/201. Every entry response is checked. A failed second call leaves a preliminary draft, never an Interpreted success. Capture uses a preliminary create and If-Match final update. Failed capture finalization returns 502 interpretation-not-finalized with saved image and draft, before Provenance.

## Existing-line grants: before → after

1. mcp/tests/followUpResults.test.ts G9: status: linkKind === "error" ? "entered-in-error" : "preliminary" → status: linkKind === "error" ? "entered-in-error" : "final".
2. mcp/tests/followUpResults.test.ts G15: status: "preliminary" → status: "final".
3. R3 withdrew original grant 3. mcp/tests/imagingEndpoint.test.ts kept, byte-identical to base by content, the test “manual imaging upload persists Media, preliminary interpretation report, and patient-scoped Provenance” and its assertion assert.equal(report.status, "preliminary"). Only line positions moved. G12 was appended.
4. ui/tests/imagingSection.test.tsx help-text regex: “Creates a preliminary DiagnosticReport linked to the uploaded Media” → “Doctors only. Saves the interpretation and report for this image.”
5. R2 registry grant: no interpret transaction-submit site → one site keyed [mcp/src/clinical-graph/follow-up-queue-endpoint.ts, handleFollowUpResultRequest, transaction-submit, 1], sourceLine 395. Reason: “Non-Observation transaction: the Follow-up interpret action creates one DiagnosticReport (status final) and its Provenance; no entry targets Observation.”
6. R4 retroactive fixture grant, mcp/tests/imagingEndpoint.test.ts deps(): before, options had no failReportUpdate; no updatedReports/writeSequence; create returned id without meta.versionId; no update method; return object lacked those two recorders. After, the fixture adds failReportUpdate, updatedReports/writeSequence, meta.versionId on created resources, an update method, and the two return fields. These are additive fixture mechanics; no existing assertion changed. The preserved capture test body was compared by content with base and was byte-identical.

The G2/G5 fake transaction behavior follows R3's accepted two-call contract; G6's new test asserts preliminary create and final update. No other pre-existing assertion changed.

## Mandate 17 guards at this diff

Each temporary break was restored byte-for-byte. Unless noted: red exit 1, 1 test/0 pass/1 fail; green exit 0, 1 test/1 pass/0 fail.

| Guard | Named red case and restored result |
| --- | --- |
| G1 | S3c2c2b1 G1 staff cannot interpret a linked photo and writes nothing: red 2 tests/1 pass/1 fail; green 2 pass. |
| G2 | S3c2c2b1 G2 provider creates preliminary then attests final with Provenance: red 1 fail; green 1 pass. |
| G3 | S3c2c2b1 G3 optic-row API interpretation covers both photo rows but not visual field: red 1 fail; green 1 pass. |
| G4 | S3c2c2b1 G4 only final amended corrected reports interpret; preliminary becomes draft: red 1 fail; green 1 pass. |
| G5 | S3c2c2b1 G5 invalid, finished, absent-result, non-image and repeated interpretations write nothing: red 1 fail; green 1 pass. |
| G6 | S3c2c2b1 G6 staff interpretation capture is refused before upload; plain capture remains available: red 1 fail; green 1 pass. |
| G7 | S3c2c2b1 G7 interpretation control stays on result row, prefills, validates, saves and shows row error: red 1 fail; green 1 pass, including R1's optic-none case. |
| G8 | S3c2c2b1 G8 non-string draft conclusion fails the queue load closed: red 1 fail; green 1 pass. |
| G9 | clinical-graph requests share the literal Vite route and Medplum authorization helpers: temporary allowed-file call made count 60, red 1 fail; restoration returned 59, green 1 pass. |
| G10 | W87a W87b W129 exact finding write registry covers every call site including Binary patches AND T22 every registered finding write path uses real handlers and emits permitted Observations: deleting the R2 entry gave 2 tests/0 pass/2 fail, exit 1, “unregistered call site ["mcp/src/clinical-graph/follow-up-queue-endpoint.ts","handleFollowUpResultRequest","transaction-submit",1] at line 395”; restoring gave 2 pass/0 fail, exit 0. |
| G11 | S3c2c2b1 G11 an entry-level 403 inside HTTP 200 cannot claim interpretation success: red 1 fail; green 1 pass. |
| G12 | S3c2c2b1 G12 provider capture attests a preliminary report before Provenance: create-final-and-skip-update break gave 1 test/0 pass/1 fail, exit 1; restoration gave 1 test/1 pass/0 fail, exit 0. |

Before R3's implementation, G12 itself failed 1/1 with actual final versus expected preliminary. Its final fixture also covers a failing update: 502 interpretation-not-finalized, created report still preliminary, no Provenance. The G11 fake returns a failed transaction entry inside an overall HTTP-200 response; removing the check falsely reports success and turns the guard red.

## Final-head checks and live proofs

Readiness and live lane order on disposable stack odos-s3c2c2b1-r3-live, new named Postgres/Redis/Binary volumes, task-only ignored .odos/s3c2c2b1-r3/live.env, configured MEDPLUM_BASE_URL exactly http://localhost:18103/:

1. R4 readiness gate: GET http://localhost:18103/healthcheck passed on attempt 1 after restart, HTTP 200, response {"ok":true,"version":"5.1.8-d50cd6f","platform":"linux","runtime":"v24.14.1","postgres":true,"redis":true,"redisInstances":{"default":true}}. The earlier R3 fetch-failed attempt happened before readiness and was not an authorization result.
2. One post-gate smoke run, node --import tsx --test --test-concurrency=1 mcp/tests/searchParamMedplumSmoke.test.ts: 12 tests, 12 pass, 0 fail, 0 skip, exit 0. This ran before role repair.
3. Integration used the exact test:live-integration file list after its smoke bootstrap, excluding the smoke file so R4's once limit held; node mcp/scripts/run-tests.mjs with those remaining files: 218 tests, 218 pass, 0 fail, 0 skip, exit 0. Same stack and task credential source.
4. repair-practice-roles with GITHUB_ACTIONS=true only for that command: 3 role policies created (provider, staff, admin), membership reconciliation CHANGED. Requested admin ProjectMembership fields after repair: {"admin":true,"accessPolicy":null}. A same-project operator client was created and verified for the next lane; the held operator files from the older stack were not imported.
5. npm --prefix mcp run test:live-authz with the new same-project operator client: 78 tests, 78 pass, 0 fail, 0 skip, exit 0.
6. Chromium /clinic, current stack: project-admin client uploaded retina photo and VF result, both HTTP 200. Before, optic-nerve row had no status/button, retina and VF needed interpretation. Provider-role client clicked Add interpretation on retina and saved, HTTP 200. After, optic nerve and retina showed Interpreted; VF remained needs-interpretation. Medplum readback: final DiagnosticReport, provider resultsInterpreter, retina order and Media links, and Provenance targeting report and patient. Artifacts: r4-before-interpretation.png, r4-after-interpretation.png, r4-browser-observation.json.
7. Chromium staff-role refusal: Add interpretation on VF returned 403 with “Only a doctor can save an interpretation” in that row. Staff-role raw preliminary report returned 201; provider queue stayed needs-interpretation and textarea prefilled its conclusion. Staff-role Manual imaging capture with interpretation returned 403 before upload and Media count stayed unchanged. Artifacts: r4-staff-follow-up-refusal.png, r4-provider-draft-prefill.png, r4-staff-imaging-refusal.png, r4-staff-observation.json.
8. Chromium project-admin capture with interpretation returned HTTP 200. Medplum readback found Media, Provenance, and DiagnosticReport history containing preliminary then final. Artifacts: r4-capture-attestation.png, r4-capture-observation.json. The first evidence script incorrectly expected numeric versionId "2"; Medplum supplied an opaque version ID, so readback was corrected to inspect actual resource history. No product retry or edit was needed. This proves the capture sequence on the live stack; it does not prove provider-role Binary create, which remains a separate permission gap.

The first browser attempt after repair used the MCP password session and read the seeded queue as recorded:false. Restarting that task-owned MCP process with the same-project operator client made the queue recorded:true with six rows; all browser proofs above then passed. No product file changed for that local service configuration. The temporary project-admin upload policy was deleted afterward (HTTP 200).

- Full MCP unit suite, dedicated odos-s3c2c2b1-tests-pg at 127.0.0.1:55483, ODOS_POSTGRES_URL set, both operator files moved outside the worktree, ODOS_ALLOW_UNGATED_MCP=1: npm --prefix mcp test → 6,299 tests, 6,244 pass, 0 fail, 55 skip, exit 0. The 47 credentialed live skips are not called unit passes; live lanes above ran separately. Base 6,290 + 9 added = 6,299.
- Full UI: npm --prefix ui test → 1,854 tests, 1,854 pass, 0 fail, 0 skip, exit 0. Base 1,852 + 2 added = 1,854.
- Three TypeScript checks: npm --prefix mcp run build → exit 0; ui node_modules/.bin/tsc --noEmit --skipLibCheck → exit 0; npm run typecheck:scripts → exit 0.
- npm run preflight → “ODOS preflight complete: 0 warning(s), 0 hard block(s).” Exit 0. git diff --check → exit 0.

Both task stacks were stopped; named volumes were retained. No root checkout .env was read or copied. Both operator files are held together outside the worktree. Final docker ps --format '{{.Names}} {{.Ports}}':

    vf-prac1b-walk-db 127.0.0.1:55481->5432/tcp

## Risks and follow-ups

A failed second interpret transaction leaves a preliminary draft. A failed capture attestation returns 502 with Media plus a preliminary report; Binary-attempt resolution currently occurs after Provenance, so that failure path can leave an open attempt ledger entry. Provider-role capture cannot be proven live while non-admin Binary create is refused; the provider-policy preliminary-to-final transition was proven on the interpret route. Imaging history on an already-mounted tab does not refresh on View. A multi-file batch can leave earlier Media after a later failure and can duplicate on repeat. Revoked ServiceRequest whose action remains ordered is a named follow-up. These are outside this slice.

Not done in this slice: fee flag and billing gate, interpretation edit/retract, diagnosis-center write-up, non-admin Binary permission gap, #656 limits 2–3, Q7 claim path, tasks, and sign race. Independent Fable/Opus evaluation must inspect this exact uncommitted diff before any merge decision.

needs-review
