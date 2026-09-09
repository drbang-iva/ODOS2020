/**
 * COMPILED-SEED ONLY registry for the 14 ocular-health structure definitions'
 * active "Abnormal findings" options. Dry-eye mappings live on other fields and
 * are deliberately out of scope.
 *
 * Seeded mechanically from ODOS2020 commit
 * 1bd9f80434c94b721f8a87c8d574e13445f230c4: an active option named by an
 * active option or qualifier trigger was marked proposes/finding; every other
 * active option was marked pending. All later edits are by hand.
 *
 * This registry describes compiled seeds, not a practice's effective finding
 * definitions. A stored Basic row replaces its compiled seed whole in
 * finding-definition-store.ts.
 */

export type FindingDisposition =
  | { kind: "proposes"; entrySurface: "finding" | "diagnosis-search" | "protocol" | "history" }
  | { kind: "descriptive"; reason: string }
  | { kind: "awaiting-ruling"; question: string; owner: string; reference: string }
  | { kind: "pending" };

export interface FindingDispositionIdentity {
  definitionStableKey: string;
  fieldLocalCode: string;
  optionCode: string;
  qualifierContext?: string;
}

export interface FindingDispositionRegistryRow extends FindingDispositionIdentity {
  disposition: FindingDisposition;
}

// Nested option codes already contain "::"; the ASCII unit separator cannot occur
// in any validated key segment and keeps the encoding unambiguous.
export const FINDING_DISPOSITION_KEY_SEPARATOR = "\u001f";

export function buildFindingDispositionKey(identity: FindingDispositionIdentity): string {
  const segments = [
    identity.definitionStableKey,
    identity.fieldLocalCode,
    identity.optionCode,
    ...(identity.qualifierContext === undefined ? [] : [identity.qualifierContext]),
  ];
  if (segments.some((segment) => segment.length === 0 || segment.includes(FINDING_DISPOSITION_KEY_SEPARATOR))) {
    throw new Error("Finding-disposition key segments must be non-empty and cannot contain the reserved separator.");
  }
  return segments.join(FINDING_DISPOSITION_KEY_SEPARATOR);
}

export function parseFindingDispositionKey(key: string): FindingDispositionIdentity {
  const segments = key.split(FINDING_DISPOSITION_KEY_SEPARATOR);
  if ((segments.length !== 3 && segments.length !== 4) || segments.some((segment) => segment.length === 0)) {
    throw new Error("Finding-disposition key must contain definition, field, option, and optional qualifier context.");
  }
  const [definitionStableKey, fieldLocalCode, optionCode, qualifierContext] = segments;
  return {
    definitionStableKey,
    fieldLocalCode,
    optionCode,
    ...(qualifierContext === undefined ? {} : { qualifierContext }),
  };
}

export const FINDING_DISPOSITION_ROWS: readonly FindingDispositionRegistryRow[] = [
  { definitionStableKey: "ocular-health:anterior:periocular-adnexa", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_01", optionCode: "dermatochalasis", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:periocular-adnexa", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_01", optionCode: "periorbital-edema", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:periocular-adnexa", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_01", optionCode: "facial-asymmetry", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:periocular-adnexa", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_01", optionCode: "brow-ptosis", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:periocular-adnexa", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_01", optionCode: "proptosis", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:periocular-adnexa", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_01", optionCode: "enophthalmos", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:periocular-adnexa", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_01", optionCode: "preauricular-node", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:periocular-adnexa", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_01", optionCode: "orbital-mass", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:periocular-adnexa", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_01", optionCode: "ecchymosis", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:periocular-adnexa", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_01", optionCode: "dermatitis", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:lids-lashes", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_02", optionCode: "demodex", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:lids-lashes", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_02", optionCode: "demodex::flaking", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:lids-lashes", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_02", optionCode: "demodex::collarettes", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:lids-lashes", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_02", optionCode: "anterior-blepharitis", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:lids-lashes", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_02", optionCode: "anterior-blepharitis::seborrheic", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:anterior:lids-lashes", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_02", optionCode: "anterior-blepharitis::ulcerative", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:anterior:lids-lashes", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_02", optionCode: "posterior-blepharitis", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:anterior:lids-lashes", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_02", optionCode: "posterior-blepharitis::inflammation", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:lids-lashes", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_02", optionCode: "posterior-blepharitis::rosacea", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:lids-lashes", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_02", optionCode: "posterior-blepharitis::vascularization", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:lids-lashes", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_02", optionCode: "meibomian-gland-dysfunction", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:anterior:lids-lashes", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_02", optionCode: "chalazion", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:lids-lashes", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_02", optionCode: "trichiasis", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:lids-lashes", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_02", optionCode: "hordeolum", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:lids-lashes", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_02", optionCode: "ptosis", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:lids-lashes", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_02", optionCode: "ectropion", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:lids-lashes", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_02", optionCode: "entropion", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:lids-lashes", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_02", optionCode: "madarosis", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:lids-lashes", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_02", optionCode: "lagophthalmos", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:lids-lashes", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_02", optionCode: "lid-lesion", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:lids-lashes", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_02", optionCode: "dermatochalasis", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:lids-lashes", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_02", optionCode: "floppy-eyelid", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:lids-lashes", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_02", optionCode: "telangiectasia", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:lids-lashes", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_02", optionCode: "lid-margin-keratinization", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:lids-lashes", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_02", optionCode: "poliosis", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:palpebral-conjunctiva", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_03", optionCode: "papillae", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:palpebral-conjunctiva", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_03", optionCode: "follicles", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:palpebral-conjunctiva", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_03", optionCode: "giant-papillae-gpc", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:anterior:palpebral-conjunctiva", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_03", optionCode: "concretions", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:palpebral-conjunctiva", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_03", optionCode: "symblepharon", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:palpebral-conjunctiva", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_03", optionCode: "scarring", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:palpebral-conjunctiva", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_03", optionCode: "membrane-pseudomembrane", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:palpebral-conjunctiva", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_03", optionCode: "hyperemia", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:conjunctiva", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_04", optionCode: "injection", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:conjunctiva", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_04", optionCode: "pinguecula", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:anterior:conjunctiva", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_04", optionCode: "pterygium", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:anterior:conjunctiva", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_04", optionCode: "chemosis", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:conjunctiva", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_04", optionCode: "subconjunctival-hemorrhage", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:conjunctiva", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_04", optionCode: "nevus", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:conjunctiva", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_04", optionCode: "pigmentation", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:conjunctiva", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_04", optionCode: "concretion", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:conjunctiva", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_04", optionCode: "conjunctivochalasis", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:conjunctiva", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_04", optionCode: "episcleritis", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:conjunctiva", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_04", optionCode: "scleritis", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:conjunctiva", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_04", optionCode: "phlyctenule", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:conjunctiva", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_04", optionCode: "lymphangiectasia", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:conjunctiva", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_04", optionCode: "scleral-thinning", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:conjunctiva", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_04", optionCode: "nodule", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:tear-film", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_05", optionCode: "reduced-tear-meniscus", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:anterior:tear-film", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_05", optionCode: "rapid-tbut", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:anterior:tear-film", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_05", optionCode: "debris-in-tear-film", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:tear-film", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_05", optionCode: "mucus-strands", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:tear-film", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_05", optionCode: "foam", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:cornea", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_06", optionCode: "superficial-punctate-keratitis-spk", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:anterior:cornea", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_06", optionCode: "dry-eye-keratopathy", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:anterior:cornea", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_06", optionCode: "arcus", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:cornea", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_06", optionCode: "scar", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:cornea", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_06", optionCode: "keratoconus", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:anterior:cornea", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_06", optionCode: "guttata", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:cornea", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_06", optionCode: "pterygium-encroaching", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:anterior:cornea", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_06", optionCode: "neovascularization", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:cornea", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_06", optionCode: "infiltrate", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:cornea", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_06", optionCode: "abrasion", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:cornea", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_06", optionCode: "dendrite", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:cornea", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_06", optionCode: "edema", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:cornea", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_06", optionCode: "foreign-body", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:cornea", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_06", optionCode: "filaments", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:cornea", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_06", optionCode: "erosion", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:cornea", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_06", optionCode: "rces-recurrent-erosion", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:cornea", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_06", optionCode: "ebmd-map-dot-fingerprint", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:cornea", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_06", optionCode: "fuchs-endothelial-dystrophy", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:cornea", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_06", optionCode: "band-keratopathy", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:cornea", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_06", optionCode: "salzmann-s-nodule", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:cornea", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_06", optionCode: "keratic-precipitates", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:cornea", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_06", optionCode: "ulcer", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:cornea", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_06", optionCode: "haze", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:cornea", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_06", optionCode: "opacification", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:cornea", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_06", optionCode: "pannus", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:cornea", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_06", optionCode: "nodules", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:cornea", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_06", optionCode: "phlyctenule", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:cornea", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_06", optionCode: "descemet-folds", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:cornea", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_06", optionCode: "krukenberg-spindle", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:cornea", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_06", optionCode: "iron-line-hudson-stahli-stocker-s-fleischer-s", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:cornea", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_06", optionCode: "vogt-striae", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:cornea", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_06", optionCode: "vortex-keratopathy-verticillata", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:cornea", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_06", optionCode: "thygeson-s-spk", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:cornea", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_06", optionCode: "lipid-keratopathy", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:cornea", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_06", optionCode: "mooren-s-ulcer", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:cornea", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_06", optionCode: "terrien-s-marginal-degeneration", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:cornea", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_06", optionCode: "peripheral-thinning", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:cornea", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_06", optionCode: "central-thinning", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:cornea", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_06", optionCode: "hydrops", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:cornea", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_06", optionCode: "pigment-on-endothelium", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:anterior-chamber", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_07", optionCode: "cells", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:anterior-chamber", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_07", optionCode: "flare", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:anterior-chamber", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_07", optionCode: "shallow-ac", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:anterior:anterior-chamber", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_07", optionCode: "hyphema", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:anterior:anterior-chamber", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_07", optionCode: "hypopyon", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:anterior:anterior-chamber", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_07", optionCode: "peripheral-anterior-synechiae", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:anterior-chamber", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_07", optionCode: "pigment", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:anterior-chamber", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_07", optionCode: "narrow-angle-by-exam", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:anterior:iris", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_08", optionCode: "nevus", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:iris", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_08", optionCode: "transillumination-defect", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:iris", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_08", optionCode: "posterior-synechiae", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:anterior:iris", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_08", optionCode: "atrophy", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:iris", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_08", optionCode: "neovascularization-rubeosis", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:anterior:iris", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_08", optionCode: "coloboma", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:iris", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_08", optionCode: "heterochromia", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:iris", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_08", optionCode: "iridodonesis", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:iris", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_08", optionCode: "nodules", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:iris", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_08", optionCode: "sphincter-tears", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:iris", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_08", optionCode: "plateau-iris", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:iris", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_08", optionCode: "irregular-pupil", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:iris", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_08", optionCode: "sectoral-atrophy", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:iris", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_08", optionCode: "pseudoexfoliation-material-on-pupil-margin", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:anterior:lens", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_09", optionCode: "nuclear-sclerosis", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:anterior:lens", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_09", optionCode: "cortical-cataract", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:anterior:lens", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_09", optionCode: "posterior-subcapsular-psc", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:anterior:lens", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_09", optionCode: "pseudophakia-pciol", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:anterior:lens", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_09", optionCode: "posterior-capsular-opacification-pco", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:anterior:lens", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_09", optionCode: "mixed", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:anterior:lens", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_09", optionCode: "anterior-polar", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:lens", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_09", optionCode: "posterior-polar", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:lens", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_09", optionCode: "anterior-subcapsular", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:anterior:lens", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_09", optionCode: "mature-cataract", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:lens", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_09", optionCode: "pseudophakia-aciol", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:lens", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_09", optionCode: "aphakia", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:anterior:lens", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_09", optionCode: "phacodonesis", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:lens", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_09", optionCode: "pseudoexfoliation", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:anterior:lens", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_09", optionCode: "dislocated-lens-iol", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:lens", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_09", optionCode: "iol-deposits", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:anterior:lens", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_09", optionCode: "polychromatic-christmas-tree", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:posterior:vitreous", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_01", optionCode: "posterior-vitreous-detachment-pvd", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:posterior:vitreous", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_01", optionCode: "syneresis", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:posterior:vitreous", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_01", optionCode: "floaters", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:posterior:vitreous", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_01", optionCode: "asteroid-hyalosis", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:posterior:vitreous", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_01", optionCode: "vitreous-hemorrhage", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:posterior:vitreous", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_01", optionCode: "vitreous-cells", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:posterior:vitreous", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_01", optionCode: "shafer-s-sign-tobacco-dust", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:posterior:vitreous", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_01", optionCode: "vitreous-opacities", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:posterior:vitreous", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_01", optionCode: "anterior-hyaloid", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:posterior:vitreous", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_01", optionCode: "synchysis", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:posterior:fundus", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_02", optionCode: "diabetic-retinopathy-background-npdr", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:posterior:fundus", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_02", optionCode: "hypertensive-retinopathy", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:posterior:fundus", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_02", optionCode: "dot-blot-hemorrhage", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:posterior:fundus", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_02", optionCode: "hard-exudate", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:posterior:fundus", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_02", optionCode: "cotton-wool-spot", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:posterior:fundus", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_02", optionCode: "choroidal-nevus", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:posterior:fundus", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_02", optionCode: "chorioretinal-scar", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:posterior:fundus", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_02", optionCode: "microaneurysm", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:posterior:fundus", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_02", optionCode: "proliferative-diabetic-retinopathy-pdr", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:posterior:fundus", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_02", optionCode: "neovascularization-elsewhere-nve", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:posterior:fundus", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_02", optionCode: "preretinal-hemorrhage", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:posterior:fundus", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_02", optionCode: "choroidal-lesion", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:posterior:fundus", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_02", optionCode: "rpe-atrophy", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:posterior:fundus", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_02", optionCode: "roth-spot", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:posterior:fundus", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_02", optionCode: "myelinated-nerve-fiber", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:posterior:fundus", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_02", optionCode: "drusen", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:posterior:fundus", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_02", optionCode: "occasional-drusen", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:posterior:macula", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_03", optionCode: "drusen", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:posterior:macula", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_03", optionCode: "rpe-changes", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:posterior:macula", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_03", optionCode: "dry-amd", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:posterior:macula", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_03", optionCode: "epiretinal-membrane-erm", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:posterior:macula", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_03", optionCode: "pigment-mottling", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:posterior:macula", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_03", optionCode: "wet-amd", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:posterior:macula", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_03", optionCode: "cnvm", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:posterior:macula", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_03", optionCode: "geographic-atrophy", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:posterior:macula", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_03", optionCode: "lamellar-macular-hole", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:posterior:macula", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_03", optionCode: "macular-hole", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:posterior:macula", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_03", optionCode: "macular-pseudohole", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:posterior:macula", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_03", optionCode: "cystoid-macular-edema-cme", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:posterior:macula", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_03", optionCode: "diabetic-macular-edema", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:posterior:macula", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_03", optionCode: "vitreomacular-traction", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:posterior:macula", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_03", optionCode: "subretinal-fluid", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:posterior:macula", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_03", optionCode: "macular-edema", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:posterior:macula", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_03", optionCode: "pigment-clumping", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:posterior:vessels", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_04", optionCode: "av-nicking", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:posterior:vessels", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_04", optionCode: "arteriolar-attenuation", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:posterior:vessels", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_04", optionCode: "tortuosity", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:posterior:vessels", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_04", optionCode: "av-crossing-changes", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:posterior:vessels", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_04", optionCode: "sclerotic-copper-silver-wire-changes", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:posterior:vessels", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_04", optionCode: "hollenhorst-plaque", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:posterior:vessels", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_04", optionCode: "retinal-embolus", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:posterior:vessels", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_04", optionCode: "vascular-sheathing", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:posterior:vessels", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_04", optionCode: "venous-beading", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:posterior:vessels", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_04", optionCode: "neovascularization-of-the-disc-nvd", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:posterior:periphery", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_05", optionCode: "lattice-degeneration", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:posterior:periphery", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_05", optionCode: "cobblestone-paving-stone-degeneration", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:posterior:periphery", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_05", optionCode: "retinal-hole", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:posterior:periphery", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_05", optionCode: "white-without-pressure", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:posterior:periphery", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_05", optionCode: "chorioretinal-scar", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:posterior:periphery", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_05", optionCode: "retinal-tear", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:posterior:periphery", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_05", optionCode: "retinal-detachment", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:posterior:periphery", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_05", optionCode: "retinoschisis", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:posterior:periphery", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_05", optionCode: "retinal-tuft", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:posterior:periphery", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_05", optionCode: "pigmentary-changes", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:posterior:periphery", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_05", optionCode: "cystoid-degeneration", disposition: { kind: "pending" } },
  { definitionStableKey: "ocular-health:posterior:periphery", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_05", optionCode: "drusen", disposition: { kind: "proposes", entrySurface: "finding" } },
  { definitionStableKey: "ocular-health:posterior:periphery", fieldLocalCode: "CUSTOM_ABNORMAL_FINDINGS_05", optionCode: "occasional-drusen", disposition: { kind: "proposes", entrySurface: "finding" } },
] satisfies readonly FindingDispositionRegistryRow[];

export const FINDING_DISPOSITION_REGISTRY: ReadonlyMap<string, FindingDispositionRegistryRow> =
  new Map(FINDING_DISPOSITION_ROWS.map((row) => [buildFindingDispositionKey(row), row]));
