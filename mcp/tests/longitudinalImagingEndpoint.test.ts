import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  Bundle,
  CarePlan,
  Encounter,
  Media,
  Provenance,
  QuestionnaireResponse,
} from "@medplum/fhirtypes";
import {
  handleLongitudinalImagingCaptureRequest,
  handleLongitudinalImagingListRequest,
  suggestComparisonPair,
  type LongitudinalImagingEndpointDeps,
  type LongitudinalPhotoSummary,
} from "../src/clinical-graph/longitudinal-imaging-endpoint.js";
import { buildProcedureDefinitionSeeds } from "../src/clinical-graph/procedure-definition-store.js";
import { buildClinicalPhotographyConsentQuestionnaireResponse } from "../src/fhir/aestheticsConsent.js";

const AUTH = "Bearer good";
const NOW = "2026-07-18T15:00:00.000Z";
const DATA = Buffer.from("clinical-photo").toString("base64");
const BODY = {
  patientReference: "Patient/p1",
  encounterReference: "Encounter/e1",
  procedureDefinitionStableKey: buildProcedureDefinitionSeeds()[0]!.stableKey,
  structure: "Upper eyelids",
  source: "device-import" as const,
  file: {
    name: "upper-lids.png",
    contentType: "image/png",
    data: DATA,
  },
};

class MemoryFhir {
  readonly created: Array<Media | Provenance> = [];
  readonly media: Media[] = [];
  readonly questionnaireResponses: QuestionnaireResponse[] = [];
  readonly encounters: Encounter[] = [{
    resourceType: "Encounter",
    id: "e1",
    status: "finished",
    class: { code: "AMB" },
    subject: { reference: "Patient/p1" },
  }];
  readonly carePlans: CarePlan[] = [{
    resourceType: "CarePlan",
    id: "series-1",
    status: "active",
    intent: "plan",
    subject: { reference: "Patient/p1" },
  }];

  async create<T extends Media | Provenance>(resource: T): Promise<T> {
    const persisted = { ...resource, id: `${resource.resourceType.toLowerCase()}-${this.created.length + 1}` };
    this.created.push(persisted);
    if (persisted.resourceType === "Media") this.media.push(persisted);
    return persisted as T;
  }

  async read<T extends CarePlan | Encounter>(resourceType: T["resourceType"], id: string): Promise<T> {
    const resource = resourceType === "Encounter"
      ? this.encounters.find((candidate) => candidate.id === id)
      : this.carePlans.find((candidate) => candidate.id === id);
    if (!resource) throw new Error(`Missing ${resourceType}/${id}`);
    return resource as T;
  }

  async search<T extends CarePlan | Media | QuestionnaireResponse>(
    resourceType: T["resourceType"],
    params?: Record<string, string>,
  ): Promise<Bundle<T>> {
    const rows = resourceType === "Media"
      ? this.media.filter((media) => !params?.patient || media.subject?.reference === params.patient)
      : resourceType === "CarePlan"
      ? this.carePlans.filter((carePlan) =>
          (!params?.subject || carePlan.subject?.reference === params.subject) &&
          (!params?.status || carePlan.status === params.status)
        )
      : this.questionnaireResponses.filter((response) =>
          (!params?.subject || response.subject?.reference === params.subject) &&
          (!params?.status || response.status === params.status)
        );
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: rows.map((resource) => ({ resource: resource as T })),
    };
  }
}

function deps(fhir: MemoryFhir): LongitudinalImagingEndpointDeps {
  return {
    authenticate: async (header) => header === AUTH
      ? {
          staffReference: "Practitioner/doc1",
          actorRole: "clinician",
          fhir,
        }
      : null,
    procedureDefinitions: () => buildProcedureDefinitionSeeds(),
    now: () => NOW,
  };
}

function addConsent(fhir: MemoryFhir): void {
  fhir.questionnaireResponses.push({
    ...buildClinicalPhotographyConsentQuestionnaireResponse({
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      acknowledged: true,
      authored: NOW,
    }),
    id: "photo-consent-1",
  });
}

test("capture is blocked before any Media write when photography consent is absent", async () => {
  const fhir = new MemoryFhir();
  const result = await handleLongitudinalImagingCaptureRequest(deps(fhir), {
    authHeader: AUTH,
    body: BODY,
  });

  assert.equal(result.status, 412);
  assert.match(JSON.stringify(result.body), /photography consent is required/i);
  assert.equal(fhir.created.length, 0);
});

test("device import writes patient, encounter, free-text structure, date, and optional CarePlan tags", async () => {
  const fhir = new MemoryFhir();
  addConsent(fhir);
  const result = await handleLongitudinalImagingCaptureRequest(deps(fhir), {
    authHeader: AUTH,
    body: { ...BODY, seriesReference: "CarePlan/series-1" },
  });

  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.deepEqual(fhir.created.map((resource) => resource.resourceType), ["Media", "Provenance"]);
  const media = fhir.created[0] as Media;
  assert.equal(media.subject?.reference, "Patient/p1");
  assert.equal(media.encounter?.reference, "Encounter/e1");
  assert.equal(media.bodySite?.text, "Upper eyelids");
  assert.equal(media.createdDateTime, NOW);
  assert.equal(media.basedOn?.[0]?.reference, "CarePlan/series-1");
  assert.equal(media.content.contentType, "image/png");
  assert.equal((result.body as { defaultLens: string }).defaultLens, "compare");
});

test("a missing optional CarePlan is ignored without losing the photo", async () => {
  const fhir = new MemoryFhir();
  addConsent(fhir);
  const result = await handleLongitudinalImagingCaptureRequest(deps(fhir), {
    authHeader: AUTH,
    body: { ...BODY, seriesReference: "CarePlan/not-installed" },
  });

  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal((fhir.created[0] as Media).basedOn, undefined);
  assert.equal((result.body as { seriesLinked: boolean }).seriesLinked, false);
});

test("a single active Slice-4 CarePlan with the matching procedure code auto-links", async () => {
  const fhir = new MemoryFhir();
  addConsent(fhir);
  fhir.carePlans[0]!.instantiatesCanonical = [
    "https://odos2020.com/fhir/PlanDefinition/series-protocol-neurotoxin",
  ];
  fhir.carePlans[0]!.activity = [{
    detail: {
      status: "not-started",
      code: { coding: [{ code: "neurotoxin-injection-glabella" }] },
    },
  }];

  const result = await handleLongitudinalImagingCaptureRequest(deps(fhir), {
    authHeader: AUTH,
    body: BODY,
  });

  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal((fhir.created[0] as Media).basedOn?.[0]?.reference, "CarePlan/series-1");
  assert.equal((result.body as { seriesLinked: boolean }).seriesLinked, true);
});

test("timeline retrieval returns chronological images and a first/last series suggestion", async () => {
  const fhir = new MemoryFhir();
  fhir.media.push(
    photo("one", "2026-01-01T10:00:00Z", "CarePlan/series-1"),
    photo("two", "2026-04-01T10:00:00Z", "CarePlan/series-1"),
    photo("three", "2026-07-01T10:00:00Z", "CarePlan/series-1"),
  );
  const result = await handleLongitudinalImagingListRequest(deps(fhir), {
    authHeader: AUTH,
    query: {
      patient: "Patient/p1",
      structure: "upper EYELIDS",
      procedureDefinitionStableKey: BODY.procedureDefinitionStableKey,
    },
  });

  assert.equal(result.status, 200, JSON.stringify(result.body));
  const body = result.body as {
    photos: LongitudinalPhotoSummary[];
    suggestedPair: { first: string; second: string; source: string };
    defaultLens: string;
  };
  assert.deepEqual(body.photos.map((item) => item.mediaReference), ["Media/one", "Media/two", "Media/three"]);
  assert.deepEqual(body.suggestedPair, {
    first: "Media/one",
    second: "Media/three",
    source: "series",
    seriesReference: "CarePlan/series-1",
  });
  assert.equal(body.defaultLens, "compare");
});

test("comparison falls back to the two most recent images of the same structure", () => {
  const pair = suggestComparisonPair([
    summary("one", "2026-01-01T10:00:00Z", "Meibomian glands"),
    summary("other", "2026-02-01T10:00:00Z", "Upper eyelids"),
    summary("two", "2026-03-01T10:00:00Z", "Meibomian glands"),
    summary("three", "2026-04-01T10:00:00Z", "Meibomian glands"),
  ]);
  assert.deepEqual(pair, {
    first: "Media/two",
    second: "Media/three",
    source: "recent",
  });
});

function photo(id: string, recordedAt: string, seriesReference?: string): Media {
  return {
    resourceType: "Media",
    id,
    status: "completed",
    modality: { coding: [{ code: "longitudinal-clinical-photo" }] },
    subject: { reference: "Patient/p1" },
    encounter: { reference: "Encounter/e1" },
    ...(seriesReference ? { basedOn: [{ reference: seriesReference }] } : {}),
    bodySite: { text: "Upper eyelids" },
    createdDateTime: recordedAt,
    content: {
      contentType: "image/png",
      data: DATA,
      title: `${id}.png`,
    },
  };
}

function summary(id: string, recordedAt: string, structure: string): LongitudinalPhotoSummary {
  return {
    mediaReference: `Media/${id}`,
    recordedAt,
    title: `${id}.png`,
    contentType: "image/png",
    dataUrl: `data:image/png;base64,${DATA}`,
    structure,
  };
}
