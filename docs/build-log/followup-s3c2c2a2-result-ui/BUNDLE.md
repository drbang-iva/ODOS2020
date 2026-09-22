# S3c-2c-2a-2 imaging results — author bundle

Coded-by: Codex

NOT EVALUATED. Independent Fable/Opus evaluation is required at the final PR head before merge.

## Summary and scope

Branch `drbang-iva/followup-s3c2c2a2-result-ui` began at `c31bd5b28861222e5890b8aebda9a574732d4881`. The Follow-up tab now shows imaging result state and dates, accepts serial JPEG/PDF result files, links and unlinks eligible images, and opens the existing Imaging tab. A Media linked only to a dead visit order becomes a candidate. The R3 per-visit capture handler maps Binary upload 401/403 to `403 upload-not-permitted` with the row message, while 500 still propagates. The longitudinal capture and `mcp/src/index.ts` are untouched.

Tracked code/test changes are limited to `mcp/src/clinical-graph/{follow-up-queue-endpoint,imaging-endpoint}.ts`, `mcp/tests/{followUpResults,imagingEndpoint}.test.ts`, `ui/src/components/charting/{FollowUpQueue,ImagingSection}.tsx`, `ui/src/lib/follow-up-queue.ts`, `ui/src/scenes/EncounterCharting.tsx`, `ui/src/styles/charting.css`, and `ui/tests/followUpQueue.test.tsx`. `ImagingSection.tsx` only exports `fileBase64`; `EncounterCharting.tsx` only changes the existing mount. No new UI source file, billing code, fee, orderable, canonical policy source, encounter lock, or `tests/bulk-data/boundary.test.ts` edit was made. No new decision, decisions index entry, Mandate 14 ledger row, or cross-repo change was needed.

P1–P6 were rechecked at the base: the queue's live-order/candidate selection, capture content and upload shape, existing Follow-up mount and Imaging selector, parser's ignored additive fields, conclusion/active-order filters and unlink guard, and routing inventory (59 clinicalGraphApiBase callers, 109 inline routes, 15 original Follow-up UI tests). The R2 grants are the only historical test changes; [R2-test-grants.md](R2-test-grants.md) quotes both tests in full before and after. The other existing assertions stayed unchanged.

## Mandate 17 guard proofs

G1–G13 each failed after a deliberate break (`1 test, 0 pass, 1 fail`, exit 1) and passed after exact restoration (`1 test, 1 pass, 0 fail`, exit 0); [mutations.json](mutations.json) contains each result. G12 temporarily added one `clinicalGraphApiBase()` call inside the allowed `FollowUpQueue.tsx`: routing count 60/red, restored 59/green. G13 temporarily rethrew the upload 403: red, then restored the handler mapping: green. Its test also verifies 401, 500 propagation, and zero Media, DiagnosticReport, or Provenance writes on denied upload. Temporary guard mutations are absent from the delivered diff.

## Ordinary suites and four-run diagnosis

Each MCP row below ran the identical CI file list with `node --import tsx --test --test-concurrency=1`, `ODOS_POSTGRES_URL` pointing to the dedicated existing `odos-s3c2c2a2-tests-pg` at `127.0.0.1:25432`, and no Medplum stack or root checkout `.env`. The base was an exact-c31 temporary local clone; the head was this task worktree. The operator pair was moved together outside the repo for rows b/d, then restored for c and later live proof. [four-run-matrix.json](four-run-matrix.json) records names and counts.

| Run | Exact code | Operator pair | Tests | Pass | Fail | Skip | Exit |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| a | base c31bd5b2 | present | 6,284 | 6,220 | 9 | 55 | 1 |
| b | base c31bd5b2 | aside | 6,284 | 6,229 | 0 | 55 | 0 |
| c | author head | present | 6,290 | 6,226 | 9 | 55 | 1 |
| d | author head | aside | 6,290 | 6,235 | 0 | 55 | 0 |

The failing names in a and c were identical, and b/d had none:

1. the migration CLI scopes both reads to the resolved project and stays dry-run
2. the migration CLI refuses a mismatched access-token project before any write
3. the migration CLI accepts only admin email and password through the shared PKCE login
4. demo seed CLI requires the exact project and loads only the dedicated operator identity
5. SMART registration refuses a session project mismatch before POSTing a client
6. SMART registration checks auth/me before creating a client in the configured project
7. bootstrap service identity completes dry-run after the ordinary operator path is denied AccessPolicy read
8. bootstrap service identity refuses a foreign-project policy before composing or sending a patch
9. bootstrap service identity still refuses a non-local Medplum URL before login

This isolates the nine failures to live operator-file pollution of ordinary unit fixtures, not the source change. Unit suites were run with the pair aside before live setup. The UI suite with the pair aside ended `# tests 1852; # pass 1852; # fail 0; # skipped 0`, exit 0. At base, UI was 1,845/1,845. Post-R3 root scripts, MCP, and UI typechecks each exited 0; preflight exited 0 with zero warnings and zero hard blocks.

An earlier R3 run once failed **“Bulk Data export job IDs are opaque and contain no PHI-shaped substrings”** in `tests/bulk-data/boundary.test.ts:15` with `true !== false` (expected false, actual true). The generated identifier was not logged, so collision is an inference from the random-ID assertion, not a reproduced value. The one authorized rerun passed it; all four matrix runs also passed it. That test was not edited.

## Live stack and credential provenance

| Run | Stack and base URL | Credential source | Result |
| --- | --- | --- | --- |
| Product browser/FHIR proof | task `odos-s3c2c2a2-live`, configured `http://localhost:18103/` | task `.odos/s3c2c2a2/live.env`, project file, task operator pair; disposable runtime identity for service reads | proof below |
| First 8103 integration attempt | task `odos-s3c2c2a2-live8103`, configured `http://localhost:8103/` | task `.odos/s3c2c2a2/stack8103.env` only | smoke 0/12; preserved old database did not recognize task admin and registration was disabled |
| Final 8103 integration | same Compose project and URL, fresh task-specific Postgres volume on host `127.0.0.1:5433` | task ignored `stack8103.env` (its admin values sourced from task `live.env`; database/Redis values stayed task-owned); temporary worktree `.env` symlink to that file | smoke 12/12, integration 218/218; zero fail/skip, exit 0 |
| First 18103 authz | task `odos-s3c2c2a2-live`, configured `http://localhost:18103/` | task `live.env` + `project.env` + restored task `operator.env`; operator identity present | 36 pass, 8 fail, 0 skip; two browser-proof policies duplicated the Provider role tag |
| Final 18103 authz | same stack, URL, and task credentials | same sources; exactly two task-created `Synthetic project-admin upload proof` AccessPolicies removed from the disposable project; canonical role policies untouched | 78/78 pass, zero fail/skip, exit 0 |

The old 8103 database volume was preserved; the fresh volume used the same Compose project and port, with no second task Postgres running at the same time. The root checkout `.env` was neither read nor copied for these runs. Medplum variables came from task ignored files, not the shell or root checkout. The final `MEDPLUM_BASE_URL` values exactly matched each stack's configured `baseUrl`. The 18103 operator client belonged to that stack's project. A temporary 8103 worktree `.env` symlink was removed after integration. Credentials, client secrets, passwords, and project IDs are not in this bundle.

## Browser and FHIR proof

The actual `/clinic` route used synthetic glaucoma and macula visit data on 18103. Routine queue/link/accept calls used a Practitioner-backed caller with the synced canonical Provider policy. Upload POSTs used a separate disposable project-admin caller; the canonical policy source was not changed. [browser-observation.json](browser-observation.json) records actions and statuses, and screenshots are adjacent to this file.

- Visual field JPEG and PDF uploads each returned 200, appeared with dates, and yielded **Completed — needs interpretation**. A separate JPEG with interpretation uploaded through Manual imaging, was explicitly linked, and showed **Interpreted** with all three files (`visual-field-two-results.png`, `visual-field-interpreted.png`).
- A fundus JPEG uploaded through Manual imaging returned 200. Retina photos offered **Link** as an on-visit candidate; optic nerve photos showed **Done — not reviewed** and **Accept**. Accept changed the optic row to Already ordered, and Retina Link showed **Completed — needs interpretation** (`fundus-candidate-optic-review.png`, `optic-accepted.png`, `fundus-retina-linked.png`).
- A FHIR Media PUT changed the fundus image's sole `basedOn` to dead `ServiceRequest/other`. Queue GET exposed it as a candidate, not a linked item. The real UI Link restored it (`stranded-fundus-candidate.png`, `stranded-fundus-relinked.png`).
- Provider-role upload returned 403; **This account is not permitted to upload images.** appeared in the Visual field row (`provider-upload-refusal.png`). **View in Imaging** selected the actual Imaging tab (`aria-selected=true`). Already-mounted read-only Imaging history did not refresh immediately after upload; changing tabs refreshed Follow-up candidates. This is a visible limitation, with no product change made for it.

## Handoff and cleanup

`vf-prac1b-walk-db` was untouched. All task containers were stopped without removing their volumes. Both preserved operator files were moved together outside the worktree after the live lane; their location is recorded in ignored `.odos/s3c2c2a2/operator-pair-hold-path`. Signing env files, preflight reports, and `.odos/s3c2c2a2/` remain. Final `docker ps` is recorded in [docker-ps-final.txt](docker-ps-final.txt).

The UI/history refresh limitation above remains. Other excluded scope: billing gate 2b, signing race, diagnosis-center interpretation write-up, ServiceRequest completion, DICOM, folder-watch, legacy images, and the longitudinal Binary permission gap. The 55 ordinary MCP skips are unconfigured live surfaces, not authz proof; the separate credentialed authz lane passed 78/78. Independent exact-head evaluation remains required; do not merge before it.

needs-review
