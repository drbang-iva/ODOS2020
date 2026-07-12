import type { Communication, Patient, Practitioner, PractitionerRole, Provenance, Resource } from "@medplum/fhirtypes";
import { PRACTICE_ROLE_IDS, type PracticeRoleId } from "../authz/roles.js";
import type { MedplumClient } from "../fhir-client.js";

const OFFICE_CATEGORY_SYSTEM = "https://osod.dev/fhir/CodeSystem/communication-category";
const OFFICE_CATEGORY_CODE = "internal-office";
const OFFICE_ROLE_SYSTEM = "https://osod.dev/fhir/NamingSystem/practice-role";
const OFFICE_ACK_SYSTEM = "https://osod.dev/fhir/CodeSystem/office-message-activity";
const OFFICE_ACK_CODE = "acknowledged";

export type OfficeFhir = Pick<MedplumClient, "read" | "search" | "create">;
export type OfficeBox = "inbox" | "sent";
export type OfficeView = "unread" | "all";

export interface OfficeMessageRow {
  id: string;
  text: string;
  sentAt: string;
  sender: { reference: string; display: string };
  recipient: { reference?: string; role?: PracticeRoleId; display: string };
  urgent: boolean;
  patient?: { reference: string; id: string; display: string };
  acknowledgements: Array<{ by: string; display: string; at: string }>;
}

export class OfficeMessageValidationError extends Error {}

export async function sendOfficeMessage(
  fhir: OfficeFhir,
  input: {
    senderReference: string;
    recipientReference?: string;
    recipientRole?: PracticeRoleId;
    text: string;
    urgent?: boolean;
    patientReference?: string;
    now?: string;
  },
): Promise<OfficeMessageRow> {
  const text = input.text.trim();
  if (!text || text.length > 2000) throw new OfficeMessageValidationError("Office message text must be 1-2000 characters.");
  if (Boolean(input.recipientReference) === Boolean(input.recipientRole)) {
    throw new OfficeMessageValidationError("Choose one practitioner or practice-role recipient.");
  }
  if (input.recipientRole && !PRACTICE_ROLE_IDS.includes(input.recipientRole)) throw new OfficeMessageValidationError("Office message practice-role recipient is invalid.");
  if (input.recipientReference && !/^Practitioner(Role)?\/[A-Za-z0-9.-]{1,64}$/.test(input.recipientReference)) {
    throw new OfficeMessageValidationError("Office message recipient is invalid.");
  }
  if (input.patientReference && !/^Patient\/[A-Za-z0-9.-]{1,64}$/.test(input.patientReference)) {
    throw new OfficeMessageValidationError("Pinned patient reference is invalid.");
  }

  const [senderDisplay, recipientDisplay, patient] = await Promise.all([
    staffDisplay(fhir, input.senderReference),
    input.recipientReference ? staffDisplay(fhir, input.recipientReference) : Promise.resolve(roleDisplay(input.recipientRole!)),
    input.patientReference ? readPatient(fhir, input.patientReference) : Promise.resolve(undefined),
  ]);
  const sentAt = input.now ?? new Date().toISOString();
  const created = await fhir.create<Communication>({
    resourceType: "Communication",
    status: "completed",
    category: [{ coding: [{ system: OFFICE_CATEGORY_SYSTEM, code: OFFICE_CATEGORY_CODE, display: "Internal office message" }], text: "Internal office message" }],
    priority: input.urgent ? "urgent" : "routine",
    sent: sentAt,
    sender: { reference: input.senderReference, display: senderDisplay },
    recipient: input.recipientReference
      ? [{ reference: input.recipientReference, display: recipientDisplay }]
      : [{ type: "PractitionerRole", identifier: { system: OFFICE_ROLE_SYSTEM, value: input.recipientRole }, display: recipientDisplay }],
    ...(patient ? { subject: { reference: input.patientReference, display: patientName(patient) } } : {}),
    payload: [{ contentString: text }],
  });
  if (!created.id) throw new Error("FHIR server did not assign an office message id.");
  return projectMessage(created, []);
}

export async function listOfficeMessages(
  fhir: OfficeFhir,
  input: { staffReference: string; role: PracticeRoleId; box: OfficeBox; view: OfficeView },
): Promise<OfficeMessageRow[]> {
  const communications = await searchOnePage<Communication>(fhir, "Communication", {
    category: `${OFFICE_CATEGORY_SYSTEM}|${OFFICE_CATEGORY_CODE}`,
    _count: "1000",
    _sort: "-sent",
  });
  const visible = communications.filter((message) => input.box === "sent"
    ? message.sender?.reference === input.staffReference
    : isRecipient(message, input.staffReference, input.role));
  const targets = visible.flatMap((message) => message.id ? [`Communication/${message.id}`] : []);
  const acknowledgements = targets.length === 0 ? [] : await searchOnePage<Provenance>(fhir, "Provenance", {
    target: targets.join(","),
    _count: "1000",
    _sort: "recorded",
  });
  const byMessage = groupAcknowledgements(acknowledgements);
  return visible
    .flatMap((message) => message.id ? [projectMessage(message, byMessage.get(message.id) ?? [])] : [])
    .filter((message) => input.view === "all" || message.acknowledgements.length === 0);
}

export async function acknowledgeOfficeMessage(
  fhir: OfficeFhir,
  input: { messageId: string; staffReference: string; role: PracticeRoleId; now?: string },
): Promise<OfficeMessageRow> {
  const message = await fhir.read<Communication>("Communication", input.messageId);
  if (!isOfficeMessage(message) || !isRecipient(message, input.staffReference, input.role)) {
    throw new OfficeMessageValidationError("Office message is not available to this caller.");
  }
  const existing = await searchOnePage<Provenance>(fhir, "Provenance", {
    target: `Communication/${input.messageId}`,
    _count: "1000",
    _sort: "recorded",
  });
  const alreadyAcknowledged = existing.some((event) => isAcknowledgement(event) && event.agent?.some((agent) => agent.who.reference === input.staffReference));
  if (!alreadyAcknowledged) {
    const at = input.now ?? new Date().toISOString();
    const display = await staffDisplay(fhir, input.staffReference);
    const created = await fhir.create<Provenance>({
      resourceType: "Provenance",
      target: [{ reference: `Communication/${input.messageId}` }],
      occurredDateTime: at,
      recorded: at,
      activity: { coding: [{ system: OFFICE_ACK_SYSTEM, code: OFFICE_ACK_CODE, display: "Office message acknowledged" }], text: "Office message acknowledged" },
      agent: [{ who: { reference: input.staffReference, display } }],
    });
    existing.push(created);
  }
  return projectMessage(message, existing.filter(isAcknowledgement));
}

function projectMessage(message: Communication, acknowledgements: Provenance[]): OfficeMessageRow {
  if (!message.id || !message.sent || !message.sender?.reference) throw new Error("Stored office message is missing required data.");
  const recipient = message.recipient?.[0];
  const patientReference = message.subject?.reference?.match(/^Patient\/([A-Za-z0-9.-]{1,64})$/);
  return {
    id: message.id,
    text: message.payload?.find((payload) => typeof payload.contentString === "string")?.contentString ?? "",
    sentAt: message.sent,
    sender: { reference: message.sender.reference, display: message.sender.display ?? message.sender.reference },
    recipient: {
      ...(recipient?.reference ? { reference: recipient.reference } : {}),
      ...(recipient?.identifier?.system === OFFICE_ROLE_SYSTEM && recipient.identifier.value ? { role: recipient.identifier.value as PracticeRoleId } : {}),
      display: recipient?.display ?? recipient?.reference ?? recipient?.identifier?.value ?? "Office recipient",
    },
    urgent: message.priority === "urgent" || message.priority === "asap" || message.priority === "stat",
    ...(patientReference ? { patient: { reference: message.subject!.reference!, id: patientReference[1], display: message.subject?.display ?? message.subject!.reference! } } : {}),
    acknowledgements: acknowledgements.flatMap((event) => {
      const agent = event.agent?.[0]?.who;
      const at = event.occurredDateTime ?? event.recorded;
      return agent?.reference && at ? [{ by: agent.reference, display: agent.display ?? agent.reference, at }] : [];
    }),
  };
}

function isRecipient(message: Communication, staffReference: string, role: PracticeRoleId): boolean {
  return (message.recipient ?? []).some((recipient) =>
    recipient.reference === staffReference ||
    (recipient.identifier?.system === OFFICE_ROLE_SYSTEM && recipient.identifier.value === role),
  );
}

function isOfficeMessage(message: Communication): boolean {
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

async function searchOnePage<T extends Resource>(fhir: Pick<OfficeFhir, "search">, resourceType: T["resourceType"], params: Record<string, string>): Promise<T[]> {
  const bundle = await fhir.search<T>(resourceType, params);
  if (bundle.link?.some((link) => link.relation === "next")) throw new Error(`${resourceType} office-message query exceeded one FHIR page; refusing partial state.`);
  return (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []);
}

async function readPatient(fhir: Pick<OfficeFhir, "read">, reference: string): Promise<Patient> {
  return fhir.read<Patient>("Patient", reference.split("/")[1]);
}

async function staffDisplay(fhir: Pick<OfficeFhir, "read">, reference: string): Promise<string> {
  const [resourceType, id] = reference.split("/");
  if (resourceType === "Practitioner") return practitionerName(await fhir.read<Practitioner>("Practitioner", id));
  const role = await fhir.read<PractitionerRole>("PractitionerRole", id);
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

function roleDisplay(role: PracticeRoleId): string {
  return role === "clinician" ? "Clinician role" : role.split("-").map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
}
