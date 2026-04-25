// MIRROR of osod/mcp/src/fhir/ophthalmology/types.ts. Source of truth lives in MCP. Sync manually until v0.5 monorepo refactor. Parity guarded by mcp/tests/builder-mirror-parity.test.ts.
import type {
  CodeableConcept,
  DiagnosticReport,
  DocumentReference,
  Extension,
  Observation,
  ObservationComponent,
  Provenance,
  Reference,
  Resource,
} from "@medplum/fhirtypes";

export type EyeLaterality = "OD" | "OS" | "OU" | "UNKNOWN";
export type VisualAcuityChartType = "SNELLEN" | "ETDRS" | "LOGMAR" | "JAEGER" | "OTHER" | "UNKNOWN";
export type VisualAcuityCorrection = "SC" | "CC" | "BCVA" | "PH" | "NI" | "OTHER" | "UNKNOWN";
export type IopMethod = "GAT" | "ICARE" | "TONOPEN" | "NCT" | "PERKINS" | "OTHER" | "UNKNOWN";
export type RefractionType = "AUTOREFRACTION" | "MANIFEST" | "CYCLOPLEGIC" | "FINAL_RX" | "OTHER";
export type SourceType = "manual" | "parser" | "device" | "vendor-export" | "unknown";

export interface BuildResult<T extends Resource> {
  resource: T;
  warnings: string[];
}

export interface CommonObservationInput {
  patientReference: string;
  encounterReference: string;
  eye: EyeLaterality;
  measuredAt: string;
  method?: CodeableConcept;
  deviceReference?: string;
  performerReferences?: string[];
  sourceReferences?: string[];
  qualityScore?: number;
  confidenceScore?: number;
  interpretation?: CodeableConcept[];
  referenceRange?: Observation["referenceRange"];
  sourceLabel?: string;
  sourceType?: SourceType;
}

export interface VisualAcuityInput extends Omit<CommonObservationInput, "method"> {
  snellen: string;
  logmar?: number;
  letterScore?: number;
  chartType: VisualAcuityChartType;
  correction: VisualAcuityCorrection;
  distance?: number;
  distanceUnit?: "ft" | "m";
  method?: string;
  allowUnparseable?: boolean;
}

export interface IopInput extends CommonObservationInput {
  value: number;
  unit?: "mm[Hg]";
}

export interface RefractionInput extends CommonObservationInput {
  refractionType: RefractionType;
  sphere?: number;
  cylinder?: number;
  axis?: number;
  add?: number;
  prism?: {
    amount?: number;
    base?: string;
    raw?: string;
  };
  visualAcuityWithCorrectionReference?: string;
}

export interface RawAssetInput {
  patientReference: string;
  encounterReference?: string;
  contentType: string;
  title?: string;
  originalFilename?: string;
  creation?: string;
  size?: number;
  sha1Base64?: string;
  sha256?: string;
  url?: string;
  data?: string;
  typeCode?: string;
  categoryCode?: string;
  authorReferences?: string[];
  custodianReference?: string;
  description?: string;
}

export interface DiagnosticReportInput {
  code: string;
  display: string;
  patientReference: string;
  encounterReference?: string;
  effectiveDateTime: string;
  resultReferences: string[];
  performerReferences?: string[];
  imagingStudyReferences?: string[];
  mediaReferences?: string[];
  presentedForms?: DiagnosticReport["presentedForm"];
  conclusion?: string;
  conclusionCode?: CodeableConcept[];
}

export interface ProvenanceInput {
  targetReferences: string[];
  occurredDateTime?: string;
  recorded?: string;
  activityCode?: string;
  activityDisplay?: string;
  agents: ProvenanceAgentInput[];
  entityReferences?: string[];
}

export interface ProvenanceAgentInput {
  typeCode?: string;
  typeDisplay?: string;
  roleCode?: string;
  roleDisplay?: string;
  whoReference?: string;
  whoDisplay?: string;
}

export type {
  CodeableConcept,
  DiagnosticReport,
  DocumentReference,
  Extension,
  Observation,
  ObservationComponent,
  Provenance,
  Reference,
  Resource,
};
