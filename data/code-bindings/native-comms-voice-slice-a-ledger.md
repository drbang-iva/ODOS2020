# Native communications Voice Slice A verification ledger

Access date: 2026-08-01

Scope: Twilio Programmable Voice call creation, call detail/history, signed inbound and status
webhooks, inbound TwiML routing, recording media retrieval, and current Batch Transcription
retrieval. All Twilio calls in tests are mocked. No real call, recording, transcript, credential,
account mutation, or Twilio Console change was used.

| Artifact | Chosen value | Primary source 1 | Primary source 2 | Status |
|---|---|---|---|---|
| Outbound call creation | `client.calls.create` supplies E.164 `to`/`from`, inline TwiML, and `initiated`, `ringing`, `answered`, and `completed` status callbacks; the returned Call SID is the provider call id | https://www.twilio.com/docs/voice/api/call-resource | https://github.com/twilio/twilio-node/blob/6.0.2/src/rest/api/v2010/account/call.ts | verified |
| Click-to-call order and outbound caller ID | ODOS first rings the configured staff endpoint, then TwiML `<Dial>` calls the patient with the configured Twilio/verified practice number as `callerId` | https://www.twilio.com/docs/voice/twiml/dial | https://www.twilio.com/docs/voice/twiml/number | verified |
| Inbound answer/routing and caller ID | Twilio requests instructions from the number's webhook; ODOS validates the request, parses `From` as caller ID, and returns `<Dial answerOnBridge="true">` without overriding `callerId`, preserving the inbound caller's number for the staff endpoint | https://www.twilio.com/docs/voice/tutorials/how-to-respond-to-incoming-phone-calls | https://www.twilio.com/docs/voice/twiml/dial | verified |
| Call status event shape | Signed form callbacks include `AccountSid`, `CallSid`, `From`, `To`, `Direction`, and `CallStatus`; callback events may arrive out of order, so `SequenceNumber` is retained when present | https://www.twilio.com/docs/voice/api/call-resource#statuscallback | https://www.twilio.com/docs/voice/twiml#twilios-request-to-your-application | verified |
| Webhook authenticity | Validate `X-Twilio-Signature` against the exact externally configured URL before trusting payload fields; form payloads use the official SDK `validateRequest` helper | https://www.twilio.com/docs/usage/webhooks/webhooks-security | https://github.com/twilio/twilio-node/blob/6.0.2/src/webhooks/webhooks.ts | verified |
| Call detail and history | Retrieve one Call by Call SID or list bounded account Calls through the official SDK and normalize the documented status, direction, timestamps, and duration | https://www.twilio.com/docs/voice/api/call-resource | https://github.com/twilio/twilio-node/blob/6.0.2/src/rest/api/v2010/account/call.ts | verified |
| Recording metadata and media | Fetch completed Recording metadata and authenticated MP3 media from the Recording resource; media URLs require HTTP Basic authentication | https://www.twilio.com/docs/voice/api/recording | https://github.com/twilio/twilio-node/blob/6.0.2/src/rest/api/v2010/account/recording.ts | verified; fetch only |
| Batch Transcription retrieval | Fetch an existing v3 Batch Transcription by `voice_transcription_…` id and flatten its ordered sentence text. ODOS does not create transcription jobs: the API is Public Beta, not HIPAA eligible, and the legacy Recording Transcriptions API is deprecated | https://www.twilio.com/docs/voice/api/batch-transcription-resource | https://www.twilio.com/docs/voice/api/recording-transcription | verified; generation blocked |
| Restricted API key scope | Restricted keys grant endpoint-specific permissions. Voice call create/read/list and recording access require Voice permissions; a Messaging-only key cannot authorize them. ODOS therefore requires a separate Voice key instead of widening the existing Messaging key | https://www.twilio.com/docs/iam/api-keys/restricted-api-keys | https://docs-resources.prod.twilio.com/documents/Twilio_Restricted_API_Keys_Permissions_-_Voice_Permissions.pdf | verified; new scoped credential required outside this slice |

## Local boundaries

| Boundary | Evidence 1 | Evidence 2 | Status |
|---|---|---|---|
| No automatic recording or transcription | Call creation and inbound TwiML omit recording flags; the adapter exposes fetch-only methods and no transcription-create method | `mcp/src/comms/adapters/twilio-adapter.ts` | `mcp/tests/twilioAdapter.test.ts` | verified |
| SMS routes are no longer parser-only | `/comms/twilio/inbound` and `/comms/twilio/status` are mounted beside signed Voice inbound/status/recording routes when the exact webhook origin is configured | `mcp/src/comms/twilio-routes.ts` | `mcp/tests/twilioRoutes.test.ts` | verified |
| UI and Call Pop remain deferred | No file under `ui/` changed; no patient search by phone or patient chart lookup was added | `git diff --name-only origin/main...HEAD` | accepted Slice A scope | verified |
