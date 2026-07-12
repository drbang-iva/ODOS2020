import type { CustomFieldEntry } from "./custom-fields.js";
import {
  buildClinicalFindingDefinition,
  type ClinicalFindingDefinition,
  type ClinicalGraphProvenance,
  type DiagnosisCandidateEntry,
} from "./glaucoma-suspect.js";

export const ANTERIOR_OCULAR_HEALTH_PREFIX = "ocular-health:anterior:";
export const POSTERIOR_OCULAR_HEALTH_PREFIX = "ocular-health:posterior:";

interface StructureSeed {
  key: string;
  display: string;
  normalTemplate: string;
  priority: string[];
  additional: string[];
  allowDeferred?: boolean;
  nested?: Array<{ parent: string; children: string[] }>;
  gradeFields?: Array<{ display: string; options: string[] }>;
}

const ANTERIOR_STRUCTURES: StructureSeed[] = [
  {
    key: "periocular-adnexa",
    display: "Periocular Adnexa",
    normalTemplate: "Periorbital region normal; no lesions, edema, or asymmetry.",
    priority: ["dermatochalasis", "periorbital edema"],
    additional: ["facial asymmetry", "brow ptosis", "proptosis", "enophthalmos", "preauricular node", "orbital mass", "ecchymosis", "dermatitis"],
  },
  {
    key: "lids-lashes",
    display: "Lids & Lashes",
    normalTemplate: "Normal lid position and lashes; no MGD, blepharitis, or lesions.",
    priority: ["blepharitis", "meibomian gland dysfunction", "chalazion"],
    additional: ["hordeolum", "ptosis", "ectropion", "entropion", "trichiasis", "madarosis", "lagophthalmos", "lid lesion", "dermatochalasis", "floppy eyelid", "telangiectasia", "lid margin keratinization", "poliosis"],
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
    priority: ["papillae", "follicles", "giant papillae (GPC)"],
    additional: ["concretions", "symblepharon", "scarring", "membrane/pseudomembrane", "hyperemia"],
    allowDeferred: true,
  },
  {
    key: "conjunctiva",
    display: "Conjunctiva",
    normalTemplate: "White and quiet; no injection or discharge.",
    priority: ["injection", "pinguecula", "pterygium", "chemosis"],
    additional: ["subconjunctival hemorrhage", "follicles", "nevus", "pigmentation", "concretion", "conjunctivochalasis", "episcleritis", "scleritis", "phlyctenule", "lymphangiectasia", "scleral injection", "scleral thinning", "nodule"],
  },
  {
    key: "tear-film",
    display: "Tear Film",
    normalTemplate: "Adequate tear film; normal meniscus and break-up.",
    priority: ["reduced tear meniscus", "rapid TBUT", "debris in tear film"],
    additional: ["mucus strands", "foam", "increased/decreased lake", "frothing"],
  },
  {
    key: "cornea",
    display: "Cornea",
    normalTemplate: "Clear, no staining; normal thickness and clarity.",
    priority: ["superficial punctate keratitis (SPK)", "corneal staining", "dry eye keratopathy", "arcus", "scar", "keratoconus", "guttata", "pterygium (encroaching)", "neovascularization", "infiltrate"],
    additional: ["abrasion", "dendrite", "edema", "foreign body", "filaments", "erosion", "RCES (recurrent erosion)", "EBMD (map-dot-fingerprint)", "Fuchs' endothelial dystrophy", "band keratopathy", "Salzmann's nodule", "keratic precipitates", "ulcer", "haze", "opacification", "pannus", "nodules", "phlyctenule", "Descemet folds", "Krukenberg spindle", "iron line (Hudson-Stahli/Stocker's/Fleischer's)", "Vogt striae", "vortex keratopathy (verticillata)", "Thygeson's SPK", "lipid keratopathy", "Mooren's ulcer", "Terrien's marginal degeneration", "peripheral thinning", "central thinning", "hydrops", "pigment on endothelium"],
  },
  {
    key: "anterior-chamber",
    display: "Anterior Chamber",
    normalTemplate: "Deep and quiet; no cells or flare.",
    priority: ["cells", "flare", "shallow AC"],
    additional: ["hyphema", "hypopyon", "peripheral anterior synechiae", "pigment", "narrow angle (by exam)"],
  },
  {
    key: "iris",
    display: "Iris",
    normalTemplate: "Flat and intact; round reactive pupil.",
    priority: ["nevus", "transillumination defect", "posterior synechiae"],
    additional: ["atrophy", "neovascularization (rubeosis)", "coloboma", "heterochromia", "iridodonesis", "nodules", "sphincter tears", "plateau iris", "irregular pupil", "sectoral atrophy", "pseudoexfoliation material on pupil margin"],
  },
  {
    key: "lens",
    display: "Lens",
    normalTemplate: "Clear; no cataract.",
    priority: ["nuclear sclerosis", "cortical cataract", "posterior subcapsular (PSC)", "pseudophakia (PCIOL)", "posterior capsular opacification (PCO)"],
    additional: ["anterior polar", "posterior polar", "anterior subcapsular", "brunescent", "mature cataract", "pseudophakia (ACIOL)", "aphakia", "phacodonesis", "pseudoexfoliation", "dislocated lens/IOL", "IOL deposits", "polychromatic (Christmas-tree)"],
  },
];

// Source: performance-od/core/operations/open-source-od/segments/ocular-health-finding-definition.md § P1/P3-P6.
const POSTERIOR_STRUCTURES: StructureSeed[] = [
  {
    key: "vitreous",
    display: "Vitreous",
    normalTemplate: "No vitreal hemorrhage, cells, or pigment.",
    priority: ["posterior vitreous detachment (PVD)", "syneresis", "floaters"],
    additional: ["asteroid hyalosis", "vitreous hemorrhage", "vitreous cells", "Shafer's sign (tobacco dust)", "vitreous opacities", "anterior hyaloid", "synchysis"],
  },
  {
    key: "fundus",
    display: "Fundus",
    normalTemplate: "Normal retinal appearance; healthy background, no lesions.",
    priority: ["diabetic retinopathy (background/NPDR)", "hypertensive retinopathy", "dot/blot hemorrhage", "hard exudate", "cotton-wool spot", "choroidal nevus", "chorioretinal scar"],
    additional: ["microaneurysm", "proliferative diabetic retinopathy (PDR)", "neovascularization elsewhere (NVE)", "preretinal hemorrhage", "choroidal lesion", "RPE atrophy", "Roth spot", "myelinated nerve fiber", "drusen", "occasional drusen"],
  },
  {
    key: "macula",
    display: "Macula",
    normalTemplate: "Healthy foveal reflex; no drusen, edema, or exudate.",
    priority: ["drusen", "RPE changes", "dry AMD", "epiretinal membrane (ERM)", "pigment mottling"],
    additional: ["wet AMD", "CNVM", "geographic atrophy", "macular hole (full/lamellar)", "cystoid macular edema (CME)", "diabetic macular edema", "vitreomacular traction", "subretinal fluid", "macular edema", "pigment clumping"],
  },
  {
    key: "vessels",
    display: "Vessels",
    normalTemplate: "Normal caliber without tortuosity, AV nicking, or crossing changes.",
    priority: ["AV nicking", "arteriolar attenuation", "tortuosity"],
    additional: ["AV crossing changes", "sclerotic (copper/silver-wire) changes", "Hollenhorst plaque", "retinal embolus", "vascular sheathing", "venous beading", "neovascularization of the disc (NVD)"],
    gradeFields: [{ display: "A/V ratio", options: ["2:3", "1:2", "1:3", "1:4"] }],
  },
  {
    key: "periphery",
    display: "Periphery",
    normalTemplate: "Normal peripheral retina without tears, breaks, holes, or detachment.",
    priority: ["lattice degeneration", "cobblestone/paving-stone degeneration", "retinal hole", "white-without-pressure", "chorioretinal scar"],
    additional: ["retinal tear", "retinal detachment", "retinoschisis", "retinal tuft", "pigmentary changes", "cystoid degeneration", "operculated hole", "horseshoe tear", "drusen", "occasional drusen"],
  },
];

interface DiagnosisCandidateSeed {
  option: string;
  diagnosisKey: string;
}

const DIAGNOSIS_CANDIDATE_SEEDS: Record<string, readonly DiagnosisCandidateSeed[]> = {
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
  ],
  "ocular-health:anterior:tear-film": [
    { option: "reduced-tear-meniscus", diagnosisKey: "kcs_not_sjogren" },
    { option: "rapid-tbut", diagnosisKey: "kcs_not_sjogren" },
  ],
  "ocular-health:anterior:cornea": [
    { option: "keratoconus", diagnosisKey: "keratoconus_stable" },
    { option: "keratoconus", diagnosisKey: "keratoconus_unstable" },
    { option: "keratoconus", diagnosisKey: "keratoconus_unspecified_stability" },
    { option: "superficial-punctate-keratitis-spk", diagnosisKey: "kcs_not_sjogren" },
    { option: "dry-eye-keratopathy", diagnosisKey: "kcs_not_sjogren" },
    { option: "pterygium-encroaching", diagnosisKey: "pterygium_central" },
    { option: "pterygium-encroaching", diagnosisKey: "pterygium_peripheral_stationary" },
    { option: "pterygium-encroaching", diagnosisKey: "pterygium_peripheral_progressive" },
    { option: "pterygium-encroaching", diagnosisKey: "pterygium_recurrent" },
  ],
  "ocular-health:posterior:fundus": [
    { option: "hypertensive-retinopathy", diagnosisKey: "hypertensive_retinopathy" },
  ],
  "ocular-health:posterior:periphery": [
    { option: "horseshoe-tear", diagnosisKey: "retinal_horseshoe_tear" },
    { option: "retinal-tear", diagnosisKey: "retinal_horseshoe_tear" },
    { option: "retinal-hole", diagnosisKey: "retinal_round_hole" },
    { option: "operculated-hole", diagnosisKey: "retinal_round_hole" },
    { option: "retinoschisis", diagnosisKey: "retinoschisis" },
    { option: "retinal-detachment", diagnosisKey: "retinal_detachment_single_break" },
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

function buildOcularHealthDefinitions(
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
        allowDeferred: structure.allowDeferred === true,
      },
      sourceStatus: "verified-seed",
      allowDiagnosisMapping: false,
      notBillReady: true,
      provenance,
    });
    const seeds = DIAGNOSIS_CANDIDATE_SEEDS[stableKey];
    if (!seeds) return definition;
    return {
      ...definition,
      allowDiagnosisMapping: true,
      diagnosisCandidates: diagnosisCandidates(definition, seeds),
    };
  });
}

function diagnosisCandidates(
  definition: ClinicalFindingDefinition,
  seeds: readonly DiagnosisCandidateSeed[],
): DiagnosisCandidateEntry[] {
  const abnormal = Object.values(definition.valueSchema.fields as Record<string, CustomFieldEntry>)
    .find((field) => field.display === "Abnormal findings" && field.valueType === "multi-select");
  if (!abnormal) throw new Error(`Ocular-health definition ${definition.stableKey} has no Abnormal findings field.`);
  return seeds.map((seed, index) => ({
    id: `SEED_${seed.diagnosisKey.toUpperCase()}_${index + 1}`,
    diagnosisKey: seed.diagnosisKey,
    trigger: { kind: "option", field: abnormal.localCode, anyOf: [seed.option] },
    priority: true,
    origin: "seed",
    active: true,
  }));
}

function gradeField(
  grade: NonNullable<StructureSeed["gradeFields"]>[number],
  gradeIndex: number,
): CustomFieldEntry {
  return {
    localCode: `CUSTOM_GRADE_${optionCode(grade.display).replaceAll("-", "_").toUpperCase()}`,
    display: grade.display,
    origin: "practice",
    valueType: "select",
    options: grade.options.map((display) => ({ code: display, display, active: true })),
    order: gradeIndex + 1,
    active: true,
  };
}

function abnormalField(structure: StructureSeed, structureIndex: number): CustomFieldEntry {
  const nested = structure.nested ?? [];
  const parentLabels = new Set(nested.map((entry) => entry.parent.toLowerCase()));
  const base = [...structure.priority, ...structure.additional]
    .filter((display) => !parentLabels.has(display.toLowerCase()))
    .map((display, index) => ({
      code: optionCode(display),
      display,
      active: true,
      priority: index < structure.priority.length,
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

function optionCode(display: string): string {
  return display.normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}
