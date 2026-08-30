export type InboundMessageProvider = "aws" | "twilio" | "ghl";
export type InboundOptOutType = "STOP" | "START" | "HELP";

export interface InboundMessageEvent {
  provider: InboundMessageProvider;
  providerMessageId: string;
  providerMessageIdentifierSystem: string;
  from: string;
  to: string;
  body: string;
  receivedAt?: string;
  optOutType?: InboundOptOutType;
}

export interface PushInboundReceiver {
  mode: "push";
  provider: "twilio" | "ghl";
  receive(event: InboundMessageEvent): Promise<void>;
}

export interface PullInboundReceiver {
  mode: "pull";
  provider: "aws";
  pollOnce(): Promise<number>;
  run(signal?: AbortSignal): Promise<void>;
}

export type InboundReceiver = PushInboundReceiver | PullInboundReceiver;
