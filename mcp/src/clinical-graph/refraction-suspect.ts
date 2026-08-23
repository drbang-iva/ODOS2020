import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EyeLaterality } from "../fhir/ophthalmology/types.js";
import { odosConcept } from "../fhir/ophthalmology/extensions.js";
import {
  buildClinicalFindingDefinition,
  buildDiagnosisDefinition,
  buildDiagnosisSuggestionEdge,
  type ClinicalFindingDefinition,
  type ClinicalFindingOption,
  type ClinicalGraphProvenance,
  type DiagnosisSuggestionEvaluation,
  type FindingInstance,
} from "./glaucoma-suspect.js";
import { buildDiagnosisCatalogSeeds } from "./diagnosis-catalog-seeds.js";
import { sphericalEquivalent } from "./refractive-status.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const REFRACTIVE_ERROR_LEDGER_PATH = resolve(
  REPO_ROOT,
  "data/code-bindings/refractive-error-phase0-ledger.json",
);

export const REFRACTION_TYPE_OPTIONS: ClinicalFindingOption[] = [
  { code: "RETINOSCOPY", display: "Retinoscopy", active: true },
  { code: "MANIFEST", display: "Manifest", active: true },
  { code: "CYCLOPLEGIC", display: "Cycloplegic", active: true },
  { code: "FINAL_RX", display: "Final/Rx", active: true },
  { code: "OVER_REFRACTION", display: "Over-Refraction", active: true },
  { code: "POST_ORTHO_K", display: "Post-Ortho-K", active: true },
  { code: "OTHER", display: "Other", active: true },
];

export interface RefractiveErrorDiagnosisCode {
  code: string;
  display: string;
  family: string;
  laterality: EyeLaterality;
  sourceRefs: string[];
}

export interface RefractiveErrorPhase0Ledger {
  accessDate?: string;
  diagnosisCodes: RefractiveErrorDiagnosisCode[];
}

export interface RefractiveErrorRiskConfig {
  refractiveThreshold?: number;
}

export interface RefractiveErrorSuggestionEngineInput {
  findings: readonly FindingInstance[];
  findingDefinitions: readonly ClinicalFindingDefinition[];
  provenance: ClinicalGraphProvenance;
  encounterReference?: string;
  ledger?: RefractiveErrorPhase0Ledger;
  riskConfig?: RefractiveErrorRiskConfig;
}

interface RefractionEvidence {
  blockId: string;
  refractionType: string;
  sphere?: number;
  cylinder?: number;
  axis?: number;
  add?: number;
}

type RefractiveDiagnosisKind = "hyperopia" | "myopia" | "astigmatism" | "anisometropia" | "presbyopia";

export function buildRefractionFindingDefinitionStub(
  provenance: ClinicalGraphProvenance,
): ClinicalFindingDefinition {
  return buildClinicalFindingDefinition({
    id: "finding-def-refraction",
    stableKey: "refraction",
    display: "Refraction",
    sectionKey: "refraction",
    anatomyTarget: "eye",
    valueSchema: {
      valueKind: "refraction-panel",
      operatorInputRequired: false,
      fields: {
        type: {
          display: "Refraction type",
          type: "single-select",
          editable: true,
          options: REFRACTION_TYPE_OPTIONS,
        },
        sphere: powerField("Sphere"),
        cylinder: powerField("Cylinder"),
        axis: {
          display: "Axis",
          type: "integer-select",
          minimum: 0,
          maximum: 180,
          step: 1,
          unit: "degrees",
        },
        add: powerField("Add"),
        prismAmount: {
          display: "Prism amount",
          type: "quarter-diopter-select",
          minimum: 0.25,
          maximum: 20,
          step: 0.25,
          unit: "PD",
        },
        prismBase: {
          display: "Prism base",
          type: "single-select",
          editable: true,
          options: [
            { code: "up", display: "Up", active: true },
            { code: "down", display: "Down", active: true },
            { code: "in", display: "In", active: true },
            { code: "out", display: "Out", active: true },
          ],
        },
        purpose: {
          display: "Purpose",
          type: "string",
        },
        distanceVisualAcuity: {
          display: "Distance VA",
          type: "visual-acuity-select",
        },
        nearVisualAcuity: {
          display: "Near VA",
          type: "visual-acuity-select",
        },
        distancePinholeVisualAcuity: {
          display: "Distance PH",
          type: "visual-acuity-select",
        },
        sourceType: {
          display: "Source type",
          type: "single-select",
          options: [
            { code: "manual", display: "Manual", active: true },
            { code: "device", display: "Device", active: true },
          ],
        },
      },
    },
    normalSemantics: {
      riskPredicate: {
        key: "manifest_refractive_error_v1",
        thresholdParameters: {
          refractiveThreshold: {
            key: "refractiveThreshold",
            defaultValue: 0.25,
            minimum: 0.25,
            maximum: 20,
            step: 0.25,
            unit: "D",
          },
        },
      },
    },
    sourceStatus: "verified-seed",
    fhirObservationCode: odosConcept("REFRACTION", "Refraction"),
    notBillReady: true,
    active: true,
    provenance: {
      ...provenance,
      note: [
        provenance.note,
        "Practice-editable refraction definition; diagnosis rules consume Manifest findings only.",
      ].filter(Boolean).join(" "),
    },
  });
}

export function addRefractionTypeOption(
  definition: ClinicalFindingDefinition,
  option: ClinicalFindingOption,
): ClinicalFindingDefinition {
  const valueSchema = { ...definition.valueSchema };
  const fields = { ...asRecord(valueSchema.fields) };
  const field = { ...asRecord(fields.type) };
  const options = fieldOptions(definition, "type");
  field.options = [...options.filter((candidate) => candidate.code !== option.code), option];
  fields.type = field;
  valueSchema.fields = fields;
  return { ...definition, valueSchema };
}

export function evaluateRefractiveErrorSuggestions(
  input: RefractiveErrorSuggestionEngineInput,
): DiagnosisSuggestionEvaluation[] {
  const definitionsById = new Map(input.findingDefinitions.map((definition) => [definition.id, definition]));
  const manifestFindings = input.findings
    .filter((finding) => !input.encounterReference || finding.encounterReference === input.encounterReference)
    .flatMap((finding) => {
      const definition = definitionsById.get(finding.findingDefinitionId);
      if (definition?.stableKey !== "refraction") return [];
      const evidence = readRefractionEvidence(finding);
      return evidence?.refractionType === "MANIFEST" ? [{ finding, definition, evidence }] : [];
    })
    .sort((a, b) => a.finding.recordedAt.localeCompare(b.finding.recordedAt) || a.finding.id.localeCompare(b.finding.id));

  const ledger = input.ledger ?? loadRefractiveErrorPhase0Ledger();
  const evaluations: DiagnosisSuggestionEvaluation[] = [];
  const byBlock = new Map<string, typeof manifestFindings>();

  for (const item of manifestFindings) {
    const threshold = resolveRefractiveErrorThreshold(item.definition, input.riskConfig);
    if (item.evidence.sphere !== undefined && item.evidence.sphere <= -threshold) {
      evaluations.push(buildEvaluation(input, item.finding, item.definition, "myopia", codeFor("myopia", item.finding.laterality), ledger,
        `Myopia suggestion because Manifest sphere ${formatDiopter(item.evidence.sphere)} is <= -${threshold.toFixed(2)} D.`));
    }
    if (item.evidence.sphere !== undefined && item.evidence.sphere >= threshold) {
      evaluations.push(buildEvaluation(input, item.finding, item.definition, "hyperopia", codeFor("hyperopia", item.finding.laterality), ledger,
        `Hypermetropia suggestion because Manifest sphere ${formatDiopter(item.evidence.sphere)} is >= +${threshold.toFixed(2)} D.`));
    }
    if (item.evidence.cylinder !== undefined && item.evidence.cylinder !== 0) {
      evaluations.push(buildEvaluation(input, item.finding, item.definition, "astigmatism", codeFor("astigmatism", item.finding.laterality), ledger,
        `Unspecified astigmatism suggestion because Manifest cylinder is ${formatDiopter(item.evidence.cylinder)}.`));
    }
    const block = byBlock.get(item.evidence.blockId) ?? [];
    block.push(item);
    byBlock.set(item.evidence.blockId, block);
  }

  for (const block of byBlock.values()) {
    const addFindings = block.filter((item) => item.evidence.add !== undefined && item.evidence.add !== 0);
    const addSource = addFindings[0];
    if (addSource) {
      evaluations.push(buildEvaluation(input, addSource.finding, addSource.definition, "presbyopia", "H52.4", ledger,
        "Presbyopia suggestion because a non-zero Add was captured in the Manifest block.",
        addFindings.map((item) => item.finding.id)));
    }

    const od = block.find((item) => item.finding.laterality === "OD");
    const os = block.find((item) => item.finding.laterality === "OS");
    if (!od || !os) continue;
    const odSe = sphericalEquivalent(od.evidence);
    const osSe = sphericalEquivalent(os.evidence);
    if (odSe === undefined || osSe === undefined) continue;
    const threshold = resolveRefractiveErrorThreshold(od.definition, input.riskConfig);
    const difference = Math.abs(odSe - osSe);
    if (difference > threshold) {
      evaluations.push(buildEvaluation(input, od.finding, od.definition, "anisometropia", "H52.31", ledger,
        `Anisometropia suggestion because Manifest spherical-equivalent difference ${difference.toFixed(2)} D is > ${threshold.toFixed(2)} D.`,
        [od.finding.id, os.finding.id]));
    }
  }

  return evaluations
    .sort((a, b) => a.suggestionEdge.id.localeCompare(b.suggestionEdge.id))
    .map((evaluation, index) => ({
      diagnosisDefinition: evaluation.diagnosisDefinition,
      suggestionEdge: { ...evaluation.suggestionEdge, rank: index + 1 },
    }));
}

export function resolveRefractiveErrorThreshold(
  definition: ClinicalFindingDefinition,
  riskConfig?: RefractiveErrorRiskConfig,
): number {
  if (riskConfig?.refractiveThreshold !== undefined) {
    return assertThreshold(riskConfig.refractiveThreshold, "refractiveThreshold");
  }
  const riskPredicate = asRecord(definition.normalSemantics?.riskPredicate);
  const thresholdParameters = asRecord(riskPredicate.thresholdParameters);
  const parameter = asRecord(thresholdParameters.refractiveThreshold);
  const value = readNumber(parameter.defaultValue);
  if (value === undefined) {
    throw new Error("Refraction risk parameter refractiveThreshold defaultValue is missing from the finding definition.");
  }
  return assertThreshold(value, "Refraction risk parameter refractiveThreshold default");
}

export function loadRefractiveErrorPhase0Ledger(): RefractiveErrorPhase0Ledger {
  cachedLedger ??= JSON.parse(readFileSync(REFRACTIVE_ERROR_LEDGER_PATH, "utf8")) as RefractiveErrorPhase0Ledger;
  return cachedLedger;
}

function buildEvaluation(
  input: RefractiveErrorSuggestionEngineInput,
  finding: FindingInstance,
  definition: ClinicalFindingDefinition,
  kind: RefractiveDiagnosisKind,
  code: string,
  ledger: RefractiveErrorPhase0Ledger,
  explanation: string,
  evidenceFindingInstanceIds = [finding.id],
): DiagnosisSuggestionEvaluation {
  const catalogRow = buildDiagnosisCatalogSeeds().find((candidate) => candidate.stableKey === kind);
  if (!catalogRow) throw new Error(`Refractive diagnosis catalog seed ${kind} is missing.`);
  const row = ledger.diagnosisCodes.find((candidate) => candidate.code === code);
  if (!row) {
    throw new Error(`Refractive-error ICD-10-CM code ${code} is missing from the Phase 0 ledger.`);
  }
  const diagnosisDefinition = buildDiagnosisDefinition({
    id: graphId("dx-def", kind, code),
    stableKey: `${kind}_${row.laterality.toLowerCase()}`,
    display: row.display,
    clinicalFamily: catalogRow.clinicalFamily,
    icd10Family: row.family,
    icd10Code: row.code,
    icd10Display: row.display,
    codingStatus: catalogRow.codingStatus,
    lateralityRequired: kind === "hyperopia" || kind === "myopia" || kind === "astigmatism",
    applicableFindingDefinitionIds: [definition.id],
    provenance: input.provenance,
  });
  const suggestionEdge = buildDiagnosisSuggestionEdge({
    id: graphId("suggestion", finding.id, kind, code),
    sourceFindingDefinitionId: definition.id,
    sourceFindingInstanceId: finding.id,
    targetDiagnosisDefinitionId: diagnosisDefinition.id,
    predicateKey: `manifest_refraction_${kind}_v1`,
    predicateExpression: {
      finding: "refraction",
      refractionType: "MANIFEST",
      diagnosisFamily: row.family,
      nonCommittal: true,
    },
    rank: 1,
    score: 0.65,
    confidence: 0.65,
    explanation,
    evidenceFindingInstanceIds,
    ruleVersion: "manifest-refraction-refractive-error-v1",
    visitState: "unreviewed",
    provenance: {
      ...input.provenance,
      source: "rule",
      sourceReferences: [
        ...evidenceFindingInstanceIds.flatMap((id) => {
          const evidence = input.findings.find((candidate) => candidate.id === id);
          return evidence?.observationReference ? [evidence.observationReference] : [];
        }),
        ...(input.provenance.sourceReferences ?? []),
      ],
      note: [
        input.provenance.note,
        "Pure Manifest-refraction evaluator: finding evidence in, suggestion edge out; no confirmed diagnosis side effects.",
      ].filter(Boolean).join(" "),
    },
  });
  return { diagnosisDefinition, suggestionEdge };
}

function readRefractionEvidence(finding: FindingInstance): RefractionEvidence | undefined {
  if (finding.value.type !== "json") return undefined;
  const value = finding.value.value;
  const blockId = typeof value.blockId === "string" ? value.blockId : undefined;
  const refractionType = typeof value.refractionType === "string" ? value.refractionType : undefined;
  if (!blockId || !refractionType) return undefined;
  return {
    blockId,
    refractionType,
    sphere: readNumber(value.sphere),
    cylinder: readNumber(value.cylinder),
    axis: readNumber(value.axis),
    add: readNumber(value.add),
  };
}

function codeFor(kind: "hyperopia" | "myopia" | "astigmatism", laterality: EyeLaterality): string {
  const eye = laterality === "OD" ? "OD" : laterality === "OS" ? "OS" : laterality === "OU" ? "OU" : "UNKNOWN";
  if (kind === "hyperopia") return { OD: "H52.01", OS: "H52.02", OU: "H52.03", UNKNOWN: "H52.00" }[eye];
  if (kind === "myopia") return { OD: "H52.11", OS: "H52.12", OU: "H52.13", UNKNOWN: "H52.10" }[eye];
  return { OD: "H52.201", OS: "H52.202", OU: "H52.203", UNKNOWN: "H52.209" }[eye];
}

function powerField(display: string): Record<string, unknown> {
  return {
    display,
    type: "quarter-diopter-select",
    minimum: -20,
    maximum: 20,
    step: 0.25,
    unit: "D",
  };
}

function fieldOptions(definition: ClinicalFindingDefinition, fieldKey: string): ClinicalFindingOption[] {
  const field = asRecord(asRecord(definition.valueSchema.fields)[fieldKey]);
  return Array.isArray(field.options)
    ? field.options.flatMap((option) => {
        const row = asRecord(option);
        return typeof row.code === "string" && typeof row.display === "string"
          ? [{ code: row.code, display: row.display, active: row.active !== false }]
          : [];
      })
    : [];
}

function assertThreshold(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > 20) {
    throw new Error(`${label} must be a finite refractive value greater than 0 and no more than 20 D.`);
  }
  return value;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatDiopter(value: number): string {
  if (value === 0) return "Plano";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)} D`;
}

function graphId(prefix: string, ...parts: string[]): string {
  return `${prefix}-${createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

let cachedLedger: RefractiveErrorPhase0Ledger | undefined;
