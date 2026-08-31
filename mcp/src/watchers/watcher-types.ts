export type WatcherSeverity = "today" | "this-week" | "watch";
export type WatcherRegister = "front-desk" | "owner" | "biller";
export type WatcherActivation = "immediate" | "fixed-threshold" | "learned-baseline";

export interface WatcherPracticeSettings {
  enabled: boolean;
  severity: WatcherSeverity;
  [key: string]: boolean | number | string;
}

export interface WatcherPracticeConfig {
  version: 1;
  goLiveAt: string;
  needsHumanCap: number;
  staleAfterMinutes: number;
  watchers: Record<string, WatcherPracticeSettings>;
}

export interface WatcherDismissalReason {
  code: string;
  display: string;
}

export interface WatcherMatch {
  watcherId: string;
  conditionKey: string;
  patientReference: string;
  patientDisplay: string;
  appointmentReference: string;
  appointmentAt: string;
  frontDeskMessage: string;
  ownerMessage: string;
  balanceCents: number;
  ageDays: number;
  sourceOccurredAt: string;
  sourceInvoiceCount: number;
  reasonCode?: string;
  coverageReference?: string;
  payerDisplay?: string;
  eligibilityCheckResult?: string;
  cobStatus?: string;
  cobReason?: string;
  memberIdProposal?: {
    current: string;
    proposed: string;
    source: "insurance-discovery";
  };
}

export interface WatcherEvaluationContext {
  now: string;
  date: string;
  settings: WatcherPracticeSettings;
}

export interface WatcherDefinition {
  id: string;
  question: string;
  firingRule(context: WatcherEvaluationContext): Promise<WatcherMatch[]>;
  owner: string;
  nextAction: {
    label: string;
    href(match: WatcherMatch): string;
  };
  consequence: string;
  register: WatcherRegister;
  dismissalReasons: WatcherDismissalReason[];
  activation: WatcherActivation;
  seedSettings: WatcherPracticeSettings;
}

export interface WatcherRegistry {
  get(id: string): WatcherDefinition;
  list(): readonly WatcherDefinition[];
}
