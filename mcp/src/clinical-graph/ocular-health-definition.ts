import type { CustomFieldEntry } from "./custom-fields.js";
import {
  buildClinicalFindingDefinition,
  type ClinicalFindingDefinition,
  type ClinicalGraphProvenance,
} from "./glaucoma-suspect.js";

export const ANTERIOR_OCULAR_HEALTH_PREFIX = "ocular-health:anterior:";

interface StructureSeed {
  key: string;
  display: string;
  normalTemplate: string;
  priority: string[];
  additional: string[];
  allowDeferred?: boolean;
  nested?: Array<{ parent: string; children: string[] }>;
}

const STRUCTURES: StructureSeed[] = [
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

export function buildAnteriorOcularHealthDefinitions(
  provenance: ClinicalGraphProvenance,
): ClinicalFindingDefinition[] {
  return STRUCTURES.map((structure, structureIndex) => {
    const stableKey = `${ANTERIOR_OCULAR_HEALTH_PREFIX}${structure.key}`;
    const field = abnormalField(structure, structureIndex);
    return buildClinicalFindingDefinition({
      stableKey,
      display: structure.display,
      sectionKey: stableKey,
      anatomyTarget: structure.key === "cornea" ? "cornea" : "eye",
      valueSchema: {
        type: "ocular-health-structure",
        perEye: true,
        fields: { [field.localCode]: field },
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
  });
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
