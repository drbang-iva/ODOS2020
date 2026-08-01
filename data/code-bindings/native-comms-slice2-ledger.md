# Native communications Slice 2 verification ledger

Access date: 2026-08-01

Scope: Twilio Programmable Messaging send adapter, SMS recipient resolution and suppression,
Twilio platform opt-out behavior, inbound/status webhook parsing, and FHIR R4 `Communication`
reminder records. All Twilio HTTP calls in this slice's tests are mocked; no real credential,
Twilio API call, or message send was used.

## Twilio Programmable Messaging

| Artifact | Chosen value | Source 1 URL | Source 2 URL | Access date | Status |
|---|---|---|---|---|---|
| Outbound SMS endpoint and payload | Form-encoded `POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json`; request supplies `To`, `Body`, and either `MessagingServiceSid` or `From`; success returns a Message SID | https://www.twilio.com/docs/messaging/api/message-resource | https://www.twilio.com/docs/messaging/services | 2026-08-01 | verified |
| API authentication | HTTP Basic authentication; API Key SID + secret is recommended for production; Account SID + Auth Token remains supported for local testing; the practice Auth Token remains required for webhook validation | https://www.twilio.com/docs/messaging/api | https://www.twilio.com/docs/usage/requests-to-twilio | 2026-08-01 | verified |
| STOP/START enforcement and error 21610 | Twilio maintains the sender/recipient block, blocks later sends after STOP, reports opted-out recipient attempts as 21610, and removes the block after START; ODOS does not retry 21610 | https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out | https://www.twilio.com/docs/api/errors/21610 | 2026-08-01 | verified |
| Outbound opt-out language | Twilio policy requires the initial message to include `Reply STOP to unsubscribe` or equivalent and recommends reminders for recurring programs; A2P campaign examples direct registrants to indicate an opt-out mechanism in every sample message. ODOS conservatively includes it in every outbound SMS. | https://www.twilio.com/en-us/legal/messaging-policy | https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/quickstart | 2026-08-01 | verified |
| Inbound opt-out event | With Advanced Opt-Out enabled on a Messaging Service, the form webhook may include `OptOutType` with `STOP`, `START`, or `HELP`; default/advanced keyword processing and replies remain Twilio-owned | https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out | https://help.twilio.com/articles/31560110671259-How-to-Track-Opt-Out-Opt-In-and-Help-Messages-Using-the-OptOutType-Parameter | 2026-08-01 | verified |
| Status callback opt-out signal | Form-encoded status callbacks include `MessageSid`, `MessageStatus`, and `ErrorCode`; ODOS projects `ErrorCode=21610` as recipient opted out | https://www.twilio.com/docs/messaging/guides/track-outbound-message-status | https://www.twilio.com/docs/messaging/guides/debugging-tools | 2026-08-01 | verified |
| Webhook authenticity | Twilio supplies `X-Twilio-Signature`; validate from the exact external URL plus every form parameter using HMAC-SHA1 with the practice Auth Token before reading payload fields | https://www.twilio.com/docs/usage/security | https://www.twilio.com/docs/usage/webhooks/webhooks-security | 2026-08-01 | verified |
| HIPAA/BAA prerequisite | Programmable SMS is HIPAA-eligible only in an appropriately designated Twilio HIPAA account with a signed BAA; HIPAA Accounts require Security or Enterprise Edition; compliance remains shared responsibility | https://www.twilio.com/en-us/hipaa | https://www.twilio.com/docs/iam/twilio-editions/hippa | 2026-08-01 | verified |
| Compliance Toolkit | Twilio says Compliance Toolkit became HIPAA-eligible on 2026-06-30, but Slice 2 does not call or depend on it; standard Messaging Service opt-out enforcement is sufficient | https://www.twilio.com/en-us/changelog/compliance-toolkit-is-now-hipaa-eligible | https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out | 2026-08-01 | verified; not consumed |

## FHIR R4 persistence

Element names are compiled against the installed `@medplum/fhirtypes` R4 declarations with
`cd mcp && npx tsc --noEmit`.

| Artifact | Chosen value | Source 1 URL | Source 2 URL | Access date | Status |
|---|---|---|---|---|---|
| SMS reminder send-state | Reuse Slice 1 `Communication` records with `identifier`, `status`, `category`, `medium=sms`, `subject`, `recipient`, `about`, `payload.contentString`, `sent`, and provider-message-id extension | https://hl7.org/fhir/R4/communication.html | https://build.fhir.org/communication.html | 2026-08-01 | verified |
| SMS destination resolution | Use an active, non-`old` `Patient.telecom` ContactPoint with `system=phone`, unless the caller supplies an explicit override; Twilio boundary then requires E.164 | https://hl7.org/fhir/R4/patient.html | https://build.fhir.org/patient.html | 2026-08-01 | verified |

## Local behavior and bounded omissions

| Artifact | Chosen value | Evidence 1 | Evidence 2 | Status |
|---|---|---|---|---|
| Every outbound SMS includes opt-out language | Adapter appends `Reply STOP to unsubscribe.` when a caller template omits it; default SMS reminder templates carry it explicitly | `mcp/src/comms/adapters/twilio-adapter.ts` | `mcp/tests/twilioAdapter.test.ts` | verified (local; stricter than Twilio's initial-message floor) |
| Local suppression mirror | Existing ODOS patient/channel opt-out extension suppresses SMS before provider dispatch; Twilio remains the authoritative carrier-side block and 21610 signal | `mcp/src/comms/suppression-gate.ts` | `mcp/tests/commsSuppression.test.ts` | verified (local) |
| Webhook boundary | Slice 2 provides signature-first inbound and status handlers, but does not register a public webhook route or build inbound conversation persistence/UI; those remain Phase 3b work | `mcp/src/comms/adapters/twilio-adapter.ts` | accepted Slice 2 scope | verified (local); intentionally bounded |
