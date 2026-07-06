import type { Coding } from "@medplum/fhirtypes";

/**
 * Clinic mode — the modularity axis of the ODOS scheduler (design brief 2026-07-06 §1).
 *
 * One scheduler serves three practice configurations: eyecare-only, aesthetics-only, or both
 * combined. Everything downstream (visit-type catalog, resources, color families) filters by the
 * disciplines the configured mode makes visible; a single-discipline practice never sees the other
 * discipline's noise.
 */

export const CLINIC_MODES = [
  { code: "eyecare", display: "Eyecare Only" },
  { code: "aesthetics", display: "Aesthetics Only" },
  { code: "both", display: "Eyecare + Aesthetics" },
] as const;

export type ClinicMode = (typeof CLINIC_MODES)[number]["code"];

/** The schedulable disciplines a mode exposes. "both" is a mode, never a discipline. */
export const SCHEDULING_DISCIPLINES = [
  { code: "eyecare", display: "Eyecare" },
  { code: "aesthetics", display: "Aesthetics" },
] as const;

export type SchedulingDiscipline = (typeof SCHEDULING_DISCIPLINES)[number]["code"];

/** Local CodeSystem tagging catalog entries + resources with their discipline. */
export const OSOD_DISCIPLINE_SYSTEM = "https://osod.dev/fhir/CodeSystem/scheduling-discipline";

const MODE_BY_CODE = new Map<string, (typeof CLINIC_MODES)[number]>(
  CLINIC_MODES.map((mode) => [mode.code, mode]),
);

const DISCIPLINE_BY_CODE = new Map<string, (typeof SCHEDULING_DISCIPLINES)[number]>(
  SCHEDULING_DISCIPLINES.map((discipline) => [discipline.code, discipline]),
);

export function assertClinicMode(code: string): asserts code is ClinicMode {
  if (!MODE_BY_CODE.has(code)) {
    throw new Error(
      `Unknown clinic mode "${code}" — must be one of eyecare, aesthetics, or both (brief §1).`,
    );
  }
}

export function assertDiscipline(code: string): asserts code is SchedulingDiscipline {
  if (!DISCIPLINE_BY_CODE.has(code)) {
    throw new Error(
      `Unknown scheduling discipline "${code}" — must be eyecare or aesthetics.`,
    );
  }
}

/** The disciplines visible under a clinic mode, in stable OD-first order. */
export function disciplinesForMode(mode: string): SchedulingDiscipline[] {
  assertClinicMode(mode);
  if (mode === "both") {
    return SCHEDULING_DISCIPLINES.map((d) => d.code);
  }
  return [mode];
}

/** Whether a discipline's catalog entries / resources appear under a clinic mode. */
export function isDisciplineVisible(discipline: string, mode: string): boolean {
  assertDiscipline(discipline);
  return disciplinesForMode(mode).includes(discipline);
}

/** The osod discipline Coding carried on catalog entries (serviceCategory) and resources. */
export function disciplineCoding(discipline: string): Coding {
  assertDiscipline(discipline);
  const entry = DISCIPLINE_BY_CODE.get(discipline)!;
  return {
    system: OSOD_DISCIPLINE_SYSTEM,
    code: entry.code,
    display: entry.display,
  };
}
