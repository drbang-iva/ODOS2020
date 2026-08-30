# AWS Communications Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one-active-provider SMS configuration, AWS End User Messaging SMS sending, SNS-to-SQS inbound polling, and shared Twilio/AWS opt-out enforcement.

**Architecture:** External communications selection uses scalar provider fields and is converted to internal adapter registrations. AWS outbound sending implements the unchanged `CommsProvider` seam; AWS inbound messages are normalized into a provider-neutral event and persisted through a shared inbound path. One updater in `suppression-gate.ts` records inbound STOP state on the Patient, and both Twilio persistence and the AWS pull receiver invoke it.

**Tech Stack:** TypeScript, Node test runner, FHIR R4 Patient/Communication resources, AWS SDK v3 `@aws-sdk/client-pinpoint-sms-voice-v2` and `@aws-sdk/client-sqs` 3.1121.0.

**Spec:** `performance-od/decisions/2026-08-30-odos-comms-provider-routing-design.md`, supplied inline in the user handoff for this build.

## Global Constraints

- `sms_provider` is one scalar: `aws`, `twilio`, `ghl`, or absent.
- `voice_provider` is one scalar: `twilio`, `ghl`, `none`, or absent; `aws` is invalid.
- Legacy `ODOS_COMMS_PROVIDERS` and `ODOS_COMMS_CHANNEL_ROUTES` fail with an explicit migration error; they are never coerced.
- `CommsProvider` remains unchanged.
- Twilio parsing, signature validation, sending, and routing remain unchanged; only inbound persistence gains the approved suppression call.
- AWS inbound uses SNS to SQS and ordinary AWS SDK authentication; no SNS HTTPS route or signature verification is added.
- The live AWS number is not mutated and two-way messaging is not enabled by this plan.
- Tests use synthetic phone numbers, identifiers, AWS responses, and FHIR resources only.

---

### Task 1: Scalar Provider Configuration and Dispatch Fence

**Files:**
- Modify: `mcp/src/comms/comms-config.ts`
- Modify: `mcp/tests/commsConfig.test.ts`
- Modify: `.env.example`
- Modify: `docs/install.md`
- Modify: `docs/google-workspace-comms.md`

**Interfaces:**
- Produces: `CommsProviderConfig` with scalar `sms_provider`, `voice_provider`, and `email_provider` fields.
- Produces: `commsProviderConfigFromEnv(env)` and scalar-derived channel assignments.
- Enforces: an adapter exposes `sendSms` only when it is the selected SMS provider and Voice methods only when it is the selected Voice provider.

- [ ] **Step 1: Write the failing scalar-config tests**

```ts
assert.deepEqual(commsProviderConfigFromEnv({
  ODOS_COMMS_SMS_PROVIDER: "aws",
  ODOS_COMMS_VOICE_PROVIDER: "twilio",
}), { sms_provider: "aws", voice_provider: "twilio" });
assert.throws(
  () => commsProviderConfigFromEnv({ ODOS_COMMS_SMS_PROVIDER: "aws,twilio" }),
  /must be exactly one of aws, twilio, ghl/,
);
assert.throws(
  () => commsProviderConfigFromEnv({ ODOS_COMMS_PROVIDERS: "aws,twilio" }),
  /breaking configuration migration/,
);
```

- [ ] **Step 2: Run the config test and verify RED**

Run: `npm test -- tests/commsConfig.test.ts`
Expected: FAIL because `commsProviderConfigFromEnv` and AWS registration do not exist.

- [ ] **Step 3: Implement the scalar parser and dispatch fence**

```ts
export interface CommsProviderConfig {
  sms_provider?: "aws" | "twilio" | "ghl";
  voice_provider?: "twilio" | "ghl" | "none";
  email_provider?: "google-workspace" | "none";
}
```

Convert the scalar selections into unique internal registrations and channel assignments. Reject both legacy list variables. Remove inactive channel methods at the returned dispatch boundary so provider overrides cannot reach a second SMS adapter.

- [ ] **Step 4: Run the config test and verify GREEN**

Run: `npm test -- tests/commsConfig.test.ts`
Expected: all `commsConfig` tests pass with zero failures.

### Task 2: AWS Outbound SMS Adapter

**Files:**
- Create: `mcp/src/comms/adapters/aws-sms-adapter.ts`
- Create: `mcp/tests/awsSmsAdapter.test.ts`
- Modify: `mcp/src/comms/comms-config.ts`
- Modify: `mcp/src/comms/comms-persistence.ts`
- Modify: `mcp/package.json`
- Modify: `mcp/package-lock.json`

**Interfaces:**
- Produces: `AwsSmsAdapterConfig` with `region`, `originationIdentity`, `inboundQueueUrl`, and `inboundTopicArn`.
- Produces: `createAwsSmsAdapter(config, deps): CommsProvider`.
- Produces: `ODOS_AWS_MESSAGE_IDENTIFIER_SYSTEM` for persisted sends and inbound messages.

- [ ] **Step 1: Write the failing adapter tests**

```ts
const result = await createAwsSmsAdapter(config, { client }).sendSms!({
  patientReference: "Patient/synthetic-1",
  toNumber: "+18645550199",
  body: "Synthetic appointment reminder.",
  campaignType: "appointment-reminder",
  suppression: {},
});
assert.deepEqual(result, { outcome: "sent", providerMessageId: "synthetic-message-id" });
assert.deepEqual(command.input, {
  DestinationPhoneNumber: "+18645550199",
  OriginationIdentity: config.originationIdentity,
  MessageBody: "Synthetic appointment reminder. Reply STOP to unsubscribe.",
  MessageType: "TRANSACTIONAL",
});
```

- [ ] **Step 2: Run the adapter test and verify RED**

Run: `npm test -- tests/awsSmsAdapter.test.ts`
Expected: FAIL because the AWS adapter module does not exist.

- [ ] **Step 3: Install pinned SDK clients and implement minimal send behavior**

Run: `npm install --save-exact @aws-sdk/client-pinpoint-sms-voice-v2@3.1121.0 @aws-sdk/client-sqs@3.1121.0`

Construct `SendTextMessageCommand` with one E.164 destination, the configured phone-number ARN, transactional message type, and required opt-out language. Require a non-empty AWS `MessageId`; preserve SDK exceptions unchanged.

- [ ] **Step 4: Run the adapter test and verify GREEN**

Run: `npm test -- tests/awsSmsAdapter.test.ts`
Expected: all AWS adapter tests pass with zero failures.

### Task 3: Provider-Neutral Inbound Persistence and Suppression

**Files:**
- Create: `mcp/src/comms/inbound-receiver.ts`
- Modify: `mcp/src/comms/suppression-gate.ts`
- Modify: `mcp/src/comms/comms-persistence.ts`
- Create: `mcp/tests/inboundSuppression.test.ts`

**Interfaces:**
- Produces: `InboundMessageEvent` with provider, provider message identity, from, to, body, and optional `STOP`, `START`, or `HELP` classification.
- Produces: discriminated `PushInboundReceiver | PullInboundReceiver` abstraction.
- Produces: `persistInboundMessageEvent(fhir, event, deps)`.
- Produces: `updateInboundSuppression(fhir, event)` in `suppression-gate.ts`.

- [ ] **Step 1: Write failing Twilio STOP integration test**

```ts
await persistTwilioWebhookEvent(fhir, "sms-inbound", {
  accountSid: syntheticAccountSid,
  messageSid: syntheticMessageSid,
  from: "+18645550199",
  to: "+18645550100",
  body: "STOP",
  optOutType: "STOP",
});
const result = await suppressedTwilio.sendSms!(syntheticSend);
assert.deepEqual(result, { outcome: "suppressed", reason: "patient-opt-out" });
assert.equal(twilioSendCount, 0);
```

- [ ] **Step 2: Run the suppression test and verify RED**

Run: `npm test -- tests/inboundSuppression.test.ts`
Expected: FAIL because Twilio inbound persistence does not update Patient suppression.

- [ ] **Step 3: Implement normalized persistence and the single updater**

For `STOP`, add one exact SMS-channel opt-out extension if absent. For `START`, remove only the exact SMS-channel extension created by this updater. For `HELP` or an unmatched patient, leave Patient state unchanged. Use an `If-Match` version fence for Patient updates.

- [ ] **Step 4: Wire Twilio persistence and verify GREEN**

Run: `npm test -- tests/inboundSuppression.test.ts tests/commsPersistence.test.ts`
Expected: Twilio STOP blocks a real Twilio adapter send; existing persistence tests remain green.

### Task 4: AWS SQS Pull Receiver and AWS Guard Proof

**Files:**
- Create: `mcp/src/comms/aws-sqs-inbound-receiver.ts`
- Create: `mcp/tests/awsSqsInboundReceiver.test.ts`
- Modify: `mcp/src/index.ts`

**Interfaces:**
- Produces: `createAwsSqsInboundReceiver(config, deps): PullInboundReceiver`.
- Consumes: SNS `Notification` envelope from the configured topic and AWS two-way SMS payload from its `Message` field.
- Deletes: an SQS message only after normalized persistence and `updateInboundSuppression` both succeed.

- [ ] **Step 1: Write failing poll/delete and AWS STOP integration tests**

```ts
const processed = await receiver.pollOnce();
assert.equal(processed, 1);
assert.equal(deleteCount, 1);
const result = await suppressedAws.sendSms!(syntheticSend);
assert.deepEqual(result, { outcome: "suppressed", reason: "patient-opt-out" });
assert.equal(awsSendCount, 0);
```

Add a wrong-topic fixture and assert that it is not deleted.

- [ ] **Step 2: Run the receiver test and verify RED**

Run: `npm test -- tests/awsSqsInboundReceiver.test.ts`
Expected: FAIL because the receiver module does not exist.

- [ ] **Step 3: Implement long polling and runtime startup**

Receive up to ten messages with `WaitTimeSeconds: 20`. Validate the configured SNS topic ARN and the documented AWS inbound fields, classify required opt-out keywords, persist the normalized event, apply suppression, then delete by receipt handle. Log identifiers or payload content nowhere.

- [ ] **Step 4: Run receiver and combined guard tests and verify GREEN**

Run: `npm test -- tests/awsSqsInboundReceiver.test.ts tests/inboundSuppression.test.ts`
Expected: both AWS and Twilio STOP paths block their subsequent provider sends.

### Task 5: Operator Handoff, Evidence, and Full Verification

**Files:**
- Create: `data/code-bindings/native-comms-aws-ledger.md`
- Modify: `.env.example`
- Modify: `docs/install.md`

**Interfaces:**
- Documents: required SDK permissions, topic policy, queue policy, SNS subscription, queue URL/topic ARN config, and delayed two-way enablement.
- Records: AWS primary-source URLs and access date `2026-08-30`.

- [ ] **Step 1: Add manual infra commands without executing them**

Document creation of one Standard SNS topic, one Standard SQS queue, the `sms-voice.amazonaws.com` topic publish policy, the topic-scoped `sqs:SendMessage` queue policy, an SQS subscription with default SNS envelope delivery, and runtime IAM permissions for `sms-voice:SendTextMessage`, `sqs:ReceiveMessage`, and `sqs:DeleteMessage`.

- [ ] **Step 2: Record Mandate 17 RED/GREEN evidence**

Run the scalar-schema mutation with `ODOS_COMMS_SMS_PROVIDER=aws,twilio` and record the exact validation failure. Temporarily disable each inbound suppression call, run its focused integration test to show failure, restore the call, and rerun to green.

- [ ] **Step 3: Run verification**

Run:

```sh
npm run build
npm test -- tests/awsSmsAdapter.test.ts tests/awsSqsInboundReceiver.test.ts tests/inboundSuppression.test.ts tests/commsConfig.test.ts tests/commsPersistence.test.ts
ODOS_ALLOW_UNGATED_MCP=1 npm test
npm run preflight
```

Expected: build succeeds; focused and full executed tests report zero failures; preflight succeeds; live-stack skips remain explicitly disclosed.

- [ ] **Step 4: Commit, push, and open the PR**

```sh
git add .env.example docs mcp data/code-bindings/native-comms-aws-ledger.md
git commit -m "Add AWS SMS communications adapter"
git push -u origin drbang-iva/aws-comms
gh pr create --base main --head drbang-iva/aws-comms --title "Add AWS SMS communications adapter" --body-file /tmp/odos-aws-comms-pr.md
```

Report the exact final head, checks, unresolved review threads, manual infra steps, live-proof limits, and independent-evaluation requirement.
