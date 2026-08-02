import type { Annotation, CodeableConcept, Communication, Identifier, Patient } from "@medplum/fhirtypes";
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
  const existing = await findCommunication(fhir, identity.system, identity.value);
  const fragment = await eventFragment(fhir, kind, event, now);
  if (!existing) {
    const baseCategory = category(identity.category);
    return fhir.create<Communication>({
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
  }
  if (!existing.id) throw new Error("Persisted Twilio Communication is missing its FHIR id.");
  return fhir.update<Communication>("Communication", existing.id, {
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
    note: mergeNotes(existing.note, fragment.note),
    payload: fragment.payload ?? existing.payload,
    subject: fragment.subject ?? existing.subject,
    sender: fragment.sender ?? existing.sender,
    recipient: fragment.recipient ?? existing.recipient,
    received: fragment.received ?? existing.received,
    sent: fragment.sent ?? existing.sent,
    status: fragment.status ?? existing.status,
  });
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
