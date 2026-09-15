# Guarantor claim fence: author evidence

NOT EVALUATED. Base: `6d41a717060fe7d01a185496279ee67f47e82fa5`. Contract anchors matched this fetched base. No product UI behavior or insurance implementation changed.

Staff RelatedPerson writes now preserve the complete claim-extension collection on update and refuse claim-bearing creates. Exists-guarded equality permits ordinary unclaimed-child updates. The canonical compiler changes **ODOS Staff**, specifically its one RelatedPerson create/update rule; Provider, Admin, and every other Staff rule are unchanged (`compiled-staff-delta.json`, `compile-check.log`). The existing claim URL has one active canonical registry entry, so no duplicate registration or new terminology was added. No new decision or Mandate 14 ledger row is required.

## Staff RelatedPerson writers

Census: searched every `RelatedPerson` reference in `ui/src` and `mcp/src`, then inspected generic update/transaction calls and identity plumbing in each candidate.

| Writer | Identity and effect |
|---|---|
| `ui/src/lib/guarantor-editor.ts` — `writeChild`, called by Save and Repair | Staff browser FHIR client. `applyResponsiblePartyDemographics` preserves claim extensions. Real Save is exercised against Medplum by K4; the control test also edits name/phone through ResponsiblePartiesControl. |
| `mcp/src/insurance/patient-insurance-handlers.ts` — `handlePatientInsuranceWrite`, transaction loop | `auth.fhir` is the authenticated staff client. Creates/updates subscriber-only RelatedPersons, built by `ui/src/lib/patient-insurance.ts`. The benefits transaction in `handleVisionBenefitsWrite` does not write RelatedPerson. |
| `mcp/src/comms/comms-api.ts` — `updateEducationRecipient`, directly and via `updateSentEducationRecipient` | Additional writer beyond the kickoff list. Staff education dispatch's `alsoUpdateChart` option updates a selected RelatedPerson's phone/email, spreading the complete resource and retaining extensions. System dispatch refuses this option. `commsApi` regression included. |

Registration and guarantor link operations write through `serviceFhir`; they are not staff-policy writers. Remaining references in claims, education, statements, eligibility, and recipient selection are reads or projections.

## Guard evidence

Each log contains the exact TAP output. Each deliberate mutation was restored before subsequent regression runs. K1–K3 use Medplum **5.1.8-d50cd6f**, matching this base's CI image, with policies generated from the current declarations and applied to a fresh disposable project. Each run creates newly bound staff clients; no fake policy engine supplies these results.

| Guard | Deliberate break | Red result | Restored |
|---|---|---|---|
| K1 | Remove RelatedPerson writeConstraint | Claim strip returns 200 instead of 403; claimed create also returns 201 | 26 passed, 0 failed, 0 skipped |
| K2 | Drop create clause | Claimed create returns 201 instead of 403 | 26 passed, 0 failed, 0 skipped |
| K3 | Use bare equality on update | Unclaimed-child update returns 403 instead of 200 | 26 passed, 0 failed, 0 skipped |
| K4 | Drop claims in demographics merge | Real editor name/phone save loses inert claim; preservation assertion fails | 1 passed, 0 failed |
| K5 | Omit new subscriber transaction entry | Insurance/INS2 suite: 4 failed, including U2, U3 and U5 | 15 passed, 0 failed |
| K6 | Remove harness's non-loopback fixture write | Under documented loopback runtime, expected ERR_ASSERTION becomes the network-stub error | Both controls pass; 0 real requests |

The compiled-rule test was also broken by removing the constraint and restored (`compiler-*.log`). K6 separately verifies byte-for-byte restoration after success and failure, plus removal when runtime.json was initially absent. Its positive control reaches exactly one stub call and zero real requests.

K4 live proof calls production `saveGuarantor`: relative FHIR requests are forwarded to the disposable server with a staff token and original If-Match headers. The inert-operation lookup is forwarded to a real missing Task read using the seeder identity, returning 404. The editor's Person and RelatedPerson writes and final reads all use the staff token. The UI control test separately covers form wiring. There is no browser screenshot claim for this policy-only change.

## Reproduction and limits

Use the existing CI live-authorization provisioning sequence, then `npm --prefix mcp run test:live-authz`. The new cases are in its existing `clinicalWriteAuthzLive.test.ts`; the workflow's live lane is blocking. Local proof used a separate Compose project `odos-claim-fence`, separate database/binary volumes, subnet `10.249.93.0/24`, Medplum `127.0.0.1:20113` and PostgreSQL `127.0.0.1:20132`. No Iris sync or practice writes occurred.

The F1 harness command and exact outputs are documented in the adjacent `guarantor-f1-fixback/README.md`. Only its evidence files changed.

The first full MCP attempt failed from local fixture configuration: operator-state files collided with synthetic CLI project names and database tests tried the default unused 5433 port. The rerun isolates the operator files under ignored `.odos/claim-fence/` and explicitly sets ODOS_POSTGRES_URL to the disposable database. No production repair was made for those environment failures.

Independent Claude Opus evaluation and an operator-authorized post-merge Iris policy sync remain separate steps. This author session posts no evaluation marker.

## Regression results

| Command | Actual result |
|---|---|
| `npm test` from `ui/` | 1,560 passed, 0 failed, 0 skipped |
| `ODOS_POSTGRES_URL=<disposable localhost database> ODOS_ALLOW_UNGATED_MCP=1 npm --prefix mcp test` | 5,010 passed, 0 failed, 51 skipped; credentials-dependent integration cases are separate |
| `npm --prefix mcp run test:live-authz` with disposable credentials | 53 passed, 0 failed, 0 skipped |
| `node --import tsx --test tests/guarantorEditor.test.tsx tests/guarantorPhoneForm.test.tsx tests/guarantorLinkOperations.test.tsx tests/patientInsurance.test.tsx` from `ui/` | 44 passed, 0 failed, 0 skipped |
| `node --import tsx --test --test-concurrency=1 tests/guarantorLinkPolicy.test.ts tests/roleGrants.test.ts tests/threeRoleModel.test.ts tests/patientRegistrationAuthz.test.ts tests/guarantorLinkOperation.test.ts tests/guarantorOwnedRecovery.test.ts tests/guarantorRegistrationAttach.test.ts tests/patientInsuranceHonestSave.test.ts tests/patientInsuranceRoutes.test.ts tests/commsApi.test.ts` from `mcp/` | 272 passed, 0 failed, 0 skipped |
| `npm --prefix ui run build`; `npm --prefix mcp run build` | Both exit 0; existing Vite chunk-size advisory |
| `npm run preflight` | 0 warnings, 0 hard blocks |

Committed regression logs contain exact output tails; full local logs are retained in ignored `.odos/claim-fence/`. Guard logs and the live-authz log are complete. The unit-oriented full MCP command explicitly acknowledges its skips and is not offered as live-authorization proof; the separate 53-test lane supplies that proof. CI results and bot disposition must be checked at the final PR SHA.
