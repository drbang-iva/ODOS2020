import type {
  BuildResult,
  EyeLaterality,
  VisualAcuityChartType,
  VisualAcuityCorrection,
  VisualAcuityInput,
} from "./types.js";
import { dualCoding } from "./codeBindings.js";
import {
  applyCommonObservationFields,
  component,
  osodConcept,
  quantity,
} from "./extensions.js";

export interface ParsedSnellen {
  numerator: number;
  denominator: number;
  suffix: string;
  logmar: number;
}

export function parseSnellen(snellen: string): ParsedSnellen | undefined {
  const match = snellen.trim().match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)(.*)$/);
  if (!match) {
    return undefined;
  }

  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || numerator <= 0) {
    return undefined;
  }

  const rawLogmar = Math.log10(denominator / numerator);
  return {
    numerator,
    denominator,
    suffix: match[3]?.trim() ?? "",
    logmar: Math.abs(rawLogmar) < 0.0000001 ? 0 : rawLogmar,
  };
}

export function buildVisualAcuityObservation(
  input: VisualAcuityInput,
): BuildResult<import("./types.js").Observation> {
  if (!input.snellen.trim()) {
    throw new Error("Visual acuity snellen value is required.");
  }

  const parsed = parseSnellen(input.snellen);
  const logmar = input.logmar ?? parsed?.logmar;

  if (!parsed && logmar === undefined && input.letterScore === undefined && !input.allowUnparseable) {
    throw new Error(
      "Visual acuity is unparseable and has no computable logMAR or ETDRS letter score. Set allowUnparseable=true only when preserving an explicitly unparseable source value.",
    );
  }

  const components = [
    component("VA_SNELLEN_RAW", "Visual acuity Snellen raw", {
      valueString: input.snellen,
    }),
    component("VA_CHART_TYPE", "Visual acuity chart type", {
      valueCodeableConcept: osodConcept(input.chartType, input.chartType),
    }),
    component("VA_CORRECTION", "Visual acuity correction", {
      valueCodeableConcept: osodConcept(input.correction, input.correction),
    }),
  ];

  if (logmar !== undefined) {
    components.push(
      component("VA_LOGMAR", "Visual acuity logMAR", {
        valueQuantity: quantity(roundLogmar(logmar), "logMAR"),
      }),
    );
  }

  if (input.letterScore !== undefined) {
    if (!Number.isInteger(input.letterScore)) {
      throw new Error("ETDRS letterScore must be an integer.");
    }
    components.push(
      component("VA_LETTER_SCORE", "Visual acuity ETDRS letter score", {
        valueInteger: input.letterScore,
      }),
    );
  }

  if (input.distance !== undefined) {
    if (!Number.isFinite(input.distance) || input.distance <= 0) {
      throw new Error("Visual acuity distance must be a positive number.");
    }
    const unit = input.distanceUnit ?? "ft";
    components.push(
      component("VA_DISTANCE", "Visual acuity test distance", {
        valueQuantity: quantity(
          input.distance,
          unit,
          unit === "m" ? "http://unitsofmeasure.org" : undefined,
          unit === "m" ? "m" : undefined,
        ),
      }),
    );
  }

  const observation = applyCommonObservationFields(
    {
      resourceType: "Observation",
      status: "final",
      code: {
        coding: dualCoding(
          "VISUAL_ACUITY",
          "Visual acuity",
          osodVAtoSnomed(visualAcuityDistanceKind(input), input.correction, input.chartType, input.eye),
        ),
        text: "Visual acuity",
      },
      method: input.method ? osodConcept(input.method, input.method) : undefined,
      component: components,
    },
    {
      ...input,
      method: input.method ? osodConcept(input.method, input.method) : undefined,
    },
  );

  const warnings: string[] = [];
  if (parsed?.suffix && input.letterScore === undefined) {
    warnings.push(
      "Snellen plus/minus notation was preserved as raw text; logMAR uses the base fraction because no ETDRS letter score was supplied.",
    );
  }

  return { resource: observation, warnings };
}

function roundLogmar(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function osodVAtoSnomed(
  distance: "distance" | "near",
  correction: VisualAcuityCorrection,
  chartType: VisualAcuityChartType = "UNKNOWN",
  eye: EyeLaterality = "UNKNOWN",
): { code: string; display: string } {
  if (chartType === "LOGMAR" && eye === "OD") {
    return { code: "413078003", display: "LogMAR visual acuity right eye (observable entity)" };
  }
  if (chartType === "LOGMAR" && eye === "OS") {
    return { code: "413077008", display: "LogMAR visual acuity left eye (observable entity)" };
  }

  if (distance === "near") {
    if (chartType === "JAEGER") {
      return { code: "251747003", display: "Near visual acuity - Jaeger's types" };
    }
    return { code: "251743004", display: "Near visual acuity" };
  }

  if (correction === "SC") {
    return { code: "420050001", display: "Uncorrected visual acuity (observable entity)" };
  }
  if (correction === "CC") {
    return { code: "397536007", display: "Corrected visual acuity (observable entity)" };
  }
  if (correction === "BCVA") {
    return { code: "419775003", display: "Best corrected visual acuity (observable entity)" };
  }
  if (correction === "PH") {
    return { code: "419475002", display: "Pinhole visual acuity (observable entity)" };
  }

  if (chartType === "SNELLEN") {
    return { code: "422673001", display: "Snellen visual acuity (observable entity)" };
  }

  return { code: "251739003", display: "Distance visual acuity" };
}

function visualAcuityDistanceKind(input: VisualAcuityInput): "distance" | "near" {
  if (input.distance === undefined) {
    return "distance";
  }

  if (input.distanceUnit === "m") {
    return input.distance <= 1 ? "near" : "distance";
  }

  return input.distance <= 3 ? "near" : "distance";
}
