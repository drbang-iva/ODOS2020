# Native communications AWS evidence ledger

Access date: 2026-08-30

| Claim used by ODOS | Primary AWS evidence | Local verification |
|---|---|---|
| Outbound SMS uses `SendTextMessage` with destination, origination identity, body, and message type, returning `MessageId`. | [SendTextMessage API](https://docs.aws.amazon.com/pinpoint/latest/apireference_smsvoicev2/API_SendTextMessage.html) | `mcp/tests/awsSmsAdapter.test.ts` inspects the actual SDK command input and requires `MessageId`. |
| Two-way inbound payload supplies origination number, destination number, keyword, body, and inbound message ID. | [Two-way SMS payload](https://docs.aws.amazon.com/sms-voice/latest/userguide/two-way-sms-payload.html) | `mcp/tests/awsSqsInboundReceiver.test.ts` normalizes an SNS-wrapped payload into `InboundMessageEvent`. |
| SQS long polling supports a wait time up to 20 seconds; successful messages are explicitly deleted. | [AWS SDK for JavaScript SQS examples](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/javascript_sqs_code_examples.html) | Receiver requests 20-second long polling and deletes only after persistence and suppression succeed. |
| Self-managed opt-outs route HELP and STOP messages to the configured SNS topic and make the sender responsible for responses and opt-out enforcement. | [Self-managed opt-outs](https://docs.aws.amazon.com/sms-voice/latest/userguide/opt-out-list-self-managed.html) | Shared suppression tests prove STOP-equivalent inbound messages block both AWS and Twilio outbound adapters. |
| Required opt-out keywords include ARRET, CANCEL, END, OPT-OUT, OPTOUT, QUIT, REMOVE, STOP, TD, and UNSUBSCRIBE; START and UNSTOP opt in. | [Required opt-out keywords](https://docs.aws.amazon.com/sms-voice/latest/userguide/keywords-required.html) | `inboundOptOutType` applies this set to provider-neutral inbound messages. |
| SNS-to-SQS delivery requires a queue policy granting `sqs:SendMessage` to the topic, followed by an SQS subscription. | [Subscribe an SQS queue to an SNS topic](https://docs.aws.amazon.com/sns/latest/dg/subscribe-sqs-queue-to-sns-topic.html) | Manual setup guide records the required policies and subscription; no repository IaC exists. |
