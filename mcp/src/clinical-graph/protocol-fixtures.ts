import type { ProcedureChargeRule, ProtocolDefinition } from "./protocol-types.js";

const DEFAULT = { defaultSelected: true, lateralityMode: "inherit-dx" as const };
const OU = { defaultSelected: true, lateralityMode: "OU-always" as const };

export const GLAUCOMA_SUSPECT_PROTOCOL: ProtocolDefinition = {
  id: "glaucoma-suspect-initial",
  version: 1,
  title: "Glaucoma Suspect — Initial Workup",
  trigger: { kind: "diagnosis", dxKeys: ["H40.0*"] },
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
    { ...OU, itemKey: "cct", itemType: "finding-seed", payload: { findingDefKey: "pachymetry-cct", mode: "promptOnly" } },
    { ...OU, itemKey: "order-gonio", itemType: "order", mergeKey: "order:92020", payload: { orderableKey: "gonioscopy", performContext: "in-office-today", chargeSeedRef: "charge-92020" } },
    { ...OU, itemKey: "order-pachy", itemType: "order", mergeKey: "order:76514", payload: { orderableKey: "corneal-pachymetry", performContext: "in-office-today", chargeSeedRef: "charge-76514" } },
    { ...OU, itemKey: "order-oct-on", itemType: "order", mergeKey: "order:92133", payload: { orderableKey: "scodi-optic-nerve", performContext: "schedule", chargeSeedRef: "charge-92133" } },
    { ...OU, itemKey: "order-vf", itemType: "order", mergeKey: "order:92083", payload: { orderableKey: "threshold-visual-field", performContext: "schedule", chargeSeedRef: "charge-92083" } },
    { ...OU, itemKey: "order-photos", itemType: "order", mergeKey: "order:92250", payload: { orderableKey: "fundus-photography", performContext: "in-office-today", chargeSeedRef: "charge-92250" } },
    ...["92020", "76514", "92133", "92083", "92250"].map((cpt) => ({
      ...DEFAULT, itemKey: `charge-${cpt}`, itemType: "charge-seed" as const,
      payload: { cptConcept: cpt, chargeRuleRefs: [cpt === "92133" ? "rule-92133-h40x-palmetto" : `rule-${cpt}-h40x`], requiresOrderCompletion: true },
    })),
    { ...DEFAULT, itemKey: "counsel-suspect", itemType: "counseling", payload: { topicKey: "glaucoma-suspect-discussion", narrativeTemplate: "Discussed glaucoma suspect status: elevated risk findings without confirmed glaucomatous damage. Reviewed need for baseline testing and ongoing monitoring; warning signs reviewed. Patient verbalized understanding." } },
    { ...DEFAULT, itemKey: "edu-suspect", itemType: "education", payload: { assetRef: "pt-ed-glaucoma-suspect", deliveryMode: "print" } },
    { ...DEFAULT, itemKey: "rto-6mo", itemType: "follow-up", mergeKey: "followup", payload: { interval: 6, unit: "months", reason: "glaucoma suspect monitoring — repeat IOP, review baseline imaging", schedulingOrder: true } },
  ],
};

const RULE_IDS = [
  "rule-92020-h40x", "rule-76514-h40x", "rule-92133-h40x-palmetto",
  "rule-92083-h40x", "rule-92250-h40x",
];

export const GLAUCOMA_SUSPECT_CHARGE_RULES: ProcedureChargeRule[] = RULE_IDS.map((id) => ({
  id,
  version: 1,
  cptConcept: id.split("-")[1]!,
  dxScope: ["H40.0*"],
  jurisdiction: { payerClass: "unspecified" },
  outcome: "needs-review",
  sourceAuthority: {
    kind: "phase-0-code-ledger",
    citation: id.includes("92133")
      ? "2026-06-13 architecture decision Phase-0 code ledger; CMS Article A57804"
      : "2026-06-13 architecture decision Phase-0 code ledger placeholder",
    url: "https://www.cms.gov/medicare-coverage-database/view/article.aspx?articleId=57804",
    accessedDate: "2026-07-18",
  },
  effectivePeriod: { start: "2026-07-18" },
  verificationStatus: "provisional",
}));
