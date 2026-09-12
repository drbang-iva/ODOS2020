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
| Webhook authenticity | Twilio supplies `X-Twilio-Signature`; use the official SDK with the exact externally configured URL. Form bodies use `validateRequest`; JSON bodies use `validateRequestWithBody`, which also verifies `bodySHA256` against the raw body. | https://www.twilio.com/docs/usage/security | https://www.twilio.com/docs/usage/webhooks/webhooks-security | 2026-08-01 | verified |
| HIPAA/BAA prerequisite | Programmable SMS is HIPAA-eligible only in an appropriately designated Twilio HIPAA account with a signed BAA; HIPAA Accounts require Security or Enterprise Edition; compliance remains shared responsibility | https://www.twilio.com/en-us/hipaa | https://www.twilio.com/docs/iam/twilio-editions/hippa | 2026-08-01 | verified |
| Compliance Toolkit | Twilio says Compliance Toolkit became HIPAA-eligible on 2026-06-30, but Slice 2 does not call or depend on it; standard Messaging Service opt-out enforcement is sufficient | https://www.twilio.com/en-us/changelog/compliance-toolkit-is-now-hipaa-eligible | https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out | 2026-08-01 | verified; not consumed |

## Official Node SDK conversion

| Artifact | Chosen value | Source 1 URL | Source 2 URL | Access date | Status |
|---|---|---|---|---|---|
| Package and exact version | Official `twilio` Node helper library, version `6.0.2`, MIT licensed, Node 20+ | https://www.npmjs.com/package/twilio/v/6.0.2 | https://github.com/twilio/twilio-node/blob/6.0.2/package.json | 2026-08-01 | verified |
| Client construction and timeout | Construct with account credentials, or API Key SID + secret with `accountSid`; set SDK client option `timeout: 30000` milliseconds, which the SDK supplies to its request client, HTTPS agent, and Axios request rather than using an ODOS-owned timer | https://www.twilio.com/docs/libraries/reference/twilio-node/ | https://github.com/twilio/twilio-node/blob/6.0.2/src/base/RequestClient.ts | 2026-08-01 | verified |
| Message create call | `client.messages.create` accepts `to`, `body`, and either `messagingServiceSid` or `from`; the returned Message instance exposes `sid` | https://www.twilio.com/docs/messaging/api/message-resource | https://github.com/twilio/twilio-node/blob/6.0.2/src/rest/api/v2010/account/message.ts | 2026-08-01 | verified |
| Form and JSON validators | Use `validateRequest(authToken, signature, url, params)` for form bodies and `validateRequestWithBody(authToken, signature, url, rawBody)` for JSON; the latter checks the URL signature and `bodySHA256` | https://www.twilio.com/docs/usage/webhooks/webhooks-security | https://github.com/twilio/twilio-node/blob/6.0.2/src/webhooks/webhooks.ts | 2026-08-01 | verified |
| SDK error shape | Failed SDK requests throw `RestException`, which retains numeric `status` and optional numeric `code`; preserve the exception unchanged except for the existing code `21610` suppression mapping | https://www.twilio.com/docs/usage/twilios-response | https://github.com/twilio/twilio-node/blob/6.0.2/src/base/RestException.ts | 2026-08-01 | verified |
| Published signature vectors | Use Twilio's published token `12345` form and JSON/bodySHA256 vectors verbatim; both official SDK suites agree on URL, parameters/body, hashes, and expected signatures | https://github.com/twilio/twilio-node/blob/6.0.2/spec/validation.spec.js | https://github.com/twilio/twilio-python/blob/becbfc5a163b0aaceb139f59b7327cba1e2dfaf5/tests/unit/test_request_validator.py | 2026-08-01 | verified |

## FHIR R4 persistence

Element names are compiled against the installed `@medplum/fhirtypes` R4 declarations with
`cd mcp && npx tsc --noEmit`.

| Artifact | Chosen value | Source 1 URL | Source 2 URL | Access date | Status |
|---|---|---|---|---|---|
| SMS reminder send-state | Reuse Slice 1 `Communication` records with `identifier`, `status`, `category`, `medium=sms`, `subject`, `recipient`, `about`, `payload.contentString`, `sent`, and provider-message-id extension | https://hl7.org/fhir/R4/communication.html | https://build.fhir.org/communication.html | 2026-08-01 | verified |
| SMS destination resolution | Unless the caller supplies an explicit override, rank active, non-`old` `Patient.telecom` ContactPoints as `system=sms`, then `use=mobile` phone, then another active phone; Twilio boundary then requires E.164 | https://hl7.org/fhir/R4/patient.html | https://build.fhir.org/patient.html | 2026-08-01 | verified |

## Local behavior and bounded omissions

| Artifact | Chosen value | Evidence 1 | Evidence 2 | Status |
|---|---|---|---|---|
| Every outbound SMS includes opt-out language | Adapter appends `Reply STOP to unsubscribe.` when a caller template omits it; default SMS reminder templates carry it explicitly | `mcp/src/comms/adapters/twilio-adapter.ts` | `mcp/tests/twilioAdapter.test.ts` | verified (local; stricter than Twilio's initial-message floor) |
| Local suppression mirror | Existing ODOS patient/channel opt-out extension suppresses SMS before provider dispatch; Twilio remains the authoritative carrier-side block and 21610 signal | `mcp/src/comms/suppression-gate.ts` | `mcp/tests/commsSuppression.test.ts` | verified (local) |
| Webhook boundary | Slice 2 provided signature-first inbound and status handlers without a public route. Voice Slice A later mounted both SMS routes plus the Voice routes when `TWILIO_WEBHOOK_BASE_URL` is configured; inbound conversation persistence/UI remains deferred. | `mcp/src/comms/adapters/twilio-adapter.ts` | `data/code-bindings/native-comms-voice-slice-a-ledger.md` | verified (local); Slice A closed the route gap |

## Item 1a: textable-number marker

Access date: 2026-09-12. The new ODOS canonical URL is locally authored; the sources
below verify its FHIR representation, not publication of an HL7-owned extension.

| Artifact | Chosen value | Source 1 URL | Source 2 URL | Access date | Status |
|---|---|---|---|---|---|
| Simple extension base | `http://hl7.org/fhir/StructureDefinition/Extension`; fixed canonical URL; nested extensions prohibited; boolean value | https://hl7.org/fhir/R4/extensibility.html | https://hl7.org/fhir/R4/extension.profile.json.html | 2026-09-12 | verified; sources agree |
| Context and constraints | Patient context, extension 0..1, value 1..1 with `fixedBoolean: true` | https://hl7.org/fhir/R4/defining-extensions.html | https://hl7.org/fhir/R4/elementdefinition-definitions.html | 2026-09-12 | verified FHIR constraint mechanics; Patient-only semantics are the ODOS contract |
