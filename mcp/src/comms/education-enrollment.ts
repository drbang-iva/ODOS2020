import { createHash, randomUUID } from "node:crypto";
import type { Basic, Bundle, Extension, Resource } from "@medplum/fhirtypes";
import type { MedplumClient } from "../fhir-client.js";
import { searchBounded } from "../fhir-search.js";
import type { SendResult } from "./comms-provider.js";

const ENROLLMENT_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/education-enrollment-id";
const ACTIVE_ENROLLMENT_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/education-enrollment-active";
const BASIC_CODE_SYSTEM =
  "https://odos2020.com/fhir/CodeSystem/basic-resource-kind";
const ENROLLMENT_CODE = "education-enrollment";
const JOURNEY_ID =
  "https://odos2020.com/fhir/StructureDefinition/education-enrollment-journey-id";
const JOURNEY_VERSION =
  "https://odos2020.com/fhir/StructureDefinition/education-enrollment-journey-version";
const CURRENT_STAGE_ID =
  "https://odos2020.com/fhir/StructureDefinition/education-enrollment-current-stage-id";
const STAGE_ENTERED_AT =
  "https://odos2020.com/fhir/StructureDefinition/education-enrollment-stage-entered-at";
const ENTERED_FROM_ENCOUNTER =
  "https://odos2020.com/fhir/StructureDefinition/education-enrollment-entered-from-encounter";
const ENROLLED_BY =
  "https://odos2020.com/fhir/StructureDefinition/education-enrollment-enrolled-by";
const ENROLLMENT_STATUS =
  "https://odos2020.com/fhir/StructureDefinition/education-enrollment-status";
const STAGE_HISTORY =
  "https://odos2020.com/fhir/StructureDefinition/education-enrollment-stage-history";
const IMMEDIATE_SEND =
  "https://odos2020.com/fhir/StructureDefinition/education-enrollment-immediate-send";

export type EducationEnrollmentStatus = "active" | "completed" | "cancelled";
export type EducationEnrollmentSendOutcome = SendResult | {
  outcome: "print";
  url: string;
};

export interface JourneyDefinitionReference {
  id: string;
  version: number;
}

export interface EducationEnrollmentStageEntry {
  stageId: string;
  enteredAt: string;
  enteredBy: string;
  reason: string;
}

export interface EducationEnrollmentImmediateSend {
  content: { id: string; version: number };
  channel: "sms" | "email" | "print";
  lane: "clinical" | "frontdesk";
  outcome?: EducationEnrollmentSendOutcome;
}

export interface EducationEnrollment {
  id: string;
  patientReference: string;
  journey: JourneyDefinitionReference;
  currentStageId: string;
  stageEnteredAt: string;
  enteredFromEncounterReference: string;
  enrolledBy: string;
  status: EducationEnrollmentStatus;
  stageHistory: EducationEnrollmentStageEntry[];
  immediateSends: EducationEnrollmentImmediateSend[];
}

export type NewEducationEnrollment = Omit<EducationEnrollment, "id">;

export interface EducationEnrollmentStore {
  create(enrollment: NewEducationEnrollment): Promise<EducationEnrollment>;
  read(id: string): Promise<EducationEnrollment | undefined>;
  listActiveForPatient(patientReference: string): Promise<EducationEnrollment[]>;
  recordImmediateSendOutcome(
    id: string,
    sendIndex: number,
    outcome: EducationEnrollmentSendOutcome,
  ): Promise<EducationEnrollment>;
}

export class EducationEnrollmentDuplicateError extends Error {
  constructor() {
    super("An active enrollment already exists for this patient and journey.");
    this.name = "EducationEnrollmentDuplicateError";
  }
}

export function createInMemoryEducationEnrollmentStore(
  deps: { generateId?: () => string } = {},
): EducationEnrollmentStore {
  const rows = new Map<string, EducationEnrollment>();
  return {
    async create(input) {
      validateNewEnrollment(input);
      if ([...rows.values()].some((row) =>
        row.status === "active"
        && row.patientReference === input.patientReference
        && row.journey.id === input.journey.id)) {
        throw new EducationEnrollmentDuplicateError();
      }
      const row = { ...structuredClone(input), id: deps.generateId?.() ?? randomUUID() };
      rows.set(row.id, row);
      return structuredClone(row);
    },
    async read(id) {
      const row = rows.get(id);
      return row ? structuredClone(row) : undefined;
    },
    async listActiveForPatient(patientReference) {
      requiredReference(patientReference, "Patient", "patientReference");
      return [...rows.values()]
        .filter((row) => row.status === "active" && row.patientReference === patientReference)
        .map((row) => structuredClone(row));
    },
    async recordImmediateSendOutcome(id, sendIndex, outcome) {
      const row = rows.get(id);
      if (!row) throw new Error("EducationEnrollment not found.");
      recordOutcome(row, sendIndex, outcome);
      return structuredClone(row);
    },
  };
}

export type EducationEnrollmentFhir = Pick<
  MedplumClient,
  "baseUrl" | "search" | "searchUrl" | "create" | "read" | "update"
>;

export function createFhirEducationEnrollmentStore(
  fhir: EducationEnrollmentFhir,
): EducationEnrollmentStore {
  return {
    async create(input) {
      validateNewEnrollment(input);
      const activeIdentifier = activeEnrollmentIdentifier(input.patientReference, input.journey.id);
      if ((await activeMatches(fhir, activeIdentifier)).length > 0) {
        throw new EducationEnrollmentDuplicateError();
      }
      const requestId = randomUUID();
      const resource = enrollmentResource({ ...structuredClone(input), id: requestId }, activeIdentifier);
      const persisted = await fhir.create<Basic>(resource, {
        "If-None-Exist": `identifier=${ACTIVE_ENROLLMENT_IDENTIFIER_SYSTEM}|${activeIdentifier}`,
      });
      const requestWon = persisted.identifier?.some((identifier) =>
        identifier.system === ENROLLMENT_IDENTIFIER_SYSTEM && identifier.value === requestId);
      if (!requestWon) throw new EducationEnrollmentDuplicateError();
      return parseEnrollment(persisted);
    },
    async read(id) {
      try {
        return parseEnrollment(await fhir.read<Basic>("Basic", resourceId(id, "enrollment id")));
      } catch (error) {
        if ([404, 410].includes((error as { status?: number })?.status ?? 0)) return undefined;
        throw error;
      }
    },
    async listActiveForPatient(patientReference) {
      requiredReference(patientReference, "Patient", "patientReference");
      const resources = await searchBounded<Basic>(fhir, "Basic", {
        code: `${BASIC_CODE_SYSTEM}|${ENROLLMENT_CODE}`,
        _count: "100",
      }, { maxPages: 10, maxRows: 1_000 });
      return resources
        .map(parseEnrollment)
        .filter((row) => row.status === "active" && row.patientReference === patientReference);
    },
    async recordImmediateSendOutcome(id, sendIndex, outcome) {
      const resource = await fhir.read<Basic>("Basic", resourceId(id, "enrollment id"));
      const enrollment = parseEnrollment(resource);
      const existing = enrollment.immediateSends[sendIndex];
      if (!existing) throw new Error("EducationEnrollment immediate send index is invalid.");
      if (existing.outcome) {
        if (JSON.stringify(existing.outcome) !== JSON.stringify(outcome)) {
          throw new Error("EducationEnrollment immediate send outcome is already recorded.");
        }
        return enrollment;
      }
      const sendExtension = resource.extension?.filter((entry) => entry.url === IMMEDIATE_SEND)[sendIndex];
      if (!sendExtension) throw new Error("EducationEnrollment immediate send extension is missing.");
      sendExtension.extension = [
        ...(sendExtension.extension ?? []),
        ...outcomeExtensions(outcome),
      ];
      const updated = await fhir.update<Basic>("Basic", resource.id!, resource, {
        ...(resource.meta?.versionId ? { "If-Match": `W/\"${resource.meta.versionId}\"` } : {}),
      });
      return parseEnrollment(updated);
    },
  };
}

async function activeMatches(
  fhir: EducationEnrollmentFhir,
  activeIdentifier: string,
): Promise<EducationEnrollment[]> {
  const bundle = await fhir.search<Basic>("Basic", {
    identifier: `${ACTIVE_ENROLLMENT_IDENTIFIER_SYSTEM}|${activeIdentifier}`,
    _count: "2",
  });
  return resources(bundle)
    .filter(isEnrollmentResource)
    .map(parseEnrollment)
    .filter((row) => row.status === "active");
}

function enrollmentResource(
  enrollment: EducationEnrollment,
  activeIdentifier: string,
): Basic {
  return {
    resourceType: "Basic",
    identifier: [
      { system: ENROLLMENT_IDENTIFIER_SYSTEM, value: enrollment.id },
      { system: ACTIVE_ENROLLMENT_IDENTIFIER_SYSTEM, value: activeIdentifier },
    ],
    code: {
      coding: [{
        system: BASIC_CODE_SYSTEM,
        code: ENROLLMENT_CODE,
        display: "Education enrollment",
      }],
    },
    subject: { reference: enrollment.patientReference },
    created: enrollment.stageEnteredAt.slice(0, 10),
    extension: [
      { url: JOURNEY_ID, valueString: enrollment.journey.id },
      { url: JOURNEY_VERSION, valueInteger: enrollment.journey.version },
      { url: CURRENT_STAGE_ID, valueString: enrollment.currentStageId },
      { url: STAGE_ENTERED_AT, valueInstant: enrollment.stageEnteredAt },
      { url: ENTERED_FROM_ENCOUNTER, valueReference: { reference: enrollment.enteredFromEncounterReference } },
      { url: ENROLLED_BY, valueReference: { reference: enrollment.enrolledBy } },
      { url: ENROLLMENT_STATUS, valueCode: enrollment.status },
      ...enrollment.stageHistory.map(stageHistoryExtension),
      ...enrollment.immediateSends.map(immediateSendExtension),
    ],
  };
}

function parseEnrollment(resource: Basic): EducationEnrollment {
  if (!isEnrollmentResource(resource)) throw new Error("Basic is not an EducationEnrollment.");
  const id = resource.id ?? extensionStringIdentifier(resource, ENROLLMENT_IDENTIFIER_SYSTEM);
  const patientReference = resource.subject?.reference ?? "";
  const journeyId = extensionValue(resource, JOURNEY_ID, "valueString");
  const journeyVersion = extensionNumber(resource, JOURNEY_VERSION, "valueInteger");
  const currentStageId = extensionValue(resource, CURRENT_STAGE_ID, "valueString");
  const stageEnteredAt = extensionValue(resource, STAGE_ENTERED_AT, "valueInstant");
  const enteredFromEncounterReference = extensionReference(resource, ENTERED_FROM_ENCOUNTER);
  const enrolledBy = extensionReference(resource, ENROLLED_BY);
  const status = extensionValue(resource, ENROLLMENT_STATUS, "valueCode") as EducationEnrollmentStatus;
  const enrollment: EducationEnrollment = {
    id: resourceId(id, "stored enrollment id"),
    patientReference: requiredReference(patientReference, "Patient", "stored patient reference"),
    journey: {
      id: definitionId(journeyId, "stored journey id"),
      version: positiveInteger(journeyVersion, "stored journey version"),
    },
    currentStageId: definitionId(currentStageId, "stored current stage id"),
    stageEnteredAt: instant(stageEnteredAt, "stored stage entered timestamp"),
    enteredFromEncounterReference: requiredReference(
      enteredFromEncounterReference,
      "Encounter",
      "stored entered-from encounter reference",
    ),
    enrolledBy: requiredReference(enrolledBy, "Practitioner", "stored enrolled-by reference"),
    status,
    stageHistory: (resource.extension ?? [])
      .filter((entry) => entry.url === STAGE_HISTORY)
      .map(parseStageHistory),
    immediateSends: (resource.extension ?? [])
      .filter((entry) => entry.url === IMMEDIATE_SEND)
      .map(parseImmediateSend),
  };
  validateEnrollment(enrollment);
  return enrollment;
}

function stageHistoryExtension(entry: EducationEnrollmentStageEntry): Extension {
  return {
    url: STAGE_HISTORY,
    extension: [
      { url: "stage-id", valueString: entry.stageId },
      { url: "entered-at", valueInstant: entry.enteredAt },
      { url: "entered-by", valueReference: { reference: entry.enteredBy } },
      { url: "reason", valueCode: entry.reason },
    ],
  };
}

function immediateSendExtension(send: EducationEnrollmentImmediateSend): Extension {
  return {
    url: IMMEDIATE_SEND,
    extension: [
      { url: "content-id", valueString: send.content.id },
      { url: "content-version", valueInteger: send.content.version },
      { url: "channel", valueCode: send.channel },
      { url: "lane", valueCode: send.lane },
      ...(send.outcome ? outcomeExtensions(send.outcome) : []),
    ],
  };
}

function outcomeExtensions(outcome: EducationEnrollmentSendOutcome): Extension[] {
  return [
    { url: "outcome", valueCode: outcome.outcome },
    ...(outcome.outcome === "sent" ? [
      { url: "provider-message-id", valueString: outcome.providerMessageId },
      ...(outcome.providerThreadId
        ? [{ url: "provider-thread-id", valueString: outcome.providerThreadId }]
        : []),
    ] : []),
    ...(outcome.outcome === "suppressed" ? [{ url: "reason", valueCode: outcome.reason }] : []),
    ...(outcome.outcome === "rescheduled" ? [
      { url: "reason", valueCode: outcome.reason },
      { url: "rescheduled-at", valueInstant: outcome.rescheduledAt },
    ] : []),
    ...(outcome.outcome === "print" ? [{ url: "url", valueUrl: outcome.url }] : []),
  ];
}

function parseStageHistory(extension: Extension): EducationEnrollmentStageEntry {
  return {
    stageId: definitionId(nestedValue(extension, "stage-id", "valueString"), "stored stage history id"),
    enteredAt: instant(nestedValue(extension, "entered-at", "valueInstant"), "stored stage history timestamp"),
    enteredBy: requiredReference(
      nestedReference(extension, "entered-by"),
      "Practitioner",
      "stored stage history actor",
    ),
    reason: definitionId(nestedValue(extension, "reason", "valueCode"), "stored stage history reason"),
  };
}

function parseImmediateSend(extension: Extension): EducationEnrollmentImmediateSend {
  const channel = nestedValue(extension, "channel", "valueCode");
  const lane = nestedValue(extension, "lane", "valueCode");
  const outcomeCode = nestedValue(extension, "outcome", "valueCode", false);
  const send: EducationEnrollmentImmediateSend = {
    content: {
      id: definitionId(nestedValue(extension, "content-id", "valueString"), "stored content id"),
      version: positiveInteger(
        nestedNumber(extension, "content-version", "valueInteger"),
        "stored content version",
      ),
    },
    channel: channel as EducationEnrollmentImmediateSend["channel"],
    lane: lane as EducationEnrollmentImmediateSend["lane"],
    ...(outcomeCode ? { outcome: parseOutcome(extension, outcomeCode) } : {}),
  };
  validateImmediateSend(send);
  return send;
}

function parseOutcome(extension: Extension, code: string): EducationEnrollmentSendOutcome {
  if (code === "sent") {
    return {
      outcome: "sent",
      providerMessageId: nestedValue(extension, "provider-message-id", "valueString"),
      ...(nestedValue(extension, "provider-thread-id", "valueString", false)
        ? { providerThreadId: nestedValue(extension, "provider-thread-id", "valueString") }
        : {}),
    };
  }
  if (code === "suppressed") {
    const reason = nestedValue(extension, "reason", "valueCode");
    if (reason !== "patient-opt-out" && reason !== "frequency-cap") {
      throw new Error("Stored EducationEnrollment suppressed reason is invalid.");
    }
    return { outcome: "suppressed", reason };
  }
  if (code === "rescheduled") {
    if (nestedValue(extension, "reason", "valueCode") !== "quiet-hours") {
      throw new Error("Stored EducationEnrollment rescheduled reason is invalid.");
    }
    return {
      outcome: "rescheduled",
      reason: "quiet-hours",
      rescheduledAt: instant(
        nestedValue(extension, "rescheduled-at", "valueInstant"),
        "stored rescheduled timestamp",
      ),
    };
  }
  if (code === "print") {
    return { outcome: "print", url: httpsUrl(nestedValue(extension, "url", "valueUrl")) };
  }
  throw new Error("Stored EducationEnrollment send outcome is invalid.");
}

function validateNewEnrollment(input: NewEducationEnrollment): void {
  validateEnrollment({ ...input, id: "validation-id" });
  if (input.immediateSends.some((send) => send.outcome !== undefined)) {
    throw new Error("New EducationEnrollment immediate sends cannot already have outcomes.");
  }
}

function validateEnrollment(enrollment: EducationEnrollment): void {
  resourceId(enrollment.id, "enrollment id");
  requiredReference(enrollment.patientReference, "Patient", "patientReference");
  definitionId(enrollment.journey.id, "journey id");
  positiveInteger(enrollment.journey.version, "journey version");
  definitionId(enrollment.currentStageId, "current stage id");
  instant(enrollment.stageEnteredAt, "stage entered timestamp");
  requiredReference(enrollment.enteredFromEncounterReference, "Encounter", "entered-from encounter reference");
  requiredReference(enrollment.enrolledBy, "Practitioner", "enrolled-by reference");
  if (!["active", "completed", "cancelled"].includes(enrollment.status)) {
    throw new Error("EducationEnrollment status is invalid.");
  }
  if (enrollment.stageHistory.length === 0) {
    throw new Error("EducationEnrollment stage history is required.");
  }
  for (const entry of enrollment.stageHistory) {
    definitionId(entry.stageId, "stage history id");
    instant(entry.enteredAt, "stage history timestamp");
    requiredReference(entry.enteredBy, "Practitioner", "stage history actor");
    definitionId(entry.reason, "stage history reason");
  }
  for (const send of enrollment.immediateSends) validateImmediateSend(send);
}

function validateImmediateSend(send: EducationEnrollmentImmediateSend): void {
  definitionId(send.content.id, "content id");
  positiveInteger(send.content.version, "content version");
  if (!["sms", "email", "print"].includes(send.channel)) {
    throw new Error("EducationEnrollment immediate-send channel is invalid.");
  }
  if (!["clinical", "frontdesk"].includes(send.lane)) {
    throw new Error("EducationEnrollment immediate-send lane is invalid.");
  }
}

function recordOutcome(
  enrollment: EducationEnrollment,
  sendIndex: number,
  outcome: EducationEnrollmentSendOutcome,
): void {
  const send = enrollment.immediateSends[sendIndex];
  if (!send) throw new Error("EducationEnrollment immediate send index is invalid.");
  if (send.outcome) {
    if (JSON.stringify(send.outcome) !== JSON.stringify(outcome)) {
      throw new Error("EducationEnrollment immediate send outcome is already recorded.");
    }
    return;
  }
  send.outcome = structuredClone(outcome);
}

function activeEnrollmentIdentifier(patientReference: string, journeyId: string): string {
  return createHash("sha256")
    .update(`${patientReference}\u0000${journeyId}`)
    .digest("hex");
}

function isEnrollmentResource(resource: Basic): boolean {
  return resource.code.coding?.some((coding) =>
    coding.system === BASIC_CODE_SYSTEM && coding.code === ENROLLMENT_CODE) === true;
}

function resources(bundle: Bundle<Basic>): Basic[] {
  return (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []);
}

function extensionStringIdentifier(resource: Basic, system: string): string {
  return resource.identifier?.find((identifier) => identifier.system === system)?.value ?? "";
}

function extensionValue(
  resource: Basic,
  url: string,
  field: "valueString" | "valueCode" | "valueInstant",
): string {
  const value = resource.extension?.find((entry) => entry.url === url)?.[field];
  return typeof value === "string" ? value : "";
}

function extensionNumber(resource: Basic, url: string, field: "valueInteger"): number {
  const value = resource.extension?.find((entry) => entry.url === url)?.[field];
  return typeof value === "number" ? value : Number.NaN;
}

function extensionReference(resource: Basic, url: string): string {
  return resource.extension?.find((entry) => entry.url === url)?.valueReference?.reference ?? "";
}

function nestedValue(
  extension: Extension,
  url: string,
  field: "valueString" | "valueCode" | "valueInstant" | "valueUrl",
  required = true,
): string {
  const value = extension.extension?.find((entry) => entry.url === url)?.[field];
  if (typeof value === "string") return value;
  if (!required) return "";
  throw new Error(`Stored EducationEnrollment ${url} is missing.`);
}

function nestedNumber(extension: Extension, url: string, field: "valueInteger"): number {
  const value = extension.extension?.find((entry) => entry.url === url)?.[field];
  return typeof value === "number" ? value : Number.NaN;
}

function nestedReference(extension: Extension, url: string): string {
  return extension.extension?.find((entry) => entry.url === url)?.valueReference?.reference ?? "";
}

function resourceId(value: string, label: string): string {
  if (!/^[A-Za-z0-9.-]{1,64}$/.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function requiredReference(value: string, resourceType: "Patient" | "Encounter" | "Practitioner", label: string): string {
  if (!new RegExp(`^${resourceType}/[A-Za-z0-9.-]{1,64}$`).test(value)) {
    throw new Error(`${label} must be ${resourceType}/<id>.`);
  }
  return value;
}

function definitionId(value: string, label: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer.`);
  return value;
}

function instant(value: string, label: string): string {
  if (!value || Number.isNaN(Date.parse(value))) throw new Error(`${label} is invalid.`);
  return value;
}

function httpsUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Stored EducationEnrollment print URL is invalid.");
  }
  if (url.protocol !== "https:") throw new Error("Stored EducationEnrollment print URL is invalid.");
  return value;
}
