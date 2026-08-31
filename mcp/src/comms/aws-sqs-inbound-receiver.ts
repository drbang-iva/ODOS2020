import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
  type DeleteMessageCommandOutput,
  type ReceiveMessageCommandOutput,
} from "@aws-sdk/client-sqs";
import {
  normalizeAwsSmsConfig,
  type AwsSmsAdapterConfig,
} from "./adapters/aws-sms-adapter.js";
import { ODOS_AWS_MESSAGE_IDENTIFIER_SYSTEM } from "./comms-persistence.js";
import type { InboundMessageEvent, PullInboundReceiver } from "./inbound-receiver.js";
import {
  inboundOptOutType,
  updateInboundSuppression,
  type InboundSuppressionFhir,
} from "./suppression-gate.js";

export interface AwsSqsClient {
  send(command: ReceiveMessageCommand): Promise<ReceiveMessageCommandOutput>;
  send(command: DeleteMessageCommand): Promise<DeleteMessageCommandOutput>;
}

export interface AwsSqsInboundReceiverDeps {
  fhir: InboundSuppressionFhir;
  onMessage(event: InboundMessageEvent): Promise<void>;
  client?: AwsSqsClient;
  error?: (message: string) => void;
  info?: (message: string) => void;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

export function createAwsSqsInboundReceiver(
  config: AwsSmsAdapterConfig,
  deps: AwsSqsInboundReceiverDeps,
): PullInboundReceiver {
  const normalized = normalizeAwsSmsConfig(config);
  const client: AwsSqsClient = deps.client
    ?? new SQSClient({ region: normalized.region }) as AwsSqsClient;
  return {
    mode: "pull",
    provider: "aws",
    async pollOnce(): Promise<number> {
      const response = await client.send(new ReceiveMessageCommand({
        QueueUrl: normalized.inboundQueueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 20,
      }));
      let processed = 0;
      for (const message of response.Messages ?? []) {
        try {
          const event = parseAwsInboundMessage(message.Body, normalized.inboundTopicArn);
          await deps.onMessage(event);
          const result = await updateInboundSuppression(deps.fhir, {
            from: event.from,
            to: event.to,
            body: event.body,
            optOutType: event.optOutType,
          });
          (deps.info ?? console.error)(
            `odos-mcp: AWS inbound SMS suppression outcome=${result.outcome} matchedPatients=${result.matchedPatients}`,
          );
          if (!message.ReceiptHandle) throw new Error("AWS SQS message is missing ReceiptHandle.");
          await client.send(new DeleteMessageCommand({
            QueueUrl: normalized.inboundQueueUrl,
            ReceiptHandle: message.ReceiptHandle,
          }));
          processed += 1;
        } catch (error) {
          (deps.error ?? console.error)(
            `odos-mcp: AWS SMS inbound message retained for retry; ${error instanceof Error ? error.message : "unknown processing failure"}`,
          );
        }
      }
      return processed;
    },
    async run(signal?: AbortSignal): Promise<void> {
      let consecutiveFailures = 0;
      while (!signal?.aborted) {
        try {
          await this.pollOnce();
          consecutiveFailures = 0;
        } catch (error) {
          if (signal?.aborted) return;
          const delayMs = Math.min(1_000 * 2 ** Math.min(consecutiveFailures, 5), 30_000);
          consecutiveFailures += 1;
          (deps.error ?? console.error)(
            `odos-mcp: AWS SMS inbound receive failed; retrying in ${delayMs}ms; ${error instanceof Error ? error.message : "unknown receive failure"}`,
          );
          await (deps.sleep ?? sleep)(delayMs, signal);
        }
      }
    },
  };
}

async function sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timeout = setTimeout(done, delayMs);
    signal?.addEventListener("abort", done, { once: true });
  });
}

export function parseAwsInboundMessage(
  body: string | undefined,
  expectedTopicArn: string,
): InboundMessageEvent {
  if (!body) throw new Error("AWS SQS message is missing Body.");
  const envelope = jsonObject(body, "AWS SNS envelope");
  if (envelope.Type !== "Notification") {
    throw new Error("AWS SQS message is not an SNS Notification.");
  }
  if (envelope.TopicArn !== expectedTopicArn) {
    throw new Error("AWS SNS notification topic does not match AWS_SMS_SNS_TOPIC_ARN.");
  }
  if (typeof envelope.Message !== "string") {
    throw new Error("AWS SNS notification is missing Message.");
  }
  const payload = jsonObject(envelope.Message, "AWS End User Messaging payload");
  const from = e164(payload.originationNumber, "originationNumber");
  const to = e164(payload.destinationNumber, "destinationNumber");
  const providerMessageId = required(payload.inboundMessageId, "inboundMessageId");
  const bodyText = required(payload.messageBody, "messageBody");
  const keyword = typeof payload.messageKeyword === "string" ? payload.messageKeyword : bodyText;
  const optOutType = inboundOptOutType(keyword);
  const receivedAt = typeof envelope.Timestamp === "string" && Number.isFinite(Date.parse(envelope.Timestamp))
    ? new Date(envelope.Timestamp).toISOString()
    : undefined;
  return {
    provider: "aws",
    providerMessageId,
    providerMessageIdentifierSystem: ODOS_AWS_MESSAGE_IDENTIFIER_SYSTEM,
    from,
    to,
    body: bodyText,
    ...(receivedAt ? { receivedAt } : {}),
    ...(optOutType ? { optOutType } : {}),
  };
}

function jsonObject(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function required(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`AWS inbound SMS ${label} is required.`);
  }
  return value.trim();
}

function e164(value: unknown, label: string): string {
  const normalized = required(value, label);
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
    throw new Error(`AWS inbound SMS ${label} must use E.164 format.`);
  }
  return normalized;
}
