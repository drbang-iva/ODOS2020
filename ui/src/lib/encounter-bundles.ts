import type { Bundle, Encounter, OperationOutcome, Provenance, Resource } from "@medplum/fhirtypes";
import type { JsonPatchOperation } from "./fhir";

export const ENCOUNTER_COMPREHENSIVE_EXAM_PROFILE =
  "https://osod.dev/fhir/StructureDefinition/Encounter-ComprehensiveExam";

const V3_ACT_CODE_SYSTEM = "http://terminology.hl7.org/CodeSystem/v3-ActCode";
const V3_DATA_OPERATION_SYSTEM = "http://terminology.hl7.org/CodeSystem/v3-DataOperation";
const PROVENANCE_PARTICIPANT_TYPE_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/provenance-participant-type";
const FALLBACK_PRACTITIONER_REFERENCE = "Practitioner/osod-admin";

export function buildStartEncounterCreateBundle(input: {
  patientId: string;
  now: string;
  practitionerReference?: string;
  episodeReference?: string;
}): Bundle {
  const encounterFullUrl = `urn:uuid:encounter-${crypto.randomUUID()}`;
  const patientReference = input.patientId.startsWith("Patient/")
    ? input.patientId
    : `Patient/${input.patientId}`;

  const encounter: Encounter = {
    resourceType: "Encounter",
    status: "arrived",
    class: {
      system: V3_ACT_CODE_SYSTEM,
      code: "AMB",
    },
    subject: { reference: patientReference },
    ...(input.episodeReference ? { episodeOfCare: [{ reference: input.episodeReference }] } : {}),
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
        request: { method: "POST", url: "Encounter" },
      },
      {
        fullUrl: `urn:uuid:provenance-start-${crypto.randomUUID()}`,
        resource: buildProvenance({
          targetReference: encounterFullUrl,
          recorded: input.now,
          activityCode: "CREATE",
          activityDisplay: "Create",
          operatorDisplay: "OSOD UI start_encounter",
          practitionerReference: input.practitionerReference,
        }),
        request: { method: "POST", url: "Provenance" },
      },
    ],
  };
}

export function buildEncounterStatusPatchBundle(input: {
  encounterId: string;
  ops: JsonPatchOperation[];
  recorded: string;
  operatorDisplay: string;
  practitionerReference?: string;
}): Bundle {
  const encounterReference = input.encounterId.startsWith("Encounter/")
    ? input.encounterId
    : `Encounter/${input.encounterId}`;

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
  recorded: string;
  activityCode: "CREATE" | "UPDATE";
  activityDisplay: string;
  operatorDisplay: string;
  practitionerReference?: string;
}): Provenance {
  return {
    resourceType: "Provenance",
    target: [{ reference: input.targetReference }],
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
