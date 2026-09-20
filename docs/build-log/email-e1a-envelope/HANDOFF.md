# E1a sealed implementation bundle

Status: **needs-review — NOT EVALUATED**. No merge or deployment authorized.

The slice applies a neutral subject and mandatory plain-text practice footer to patient email.
The sequence probe and prepared send share the subject resolved during preparation.
Cosmetic content refuses on every dispatch channel; promotional email requires the E1c capability.
Existing purpose mapping, default preferences, consent exemption and transactional staff override remain intact.
Communication retains the full titled item; Provenance remains ID@version without a title.
The actual Staff web confirmation now discloses that sending turns education email back on.
Six required guard groups were demonstrated by deliberate product mutations, with additional propagation guards.

## Identity and scope

- Repo/worktree: `/Users/ericr.bang/.codex/worktrees/email-e1a-envelope/ODOS2020`.
- Branch: `codex/email-e1a-envelope`.
- Base and refreshed `origin/main`: `f2ef2c325e36d756759a525339431d70c7bcfde1`.
- Author commit: 53dcbdd4bf47176019d69a127338e85e6a2f60f4. Evidence is committed separately; the PR head is the evaluation target.
- User ruling: companion commit `cb1e2368`, amendment to `decisions/2026-09-19-odos-email-e1a-envelope-codex-kickoff.md`. Companion checkout read only.
- Prior [BLOCKED.md](BLOCKED.md) is retained as historical evidence and superseded by this bundle.
- Open-PR scope check: #626 changes AGENTS.md only; no overlap.

## Files touched

- `.env.example`
- `data/education-catalog.json`
- `mcp/src/comms/adapters/google-workspace-adapter.ts`
- `mcp/src/comms/comms-api.ts`
- `mcp/src/comms/comms-config.ts`
- `mcp/src/comms/comms-provider.ts`
- `mcp/src/comms/education-catalog.ts`
- `mcp/src/comms/education-sequence-worker.ts`
- `mcp/src/comms/suppression-gate.ts`
- `mcp/src/index.ts`
- `mcp/tests/commsApi.test.ts`
- `mcp/tests/commsConfig.test.ts`
- `mcp/tests/commsSuppression.test.ts`
- `mcp/tests/educationCatalog.test.ts`
- `mcp/tests/educationDispatchActor.test.ts`
- `mcp/tests/educationSequenceWorker.test.ts`
- `mcp/tests/googleWorkspaceAdapter.test.ts`
- `mcp/tests/visionforgeEducationCatalog.test.ts`
- `scripts/fhir-read-grant-check.ts`
- `ui/src/components/comms/EngageSheet.tsx`
- `ui/tests/engageCommunicationPreferences.test.tsx`
- `mcp/src/comms/patient-email-envelope.ts`
- `docs/build-log/email-e1a-envelope/ (sealed evidence, replay scripts, screenshots)`

## Author verification

| Command (from repo root unless noted) | Actual result | Evidence |
| --- | --- | --- |
| `cd mcp && ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:29433/medplum ODOS_ALLOW_UNGATED_MCP=1 npm test` | exit0; 6,127 tests; **6,072 pass, 0 fail, 55 skipped**; 143,009.817ms | [summary](checks/full-mcp.log.summary.txt), [complete gzip log](checks/full-mcp.log.gz) |
| `npm --prefix ui test` | exit0; **1,771 pass, 0 fail, 0 skipped**; 215,294.349ms | [summary](checks/full-ui.log.summary.txt), [complete gzip log](checks/full-ui.log.gz) |
| `npm --prefix mcp run build` | exit0; `tsc` | [output](checks/mcp-build.log) |
| `npm --prefix ui run build` | exit0; TypeScript and Vite; 333 modules; existing large-chunk advisory | [sealed served build](checks/served-build.log) |
| `npm run typecheck:scripts` | exit0 | [output](checks/scripts-types.log) |
| `npm run preflight` | exit0; **0 warnings, 0 hard blocks** | [output](checks/preflight.log) |
| `ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:29433/medplum npm --prefix mcp test -- tests/visionforgeEducationCatalog.test.ts` | exit0; **27 pass, 0 fail, 0 skipped** | [output](checks/published-catalog.log) |
| `npm --prefix mcp test -- tests/commsApi.test.ts` | exit0; **116 pass, 0 fail** | [output](checks/comms-api.log) |
| `python3 docs/build-log/email-e1a-envelope/proof/mutations.py /tmp/odos-email-e1a-proof-base` | **22/22 broken runs failed; 22/22 restored runs passed** | [all results](mutations/results.json) |
| `git diff --check` | exit0 | no whitespace errors |

Read compressed complete output with `gzip -cd docs/build-log/email-e1a-envelope/checks/full-mcp.log.gz`.
[Source hashes](checks/source-hashes.json) bind verification to the author commit. Failed author attempts are
retained in [the archive](checks/earlier-author-attempts.log.gz), including earlier database/fixture failures
and the test corrections described below.

Full MCP invocation includes all default suites, with the task-owned PostgreSQL database. The explicit
`ODOS_ALLOW_UNGATED_MCP=1` acknowledges the runner's credential-gated skips; it does not claim live
authorization coverage. The separate browser proof below does use real stored Staff policy enforcement.
No production or primary-account credentials were used. Provider delivery tests use synthetic RSA keys and
an injected fake token/Gmail fetch, capturing decoded real-adapter MIME; they do not send real email.

Root dependencies were incomplete when the first MCP build failed (four errors originating at
`scripts/access-policy-rules.ts`). `npm ci --ignore-scripts` at the repository root installed 10 packages,
reported 0 vulnerabilities, and left all lockfiles unchanged. The subsequent MCP build and root script
check exit 0; no production TypeScript workaround was needed.

The published-catalog G18 source-line hash test necessarily changed with the authorized schema addition.
It now verifies compatibility of the captured transactional wire fixture, default eyecare, explicit
marketing classification, refusal without it, and both explicit enum values. Real HTTP/PostgreSQL tests
also verify last-good content survives refusal and classification survives restart. Original unrelated
catalog tests remain unchanged. During author verification, an overbroad test edit was caught and fully
restored before the final suite; no product behavior was weakened to satisfy those failures.

Intermittent HTTP failures occurred in the communications fixture during broad runs (`fetch failed` and
an HTML response where JSON was expected). The fixture now explicitly binds `127.0.0.1`, matching its
advertised request URL instead of the platform's default listen address. All 116 communications API
tests pass after this fixture correction. Failed attempts remain in the compressed author-run archive.

## Six deliberate guard demonstrations

All mutations altered product source in `/tmp/odos-email-e1a-proof-base`; no test assertions were changed
between broken and restored runs. Every mutation has a `.diff.gz` (read with `gzip -cd`), complete broken/restored command output,
and source SHA-256 in [mutations/results.json](mutations/results.json). Restores were byte-checked against
this worktree. These are separate from initial test-first reds.

| Required guard | Broken product behavior | Named test(s) | Broken → restored |
| --- | --- | --- | --- |
| a | Return condition title as subject; omit footer; erase frozen title; add title to Provenance (four separate runs) | `E1a a neutral MIME envelope keeps the item title on the chart`; configured reminder/education envelope test for footer | 1, 2, 1, 1 failures respectively → 1, 2, 1, 1 passes; zero restored failures |
| b | Bypass required practice fields | `E1a b missing ODOS_PRACTICE_POSTAL_ADDRESS…` and `…PHONE…` | 2 failures → 2 passes; restored provider calls and reservations both 0 |
| c | Bypass cosmetic refusal | `E1a c cosmetic email/sms/print refuses with visible reason` plus sequence cosmetic hold | 4 failures → 4 passes |
| d | Bypass unsubscribe capability guard | `E1a d marketing email needs unsubscribe capability while SMS and print retain behavior`, sequence hold, prepared capability recheck | 3 failures → 3 passes; restored email provider calls 0; existing SMS/print assertions execute |
| e | Require recorded consent on email (API and wrapper separately); bypass explicit OFF | `E1a e …allowed=true`, `E1a email wrapper…`, `E1a e …allowed=false` | 1 failure each → 1 pass each |
| f | Disable transactional staff override; separately skip preference write ON | `E1a f real email suppression preserves staff override and preference write ON` | 1 failure each → 1 pass each |

Additional demonstrations (broken counts, followed by restored counts):

- `a-subject`: exit 1, 0 pass / 1 fail → exit 0, 1 pass / 0 fail. [Broken](mutations/a-subject-broken.log) · [restored](mutations/a-subject-restored.log).
- `a-footer`: exit 1, 0 pass / 2 fail → exit 0, 2 pass / 0 fail. [Broken](mutations/a-footer-broken.log) · [restored](mutations/a-footer-restored.log).
- `a-chart-title`: exit 1, 0 pass / 1 fail → exit 0, 1 pass / 0 fail. [Broken](mutations/a-chart-title-broken.log) · [restored](mutations/a-chart-title-restored.log).
- `a-provenance-title`: exit 1, 0 pass / 1 fail → exit 0, 1 pass / 0 fail. [Broken](mutations/a-provenance-title-broken.log) · [restored](mutations/a-provenance-title-restored.log).
- `b-required`: exit 1, 0 pass / 2 fail → exit 0, 2 pass / 0 fail. [Broken](mutations/b-required-broken.log) · [restored](mutations/b-required-restored.log).
- `b-unresolved`: exit 1, 0 pass / 3 fail → exit 0, 3 pass / 0 fail. [Broken](mutations/b-unresolved-broken.log) · [restored](mutations/b-unresolved-restored.log).
- `c-cosmetic`: exit 1, 0 pass / 4 fail → exit 0, 4 pass / 0 fail. [Broken](mutations/c-cosmetic-broken.log) · [restored](mutations/c-cosmetic-restored.log).
- `d-unsubscribe`: exit 1, 0 pass / 3 fail → exit 0, 3 pass / 0 fail. [Broken](mutations/d-unsubscribe-broken.log) · [restored](mutations/d-unsubscribe-restored.log).
- `e-consent-api`: exit 1, 0 pass / 1 fail → exit 0, 1 pass / 0 fail. [Broken](mutations/e-consent-api-broken.log) · [restored](mutations/e-consent-api-restored.log).
- `e-consent-wrapper`: exit 1, 0 pass / 1 fail → exit 0, 1 pass / 0 fail. [Broken](mutations/e-consent-wrapper-broken.log) · [restored](mutations/e-consent-wrapper-restored.log).
- `e-explicit-off`: exit 1, 0 pass / 1 fail → exit 0, 1 pass / 0 fail. [Broken](mutations/e-explicit-off-broken.log) · [restored](mutations/e-explicit-off-restored.log).
- `f-override`: exit 1, 0 pass / 1 fail → exit 0, 1 pass / 0 fail. [Broken](mutations/f-override-broken.log) · [restored](mutations/f-override-restored.log).
- `f-write-on`: exit 1, 0 pass / 1 fail → exit 0, 1 pass / 0 fail. [Broken](mutations/f-write-on-broken.log) · [restored](mutations/f-write-on-restored.log).
- `sequence-probe`: exit 1, 0 pass / 2 fail → exit 0, 2 pass / 0 fail. [Broken](mutations/sequence-probe-broken.log) · [restored](mutations/sequence-probe-restored.log).
- `sequence-send`: exit 1, 0 pass / 2 fail → exit 0, 2 pass / 0 fail. [Broken](mutations/sequence-send-broken.log) · [restored](mutations/sequence-send-restored.log).
- `wrapper-validation`: exit 1, 0 pass / 3 fail → exit 0, 3 pass / 0 fail. [Broken](mutations/wrapper-validation-broken.log) · [restored](mutations/wrapper-validation-restored.log).
- `scheduled-detail`: exit 1, 0 pass / 1 fail → exit 0, 1 pass / 0 fail. [Broken](mutations/scheduled-detail-broken.log) · [restored](mutations/scheduled-detail-restored.log).
- `catalog-required`: exit 1, 0 pass / 3 fail → exit 0, 3 pass / 0 fail. [Broken](mutations/catalog-required-broken.log) · [restored](mutations/catalog-required-restored.log).
- `catalog-default`: exit 1, 0 pass / 2 fail → exit 0, 2 pass / 0 fail. [Broken](mutations/catalog-default-broken.log) · [restored](mutations/catalog-default-restored.log).
- `catalog-propagation`: exit 1, 0 pass / 1 fail → exit 0, 1 pass / 0 fail. [Broken](mutations/catalog-propagation-broken.log) · [restored](mutations/catalog-propagation-restored.log).
- `ui-disclosure`: exit 1, 0 pass / 1 fail → exit 0, 1 pass / 0 fail. [Broken](mutations/ui-disclosure-broken.log) · [restored](mutations/ui-disclosure-restored.log).
- `write-inventory`: exit 1, 0 pass / 1 fail → exit 0, 1 pass / 0 fail. [Broken](mutations/write-inventory-broken.log) · [restored](mutations/write-inventory-restored.log).

Replay: `python3 docs/build-log/email-e1a-envelope/proof/mutations.py /absolute/disposable-candidate-checkout`.
The checkout needs the candidate sources and installed root/MCP/UI dependencies; the synthetic PostgreSQL
port is 29433. Never point this replay at the author worktree or another agent's checkout.
The changed FHIR write inventory is enforced: removing its AccessPolicy entry makes the CLI test fail.

## Premises reverified

Base refs are the requested `f2ef2c32`; current refs below identify the implementation after this slice.

| Premise at base | Evidence at current source | Finding |
| --- | --- | --- |
| Education subject is item.title, comms-api:1348 | `mcp/src/comms/comms-api.ts:1100,1148,1374` | True at base; one prepared neutral subject now supplies probe and send |
| Recorded marketing consent is SMS-only, :1087 | `mcp/src/comms/comms-api.ts:1092`; `mcp/src/comms/suppression-gate.ts:577` | Preserved |
| Override requires transactional staff send, :1343 | `mcp/src/comms/comms-api.ts:1369` | Preserved |
| Successful override writes education/email ON, :1372 | `mcp/src/comms/comms-api.ts:1398` | Preserved; mutation covers write and send separately |
| marketing-promo/email default true, suppression:44 | `mcp/src/comms/suppression-gate.ts:44` | Preserved; purpose/default matrix unchanged |
| Existing catalog fields, catalog:6–21 | `mcp/src/comms/education-catalog.ts:6–26` | Added optional classification with transactional default and explicit marketing requirement |
| Plain MIME, one From, adapter:126–142 | `mcp/src/comms/adapters/google-workspace-adapter.ts:135–148` | Preserved; mandatory subject/footer applied here |
| UI withheld detection/post-send text, Engage:134,279 | `ui/src/components/comms/EngageSheet.tsx:134,279,383` | Existing messages retained; confirmation gains disclosure |
| Provenance already contains item title | `mcp/src/comms/comms-api.ts:2562`; `mcp/src/fhir/ophthalmology/provenance.ts:17` | **False in original kickoff**, accepted ruling preserves ID@version without title |
| Whole item is frozen on Communication | `mcp/src/comms/comms-api.ts:1271` | Title retained on Communication and explicitly asserted |

`persistEducationSendProvenance` is byte-identical to base (SHA-256
`87e424a41f1ffe2a43dfa951575901af4de7c1744c2da3a50e05f3b4b6ffcf77`).
`buildProvenance` has no diff. The deliberate title-addition mutation exists only in isolated proof logs.

## Settings and propagation census

- Reused existing `ODOS_PRACTICE_NAME` in `.env.example`; added `ODOS_PRACTICE_POSTAL_ADDRESS`,
  `ODOS_PRACTICE_PHONE`, and optional `ODOS_COMMS_EMAIL_SUBJECT` alongside it. Comms already reads practice
  identity from environment. This avoids coupling communications to billing setup requiring tax/NPI data.
  Blank or unresolved required envelope fields refuse; the default subject is `Information from <name>`.
- `ODOS_COMMS_EMAIL_UNSUBSCRIBE_ENDPOINT` is the single optional capability in `index.ts:5825`. It remains
  absent in example/runtime configuration; synthetic positive tests supply it only to exercise preferences.
  No endpoint, token, List-Unsubscribe header, tracked email link, HTML, attachment, or extra From identity.
- `rg -n 'sendEmail\(' mcp/src` finds the Google adapter, suppression wrapper, education dispatcher and
  `mcp/src/reminders/reminder-engine.ts:673`. Both patient-email callers reach the same real MIME adapter.
  The registration (`comms-config.ts:535`) carries settings; role scoping preserves the optional validator;
  the suppression wrapper forwards it (`suppression-gate.ts:494`). API integration uses that actual chain.
  Adapter tests exercise both appointment-reminder and clinical-education campaigns, including custom subject.
- Published catalog: `visionforge-education-catalog.ts:41` uses the same item schema for incoming entries and
  persisted snapshots. New tests use existing captured wire fixtures and a real task-owned PostgreSQL schema.
  Seed marketing entries explicitly declare eyecare. Transactional fixtures need no classification edits.
- Consumers: communications list/detail/manual dispatch, enrollment validation/immediate dispatch,
  scheduled sequence preparation/worker, protocol CarePlan education and plan-set generation. The latter
  two retain their existing seed-reader defaults (`protocol-endpoint.ts:1154`, `plan-sets/generator.ts:7`),
  covered by G19 and the full regression. [Catalog census](checks/catalog-consumers.txt) contains file refs.
- Scheduled sends preserve the system actor, frozen reconciliation and final preference checks. Preparation
  reports classified hold reasons before provider probing; the worker passes the explanation to its existing
  staff task (`education-sequence-worker.ts:270`). Prepared actual email goes through the same send at :1374
  and rechecks the unsubscribe capability before a new reservation. Existing recovery tests remain green.

## Actual web-tier Staff proof

Used the repository `/before-and-after` skill and its production Caddy route map. No request interception,
component fixture, localStorage token injection, or admin browser token. Playwright logged in through the
real front door using the disposable **Staff** account. `/auth/me` returned that Practitioner/membership and
`admin:false`; read-only inspection of its stored membership and policy confirmed the `practice-role=staff`
binding ([staff-policy.json](staff-policy.json)). The chart's presentation selector can display “Doctor”;
it is not the authenticated role, which is independently recorded here.

Commands from the author worktree:

```sh
node docs/build-log/email-e1a-envelope/proof/prepare.mjs
node .odos/email-e1a-proof-scripts/stack.mjs prepare
node .odos/email-e1a-proof-scripts/stack.mjs up
node .odos/email-e1a-proof-scripts/stack.mjs build
node .odos/email-e1a-proof-scripts/stack.mjs serve
node --import tsx docs/build-log/email-e1a-envelope/proof/seed.ts
node docs/build-log/email-e1a-envelope/proof/browser.mjs before
node docs/build-log/email-e1a-envelope/proof/browser.mjs after
```

The final after build is from author commit `53dcbdd4`; only untracked evidence made its build metadata dirty. [Served identity](checks/served-identity.json) records the bundle hashes and process IDs.

The generated task-owned harness reuses existing synthetic bootstrap helpers. Docker project
`odos-email-e1a-proof`, subnet `10.249.162.0/24`, frontdoor32190 / Medplum32103 / PostgreSQL29433 /
Redis30380 / MCP27334 / proxy27335 / control27336. Credentials stay under ignored `.odos/email-e1a-proof`.
Synthetic setup uses a separate bootstrap/seeder identity; **all browser proof traffic uses Staff**.
The seeded adult patient has education/email explicitly OFF and an `.invalid` email address.

Base UI was built from a separate detached worktree `/tmp/odos-email-e1a-proof-base` at `f2ef2c32`, served by
its own Caddy process on32191. Both front doors use the same synthetic backend, route and 1600×1100 viewport.
Only port substitutions differ from the checked-in Caddy map. `lsof` confirmed task-owned listeners.
The base UI build was retained unchanged when its source checkout was later used for mutations.

Navigation: `/clinic?patientId=<synthetic-id>&encounterId=<synthetic-id>` → Engage tab → first content Email
button → confirmation. After: disclosure visible, confirm enabled, confirm not clicked, dispatch requests **0**.
Before: disclosure absent in confirmation, confirm enabled, dispatch requests **0**. Opt-out, education and
preference API reads returned200 through the web tier. JSON proof records served JavaScript SHA-256.

[Before screenshot](staff-before.png) · [after screenshot](staff-after.png) · [before facts](staff-before.json) · [after facts](staff-after.json).

## Risks, follow-ups and release boundary

- **NOT EVALUATED.** Fable/Opus must independently evaluate the exact PR head before merge. No evaluation
  marker or operator override label has been applied. No merge, deployment or real email delivery occurred.
- Configure the three required practice fields before enabling patient email. Existing installations missing
  address/phone will deliberately refuse email, including reminders. Operators must keep custom subjects neutral.
- E1c must implement/verify unsubscribe handling before supplying the capability. A nonempty config value is a
  capability assertion, not a network health check or proof of an endpoint in this slice.
- VisionForge follow-up: marketing publications must explicitly supply offerClass; missing classification is
  intentionally invalid. Old marketing snapshots can also fail validation at restart and require a correctly
  classified publication. No publisher code was changed or deployed here.
- The broad regression's credential-gated skips do not establish whole-product live authorization. The changed
  visible surface has separate real Staff proof; live Gmail delivery is intentionally not exercised.
- No new clinical codes, FHIR artifact URLs or regulatory claims were introduced into product code. Mandate14:
  no new ledger rows required. Existing code displays in synthetic screenshots are unchanged repository content.
- No new decision was authored: the accepted companion amendment supplies the decision; `decisions/INDEX.md`
  was not modified because the companion checkout was explicitly read-only.
- Per the explicit “open PR and stop” instruction, bot checks/reviews may be pending at handoff. No bot trigger,
  self-evaluation or merge is part of this request.

Web route census: 25 backend route families / 28 proxy entries; all covered. Production front-door parity: 0 findings, PASS.

Readable command logs have trailing whitespace normalized; test results and messages are unchanged. Compressed full-suite output and mutation diffs retain their original bytes.
