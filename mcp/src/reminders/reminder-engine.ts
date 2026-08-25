import { createHash } from "node:crypto";
import type {
  Appointment,
  Bundle,
  Communication,
  Patient,
  Resource,
} from "@medplum/fhirtypes";
import type { MedplumClient } from "../fhir-client.js";
import type { CommsDispatch } from "../comms/comms-config.js";
import type { SendResult } from "../comms/comms-provider.js";
import {
  ODOS_COMMS_CAMPAIGN_TYPE_SYSTEM,
  ODOS_COMMS_SEND_IDENTIFIER_SYSTEM,
} from "../comms/suppression-gate.js";

const CHANNEL_SYSTEM =
  "https://odos2020.com/fhir/CodeSystem/comms-channel";
const CAMPAIGN_ID_URL =
  "https://odos2020.com/fhir/StructureDefinition/comms-campaign-id";
const CLAIM_ID_URL =
  "https://odos2020.com/fhir/StructureDefinition/comms-send-claim-id";
const ANCHOR_URL =
  "https://odos2020.com/fhir/StructureDefinition/comms-anchor";
const OFFSET_URL =
  "https://odos2020.com/fhir/StructureDefinition/comms-offset-minutes";
const RESCHEDULED_AT_URL =
  "https://odos2020.com/fhir/StructureDefinition/comms-rescheduled-at";
const PROVIDER_MESSAGE_ID_URL =
  "https://odos2020.com/fhir/StructureDefinition/comms-provider-message-id";

export type ReminderFhir = Pick<
  MedplumClient,
  "baseUrl" | "read" | "search" | "searchUrl" | "create" | "update"
>;

export interface ReminderAnchorConfig {
  resourceType: Resource["resourceType"];
  searchParameter: string;
  fieldPath: string;
  searchPaddingMinutes?: number;
}

export interface ReminderCampaignConfig {
  id: string;
  campaignType: string;
  provider: string;
  channel: "email" | "sms";
  anchor: ReminderAnchorConfig;
  offsetMinutes: number;
  subjectTemplate: string;
  bodyTemplate: string;
  frequencyCapDays?: number;
}

export interface ReminderEngineDeps {
  fhir: ReminderFhir;
  dispatch: CommsDispatch;
  practiceTimeZone: string;
  now?: () => Date;
  generateId?: () => string;
  lookbackMinutes?: number;
}

export type ReminderRunOutcome =
  | "sent"
  | "suppressed"
  | "rescheduled"
  | "already-processed"
  | "failed";

export interface ReminderRunResult {
  campaignId: string;
  anchorReference: string;
  outcome: ReminderRunOutcome;
  communicationId?: string;
  detail?: string;
}

export interface ReminderEngine {
  run(campaigns?: ReminderCampaignConfig[]): Promise<ReminderRunResult[]>;
}

export interface ReminderWorkerDeps {
  authenticate(): Promise<void>;
  engine: ReminderEngine;
  campaigns?: ReminderCampaignConfig[];
  intervalMs?: number;
}

const DEFAULT_TEMPLATE = {
  provider: "google-workspace",
  channel: "email" as const,
  campaignType: "appointment-reminder",
  anchor: {
    resourceType: "Appointment" as const,
    searchParameter: "date",
    fieldPath: "start",
  },
  subjectTemplate: "Appointment reminder",
  bodyTemplate:
    "Your appointment is {{appointmentDateTime}} with {{provider}} at {{location}}.",
};

export const DEFAULT_APPOINTMENT_REMINDER_CAMPAIGNS: ReminderCampaignConfig[] = [
  { ...DEFAULT_TEMPLATE, id: "appointment-reminder-7d", offsetMinutes: -7 * 24 * 60 },
  { ...DEFAULT_TEMPLATE, id: "appointment-reminder-1d", offsetMinutes: -24 * 60 },
  { ...DEFAULT_TEMPLATE, id: "appointment-reminder-2h", offsetMinutes: -2 * 60 },
];

export function appointmentReminderCampaignsFromEnv(
  env: Record<string, string | undefined>,
): ReminderCampaignConfig[] {
  const values = (env.ODOS_REMINDER_CHANNELS ?? "email")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const configuredChannels = [...new Set(values)];
  if (
    configuredChannels.length === 0
    || configuredChannels.some((channel) => channel !== "email" && channel !== "sms")
  ) {
    throw new Error("ODOS_REMINDER_CHANNELS must contain email, sms, or both.");
  }
  const channels = configuredChannels as Array<"email" | "sms">;
  return channels.flatMap((channel) => {
    const provider = (channel === "email"
      ? env.ODOS_REMINDER_EMAIL_PROVIDER ?? env.ODOS_REMINDER_PROVIDER ?? "google-workspace"
      : env.ODOS_REMINDER_SMS_PROVIDER ?? "twilio").trim();
    if (!provider.trim()) {
      throw new Error(`ODOS reminder ${channel} provider is required.`);
    }
    return DEFAULT_APPOINTMENT_REMINDER_CAMPAIGNS.map((campaign) => ({
      ...campaign,
      id: channel === "email" ? campaign.id : `${campaign.id}-sms`,
      provider,
      channel,
      ...(channel === "sms"
        ? { bodyTemplate: `${campaign.bodyTemplate} Reply STOP to unsubscribe.` }
        : {}),
    }));
  });
}

export function scheduledAt(anchorDateTime: string, offsetMinutes: number): string {
  if (!Number.isInteger(offsetMinutes)) {
    throw new Error("Reminder offsetMinutes must be a signed integer.");
  }
  const anchorMs = Date.parse(anchorDateTime);
  if (!Number.isFinite(anchorMs)) {
    throw new Error(`Reminder anchor is not a valid FHIR dateTime: "${anchorDateTime}".`);
  }
  return new Date(anchorMs + offsetMinutes * 60_000).toISOString();
}

export function createReminderEngine(deps: ReminderEngineDeps): ReminderEngine {
  const now = deps.now ?? (() => new Date());
  const generateId = deps.generateId ?? (() => crypto.randomUUID());
  const lookbackMinutes = deps.lookbackMinutes ?? 5;
  if (!Number.isInteger(lookbackMinutes) || lookbackMinutes <= 0) {
    throw new Error("Reminder lookbackMinutes must be a positive integer.");
  }
  assertTimeZone(deps.practiceTimeZone);

  return {
    async run(
      campaigns = DEFAULT_APPOINTMENT_REMINDER_CAMPAIGNS,
    ): Promise<ReminderRunResult[]> {
      const current = now();
      const results: ReminderRunResult[] = [];
      for (const campaign of campaigns) {
        validateCampaign(campaign);
        const handledAnchors = new Set<string>();
        const held = await loadHeldCommunications(deps.fhir, campaign, current);
        for (const communication of held) {
          const result = await processHeldCommunication(
            deps,
            campaign,
            communication,
            current,
            generateId,
          );
          results.push(result);
          handledAnchors.add(result.anchorReference);
        }
        const anchors = await loadDueAnchors(
          deps.fhir,
          campaign,
          current,
          lookbackMinutes,
        );
        for (const anchor of anchors) {
          if (handledAnchors.has(resourceReference(anchor))) continue;
          results.push(await processAnchor(
            deps,
            campaign,
            anchor,
            current,
            generateId,
          ));
        }
      }
      return results;
    },
  };
}

export async function runReminderSweep(
  deps: Pick<ReminderWorkerDeps, "authenticate" | "engine" | "campaigns">,
): Promise<ReminderRunResult[]> {
  await deps.authenticate();
  return deps.engine.run(deps.campaigns);
}

export function startReminderWorker(deps: ReminderWorkerDeps): NodeJS.Timeout {
  const run = (): void => {
    void runReminderSweep(deps).catch((error) => {
      console.error("odos-mcp: appointment reminder sweep failed:", error);
    });
  };
  run();
  const timer = setInterval(run, deps.intervalMs ?? 60_000);
  timer.unref();
  return timer;
}

export function reminderWorkerIntervalMs(value: string | undefined): number {
  if (!value?.trim()) return 60_000;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 15_000) {
    throw new Error("ODOS_REMINDER_WORKER_MS must be an integer of at least 15000.");
  }
  return parsed;
}

export function reminderLookbackMinutes(value: string | undefined): number {
  if (!value?.trim()) return 24 * 60;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("ODOS_REMINDER_LOOKBACK_MINUTES must be a positive integer.");
  }
  return parsed;
}

async function loadHeldCommunications(
  fhir: ReminderFhir,
  campaign: ReminderCampaignConfig,
  now: Date,
): Promise<Communication[]> {
  const bundle = await fhir.search<Communication>("Communication", [
    ["status", "on-hold"],
    ["category", `${ODOS_COMMS_CAMPAIGN_TYPE_SYSTEM}|${campaign.campaignType}`],
    ["_count", "1000"],
  ]);
  const communications = await collectSearchResources(
    fhir,
    bundle,
    "Communication",
    "Reminder held-send",
  );
  return communications
    .filter((communication) => communication.status === "on-hold")
    .filter((communication) =>
      extensionString(communication, CAMPAIGN_ID_URL, "valueString") === campaign.id)
    .filter((communication) => {
      const rescheduledAt = extensionString(
        communication,
        RESCHEDULED_AT_URL,
        "valueInstant",
      );
      return Boolean(rescheduledAt) && Date.parse(rescheduledAt!) <= now.getTime();
    });
}

async function processHeldCommunication(
  deps: ReminderEngineDeps,
  campaign: ReminderCampaignConfig,
  communication: Communication,
  now: Date,
  generateId: () => string,
): Promise<ReminderRunResult> {
  const anchorReference = communication.about?.[0]?.reference;
  const patientReference = communication.subject?.reference;
  if (!anchorReference || !patientReference?.startsWith("Patient/")) {
    throw new Error("Held Communication is missing its anchor or patient.");
  }
  const anchor = await readAnchor(deps.fhir, campaign, anchorReference);
  const heldAnchorValue = anchorValueFromCommunication(
    communication,
    campaign,
    anchorReference,
  );
  const currentAnchorValue = stringAtPath(anchor, campaign.anchor.fieldPath);
  let currentPatientReference: string | undefined;
  try {
    currentPatientReference = patientReferenceOf(anchor);
  } catch {
    currentPatientReference = undefined;
  }
  if (
    !activeAnchor(anchor)
    || !heldAnchorValue
    || currentAnchorValue !== heldAnchorValue
    || currentPatientReference !== patientReference
    || (
      campaign.offsetMinutes < 0
      && Boolean(currentAnchorValue)
      && Date.parse(currentAnchorValue!) <= now.getTime()
    )
  ) {
    return abandonHeldCommunication(
      deps.fhir,
      campaign,
      anchorReference,
      communication,
      "Anchor changed, is no longer active, or the reminder is no longer timely.",
    );
  }
  const patient = await deps.fhir.read<Patient>(
    "Patient",
    patientReference.slice("Patient/".length),
  );
  const context = templateContext(anchor, patient, deps.practiceTimeZone);
  const subject = render(campaign.subjectTemplate, context);
  const body = render(campaign.bodyTemplate, context);
  const claimId = generateId();
  const claimed = await updateCommunication(deps.fhir, {
    ...communication,
    status: "in-progress",
    extension: replaceExtension(communication.extension, CLAIM_ID_URL, {
      url: CLAIM_ID_URL,
      valueString: claimId,
    }).filter((entry) => entry.url !== RESCHEDULED_AT_URL),
  });
  try {
    const send = await dispatchReminder(deps, campaign, {
      patientReference,
      subject,
      body,
      messageId: claimed.identifier?.find(
        (identifier) => identifier.system === ODOS_COMMS_SEND_IDENTIFIER_SYSTEM,
      )?.value,
    });
    return persistOutcome(
      deps.fhir,
      campaign,
      anchorReference,
      claimed,
      send,
      now.toISOString(),
    );
  } catch (error) {
    await updateCommunication(deps.fhir, {
      ...claimed,
      status: "not-done",
      statusReason: {
        text: error instanceof Error ? error.message : "Communications provider failed.",
      },
    });
    return {
      campaignId: campaign.id,
      anchorReference,
      outcome: "failed",
      ...(claimed.id ? { communicationId: claimed.id } : {}),
      detail: error instanceof Error ? error.message : "Communications provider failed.",
    };
  }
}

async function readAnchor(
  fhir: ReminderFhir,
  campaign: ReminderCampaignConfig,
  reference: string,
): Promise<Resource> {
  const match = /^([A-Z][A-Za-z]+)\/([A-Za-z0-9.-]{1,64})$/.exec(reference);
  if (!match || match[1] !== campaign.anchor.resourceType) {
    throw new Error(`Held Communication anchor "${reference}" does not match its campaign.`);
  }
  return fhir.read<Resource>(
    campaign.anchor.resourceType,
    match[2],
  );
}

function anchorValueFromCommunication(
  communication: Communication,
  campaign: ReminderCampaignConfig,
  anchorReference: string,
): string | undefined {
  const metadata = extensionString(communication, ANCHOR_URL, "valueString");
  const prefix = `${anchorReference}#${campaign.anchor.fieldPath}=`;
  return metadata?.startsWith(prefix) ? metadata.slice(prefix.length) : undefined;
}

async function abandonHeldCommunication(
  fhir: ReminderFhir,
  campaign: ReminderCampaignConfig,
  anchorReference: string,
  communication: Communication,
  reason: string,
): Promise<ReminderRunResult> {
  const updated = await updateCommunication(fhir, {
    ...communication,
    status: "not-done",
    statusReason: { text: reason },
    extension: communication.extension?.filter((entry) => entry.url !== RESCHEDULED_AT_URL),
  });
  return {
    campaignId: campaign.id,
    anchorReference,
    outcome: "suppressed",
    ...(updated.id ? { communicationId: updated.id } : {}),
    detail: reason,
  };
}

async function loadDueAnchors(
  fhir: ReminderFhir,
  campaign: ReminderCampaignConfig,
  now: Date,
  lookbackMinutes: number,
): Promise<Resource[]> {
  const anchorUpper = new Date(now.getTime() - campaign.offsetMinutes * 60_000);
  const anchorLower = campaign.offsetMinutes < 0
    ? now
    : new Date(anchorUpper.getTime() - lookbackMinutes * 60_000);
  const searchLower = new Date(
    anchorLower.getTime() - (campaign.anchor.searchPaddingMinutes ?? 0) * 60_000,
  );
  // search-contract: reminder-engine.search-anchor
  const bundle = await fhir.search<Resource>(campaign.anchor.resourceType, [
    [campaign.anchor.searchParameter, `ge${searchLower.toISOString()}`],
    [campaign.anchor.searchParameter, `le${anchorUpper.toISOString()}`],
    ["_count", "1000"],
  ]);
  const resources = await collectSearchResources(
    fhir,
    bundle,
    campaign.anchor.resourceType,
    "Reminder due-anchor",
  );
  return resources
    .filter((resource) => activeAnchor(resource))
    .filter((resource) => {
      const value = stringAtPath(resource, campaign.anchor.fieldPath);
      if (!value) return false;
      const anchorMs = Date.parse(value);
      const due = Date.parse(scheduledAt(value, campaign.offsetMinutes));
      if (campaign.offsetMinutes < 0) {
        return due <= now.getTime() && anchorMs > now.getTime();
      }
      return due <= now.getTime() && due >= now.getTime() - lookbackMinutes * 60_000;
    });
}

async function collectSearchResources<T extends Resource>(
  fhir: ReminderFhir,
  initialBundle: Bundle<T>,
  resourceType: T["resourceType"],
  label: string,
): Promise<T[]> {
  let bundle = initialBundle;
  const resources = bundleResources(bundle);
  let pages = 1;
  while (nextLink(bundle)) {
    if (pages >= 100 || resources.length >= 10_000) {
      throw new Error(`${label} search exceeded its 100-page or 10000-row bound.`);
    }
    if (!fhir.searchUrl) {
      throw new Error(`${label} pagination requires FHIR next-link support.`);
    }
    bundle = await fhir.searchUrl<T>(
      nextLink(bundle)!,
      resourceType,
    );
    resources.push(...bundleResources(bundle));
    pages += 1;
  }
  if (resources.length > 10_000) {
    throw new Error(`${label} search exceeded its 10000-row bound.`);
  }
  return resources;
}

function bundleResources<T extends Resource>(bundle: Bundle<T>): T[] {
  return (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []);
}

function nextLink<T extends Resource>(bundle: Bundle<T>): string | undefined {
  return bundle.link?.find((link) => link.relation === "next")?.url;
}

async function processAnchor(
  deps: ReminderEngineDeps,
  campaign: ReminderCampaignConfig,
  anchor: Resource,
  now: Date,
  generateId: () => string,
): Promise<ReminderRunResult> {
  const anchorReference = resourceReference(anchor);
  const anchorValue = stringAtPath(anchor, campaign.anchor.fieldPath)!;
  const patientReference = patientReferenceOf(anchor);
  const key = sendKey(campaign, anchorReference, anchorValue);
  const existing = await findSend(deps.fhir, key);
  if (existing) {
    const rescheduledAt = extensionString(existing, RESCHEDULED_AT_URL, "valueInstant");
    if (
      existing.status !== "on-hold"
      || !rescheduledAt
      || Date.parse(rescheduledAt) > now.getTime()
    ) {
      return {
        campaignId: campaign.id,
        anchorReference,
        outcome: "already-processed",
        ...(existing.id ? { communicationId: existing.id } : {}),
      };
    }
  }

  const patient = await deps.fhir.read<Patient>("Patient", patientReference.slice("Patient/".length));
  const context = templateContext(anchor, patient, deps.practiceTimeZone);
  const subject = render(campaign.subjectTemplate, context);
  const body = render(campaign.bodyTemplate, context);
  const claimId = generateId();
  const candidate = communicationCandidate({
    campaign,
    anchor,
    anchorReference,
    anchorValue,
    patientReference,
    subject,
    body,
    key,
    claimId,
  });
  const claimed = existing
    ? await updateCommunication(deps.fhir, {
        ...existing,
        status: "in-progress",
        extension: replaceExtension(existing.extension, CLAIM_ID_URL, {
          url: CLAIM_ID_URL,
          valueString: claimId,
        }).filter((entry) => entry.url !== RESCHEDULED_AT_URL),
      })
    : await deps.fhir.create<Communication>(candidate, {
        "If-None-Exist": `identifier=${ODOS_COMMS_SEND_IDENTIFIER_SYSTEM}|${key}`,
      });
  if (extensionString(claimed, CLAIM_ID_URL, "valueString") !== claimId) {
    return {
      campaignId: campaign.id,
      anchorReference,
      outcome: "already-processed",
      ...(claimed.id ? { communicationId: claimed.id } : {}),
    };
  }

  try {
    const send = await dispatchReminder(deps, campaign, {
      patientReference,
      subject,
      body,
      messageId: key,
    });
    return await persistOutcome(
      deps.fhir,
      campaign,
      anchorReference,
      claimed,
      send,
      now.toISOString(),
    );
  } catch (error) {
    await updateCommunication(deps.fhir, {
      ...claimed,
      status: "not-done",
      statusReason: { text: error instanceof Error ? error.message : "Communications provider failed." },
    });
    return {
      campaignId: campaign.id,
      anchorReference,
      outcome: "failed",
      ...(claimed.id ? { communicationId: claimed.id } : {}),
      detail: error instanceof Error ? error.message : "Communications provider failed.",
    };
  }
}

async function persistOutcome(
  fhir: ReminderFhir,
  campaign: ReminderCampaignConfig,
  anchorReference: string,
  communication: Communication,
  send: SendResult,
  sentAt: string,
): Promise<ReminderRunResult> {
  if (send.outcome === "sent") {
    const updated = await updateCommunication(fhir, {
      ...communication,
      status: "completed",
      sent: sentAt,
      extension: replaceExtension(communication.extension, PROVIDER_MESSAGE_ID_URL, {
        url: PROVIDER_MESSAGE_ID_URL,
        valueString: send.providerMessageId,
      }),
    });
    return {
      campaignId: campaign.id,
      anchorReference,
      outcome: "sent",
      ...(updated.id ? { communicationId: updated.id } : {}),
    };
  }
  if (send.outcome === "rescheduled") {
    const updated = await updateCommunication(fhir, {
      ...communication,
      status: "on-hold",
      statusReason: { text: "Quiet-hours clamp" },
      extension: replaceExtension(communication.extension, RESCHEDULED_AT_URL, {
        url: RESCHEDULED_AT_URL,
        valueInstant: send.rescheduledAt,
      }),
    });
    return {
      campaignId: campaign.id,
      anchorReference,
      outcome: "rescheduled",
      ...(updated.id ? { communicationId: updated.id } : {}),
      detail: send.rescheduledAt,
    };
  }
  const updated = await updateCommunication(fhir, {
    ...communication,
    status: "not-done",
    statusReason: { text: send.reason },
  });
  return {
    campaignId: campaign.id,
    anchorReference,
    outcome: "suppressed",
    ...(updated.id ? { communicationId: updated.id } : {}),
    detail: send.reason,
  };
}

async function dispatchReminder(
  deps: ReminderEngineDeps,
  campaign: ReminderCampaignConfig,
  input: {
    patientReference: string;
    subject: string;
    body: string;
    messageId?: string;
  },
): Promise<SendResult> {
  const provider = deps.dispatch.getAdapter(campaign.provider, deps.fhir);
  const common = {
    patientReference: input.patientReference,
    body: input.body,
    campaignType: campaign.campaignType,
    campaignId: campaign.id,
    messageId: input.messageId,
    suppression: {
      ...(campaign.frequencyCapDays !== undefined
        ? { frequencyCapDays: campaign.frequencyCapDays }
        : {}),
    },
  };
  if (campaign.channel === "email") {
    if (!provider.capabilities.email || !provider.sendEmail) {
      throw new Error(`Communications provider "${provider.name}" does not support email.`);
    }
    return provider.sendEmail({ ...common, subject: input.subject });
  }
  if (!provider.capabilities.sms || !provider.sendSms) {
    throw new Error(`Communications provider "${provider.name}" does not support SMS.`);
  }
  return provider.sendSms(common);
}

function communicationCandidate(input: {
  campaign: ReminderCampaignConfig;
  anchor: Resource;
  anchorReference: string;
  anchorValue: string;
  patientReference: string;
  subject: string;
  body: string;
  key: string;
  claimId: string;
}): Communication {
  return {
    resourceType: "Communication",
    status: "in-progress",
    identifier: [{ system: ODOS_COMMS_SEND_IDENTIFIER_SYSTEM, value: input.key }],
    category: [{
      coding: [{
        system: ODOS_COMMS_CAMPAIGN_TYPE_SYSTEM,
        code: input.campaign.campaignType,
      }],
      text: input.campaign.id,
    }],
    medium: [{ coding: [{ system: CHANNEL_SYSTEM, code: input.campaign.channel }] }],
    subject: { reference: input.patientReference },
    recipient: [{ reference: input.patientReference }],
    about: [{ reference: input.anchorReference }],
    payload: [{ contentString: input.body }],
    topic: { text: input.subject },
    extension: [
      { url: CAMPAIGN_ID_URL, valueString: input.campaign.id },
      { url: CLAIM_ID_URL, valueString: input.claimId },
      {
        url: ANCHOR_URL,
        valueString:
          `${input.anchorReference}#${input.campaign.anchor.fieldPath}=${input.anchorValue}`,
      },
      { url: OFFSET_URL, valueInteger: input.campaign.offsetMinutes },
    ],
  };
}

async function findSend(
  fhir: ReminderFhir,
  key: string,
): Promise<Communication | undefined> {
  const bundle = await fhir.search<Communication>("Communication", {
    identifier: `${ODOS_COMMS_SEND_IDENTIFIER_SYSTEM}|${key}`,
    _count: "2",
  });
  const matches = (bundle.entry ?? []).flatMap((entry) =>
    entry.resource ? [entry.resource] : []);
  if (matches.length > 1) throw new Error("Communications send identifier is not unique.");
  return matches[0];
}

async function updateCommunication(
  fhir: ReminderFhir,
  communication: Communication,
): Promise<Communication> {
  if (!communication.id) throw new Error("FHIR Communication must have an id before update.");
  return fhir.update<Communication>(
    "Communication",
    communication.id,
    communication,
    communication.meta?.versionId
      ? { "If-Match": `W/"${communication.meta.versionId}"` }
      : undefined,
  );
}

function replaceExtension(
  extensions: Communication["extension"],
  url: string,
  replacement: NonNullable<Communication["extension"]>[number],
) {
  return [...(extensions ?? []).filter((entry) => entry.url !== url), replacement];
}

function extensionString(
  communication: Communication,
  url: string,
  field: "valueString" | "valueInstant",
): string | undefined {
  const value = communication.extension?.find((entry) => entry.url === url)?.[field];
  return typeof value === "string" ? value : undefined;
}

function activeAnchor(resource: Resource): boolean {
  if (resource.resourceType !== "Appointment") return true;
  return !["cancelled", "entered-in-error", "noshow"].includes(resource.status);
}

function patientReferenceOf(resource: Resource): string {
  if (resource.resourceType === "Appointment") {
    const reference = resource.participant.find(
      (participant) => participant.actor?.reference?.startsWith("Patient/"),
    )?.actor?.reference;
    if (reference) return reference;
  }
  const candidate = resource as Resource & {
    subject?: { reference?: string };
    patient?: { reference?: string };
  };
  const reference = candidate.subject?.reference ?? candidate.patient?.reference;
  if (!reference?.startsWith("Patient/")) {
    throw new Error(`${resource.resourceType}/${resource.id ?? "unknown"} has no Patient anchor.`);
  }
  return reference;
}

function templateContext(
  resource: Resource,
  patient: Patient,
  practiceTimeZone: string,
): Record<string, string> {
  const appointment = resource.resourceType === "Appointment" ? resource : undefined;
  const patientName = patient.name?.[0];
  return {
    patientFirstName: patientName?.given?.[0] ?? "there",
    appointmentDateTime: appointment?.start
      ? new Intl.DateTimeFormat("en-US", {
          timeZone: practiceTimeZone,
          dateStyle: "long",
          timeStyle: "short",
        }).format(new Date(appointment.start))
      : "",
    provider: appointment ? participantDisplay(appointment, "Practitioner") : "your provider",
    location: appointment ? participantDisplay(appointment, "Location") : "the practice",
  };
}

function participantDisplay(appointment: Appointment, resourceType: string): string {
  const actor = appointment.participant.find(
    (participant) => participant.actor?.reference?.startsWith(`${resourceType}/`),
  )?.actor;
  return actor?.display ?? actor?.reference ?? (resourceType === "Location" ? "the practice" : "your provider");
}

function render(template: string, context: Record<string, string>): string {
  return template.replace(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g, (_match, key: string) => {
    if (!(key in context)) throw new Error(`Unknown communications template field "{{${key}}}".`);
    return context[key];
  });
}

function stringAtPath(resource: Resource, path: string): string | undefined {
  const value = path.split(".").reduce<unknown>((current, key) => {
    if (typeof current !== "object" || current === null || !(key in current)) return undefined;
    return (current as Record<string, unknown>)[key];
  }, resource);
  return typeof value === "string" ? value : undefined;
}

function sendKey(
  campaign: ReminderCampaignConfig,
  anchorReference: string,
  anchorValue: string,
): string {
  return createHash("sha256").update([
    campaign.id,
    anchorReference,
    campaign.anchor.fieldPath,
    anchorValue,
    String(campaign.offsetMinutes),
  ].join("|")).digest("hex");
}

function resourceReference(resource: Resource): string {
  if (!resource.id) throw new Error(`${resource.resourceType} anchor must have an id.`);
  return `${resource.resourceType}/${resource.id}`;
}

function validateCampaign(campaign: ReminderCampaignConfig): void {
  if (!campaign.id.trim() || !campaign.campaignType.trim() || !campaign.provider.trim()) {
    throw new Error("Reminder campaign id, campaignType, and provider are required.");
  }
  if (campaign.channel !== "email" && campaign.channel !== "sms") {
    throw new Error(`Reminder channel "${campaign.channel}" is not supported.`);
  }
  if (!Number.isInteger(campaign.offsetMinutes)) {
    throw new Error("Reminder offsetMinutes must be a signed integer.");
  }
  if (
    !campaign.anchor.searchParameter.trim()
    || !campaign.anchor.fieldPath.trim()
  ) {
    throw new Error("Reminder anchor searchParameter and fieldPath are required.");
  }
  const searchPaddingMinutes = campaign.anchor.searchPaddingMinutes ?? 0;
  if (!Number.isInteger(searchPaddingMinutes) || searchPaddingMinutes < 0) {
    throw new Error("Reminder anchor searchPaddingMinutes must be a non-negative integer.");
  }
  if (
    campaign.anchor.resourceType === "Appointment"
    && campaign.anchor.fieldPath === "start"
    && campaign.anchor.searchParameter !== "date"
  ) {
    throw new Error('Appointment.start anchors require searchParameter "date".');
  }
  if (
    campaign.anchor.resourceType === "Appointment"
    && campaign.anchor.fieldPath === "end"
    && campaign.anchor.searchParameter !== "date"
  ) {
    throw new Error(
      'Appointment.end anchors require standard FHIR searchParameter "date" with search padding.',
    );
  }
  if (
    campaign.anchor.resourceType === "Appointment"
    && campaign.anchor.fieldPath === "end"
    && searchPaddingMinutes === 0
  ) {
    throw new Error("Appointment.end anchors require positive searchPaddingMinutes.");
  }
}

function assertTimeZone(value: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
  } catch {
    throw new Error(`Reminder practice time zone "${value}" is invalid.`);
  }
}
