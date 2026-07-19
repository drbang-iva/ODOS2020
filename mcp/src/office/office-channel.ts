import type { Communication, Patient, Practitioner, PractitionerRole, Provenance, Resource } from "@medplum/fhirtypes";
import type { MedplumClient } from "../fhir-client.js";
import { collectBoundedSearch } from "../fhir-search.js";

export const OFFICE_CATEGORY_SYSTEM = "https://odos2020.com/fhir/CodeSystem/communication-category";
export const OFFICE_CATEGORY_CODE = "internal-office";
export const OFFICE_AUDIENCE_SYSTEM = "https://odos2020.com/fhir/NamingSystem/office-channel-audience";
export const OFFICE_AUDIENCE_CODE = "clinic-side";
export const OFFICE_ACK_SYSTEM = "https://odos2020.com/fhir/CodeSystem/office-message-activity";
export const OFFICE_ACK_CODE = "acknowledged";
export const OFFICE_ACK_TAG_SYSTEM = "https://odos2020.com/fhir/CodeSystem/office-message-kind";
export const OFFICE_ACK_TAG_CODE = "acknowledgement";
export const OFFICE_TEXT_LIMIT = 1000;
const RECENT_ACKNOWLEDGED_TAIL = 20;
const OFFICE_SEARCH_LIMITS = { maxPages: 5, maxRows: 5_000 } as const;

export type OfficeFhir = Pick<MedplumClient, "read" | "search" | "searchUrl" | "create">;
export type OfficeTier = "ambient" | "urgent" | "patient-pinned";
export type OfficeMailbox = "clinic" | "desk";

export interface OfficeMessageRow {
  id: string;
  text: string;
  sentAt: string;
  sender: { reference: string; display: string };
  tier: OfficeTier;
  patient?: { reference: string; id: string; display: string };
  acknowledgement?: { by: string; display: string; at: string };
}

export class OfficeMessageValidationError extends Error {}

export async function sendOfficeMessage(
  fhir: OfficeFhir,
  input: { senderReference: string; text: string; tier: OfficeTier; patientId?: string; now?: string },
): Promise<OfficeMessageRow> {
  const text = input.text.trim();
  if (!text || text.length > OFFICE_TEXT_LIMIT) {
    throw new OfficeMessageValidationError(`Office message text must be 1-${OFFICE_TEXT_LIMIT} characters.`);
  }
  if (!isOfficeTier(input.tier)) throw new OfficeMessageValidationError("Office message tier is invalid.");
  if (input.tier === "patient-pinned" && !input.patientId) {
    throw new OfficeMessageValidationError("Pinned Office messages require a patientId.");
  }
  if (input.tier !== "patient-pinned" && input.patientId !== undefined) {
    throw new OfficeMessageValidationError("Only patient-pinned Office messages may include a patientId.");
  }
  if (input.patientId !== undefined && !resourceId(input.patientId)) {
    throw new OfficeMessageValidationError("Pinned Office message patientId is invalid.");
  }

  const [senderDisplay, patient] = await Promise.all([
    staffDisplay(fhir, input.senderReference),
    input.patientId ? fhir.read<Patient>("Patient", input.patientId) : Promise.resolve(undefined),
  ]);
  const sentAt = input.now ?? new Date().toISOString();
  const created = await fhir.create<Communication>({
    resourceType: "Communication",
    status: "completed",
    category: [{ coding: [{ system: OFFICE_CATEGORY_SYSTEM, code: OFFICE_CATEGORY_CODE, display: "Internal Office message" }], text: "Internal Office message" }],
    priority: input.tier === "urgent" ? "urgent" : "routine",
    sent: sentAt,
    sender: { reference: input.senderReference, display: senderDisplay },
    recipient: [{ type: "PractitionerRole", identifier: { system: OFFICE_AUDIENCE_SYSTEM, value: OFFICE_AUDIENCE_CODE }, display: "Clinic side" }],
    ...(patient ? { subject: { reference: `Patient/${input.patientId}`, display: patientName(patient) } } : {}),
    payload: [{ contentString: text }],
  });
  if (!created.id) throw new Error("FHIR server did not assign an Office message id.");
  return projectMessage(created, []);
}

export async function listOfficeMessages(
  fhir: OfficeFhir,
  input: { mailbox: OfficeMailbox; staffReference: string },
): Promise<OfficeMessageRow[]> {
  const communications = await searchOfficePages<Communication>(fhir, "Communication", {
    category: `${OFFICE_CATEGORY_SYSTEM}|${OFFICE_CATEGORY_CODE}`,
    _count: "1000",
    _sort: "-sent",
  });
  const visible = communications
    .filter(isOfficeMessage)
    .filter((message) => input.mailbox === "clinic" ? isClinicAudience(message) : message.sender?.reference === input.staffReference)
    .sort((left, right) => Date.parse(right.sent ?? "") - Date.parse(left.sent ?? ""));
  const targets = visible.flatMap((message) => message.id ? [`Communication/${message.id}`] : []);
  const earliestSent = visible.at(-1)?.sent;
  const acknowledgements = targets.length === 0 ? [] : await searchOfficePages<Provenance>(fhir, "Provenance", {
    _tag: `${OFFICE_ACK_TAG_SYSTEM}|${OFFICE_ACK_TAG_CODE}`,
    ...(earliestSent ? { recorded: `ge${earliestSent}` } : {}),
    _count: "1000",
    _sort: "recorded",
  }).then((events) => events.filter((event) => event.target?.some((target) => targets.includes(target.reference ?? ""))));
  const byMessage = groupAcknowledgements(acknowledgements);
  const rows = visible.flatMap((message) => message.id ? [projectMessage(message, byMessage.get(message.id) ?? [])] : []);
  if (input.mailbox === "desk") return rows;
  const unacknowledged = rows.filter((message) => !message.acknowledgement);
  const recentAcknowledged = rows.filter((message) => message.acknowledgement).slice(0, RECENT_ACKNOWLEDGED_TAIL);
  return [...unacknowledged, ...recentAcknowledged].sort((left, right) => Date.parse(right.sentAt) - Date.parse(left.sentAt));
}

export async function acknowledgeOfficeMessage(
  fhir: OfficeFhir,
  input: { messageId: string; staffReference: string; now?: string },
): Promise<OfficeMessageRow> {
  if (!resourceId(input.messageId)) throw new OfficeMessageValidationError("Office message id is invalid.");
  const message = await fhir.read<Communication>("Communication", input.messageId);
  if (!isOfficeMessage(message) || !isClinicAudience(message)) {
    throw new OfficeMessageValidationError("Office message is not available to the Clinic channel.");
  }
  const existing = (await searchOfficePages<Provenance>(fhir, "Provenance", {
    _tag: `${OFFICE_ACK_TAG_SYSTEM}|${OFFICE_ACK_TAG_CODE}`,
    ...(message.sent ? { recorded: `ge${message.sent}` } : {}),
    _count: "1000",
    _sort: "recorded",
  })).filter((event) =>
    isAcknowledgement(event) && event.target?.some((target) => target.reference === `Communication/${input.messageId}`),
  );
  if (existing.length === 0) {
    const at = input.now ?? new Date().toISOString();
    const display = await staffDisplay(fhir, input.staffReference);
    existing.push(await fhir.create<Provenance>({
      resourceType: "Provenance",
      meta: { tag: [{ system: OFFICE_ACK_TAG_SYSTEM, code: OFFICE_ACK_TAG_CODE }] },
      target: [{ reference: `Communication/${input.messageId}` }],
      occurredDateTime: at,
      recorded: at,
      activity: { coding: [{ system: OFFICE_ACK_SYSTEM, code: OFFICE_ACK_CODE, display: "Office message acknowledged" }], text: "Office message acknowledged" },
      agent: [{ who: { reference: input.staffReference, display } }],
    }));
  }
  return projectMessage(message, existing);
}

function projectMessage(message: Communication, acknowledgements: Provenance[]): OfficeMessageRow {
  if (!message.id || !message.sent || !message.sender?.reference) throw new Error("Stored Office message is missing required data.");
  const patientReference = message.subject?.reference?.match(/^Patient\/([A-Za-z0-9.-]{1,64})$/);
  const acknowledgement = acknowledgements.filter(isAcknowledgement).flatMap((event) => {
    const agent = event.agent?.[0]?.who;
    const at = event.occurredDateTime ?? event.recorded;
    return agent?.reference && at ? [{ by: agent.reference, display: agent.display ?? agent.reference, at }] : [];
  })[0];
  return {
    id: message.id,
    text: message.payload?.find((payload) => typeof payload.contentString === "string")?.contentString ?? "",
    sentAt: message.sent,
    sender: { reference: message.sender.reference, display: message.sender.display ?? message.sender.reference },
    tier: patientReference ? "patient-pinned" : message.priority === "urgent" ? "urgent" : "ambient",
    ...(patientReference ? { patient: { reference: message.subject!.reference!, id: patientReference[1], display: message.subject?.display ?? message.subject!.reference! } } : {}),
    ...(acknowledgement ? { acknowledgement } : {}),
  };
}

function isClinicAudience(message: Communication): boolean {
  return message.recipient?.some((recipient) => recipient.identifier?.system === OFFICE_AUDIENCE_SYSTEM && recipient.identifier.value === OFFICE_AUDIENCE_CODE) ?? false;
}

export function isOfficeMessage(message: Communication): boolean {
  return message.category?.some((category) => category.coding?.some((coding) => coding.system === OFFICE_CATEGORY_SYSTEM && coding.code === OFFICE_CATEGORY_CODE)) ?? false;
}

function isAcknowledgement(event: Provenance): boolean {
  return event.activity?.coding?.some((coding) => coding.system === OFFICE_ACK_SYSTEM && coding.code === OFFICE_ACK_CODE) ?? false;
}

function groupAcknowledgements(events: Provenance[]): Map<string, Provenance[]> {
  const grouped = new Map<string, Provenance[]>();
  for (const event of events.filter(isAcknowledgement)) {
    for (const target of event.target ?? []) {
      const id = target.reference?.match(/^Communication\/([^/]+)$/)?.[1];
      if (!id) continue;
      grouped.set(id, [...(grouped.get(id) ?? []), event]);
    }
  }
  return grouped;
}

function isOfficeTier(value: unknown): value is OfficeTier {
  return value === "ambient" || value === "urgent" || value === "patient-pinned";
}

function resourceId(value: string): boolean {
  return /^[A-Za-z0-9.-]{1,64}$/.test(value);
}

async function searchOfficePages<T extends Resource>(
  fhir: Pick<OfficeFhir, "search" | "searchUrl">,
  resourceType: T["resourceType"],
  params: Record<string, string>,
): Promise<T[]> {
  const firstBundle = await fhir.search<T>(resourceType, params);
  return collectBoundedSearch(fhir, resourceType, firstBundle, OFFICE_SEARCH_LIMITS);
}

async function staffDisplay(fhir: Pick<OfficeFhir, "read">, reference: string): Promise<string> {
  const match = reference.match(/^(Practitioner|PractitionerRole)\/([A-Za-z0-9.-]{1,64})$/);
  if (!match) throw new OfficeMessageValidationError("Authenticated Office staff reference is invalid.");
  if (match[1] === "Practitioner") return practitionerName(await fhir.read<Practitioner>("Practitioner", match[2]));
  const role = await fhir.read<PractitionerRole>("PractitionerRole", match[2]);
  return role.practitioner?.display ?? role.code?.[0]?.text ?? role.code?.[0]?.coding?.[0]?.display ?? reference;
}

function practitionerName(practitioner: Practitioner): string {
  const name = practitioner.name?.find((candidate) => candidate.use === "usual") ?? practitioner.name?.[0];
  return [name?.prefix?.join(" "), name?.given?.join(" "), name?.family].filter(Boolean).join(" ") || `Practitioner/${practitioner.id}`;
}

function patientName(patient: Patient): string {
  const name = patient.name?.find((candidate) => candidate.use === "usual") ?? patient.name?.[0];
  return [name?.given?.join(" "), name?.family].filter(Boolean).join(" ") || `Patient/${patient.id}`;
}
