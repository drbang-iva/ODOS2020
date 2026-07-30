import type { Communication, Patient, Resource } from "@medplum/fhirtypes";
import type { MedplumClient } from "../fhir-client.js";
import type {
  CommsProvider,
  SendEmailRequest,
  SendResult,
} from "./comms-provider.js";

export const ODOS_COMMS_OPT_OUT_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-comms-opt-out";
export const ODOS_PATIENT_TIMEZONE_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-patient-timezone";
export const ODOS_COMMS_CAMPAIGN_TYPE_SYSTEM =
  "https://odos2020.com/fhir/CodeSystem/comms-campaign-type";

export type SuppressionFhir = Pick<MedplumClient, "read" | "search">;

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
    async sendEmail(request: SendEmailRequest): Promise<SendResult> {
      const now = deps.now?.() ?? new Date();
      const patient = await readPatient(deps.fhir, request.patientReference);
      if (isOptedOut(patient, "email", request.campaignType)) {
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
      return provider.sendEmail({
        ...request,
        toAddress: request.toAddress ?? patientEmail(patient, now),
      });
    },
  };
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
): Promise<boolean> {
  if (!Number.isInteger(capDays) || capDays <= 0) {
    throw new Error("Communications frequencyCapDays must be a positive integer.");
  }
  if (!patient.id) {
    throw new Error("Patient must have an id before communications suppression can be evaluated.");
  }
  const cutoff = new Date(now.getTime() - capDays * 86_400_000).toISOString();
  const bundle = await fhir.search<Communication>("Communication", [
    ["subject", `Patient/${patient.id}`],
    ["category", `${ODOS_COMMS_CAMPAIGN_TYPE_SYSTEM}|${campaignType}`],
    ["sent", `ge${cutoff}`],
    ["_count", "100"],
  ]);
  return (bundle.entry ?? []).some((entry) => {
    const communication = entry.resource;
    return communication?.status === "completed"
      && Boolean(communication.sent)
      && Date.parse(communication.sent!) >= Date.parse(cutoff)
      && communication.subject?.reference === `Patient/${patient.id}`
      && communication.category?.some((category) =>
        category.coding?.some((coding) =>
          coding.system === ODOS_COMMS_CAMPAIGN_TYPE_SYSTEM && coding.code === campaignType));
  });
}

function patientEmail(patient: Patient, now: Date): string {
  const email = patient.telecom?.find((point) =>
    point.system === "email"
    && point.use !== "old"
    && Boolean(point.value?.trim())
    && (!point.period?.end || Date.parse(point.period.end) > now.getTime()))
    ?.value?.trim();
  if (!email) {
    throw new Error(`Patient/${patient.id ?? "unknown"} has no active email in Patient.telecom.`);
  }
  return email;
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
