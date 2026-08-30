import assert from "node:assert/strict";
import { test } from "node:test";
import { createAwsSmsAdapter } from "../src/comms/adapters/aws-sms-adapter.js";

const CONFIG = {
  region: "us-east-1",
  originationIdentity:
    "arn:aws:sms-voice:us-east-1:123456789012:phone-number/phone-11111111111111111111111111111111",
  inboundQueueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/odos-sms-inbound",
  inboundTopicArn: "arn:aws:sns:us-east-1:123456789012:odos-sms-inbound",
};

const REQUEST = {
  patientReference: "Patient/synthetic-1",
  toNumber: "+18645550199",
  body: "Synthetic appointment reminder.",
  campaignType: "appointment-reminder",
  suppression: {},
};

test("AWS SDK sends one transactional SMS through the configured origination identity", async () => {
  const commands: Array<{ input: Record<string, unknown> }> = [];
  const adapter = createAwsSmsAdapter(CONFIG, {
    client: {
      async send(command: unknown) {
        commands.push(command as { input: Record<string, unknown> });
        return { MessageId: "synthetic-aws-message-id" };
      },
    },
  });

  const result = await adapter.sendSms!(REQUEST);

  assert.equal(
    adapter.messageIdentifierSystem,
    "https://odos2020.com/fhir/NamingSystem/aws-end-user-messaging-message-id",
  );
  assert.deepEqual(result, {
    outcome: "sent",
    providerMessageId: "synthetic-aws-message-id",
  });
  assert.equal(commands[0]?.constructor.name, "SendTextMessageCommand");
  assert.deepEqual(commands[0]?.input, {
    DestinationPhoneNumber: "+18645550199",
    OriginationIdentity: CONFIG.originationIdentity,
    MessageBody: "Synthetic appointment reminder. Reply STOP to unsubscribe.",
    MessageType: "TRANSACTIONAL",
  });
});

test("AWS SMS validates the boundary and requires a provider message id", async () => {
  let sends = 0;
  const adapter = createAwsSmsAdapter(CONFIG, {
    client: {
      async send() {
        sends += 1;
        return {};
      },
    },
  });

  await assert.rejects(
    adapter.sendSms!({ ...REQUEST, toNumber: "8645550199" }),
    /AWS SMS recipient must use E\.164/i,
  );
  assert.equal(sends, 0);
  await assert.rejects(adapter.sendSms!(REQUEST), /AWS SendTextMessage response is missing MessageId/i);
  assert.equal(sends, 1);
});

test("AWS SMS preserves SDK failures unchanged", async () => {
  const failure = Object.assign(new Error("synthetic AWS failure"), {
    name: "ThrottlingException",
  });
  const adapter = createAwsSmsAdapter(CONFIG, {
    client: { send: async () => { throw failure; } },
  });

  await assert.rejects(adapter.sendSms!(REQUEST), (error) => error === failure);
});
