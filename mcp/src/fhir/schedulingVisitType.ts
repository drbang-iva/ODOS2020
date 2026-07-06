import type { HealthcareService } from "@medplum/fhirtypes";
import {
  OSOD_DISCIPLINE_SYSTEM,
  type SchedulingDiscipline,
  assertDiscipline,
  disciplineCoding,
  disciplinesForMode,
} from "../scheduling/clinic-mode.js";

/**
 * The service/visit-type catalog — one HealthcareService per practice-defined visit type.
 *
 * This is the GHL "Service Menu" customizability model (brief §3.1): each visit type carries its
 * own duration, color, eligible resources, and intake form, all as DATA. New visit types are
 * catalog rows, not code. Discipline (eyecare/aesthetics) rides in `category` — the native R4
 * broad-categorization element — so clinic-mode filtering (brief §1) is one coding match.
 *
 * R4 name traps verified against @medplum/fhirtypes: HealthcareService's categorization element
 * is `category` (Appointment/Slot call theirs `serviceCategory`); duration/color have no native
 * R4 home on HealthcareService, so they ride osod-* extensions.
 */

export const OSOD_VISIT_TYPE_SYSTEM = "https://osod.dev/fhir/CodeSystem/visit-type";

export const OSOD_VISIT_DURATION_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/osod-visit-duration";

export const OSOD_DISPLAY_COLOR_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/osod-display-color";

export const OSOD_ELIGIBLE_RESOURCE_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/osod-eligible-resource";

export const OSOD_INTAKE_FORM_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/osod-intake-form";

/**
 * The v8 front-desk palette — the shipped color defaults (brief §4, hex extracted from
 * osod-timeline-v8-frontdesk.html). Operator-reconfigurable per visit type; the catalog owns the
 * color. Dark theme.
 */
export const SCHEDULER_PALETTE = {
  surfaceBase: "#060610",
  mutedLine: "#666678",
  mutedLineLight: "#9999aa",
  lightSurface: "#ccccdd",
  lightSurfaceBright: "#eeeef2",
  newExamBlue: "#4a7dff",
  newExamBlueAlt: "#4488ff",
  establishedTeal: "#44ddaa",
  specialTestingPurple: "#cc88ff",
  officeVisitOrange: "#ff8844",
  officeVisitOrangeAlt: "#ff9944",
  nonPatientGold: "#ffcc44",
  urgentRed: "#ff5555",
  aestheticsCyan: "#22aabb",
  /** The brief reserves a second aesthetics hue (§4); ODOS ships rose — nothing in the OD band is near it. */
  aestheticsRose: "#ee6699",
  aestheticsSky: "#66ccdd",
} as const;

/**
 * Combined-mode legibility rule (brief §4): OD types draw from the blue/teal/purple/orange band;
 * aesthetics types draw from the cyan/rose band — discipline reads from color alone.
 */
export const DISCIPLINE_COLOR_BANDS: Record<SchedulingDiscipline, readonly string[]> = {
  eyecare: [
    SCHEDULER_PALETTE.newExamBlue,
    SCHEDULER_PALETTE.newExamBlueAlt,
    SCHEDULER_PALETTE.establishedTeal,
    SCHEDULER_PALETTE.specialTestingPurple,
    SCHEDULER_PALETTE.officeVisitOrange,
    SCHEDULER_PALETTE.officeVisitOrangeAlt,
    SCHEDULER_PALETTE.nonPatientGold,
    SCHEDULER_PALETTE.lightSurfaceBright,
  ],
  aesthetics: [
    SCHEDULER_PALETTE.aestheticsCyan,
    SCHEDULER_PALETTE.aestheticsRose,
    SCHEDULER_PALETTE.aestheticsSky,
  ],
};

const DEFAULT_COLOR_BY_DISCIPLINE: Record<SchedulingDiscipline, string> = {
  eyecare: SCHEDULER_PALETTE.newExamBlue,
  aesthetics: SCHEDULER_PALETTE.aestheticsCyan,
};

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export interface VisitTypeInput {
  /** Stable kebab-case catalog code — becomes the type coding + Appointment.serviceType code. */
  code: string;
  /** Front-desk display name. */
  name: string;
  discipline: string;
  /** Default booking duration in whole minutes. */
  durationMinutes: number;
  /** Block color (#rrggbb). Defaults to the discipline's primary band color. */
  color?: string;
  /** Resources (Practitioner/Location/Device refs) eligible to host this visit type. */
  eligibleResourceReferences?: string[];
  /** Intake form (Questionnaire ref) attached to bookings of this type. */
  intakeFormReference?: string;
  active?: boolean;
}

/** Build the HealthcareService catalog entry for a practice-defined visit type. */
export function buildVisitType(input: VisitTypeInput): HealthcareService {
  if (!input.code) {
    throw new Error("Visit type requires a stable catalog code.");
  }
  if (!input.name) {
    throw new Error("Visit type requires a front-desk display name.");
  }
  assertDiscipline(input.discipline);
  if (!Number.isInteger(input.durationMinutes) || input.durationMinutes <= 0) {
    throw new Error("Visit type duration (durationMinutes) must be a positive integer.");
  }
  const color = input.color ?? DEFAULT_COLOR_BY_DISCIPLINE[input.discipline];
  if (!HEX_COLOR.test(color)) {
    throw new Error(`Visit type color must be a #rrggbb hex value, got "${color}".`);
  }

  return {
    resourceType: "HealthcareService",
    active: input.active ?? true,
    appointmentRequired: true,
    name: input.name,
    category: [{ coding: [disciplineCoding(input.discipline)] }],
    type: [
      {
        coding: [{ system: OSOD_VISIT_TYPE_SYSTEM, code: input.code, display: input.name }],
        text: input.name,
      },
    ],
    extension: [
      { url: OSOD_VISIT_DURATION_EXTENSION_URL, valuePositiveInt: input.durationMinutes },
      { url: OSOD_DISPLAY_COLOR_EXTENSION_URL, valueString: color },
      ...(input.eligibleResourceReferences ?? []).map((reference) => ({
        url: OSOD_ELIGIBLE_RESOURCE_EXTENSION_URL,
        valueReference: { reference },
      })),
      ...(input.intakeFormReference
        ? [
            {
              url: OSOD_INTAKE_FORM_EXTENSION_URL,
              valueReference: { reference: input.intakeFormReference },
            },
          ]
        : []),
    ],
  };
}

/** The catalog code of a visit-type entry. */
export function visitTypeCode(hs: HealthcareService): string | undefined {
  return hs.type?.[0]?.coding?.find((c) => c.system === OSOD_VISIT_TYPE_SYSTEM)?.code;
}

/** The discipline a visit-type entry belongs to (drives clinic-mode filtering). */
export function visitTypeDiscipline(hs: HealthcareService): SchedulingDiscipline | undefined {
  const code = hs.category
    ?.flatMap((c) => c.coding ?? [])
    .find((c) => c.system === OSOD_DISCIPLINE_SYSTEM)?.code;
  return code as SchedulingDiscipline | undefined;
}

/** Default booking duration in minutes. */
export function visitTypeDurationMinutes(hs: HealthcareService): number | undefined {
  return hs.extension?.find((e) => e.url === OSOD_VISIT_DURATION_EXTENSION_URL)?.valuePositiveInt;
}

/** Block display color (#rrggbb). */
export function visitTypeColor(hs: HealthcareService): string | undefined {
  return hs.extension?.find((e) => e.url === OSOD_DISPLAY_COLOR_EXTENSION_URL)?.valueString;
}

/** Resource references eligible to host this visit type (empty = any resource). */
export function visitTypeEligibleResourceReferences(hs: HealthcareService): string[] {
  return (hs.extension ?? [])
    .filter((e) => e.url === OSOD_ELIGIBLE_RESOURCE_EXTENSION_URL)
    .map((e) => e.valueReference?.reference)
    .filter((reference): reference is string => Boolean(reference));
}

/**
 * The shipped default catalog — Eyefinity type semantics on the OD side (brief §3.2), the
 * AestheticsPro Consult/Procedure/Follow-Up trio on the aesthetics side (brief §3.3), colored per
 * the v8 palette mapping (§4). Seed data the practice edits; not a hard-code.
 */
const DEFAULT_VISIT_TYPES: VisitTypeInput[] = [
  {
    code: "routine-exam-new",
    name: "Routine Exam (New)",
    discipline: "eyecare",
    durationMinutes: 30,
    color: SCHEDULER_PALETTE.newExamBlue,
  },
  {
    code: "routine-exam-established",
    name: "Routine Exam (Established)",
    discipline: "eyecare",
    durationMinutes: 30,
    color: SCHEDULER_PALETTE.establishedTeal,
  },
  {
    code: "medicaid-exam",
    name: "Medicaid Exam",
    discipline: "eyecare",
    durationMinutes: 30,
    color: SCHEDULER_PALETTE.lightSurfaceBright,
  },
  {
    code: "office-visit",
    name: "Office Visit (Medical)",
    discipline: "eyecare",
    durationMinutes: 20,
    color: SCHEDULER_PALETTE.officeVisitOrange,
  },
  {
    code: "special-testing",
    name: "Special Testing (VF / OCT / Dry Eye)",
    discipline: "eyecare",
    durationMinutes: 30,
    color: SCHEDULER_PALETTE.specialTestingPurple,
  },
  {
    code: "aesthetics-consult",
    name: "Aesthetics Consult",
    discipline: "aesthetics",
    durationMinutes: 30,
    color: SCHEDULER_PALETTE.aestheticsCyan,
  },
  {
    code: "aesthetics-treatment",
    name: "Aesthetics Treatment",
    discipline: "aesthetics",
    durationMinutes: 60,
    color: SCHEDULER_PALETTE.aestheticsRose,
  },
  {
    code: "aesthetics-follow-up",
    name: "Aesthetics Follow-Up",
    discipline: "aesthetics",
    durationMinutes: 15,
    color: SCHEDULER_PALETTE.aestheticsSky,
  },
];

/** The default catalog for a clinic mode — a single-discipline practice never sees the other side. */
export function defaultVisitTypeCatalog(mode: string): HealthcareService[] {
  const visible = new Set<string>(disciplinesForMode(mode));
  return DEFAULT_VISIT_TYPES.filter((vt) => visible.has(vt.discipline)).map(buildVisitType);
}
