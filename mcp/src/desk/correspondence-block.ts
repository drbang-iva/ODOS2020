import type { Bundle, DocumentReference, Resource } from "@medplum/fhirtypes";
import type { FhirSearchParams } from "../fhir-client.js";
import {
  FAX_ERROR_EXTENSION_URL,
  FAX_STATUS_EXTENSION_URL,
} from "../fax/fax-record.js";
import {
  ReferralReplyWorklist,
  type ReferralReplyWorklistRow,
} from "../referral/reciprocal-referral.js";
export { CORRESPONDENCE_DRAFT_EXTENSION_URL } from "../correspondence/correspondence-document.js";
import { CORRESPONDENCE_DRAFT_EXTENSION_URL } from "../correspondence/correspondence-document.js";
import {
  inboundFaxPageCount,
  inboundFaxSenderNumber,
  inboundFaxSuggestedPatient,
  inboundFaxTriageStatus,
} from "../fax/inbound-fax.js";

export interface CorrespondenceAttentionItem {
  kind: "draft" | "reply-owed" | "send-failure" | "inbound-fax";
  title: string;
  patientReference: string;
  severity: "info" | "warning" | "urgent";
  ageMinutes: number | null;
  action: string;
  owner: "provider" | "front-desk";
  status: "open" | "failed";
  faxId?: string;
  receivedAt?: string;
  senderNumber?: string;
  pageCount?: number;
  documentUrl?: string;
  triageStatus?: "received" | "inbox";
  suggestedPatient?: {
    reference: string;
    display?: string;
  };
}

export interface CorrespondenceDeskBlock {
  draftsAwaitingSignature: {
    value: number;
    tone: "ok" | "warn";
  };
  repliesOwed: {
    value: number;
    tone: "ok" | "warn";
  };
  sendFailures: {
    value: number;
    tone: "ok" | "alert";
  };
  inboundFaxes: {
    value: number;
    tone: "ok" | "warn";
  };
  items: CorrespondenceAttentionItem[];
}

interface CorrespondenceDeskFhir {
  search<T extends Resource>(
    resourceType: T["resourceType"],
    params?: FhirSearchParams,
  ): Promise<Bundle<T>>;
}

const FAX_FAILURE_STATUSES = new Set([
  "BadNumber",
  "Busy",
  "NoAnswer",
  "NoFaxDevice",
  "Cancelled",
  "Failed",
  "InvalidNumber",
]);

export async function loadCorrespondenceDeskBlock(
  fhir: CorrespondenceDeskFhir,
  options: {
    now?: string;
    loadRepliesOwed?: () => Promise<ReferralReplyWorklistRow[]>;
  } = {},
): Promise<CorrespondenceDeskBlock> {
  const now = options.now ?? new Date().toISOString();
  const [documents, repliesOwed] = await Promise.all([
    fhir.search<DocumentReference>("DocumentReference", {
      status: "current",
      _sort: "-date",
      _count: "200",
    }).then(resources),
    options.loadRepliesOwed?.() ?? new ReferralReplyWorklist(fhir).list(),
  ]);
  const drafts = documents.filter(isAwaitingSignatureDraft);
  const sendFailures = documents.filter(isFaxFailure);
  const inboundFaxes = documents.filter(isInboundFaxTriage);
  const items: CorrespondenceAttentionItem[] = [
    ...drafts.map((document): CorrespondenceAttentionItem => ({
      kind: "draft",
      title: "Draft awaiting provider signature",
      patientReference: document.subject?.reference ?? "Patient/unknown",
      severity: "warning",
      ageMinutes: ageMinutes(document.date, now),
      action: "Review and sign",
      owner: "provider",
      status: "open",
    })),
    ...repliesOwed.map((row): CorrespondenceAttentionItem => ({
      kind: "reply-owed",
      title: `Reply owed to ${row.referrerDisplay}`,
      patientReference: row.patientReference,
      severity: "warning",
      ageMinutes: ageMinutes(row.authoredOn, now),
      action: "Draft consult report",
      owner: "provider",
      status: "open",
    })),
    ...sendFailures.map((document): CorrespondenceAttentionItem => ({
      kind: "send-failure",
      title: faxFailureTitle(document),
      patientReference: document.subject?.reference ?? "Patient/unknown",
      severity: "urgent",
      ageMinutes: ageMinutes(document.date, now),
      action: "Review send failure",
      owner: "front-desk",
      status: "failed",
    })),
    ...inboundFaxes.flatMap((document): CorrespondenceAttentionItem[] => {
      if (!document.id) return [];
      const triageStatus = inboundFaxTriageStatus(document);
      if (triageStatus !== "received" && triageStatus !== "inbox") return [];
      const senderNumber = inboundFaxSenderNumber(document);
      const pageCount = inboundFaxPageCount(document);
      const suggestedPatient = inboundFaxSuggestedPatient(document);
      return [{
        kind: "inbound-fax",
        title: senderNumber ? `Inbound fax from ${senderNumber}` : "Inbound fax received",
        patientReference: document.subject?.reference ?? "Patient/unknown",
        severity: "info",
        ageMinutes: ageMinutes(document.date, now),
        action: "Review and triage",
        owner: "front-desk",
        status: "open",
        faxId: document.id,
        receivedAt: document.date ?? "",
        ...(senderNumber ? { senderNumber } : {}),
        ...(pageCount !== undefined ? { pageCount } : {}),
        documentUrl: `/fax/inbound/${encodeURIComponent(document.id)}/document`,
        triageStatus,
        ...(suggestedPatient ? { suggestedPatient } : {}),
      }];
    }),
  ];
  const inboundFaxCount = items.filter((item) => item.kind === "inbound-fax").length;
  return {
    draftsAwaitingSignature: {
      value: drafts.length,
      tone: drafts.length ? "warn" : "ok",
    },
    repliesOwed: {
      value: repliesOwed.length,
      tone: repliesOwed.length ? "warn" : "ok",
    },
    sendFailures: {
      value: sendFailures.length,
      tone: sendFailures.length ? "alert" : "ok",
    },
    inboundFaxes: {
      value: inboundFaxCount,
      tone: inboundFaxCount ? "warn" : "ok",
    },
    items,
  };
}

function resources<T extends Resource>(bundle: Bundle<T>): T[] {
  return (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []);
}

function isAwaitingSignatureDraft(document: DocumentReference): boolean {
  return document.status === "current"
    && document.docStatus === "preliminary"
    && Boolean(document.extension?.some(
      (extension) =>
        extension.url === CORRESPONDENCE_DRAFT_EXTENSION_URL
        && extension.valueBoolean === true,
    ));
}

function isFaxFailure(document: DocumentReference): boolean {
  const status = document.extension?.find(
    (extension) => extension.url === FAX_STATUS_EXTENSION_URL,
  )?.valueString;
  return Boolean(status && FAX_FAILURE_STATUSES.has(status));
}

function isInboundFaxTriage(document: DocumentReference): boolean {
  const status = inboundFaxTriageStatus(document);
  return status === "received" || status === "inbox";
}

function faxFailureTitle(document: DocumentReference): string {
  const detail = document.extension?.find(
    (extension) => extension.url === FAX_ERROR_EXTENSION_URL,
  )?.valueString?.trim();
  return detail ? `Send failed: ${detail}` : "Correspondence send failed";
}

function ageMinutes(value: string | undefined, now: string): number | null {
  const thenMs = Date.parse(value ?? "");
  const nowMs = Date.parse(now);
  if (!Number.isFinite(thenMs) || !Number.isFinite(nowMs)) return null;
  return Math.max(0, Math.floor((nowMs - thenMs) / 60_000));
}
