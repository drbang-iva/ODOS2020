import type {
  Bundle,
  ChargeItem,
  Condition,
  Coverage,
  Encounter,
  Resource,
} from "@medplum/fhirtypes";
import { isConfirmedEncounterDiagnosis, referenceId } from "../fhir/condition.js";
import { chargeItemLaterality } from "../fhir/charge-item-laterality.js";
import { searchAll } from "../fhir-search.js";
import { buildDiagnosisCatalogSeeds } from "../clinical-graph/diagnosis-catalog-seeds.js";
import { resolveConditionCodes } from "../clinical-graph/diagnosis-code-resolution.js";
import { ICD10_CM_CODE_SYSTEM, type DiagnosisCatalogRow } from "../clinical-graph/glaucoma-suspect.js";
import {
  DIAGNOSIS_CATALOG_CODE_SYSTEM,
  DIAGNOSIS_KEY_IDENTIFIER_SYSTEM,
} from "../clinical-graph/diagnosis-pick-endpoint.js";

export interface ClaimDraftFhirClient {
  read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T>;
  search<T extends Resource>(
    resourceType: T["resourceType"],
    params?: Record<string, string>,
  ): Promise<Bundle<T>>;
  searchUrl?<T extends Resource>(
    url: string,
    resourceType: T["resourceType"],
  ): Promise<Bundle<T>>;
}

export interface EncounterClaimDraftDiagnosis {
  system: string;
  code: string;
  description: string;
}

export interface EncounterClaimDraftCharge {
  id: string;
  codeType: "CPT" | "HCPCS";
  codeSystem: string;
  code: string;
  description: string;
  feeDollars: string;
  quantity: string;
  diagnosisSequence: number[];
  laterality?: string;
}

export interface EncounterClaimDraft {
  encounterReference: string;
  patientReference: string;
  serviceDate: string;
  diagnoses: EncounterClaimDraftDiagnosis[];
  charges: EncounterClaimDraftCharge[];
  coverageReference?: string;
  insurerReference?: string;
  payerId?: string;
  warnings?: string[];
}

export class ClaimDraftAssemblyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ClaimDraftAssemblyError";
  }
}

export async function buildClaimDraft(
  fhir: ClaimDraftFhirClient,
  encounterId: string,
  diagnosisCatalog: readonly DiagnosisCatalogRow[] = buildDiagnosisCatalogSeeds(),
): Promise<EncounterClaimDraft> {
  if (!/^[A-Za-z0-9.-]{1,64}$/.test(encounterId)) {
    throw new ClaimDraftAssemblyError("A valid encounter id is required.");
  }
  const encounterReference = `Encounter/${encounterId}`;
  const encounter = await readClaimDraftResource<Encounter>(fhir, "Encounter", encounterId);
  if (encounter.status !== "finished") {
    throw new ClaimDraftAssemblyError("The encounter must be signed before a claim draft can be assembled.");
  }
  const patientReference = encounter.subject?.reference;
  if (!/^Patient\/[A-Za-z0-9.-]{1,64}$/.test(patientReference ?? "")) {
    throw new ClaimDraftAssemblyError("The encounter does not reference a valid Patient.");
  }

  const diagnosisEntries = [...(encounter.diagnosis ?? [])];
  if (diagnosisEntries.some((entry) => !Number.isInteger(entry.rank) || (entry.rank ?? 0) < 1)) {
    throw new ClaimDraftAssemblyError("Every encounter diagnosis must have a positive integer rank.");
  }
  if (new Set(diagnosisEntries.map((entry) => entry.rank)).size !== diagnosisEntries.length) {
    throw new ClaimDraftAssemblyError("The encounter has duplicate diagnosis ranks and cannot produce a claim draft.");
  }
  const normalizedDiagnosisEntries = diagnosisEntries.map((entry) => {
    const reference = entry.condition.reference;
    if (!reference) throw new ClaimDraftAssemblyError("An encounter diagnosis is missing its Condition reference.");
    const id = referenceId(reference, "Condition");
    if (!id) throw new ClaimDraftAssemblyError(`Encounter diagnosis reference ${reference} is invalid.`);
    return { entry, conditionId: id, conditionKey: `Condition/${id}` };
  });
  if (new Set(normalizedDiagnosisEntries.map(({ conditionKey }) => conditionKey)).size !== normalizedDiagnosisEntries.length) {
    throw new ClaimDraftAssemblyError("The encounter has duplicate diagnosis Condition references and cannot produce a claim draft.");
  }
  normalizedDiagnosisEntries.sort((left, right) => left.entry.rank! - right.entry.rank!);
  const resolvedConditions = await Promise.all(normalizedDiagnosisEntries.map(({ conditionId }) =>
    readClaimDraftResource<Condition>(fhir, "Condition", conditionId)
  ));
  const confirmedConditions = resolvedConditions.filter((condition) =>
    isConfirmedEncounterDiagnosis(condition) && condition.encounter?.reference === encounterReference
  );
  const diagnosisRows = confirmedConditions.flatMap((condition) =>
    claimDiagnosesForCondition(condition, diagnosisCatalog).map((diagnosis) => ({ condition, diagnosis }))
  );
  const diagnoses = diagnosisRows.map((row) => row.diagnosis);
  const diagnosisIndex = new Map<string, number[]>();
  diagnosisRows.forEach(({ condition }, index) => {
    if (!condition.id) return;
    const key = `Condition/${condition.id}`;
    diagnosisIndex.set(key, [...(diagnosisIndex.get(key) ?? []), index + 1]);
  });

  const [chargeItems, coverages] = await Promise.all([
    searchAll<ChargeItem>(fhir, "ChargeItem", {
      context: encounterReference,
      _count: "100",
    }),
    searchAll<Coverage>(fhir, "Coverage", {
      beneficiary: patientReference!,
      _count: "100",
    }),
  ]);
  const warnings: string[] = [];
  const charges = chargeItems.filter((chargeItem) => chargeItem.status === "billable").flatMap((chargeItem): EncounterClaimDraftCharge[] => {
    if (!chargeItem.id) throw new ClaimDraftAssemblyError("A billable ChargeItem is missing its persisted id.");
    const coding = chargeItem.code.coding?.find((candidate) => candidate.system && candidate.code);
    if (!coding?.system || !coding.code) {
      throw new ClaimDraftAssemblyError(`ChargeItem/${chargeItem.id} has no procedure coding.`);
    }
    const linkedConditions = (chargeItem.supportingInformation ?? []).flatMap((reference) => {
      const sequences = diagnosisIndex.get(reference.reference ?? "") ?? [];
      const condition = confirmedConditions.find((candidate) => candidate.id && `Condition/${candidate.id}` === reference.reference);
      return condition ? sequences : [];
    });
    const diagnosisSequence = [...new Set(linkedConditions)].sort((a, b) => a - b);
    if (diagnosisSequence.length === 0) {
      warnings.push(
        `ChargeItem/${chargeItem.id} was excluded because it has no linked confirmed encounter diagnosis.`,
      );
      return [];
    }
    const chargeLaterality = chargeItemLaterality(chargeItem);
    if (chargeLaterality.conflict) {
      warnings.push(
        `ChargeItem/${chargeItem.id} omitted laterality because bodysite contains conflicting laterality values.`,
      );
    }
    return [{
      id: chargeItem.id,
      codeType: coding.system.toLowerCase().includes("hcpcs") ? "HCPCS" : "CPT",
      codeSystem: coding.system,
      code: coding.code,
      description: coding.display ?? chargeItem.code.text ?? "",
      feeDollars: chargeItem.priceOverride?.value === undefined
        ? ""
        : chargeItem.priceOverride.value.toFixed(2),
      quantity: String(chargeItem.quantity?.value ?? 1),
      diagnosisSequence,
      ...(chargeLaterality.laterality ? { laterality: chargeLaterality.laterality } : {}),
    }];
  });

  const activeCoverages = coverages.filter((coverage) => coverage.status === "active");
  const intendedCoverageReferences = new Set(
    (encounter.extension ?? [])
      .filter((extension) =>
        extension.url === "https://odos2020.com/fhir/StructureDefinition/intended-coverage"
      )
      .flatMap((extension) => extension.valueReference?.reference
        ? [extension.valueReference.reference]
        : []),
  );
  const activeIntendedCoverages = activeCoverages.filter((coverage) =>
    coverage.id && intendedCoverageReferences.has(`Coverage/${coverage.id}`)
  );
  let primaryCoverage = activeIntendedCoverages.length === 1
    ? activeIntendedCoverages[0]
    : activeIntendedCoverages.find((coverage) => coverage.order === 1);
  primaryCoverage ??= activeCoverages.find((coverage) => coverage.order === 1);
  if (!primaryCoverage && activeCoverages.length === 1 && coverages.length === 1) {
    primaryCoverage = activeCoverages[0];
  }
  if (activeCoverages.length === 0) {
    throw new ClaimDraftAssemblyError("The patient has no active Coverage available for claim assembly.");
  }
  if (!primaryCoverage) {
    throw new ClaimDraftAssemblyError(
      activeCoverages.length > 1
        ? "The patient has multiple active Coverages but none recorded as primary (order 1); set the primary Coverage before assembling a claim."
        : "The patient has another Coverage record and the only active Coverage is not recorded as primary (order 1); update the Coverage priority before assembling a claim.",
    );
  }
  return {
    encounterReference,
    patientReference: patientReference!,
    serviceDate: encounter.period?.start?.slice(0, 10) ?? "",
    diagnoses,
    charges,
    ...(primaryCoverage?.id ? { coverageReference: `Coverage/${primaryCoverage.id}` } : {}),
    ...(primaryCoverage?.payor[0]?.reference ? { insurerReference: primaryCoverage.payor[0].reference } : {}),
    ...(primaryCoverage?.payor[0]?.identifier?.value ? { payerId: primaryCoverage.payor[0].identifier.value } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

function claimDiagnosesForCondition(
  condition: Condition,
  diagnosisCatalog: readonly DiagnosisCatalogRow[],
): EncounterClaimDraftDiagnosis[] {
  const stableKey = conditionCatalogStableKey(condition);
  const catalogRow = stableKey ? diagnosisCatalog.find((row) => row.stableKey === stableKey) : undefined;
  const usesCatalogConcept = condition.code?.coding?.some((coding) =>
    coding.system === DIAGNOSIS_CATALOG_CODE_SYSTEM && coding.code === stableKey
  );
  if (usesCatalogConcept && !catalogRow) {
    throw new ClaimDraftAssemblyError(`Condition/${condition.id ?? "unknown"} references an unknown diagnosis catalog concept.`);
  }
  if (catalogRow && usesCatalogConcept) {
    const codes = resolveConditionCodes(catalogRow, conditionLaterality(condition));
    if (codes.length === 0) {
      throw new ClaimDraftAssemblyError(`Condition/${condition.id ?? "unknown"} has no coded diagnosis for claim assembly.`);
    }
    return codes.map((code) => ({
      system: ICD10_CM_CODE_SYSTEM,
      code,
      description: condition.code?.text ?? catalogRow.display,
    }));
  }
  const coding = condition.code?.coding?.find((candidate) => candidate.system && candidate.code);
  if (!coding?.system || !coding.code) {
    throw new ClaimDraftAssemblyError(`Condition/${condition.id ?? "unknown"} has no coded diagnosis for claim assembly.`);
  }
  return [{
    system: coding.system,
    code: coding.code,
    description: coding.display ?? condition.code?.text ?? "",
  }];
}

function conditionCatalogStableKey(condition: Condition): string | undefined {
  const identifierValue = condition.identifier?.find((identifier) =>
    identifier.system === DIAGNOSIS_KEY_IDENTIFIER_SYSTEM
  )?.value;
  if (identifierValue) {
    const parts = identifierValue.split("::");
    if (parts.length >= 2) return parts.at(-2);
  }
  return condition.code?.coding?.find((coding) => coding.system === DIAGNOSIS_CATALOG_CODE_SYSTEM)?.code;
}

function conditionLaterality(condition: Condition): "right" | "left" | "bilateral" | undefined {
  const value = condition.bodySite?.[0]?.text ?? condition.identifier?.find((identifier) =>
    identifier.system === DIAGNOSIS_KEY_IDENTIFIER_SYSTEM
  )?.value?.split("::").at(-1);
  if (value === "OD" || value === "right") return "right";
  if (value === "OS" || value === "left") return "left";
  if (value === "OU" || value === "bilateral") return "bilateral";
  return undefined;
}

async function readClaimDraftResource<T extends Resource>(
  fhir: ClaimDraftFhirClient,
  resourceType: T["resourceType"],
  id: string,
): Promise<T> {
  try {
    return await fhir.read<T>(resourceType, id);
  } catch (error) {
    if (errorStatus(error) === 404) {
      throw new ClaimDraftAssemblyError(
        `${resourceType}/${id} could not be loaded for claim assembly.`,
        { cause: error },
      );
    }
    throw error;
  }
}

function errorStatus(error: unknown): number | undefined {
  if (!(error instanceof Error) || !("status" in error)) return undefined;
  const status = (error as Error & { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}
