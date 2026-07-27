import type { ProcedureChargeRule, ProtocolDefinition } from "./protocol-types.js";
import {
  DRY_EYE_CONJUNCTIVAL_STAINING_KEY,
  DRY_EYE_GLAND_FUNCTION_KEY,
  DRY_EYE_GLAND_STRUCTURE_KEY,
  DRY_EYE_MARKERS_KEY,
  DRY_EYE_STAGING_KEY,
  DRY_EYE_SYMPTOMS_KEY,
  DRY_EYE_TEAR_VOLUME_KEY,
} from "./dry-eye-finding-definition.js";
import { DRY_EYE_PROCEDURE_STABLE_KEYS } from "./procedure-definition-store.js";

const DEFAULT = { defaultSelected: true, lateralityMode: "inherit-dx" as const };
const OU = { defaultSelected: true, lateralityMode: "OU-always" as const };
export const GLAUCOMA_SUSPECT_TRIGGER_PREFIX = "H40.0";
export const DRY_EYE_KCS_TRIGGER_PREFIX = "H16.22";
export const DRY_EYE_MGD_TRIGGER_PREFIX = "H02.88";
const PHASE0_LEDGER = "data/code-bindings/glaucoma-suspect-phase0-ledger.json";
const DRY_EYE_DESIGN =
  "performance-od/decisions/2026-07-26-odos-dry-eye-workup-pack-design.md";
const PROCEDURES = [
  { key: "gonioscopy", context: "in-office-today" },
  { key: "corneal-pachymetry", context: "in-office-today" },
  { key: "scodi-optic-nerve", context: "schedule" },
  { key: "visual-field-threshold", context: "schedule" },
  { key: "fundus-photography", context: "in-office-today" },
] as const;

export const GLAUCOMA_SUSPECT_PROTOCOL: ProtocolDefinition = {
  id: "glaucoma-suspect-initial",
  version: 1,
  title: "Glaucoma Suspect — Initial Workup",
  // The trigger family is verified in the Phase-0 glaucoma ledger; procedure concepts below are not CPT codes.
  trigger: { kind: "diagnosis", dxKeys: [`${GLAUCOMA_SUSPECT_TRIGGER_PREFIX}*`] },
  ownership: { ownerId: "practice", sharing: "practice" },
  categories: [],
  status: "active",
  provenanceNote: "Operator-authored (E. Bang, O.D.) initial glaucoma-suspect workup.",
  authoring: {
    origin: "clinician",
    at: "2026-07-18T00:00:00.000Z",
    actor: "Practitioner/odos-system",
  },
  audit: {
    createdBy: "Practitioner/odos-system",
    createdAt: "2026-07-18T00:00:00.000Z",
    publishedBy: "Practitioner/odos-system",
    publishedAt: "2026-07-18T00:00:00.000Z",
  },
  items: [
    {
      ...OU,
      itemKey: "cd-ratio",
      itemType: "finding-seed",
      payload: {
        findingDefKey: "cup_disc_ratio",
        mode: "seedValue",
        defaultValues: { OD: 0.6, OS: 0.6 },
        expand: { eyes: ["OD", "OS"] },
      },
    },
    {
      ...OU,
      itemKey: "gonio-angle",
      itemType: "finding-seed",
      payload: {
        findingDefKey: "gonio_angle_structures",
        mode: "seedValue",
        defaultValue: "ss",
        expand: { eyes: ["OD", "OS"], components: ["superior", "nasal", "inferior", "temporal"] },
        entryMode: "propagated-uniform",
      },
    },
    {
      ...OU,
      itemKey: "gonio-pigmentation",
      itemType: "finding-seed",
      payload: {
        findingDefKey: "gonio_tm_pigmentation",
        mode: "promptOnly",
        expand: { eyes: ["OD", "OS"] },
      },
    },
    { ...OU, itemKey: "iop", itemType: "finding-seed", payload: { findingDefKey: "iop", mode: "promptOnly" } },
    { ...OU, itemKey: "cct", itemType: "finding-seed", payload: { findingDefKey: "pachymetry_um", mode: "promptOnly" } },
    ...PROCEDURES.map((procedure) => ({
      ...OU, itemKey: `order-${procedure.key}`, itemType: "order" as const, mergeKey: `order:${procedure.key}`,
      payload: { orderableKey: procedure.key, performContext: procedure.context, chargeSeedRef: `charge-${procedure.key}` },
    })),
    ...PROCEDURES.map((procedure) => ({
      ...DEFAULT, itemKey: `charge-${procedure.key}`, itemType: "charge-seed" as const,
      payload: { procedureConceptKey: procedure.key, chargeRuleRefs: [`rule-${procedure.key}-h40x`], requiresOrderCompletion: true },
    })),
    { ...DEFAULT, itemKey: "counsel-suspect", itemType: "counseling", payload: { topicKey: "glaucoma-suspect-discussion", narrativeTemplate: "Discussed glaucoma suspect status: elevated risk findings without confirmed glaucomatous damage. Reviewed need for baseline testing and ongoing monitoring; warning signs reviewed. Patient verbalized understanding." } },
    { ...DEFAULT, itemKey: "edu-suspect", itemType: "education", payload: { assetRef: "pt-ed-glaucoma-suspect", deliveryMode: "print" } },
    { ...DEFAULT, itemKey: "rto-6mo", itemType: "follow-up", mergeKey: "followup", payload: { interval: 6, unit: "months", reason: "glaucoma suspect monitoring — repeat IOP, review baseline imaging", schedulingOrder: true } },
  ],
};

export const GLAUCOMA_SUSPECT_CHARGE_RULES: ProcedureChargeRule[] = PROCEDURES.map((procedure) => ({
  id: `rule-${procedure.key}-h40x`,
  version: 1,
  procedureConceptKey: procedure.key,
  dxScope: [`${GLAUCOMA_SUSPECT_TRIGGER_PREFIX}*`],
  jurisdiction: { payerClass: "unspecified" },
  outcome: "needs-review",
  sourceAuthority: {
    kind: "phase-0-code-ledger",
    citation: procedure.key === "scodi-optic-nerve"
      ? "CMS Article A57804 and LCD L34431"
      : PHASE0_LEDGER,
    url: procedure.key === "scodi-optic-nerve"
      ? "https://www.cms.gov/medicare-coverage-database/view/article.aspx?articleId=57804"
      : PHASE0_LEDGER,
    ...(procedure.key === "scodi-optic-nerve"
      ? { additionalUrls: ["https://www.cms.gov/medicare-coverage-database/view/lcd.aspx?lcdId=34431"] }
      : {}),
    accessedDate: "2026-07-18",
  },
  effectivePeriod: { start: "2026-07-18" },
  verificationStatus: "provisional",
}));

const DRY_EYE_PROMPT_FINDINGS = [
  { itemKey: "dry-eye-symptoms", findingDefKey: DRY_EYE_SYMPTOMS_KEY },
  { itemKey: "dry-eye-tear-stability", findingDefKey: "ocular-health:anterior:tear-film" },
  { itemKey: "dry-eye-tear-volume", findingDefKey: DRY_EYE_TEAR_VOLUME_KEY },
  { itemKey: "dry-eye-markers", findingDefKey: DRY_EYE_MARKERS_KEY },
  { itemKey: "dry-eye-gland-structure", findingDefKey: DRY_EYE_GLAND_STRUCTURE_KEY },
  { itemKey: "dry-eye-gland-function", findingDefKey: DRY_EYE_GLAND_FUNCTION_KEY },
  { itemKey: "dry-eye-conjunctival-staining", findingDefKey: DRY_EYE_CONJUNCTIVAL_STAINING_KEY },
  { itemKey: "dry-eye-staging", findingDefKey: DRY_EYE_STAGING_KEY },
] as const;

export const DRY_EYE_EVALUATION_PROCEDURE_KEY = "dry-eye-evaluation";
export const DRY_EYE_EVALUATION_RULE_ID = "rule-dry-eye-evaluation";
export const DRY_EYE_PUNCTAL_OCCLUSION_RULE_ID = "rule-dry-eye-punctal-occlusion";

export const DRY_EYE_EVALUATION_PROTOCOL: ProtocolDefinition = {
  id: "dry-eye-evaluation",
  version: 1,
  acceptCharges: true,
  title: "Dry Eye — Evaluation Workup",
  trigger: {
    kind: "diagnosis",
    dxKeys: [`${DRY_EYE_KCS_TRIGGER_PREFIX}*`, `${DRY_EYE_MGD_TRIGGER_PREFIX}*`],
  },
  ownership: { ownerId: "practice", sharing: "practice" },
  categories: ["Dry Eye"],
  status: "active",
  provenanceNote: "Operator-authored dry-eye evaluation workup.",
  authoring: {
    origin: "clinician",
    at: "2026-07-26T00:00:00.000Z",
    actor: "Practitioner/odos-system",
  },
  audit: {
    createdBy: "Practitioner/odos-system",
    createdAt: "2026-07-26T00:00:00.000Z",
    publishedBy: "Practitioner/odos-system",
    publishedAt: "2026-07-26T00:00:00.000Z",
  },
  items: [
    ...DRY_EYE_PROMPT_FINDINGS.map(({ itemKey, findingDefKey }) => ({
      ...OU,
      itemKey,
      itemType: "finding-seed" as const,
      payload: { findingDefKey, mode: "promptOnly" },
    })),
    {
      ...OU,
      itemKey: "order-dry-eye-evaluation",
      itemType: "order",
      mergeKey: "order:dry-eye-evaluation",
      payload: {
        orderableKey: DRY_EYE_EVALUATION_PROCEDURE_KEY,
        performContext: "in-office-today",
        chargeSeedRef: "charge-dry-eye-evaluation",
      },
    },
    {
      ...DEFAULT,
      itemKey: "charge-dry-eye-evaluation",
      itemType: "charge-seed",
      payload: {
        procedureConceptKey: DRY_EYE_EVALUATION_PROCEDURE_KEY,
        chargeRuleRefs: [DRY_EYE_EVALUATION_RULE_ID],
        requiresOrderCompletion: true,
      },
    },
  ],
};

export const DRY_EYE_CHARGE_RULES: ProcedureChargeRule[] = [
  {
    id: DRY_EYE_EVALUATION_RULE_ID,
    version: 1,
    procedureConceptKey: DRY_EYE_EVALUATION_PROCEDURE_KEY,
    dxScope: [`${DRY_EYE_KCS_TRIGGER_PREFIX}*`, `${DRY_EYE_MGD_TRIGGER_PREFIX}*`],
    jurisdiction: { payerClass: "unspecified" },
    outcome: "needs-review",
    sourceAuthority: {
      kind: "operator-design",
      citation: `${DRY_EYE_DESIGN} §3`,
      url: DRY_EYE_DESIGN,
      accessedDate: "2026-07-26",
    },
    effectivePeriod: { start: "2026-07-26" },
    verificationStatus: "provisional",
  },
  {
    id: DRY_EYE_PUNCTAL_OCCLUSION_RULE_ID,
    version: 1,
    procedureConceptKey: DRY_EYE_PROCEDURE_STABLE_KEYS.punctalOcclusion,
    dxScope: [`${DRY_EYE_KCS_TRIGGER_PREFIX}*`, `${DRY_EYE_MGD_TRIGGER_PREFIX}*`],
    jurisdiction: { payerClass: "unspecified" },
    outcome: "needs-review",
    sourceAuthority: {
      kind: "operator-design",
      citation: `${DRY_EYE_DESIGN} §4`,
      url: DRY_EYE_DESIGN,
      accessedDate: "2026-07-26",
    },
    effectivePeriod: { start: "2026-07-26" },
    verificationStatus: "provisional",
  },
];

export const BUILTIN_PROTOCOLS = [
  GLAUCOMA_SUSPECT_PROTOCOL,
  DRY_EYE_EVALUATION_PROTOCOL,
] as const;

export const BUILTIN_CHARGE_RULES = [
  ...GLAUCOMA_SUSPECT_CHARGE_RULES,
  ...DRY_EYE_CHARGE_RULES,
] as const;
