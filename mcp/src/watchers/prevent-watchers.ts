import type {
  EligibilityFinding,
  EligibilitySweepStore,
  PreventWatcherId,
} from "../jobs/eligibilitySweep.js";
import type {
  WatcherDefinition,
  WatcherEvaluationContext,
  WatcherMatch,
} from "./watcher-types.js";

export function createPreventWatcherDefinitions(
  store: EligibilitySweepStore,
  timeZone: string,
): readonly WatcherDefinition[] {
  return [
    {
      id: "W21",
      question: "Which upcoming visits have a coverage problem before the patient arrives?",
      firingRule: (context) => evaluatePreventWatcher(store, "W21", context, timeZone),
      owner: "front-desk",
      nextAction: { label: "Open patient", href: patientInsuranceHref },
      consequence: "Resolving coverage before the visit avoids billing the patient after care is delivered.",
      register: "front-desk",
      dismissalReasons: [
        { code: "already-sorted", display: "Already sorted" },
        { code: "patient-self-pay", display: "Patient is self-pay" },
        { code: "check-again", display: "Check again" },
      ],
      activation: "fixed-threshold",
      seedSettings: { enabled: true, severity: "today" },
    },
    {
      id: "W22",
      question: "Which upcoming visits have the wrong primary payer or could not be checked for primacy?",
      firingRule: (context) => evaluatePreventWatcher(store, "W22", context, timeZone),
      owner: "biller",
      nextAction: { label: "Review insurance", href: patientInsuranceHref },
      consequence: "Confirming payer order before submission avoids preventable COB denials and rebilling.",
      register: "biller",
      dismissalReasons: [
        { code: "already-sorted", display: "Already sorted" },
        { code: "payer-order-confirmed", display: "Payer order confirmed" },
        { code: "not-applicable", display: "COB not applicable" },
      ],
      activation: "fixed-threshold",
      seedSettings: { enabled: true, severity: "this-week" },
    },
    {
      id: "W23",
      question: "Which upcoming visits have payer-rejected member or demographic details?",
      firingRule: (context) => evaluatePreventWatcher(store, "W23", context, timeZone),
      owner: "front-desk",
      nextAction: { label: "Review insurance", href: patientInsuranceHref },
      consequence: "Confirming payer-returned corrections before the visit prevents another rejected eligibility or claim transaction.",
      register: "front-desk",
      dismissalReasons: [
        { code: "already-correct", display: "Already correct" },
        { code: "payer-data-wrong", display: "Payer data is wrong" },
        { code: "patient-confirmation-needed", display: "Patient confirmation needed" },
      ],
      activation: "fixed-threshold",
      seedSettings: { enabled: true, severity: "this-week" },
    },
  ];
}

async function evaluatePreventWatcher(
  store: EligibilitySweepStore,
  watcherId: PreventWatcherId,
  context: WatcherEvaluationContext,
  timeZone: string,
): Promise<WatcherMatch[]> {
  if (!context.settings.enabled) return [];
  const targetDate = addDate(context.date, 1);
  const state = await store.loadState(targetDate);
  if (state?.status !== "healthy" || !state.lastSuccessfulAt) return [];
  const findings = await store.loadFindings(targetDate);
  return findings
    .filter((finding) => finding.watcherId === watcherId)
    .map((finding) => findingMatch(finding, timeZone));
}

function findingMatch(finding: EligibilityFinding, timeZone: string): WatcherMatch {
  const visit = `${formatWeekday(finding.appointmentAt, timeZone)} at ${formatTime(finding.appointmentAt, timeZone)}`;
  const messages = findingMessages(finding, visit);
  return {
    watcherId: finding.watcherId,
    conditionKey: `${finding.watcherId}:${finding.key}`,
    patientReference: finding.patientReference,
    patientDisplay: finding.patientDisplay,
    appointmentReference: finding.appointmentReference,
    appointmentAt: finding.appointmentAt,
    frontDeskMessage: messages.frontDesk,
    ownerMessage: messages.owner,
    balanceCents: 0,
    ageDays: 0,
    sourceOccurredAt: finding.sourceOccurredAt,
    sourceInvoiceCount: 0,
    reasonCode: reasonCode(finding),
    coverageReference: finding.coverageReference,
    payerDisplay: finding.payerDisplay,
    ...(finding.eligibilityCheckResult ? { eligibilityCheckResult: finding.eligibilityCheckResult } : {}),
    ...(finding.cob ? { cobStatus: finding.cob.status, cobReason: finding.cob.reason } : {}),
    ...(finding.memberIdProposal ? { memberIdProposal: finding.memberIdProposal } : {}),
  };
}

function findingMessages(
  finding: EligibilityFinding,
  visit: string,
): { frontDesk: string; owner: string } {
  if (finding.watcherId === "W21") {
    const detail = finding.coverageEnd
      ? `his coverage ends ${formatDate(finding.coverageEnd)} before the visit`
      : `his insurance shows as ${(finding.eligibilityCheckResult ?? "failed").toLowerCase()}`;
    return {
      frontDesk: `${finding.patientDisplay} comes in ${visit}, and ${detail}. Worth a call before he arrives — otherwise the visit likely bills to him instead of the plan.`,
      owner: `${finding.patientDisplay} comes in ${visit}; ${detail}. Resolve coverage before the visit.`,
    };
  }
  if (finding.watcherId === "W22") {
    if (finding.cob?.status === "mismatch") {
      const returned = finding.cob.returnedPrimaryPayerDisplay || finding.cob.returnedPrimaryPayerId || "another payer";
      return {
        frontDesk: `${finding.patientDisplay} comes in ${visit}. COB returned ${returned} as primary instead of ${finding.payerDisplay}.`,
        owner: `${finding.patientDisplay} comes in ${visit}; COB returned ${returned} as primary instead of ${finding.payerDisplay}. Review payer order before billing.`,
      };
    }
    const reason = cobReasonDisplay(finding.cob?.reason);
    return {
      frontDesk: `${finding.patientDisplay} comes in ${visit}. ODOS could not check payer order for ${finding.payerDisplay}: ${reason}.`,
      owner: `${finding.patientDisplay} comes in ${visit}; ODOS could not check payer order for ${finding.payerDisplay}: ${reason}. This is not an all-clear.`,
    };
  }
  const codes = finding.aaaCodes?.join(", ") || "payer rejection";
  const proposal = finding.memberIdProposal
    ? ` Insurance Discovery found a different member ID as a proposed correction; confirm it before changing the chart.`
    : " Confirm the member and demographic details with the patient or payer.";
  return {
    frontDesk: `${finding.patientDisplay} comes in ${visit}, and ${finding.payerDisplay} rejected the eligibility details (${codes}).${proposal}`,
    owner: `${finding.patientDisplay} comes in ${visit}; ${finding.payerDisplay} rejected member or demographic details (${codes}).${proposal}`,
  };
}

function reasonCode(finding: EligibilityFinding): string {
  if (finding.watcherId === "W21") return finding.coverageEnd ? "coverage-ends-before-visit" : `eligibility-${(finding.eligibilityCheckResult ?? "failed").toLowerCase()}`;
  if (finding.watcherId === "W22") return finding.cob?.status === "mismatch" ? "payer-primacy-mismatch" : `cob-${finding.cob?.reason ?? "could-not-check"}`;
  return `aaa-${finding.aaaCodes?.join("-") || "member-data"}`;
}

function patientInsuranceHref(match: WatcherMatch): string {
  return `/insurance?patientId=${match.patientReference.replace(/^Patient\//, "")}`;
}

function cobReasonDisplay(reason: string | undefined): string {
  switch (reason) {
    case "unknown": return "the payer has not been classified yet";
    case "unsupported": return "this payer is marked unsupported";
    case "traditional-medicare": return "traditional Medicare is outside this COB check";
    case "capitated": return "capitation cannot be detected by this COB check";
    case "primacy-undetermined": return "the payer data did not determine primacy";
    default: return "eligibility did not return enough exact payer data";
  }
}

function formatWeekday(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone }).format(new Date(value));
}

function formatTime(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(new Date(value));
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${value}T12:00:00.000Z`));
}

function addDate(date: string, days: number): string {
  const parsed = new Date(`${date}T12:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}
