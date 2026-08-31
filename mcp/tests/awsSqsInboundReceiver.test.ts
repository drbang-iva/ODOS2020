import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, Patient, Resource } from "@medplum/fhirtypes";
import { createAwsSmsAdapter } from "../src/comms/adapters/aws-sms-adapter.js";
import { createAwsSqsInboundReceiver } from "../src/comms/aws-sqs-inbound-receiver.js";
import type { InboundMessageEvent } from "../src/comms/inbound-receiver.js";
import { createSuppressedCommsProvider, ODOS_COMMS_OPT_OUT_EXTENSION_URL } from "../src/comms/suppression-gate.js";

const CONFIG = {
  region: "us-east-1",
  originationIdentity:
    "arn:aws:sms-voice:us-east-1:123456789012:phone-number/phone-11111111111111111111111111111111",
  inboundQueueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/odos-sms-inbound",
  inboundTopicArn: "arn:aws:sns:us-east-1:123456789012:odos-sms-inbound",
};
const PATIENT_NUMBER = "+18645550199";
const PRACTICE_NUMBER = "+18485550100";

test("AWS SQS STOP-equivalent delivery uses the shared gate and blocks AWS outbound SMS", async () => {
  const fhir = new InMemorySuppressionFhir({
    resourceType: "Patient",
    id: "synthetic-1",
    meta: { versionId: "1" },
    telecom: [{ system: "phone", use: "mobile", value: PATIENT_NUMBER }],
  });
  const received: InboundMessageEvent[] = [];
  let deletes = 0;
  let queueReads = 0;
  const info: string[] = [];
  const receiver = createAwsSqsInboundReceiver(CONFIG, {
    fhir,
    onMessage: async (event) => { received.push(event); },
    info: (message) => info.push(message),
    client: {
      async send(command) {
        if (command.constructor.name === "ReceiveMessageCommand") {
          queueReads += 1;
          return { Messages: queueReads === 1 ? [{
            MessageId: "sqs-message-1",
            ReceiptHandle: "receipt-1",
            Body: JSON.stringify({
              Type: "Notification",
              TopicArn: CONFIG.inboundTopicArn,
              Message: JSON.stringify({
                originationNumber: PATIENT_NUMBER,
                destinationNumber: PRACTICE_NUMBER,
                messageKeyword: "CANCEL",
                messageBody: "CANCEL",
                inboundMessageId: "aws-inbound-1",
              }),
            }),
          }] : [] };
        }
        deletes += 1;
        return {};
      },
    },
  });

  assert.equal(await receiver.pollOnce(), 1);
  assert.equal(deletes, 1);
  assert.equal(received[0]?.provider, "aws");
  assert.equal(received[0]?.optOutType, "STOP");
  assert.equal(received[0]?.providerMessageId, "aws-inbound-1");
  assert.deepEqual(info, [
    "odos-mcp: AWS inbound SMS suppression outcome=opted-out matchedPatients=1",
  ]);

  let sends = 0;
  const outbound = createSuppressedCommsProvider(createAwsSmsAdapter(CONFIG, {
    client: { async send() { sends += 1; return { MessageId: "aws-outbound-1", $metadata: {} }; } },
  }), { fhir, practiceTimeZone: "UTC", now: () => new Date("2026-08-30T15:00:00.000Z") });
  const result = await outbound.sendSms!({
    patientReference: "Patient/synthetic-1",
    body: "Synthetic follow-up",
    campaignType: "manual",
    suppression: {},
  });
  assert.deepEqual(result, { outcome: "suppressed", reason: "patient-opt-out" });
  assert.equal(sends, 0);
  assert.equal(fhir.patient.extension?.[0]?.url, ODOS_COMMS_OPT_OUT_EXTENSION_URL);
  assert.equal(
    fhir.patient.extension?.[0]?.extension?.find((part) => part.url === "number")?.valueString,
    PRACTICE_NUMBER,
  );
});

test("AWS SQS retains a shared-number STOP after a mid-loop Patient update failure and succeeds on retry", async () => {
  const fhir = new InMemorySuppressionFhir(["synthetic-1", "synthetic-2"].map((id) => ({
    resourceType: "Patient" as const,
    id,
    meta: { versionId: "1" },
    telecom: [{ system: "phone" as const, use: "mobile" as const, value: PATIENT_NUMBER }],
  })));
  fhir.failNextUpdateFor("synthetic-2");
  const errors: string[] = [];
  const info: string[] = [];
  let deletes = 0;
  const receiver = createAwsSqsInboundReceiver(CONFIG, {
    fhir,
    onMessage: async () => undefined,
    error: (message) => errors.push(message),
    info: (message) => info.push(message),
    client: {
      async send(command) {
        if (command.constructor.name === "ReceiveMessageCommand") {
          return { Messages: [{
            MessageId: "sqs-shared-phone",
            ReceiptHandle: "receipt-shared-phone",
            Body: inboundNotification("aws-shared-phone", "STOP"),
          }] };
        }
        deletes += 1;
        return {};
      },
    },
  });

  assert.equal(await receiver.pollOnce(), 0);
  assert.equal(deletes, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /retained for retry.*synthetic Patient update failure/i);

  assert.equal(await receiver.pollOnce(), 1);
  assert.equal(deletes, 1);
  assert.deepEqual(info, [
    "odos-mcp: AWS inbound SMS suppression outcome=opted-out matchedPatients=2",
  ]);
  assert.equal(fhir.patients.filter((patient) =>
    patient.extension?.some((extension) => extension.url === ODOS_COMMS_OPT_OUT_EXTENSION_URL)).length, 2);
});

test("AWS SQS logs a distinct zero-match suppression outcome", async () => {
  const fhir = new InMemorySuppressionFhir({
    resourceType: "Patient",
    id: "synthetic-1",
    meta: { versionId: "1" },
    telecom: [{ system: "phone", value: "+18645550198" }],
  });
  const info: string[] = [];
  let deletes = 0;
  const receiver = createAwsSqsInboundReceiver(CONFIG, {
    fhir,
    onMessage: async () => undefined,
    info: (message) => info.push(message),
    client: {
      async send(command) {
        if (command.constructor.name === "ReceiveMessageCommand") {
          return { Messages: [{
            MessageId: "sqs-no-match",
            ReceiptHandle: "receipt-no-match",
            Body: inboundNotification("aws-no-match", "STOP"),
          }] };
        }
        deletes += 1;
        return {};
      },
    },
  });

  assert.equal(await receiver.pollOnce(), 1);
  assert.equal(deletes, 1);
  assert.deepEqual(info, [
    "odos-mcp: AWS inbound SMS suppression outcome=no-patient-match matchedPatients=0",
  ]);
});

test("AWS SQS START log reports the legacy global opt-out that prevented re-enrollment", async () => {
  const fhir = new InMemorySuppressionFhir({
    resourceType: "Patient",
    id: "synthetic-1",
    meta: { versionId: "1" },
    telecom: [{ system: "phone", use: "mobile", value: PATIENT_NUMBER }],
    extension: [{
      url: ODOS_COMMS_OPT_OUT_EXTENSION_URL,
      extension: [{ url: "channel", valueCode: "sms" }],
    }],
  });
  const info: string[] = [];
  let deletes = 0;
  const receiver = createAwsSqsInboundReceiver(CONFIG, {
    fhir,
    onMessage: async () => undefined,
    info: (message) => info.push(message),
    client: {
      async send(command) {
        if (command.constructor.name === "ReceiveMessageCommand") {
          return { Messages: [{
            MessageId: "sqs-legacy-start",
            ReceiptHandle: "receipt-legacy-start",
            Body: inboundNotification("aws-legacy-start", "START"),
          }] };
        }
        deletes += 1;
        return {};
      },
    },
  });

  assert.equal(await receiver.pollOnce(), 1);
  assert.equal(deletes, 1);
  assert.deepEqual(info, [
    "odos-mcp: AWS inbound SMS suppression outcome=opt-in-refused-broader-opt-out matchedPatients=1 remainingGlobal=true remainingNumbers=none",
  ]);
});

test("AWS SQS rejects a notification from a different SNS topic without deleting it", async () => {
  const fhir = new InMemorySuppressionFhir({ resourceType: "Patient", id: "synthetic-1" });
  let deletes = 0;
  const receiver = createAwsSqsInboundReceiver(CONFIG, {
    fhir,
    onMessage: async () => undefined,
    error: () => undefined,
    client: {
      async send(command) {
        if (command.constructor.name === "ReceiveMessageCommand") return { Messages: [{
          MessageId: "sqs-message-2",
          ReceiptHandle: "receipt-2",
          Body: JSON.stringify({
            Type: "Notification",
            TopicArn: "arn:aws:sns:us-east-1:123456789012:wrong-topic",
            Message: "{}",
          }),
        }] };
        deletes += 1;
        return {};
      },
    },
  });
  assert.equal(await receiver.pollOnce(), 0);
  assert.equal(deletes, 0);
});

test("AWS SQS run recovers from a transient receive failure with bounded backoff", async () => {
  const fhir = new InMemorySuppressionFhir({ resourceType: "Patient", id: "synthetic-1" });
  const controller = new AbortController();
  const delays: number[] = [];
  const errors: string[] = [];
  let receives = 0;
  const receiver = createAwsSqsInboundReceiver(CONFIG, {
    fhir,
    onMessage: async () => undefined,
    error: (message) => errors.push(message),
    sleep: async (delayMs) => { delays.push(delayMs); },
    client: {
      async send(command) {
        if (command.constructor.name !== "ReceiveMessageCommand") return {};
        receives += 1;
        if (receives === 1) throw new Error("synthetic transient receive failure");
        controller.abort();
        return { Messages: [] };
      },
    },
  });

  await receiver.run(controller.signal);

  assert.equal(receives, 2);
  assert.deepEqual(delays, [1_000]);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /receive failed.*retrying in 1000ms.*synthetic transient/i);
});

function inboundNotification(providerMessageId: string, messageBody: string): string {
  return JSON.stringify({
    Type: "Notification",
    TopicArn: CONFIG.inboundTopicArn,
    Message: JSON.stringify({
      originationNumber: PATIENT_NUMBER,
      destinationNumber: PRACTICE_NUMBER,
      messageKeyword: messageBody,
      messageBody,
      inboundMessageId: providerMessageId,
    }),
  });
}

class InMemorySuppressionFhir {
  readonly baseUrl = "http://synthetic.fhir/R4";
  readonly patients: Patient[];
  private failUpdateId?: string;
  constructor(patient: Patient | Patient[]) {
    this.patients = structuredClone(Array.isArray(patient) ? patient : [patient]);
  }
  get patient(): Patient { return this.patients[0]!; }
  failNextUpdateFor(id: string): void { this.failUpdateId = id; }
  async read<T extends Resource>(_resourceType: T["resourceType"], id: string): Promise<T> {
    const patient = this.patients.find((candidate) => candidate.id === id);
    if (!patient) throw new Error(`Missing Patient/${id}`);
    return structuredClone(patient) as T;
  }
  async search<T extends Resource>(resourceType: T["resourceType"], params: Record<string, string> = {}): Promise<Bundle<T>> {
    const matches = resourceType === "Patient"
      ? this.patients.filter((patient) => patient.telecom?.some((point) => point.value === params.telecom))
      : [];
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: matches.map((patient) => ({ resource: structuredClone(patient) as T })),
    };
  }
  async searchUrl<T extends Resource>(): Promise<Bundle<T>> {
    return { resourceType: "Bundle", type: "searchset" };
  }
  async update<T extends Resource>(_type: T["resourceType"], id: string, resource: T): Promise<T> {
    if (this.failUpdateId === id) {
      this.failUpdateId = undefined;
      throw new Error("synthetic Patient update failure");
    }
    const index = this.patients.findIndex((patient) => patient.id === id);
    if (index < 0) throw new Error(`Missing Patient/${id}`);
    const currentVersion = Number(this.patients[index]!.meta?.versionId ?? "0");
    this.patients[index] = {
      ...structuredClone(resource) as Patient,
      meta: { ...resource.meta, versionId: String(currentVersion + 1) },
    };
    return structuredClone(resource);
  }
}
