import type { Annotation, CodeableConcept, Communication, Identifier, Patient } from "@medplum/fhirtypes";
import { isDeepStrictEqual } from "node:util";
import type { MedplumClient } from "../fhir-client.js";
import type {
  TwilioInboundWebhookEvent,
  TwilioRecordingWebhookEvent,
  TwilioStatusWebhookEvent,
  TwilioTranscriptionWebhookEvent,
  TwilioVoiceWebhookEvent,
} from "./adapters/twilio-adapter.js";

export const ODOS_TWILIO_MESSAGE_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/twilio-message-sid";
export const ODOS_TWILIO_CALL_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/twilio-call-sid";
export const ODOS_COMMS_PHONE_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/phone-number";
export const ODOS_COMMS_CATEGORY_SYSTEM =
  "https://odos2020.com/fhir/CodeSystem/communication-category";
export const ODOS_PATIENT_SMS_CATEGORY = "patient-sms";
export const ODOS_PATIENT_CALL_CATEGORY = "patient-call";
export const ODOS_PATIENT_SMS_INBOUND_CATEGORY = "patient-sms-inbound";
export const ODOS_PATIENT_SMS_OUTBOUND_CATEGORY = "patient-sms-outbound";
export const ODOS_PATIENT_CALL_INBOUND_CATEGORY = "patient-call-inbound";
export const ODOS_PATIENT_CALL_OUTBOUND_CATEGORY = "patient-call-outbound";
export const ODOS_TWILIO_RECORDING_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/twilio-recording-sid";
export const ODOS_TWILIO_TRANSCRIPTION_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/twilio-transcription-sid";

const TWILIO_CALL_METADATA_AUTHOR = "ODOS Twilio call metadata";
const TWILIO_RECORDING_METADATA_AUTHOR = "ODOS Twilio recording metadata";
const TWILIO_TRANSCRIPTION_METADATA_AUTHOR = "ODOS Twilio transcription metadata";
const communicationWrites = new Map<string, Promise<void>>();

export type TwilioWebhookKind =
  | "sms-inbound"
  | "sms-status"
  | "voice-inbound"
  | "voice-status"
  | "voice-recording"
  | "voice-transcription";

export type TwilioWebhookEvent =
  | TwilioInboundWebhookEvent
  | TwilioStatusWebhookEvent
  | TwilioVoiceWebhookEvent
  | TwilioRecordingWebhookEvent
  | TwilioTranscriptionWebhookEvent;

export type CommsPersistenceFhir = Pick<MedplumClient, "search" | "create" | "update">;

export async function persistTwilioWebhookEvent(
  fhir: CommsPersistenceFhir,
  kind: TwilioWebhookKind,
  event: TwilioWebhookEvent,
  deps: { now?: () => string } = {},
): Promise<Communication> {
  const now = deps.now?.() ?? new Date().toISOString();
  const identity = eventIdentity(kind, event);
  return serializeCommunicationWrite(`${identity.system}|${identity.value}`, () =>
    persistTwilioWebhookEventLocked(fhir, kind, event, identity, now));
}

export async function persistStaffSentSms(
  fhir: CommsPersistenceFhir,
  input: { messageSid: string; patientReference: string; senderReference: string; body: string },
  deps: { now?: () => string } = {},
): Promise<Communication> {
  const identity = {
    system: ODOS_TWILIO_MESSAGE_IDENTIFIER_SYSTEM,
    value: input.messageSid,
    category: ODOS_PATIENT_SMS_CATEGORY,
  };
  const fragment: Partial<Communication> = {
    status: "in-progress",
    subject: { reference: input.patientReference },
    sender: { reference: input.senderReference },
    recipient: [{ reference: input.patientReference }],
    sent: deps.now?.() ?? new Date().toISOString(),
    payload: [{ contentString: input.body }],
    category: [category(ODOS_PATIENT_SMS_OUTBOUND_CATEGORY)],
  };
  return serializeCommunicationWrite(`${identity.system}|${identity.value}`, () =>
    persistCommunicationFragment(fhir, identity, fragment));
}

async function persistTwilioWebhookEventLocked(
  fhir: CommsPersistenceFhir,
  kind: TwilioWebhookKind,
  event: TwilioWebhookEvent,
  identity: ReturnType<typeof eventIdentity>,
  now: string,
): Promise<Communication> {
  const fragment = await eventFragment(fhir, kind, event, now);
  return persistCommunicationFragment(fhir, identity, fragment);
}

async function persistCommunicationFragment(
  fhir: CommsPersistenceFhir,
  identity: ReturnType<typeof eventIdentity>,
  fragment: Partial<Communication>,
): Promise<Communication> {
  const existing = await findCommunication(fhir, identity.system, identity.value);
  if (!existing) {
    const baseCategory = category(identity.category);
    const created = await fhir.create<Communication>({
      resourceType: "Communication",
      status: fragment.status ?? "unknown",
      medium: [{ text: identity.category === ODOS_PATIENT_SMS_CATEGORY ? "SMS" : "Voice call" }],
      ...fragment,
      identifier: mergeIdentifiers(
        [{ system: identity.system, value: identity.value }],
        fragment.identifier,
      ),
      category: mergeCategories([baseCategory], fragment.category),
    }, {
      "If-None-Exist": `identifier=${identity.system}|${identity.value}`,
    });
    const merged = mergeCommunication(created, fragment, identity);
    if (isDeepStrictEqual(created, merged)) return created;
    const winner = await findCommunication(fhir, identity.system, identity.value);
    if (!winner?.id) throw new Error("Persisted Twilio Communication is missing its FHIR id.");
    const mergedWinner = mergeCommunication(winner, fragment, identity);
    if (isDeepStrictEqual(winner, mergedWinner)) return winner;
    return fhir.update<Communication>("Communication", winner.id, mergedWinner);
  }
  if (!existing.id) throw new Error("Persisted Twilio Communication is missing its FHIR id.");
  return fhir.update<Communication>("Communication", existing.id, mergeCommunication(existing, fragment, identity));
}

function mergeCommunication(
  existing: Communication,
  fragment: Partial<Communication>,
  identity: ReturnType<typeof eventIdentity>,
): Communication {
  const acceptStatus = acceptsIncomingStatus(existing.status, existing.statusReason, fragment.status);
  const incomingNotes = acceptStatus
    ? fragment.note
    : fragment.note?.filter((note) => note.authorString !== TWILIO_CALL_METADATA_AUTHOR);
  return Object.fromEntries(Object.entries({
    ...existing,
    ...fragment,
    identifier: mergeIdentifiers(
      existing.identifier,
      [{ system: identity.system, value: identity.value }, ...(fragment.identifier ?? [])],
    ),
    category: mergeCategories(
      existing.category ?? [category(identity.category)],
      fragment.category,
    ),
    medium: existing.medium ?? [{ text: identity.category === ODOS_PATIENT_SMS_CATEGORY ? "SMS" : "Voice call" }],
    note: mergeNotes(existing.note, incomingNotes),
    payload: fragment.payload ?? existing.payload,
    subject: fragment.subject ?? existing.subject,
    sender: fragment.sender ?? existing.sender,
    recipient: fragment.recipient ?? existing.recipient,
    received: existing.received ?? fragment.received,
    sent: existing.sent ?? fragment.sent,
    status: acceptStatus ? fragment.status ?? existing.status : existing.status,
    statusReason: acceptStatus ? fragment.statusReason ?? existing.statusReason : existing.statusReason,
  }).filter(([, value]) => value !== undefined)) as unknown as Communication;
}

async function serializeCommunicationWrite<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = communicationWrites.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  communicationWrites.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (communicationWrites.get(key) === tail) communicationWrites.delete(key);
  }
}

function eventIdentity(kind: TwilioWebhookKind, event: TwilioWebhookEvent) {
  if (kind === "sms-inbound" || kind === "sms-status") {
    return {
      system: ODOS_TWILIO_MESSAGE_IDENTIFIER_SYSTEM,
      value: (event as TwilioInboundWebhookEvent | TwilioStatusWebhookEvent).messageSid,
      category: ODOS_PATIENT_SMS_CATEGORY,
    };
  }
  return {
    system: ODOS_TWILIO_CALL_IDENTIFIER_SYSTEM,
    value: (event as TwilioVoiceWebhookEvent | TwilioRecordingWebhookEvent | TwilioTranscriptionWebhookEvent).callId,
    category: ODOS_PATIENT_CALL_CATEGORY,
  };
}

async function eventFragment(
  fhir: CommsPersistenceFhir,
  kind: TwilioWebhookKind,
  event: TwilioWebhookEvent,
  now: string,
): Promise<Partial<Communication>> {
  switch (kind) {
    case "sms-inbound": {
      const inbound = event as TwilioInboundWebhookEvent;
      const patient = await patientForPhone(fhir, inbound.from);
      return {
        status: "completed",
        ...(patient ? { subject: patientReference(patient), sender: patientReference(patient) } : { sender: phoneReference(inbound.from) }),
        recipient: [phoneReference(inbound.to)],
        received: now,
        payload: [{ contentString: inbound.body }],
        category: [category(ODOS_PATIENT_SMS_INBOUND_CATEGORY)],
      };
    }
    case "sms-status": {
      const status = event as TwilioStatusWebhookEvent;
      return {
        status: communicationStatusForMessage(status.messageStatus),
        statusReason: { text: `Twilio message status: ${status.messageStatus}` },
      };
    }
    case "voice-inbound":
    case "voice-status": {
      const voice = event as TwilioVoiceWebhookEvent;
      const patientPhone = voice.direction === "inbound" ? voice.from : voice.to;
      const patient = patientPhone.startsWith("+") ? await patientForPhone(fhir, patientPhone) : undefined;
      const inbound = voice.direction === "inbound";
      const sender = inbound
        ? patient ? patientReference(patient) : phoneReference(voice.from)
        : phoneReference(voice.from);
      const recipient = inbound
        ? [phoneReference(voice.to)]
        : [patient ? patientReference(patient) : phoneReference(voice.to)];
      return {
        status: communicationStatusForCall(voice.status),
        ...(patient ? { subject: patientReference(patient) } : {}),
        sender,
        recipient,
        ...(kind === "voice-inbound" ? { received: now } : {}),
        category: [category(inbound ? ODOS_PATIENT_CALL_INBOUND_CATEGORY : ODOS_PATIENT_CALL_OUTBOUND_CATEGORY)],
        statusReason: { text: `Twilio call status: ${voice.status}` },
        ...(voice.recordingId ? {
          identifier: [{ system: ODOS_TWILIO_RECORDING_IDENTIFIER_SYSTEM, value: voice.recordingId }],
        } : {}),
        note: [metadataNote(TWILIO_CALL_METADATA_AUTHOR, now, {
          direction: inbound ? "inbound" : "outbound",
          status: voice.status,
          durationSeconds: voice.durationSeconds,
        })],
      };
    }
    case "voice-recording": {
      const recording = event as TwilioRecordingWebhookEvent;
      return {
        identifier: [{ system: ODOS_TWILIO_RECORDING_IDENTIFIER_SYSTEM, value: recording.recordingId }],
        note: [metadataNote(TWILIO_RECORDING_METADATA_AUTHOR, now, {
          status: recording.status,
          durationSeconds: recording.durationSeconds,
          channels: recording.channels,
        })],
      };
    }
    case "voice-transcription": {
      const transcription = event as TwilioTranscriptionWebhookEvent;
      return {
        identifier: [{ system: ODOS_TWILIO_TRANSCRIPTION_IDENTIFIER_SYSTEM, value: transcription.transcriptionId }],
        note: [metadataNote(TWILIO_TRANSCRIPTION_METADATA_AUTHOR, now, {
          event: transcription.event,
          timestamp: transcription.timestamp,
          sequenceId: transcription.sequenceId,
          languageCode: transcription.languageCode,
          track: transcription.track,
          confidence: transcription.confidence,
          final: transcription.final,
        })],
      };
    }
  }
}

async function findCommunication(
  fhir: CommsPersistenceFhir,
  system: string,
  value: string,
): Promise<Communication | undefined> {
  const bundle = await fhir.search<Communication>("Communication", {
    identifier: `${system}|${value}`,
    _count: "2",
  });
  const matches = (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []);
  if (matches.length > 1) throw new Error(`Twilio Communication identifier ${value} is not unique.`);
  return matches[0];
}

async function patientForPhone(
  fhir: CommsPersistenceFhir,
  phone: string,
): Promise<Patient | undefined> {
  const bundle = await fhir.search<Patient>("Patient", { telecom: phone, _count: "2" });
  const matches = (bundle.entry ?? []).flatMap((entry) => entry.resource?.id ? [entry.resource] : []);
  return matches.length === 1 ? matches[0] : undefined;
}

function patientReference(patient: Patient) {
  return { reference: `Patient/${patient.id}` } as const;
}

function phoneReference(phone: string) {
  return { identifier: { system: ODOS_COMMS_PHONE_IDENTIFIER_SYSTEM, value: phone } };
}

function communicationStatusForMessage(status: string): Communication["status"] {
  if (["sent", "delivered", "read"].includes(status)) return "completed";
  if (["failed", "undelivered"].includes(status)) return "not-done";
  if (["accepted", "queued", "sending", "scheduled"].includes(status)) return "in-progress";
  return "unknown";
}

function communicationStatusForCall(status: TwilioVoiceWebhookEvent["status"]): Communication["status"] {
  if (status === "completed") return "completed";
  if (["busy", "failed", "no-answer", "canceled"].includes(status)) return "not-done";
  return "in-progress";
}

function acceptsIncomingStatus(
  existing: Communication["status"],
  existingReason: Communication["statusReason"],
  incoming: Communication["status"] | undefined,
): boolean {
  if (!incoming) return false;
  if (existing !== "completed" && existing !== "not-done") return true;
  return incoming === existing && existingReason === undefined;
}

function category(code: string): CodeableConcept {
  return { coding: [{ system: ODOS_COMMS_CATEGORY_SYSTEM, code }] };
}

function mergeIdentifiers(existing: Identifier[] | undefined, incoming: Identifier[] | undefined): Identifier[] | undefined {
  if (!incoming?.length) return existing;
  const systems = new Set(incoming.map((identifier) => identifier.system));
  return [...incoming, ...(existing ?? []).filter((identifier) => !systems.has(identifier.system))];
}

function mergeCategories(existing: CodeableConcept[] | undefined, incoming: CodeableConcept[] | undefined): CodeableConcept[] | undefined {
  if (!incoming?.length) return existing;
  const codes = new Set(incoming.flatMap((concept) => concept.coding ?? []).map((coding) => `${coding.system}|${coding.code}`));
  return [
    ...(existing ?? []).filter((concept) => !concept.coding?.some((coding) => codes.has(`${coding.system}|${coding.code}`))),
    ...incoming,
  ];
}

function mergeNotes(existing: Annotation[] | undefined, incoming: Annotation[] | undefined): Annotation[] | undefined {
  if (!incoming?.length) return existing;
  const authors = new Set(incoming.map((note) => note.authorString));
  return [...(existing ?? []).filter((note) => !authors.has(note.authorString)), ...incoming];
}

function metadataNote(
  authorString: string,
  time: string,
  metadata: Record<string, string | number | boolean | undefined>,
): Annotation {
  return {
    authorString,
    time,
    text: Object.entries(metadata)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${value}`)
      .join("; "),
  };
}
