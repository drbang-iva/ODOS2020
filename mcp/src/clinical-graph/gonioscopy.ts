import type { Observation } from "@medplum/fhirtypes";
import type { ClinicalFindingDefinition, ClinicalGraphProvenance } from "./glaucoma-suspect.js";
import type { ProtocolFindingInstance } from "./protocol-types.js";

export const GONIO_EYES = ["OD", "OS"] as const;
export const GONIO_QUADRANTS = ["superior", "nasal", "inferior", "temporal"] as const;
export const GONIO_STRUCTURES = ["closed", "sl", "atm", "ptm", "ss", "cb"] as const;
export const GONIO_PIGMENTATION = ["0", "1+", "2+", "3+", "4+"] as const;
export type GonioEye = typeof GONIO_EYES[number];
export type GonioQuadrant = typeof GONIO_QUADRANTS[number];
export type GonioStructure = typeof GONIO_STRUCTURES[number];
export type GonioEntryMode = "propagated-uniform" | "quadrant-specific";

const ODOS = "https://odos2020.com/fhir";
const ENTRY_MODE_URL = `${ODOS}/StructureDefinition/gonio-entry-mode`;
const SOURCE_URL = `${ODOS}/StructureDefinition/finding-source`;

export interface GonioQuadrantRecord {
  eye: GonioEye;
  quadrant: GonioQuadrant;
  value: GonioStructure;
  entryMode: GonioEntryMode;
  source: "protocol-default" | "clinician-entered";
  observationReference?: string;
}

export function buildGonioscopyFindingDefinitions(
  provenance: ClinicalGraphProvenance,
): ClinicalFindingDefinition[] {
  return [
    definition("gonio_angle_structures", "Gonioscopy angle structures", {
      valueKind: "coded",
      components: [...GONIO_QUADRANTS],
      options: GONIO_STRUCTURES.map((code) => ({ code, display: gonioStructureDisplay(code) })),
    }, provenance),
    definition("gonio_tm_pigmentation", "Gonioscopy TM pigmentation", {
      valueKind: "coded",
      options: GONIO_PIGMENTATION.map((code) => ({ code, display: code })),
    }, provenance),
    definition("gonio_note", "Gonioscopy note", { valueKind: "string" }, provenance),
  ];
}

export function protocolFindingToGonioObservation(finding: ProtocolFindingInstance): Observation {
  if (finding.findingDefKey !== "gonio_angle_structures" || !isEye(finding.laterality) ||
    !isQuadrant(finding.componentKey) || !isStructure(finding.value)) {
    throw new Error("Protocol gonioscopy finding requires a valid eye, quadrant, and structure.");
  }
  return buildGonioQuadrantObservation({
    encounterReference: `Encounter/${finding.encounterId}`,
    patientReference: `Patient/${finding.patientId}`,
    actorReference: finding.provenance.actor,
    recordedAt: finding.provenance.at,
    record: {
      eye: finding.laterality,
      quadrant: finding.componentKey,
      value: finding.value,
      entryMode: finding.provenance.entryMode ?? "propagated-uniform",
      source: finding.provenance.source,
    },
  });
}

export function buildGonioQuadrantObservation(input: {
  encounterReference: string;
  patientReference: string;
  actorReference: string;
  recordedAt: string;
  record: GonioQuadrantRecord;
}): Observation {
  return {
    resourceType: "Observation",
    status: "final",
    code: { coding: [{ system: `${ODOS}/CodeSystem/odos`, code: "gonio_angle_structures" }] },
    subject: { reference: input.patientReference },
    encounter: { reference: input.encounterReference },
    effectiveDateTime: input.recordedAt,
    issued: input.recordedAt,
    performer: [{ reference: input.actorReference }],
    bodySite: { coding: [{ system: `${ODOS}/CodeSystem/laterality`, code: input.record.eye }] },
    valueCodeableConcept: {
      coding: [{ system: `${ODOS}/CodeSystem/gonio-angle-structure`, code: input.record.value }],
      text: gonioStructureDisplay(input.record.value),
    },
    component: [{
      code: { coding: [{ system: `${ODOS}/CodeSystem/gonio-quadrant`, code: input.record.quadrant }] },
      valueCodeableConcept: {
        coding: [{ system: `${ODOS}/CodeSystem/gonio-angle-structure`, code: input.record.value }],
      },
    }],
    extension: [
      { url: ENTRY_MODE_URL, valueCode: input.record.entryMode },
      { url: SOURCE_URL, valueCode: input.record.source },
    ],
  };
}

export function parseGonioQuadrantObservation(observation: Observation): GonioQuadrantRecord | undefined {
  if (observation.code?.coding?.[0]?.code !== "gonio_angle_structures") return undefined;
  const eye = observation.bodySite?.coding?.[0]?.code;
  const quadrant = observation.component?.[0]?.code?.coding?.[0]?.code;
  const value = observation.valueCodeableConcept?.coding?.[0]?.code ??
    observation.component?.[0]?.valueCodeableConcept?.coding?.[0]?.code;
  if (!isEye(eye) || !isQuadrant(quadrant) || !isStructure(value)) return undefined;
  const entryMode = observation.extension?.find((row) => row.url === ENTRY_MODE_URL)?.valueCode;
  const source = observation.extension?.find((row) => row.url === SOURCE_URL)?.valueCode;
  return {
    eye,
    quadrant,
    value,
    entryMode: entryMode === "quadrant-specific" ? entryMode : "propagated-uniform",
    source: source === "protocol-default" ? source : "clinician-entered",
    ...(observation.id ? { observationReference: `Observation/${observation.id}` } : {}),
  };
}

export function gonioStructureDisplay(value: GonioStructure): string {
  return ({ closed: "Closed", sl: "SL", atm: "ATM", ptm: "PTM", ss: "SS", cb: "CB" } as const)[value];
}

function definition(
  stableKey: string,
  display: string,
  valueSchema: Record<string, unknown>,
  provenance: ClinicalGraphProvenance,
): ClinicalFindingDefinition {
  return {
    id: `finding-def-${stableKey.replaceAll("_", "-")}`,
    stableKey,
    display,
    sectionKey: "gonioscopy",
    anatomyTarget: "eye",
    valueSchema,
    normalSemantics: {},
    sourceStatus: "local-practice",
    notBillReady: true,
    active: true,
    provenance,
  };
}

function isEye(value: unknown): value is GonioEye {
  return value === "OD" || value === "OS";
}
function isQuadrant(value: unknown): value is GonioQuadrant {
  return GONIO_QUADRANTS.includes(value as GonioQuadrant);
}
function isStructure(value: unknown): value is GonioStructure {
  return GONIO_STRUCTURES.includes(value as GonioStructure);
}
