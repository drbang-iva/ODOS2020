import type {
  Bundle,
  ChargeItem,
  ChargeItemDefinition,
  Encounter,
  Resource,
} from "@medplum/fhirtypes";
import { searchAll } from "../fhir-search.js";
import { chargeItemBodysite } from "../fhir/charge-item-laterality.js";
import type { ChargeProposal, ProtocolApplication } from "./protocol-types.js";

const BASE = "https://odos2020.com/fhir";
const PRACTICE_ID = "odos-practice";
export const PROCEDURE_CONCEPT_SYSTEM = `${BASE}/CodeSystem/procedure-concept`;
export const HCPCS_CODE_SYSTEM = "https://bluebutton.cms.gov/resources/codesystem/hcpcs";
const CPT_CODE_SYSTEM = "urn:ama:cpt";
const FEE_DEFINITION_IDENTIFIER_SYSTEM = `${BASE}/NamingSystem/procedure-fee-definition`;
const CHARGE_PROPOSAL_IDENTIFIER_SYSTEM = `${BASE}/NamingSystem/charge-proposal-charge-item`;
const ACT_CODE_SYSTEM = "http://terminology.hl7.org/CodeSystem/v3-ActCode";
const FEE_CATEGORY_EXTENSION_URL = `${BASE}/StructureDefinition/odos-procedure-fee-category`;
const FEE_MODIFIER_EXTENSION_URL = `${BASE}/StructureDefinition/odos-procedure-fee-modifier`;

export const ODOS_UNPRICED_CHARGE_EXTENSION_URL =
  `${BASE}/StructureDefinition/odos-unpriced-charge`;

export const PROCEDURE_FEE_CATEGORIES = ["exam", "refraction", "cl-fitting", "procedure"] as const;
export type ProcedureFeeCategory = (typeof PROCEDURE_FEE_CATEGORIES)[number];

interface ProcedureFeeSeed {
  procedureConceptKey: string;
  display: string;
  category: ProcedureFeeCategory;
  billingCode?: string;
}

export const PROCEDURE_FEE_SEEDS: readonly ProcedureFeeSeed[] = [
  { procedureConceptKey: "gonioscopy", display: "Gonioscopy", category: "procedure" },
  { procedureConceptKey: "corneal-pachymetry", display: "Corneal pachymetry", category: "procedure" },
  { procedureConceptKey: "scodi-optic-nerve", display: "SCODI optic nerve", category: "procedure" },
  { procedureConceptKey: "visual-field-threshold", display: "Threshold visual field", category: "procedure" },
  { procedureConceptKey: "fundus-photography", display: "Fundus photography", category: "procedure" },
  { procedureConceptKey: "comprehensive-exam-new", display: "Comprehensive eye exam — new patient", category: "exam" },
  { procedureConceptKey: "comprehensive-exam-established", display: "Comprehensive eye exam — established patient", category: "exam" },
  { procedureConceptKey: "intermediate-exam-new", display: "Intermediate eye exam — new patient", category: "exam" },
  { procedureConceptKey: "intermediate-exam-established", display: "Intermediate eye exam — established patient", category: "exam" },
  { procedureConceptKey: "office-visit-new-straightforward", display: "Office visit — new, straightforward", category: "exam" },
  { procedureConceptKey: "office-visit-new-low", display: "Office visit — new, low complexity", category: "exam" },
  { procedureConceptKey: "office-visit-new-moderate", display: "Office visit — new, moderate complexity", category: "exam" },
  { procedureConceptKey: "office-visit-established-straightforward", display: "Office visit — established, straightforward", category: "exam" },
  { procedureConceptKey: "office-visit-established-low", display: "Office visit — established, low complexity", category: "exam" },
  { procedureConceptKey: "office-visit-established-moderate", display: "Office visit — established, moderate complexity", category: "exam" },
  { procedureConceptKey: "routine-vision-exam-new", display: "Routine vision exam — new patient", category: "exam", billingCode: "S0620" },
  { procedureConceptKey: "routine-vision-exam-established", display: "Routine vision exam — established", category: "exam", billingCode: "S0621" },
  { procedureConceptKey: "refraction", display: "Refraction", category: "refraction" },
];

export const VISIT_PROCEDURE_CONCEPT_KEYS = [
  "comprehensive-exam-new",
  "comprehensive-exam-established",
  "intermediate-exam-new",
  "intermediate-exam-established",
  "office-visit-new-straightforward",
  "office-visit-new-low",
  "office-visit-new-moderate",
  "office-visit-established-straightforward",
  "office-visit-established-low",
  "office-visit-established-moderate",
  "routine-vision-exam-new",
  "routine-vision-exam-established",
] as const;

const VISIT_PROCEDURE_CONCEPT_KEY_SET = new Set<string>(VISIT_PROCEDURE_CONCEPT_KEYS);

const INITIAL_DEFINITION_KEYS = new Set([
  "gonioscopy",
  "corneal-pachymetry",
  "scodi-optic-nerve",
  "visual-field-threshold",
  "fundus-photography",
]);

export interface ProcedureFeeScheduleFhir {
  read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T>;
  search<T extends Resource>(resourceType: T["resourceType"], params?: Record<string, string>): Promise<Bundle<T>>;
  searchUrl?<T extends Resource>(url: string, resourceType: T["resourceType"]): Promise<Bundle<T>>;
  create<T extends Resource>(resource: T, headers?: Record<string, string>): Promise<T>;
  createWithOutcome?<T extends Resource>(
    resource: T,
    headers?: Record<string, string>,
  ): Promise<{ resource: T; created: boolean }>;
  update<T extends Resource>(
    resourceType: T["resourceType"],
    id: string,
    resource: T,
    headers?: Record<string, string>,
  ): Promise<T>;
}

export interface ProcedureChargeFhir {
  read(resourceType: "Encounter", id: string): Promise<Encounter>;
  create(resource: ChargeItem, headers?: Record<string, string>): Promise<ChargeItem>;
}

export interface ProcedureFeeScheduleItem {
  id: string;
  procedureConceptKey: string;
  display: string;
  active: boolean;
  billingCode?: string;
  category?: ProcedureFeeCategory;
  modifier?: string;
  priceCents?: number;
  version: string;
}

export type CodedProcedureFeeScheduleItem = ProcedureFeeScheduleItem & {
  billingCode: string;
};

type RowStore<T extends { id: string }> = {
  list(): Promise<T[]>;
  save(value: T): Promise<T>;
};

export async function ensureProcedureFeeSchedule(
  fhir: ProcedureFeeScheduleFhir,
  additionalConceptKeys: readonly string[] = [],
): Promise<ChargeItemDefinition[]> {
  const existing = await listProcedureFeeDefinitions(fhir);
  const byKey = new Map<string, ChargeItemDefinition>();
  for (const definition of existing) {
    const key = procedureConceptKey(definition);
    if (!key) continue;
    if (byKey.has(key)) throw new Error(`Duplicate procedure fee definitions found for ${key}.`);
    byKey.set(key, definition);
  }
  const seedByKey = new Map(PROCEDURE_FEE_SEEDS.map((seed) => [seed.procedureConceptKey, seed]));
  const concepts = new Map<string, ProcedureFeeSeed>(PROCEDURE_FEE_SEEDS
    .filter((seed) => INITIAL_DEFINITION_KEYS.has(seed.procedureConceptKey))
    .map((seed) => [seed.procedureConceptKey, seed]));
  for (const key of additionalConceptKeys) {
    if (key.trim() && !concepts.has(key)) {
      concepts.set(key, seedByKey.get(key) ?? {
        procedureConceptKey: key,
        display: displayFromKey(key),
        category: "procedure",
      });
    }
  }
  for (const [key, seed] of concepts) {
    if (byKey.has(key)) continue;
    const created = await fhir.create(
      buildProcedureFeeDefinition({
        procedureConceptKey: key,
        display: seed.display,
        category: seed.category,
        billingCode: seed.billingCode,
      }),
      {
        "X-ODOS-Source": "procedure-fee-schedule",
        "If-None-Exist": `identifier=${FEE_DEFINITION_IDENTIFIER_SYSTEM}|${key}`,
      },
    );
    byKey.set(key, created);
  }
  return [...byKey.values()];
}

export async function listProcedureFeeSchedule(
  fhir: ProcedureFeeScheduleFhir,
): Promise<ProcedureFeeScheduleItem[]> {
  const definitions = await ensureProcedureFeeSchedule(fhir);
  const persisted = definitions.map(procedureFeeScheduleItem);
  const persistedKeys = new Set(persisted.map((item) => item.procedureConceptKey));
  const virtualSeeds = PROCEDURE_FEE_SEEDS
    .filter((seed) => !persistedKeys.has(seed.procedureConceptKey))
    .map((seed): ProcedureFeeScheduleItem => ({
      id: seed.procedureConceptKey,
      procedureConceptKey: seed.procedureConceptKey,
      display: seed.display,
      active: true,
      category: seed.category,
      ...(seed.billingCode ? { billingCode: seed.billingCode } : {}),
      version: "1",
    }));
  return [...persisted, ...virtualSeeds]
    .sort((left, right) => left.display.localeCompare(right.display));
}

export async function listActiveVisitProcedureFees(
  fhir: Pick<ProcedureFeeScheduleFhir, "search" | "searchUrl">,
): Promise<ProcedureFeeScheduleItem[]> {
  const definitions = await listProcedureFeeDefinitions(fhir);
  const byKey = new Map<string, ChargeItemDefinition>();
  for (const definition of definitions) {
    const key = procedureConceptKey(definition);
    if (!key || !VISIT_PROCEDURE_CONCEPT_KEY_SET.has(key)) continue;
    if (byKey.has(key)) throw new Error(`Duplicate procedure fee definitions found for ${key}.`);
    byKey.set(key, definition);
  }
  return VISIT_PROCEDURE_CONCEPT_KEYS.flatMap((key) => {
    const definition = byKey.get(key);
    if (definition) {
      const item = procedureFeeScheduleItem(definition);
      return item.active ? [item] : [];
    }
    const seed = PROCEDURE_FEE_SEEDS.find((row) => row.procedureConceptKey === key)!;
    return [{
      id: key,
      procedureConceptKey: key,
      display: seed.display,
      active: true,
      category: seed.category,
      ...(seed.billingCode ? { billingCode: seed.billingCode } : {}),
      version: "1",
    }];
  });
}

export async function listActiveCodedNonVisitProcedureFees(
  fhir: Pick<ProcedureFeeScheduleFhir, "search" | "searchUrl">,
): Promise<CodedProcedureFeeScheduleItem[]> {
  return (await listProcedureFeeDefinitions(fhir))
    .map(procedureFeeScheduleItem)
    .filter((item): item is CodedProcedureFeeScheduleItem =>
      item.active &&
      typeof item.billingCode === "string" && item.billingCode.trim().length > 0 &&
      !isVisitProcedureConceptKey(item.procedureConceptKey)
    )
    .sort((left, right) => left.display.localeCompare(right.display));
}

export function isVisitProcedureConceptKey(value: string): boolean {
  return VISIT_PROCEDURE_CONCEPT_KEY_SET.has(value);
}

export class ProcedureFeeConceptConflictError extends Error {
  constructor(key: string) {
    super(`A procedure fee concept with key "${key}" already exists.`);
    this.name = "ProcedureFeeConceptConflictError";
  }
}

export async function createProcedureFeeScheduleItem(
  fhir: ProcedureFeeScheduleFhir,
  input: {
    display: string;
    category?: ProcedureFeeCategory;
    billingCode?: string | null;
    modifier?: string | null;
    priceCents?: number | null;
    active: boolean;
  },
): Promise<ProcedureFeeScheduleItem> {
  assertCents(input.priceCents);
  const display = normalizeDisplay(input.display);
  const generatedKey = procedureConceptKeyFromDisplay(display);
  const definitions = await listProcedureFeeDefinitions(fhir);
  const occupiedKeys = new Set([
    ...PROCEDURE_FEE_SEEDS.map((seed) => seed.procedureConceptKey),
    ...definitions.flatMap((definition) => {
      const key = procedureConceptKey(definition);
      return key ? [key] : [];
    }),
  ]);
  if (occupiedKeys.has(generatedKey)) {
    throw new ProcedureFeeConceptConflictError(generatedKey);
  }
  if (!fhir.createWithOutcome) {
    throw new Error("Procedure fee creation requires conditional-create outcome support.");
  }
  const outcome = await fhir.createWithOutcome(buildProcedureFeeDefinition({
    procedureConceptKey: generatedKey,
    display,
    category: input.category,
    billingCode: normalizeBillingCode(input.billingCode),
    modifier: normalizeModifier(input.modifier),
    priceCents: input.priceCents ?? undefined,
    active: input.active,
  }), {
    "X-ODOS-Source": "procedure-fee-schedule",
    "If-None-Exist": `identifier=${FEE_DEFINITION_IDENTIFIER_SYSTEM}|${generatedKey}`,
  });
  if (!outcome.created) throw new ProcedureFeeConceptConflictError(generatedKey);
  return procedureFeeScheduleItem(outcome.resource);
}

export async function saveProcedureFeeScheduleItem(
  fhir: ProcedureFeeScheduleFhir,
  input: {
    procedureConceptKey: string;
    display?: string;
    category?: ProcedureFeeCategory;
    billingCode?: string | null;
    modifier?: string | null;
    priceCents?: number | null;
    active: boolean;
  },
): Promise<ProcedureFeeScheduleItem> {
  assertCents(input.priceCents);
  const definitions = await ensureProcedureFeeSchedule(fhir, [input.procedureConceptKey]);
  const existing = definitions.find((definition) =>
    procedureConceptKey(definition) === input.procedureConceptKey
  );
  if (!existing?.id) throw new Error("Procedure fee definition could not be resolved for update.");
  const priceCents = input.priceCents === undefined
    ? definitionPriceCents(existing)
    : input.priceCents ?? undefined;
  const billingCode = input.billingCode === undefined
    ? definitionBillingCode(existing)
    : normalizeBillingCode(input.billingCode);
  const seed = PROCEDURE_FEE_SEEDS.find((candidate) =>
    candidate.procedureConceptKey === input.procedureConceptKey
  );
  const display = seed?.display ?? (input.display === undefined
    ? existing.title ?? displayFromKey(input.procedureConceptKey)
    : normalizeDisplay(input.display));
  const category = seed?.category ?? (input.category === undefined
    ? definitionCategory(existing)
    : input.category);
  const modifier = input.modifier === undefined
    ? definitionModifier(existing)
    : normalizeModifier(input.modifier);
  const saved = await fhir.update(
    "ChargeItemDefinition",
    existing.id,
    buildProcedureFeeDefinition({
      procedureConceptKey: input.procedureConceptKey,
      display,
      category,
      billingCode,
      modifier,
      priceCents,
      active: input.active,
      existing,
    }),
    {
      "X-ODOS-Source": "procedure-fee-schedule",
      ...(existing.meta?.versionId ? { "If-Match": `W/"${existing.meta.versionId}"` } : {}),
    },
  );
  return procedureFeeScheduleItem(saved);
}

export async function materializeAcceptedChargeProposals(input: {
  fhir: ProcedureChargeFhir;
  feeScheduleFhir: ProcedureFeeScheduleFhir;
  encounterId: string;
  actorReference: string;
  charges: RowStore<ChargeProposal>;
  applications: RowStore<ProtocolApplication>;
  now?: () => string;
}): Promise<{ materialized: number; finalized: number }> {
  const proposals = (await input.charges.list()).filter((proposal) =>
    proposal.encounterId === input.encounterId && proposal.state === "accepted"
  );
  if (!proposals.length) return { materialized: 0, finalized: 0 };

  const encounter = await input.fhir.read("Encounter", input.encounterId);
  const patientReference = encounter.subject?.reference;
  if (!patientReference?.match(/^Patient\/[A-Za-z0-9.-]+$/)) {
    throw new Error("Encounter must have a local Patient subject before charges can be materialized.");
  }
  const patientId = patientReference.slice("Patient/".length);
  const applications = await input.applications.list();
  for (const proposal of proposals) {
    if (proposal.protocolApplicationId !== undefined && proposal.protocolApplicationId !== null) {
      const application = applications.find((row) => row.id === proposal.protocolApplicationId);
      if (!application || application.encounterId !== input.encounterId || application.patientId !== patientId ||
        !application.confirmed || application.undoState !== "active") {
        throw new Error(`Charge proposal ${proposal.id} is not linked to an active confirmed application for this encounter and patient.`);
      }
    }
    if (!Number.isSafeInteger(proposal.units) || proposal.units < 1) {
      throw new Error(`Charge proposal ${proposal.id} has invalid units.`);
    }
    if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(proposal.procedureConceptKey)) {
      throw new Error(`Charge proposal ${proposal.id} has an invalid procedure concept key.`);
    }
    if (proposal.dxPointers.some((reference) => !/^Condition\/[A-Za-z0-9.-]+$/.test(reference))) {
      throw new Error(`Charge proposal ${proposal.id} has an invalid diagnosis pointer.`);
    }
  }
  const definitions = await ensureProcedureFeeSchedule(
    input.feeScheduleFhir,
    proposals.map((proposal) => proposal.procedureConceptKey),
  );
  const definitionsByKey = new Map(definitions.flatMap((definition) => {
    const key = procedureConceptKey(definition);
    return key ? [[key, definition] as const] : [];
  }));
  const enteredDate = input.now?.() ?? new Date().toISOString();
  let materialized = 0;
  let finalized = 0;

  for (const proposal of proposals) {
    if (proposal.chargeItemRef) {
      await input.charges.save({ ...proposal, state: "finalized" });
      finalized += 1;
      continue;
    }
    const definition = definitionsByKey.get(proposal.procedureConceptKey);
    const unitPriceCents = definition?.status === "active"
      ? definitionPriceCents(definition)
      : undefined;
    const totalCents = unitPriceCents === undefined ? 0 : unitPriceCents * proposal.units;
    if (!Number.isSafeInteger(totalCents)) {
      throw new Error(`Charge proposal ${proposal.id} total is outside the safe integer range.`);
    }
    const chargeItem = buildChargeItem({
      proposal,
      definition,
      patientReference,
      actorReference: input.actorReference,
      occurrenceDateTime: encounter.period?.start ?? enteredDate,
      enteredDate,
      totalCents,
      unpriced: unitPriceCents === undefined,
    });
    const saved = await input.fhir.create(chargeItem, {
      "X-ODOS-Source": "protocol-charge-materializer",
      "If-None-Exist": `identifier=${CHARGE_PROPOSAL_IDENTIFIER_SYSTEM}|${proposal.id}`,
    });
    if (!saved.id) throw new Error(`ChargeItem for proposal ${proposal.id} was saved without an id.`);
    await input.charges.save({
      ...proposal,
      state: "finalized",
      chargeItemRef: `ChargeItem/${saved.id}`,
    });
    materialized += 1;
    finalized += 1;
  }
  return { materialized, finalized };
}

export function buildProcedureFeeDefinition(input: {
  procedureConceptKey: string;
  display: string;
  category?: ProcedureFeeCategory;
  billingCode?: string;
  modifier?: string;
  priceCents?: number;
  active?: boolean;
  existing?: ChargeItemDefinition;
}): ChargeItemDefinition {
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(input.procedureConceptKey)) {
    throw new Error("Procedure concept key must use lowercase letters, numbers, and hyphens.");
  }
  assertCents(input.priceCents);
  const billingCode = normalizeBillingCode(input.billingCode);
  const modifier = normalizeModifier(input.modifier);
  assertCategory(input.category);
  const version = input.existing ? nextVersion(input.existing.version) : "1";
  const retainedExtensions = input.existing?.extension?.filter((extension) =>
    extension.url !== FEE_CATEGORY_EXTENSION_URL && extension.url !== FEE_MODIFIER_EXTENSION_URL
  ) ?? [];
  const extensions = [
    ...retainedExtensions,
    ...(input.category ? [{ url: FEE_CATEGORY_EXTENSION_URL, valueCode: input.category }] : []),
    ...(modifier ? [{ url: FEE_MODIFIER_EXTENSION_URL, valueString: modifier }] : []),
  ];
  return {
    resourceType: "ChargeItemDefinition",
    ...(input.existing?.id ? { id: input.existing.id } : {}),
    ...(input.existing?.meta ? { meta: input.existing.meta } : {}),
    url: procedureFeeCanonical(input.procedureConceptKey),
    identifier: [{ system: FEE_DEFINITION_IDENTIFIER_SYSTEM, value: input.procedureConceptKey }],
    version,
    status: input.active === false ? "retired" : "active",
    title: input.display,
    ...(extensions.length ? { extension: extensions } : {}),
    code: {
      coding: [
        ...(billingCode ? [{
          system: billingCodeSystem(billingCode),
          code: billingCode,
          display: input.display,
        }] : []),
        {
          system: PROCEDURE_CONCEPT_SYSTEM,
          code: input.procedureConceptKey,
          display: input.display,
        },
      ],
      text: input.display,
    },
    ...(input.priceCents === undefined ? {} : {
      propertyGroup: [{
        priceComponent: [{
          type: "base",
          code: { coding: [{ system: ACT_CODE_SYSTEM, code: "CHRG" }] },
          amount: { value: input.priceCents / 100, currency: "USD" },
        }],
      }],
    }),
  };
}

function buildChargeItem(input: {
  proposal: ChargeProposal;
  definition?: ChargeItemDefinition;
  patientReference: string;
  actorReference: string;
  occurrenceDateTime: string;
  enteredDate: string;
  totalCents: number;
  unpriced: boolean;
}): ChargeItem {
  const display = input.definition?.title ?? displayFromKey(input.proposal.procedureConceptKey);
  const canonical = input.definition?.url ?? procedureFeeCanonical(input.proposal.procedureConceptKey);
  const version = input.definition?.version;
  return {
    resourceType: "ChargeItem",
    identifier: [{ system: CHARGE_PROPOSAL_IDENTIFIER_SYSTEM, value: input.proposal.id }],
    definitionCanonical: [`${canonical}${version ? `|${version}` : ""}`],
    status: "billable",
    code: input.definition?.code ?? {
      coding: [{
        system: PROCEDURE_CONCEPT_SYSTEM,
        code: input.proposal.procedureConceptKey,
        display,
      }],
      text: display,
    },
    subject: { reference: input.patientReference },
    context: { reference: `Encounter/${input.proposal.encounterId}` },
    occurrenceDateTime: input.occurrenceDateTime,
    quantity: { value: input.proposal.units },
    priceOverride: { value: input.totalCents / 100, currency: "USD" },
    enterer: { reference: input.actorReference },
    enteredDate: input.enteredDate,
    supportingInformation: [...new Set(input.proposal.dxPointers)].map((reference) => ({ reference })),
    ...(input.proposal.laterality
      ? { bodysite: chargeItemBodysite(input.proposal.laterality) }
      : {}),
    ...(input.unpriced ? {
      extension: [{ url: ODOS_UNPRICED_CHARGE_EXTENSION_URL, valueBoolean: true }],
    } : {}),
  };
}

async function listProcedureFeeDefinitions(
  fhir: Pick<ProcedureFeeScheduleFhir, "search" | "searchUrl">,
): Promise<ChargeItemDefinition[]> {
  return (await searchAll<ChargeItemDefinition>(fhir, "ChargeItemDefinition", { _count: "100" }))
    .filter((definition) => Boolean(procedureConceptKey(definition)));
}

function procedureFeeScheduleItem(definition: ChargeItemDefinition): ProcedureFeeScheduleItem {
  const key = procedureConceptKey(definition);
  if (!key) throw new Error("ChargeItemDefinition is not an ODOS procedure fee definition.");
  const seed = PROCEDURE_FEE_SEEDS.find((candidate) => candidate.procedureConceptKey === key);
  return {
    id: key,
    procedureConceptKey: key,
    display: definition.title ?? displayFromKey(key),
    active: definition.status === "active",
    billingCode: definitionBillingCode(definition),
    category: definitionCategory(definition) ?? seed?.category,
    modifier: definitionModifier(definition),
    priceCents: definitionPriceCents(definition),
    version: definition.version ?? "1",
  };
}

function procedureConceptKey(definition: ChargeItemDefinition): string | undefined {
  return definition.code?.coding?.find((coding) => coding.system === PROCEDURE_CONCEPT_SYSTEM)?.code;
}

function definitionPriceCents(definition: ChargeItemDefinition): number | undefined {
  const basePrices = definition.propertyGroup
    ?.flatMap((group) => group.priceComponent ?? [])
    .filter((component) => component.type === "base") ?? [];
  if (basePrices.length > 1) {
    throw new Error(`Procedure fee definition ${procedureConceptKey(definition) ?? definition.id ?? "unknown"} has multiple base prices.`);
  }
  const value = basePrices[0]?.amount?.value;
  if (value === undefined) return undefined;
  const scaled = value * 100;
  const cents = Math.round(scaled);
  if (!Number.isSafeInteger(cents) || value < 0 || Math.abs(scaled - cents) > 0.000001) {
    throw new Error(`Procedure fee definition ${procedureConceptKey(definition) ?? definition.id ?? "unknown"} has an invalid base price.`);
  }
  return cents;
}

function definitionBillingCode(definition: ChargeItemDefinition): string | undefined {
  return definition.code?.coding?.find((coding) =>
    coding.system === HCPCS_CODE_SYSTEM || coding.system === CPT_CODE_SYSTEM
  )?.code;
}

function definitionCategory(definition: ChargeItemDefinition): ProcedureFeeCategory | undefined {
  const value = definition.extension?.find((extension) =>
    extension.url === FEE_CATEGORY_EXTENSION_URL
  )?.valueCode;
  return typeof value === "string" && PROCEDURE_FEE_CATEGORIES.includes(value as ProcedureFeeCategory)
    ? value as ProcedureFeeCategory
    : undefined;
}

function definitionModifier(definition: ChargeItemDefinition): string | undefined {
  const value = definition.extension?.find((extension) =>
    extension.url === FEE_MODIFIER_EXTENSION_URL
  )?.valueString;
  return typeof value === "string" ? normalizeModifier(value) : undefined;
}

function normalizeBillingCode(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const normalized = value.trim().toUpperCase();
  if (!normalized) return undefined;
  if (!/^[A-Z0-9]{1,20}$/.test(normalized)) {
    throw new Error("Billing code must contain only letters and numbers.");
  }
  return normalized;
}

function normalizeModifier(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const normalized = value.trim().toUpperCase();
  if (!normalized) return undefined;
  if (!/^[A-Z0-9]{1,10}$/.test(normalized)) {
    throw new Error("Modifier must contain only letters and numbers.");
  }
  return normalized;
}

function assertCategory(value: ProcedureFeeCategory | undefined): void {
  if (value !== undefined && !PROCEDURE_FEE_CATEGORIES.includes(value)) {
    throw new Error("Procedure fee category is invalid.");
  }
}

function normalizeDisplay(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) throw new Error("Procedure display name is required.");
  return normalized;
}

export function procedureConceptKeyFromDisplay(display: string): string {
  const slug = display.normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100)
    .replace(/-+$/g, "");
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)) {
    throw new Error("Procedure display name must contain a letter or number.");
  }
  return slug;
}

function billingCodeSystem(code: string): string {
  return /^[A-Z]/.test(code) ? HCPCS_CODE_SYSTEM : CPT_CODE_SYSTEM;
}

function procedureFeeCanonical(procedureConceptKey: string): string {
  return `https://odos2020.com/practice/${PRACTICE_ID}/charge-rules/procedures/${encodeURIComponent(procedureConceptKey)}`;
}

function nextVersion(version: string | undefined): string {
  const current = Number(version ?? "0");
  if (!Number.isSafeInteger(current) || current < 0) {
    throw new Error("Procedure fee definition version must be a nonnegative integer.");
  }
  return String(current + 1);
}

function assertCents(value: number | null | undefined): void {
  if (value !== undefined && value !== null && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error("Procedure fee must be a nonnegative integer number of cents.");
  }
}

function displayFromKey(key: string): string {
  return key.split("-").filter(Boolean).map((part) =>
    `${part[0]?.toLocaleUpperCase() ?? ""}${part.slice(1)}`
  ).join(" ");
}
