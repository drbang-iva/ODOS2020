// MIRROR of osod/mcp/src/fhir/ophthalmology/save-section-bundle.ts. Source of truth lives in MCP. Sync manually until v0.5 monorepo refactor. Parity guarded by mcp/tests/builder-mirror-parity.test.ts.
import type {
  BodyStructure,
  Bundle,
  BundleEntry,
  Observation,
  Resource,
} from "@medplum/fhirtypes";
import { buildEyeBodyStructure, rewriteObservationBodyStructureReference } from "./bodyStructure.js";
import { buildIopObservation } from "./iop.js";
import { buildRefractionObservation } from "./refraction.js";
import { buildVisualAcuityObservation } from "./visualAcuity.js";
import { osodConcept } from "./extensions.js";
import type {
  EyeLaterality,
  IopMethod,
  RefractionType,
  VisualAcuityChartType,
  VisualAcuityCorrection,
} from "./types.js";

export type SectionSaveSection = "va" | "iop" | "refraction";
export type SectionSaveLaterality = Exclude<EyeLaterality, "UNKNOWN">;

export interface VisualAcuitySectionSaveEntry {
  laterality: SectionSaveLaterality;
  snellen: string;
  chartType: VisualAcuityChartType;
  correction: VisualAcuityCorrection;
  logmar?: number;
  letterScore?: number;
  distance?: number;
  distanceUnit?: "ft" | "m";
  method?: string;
  allowUnparseable?: boolean;
}

export interface IopSectionSaveEntry {
  laterality: SectionSaveLaterality;
  value: number;
  method?: IopMethod;
}

export interface RefractionSectionSaveEntry {
  laterality: SectionSaveLaterality;
  refractionType: RefractionType;
  sphere?: number;
  cylinder?: number;
  axis?: number;
  add?: number;
  prism?: {
    amount?: number;
    base?: string;
    raw?: string;
  };
}

export type SectionSaveEntry =
  | VisualAcuitySectionSaveEntry
  | IopSectionSaveEntry
  | RefractionSectionSaveEntry;

export interface BuildSectionSaveBundleInput {
  patientReference: string;
  encounterReference: string;
  section: SectionSaveSection;
  entries: SectionSaveEntry[];
  operatorDisplay: string;
  measuredAt?: string;
  recordedAt?: string;
}

export const SECTION_PROFILE_URLS: Record<SectionSaveSection, string> = {
  va: "https://osod.dev/fhir/StructureDefinition/Observation-VA",
  iop: "https://osod.dev/fhir/StructureDefinition/Observation-IOP",
  refraction: "https://osod.dev/fhir/StructureDefinition/Observation-Refraction",
};

const BODY_STRUCTURE_IDENTIFIER_SYSTEM =
  "https://osod.dev/fhir/NamingSystem/body-structure";
const SNOMED_BY_LATERALITY: Record<SectionSaveLaterality, string> = {
  OD: "18944008",
  OS: "8966001",
  OU: "81745001",
};

export function buildSectionSaveBundle(input: BuildSectionSaveBundleInput): Bundle {
  if (input.entries.length === 0) {
    throw new Error("buildSectionSaveBundle requires at least one section entry.");
  }

  const measuredAt = input.measuredAt ?? new Date().toISOString();
  const recordedAt = input.recordedAt ?? measuredAt;
  const entries: BundleEntry<Resource>[] = [];

  for (const entry of input.entries) {
    const laterality = entry.laterality;
    const bodyStructureFullUrl = `urn:uuid:bs-${laterality.toLowerCase()}`;
    const observationFullUrl = `urn:uuid:obs-${input.section}-${laterality.toLowerCase()}`;
    const bodyStructure = prepareBodyStructure(
      buildEyeBodyStructure(laterality, input.patientReference),
      input.patientReference,
      laterality,
    );
    const locationCode = SNOMED_BY_LATERALITY[laterality];
    const ifNoneExist = `patient=${input.patientReference}&location=${locationCode}`;

    entries.push({
      fullUrl: bodyStructureFullUrl,
      resource: bodyStructure,
      request: {
        method: "POST",
        url: `BodyStructure?${ifNoneExist}&_count=1`,
        ifNoneExist,
      },
    });

    const observation = prepareObservation(
      buildSectionObservation({
        input,
        entry,
        measuredAt,
      }),
      bodyStructureFullUrl,
      input.section,
    );

    entries.push({
      fullUrl: observationFullUrl,
      resource: observation,
      request: {
        method: "POST",
        url: "Observation",
      },
    });

    entries.push({
      fullUrl: `urn:uuid:prov-${input.section}-${laterality.toLowerCase()}`,
      resource: buildCreateProvenance({
        targetReference: observationFullUrl,
        recordedAt,
        occurredDateTime: measuredAt,
        operatorDisplay: input.operatorDisplay,
      }),
      request: {
        method: "POST",
        url: "Provenance",
      },
    });
  }

  return {
    resourceType: "Bundle",
    type: "transaction",
    entry: entries,
  };
}

function buildSectionObservation(input: {
  input: BuildSectionSaveBundleInput;
  entry: SectionSaveEntry;
  measuredAt: string;
}): Observation {
  const common = {
    patientReference: input.input.patientReference,
    encounterReference: input.input.encounterReference,
    eye: input.entry.laterality,
    measuredAt: input.measuredAt,
  };

  switch (input.input.section) {
    case "va": {
      const entry = input.entry as VisualAcuitySectionSaveEntry;
      return buildVisualAcuityObservation({
        ...common,
        snellen: entry.snellen,
        chartType: entry.chartType,
        correction: entry.correction,
        logmar: entry.logmar,
        letterScore: entry.letterScore,
        distance: entry.distance,
        distanceUnit: entry.distanceUnit,
        method: entry.method,
        allowUnparseable: entry.allowUnparseable,
      }).resource;
    }

    case "iop": {
      const entry = input.entry as IopSectionSaveEntry;
      const method = entry.method ?? "UNKNOWN";
      return buildIopObservation({
        ...common,
        value: entry.value,
        unit: "mmHg",
        method: osodConcept(method, method),
      }).resource;
    }

    case "refraction": {
      const entry = input.entry as RefractionSectionSaveEntry;
      return buildRefractionObservation({
        ...common,
        refractionType: entry.refractionType,
        sphere: entry.sphere,
        cylinder: entry.cylinder,
        axis: entry.axis,
        add: entry.add,
        prism: entry.prism,
      }).resource;
    }
  }
}

function prepareObservation(
  observation: Observation,
  bodyStructureFullUrl: string,
  section: SectionSaveSection,
): Observation {
  const originalBodyStructureReference = observation.contained?.find(
    (resource) => resource.resourceType === "BodyStructure",
  )?.id;
  const withoutContained = stripContainedBodyStructures(observation);

  const rewritten = originalBodyStructureReference
    ? rewriteObservationBodyStructureReference(
        withoutContained,
        `#${originalBodyStructureReference}`,
        bodyStructureFullUrl,
      )
    : withoutContained;

  return {
    ...rewritten,
    meta: {
      ...(rewritten.meta ?? {}),
      profile: [SECTION_PROFILE_URLS[section]],
    },
  };
}

function stripContainedBodyStructures(observation: Observation): Observation {
  const contained = observation.contained?.filter(
    (resource) => resource.resourceType !== "BodyStructure",
  );

  return {
    ...observation,
    ...(contained?.length ? { contained } : { contained: undefined }),
  };
}

function prepareBodyStructure(
  bodyStructure: BodyStructure,
  patientReference: string,
  laterality: SectionSaveLaterality,
): BodyStructure {
  const { id: _containedId, ...bodyStructureWithoutId } = bodyStructure;

  return {
    ...bodyStructureWithoutId,
    identifier: [
      ...(bodyStructure.identifier ?? []),
      {
        system: BODY_STRUCTURE_IDENTIFIER_SYSTEM,
        value: `${patientReference}|eye|${laterality}`,
      },
    ],
  };
}

function buildCreateProvenance(input: {
  targetReference: string;
  recordedAt: string;
  occurredDateTime: string;
  operatorDisplay: string;
}): Resource {
  return {
    resourceType: "Provenance",
    target: [{ reference: input.targetReference }],
    recorded: input.recordedAt,
    occurredDateTime: input.occurredDateTime,
    activity: {
      coding: [
        {
          system: "http://terminology.hl7.org/CodeSystem/v3-DataOperation",
          code: "CREATE",
          display: "Create",
        },
      ],
      text: "Create",
    },
    agent: [
      {
        type: {
          coding: [
            {
              system: "http://terminology.hl7.org/CodeSystem/provenance-participant-type",
              code: "author",
              display: "Author",
            },
          ],
          text: "Author",
        },
        who: { display: input.operatorDisplay },
      },
    ],
  };
}
