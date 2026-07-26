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
    priority: ["superficial punctate keratitis (SPK)", "corneal staining", "dry eye keratopathy", "arcus", "scar", "keratoconus", "guttata", "pterygium (encroaching)", "neovascularization", "infiltrate"],
    additional: ["abrasion", "dendrite", "edema", "foreign body", "filaments", "erosion", "RCES (recurrent erosion)", "EBMD (map-dot-fingerprint)", "Fuchs' endothelial dystrophy", "band keratopathy", "Salzmann's nodule", "keratic precipitates", "ulcer", "haze", "opacification", "pannus", "nodules", "phlyctenule", "Descemet folds", "Krukenberg spindle", "iron line (Hudson-Stahli/Stocker's/Fleischer's)", "Vogt striae", "vortex keratopathy (verticillata)", "Thygeson's SPK", "lipid keratopathy", "Mooren's ulcer", "Terrien's marginal degeneration", "peripheral thinning", "central thinning", "hydrops", "pigment on endothelium"],
    gradeFields: [
      {
        display: "Corneal staining grade (grading scheme provisional)",
        kind: "select",
        options: ["Grade 0", "Grade 1", "Grade 2", "Grade 3", "Grade 4"],
        slugOptionCodes: true,
      },
      {
        display: "Corneal staining zone (grading scheme provisional)",
        kind: "select",
        options: ["Central", "Nasal", "Temporal", "Superior", "Inferior", "Diffuse"],
        slugOptionCodes: true,
      },
      {
        display: "Vital dye",
        kind: "select",
        options: ["Fluorescein", "Lissamine green"],
        slugOptionCodes: true,
      },
    ],
  },
  {
    key: "anterior-chamber",
    display: "Anterior Chamber",
    normalTemplate: "Deep and quiet; no cells or flare.",
    priority: ["cells", "flare", "shallow AC"],
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
    priority: ["nevus", "transillumination defect", "posterior synechiae"],
    additional: ["atrophy", "neovascularization (rubeosis)", "coloboma", "heterochromia", "iridodonesis", "nodules", "sphincter tears", "plateau iris", "irregular pupil", "sectoral atrophy", "pseudoexfoliation material on pupil margin"],
  },
  {
    key: "lens",
    display: "Lens",
    normalTemplate: "Clear; no cataract.",
    priority: ["nuclear sclerosis", "cortical cataract", "posterior subcapsular (PSC)", "pseudophakia (PCIOL)", "posterior capsular opacification (PCO)"],
    additional: ["anterior polar", "posterior polar", "anterior subcapsular", "brunescent", "mature cataract", "pseudophakia (ACIOL)", "aphakia", "phacodonesis", "pseudoexfoliation", "dislocated lens/IOL", "IOL deposits", "polychromatic (Christmas-tree)"],
    gradeFields: [
      { display: "LOCS III — NO (nuclear opalescence)", kind: "number", min: 0.1, max: 6.9, step: 0.1 },
      { display: "LOCS III — NC (nuclear color)", kind: "number", min: 0.1, max: 6.9, step: 0.1 },
      { display: "LOCS III — C (cortical)", kind: "number", min: 0.1, max: 6.9, step: 0.1 },
      { display: "LOCS III — P (posterior subcapsular)", kind: "number", min: 0.1, max: 6.9, step: 0.1 },
    ],
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
    gradeFields: [{ display: "A/V ratio", kind: "select", options: ["2:3", "1:2", "1:3", "1:4"] }],
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
  fieldDisplay?: string;
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
    return applyOcularHealthDiagnosisCandidates(definition);
  });
}

export function applyOcularHealthDiagnosisCandidates(
  definition: ClinicalFindingDefinition,
): ClinicalFindingDefinition {
  const seeds = DIAGNOSIS_CANDIDATE_SEEDS[definition.stableKey];
  if (!seeds) return definition;
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
    return {
    id: `SEED_${seed.diagnosisKey.toUpperCase()}_${index + 1}`,
    diagnosisKey: seed.diagnosisKey,
    trigger: { kind: "option", field: field.localCode, anyOf: [seed.option] },
    priority: true,
    origin: "seed",
    active: true,
    };
  });
  return {
    ...definition,
    allowDiagnosisMapping: true,
    diagnosisCandidates,
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
