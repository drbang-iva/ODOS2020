import type {
  Bundle,
  ChargeItem,
  Condition,
  Coverage,
  Encounter,
  Resource,
} from "@medplum/fhirtypes";
import { isConfirmedEncounterDiagnosis, referenceId } from "../fhir/condition.js";
import { searchAll } from "../fhir-search.js";

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
  const diagnoses = confirmedConditions.map((condition): EncounterClaimDraftDiagnosis => {
    const coding = condition.code?.coding?.find((candidate) => candidate.system && candidate.code);
    if (!coding?.system || !coding.code) {
      throw new ClaimDraftAssemblyError(`Condition/${condition.id ?? "unknown"} has no coded diagnosis for claim assembly.`);
    }
    return {
      system: coding.system,
      code: coding.code,
      description: coding.display ?? condition.code?.text ?? "",
    };
  });
  const diagnosisIndex = new Map<string, number>(
    confirmedConditions.flatMap((condition, index) => condition.id ? [[`Condition/${condition.id}`, index + 1] as const] : []),
  );

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
      const sequence = diagnosisIndex.get(reference.reference ?? "");
      return sequence ? [{ sequence, condition: confirmedConditions[sequence - 1]! }] : [];
    });
    const diagnosisSequence = [...new Set(linkedConditions.map((entry) => entry.sequence))].sort((a, b) => a - b);
    if (diagnosisSequence.length === 0) {
      warnings.push(
        `ChargeItem/${chargeItem.id} was excluded because it has no linked confirmed encounter diagnosis.`,
      );
      return [];
    }
    const lateralities = [...new Set(linkedConditions
      .map((entry) => entry.condition.bodySite?.[0]?.text?.trim())
      .filter((value): value is string => Boolean(value)))];
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
      ...(lateralities.length === 1 ? { laterality: lateralities[0] } : {}),
    }];
  });

  const activeCoverages = coverages
    .filter((coverage) => coverage.status === "active")
    .sort((left, right) => (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER));
  const primaryCoverage = activeCoverages.find((coverage) => coverage.order === 1) ?? activeCoverages[0];
  if (!primaryCoverage) {
    throw new ClaimDraftAssemblyError("The patient has no active Coverage available for claim assembly.");
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

async function readClaimDraftResource<T extends Resource>(
  fhir: ClaimDraftFhirClient,
  resourceType: T["resourceType"],
  id: string,
): Promise<T> {
  try {
    return await fhir.read<T>(resourceType, id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/\b404\b|\bnot found\b/i.test(message)) {
      throw new ClaimDraftAssemblyError(
        `${resourceType}/${id} could not be loaded for claim assembly.`,
        { cause: error },
      );
    }
    throw error;
  }
}
