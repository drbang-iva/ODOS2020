import type { Basic } from "@medplum/fhirtypes";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FindingSectionGroupFhirClient } from "./finding-section-group-store.js";
import { searchAll, type FhirSearchClient } from "../fhir-search.js";

export const FOLLOW_UP_PROFILE_CODE_SYSTEM = "https://odos2020.com/fhir/CodeSystem/odos-follow-up-profile";
export const FOLLOW_UP_PROFILE_CODE = "odos-follow-up-profile";
export const FOLLOW_UP_PROFILE_IDENTIFIER_SYSTEM = "https://odos2020.com/fhir/NamingSystem/follow-up-profile-key";
export const FOLLOW_UP_PROFILE_EXTENSION_URL = "https://odos2020.com/fhir/StructureDefinition/odos-follow-up-profile-json";
const writeHeaders = { "X-ODOS-Source": "follow-up-profiles" };
const text = z.string().trim().min(1).max(2000);
export const profileReferenceSchema = z.object({ key: text, label: text.optional(), unavailableReason: text.optional() }).strict();
export const profileTestSchema = z.object({
  orderable: text, label: text, focus: text.optional(), unavailableReason: text.optional(),
  resultSection: profileReferenceSchema.optional(),
  choice: z.object({ name: text, options: z.array(z.object({ code: text, unavailableReason: text.optional() }).strict()).min(1) }).strict().optional(),
}).strict();
export const followUpProfileSchema = z.object({
  profileKey: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100),
  label: text, version: z.number().int().positive(), active: z.boolean(),
  matchesDiagnosisFamilies: z.array(text).max(100), episodeType: text.optional(),
  sectionsOpen: z.array(profileReferenceSchema).min(2).max(200),
  testsQueuedByDefault: z.array(profileTestSchema).max(100),
  priorValuesShown: z.array(profileReferenceSchema).max(100),
  historyTemplate: profileReferenceSchema,
  historyItems: z.array(text).max(100), source: text,
}).strict().superRefine((profile, ctx) => {
  for (const required of ["hpi", "assessment"]) if (!profile.sectionsOpen.some(row => row.key === required)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sectionsOpen"], message: `${required} must remain open.` });
  }
  for (const [name, keys] of [
    ["sectionsOpen", profile.sectionsOpen.map(row => row.key)],
    ["testsQueuedByDefault", profile.testsQueuedByDefault.map(row => `${row.orderable}|${row.focus ?? ""}`)],
    ["priorValuesShown", profile.priorValuesShown.map(row => row.key)],
    ["historyItems", profile.historyItems], ["matchesDiagnosisFamilies", profile.matchesDiagnosisFamilies],
  ] as const) if (new Set(keys).size !== keys.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: `${name} contains duplicates.` });
});
export type FollowUpProfile = z.infer<typeof followUpProfileSchema>;
export type ProfileReference = z.infer<typeof profileReferenceSchema>;
export type ProfileTest = z.infer<typeof profileTestSchema>;
export type FollowUpProfileRecord = FollowUpProfile & { versionId: string | null };
export type FollowUpProfileFhirClient = FindingSectionGroupFhirClient & FhirSearchClient;

export class FollowUpProfileConcurrentEditError extends Error {
  readonly status = 409;
  readonly code = "concurrent-edit";
  constructor() { super("This follow-up profile changed concurrently — reload and retry."); }
}

export class FollowUpProfileNotFoundError extends Error {
  readonly status = 404;
  constructor() { super("Profile does not exist."); }
}

export class FhirFollowUpProfileStore {
  constructor(private readonly fhir: FollowUpProfileFhirClient, private readonly seeds: readonly FollowUpProfile[] = FOLLOW_UP_PROFILE_SEEDS) {}

  async list(): Promise<FollowUpProfileRecord[]> {
    const rows = await this.stored();
    const byKey = new Map(rows.map(row => [row.profile.profileKey, { ...row.profile, versionId: row.resource.meta!.versionId! }]));
    const seedKeys = new Set(this.seeds.map(seed => seed.profileKey));
    return [
      ...this.seeds.map(seed => byKey.get(seed.profileKey) ?? { ...structuredClone(seed), versionId: null }),
      ...[...byKey.values()].filter(row => !seedKeys.has(row.profileKey)),
    ];
  }

  create(profile: FollowUpProfile, expectedVersion: string | null) { return this.write(profile, expectedVersion, "create"); }
  save(profile: FollowUpProfile, expectedVersion: string | null) { return this.write(profile, expectedVersion, "save"); }

  private async write(input: FollowUpProfile, expectedVersion: string | null, mode: "create" | "save") {
    const profile = followUpProfileSchema.parse(input);
    const rows = await this.stored();
    const existing = rows.find(row => row.profile.profileKey === profile.profileKey)?.resource;
    const seed = this.seeds.find(row => row.profileKey === profile.profileKey);
    if (mode === "create" && (existing || seed)) throw new FollowUpProfileConcurrentEditError();
    if (mode === "save" && !existing && !seed) throw new FollowUpProfileNotFoundError();
    const writeVersion = expectedVersion;
    if ((existing?.meta?.versionId ?? null) !== writeVersion) throw new FollowUpProfileConcurrentEditError();
    const writeToken = randomUUID();
    const resource = buildFollowUpProfileResource(profile, writeToken, existing);
    try {
      const persisted = existing?.id
        ? await this.fhir.update("Basic", existing.id, resource, { ...writeHeaders, "If-Match": `W/"${writeVersion}"` })
        : await this.fhir.create(resource, { ...writeHeaders, "If-None-Exist": `identifier=${encodeURIComponent(`${FOLLOW_UP_PROFILE_IDENTIFIER_SYSTEM}|${profile.profileKey}`)}` });
      const result = parseFollowUpProfileResource(persisted);
      if (result.writeToken !== writeToken) throw new FollowUpProfileConcurrentEditError();
      if (!persisted.meta?.versionId) throw new Error("Persisted profile has no version.");
      return { profile: result.profile, versionId: persisted.meta.versionId };
    } catch (error) {
      if ((error as { status?: number }).status === 412) throw new FollowUpProfileConcurrentEditError();
      throw error;
    }
  }

  private async stored() {
    const resources = await searchAll<Basic>(this.fhir, "Basic", { code: `${FOLLOW_UP_PROFILE_CODE_SYSTEM}|${FOLLOW_UP_PROFILE_CODE}`, _count: "100" });
    const rows = resources.map(resource => {
      if (!resource.id || !resource.meta?.versionId) throw new Error("Stored profile has no id or version.");
      return { resource, ...parseFollowUpProfileResource(resource) };
    });
    const keys = rows.map(row => row.profile.profileKey);
    if (new Set(keys).size !== keys.length) throw new Error("Duplicate stored follow-up profile keys.");
    return rows;
  }
}

export function buildFollowUpProfileResource(profile: FollowUpProfile, writeToken: string, existing?: Basic): Basic {
  const value = followUpProfileSchema.parse(profile);
  return {
    resourceType: "Basic", ...(existing?.id ? { id: existing.id, meta: existing.meta } : {}),
    identifier: [{ system: FOLLOW_UP_PROFILE_IDENTIFIER_SYSTEM, value: value.profileKey }],
    code: { coding: [{ system: FOLLOW_UP_PROFILE_CODE_SYSTEM, code: FOLLOW_UP_PROFILE_CODE }], text: value.label },
    extension: [{ url: FOLLOW_UP_PROFILE_EXTENSION_URL, valueString: JSON.stringify({ profile: value, writeToken }) }],
  };
}

export function parseFollowUpProfileResource(resource: Basic) {
  if (!resource.code.coding?.some(row => row.system === FOLLOW_UP_PROFILE_CODE_SYSTEM && row.code === FOLLOW_UP_PROFILE_CODE)) throw new Error("Not a follow-up profile Basic.");
  const values = resource.extension?.filter(row => row.url === FOLLOW_UP_PROFILE_EXTENSION_URL) ?? [];
  if (values.length !== 1 || !values[0]!.valueString) throw new Error("Profile JSON extension is missing or duplicated.");
  const value = z.object({ profile: followUpProfileSchema, writeToken: text }).strict().parse(JSON.parse(values[0]!.valueString));
  const identifiers = resource.identifier?.filter(row => row.system === FOLLOW_UP_PROFILE_IDENTIFIER_SYSTEM) ?? [];
  if (identifiers.length !== 1 || identifiers[0]!.value !== value.profile.profileKey) throw new Error("Profile identifier mismatch.");
  return value;
}

export const FOLLOW_UP_PROFILE_SEEDS: readonly FollowUpProfile[] = [
  {
    "profileKey": "glaucoma",
    "label": "Glaucoma / glaucoma suspect",
    "matchesDiagnosisFamilies": [
      "glaucoma suspect",
      "ocular hypertension",
      "anatomical narrow angle",
      "primary angle closure",
      "steroid responder",
      "primary open-angle glaucoma",
      "low-tension glaucoma"
    ],
    "historyItems": [
      "core",
      "Missed doses in the last week",
      "Eye redness, stinging or blur from the drops",
      "Any steroid use started since last visit (drops, inhaler, nasal, oral, injection)"
    ],
    "source": "operator direction 2026-09-19 incl. §1.8–§1.9 · reconciliation §4 · Eyefinity walk §4 · shipped glaucoma plan sets",
    "version": 1,
    "active": true,
    "episodeType": "glaucoma",
    "sectionsOpen": [
      {
        "key": "hpi"
      },
      {
        "key": "va"
      },
      {
        "key": "pupils"
      },
      {
        "key": "cvf"
      },
      {
        "key": "iop"
      },
      {
        "key": "dilation"
      },
      {
        "key": "cup-disc"
      },
      {
        "key": "ocular-health:posterior:fundus"
      },
      {
        "key": "imaging"
      },
      {
        "key": "assessment"
      }
    ],
    "testsQueuedByDefault": [
      {
        "orderable": "visual-field-threshold",
        "label": "Visual field"
      },
      {
        "orderable": "scodi-optic-nerve",
        "label": "OCT optic nerve"
      },
      {
        "orderable": "fundus-photography",
        "label": "Optic nerve photos",
        "focus": "optic nerve"
      }
    ],
    "priorValuesShown": [
      {
        "key": "IOP, each eye — last three visits with date, time and method"
      },
      {
        "key": "Highest recorded IOP, each eye (needs a read over prior IOP records — not built)"
      },
      {
        "key": "Cup-to-disc, each eye — last recorded, with date"
      },
      {
        "key": "Central corneal thickness — last recorded, with date (stays here although pachymetry is on the shelf — §1.9)"
      },
      {
        "key": "Gonioscopy — date of the last one and its recorded result (stays here although gonioscopy is on the shelf — §1.9)"
      },
      {
        "key": "Visual field — last date, and the reliability / summary values if they were recorded"
      },
      {
        "key": "OCT optic nerve — last date, and the summary values if they were recorded"
      },
      {
        "key": "Current glaucoma treatment, per eye (from the glaucoma history template's current-treatment section)"
      }
    ],
    "historyTemplate": {
      "key": "glaucoma"
    }
  },
  {
    "profileKey": "macula-retina",
    "label": "Macular degeneration / retina",
    "matchesDiagnosisFamilies": [
      "age-related macular degeneration",
      "macular drusen",
      "other followed retinal disease"
    ],
    "historyItems": [
      "core",
      "New distortion, a new blank spot, or a sudden drop in vision — which eye",
      "Home grid checked since last visit, and what was seen",
      "Taking the recommended supplement",
      "Smoking status reviewed"
    ],
    "source": "operator direction 2026-09-19 incl. §1.8 · reconciliation §4",
    "version": 1,
    "active": true,
    "sectionsOpen": [
      {
        "key": "hpi"
      },
      {
        "key": "va"
      },
      {
        "key": "pupils"
      },
      {
        "key": "dilation"
      },
      {
        "key": "ocular-health:posterior:macula"
      },
      {
        "key": "ocular-health:posterior:vessels"
      },
      {
        "key": "ocular-health:posterior:vitreous"
      },
      {
        "key": "ocular-health:posterior:periphery"
      },
      {
        "key": "ocular-health:posterior:fundus"
      },
      {
        "key": "imaging"
      },
      {
        "key": "assessment"
      }
    ],
    "testsQueuedByDefault": [
      {
        "orderable": "oct-retina",
        "label": "OCT retina",
        "unavailableReason": "No OCT retina orderable exists in ODOS yet"
      },
      {
        "orderable": "fundus-photography",
        "label": "Retina photos",
        "focus": "retina"
      },
      {
        "orderable": "erg",
        "label": "ERG",
        "unavailableReason": "ERG is on ODOS's pending-orderables list — plan-sets/glaucoma.ts:2"
      }
    ],
    "priorValuesShown": [
      {
        "key": "Best-corrected acuity, each eye — last three visits"
      },
      {
        "key": "Home grid monitoring result, as reported (history item — no exam section for it today)"
      },
      {
        "key": "Macula findings at the last visit, each eye, with grades"
      },
      {
        "key": "OCT retina — last date, and the summary values if they were recorded"
      },
      {
        "key": "Retina photos — last date, with a link to open them"
      },
      {
        "key": "Supplement use (history)"
      }
    ],
    "historyTemplate": {
      "key": "dry-macular-degeneration",
      "unavailableReason": "NEW — named in the 2026-09-03 history proposal's shipped-eight list, not built (only glaucoma and routine exist)"
    }
  },
  {
    "profileKey": "dry-eye",
    "label": "Dry eye / ocular surface",
    "matchesDiagnosisFamilies": [
      "dry eye",
      "meibomian gland dysfunction",
      "blepharitis",
      "ocular rosacea"
    ],
    "historyItems": [
      "core",
      "Main symptom now (dryness, burning, grittiness, watering, fluctuating blur) and how often",
      "Lid hygiene / warm compress done as directed",
      "Drop use per day",
      "Screen hours and contact lens wear since last visit"
    ],
    "source": "operator direction 2026-09-19 incl. §1.7 · reconciliation §4 · shipped dry-eye workup definitions",
    "version": 1,
    "active": true,
    "episodeType": "dry-eye",
    "sectionsOpen": [
      {
        "key": "hpi"
      },
      {
        "key": "va"
      },
      {
        "key": "dry-eye"
      },
      {
        "key": "group:dry-eye-workup"
      },
      {
        "key": "ocular-health:anterior:tear-film"
      },
      {
        "key": "ocular-health:anterior:lids-lashes"
      },
      {
        "key": "ocular-health:anterior:palpebral-conjunctiva"
      },
      {
        "key": "ocular-health:anterior:conjunctiva"
      },
      {
        "key": "ocular-health:anterior:cornea"
      },
      {
        "key": "assessment"
      }
    ],
    "testsQueuedByDefault": [
      {
        "orderable": "ocular-surface-staining",
        "label": "Ocular surface staining",
        "unavailableReason": "No staining orderable exists in ODOS yet",
        "resultSection": {
          "key": "dry-eye:conjunctival-staining"
        },
        "choice": {
          "name": "dye",
          "options": [
            {
              "code": "fluorescein"
            },
            {
              "code": "lissamine-green"
            },
            {
              "code": "rose-bengal",
              "unavailableReason": "not in the shipped 'Vital dye' list — dry-eye-finding-definition.ts:168-171; add as content"
            }
          ]
        }
      },
      {
        "orderable": "tear-osmolarity",
        "label": "Tear osmolarity",
        "unavailableReason": "No tear osmolarity orderable exists in ODOS yet",
        "resultSection": {
          "key": "dry-eye:markers"
        }
      },
      {
        "orderable": "inflammadry-mmp-9",
        "label": "InflammaDry (MMP-9)",
        "unavailableReason": "No InflammaDry orderable exists in ODOS yet",
        "resultSection": {
          "key": "dry-eye:markers"
        }
      },
      {
        "orderable": "meibography",
        "label": "Meibography",
        "unavailableReason": "Meibography capture exists (dry-eye-meibography-endpoint.ts); no orderable yet",
        "resultSection": {
          "key": "dry-eye:gland-structure"
        }
      }
    ],
    "priorValuesShown": [
      {
        "key": "Symptom questionnaire score — last three, if recorded"
      },
      {
        "key": "Tear break-up time, each eye — last recorded"
      },
      {
        "key": "Corneal and conjunctival staining, each eye — last recorded grade and dye"
      },
      {
        "key": "Tear osmolarity and InflammaDry — last date and result if recorded"
      },
      {
        "key": "Gland findings (dropout, expressibility, secretion quality) and meibography — last recorded"
      },
      {
        "key": "Punctal plug status, per punctum — last recorded (present / retained / lost) with the date placed",
        "unavailableReason": "Punctal plug status finding is not built."
      },
      {
        "key": "Current ocular-surface treatment"
      },
      {
        "key": "Treatment series position (see design §8 for the counting rule)"
      }
    ],
    "historyTemplate": {
      "key": "dry-eye",
      "unavailableReason": "NEW"
    }
  },
  {
    "profileKey": "red-eye",
    "label": "Red eye / infection",
    "matchesDiagnosisFamilies": [
      "conjunctivitis",
      "keratitis",
      "corneal abrasion",
      "corneal foreign body",
      "anterior uveitis",
      "episcleritis",
      "subconjunctival hemorrhage"
    ],
    "historyItems": [
      "core",
      "Pain, light sensitivity, discharge, vision — each: better / same / worse / gone",
      "Other eye now involved",
      "Contact lens wear stopped as directed",
      "Anyone at home with the same"
    ],
    "source": "operator direction 2026-09-19 · Eyefinity walk addendum (red eye)",
    "version": 1,
    "active": true,
    "sectionsOpen": [
      {
        "key": "hpi"
      },
      {
        "key": "va"
      },
      {
        "key": "pupils"
      },
      {
        "key": "iop"
      },
      {
        "key": "ocular-health:anterior:periocular-adnexa"
      },
      {
        "key": "ocular-health:anterior:lids-lashes"
      },
      {
        "key": "ocular-health:anterior:palpebral-conjunctiva"
      },
      {
        "key": "ocular-health:anterior:conjunctiva"
      },
      {
        "key": "ocular-health:anterior:cornea"
      },
      {
        "key": "ocular-health:anterior:anterior-chamber"
      },
      {
        "key": "ocular-health:anterior:iris"
      },
      {
        "key": "assessment"
      }
    ],
    "testsQueuedByDefault": [],
    "priorValuesShown": [
      {
        "key": "Acuity in the involved eye — first visit and last visit"
      },
      {
        "key": "IOP in the involved eye — last recorded"
      },
      {
        "key": "The involved eye's findings at the last visit, with grades"
      },
      {
        "key": "What was started, and the date"
      },
      {
        "key": "Days since the first visit for this problem"
      }
    ],
    "historyTemplate": {
      "key": "red-eye",
      "unavailableReason": "NEW"
    }
  },
  {
    "profileKey": "bv-vt",
    "label": "Binocular vision / vision therapy",
    "matchesDiagnosisFamilies": [
      "convergence insufficiency",
      "convergence excess",
      "accommodative dysfunction",
      "oculomotor dysfunction",
      "strabismus",
      "amblyopia"
    ],
    "historyItems": [
      "core",
      "Reading / near work: comfort and stamina now",
      "Double vision, words moving, losing place, headaches — each: better / same / worse / gone",
      "Home therapy done: days per week",
      "Schoolwork or job change noticed"
    ],
    "source": "operator direction 2026-09-19 · documents/drafts/2026-09-19-odos-findings-and-records-draft.md §10–§11",
    "version": 1,
    "active": true,
    "episodeType": "vision-therapy",
    "sectionsOpen": [
      {
        "key": "hpi"
      },
      {
        "key": "va"
      },
      {
        "key": "pupils"
      },
      {
        "key": "eom"
      },
      {
        "key": "cover-test"
      },
      {
        "key": "stereopsis"
      },
      {
        "key": "refraction"
      },
      {
        "key": "group:binocular-vision",
        "unavailableReason": "NEW #238 group proposed in the BV draft §10.2"
      },
      {
        "key": "group:sensory",
        "unavailableReason": "NEW #238 group proposed in the BV draft §10.2"
      },
      {
        "key": "assessment"
      }
    ],
    "testsQueuedByDefault": [],
    "priorValuesShown": [
      {
        "key": "Cover test, distance and near — baseline and last evaluation"
      },
      {
        "key": "Near point of convergence, vergence ranges, accommodative measures — baseline and last evaluation (once the BV sections exist)"
      },
      {
        "key": "Stereopsis — baseline and last"
      },
      {
        "key": "Symptom survey score — baseline and last, if recorded"
      },
      {
        "key": "The program card (design §8): completed sessions counted from documented sessions only; 'planned total not recorded' rather than a guess"
      }
    ],
    "historyTemplate": {
      "key": "binocular-vision",
      "unavailableReason": "NEW"
    }
  }
];

export const BUILT_IN_PROFILE_SECTIONS: Record<import("../../../ui/src/components/charting/types.js").BuiltInSectionId, string> = {
  "aesthetics-consent": "Aesthetics consent",
  "hpi": "Chief Complaint & HPI",
  "wearing": "Wearing (WRx)",
  "auto-refraction": "Auto-Refraction / Auto-K",
  "pretest-vitals": "Vitals / BioPhotonic",
  "pupils": "Pupils",
  "stereopsis": "Stereopsis",
  "color-vision": "Color Vision",
  "eom": "EOM / Diplopia",
  "cvf": "Confrontation visual fields",
  "cover-test": "Cover Test",
  "pachymetry": "Pachymetry",
  "manual-keratometry": "Manual Keratometry",
  "dilation": "Dilation",
  "va": "Visual Acuity",
  "refraction": "Refraction",
  "soft-contact-lens": "Soft Contact Lenses",
  "specialty-contact-lens": "Specialty Contact Lens",
  "refraction-history": "Refraction History",
  "eye-growth": "Eye Growth",
  "ortho-k": "Ortho-K",
  "dry-eye": "Dry Eye",
  "myopia-management": "Myopia Management",
  "cup-disc": "Cup/Disc",
  "gonioscopy": "Gonioscopy",
  "imaging": "Manual imaging",
  "iop": "IOP",
  "assessment": "Assessment",
  "prescription": "Plan \u00b7 Prescriptions"
};
