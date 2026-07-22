import type { ProcedureChargeRule, ProtocolDefinition } from "./protocol-types.js";

const DEFAULT = { defaultSelected: true, lateralityMode: "inherit-dx" as const };
const OU = { defaultSelected: true, lateralityMode: "OU-always" as const };
export const GLAUCOMA_SUSPECT_TRIGGER_PREFIX = "H40.0";
const PHASE0_LEDGER = "data/code-bindings/glaucoma-suspect-phase0-ledger.json";
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
