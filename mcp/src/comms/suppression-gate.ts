import type { Bundle, Communication, Patient, Resource } from "@medplum/fhirtypes";
import type { MedplumClient } from "../fhir-client.js";
import type {
  CallRequest,
  CommsProvider,
  SendEmailRequest,
  SendResult,
  SendSmsRequest,
} from "./comms-provider.js";

export const ODOS_COMMS_OPT_OUT_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-comms-opt-out";
export const ODOS_PATIENT_TIMEZONE_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-patient-timezone";
export const ODOS_COMMS_CAMPAIGN_TYPE_SYSTEM =
  "https://odos2020.com/fhir/CodeSystem/comms-campaign-type";
export const ODOS_COMMS_SEND_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/comms-send";

export type SuppressionFhir = Pick<MedplumClient, "read" | "search" | "searchUrl">;

export interface SuppressionGateDeps {
  fhir: SuppressionFhir;
  practiceTimeZone: string;
  now?: () => Date;
}

export function createSuppressedCommsProvider(
  provider: CommsProvider,
  deps: SuppressionGateDeps,
): CommsProvider {
  return {
    name: provider.name,
    capabilities: provider.capabilities,
    ...(provider.sendEmail ? {
      async sendEmail(request: SendEmailRequest): Promise<SendResult> {
        return gatedSend(deps, request, "email", (patient, now) => provider.sendEmail!({
          ...request,
          toAddress: request.toAddress ?? patientEmail(patient, now),
        }));
      },
    } : {}),
    ...(provider.sendSms ? {
      async sendSms(request: SendSmsRequest): Promise<SendResult> {
        return gatedSend(deps, request, "sms", (patient, now) => provider.sendSms!({
          ...request,
          toNumber: request.toNumber ?? patientPhone(patient, now),
        }));
      },
    } : {}),
    ...(provider.initiateCall ? {
      // Live staff click-to-call is not automated outreach, so messaging opt-out,
      // frequency-cap, and quiet-hours suppression do not apply.
      async initiateCall(request: CallRequest): Promise<{ callId: string }> {
        const patient = await readPatient(deps.fhir, request.patientReference);
        return provider.initiateCall!({
          ...request,
          toNumber: request.toNumber ?? patientPhone(patient, deps.now?.() ?? new Date()),
        });
      },
    } : {}),
    ...(provider.getCall ? {
      getCall: (callId: string) => provider.getCall!(callId),
    } : {}),
    ...(provider.listCalls ? {
      listCalls: (request = {}) => provider.listCalls!(request),
    } : {}),
    ...(provider.fetchRecording ? {
      fetchRecording: (recordingId: string) => provider.fetchRecording!(recordingId),
    } : {}),
    ...(provider.fetchTranscription ? {
      fetchTranscription: (transcriptionId: string) => provider.fetchTranscription!(transcriptionId),
    } : {}),
    ...(provider.listConversations ? {
      listConversations: (request = {}) => provider.listConversations!(request),
    } : {}),
  };
}

async function gatedSend(
  deps: SuppressionGateDeps,
  request: SendEmailRequest | SendSmsRequest,
  channel: "email" | "sms",
  send: (patient: Patient, now: Date) => Promise<SendResult>,
): Promise<SendResult> {
  const now = deps.now?.() ?? new Date();
  const patient = await readPatient(deps.fhir, request.patientReference);
  if (isOptedOut(patient, channel, request.campaignType)) {
    return { outcome: "suppressed", reason: "patient-opt-out" };
  }
  if (
    request.suppression.frequencyCapDays !== undefined
    && await isFrequencyCapped(
      deps.fhir,
      patient,
      request.campaignType,
      request.suppression.frequencyCapDays,
      now,
      request.messageId,
    )
  ) {
    return { outcome: "suppressed", reason: "frequency-cap" };
  }
  const timeZone = patientTimeZone(patient, deps.practiceTimeZone);
  if (!insideQuietHoursWindow(now, timeZone)) {
    return {
      outcome: "rescheduled",
      reason: "quiet-hours",
      rescheduledAt: nextWindowOpen(now, timeZone),
    };
  }
  return send(patient, now);
}

async function readPatient(fhir: SuppressionFhir, reference: string): Promise<Patient> {
  const match = /^Patient\/([A-Za-z0-9.-]{1,64})$/.exec(reference);
  if (!match) {
    throw new Error(`Communications patientReference must be Patient/…, got "${reference}".`);
  }
  return fhir.read<Patient>("Patient", match[1]);
}

function isOptedOut(patient: Patient, channel: string, campaignType: string): boolean {
  return patient.extension?.some((entry) => {
    if (entry.url !== ODOS_COMMS_OPT_OUT_EXTENSION_URL) return false;
    const configuredChannel = entry.extension?.find((part) => part.url === "channel")?.valueCode;
    const configuredCampaign = entry.extension?.find((part) => part.url === "campaign-type")?.valueCode;
    const channelMatches = !configuredChannel || configuredChannel === "all" || configuredChannel === channel;
    const campaignMatches = !configuredCampaign || configuredCampaign === campaignType;
    return channelMatches && campaignMatches;
  }) ?? false;
}

async function isFrequencyCapped(
  fhir: SuppressionFhir,
  patient: Patient,
  campaignType: string,
  capDays: number,
  now: Date,
  messageId: string | undefined,
): Promise<boolean> {
  if (!Number.isInteger(capDays) || capDays <= 0) {
    throw new Error("Communications frequencyCapDays must be a positive integer.");
  }
  if (!patient.id) {
    throw new Error("Patient must have an id before communications suppression can be evaluated.");
  }
  if (!messageId?.trim()) {
    throw new Error("Frequency-capped communications require a persisted messageId claim.");
  }
  const cutoff = new Date(now.getTime() - capDays * 86_400_000).toISOString();
  const candidates = await fhir.search<Communication>("Communication", [
    ["subject", `Patient/${patient.id}`],
    ["category", `${ODOS_COMMS_CAMPAIGN_TYPE_SYSTEM}|${campaignType}`],
    ["status", "in-progress,completed"],
    ["_lastUpdated", `ge${cutoff}`],
    ["_count", "100"],
  ]);
  const communications = await collectCommunications(fhir, candidates);
  if (communications.some((communication) =>
    communication.status === "completed"
    && Boolean(communication.sent)
    && Date.parse(communication.sent!) >= Date.parse(cutoff)
    && matchesFrequencyCapScope(communication, patient.id!, campaignType))) {
    return true;
  }
  const claims = communications.filter((communication) =>
    communication.status === "in-progress"
    && matchesFrequencyCapScope(communication, patient.id!, campaignType));
  const current = claims.find((communication) =>
    frequencyCapClaimId(communication) === messageId);
  if (!current) {
    throw new Error("Frequency-capped communication claim is not visible in FHIR search.");
  }
  const winner = [...claims].sort(compareFrequencyCapClaims)[0];
  return frequencyCapClaimId(winner) !== messageId;
}

async function collectCommunications(
  fhir: SuppressionFhir,
  initialBundle: Bundle<Communication>,
): Promise<Communication[]> {
  let bundle = initialBundle;
  const communications = (bundle.entry ?? []).flatMap((entry) =>
    entry.resource ? [entry.resource] : []);
  let pages = 1;
  while (bundle.link?.some((link) => link.relation === "next")) {
    if (pages >= 100 || communications.length >= 10_000) {
      throw new Error("Communications frequency-cap search exceeded its 100-page or 10000-row bound.");
    }
    if (!fhir.searchUrl) {
      throw new Error("Communications frequency-cap pagination requires FHIR next-link support.");
    }
    const next = bundle.link.find((link) => link.relation === "next")!.url;
    bundle = await fhir.searchUrl<Communication>(next, "Communication");
    communications.push(...(bundle.entry ?? []).flatMap((entry) =>
      entry.resource ? [entry.resource] : []));
    pages += 1;
  }
  if (communications.length > 10_000) {
    throw new Error("Communications frequency-cap search exceeded its 10000-row bound.");
  }
  return communications;
}

function compareFrequencyCapClaims(left: Communication, right: Communication): number {
  const leftUpdated = Date.parse(left.meta?.lastUpdated ?? "");
  const rightUpdated = Date.parse(right.meta?.lastUpdated ?? "");
  if (!Number.isFinite(leftUpdated) || !Number.isFinite(rightUpdated)) {
    throw new Error("Frequency-capped Communication claims require FHIR meta.lastUpdated.");
  }
  return leftUpdated - rightUpdated
    || frequencyCapClaimId(left).localeCompare(frequencyCapClaimId(right));
}

function frequencyCapClaimId(communication: Communication): string {
  const value = communication.identifier?.find(
    (identifier) => identifier.system === ODOS_COMMS_SEND_IDENTIFIER_SYSTEM,
  )?.value;
  if (!value) {
    throw new Error("Frequency-capped Communication claims require the ODOS send identifier.");
  }
  return value;
}

function matchesFrequencyCapScope(
  communication: Communication,
  patientId: string,
  campaignType: string,
): boolean {
  return communication.subject?.reference === `Patient/${patientId}`
    && (communication.category?.some((category) =>
      category.coding?.some((coding) =>
        coding.system === ODOS_COMMS_CAMPAIGN_TYPE_SYSTEM && coding.code === campaignType)) ?? false);
}

function patientEmail(patient: Patient, now: Date): string {
  const email = patient.telecom?.find((point) =>
    point.system === "email"
    && point.use !== "old"
    && Boolean(point.value?.trim())
    && (!point.period?.start || Date.parse(point.period.start) <= now.getTime())
    && (!point.period?.end || Date.parse(point.period.end) > now.getTime()))
    ?.value?.trim();
  if (!email) {
    throw new Error(`Patient/${patient.id ?? "unknown"} has no active email in Patient.telecom.`);
  }
  return email;
}

function patientPhone(patient: Patient, now: Date): string {
  const active = (patient.telecom ?? []).filter((point) =>
    (point.system === "sms" || point.system === "phone")
    && point.use !== "old"
    && Boolean(point.value?.trim())
    && (!point.period?.start || Date.parse(point.period.start) <= now.getTime())
    && (!point.period?.end || Date.parse(point.period.end) > now.getTime()));
  const phone = (
    active.find((point) => point.system === "sms")
    ?? active.find((point) => point.use === "mobile")
    ?? active[0]
  )?.value?.trim();
  if (!phone) {
    throw new Error(`Patient/${patient.id ?? "unknown"} has no active phone in Patient.telecom.`);
  }
  return phone;
}

function patientTimeZone(patient: Patient, practiceTimeZone: string): string {
  const patientZone = patient.extension?.find(
    (entry) => entry.url === ODOS_PATIENT_TIMEZONE_EXTENSION_URL,
  )?.valueString;
  return validTimeZone(patientZone) ? patientZone! : assertTimeZone(practiceTimeZone);
}

function insideQuietHoursWindow(now: Date, timeZone: string): boolean {
  const parts = localParts(now, timeZone);
  const minute = parts.hour * 60 + parts.minute;
  return minute >= 8 * 60 && minute < 21 * 60;
}

function nextWindowOpen(now: Date, timeZone: string): string {
  const parts = localParts(now, timeZone);
  const minute = parts.hour * 60 + parts.minute;
  const day = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  if (minute >= 21 * 60) day.setUTCDate(day.getUTCDate() + 1);
  return zonedWallTimeToIso(
    day.getUTCFullYear(),
    day.getUTCMonth() + 1,
    day.getUTCDate(),
    8,
    0,
    timeZone,
  );
}

function localParts(date: Date, timeZone: string) {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: assertTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(formatted.find((part) => part.type === type)?.value ?? 0);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

function zonedWallTimeToIso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): string {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let guess = target;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const represented = localParts(new Date(guess), timeZone);
    const representedMs = Date.UTC(
      represented.year,
      represented.month - 1,
      represented.day,
      represented.hour,
      represented.minute,
      represented.second,
    );
    guess += target - representedMs;
  }
  return new Date(guess).toISOString();
}

function validTimeZone(value: string | undefined): boolean {
  if (!value) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function assertTimeZone(value: string): string {
  if (!validTimeZone(value)) {
    throw new Error(`Communications practice time zone "${value}" is invalid.`);
  }
  return value;
}

export function communicationResources(bundle: { entry?: Array<{ resource?: Resource }> }): Communication[] {
  return (bundle.entry ?? []).flatMap((entry) =>
    entry.resource?.resourceType === "Communication" ? [entry.resource] : []);
}
