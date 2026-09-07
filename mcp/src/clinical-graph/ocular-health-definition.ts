import type { CustomFieldEntry, QualifierSeed } from "./custom-fields.js";
import {
  buildClinicalFindingDefinition,
  type ClinicalFindingDefinition,
  type ClinicalGraphProvenance,
  type DiagnosisCandidateEntry,
} from "./glaucoma-suspect.js";
import {
  buildDiagnosisCatalogSeeds,
  FAMILY_RESOLUTION_MODES,
  validateFamilyResolutionModes,
} from "./diagnosis-catalog-seeds.js";

export const ANTERIOR_OCULAR_HEALTH_PREFIX = "ocular-health:anterior:";
export const POSTERIOR_OCULAR_HEALTH_PREFIX = "ocular-health:posterior:";

export interface FindingSeed {
  key: string;
  display: string;
  qualifiers?: QualifierSeed[];
}

export interface StructureSeed {
  key: string;
  display: string;
  normalTemplate: string;
  sheetLabel?: string;
  priority: Array<string | FindingSeed>;
  additional: Array<string | FindingSeed>;
  allowDeferred?: boolean;
  nested?: Array<{ parent: string; children: string[] }>;
  gradeFields?: Array<
    | { display: string; kind: "select"; options: string[]; slugOptionCodes?: boolean }
    | { display: string; kind: "number"; min: number; max: number; step: number; unit?: CustomFieldEntry["unit"] }
  >;
}

const ANTERIOR_STRUCTURES: StructureSeed[] = [
  {
    key: "periocular-adnexa",
    display: "Periocular Adnexa",
    normalTemplate: "Periorbital region normal; no lesions, edema, or asymmetry.",
    sheetLabel: "Periorbital region normal",
    priority: ["dermatochalasis", "periorbital edema"],
    additional: ["facial asymmetry", "brow ptosis", "proptosis", "enophthalmos", "preauricular node", "orbital mass", "ecchymosis", "dermatitis"],
  },
  {
    key: "lids-lashes",
    display: "Lids & Lashes",
    normalTemplate: "Normal lid position and lashes; no MGD, blepharitis, or lesions.",
    sheetLabel: "Normal lid position and lashes",
    priority: ["meibomian gland dysfunction", "chalazion", "trichiasis"],
    additional: ["hordeolum", "ptosis", "ectropion", "entropion", "madarosis", "lagophthalmos", "lid lesion", "dermatochalasis", "floppy eyelid", "telangiectasia", "lid margin keratinization", "poliosis"],
    nested: [
      { parent: "Demodex", children: ["Flaking", "Collarettes"] },
      { parent: "Anterior Blepharitis", children: ["Seborrheic", "Ulcerative"] },
      { parent: "Posterior Blepharitis", children: ["Inflammation", "Rosacea", "Vascularization"] },
    ],
  },
  {
    key: "palpebral-conjunctiva",
    display: "Palpebral Conjunctiva",
    normalTemplate: "Palpebral conjunctiva normal; no papillae or follicles.",
    sheetLabel: "Smooth and pink",
    priority: ["papillae", "follicles", "giant papillae (GPC)"],
    additional: ["concretions", "symblepharon", "scarring", "membrane/pseudomembrane", "hyperemia"],
    allowDeferred: true,
  },
  {
    key: "conjunctiva",
    display: "Conjunctiva",
    normalTemplate: "White and quiet; no injection or discharge.",
    sheetLabel: "White and quiet",
    priority: ["injection", "pinguecula", pterygiumFinding("pterygium", "pterygium"), "chemosis"],
    additional: ["subconjunctival hemorrhage", "nevus", "pigmentation", "concretion", "conjunctivochalasis", "episcleritis", "scleritis", "phlyctenule", "lymphangiectasia", "scleral thinning", "nodule"],
  },
  {
    key: "tear-film",
    display: "Tear Film",
    normalTemplate: "Adequate tear film; normal meniscus and break-up.",
    sheetLabel: "Adequate film and meniscus",
    priority: ["reduced tear meniscus", "rapid TBUT", "debris in tear film"],
    additional: ["mucus strands", { key: "foam", display: "foam/frothing" }],
    gradeFields: [
      { display: "TBUT", kind: "number", min: 0, max: 60, step: 1, unit: "s" },
      {
        display: "TBUT method",
        kind: "select",
        options: ["Fluorescein", "Non-invasive"],
        slugOptionCodes: true,
      },
    ],
  },
  {
    key: "cornea",
    display: "Cornea",
    normalTemplate: "Clear, no staining; normal thickness and clarity.",
    sheetLabel: "Clear and compact",
    priority: [
      cornealStainingFinding(),
      "dry eye keratopathy",
      {
        key: "arcus",
        display: "arcus",
        qualifiers: [{
          kind: "enum",
          key: "extent",
          display: "Extent",
          options: ["Inferior", "Superior", "Partial", "Complete (360°)"].map((display) => ({
            code: optionCode(display),
            display,
          })),
        }],
      },
      "scar",
      keratoconusFinding(),
      sourcedCornealGradedFinding("guttata", "guttata", [
        "1+ (central/paracentral nonconfluent guttae)",
        "2+ (1–2 mm confluent central/paracentral guttae)",
        "3+ (>2–5 mm confluent central/paracentral guttae)",
        "4+ (>5 mm confluent central/paracentral guttae, with or without edema)",
      ], "Modified Krachmer (ODOS 1–4+ collapse)"),
      pterygiumFinding("pterygium-encroaching", "pterygium (encroaching)"),
      sourcedCornealGradedFinding("neovascularization", "neovascularization", [
        "1+ (<1.0 mm vessel penetration)",
        "2+ (≥1.0 to <1.5 mm vessel penetration)",
        "3+ (≥1.5 to 2.0 mm vessel penetration)",
        "4+ (>2.0 mm vessel penetration)",
      ]),
      sourcedCornealGradedFinding("infiltrate", "infiltrate", [
        "1+ (one faint peripheral infiltrate without staining)",
        "2+ (a few faint infiltrates)",
        "3+ (multiple dense infiltrates)",
        "4+ (marked infiltrates with overlying staining)",
      ]),
    ],
    additional: [
      "abrasion",
      "dendrite",
      sourcedCornealGradedFinding("edema", "edema", [
        "1+ (barely discernible localized epithelial/subepithelial or stromal haze; 1–20 microcysts)",
        "2+ (faint definite localized/generalized epithelial/stromal haze; 21–50 microcysts)",
        "3+ (significant localized/generalized epithelial/stromal haze; 51–100 microcysts)",
        "4+ (widespread epithelial/stromal clouding, coalescent bullae, or striae; >100 microcysts or bullae)",
      ]),
      "foreign body",
      "filaments",
      "erosion",
      "RCES (recurrent erosion)",
      "EBMD (map-dot-fingerprint)",
      "Fuchs' endothelial dystrophy",
      "band keratopathy",
      "Salzmann's nodule",
      "keratic precipitates",
      "ulcer",
      "haze",
      "opacification",
      "pannus",
      "nodules",
      "phlyctenule",
      "Descemet folds",
      "Krukenberg spindle",
      "iron line (Hudson-Stahli/Stocker's/Fleischer's)",
      "Vogt striae",
      "vortex keratopathy (verticillata)",
      "Thygeson's SPK",
      "lipid keratopathy",
      "Mooren's ulcer",
      "Terrien's marginal degeneration",
      "peripheral thinning",
      "central thinning",
      "hydrops",
      "pigment on endothelium",
    ],
    gradeFields: [
      {
        display: "Vital dye",
        kind: "select",
        options: ["Fluorescein"],
        slugOptionCodes: true,
      },
    ],
  },
  {
    key: "anterior-chamber",
    display: "Anterior Chamber",
    normalTemplate: "Deep and quiet; no cells or flare.",
    sheetLabel: "Deep and quiet",
    priority: [
      sunDerivedGradedFinding("cells", "cells", [
        "Trace (1–5)",
        "1+ (6–15)",
        "2+ (16–25)",
        "3+ (26–50)",
        "4+ (>50)",
      ]),
      sunDerivedGradedFinding("flare", "flare", [
        "1+ (faint)",
        "2+ (moderate; iris and lens clear)",
        "3+ (marked; iris and lens hazy)",
        "4+ (intense; fibrin or plastic aqueous)",
      ]),
      "shallow AC",
    ],
    additional: ["hyphema", "hypopyon", "peripheral anterior synechiae", "pigment", "narrow angle (by exam)"],
    gradeFields: [{
      display: "Van Herick",
      kind: "select",
      options: ["Grade 4 (wide open)", "Grade 3", "Grade 2", "Grade 1 (narrow)", "Grade 0 (closed)"],
      slugOptionCodes: true,
    }],
  },
  {
    key: "iris",
    display: "Iris",
    normalTemplate: "Flat and intact; round reactive pupil.",
    sheetLabel: "Flat and intact",
    priority: ["nevus", "transillumination defect", "posterior synechiae"],
    additional: ["atrophy", "neovascularization (rubeosis)", "coloboma", "heterochromia", "iridodonesis", "nodules", "sphincter tears", "plateau iris", "irregular pupil", "sectoral atrophy", "pseudoexfoliation material on pupil margin"],
  },
  {
    key: "lens",
    display: "Lens",
    normalTemplate: "Clear; no cataract.",
    sheetLabel: "Clear",
    priority: [
      gradedLensFinding("nuclear-sclerosis", "nuclear sclerosis", [{
        kind: "graded",
        key: "colour",
        display: "Colour",
        options: [
          "1+ (pale yellow)",
          "2+ (yellow)",
          "3+ (dark yellow/amber)",
          "4+ (dark brown/black; brunescent)",
        ],
        scheme: "Shirao; Sharma; LOCS III two-axis architecture",
      }]),
      gradedLensFinding("cortical-cataract", "cortical cataract"),
      gradedLensFinding("posterior-subcapsular-psc", "posterior subcapsular (PSC)"),
      "pseudophakia (PCIOL)",
      gradedLensFinding("posterior-capsular-opacification-pco", "posterior capsular opacification (PCO) (after cataract)"),
      gradedLensFinding("mixed", "Mixed"),
    ],
    additional: ["anterior polar", "posterior polar", gradedLensFinding("anterior-subcapsular", "anterior subcapsular"), "mature cataract", "pseudophakia (ACIOL)", "aphakia", "phacodonesis", "pseudoexfoliation", "dislocated lens/IOL", "IOL deposits", "polychromatic (Christmas-tree)"],
  },
];

// Source: performance-od/core/operations/open-source-od/segments/ocular-health-finding-definition.md § P1/P3-P6.
const POSTERIOR_STRUCTURES: StructureSeed[] = [
  {
    key: "vitreous",
    display: "Vitreous",
    normalTemplate: "No vitreal hemorrhage, cells, or pigment.",
    sheetLabel: "Optically clear",
    priority: ["posterior vitreous detachment (PVD)", "syneresis", "floaters"],
    additional: ["asteroid hyalosis", "vitreous hemorrhage", "vitreous cells", "Shafer's sign (tobacco dust)", "vitreous opacities", "anterior hyaloid", "synchysis"],
  },
  {
    key: "fundus",
    display: "Fundus",
    normalTemplate: "Normal retinal appearance; healthy background, no lesions.",
    sheetLabel: "Healthy background",
    priority: [npdrFinding(), "hypertensive retinopathy", "dot/blot hemorrhage", "hard exudate", "cotton-wool spot", "choroidal nevus", "chorioretinal scar"],
    additional: ["microaneurysm", pdrFinding(), "neovascularization elsewhere (NVE)", "preretinal hemorrhage", "choroidal lesion", "RPE atrophy", "Roth spot", "myelinated nerve fiber", "drusen", "occasional drusen"],
  },
  {
    key: "macula",
    display: "Macula",
    normalTemplate: "Healthy foveal reflex; no drusen, edema, or exudate.",
    sheetLabel: "Healthy foveal reflex",
    priority: ["drusen", "RPE changes", "dry AMD", "epiretinal membrane (ERM)", "pigment mottling"],
    additional: ["wet AMD", "CNVM", "geographic atrophy", macularHoleFinding(), "lamellar macular hole", "macular pseudohole", "cystoid macular edema (CME)", "diabetic macular edema", "vitreomacular traction", "subretinal fluid", "macular edema", "pigment clumping"],
  },
  {
    key: "vessels",
    display: "Vessels",
    normalTemplate: "Normal caliber without tortuosity, AV nicking, or crossing changes.",
    sheetLabel: "Normal caliber and course",
    priority: ["AV nicking", "arteriolar attenuation", "tortuosity"],
    additional: ["AV crossing changes", "sclerotic (copper/silver-wire) changes", "Hollenhorst plaque", "retinal embolus", "vascular sheathing", "venous beading", "neovascularization of the disc (NVD)"],
    gradeFields: [{ display: "A/V ratio", kind: "select", options: ["2:3", "1:2", "1:3", "1:4"], slugOptionCodes: true }],
  },
  {
    key: "periphery",
    display: "Periphery",
    normalTemplate: "Normal peripheral retina without tears, breaks, holes, or detachment.",
    sheetLabel: "Flat and attached",
    priority: ["lattice degeneration", "cobblestone/paving-stone degeneration", "retinal hole", "white-without-pressure", "chorioretinal scar"],
    additional: ["retinal tear", retinalDetachmentFinding(), "retinoschisis", "retinal tuft", "pigmentary changes", "cystoid degeneration", "operculated hole", "horseshoe tear", "drusen", "occasional drusen"],
  },
];

interface DiagnosisCandidateSeedBase {
  option: string;
  fieldDisplay?: string;
  qualifiers?: Record<string, string>;
}

type DiagnosisCandidateSeed = DiagnosisCandidateSeedBase & (
  | { diagnosisKey: string; familyGroup?: never }
  | { familyGroup: string; diagnosisKey?: never }
);

const TYPE_2_PDR_DIAGNOSIS_KEYS = [
  "t2_dr_pdr_with_dme",
  "t2_dr_pdr_trd_involving_macula",
  "t2_dr_pdr_trd_not_involving_macula",
  "t2_dr_pdr_combined_trd_rrd",
  "t2_dr_stable_pdr",
  "t2_dr_pdr_without_dme",
] as const;

function type2PdrCandidateSeeds(option: string): DiagnosisCandidateSeed[] {
  return TYPE_2_PDR_DIAGNOSIS_KEYS.map((diagnosisKey) => ({ option, diagnosisKey }));
}

const DIAGNOSIS_CANDIDATE_SEEDS: Record<string, readonly DiagnosisCandidateSeed[]> = {
  "ocular-health:anterior:palpebral-conjunctiva": [
    { option: "giant-papillae-gpc", diagnosisKey: "giant_papillary_conjunctivitis" },
  ],
  "ocular-health:anterior:lids-lashes": [
    { option: "anterior-blepharitis::ulcerative", diagnosisKey: "ulcerative_blepharitis" },
    { option: "anterior-blepharitis::seborrheic", diagnosisKey: "squamous_blepharitis" },
    { option: "posterior-blepharitis", diagnosisKey: "meibomian_gland_dysfunction" },
    { option: "meibomian-gland-dysfunction", diagnosisKey: "meibomian_gland_dysfunction" },
  ],
  "ocular-health:anterior:conjunctiva": [
    { option: "pinguecula", diagnosisKey: "pinguecula" },
    { option: "pterygium", diagnosisKey: "pterygium_central" },
    { option: "pterygium", diagnosisKey: "pterygium_peripheral_stationary" },
    { option: "pterygium", diagnosisKey: "pterygium_peripheral_progressive" },
    { option: "pterygium", diagnosisKey: "pterygium_recurrent" },
    { option: "pterygium", qualifiers: { location: "central" }, diagnosisKey: "pterygium_central" },
    { option: "pterygium", qualifiers: { location: "peripheral", progression: "stationary" }, diagnosisKey: "pterygium_peripheral_stationary" },
    { option: "pterygium", qualifiers: { location: "peripheral", progression: "progressive" }, diagnosisKey: "pterygium_peripheral_progressive" },
    { option: "pterygium", qualifiers: { location: "peripheral", progression: "recurrent" }, diagnosisKey: "pterygium_recurrent" },
  ],
  "ocular-health:anterior:tear-film": [
    { option: "reduced-tear-meniscus", diagnosisKey: "kcs_not_sjogren" },
    { option: "rapid-tbut", diagnosisKey: "kcs_not_sjogren" },
  ],
  "ocular-health:anterior:cornea": [
    { option: "keratoconus", diagnosisKey: "keratoconus_stable" },
    { option: "keratoconus", diagnosisKey: "keratoconus_unstable" },
    { option: "keratoconus", qualifiers: { stability: "stable" }, diagnosisKey: "keratoconus_stable" },
    { option: "keratoconus", qualifiers: { stability: "unstable" }, diagnosisKey: "keratoconus_unstable" },
    { option: "superficial-punctate-keratitis-spk", diagnosisKey: "kcs_not_sjogren" },
    { option: "dry-eye-keratopathy", diagnosisKey: "kcs_not_sjogren" },
    { option: "pterygium-encroaching", diagnosisKey: "pterygium_central" },
    { option: "pterygium-encroaching", diagnosisKey: "pterygium_peripheral_stationary" },
    { option: "pterygium-encroaching", diagnosisKey: "pterygium_peripheral_progressive" },
    { option: "pterygium-encroaching", diagnosisKey: "pterygium_recurrent" },
    { option: "pterygium-encroaching", qualifiers: { location: "central" }, diagnosisKey: "pterygium_central" },
    { option: "pterygium-encroaching", qualifiers: { location: "peripheral", progression: "stationary" }, diagnosisKey: "pterygium_peripheral_stationary" },
    { option: "pterygium-encroaching", qualifiers: { location: "peripheral", progression: "progressive" }, diagnosisKey: "pterygium_peripheral_progressive" },
    { option: "pterygium-encroaching", qualifiers: { location: "peripheral", progression: "recurrent" }, diagnosisKey: "pterygium_recurrent" },
  ],
  "ocular-health:anterior:anterior-chamber": [
    { option: "hyphema", diagnosisKey: "hyphema" },
    { option: "hypopyon", diagnosisKey: "hypopyon" },
    { option: "shallow-ac", diagnosisKey: "anatomical_narrow_angle" },
    { option: "narrow-angle-by-exam", diagnosisKey: "anatomical_narrow_angle" },
  ],
  "ocular-health:anterior:iris": [
    { option: "posterior-synechiae", diagnosisKey: "posterior_synechiae" },
    { option: "neovascularization-rubeosis", diagnosisKey: "iris_neovascularization" },
    { option: "pseudoexfoliation-material-on-pupil-margin", diagnosisKey: "pseudoexfoliation_lens" },
  ],
  "ocular-health:anterior:lens": [
    { option: "nuclear-sclerosis", diagnosisKey: "cataract_nuclear_sclerosis" },
    { option: "cortical-cataract", diagnosisKey: "cataract_cortical" },
    { option: "anterior-subcapsular", diagnosisKey: "cataract_anterior_subcapsular" },
    { option: "posterior-subcapsular-psc", diagnosisKey: "cataract_posterior_subcapsular" },
    { option: "mixed", diagnosisKey: "cataract_combined_forms" },
    { option: "posterior-capsular-opacification-pco", diagnosisKey: "cataract_posterior_capsular_opacification" },
    { option: "pseudophakia-pciol", diagnosisKey: "pseudophakia" },
    { option: "aphakia", diagnosisKey: "aphakia" },
    { option: "pseudoexfoliation", diagnosisKey: "pseudoexfoliation_lens" },
  ],
  "ocular-health:posterior:vitreous": [
    { option: "vitreous-hemorrhage", diagnosisKey: "vitreous_hemorrhage" },
    { option: "floaters", diagnosisKey: "vitreous_opacities" },
  ],
  "ocular-health:posterior:fundus": [
    { option: "hypertensive-retinopathy", diagnosisKey: "hypertensive_retinopathy" },
    { option: "diabetic-retinopathy-background-npdr", diagnosisKey: "t2_dr_mild_npdr_with_dme" },
    { option: "diabetic-retinopathy-background-npdr", diagnosisKey: "t2_dr_mild_npdr_without_dme" },
    { option: "diabetic-retinopathy-background-npdr", diagnosisKey: "t2_dr_moderate_npdr_with_dme" },
    { option: "diabetic-retinopathy-background-npdr", diagnosisKey: "t2_dr_moderate_npdr_without_dme" },
    { option: "diabetic-retinopathy-background-npdr", diagnosisKey: "t2_dr_severe_npdr_with_dme" },
    { option: "diabetic-retinopathy-background-npdr", diagnosisKey: "t2_dr_severe_npdr_without_dme" },
    { option: "diabetic-retinopathy-background-npdr", qualifiers: { severity: "mild", "macular-edema": "present" }, diagnosisKey: "t2_dr_mild_npdr_with_dme" },
    { option: "diabetic-retinopathy-background-npdr", qualifiers: { severity: "mild", "macular-edema": "absent" }, diagnosisKey: "t2_dr_mild_npdr_without_dme" },
    { option: "diabetic-retinopathy-background-npdr", qualifiers: { severity: "moderate", "macular-edema": "present" }, diagnosisKey: "t2_dr_moderate_npdr_with_dme" },
    { option: "diabetic-retinopathy-background-npdr", qualifiers: { severity: "moderate", "macular-edema": "absent" }, diagnosisKey: "t2_dr_moderate_npdr_without_dme" },
    { option: "diabetic-retinopathy-background-npdr", qualifiers: { severity: "severe", "macular-edema": "present" }, diagnosisKey: "t2_dr_severe_npdr_with_dme" },
    { option: "diabetic-retinopathy-background-npdr", qualifiers: { severity: "severe", "macular-edema": "absent" }, diagnosisKey: "t2_dr_severe_npdr_without_dme" },
    ...type2PdrCandidateSeeds("proliferative-diabetic-retinopathy-pdr"),
    { option: "proliferative-diabetic-retinopathy-pdr", qualifiers: { severity: "with-macular-edema" }, diagnosisKey: "t2_dr_pdr_with_dme" },
    { option: "proliferative-diabetic-retinopathy-pdr", qualifiers: { severity: "traction-rd-involving-macula" }, diagnosisKey: "t2_dr_pdr_trd_involving_macula" },
    { option: "proliferative-diabetic-retinopathy-pdr", qualifiers: { severity: "traction-rd-not-involving-macula" }, diagnosisKey: "t2_dr_pdr_trd_not_involving_macula" },
    { option: "proliferative-diabetic-retinopathy-pdr", qualifiers: { severity: "combined-traction-rhegmatogenous-rd" }, diagnosisKey: "t2_dr_pdr_combined_trd_rrd" },
    { option: "proliferative-diabetic-retinopathy-pdr", qualifiers: { severity: "stable" }, diagnosisKey: "t2_dr_stable_pdr" },
    { option: "proliferative-diabetic-retinopathy-pdr", qualifiers: { severity: "without-macular-edema" }, diagnosisKey: "t2_dr_pdr_without_dme" },
    { option: "drusen", diagnosisKey: "macular_drusen" },
    { option: "drusen", familyGroup: "nonexudative-amd" },
    // A few small occasional drusen are below AMD suspicion (AREDS category 1), so this remains leaf-only.
    { option: "occasional-drusen", diagnosisKey: "macular_drusen" },
  ],
  "ocular-health:posterior:vessels": [
    { option: "av-nicking", diagnosisKey: "hypertensive_retinopathy" },
    { option: "arteriolar-attenuation", diagnosisKey: "hypertensive_retinopathy" },
    { option: "sclerotic-copper-silver-wire-changes", diagnosisKey: "hypertensive_retinopathy" },
    ...type2PdrCandidateSeeds("neovascularization-of-the-disc-nvd"),
  ],
  "ocular-health:posterior:macula": [
    { option: "drusen", diagnosisKey: "macular_drusen" },
    { option: "drusen", familyGroup: "nonexudative-amd" },
    { option: "dry-amd", familyGroup: "nonexudative-amd" },
    { option: "wet-amd", familyGroup: "exudative-amd" },
    { option: "epiretinal-membrane-erm", diagnosisKey: "epiretinal_membrane" },
    { option: "macular-hole", diagnosisKey: "macular_hole" },
    { option: "lamellar-macular-hole", diagnosisKey: "macular_hole" },
    { option: "macular-pseudohole", diagnosisKey: "macular_hole" },
    { option: "cystoid-macular-edema-cme", diagnosisKey: "cme_following_cataract_surgery" },
    { option: "cystoid-macular-edema-cme", diagnosisKey: "cystoid_macular_degeneration" },
    { option: "cystoid-macular-edema-cme", diagnosisKey: "retinal_edema" },
    { option: "geographic-atrophy", familyGroup: "nonexudative-amd" },
    { option: "cnvm", familyGroup: "exudative-amd" },
  ],
  "ocular-health:posterior:periphery": [
    { option: "horseshoe-tear", diagnosisKey: "retinal_horseshoe_tear" },
    { option: "retinal-tear", diagnosisKey: "retinal_horseshoe_tear" },
    { option: "retinal-hole", diagnosisKey: "retinal_round_hole" },
    { option: "operculated-hole", diagnosisKey: "retinal_round_hole" },
    { option: "retinoschisis", diagnosisKey: "retinoschisis" },
    { option: "retinal-detachment", diagnosisKey: "retinal_detachment_single_break" },
    { option: "drusen", diagnosisKey: "macular_drusen" },
    { option: "drusen", familyGroup: "nonexudative-amd" },
    // A few small occasional drusen are below AMD suspicion (AREDS category 1), so this remains leaf-only.
    { option: "occasional-drusen", diagnosisKey: "macular_drusen" },
  ],
  "dry-eye:markers": [
    {
      fieldDisplay: "Inflammatory result",
      option: "positive",
      diagnosisKey: "kcs_not_sjogren",
    },
  ],
  "dry-eye:gland-function": [
    {
      fieldDisplay: "Expressibility",
      option: "reduced",
      diagnosisKey: "meibomian_gland_dysfunction",
    },
    {
      fieldDisplay: "Expressibility",
      option: "non-expressible",
      diagnosisKey: "meibomian_gland_dysfunction",
    },
    {
      fieldDisplay: "Secretion quality",
      option: "granular",
      diagnosisKey: "meibomian_gland_dysfunction",
    },
    {
      fieldDisplay: "Secretion quality",
      option: "inspissated",
      diagnosisKey: "meibomian_gland_dysfunction",
    },
  ],
  "dry-eye:conjunctival-staining": [
    ...["grade-1", "grade-2", "grade-3", "grade-4"].map((option) => ({
      fieldDisplay: "Conjunctival staining grade (grading scheme provisional)",
      option,
      diagnosisKey: "kcs_not_sjogren",
    })),
  ],
  "dry-eye:staging": [
    {
      fieldDisplay: "Subtype",
      option: "aqueous-deficient",
      diagnosisKey: "kcs_not_sjogren",
    },
    {
      fieldDisplay: "Subtype",
      option: "evaporative-mgd",
      diagnosisKey: "meibomian_gland_dysfunction",
    },
    {
      fieldDisplay: "Subtype",
      option: "mixed",
      diagnosisKey: "kcs_not_sjogren",
    },
    {
      fieldDisplay: "Subtype",
      option: "mixed",
      diagnosisKey: "meibomian_gland_dysfunction",
    },
  ],
};

export function buildAnteriorOcularHealthDefinitions(
  provenance: ClinicalGraphProvenance,
): ClinicalFindingDefinition[] {
  return buildOcularHealthDefinitions(ANTERIOR_STRUCTURES, ANTERIOR_OCULAR_HEALTH_PREFIX, provenance);
}

export function buildPosteriorOcularHealthDefinitions(
  provenance: ClinicalGraphProvenance,
): ClinicalFindingDefinition[] {
  return buildOcularHealthDefinitions(POSTERIOR_STRUCTURES, POSTERIOR_OCULAR_HEALTH_PREFIX, provenance);
}

export function buildOcularHealthDefinitions(
  structures: StructureSeed[],
  prefix: string,
  provenance: ClinicalGraphProvenance,
): ClinicalFindingDefinition[] {
  return structures.map((structure, structureIndex) => {
    const stableKey = `${prefix}${structure.key}`;
    const fields = [
      abnormalField(structure, structureIndex),
      ...(structure.gradeFields ?? []).map((grade, gradeIndex) => gradeField(grade, gradeIndex)),
    ];
    const definition = buildClinicalFindingDefinition({
      stableKey,
      display: structure.display,
      sectionKey: stableKey,
      anatomyTarget: structure.key === "cornea" ? "cornea" : "eye",
      valueSchema: {
        type: "ocular-health-structure",
        perEye: true,
        fields: Object.fromEntries(fields.map((field) => [field.localCode, field])),
      },
      normalSemantics: {
        template: structure.normalTemplate,
        ...(structure.sheetLabel ? { sheetLabel: structure.sheetLabel } : {}),
        allowDeferred: structure.allowDeferred === true,
      },
      sourceStatus: "verified-seed",
      allowDiagnosisMapping: false,
      notBillReady: true,
      provenance,
    });
    return applyOcularHealthDiagnosisCandidates(definition);
  });
}

export function applyOcularHealthDiagnosisCandidates(
  definition: ClinicalFindingDefinition,
): ClinicalFindingDefinition {
  const seeds = DIAGNOSIS_CANDIDATE_SEEDS[definition.stableKey];
  if (!seeds) return definition;
  validateFamilyResolutionModes(
    buildDiagnosisCatalogSeeds(),
    FAMILY_RESOLUTION_MODES,
    seeds.flatMap((seed) => seed.familyGroup !== undefined ? [seed.familyGroup] : []),
  );
  const fields = Object.values(
    definition.valueSchema.fields as Record<string, CustomFieldEntry>,
  );
  const diagnosisCandidates: DiagnosisCandidateEntry[] = seeds.map((seed, index) => {
    const field = fields.find((candidate) =>
      candidate.display === (seed.fieldDisplay ?? "Abnormal findings")
    );
    if (!field) {
      throw new Error(
        `Finding definition ${definition.stableKey} has no ${seed.fieldDisplay ?? "Abnormal findings"} field.`,
      );
    }
    const trigger: DiagnosisCandidateEntry["trigger"] = seed.qualifiers
      ? { kind: "qualifier", field: field.localCode, option: seed.option, qualifiers: seed.qualifiers }
      : { kind: "option", field: field.localCode, anyOf: [seed.option] };
    const id = `SEED_${(seed.diagnosisKey ?? seed.familyGroup!).toUpperCase()}_${index + 1}`;
    return seed.diagnosisKey !== undefined
      ? { id, diagnosisKey: seed.diagnosisKey, trigger, priority: true, origin: "seed", active: true }
      : { id, familyGroup: seed.familyGroup!, trigger, priority: true, origin: "seed", active: true };
  });
  return {
    ...definition,
    allowDiagnosisMapping: true,
    diagnosisCandidates,
  };
}

function pterygiumFinding(key: string, display: string): FindingSeed {
  return {
    key,
    display,
    qualifiers: [
      { kind: "enum", key: "location", display: "Location", options: [{ code: "central", display: "Central" }, { code: "peripheral", display: "Peripheral" }] },
      { kind: "enum", key: "progression", display: "Progression", options: [{ code: "stationary", display: "Stationary" }, { code: "progressive", display: "Progressive" }, { code: "recurrent", display: "Recurrent" }] },
    ],
  };
}

function keratoconusFinding(): FindingSeed {
  return {
    key: "keratoconus",
    display: "keratoconus",
    qualifiers: [{ kind: "enum", key: "stability", display: "Stability", options: [{ code: "stable", display: "Stable" }, { code: "unstable", display: "Unstable" }] }],
  };
}

function cornealStainingFinding(): FindingSeed {
  return {
    key: "superficial-punctate-keratitis-spk",
    display: "superficial punctate keratitis (SPK)",
    qualifiers: [
      {
        kind: "graded",
        key: "grade",
        display: "Corneal staining grade (FDA Appendix C; Efron-corroborated)",
        options: ["Grade 1", "Grade 2", "Grade 3", "Grade 4"],
        scheme: "FDA Appendix C; Efron-corroborated",
      },
      {
        kind: "enum",
        key: "zone",
        display: "Corneal staining zone",
        options: ["Central", "Nasal", "Temporal", "Superior", "Inferior", "Diffuse"].map((display) => ({
          code: optionCode(display),
          display,
        })),
      },
    ],
  };
}

function sourcedCornealGradedFinding(
  key: string,
  display: string,
  options: string[],
  scheme = "FDA Appendix C; Efron-corroborated",
): FindingSeed {
  return {
    key,
    display,
    qualifiers: [{ kind: "graded", key: "grade", display: "Grade", options, scheme }],
  };
}

function gradedLensFinding(
  key: string,
  display: string,
  additionalQualifiers: QualifierSeed[] = [],
): FindingSeed {
  return {
    key,
    display,
    qualifiers: [{
      kind: "graded",
      key: "grade",
      display: "Grade",
      options: ["1+", "2+", "3+", "4+"],
      scheme: "Operator-ruled ODOS 1–4+ present-finding scale (2026-08-09)",
    }, ...additionalQualifiers],
  };
}

function sunDerivedGradedFinding(key: string, display: string, options: string[]): FindingSeed {
  return {
    key,
    display,
    qualifiers: [{
      kind: "graded",
      key: "grade",
      display: "Grade",
      options,
      scheme: "SUN-derived (ODOS present-finding scale)",
    }],
  };
}

function retinalDetachmentFinding(): FindingSeed {
  return {
    key: "retinal-detachment",
    display: "retinal detachment",
    qualifiers: [{
      kind: "enum",
      key: "macula-status",
      display: "Macula",
      options: [
        { code: "macula-on", display: "Macula on" },
        { code: "macula-off", display: "Macula off" },
      ],
    }],
  };
}

function macularHoleFinding(): FindingSeed {
  return {
    key: "macular-hole",
    display: "macular hole",
    qualifiers: [{
      kind: "enum",
      key: "stage",
      display: "Gass stage",
      options: [
        { code: "stage-1", display: "Stage I (impending hole; yellow spot or ring, no vitreofoveal separation)" },
        { code: "stage-2", display: "Stage II (small full-thickness hole, <400 µm)" },
        { code: "stage-3", display: "Stage III (full-thickness hole, ≥400 µm, without complete PVD)" },
        { code: "stage-4", display: "Stage IV (full-thickness hole with complete PVD)" },
      ],
    }],
  };
}

function npdrFinding(): FindingSeed {
  return {
    key: "diabetic-retinopathy-background-npdr",
    display: "diabetic retinopathy (background/NPDR)",
    qualifiers: [
      { kind: "enum", key: "severity", display: "Severity", options: [{ code: "mild", display: "Mild" }, { code: "moderate", display: "Moderate" }, { code: "severe", display: "Severe" }] },
      { kind: "enum", key: "macular-edema", display: "Macular edema", options: [{ code: "present", display: "Present" }, { code: "absent", display: "Absent" }] },
    ],
  };
}

function pdrFinding(): FindingSeed {
  return {
    key: "proliferative-diabetic-retinopathy-pdr",
    display: "proliferative diabetic retinopathy (PDR)",
    qualifiers: [{
      kind: "enum",
      key: "severity",
      display: "Severity",
      options: [
        { code: "with-macular-edema", display: "With macular edema" },
        { code: "traction-rd-involving-macula", display: "Traction RD involving the macula" },
        { code: "traction-rd-not-involving-macula", display: "Traction RD not involving the macula" },
        { code: "combined-traction-rhegmatogenous-rd", display: "Combined traction + rhegmatogenous RD" },
        { code: "stable", display: "Stable" },
        { code: "without-macular-edema", display: "Without macular edema" },
      ],
    }],
  };
}

function gradeField(
  grade: NonNullable<StructureSeed["gradeFields"]>[number],
  gradeIndex: number,
): CustomFieldEntry {
  const base = {
    localCode: `CUSTOM_GRADE_${optionCode(grade.display).replaceAll("-", "_").toUpperCase()}`,
    display: grade.display,
    origin: "practice" as const,
    order: gradeIndex + 1,
    active: true,
  };
  return grade.kind === "select"
    ? {
        ...base,
        valueType: "select",
        options: grade.options.map((display) => ({
          code: grade.slugOptionCodes ? optionCode(display) : display,
          display,
          active: true,
        })),
      }
    : {
        ...base,
        valueType: "number",
        min: grade.min,
        max: grade.max,
        step: grade.step,
        ...(grade.unit ? { unit: grade.unit } : {}),
      };
}

function abnormalField(structure: StructureSeed, structureIndex: number): CustomFieldEntry {
  const nested = structure.nested ?? [];
  const parentLabels = new Set(nested.map((entry) => entry.parent.toLowerCase()));
  const base = [...structure.priority, ...structure.additional]
    .filter((finding) => !parentLabels.has(findingDisplay(finding).toLowerCase()))
    .map((finding, index) => ({
      code: findingCode(finding),
      display: findingDisplay(finding),
      active: true,
      priority: index < structure.priority.length,
      ...(typeof finding === "string" || !finding.qualifiers
        ? {}
        : { qualifiers: finding.qualifiers }),
    }));
  const nestedOptions = nested.flatMap(({ parent, children }) => {
    const parentCode = optionCode(parent);
    return [
      { code: parentCode, display: parent, active: true, priority: true },
      ...children.map((display) => ({
        code: `${parentCode}::${optionCode(display)}`,
        display,
        active: true,
        parentCode,
        priority: true,
      })),
    ];
  });
  return {
    localCode: `CUSTOM_ABNORMAL_FINDINGS_${String(structureIndex + 1).padStart(2, "0")}`,
    display: "Abnormal findings",
    origin: "practice",
    valueType: "multi-select",
    options: [...nestedOptions, ...base],
    order: 0,
    active: true,
  };
}

function findingDisplay(finding: string | FindingSeed): string {
  return typeof finding === "string" ? finding : finding.display;
}

function findingCode(finding: string | FindingSeed): string {
  if (typeof finding === "string") return optionCode(finding);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(finding.key)) {
    throw new Error(`Ocular-health finding key must be a slug: ${finding.key}.`);
  }
  return finding.key;
}

function optionCode(display: string): string {
  return display.normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}
