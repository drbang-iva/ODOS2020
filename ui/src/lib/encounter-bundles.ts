import type {
  Appointment,
  Bundle,
  CodeableConcept,
  Encounter,
  OperationOutcome,
  Provenance,
  Resource,
} from "@medplum/fhirtypes";
import { fhir } from "./fhir";
import type { JsonPatchOperation } from "./fhir";
import {
  medicalCoverageOf,
  ODOS_VISIT_TYPE_SYSTEM,
  visionCoverageOf,
} from "./scheduling";

export const ENCOUNTER_COMPREHENSIVE_EXAM_PROFILE =
  "https://odos2020.com/fhir/StructureDefinition/Encounter-ComprehensiveExam";
export const INTENDED_COVERAGE_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/intended-coverage";

const V3_ACT_CODE_SYSTEM = "http://terminology.hl7.org/CodeSystem/v3-ActCode";
const V3_DATA_OPERATION_SYSTEM = "http://terminology.hl7.org/CodeSystem/v3-DataOperation";
const PROVENANCE_PARTICIPANT_TYPE_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/provenance-participant-type";
const FALLBACK_PRACTITIONER_REFERENCE = "Practitioner/odos-admin";

export function buildStartEncounterCreateBundle(input: {
  patientId: string;
  now: string;
  practitionerReference?: string;
  episodeReference?: string;
  visitType?: CodeableConcept;
  appointmentContext?: {
    appointmentId: string;
    visitTypeCoding?: { system: string; code: string; display?: string };
    intendedCoverageReferences?: string[];
  };
}): Bundle {
  const encounterFullUrl = `urn:uuid:encounter-${crypto.randomUUID()}`;
  const patientReference = input.patientId.startsWith("Patient/")
    ? input.patientId
    : `Patient/${input.patientId}`;
  const appointmentReference = input.appointmentContext
    ? referenceOf("Appointment", input.appointmentContext.appointmentId)
    : undefined;
  const intendedCoverageReferences = input.appointmentContext?.intendedCoverageReferences ?? [];

  const encounter: Encounter = {
    resourceType: "Encounter",
    status: "arrived",
    class: {
      system: V3_ACT_CODE_SYSTEM,
      code: "AMB",
    },
    subject: { reference: patientReference },
    ...(input.episodeReference ? { episodeOfCare: [{ reference: input.episodeReference }] } : {}),
    ...(appointmentReference ? { appointment: [{ reference: appointmentReference }] } : {}),
    ...(input.visitType
      ? { type: [input.visitType] }
      : input.appointmentContext?.visitTypeCoding
      ? { type: [{ coding: [{ ...input.appointmentContext.visitTypeCoding }] }] }
      : {}),
    ...(intendedCoverageReferences.length > 0
      ? {
          extension: intendedCoverageReferences.map((reference) => ({
            url: INTENDED_COVERAGE_EXTENSION_URL,
            valueReference: { reference },
          })),
        }
      : {}),
    period: { start: input.now },
    meta: { profile: [ENCOUNTER_COMPREHENSIVE_EXAM_PROFILE] },
  };

  return {
    resourceType: "Bundle",
    type: "transaction",
    entry: [
      {
        fullUrl: encounterFullUrl,
        resource: encounter,
        request: {
          method: "POST",
          url: "Encounter",
          ...(appointmentReference
            ? { ifNoneExist: activeAppointmentEncounterCriteria(appointmentReference) }
            : {}),
        },
      },
      {
        fullUrl: `urn:uuid:provenance-start-${crypto.randomUUID()}`,
        resource: buildProvenance({
          targetReference: encounterFullUrl,
          patientReference,
          recorded: input.now,
          activityCode: "CREATE",
          activityDisplay: "Create",
          operatorDisplay: "ODOS UI start_encounter",
          practitionerReference: input.practitionerReference,
        }),
        request: { method: "POST", url: "Provenance" },
      },
    ],
  };
}

type AppointmentEncounterClient = Pick<typeof fhir, "search" | "executeTransaction">;

export async function findOpenEncounterForAppointment(
  appointmentId: string,
  client: AppointmentEncounterClient = fhir,
): Promise<Encounter | undefined> {
  const appointmentReference = referenceOf("Appointment", appointmentId);
  const bundle = await client.search<Encounter>("Encounter", [
    ["appointment", appointmentReference],
    ["status:not", "cancelled"],
    ["status:not", "entered-in-error"],
    ["_count", "2"],
  ]);
  return (bundle.entry ?? [])
    .flatMap((entry) => (entry.resource ? [entry.resource] : []))
    .find((encounter) =>
      encounter.status !== "cancelled"
      && encounter.status !== "entered-in-error"
      && Boolean(encounter.id),
    );
}

export async function startOrOpenEncounterForAppointment(
  appointment: Appointment,
  options: {
    existingEncounter?: Encounter | null;
    client?: AppointmentEncounterClient;
    now?: () => Date;
  } = {},
): Promise<{ encounterId: string; created: boolean }> {
  if (!appointment.id) {
    throw new Error("Starting an appointment chart requires Appointment.id.");
  }
  const patientReference = appointment.participant.find((participant) =>
    participant.actor?.reference?.startsWith("Patient/"),
  )?.actor?.reference;
  if (!patientReference) {
    throw new Error("Starting an appointment chart requires a patient participant.");
  }

  const client = options.client ?? fhir;
  const existing = options.existingEncounter === undefined
    ? await findOpenEncounterForAppointment(appointment.id, client)
    : options.existingEncounter ?? undefined;
  if (existing?.id) {
    return { encounterId: existing.id, created: false };
  }

  const visitType = appointment.serviceType?.[0]?.coding?.find(
    (coding) => coding.system === ODOS_VISIT_TYPE_SYSTEM && coding.code,
  );
  const visitTypeCoding = visitType
    ? {
        system: ODOS_VISIT_TYPE_SYSTEM,
        code: visitType.code!,
        ...(visitType.display ? { display: visitType.display } : {}),
      }
    : undefined;
  const intendedCoverageReferences = [
    visionCoverageOf(appointment)?.reference,
    medicalCoverageOf(appointment)?.reference,
  ].filter((reference, index, references): reference is string =>
    Boolean(reference) && references.indexOf(reference) === index,
  );
  const now = (options.now ?? (() => new Date()))();
  const patientId = patientReference.slice("Patient/".length);
  const createResponse = await client.executeTransaction(
    buildStartEncounterCreateBundle({
      patientId,
      now: now.toISOString(),
      appointmentContext: {
        appointmentId: appointment.id,
        visitTypeCoding,
        intendedCoverageReferences,
      },
    }),
    "start_appointment_encounter",
  );
  assertTransactionSuccess(createResponse);

  const encounterId = createdIdFromEntry(createResponse, 0, "Encounter");
  const created = createResponse.entry?.[0]?.response?.status?.startsWith("201") === true;
  const inProgressResponse = await client.executeTransaction(
    buildEncounterStatusPatchBundle({
      encounterId,
      patientId,
      recorded: new Date(now.getTime() + 1).toISOString(),
      operatorDisplay: "ODOS UI start_appointment_encounter",
      ops: [{ op: "replace", path: "/status", value: "in-progress" }],
    }),
    "start_appointment_encounter",
  );
  assertTransactionSuccess(inProgressResponse);

  return { encounterId, created };
}

export function buildEncounterStatusPatchBundle(input: {
  encounterId: string;
  patientId: string;
  ops: JsonPatchOperation[];
  recorded: string;
  operatorDisplay: string;
  practitionerReference?: string;
}): Bundle {
  const encounterReference = input.encounterId.startsWith("Encounter/")
    ? input.encounterId
    : `Encounter/${input.encounterId}`;
  const patientReference = input.patientId.startsWith("Patient/")
    ? input.patientId
    : `Patient/${input.patientId}`;

  return {
    resourceType: "Bundle",
    type: "transaction",
    entry: [
      {
        resource: jsonPatchBinary(input.ops),
        request: {
          method: "PATCH",
          url: encounterReference,
        },
      },
      {
        fullUrl: `urn:uuid:provenance-encounter-${crypto.randomUUID()}`,
        resource: buildProvenance({
          targetReference: encounterReference,
          patientReference,
          recorded: input.recorded,
          activityCode: "UPDATE",
          activityDisplay: "Update",
          operatorDisplay: input.operatorDisplay,
          practitionerReference: input.practitionerReference,
        }),
        request: { method: "POST", url: "Provenance" },
      },
    ],
  };
}

export function assertTransactionSuccess(bundle: Bundle): void {
  const failures = (bundle.entry ?? []).filter((entry) => {
    const status = entry.response?.status;
    return !status || !/^2\d\d/.test(status);
  });

  if (failures.length === 0) {
    return;
  }

  throw new Error(
    failures
      .map((entry, index) => {
        const status = entry.response?.status ?? "missing status";
        const detail = formatOperationOutcome(entry.response?.outcome as OperationOutcome | undefined);
        return `entry ${index}: ${status}${detail ? ` ${detail}` : ""}`;
      })
      .join("; "),
  );
}

export function createdIdFromEntry(
  bundle: Bundle,
  entryIndex: number,
  resourceType: string,
): string {
  const location = bundle.entry?.[entryIndex]?.response?.location;
  const match = location?.match(new RegExp(`^${resourceType}/([^/]+)`));
  if (!match) {
    throw new Error(`Transaction response entry ${entryIndex} did not include ${resourceType}/<id> location.`);
  }
  return match[1];
}

function buildProvenance(input: {
  targetReference: string;
  patientReference: string;
  recorded: string;
  activityCode: "CREATE" | "UPDATE";
  activityDisplay: string;
  operatorDisplay: string;
  practitionerReference?: string;
}): Provenance {
  return {
    resourceType: "Provenance",
    target: [
      { reference: input.targetReference },
      { reference: input.patientReference },
    ],
    recorded: input.recorded,
    activity: {
      coding: [
        {
          system: V3_DATA_OPERATION_SYSTEM,
          code: input.activityCode,
          display: input.activityDisplay,
        },
      ],
      text: input.activityDisplay,
    },
    agent: [
      {
        type: {
          coding: [
            {
              system: PROVENANCE_PARTICIPANT_TYPE_SYSTEM,
              code: "author",
              display: "Author",
            },
          ],
          text: "Author",
        },
        who: { display: input.operatorDisplay },
        onBehalfOf: {
          reference: input.practitionerReference ?? FALLBACK_PRACTITIONER_REFERENCE,
        },
      },
    ],
  };
}

function jsonPatchBinary(ops: JsonPatchOperation[]): Resource {
  return {
    resourceType: "Binary",
    contentType: "application/json-patch+json",
    data: btoa(JSON.stringify(ops)),
  } as Resource;
}

function formatOperationOutcome(outcome: OperationOutcome | undefined): string | undefined {
  return outcome?.issue
    ?.map((issue) => {
      const expression = issue.expression?.length
        ? ` [${issue.expression.join(", ")}]`
        : "";
      return `${issue.diagnostics ?? issue.details?.text ?? issue.code}${expression}`;
    })
    .join("; ");
}

function referenceOf(resourceType: string, idOrReference: string): string {
  return idOrReference.startsWith(`${resourceType}/`)
    ? idOrReference
    : `${resourceType}/${idOrReference}`;
}

function activeAppointmentEncounterCriteria(appointmentReference: string): string {
  return new URLSearchParams([
    ["appointment", appointmentReference],
    ["status:not", "cancelled"],
    ["status:not", "entered-in-error"],
  ]).toString();
}
