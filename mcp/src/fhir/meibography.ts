import type { Observation } from "@medplum/fhirtypes";
import {
  MEIBOGRAPHY_SCORE_CODE_SYSTEM,
  OBSERVATION_MEIBOMIAN_GLAND_SCORE_PROFILE_URL,
} from "./contactLens.js";
import {
  lateralityConcept,
  normalizeLaterality,
  reference,
} from "./ophthalmology/extensions.js";
import type { EyeLaterality } from "./ophthalmology/types.js";

export const MEIBOGRAPHY_SCORE_SYSTEMS = ["meiboscore", "arita"] as const;
export const MEIBOGRAPHY_LIDS = ["upper", "lower"] as const;
export type MeibographyScoreSystem = (typeof MEIBOGRAPHY_SCORE_SYSTEMS)[number];
export type MeibographyLid = (typeof MEIBOGRAPHY_LIDS)[number];

export interface MeibographyObservationInput {
  patientReference: string;
  documentReference: string;
  eye: Exclude<EyeLaterality, "UNKNOWN">;
  lid: MeibographyLid;
  scoringSystem: MeibographyScoreSystem;
  totalScore: number;
  glandScores?: number[];
  encounterReference?: string;
  effectiveDateTime?: string;
  performerReferences?: string[];
}

export function buildMeibographyObservation(
  input: MeibographyObservationInput,
): Observation {
  const eye = normalizeLaterality(input.eye);
  if (eye === "UNKNOWN") {
    throw new Error("Meibography laterality must be OD, OS, or OU.");
  }
  assertScoreRange(input.scoringSystem, input.totalScore, input.glandScores);
  const effectiveDateTime = input.effectiveDateTime ?? new Date().toISOString();

  return {
    resourceType: "Observation",
    meta: { profile: [OBSERVATION_MEIBOMIAN_GLAND_SCORE_PROFILE_URL] },
    status: "final",
    category: [
      {
        coding: [
          {
            system: "http://terminology.hl7.org/CodeSystem/observation-category",
            code: "exam",
            display: "Exam",
          },
        ],
        text: "Exam",
      },
    ],
    code: meibographyScoreConcept(input.scoringSystem, input.lid),
    subject: reference(input.patientReference),
    ...(input.encounterReference ? { encounter: reference(input.encounterReference) } : {}),
    effectiveDateTime,
    bodySite: {
      ...lateralityConcept(eye),
      text: `${eye} ${input.lid} lid`,
    },
    valueInteger: input.totalScore,
    derivedFrom: [reference(input.documentReference)],
    ...(input.performerReferences?.length
      ? { performer: input.performerReferences.map((performer) => reference(performer)) }
      : {}),
    ...(input.glandScores?.length
      ? {
          component: input.glandScores.map((score, index) => ({
            code: {
              coding: [
                {
                  system: MEIBOGRAPHY_SCORE_CODE_SYSTEM,
                  code: glandCode(input.scoringSystem),
                  display: `${displayForSystem(input.scoringSystem)} gland ${index + 1}`,
                },
              ],
              text: `${displayForSystem(input.scoringSystem)} gland ${index + 1}`,
            },
            valueInteger: score,
          })),
        }
      : {}),
  };
}

export function meibographyScoreConcept(
  scoringSystem: MeibographyScoreSystem,
  lid: MeibographyLid,
) {
  const code =
    scoringSystem === "meiboscore" ? "meiboscore-total-lid" : "arita-total-lid";
  const display = `${displayForSystem(scoringSystem)} ${lid} lid total score`;
  return {
    coding: [
      {
        system: MEIBOGRAPHY_SCORE_CODE_SYSTEM,
        code,
        display,
      },
    ],
    text: display,
  };
}

function assertScoreRange(
  scoringSystem: MeibographyScoreSystem,
  totalScore: number,
  glandScores: number[] | undefined,
): void {
  const maxTotal = scoringSystem === "meiboscore" ? 9 : 15;
  const expectedGlands = scoringSystem === "meiboscore" ? 3 : 5;
  if (!Number.isInteger(totalScore) || totalScore < 0 || totalScore > maxTotal) {
    throw new Error(`${displayForSystem(scoringSystem)} total score must be 0-${maxTotal}.`);
  }
  if (!glandScores) {
    return;
  }
  if (glandScores.length !== expectedGlands) {
    throw new Error(
      `${displayForSystem(scoringSystem)} gland scoring requires ${expectedGlands} gland scores.`,
    );
  }
  for (const score of glandScores) {
    if (!Number.isInteger(score) || score < 0 || score > 3) {
      throw new Error(`${displayForSystem(scoringSystem)} gland scores must be integers 0-3.`);
    }
  }
}

function glandCode(scoringSystem: MeibographyScoreSystem): string {
  return scoringSystem === "meiboscore" ? "meiboscore-gland" : "arita-gland";
}

function displayForSystem(scoringSystem: MeibographyScoreSystem): string {
  return scoringSystem === "meiboscore" ? "Meiboscore" : "Arita";
}
