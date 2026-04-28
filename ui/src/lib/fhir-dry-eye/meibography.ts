import type { Observation } from "@medplum/fhirtypes";
import { lateralityConcept, normalizeLaterality, reference, type DryEyeLaterality } from "./common.js";
import {
  MEIBOGRAPHY_SCORE_CODE_SYSTEM,
  OBSERVATION_MEIBOMIAN_GLAND_SCORE_PROFILE_URL,
} from "./terminology.js";

export const MEIBOGRAPHY_SCORE_SYSTEMS = ["meiboscore", "arita"] as const;
export const MEIBOGRAPHY_LIDS = ["upper", "lower"] as const;
export type MeibographyScoreSystem = (typeof MEIBOGRAPHY_SCORE_SYSTEMS)[number];
export type MeibographyLid = (typeof MEIBOGRAPHY_LIDS)[number];

export function buildMeibographyObservation(input: {
  patientReference: string;
  documentReference: string;
  eye: DryEyeLaterality;
  lid: MeibographyLid;
  scoringSystem: MeibographyScoreSystem;
  totalScore: number;
  glandScores?: number[];
  encounterReference?: string;
  effectiveDateTime?: string;
}): Observation {
  const eye = normalizeLaterality(input.eye);
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
    effectiveDateTime: input.effectiveDateTime ?? new Date().toISOString(),
    bodySite: {
      ...lateralityConcept(eye),
      text: `${eye} ${input.lid} lid`,
    },
    valueInteger: input.totalScore,
    derivedFrom: [reference(input.documentReference)],
    ...(input.glandScores?.length
      ? {
          component: input.glandScores.map((score, index) => ({
            code: {
              coding: [
                {
                  system: MEIBOGRAPHY_SCORE_CODE_SYSTEM,
                  code: input.scoringSystem === "meiboscore" ? "meiboscore-gland" : "arita-gland",
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

function displayForSystem(scoringSystem: MeibographyScoreSystem): string {
  return scoringSystem === "meiboscore" ? "Meiboscore" : "Arita";
}

export function meibographyScoreConcept(scoringSystem: MeibographyScoreSystem, lid: MeibographyLid) {
  const code = scoringSystem === "meiboscore" ? "meiboscore-total-lid" : "arita-total-lid";
  const display = `${scoringSystem === "meiboscore" ? "Meiboscore" : "Arita"} ${lid} lid total score`;
  return {
    coding: [{ system: MEIBOGRAPHY_SCORE_CODE_SYSTEM, code, display }],
    text: display,
  };
}
