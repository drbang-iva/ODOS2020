import {
  PinpointSMSVoiceV2Client,
  SendTextMessageCommand,
  type SendTextMessageCommandOutput,
} from "@aws-sdk/client-pinpoint-sms-voice-v2";
import type {
  CommsProvider,
  SendResult,
  SendSmsRequest,
} from "../comms-provider.js";
import { ODOS_AWS_MESSAGE_IDENTIFIER_SYSTEM } from "../comms-persistence.js";

export const AWS_SMS_OPT_OUT_LANGUAGE = "Reply STOP to unsubscribe.";

export interface AwsSmsAdapterConfig {
  region: string;
  originationIdentity: string;
  inboundQueueUrl: string;
  inboundTopicArn: string;
}

export interface AwsSmsClient {
  send(command: SendTextMessageCommand): Promise<SendTextMessageCommandOutput>;
}

export interface AwsSmsAdapterDeps {
  client?: AwsSmsClient;
}

export function createAwsSmsAdapter(
  config: AwsSmsAdapterConfig,
  deps: AwsSmsAdapterDeps = {},
): CommsProvider {
  const normalized = normalizeConfig(config);
  const client = deps.client ?? new PinpointSMSVoiceV2Client({ region: normalized.region });
  return {
    name: "aws",
    messageIdentifierSystem: ODOS_AWS_MESSAGE_IDENTIFIER_SYSTEM,
    capabilities: {
      sms: true,
      calls: false,
      email: false,
      contacts: false,
      conversations: false,
      reviews: false,
    },
    async sendSms(request: SendSmsRequest): Promise<SendResult> {
      const response = await client.send(new SendTextMessageCommand({
        DestinationPhoneNumber: e164(request.toNumber, "AWS SMS recipient"),
        OriginationIdentity: normalized.originationIdentity,
        MessageBody: smsBody(request.body),
        MessageType: "TRANSACTIONAL",
      }));
      const messageId = response.MessageId?.trim();
      if (!messageId) throw new Error("AWS SendTextMessage response is missing MessageId.");
      return { outcome: "sent", providerMessageId: messageId };
    },
  };
}

export function normalizeAwsSmsConfig(config: AwsSmsAdapterConfig): AwsSmsAdapterConfig {
  return normalizeConfig(config);
}

function normalizeConfig(config: AwsSmsAdapterConfig): AwsSmsAdapterConfig {
  const region = required(config.region, "AWS SMS region");
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region)) {
    throw new Error("AWS SMS region must be an AWS region identifier.");
  }
  const originationIdentity = required(
    config.originationIdentity,
    "AWS SMS origination identity",
  );
  const phoneArn = /^arn:aws:sms-voice:([^:]+):(\d{12}):phone-number\/(phone-[a-z0-9]{32})$/.exec(
    originationIdentity,
  );
  if (!phoneArn || phoneArn[1] !== region) {
    throw new Error("AWS SMS origination identity must be a phone-number ARN in AWS_SMS_REGION.");
  }
  const accountId = phoneArn[2];
  const inboundQueueUrl = required(config.inboundQueueUrl, "AWS SMS inbound queue URL");
  let queueUrl: URL;
  try {
    queueUrl = new URL(inboundQueueUrl);
  } catch {
    throw new Error("AWS SMS inbound queue URL must be an HTTPS SQS URL.");
  }
  if (
    queueUrl.protocol !== "https:"
    || queueUrl.hostname !== `sqs.${region}.amazonaws.com`
    || !queueUrl.pathname.startsWith(`/${accountId}/`)
    || queueUrl.search
    || queueUrl.hash
  ) {
    throw new Error("AWS SMS inbound queue URL must be an HTTPS SQS URL in the phone ARN account and region.");
  }
  const inboundTopicArn = required(config.inboundTopicArn, "AWS SMS inbound topic ARN");
  if (!new RegExp(`^arn:aws:sns:${escapeRegex(region)}:${accountId}:[A-Za-z0-9_-]{1,256}$`).test(inboundTopicArn)) {
    throw new Error("AWS SMS inbound topic ARN must be an SNS topic in the phone ARN account and region.");
  }
  return { region, originationIdentity, inboundQueueUrl, inboundTopicArn };
}

function smsBody(value: string): string {
  const body = required(value, "AWS SMS body");
  return /\breply\s+stop\s+to\s+unsubscribe\b/i.test(body)
    ? body
    : `${body} ${AWS_SMS_OPT_OUT_LANGUAGE}`;
}

function e164(value: string | undefined, label: string): string {
  const normalized = value?.trim() ?? "";
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
    throw new Error(`${label} must use E.164 format.`);
  }
  return normalized;
}

function required(value: string | undefined, label: string): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
