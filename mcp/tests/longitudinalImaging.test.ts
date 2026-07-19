import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, Media, Provenance, QuestionnaireResponse } from "@medplum/fhirtypes";
import {
  handleLongitudinalImagingCaptureRequest,
  handleLongitudinalImagingListRequest,
  suggestComparisonPair,
  type ImagingEndpointDeps,
  type LongitudinalImageSummary,
} from "../src/clinical-graph/imaging-endpoint.js";
import { buildProcedureDefinitionSeeds } from "../src/clinical-graph/procedure-definition-store.js";
import {
  AESTHETICS_CONSENT_ACKNOWLEDGEMENT_LINK_ID,
  AESTHETICS_COSMETIC_CONSENT_URL,
} from "../src/fhir/aestheticsConsent.js";

const AUTH = "Bearer good";
const DATA = Buffer.from("clinical photo").toString("base64");
const BODY = {
  patientReference: "Patient/p1",
  procedureDefinitionStableKey: buildProcedureDefinitionSeeds()[0]!.stableKey,
  structure: "Lid margin",
  seriesReference: "CarePlan/series-1",
  procedureReference: "Procedure/session-1",
  file: { name: "lid-margin.jpg", contentType: "image/jpeg", data: DATA },
};

class PhotoFhir {
  readonly media: Media[] = [];
  readonly provenances: Provenance[] = [];
  readonly responses: QuestionnaireResponse[] = [];
  readonly sources: string[] = [];
  readonly searches: Array<{ resourceType: string; params: Record<string, string> }> = [];

  async search<T extends Media | QuestionnaireResponse>(
    resourceType: T["resourceType"],
    params: Record<string, string> = {},
  ): Promise<Bundle<T>> {
    this.searches.push({ resourceType, params: { ...params } });
    let rows: Array<Media | QuestionnaireResponse> = resourceType === "Media" ? this.media : this.responses;
    if (resourceType === "Media" && params.subject) {
      rows = rows.filter((resource) => (resource as Media).subject?.reference === params.subject);
    }
    if (resourceType === "QuestionnaireResponse") {
      if (params.patient) rows = rows.filter((resource) => (resource as QuestionnaireResponse).subject?.reference === params.patient);
      if (params.status) rows = rows.filter((resource) => (resource as QuestionnaireResponse).status === params.status);
      if (params.questionnaire) rows = rows.filter((resource) => (resource as QuestionnaireResponse).questionnaire === params.questionnaire);
    }
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: rows.map((resource) => ({ resource: resource as T })),
    };
  }

  async create<T extends Media | Provenance>(resource: T, headers?: Record<string, string>): Promise<T> {
    const persisted = { ...resource, id: `${resource.resourceType.toLowerCase()}-${this.media.length + this.provenances.length + 1}` };
    if (persisted.resourceType === "Media") this.media.unshift(persisted as Media);
    if (persisted.resourceType === "Provenance") this.provenances.push(persisted as Provenance);
    this.sources.push(headers?.["X-ODOS-Source"] ?? "");
    return persisted as T;
  }
}

function deps(fhir: PhotoFhir): ImagingEndpointDeps {
  return {
    authenticate: async (header) => header === AUTH ? {
      staffReference: "Practitioner/doc1",
      actorRole: "clinician",
      fhir,
    } : null,
    procedureDefinitions: buildProcedureDefinitionSeeds,
    now: () => "2026-07-18T15:00:00.000Z",
  };
}

test("longitudinal capture blocks before any Media write when cosmetic consent is absent", async () => {
  const fhir = new PhotoFhir();
  const result = await handleLongitudinalImagingCaptureRequest(deps(fhir), {
    authHeader: AUTH,
    body: BODY,
  });

  assert.equal(result.status, 409);
  assert.match(JSON.stringify(result.body), /consent is required/i);
  assert.equal(fhir.media.length, 0);
  assert.equal(fhir.provenances.length, 0);
});

test("consented capture tags Media to patient, series, session, and structure", async () => {
  const fhir = new PhotoFhir();
  fhir.responses.push(consent());
  fhir.responses.push({ ...consent(), subject: { reference: "Patient/other" } });
  const result = await handleLongitudinalImagingCaptureRequest(deps(fhir), {
    authHeader: AUTH,
    body: BODY,
  });

  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(fhir.media.length, 1);
  assert.equal(fhir.media[0]?.subject?.reference, "Patient/p1");
  assert.equal(fhir.media[0]?.bodySite?.text, "Lid margin");
  assert.equal(fhir.media[0]?.basedOn?.[0]?.reference, "CarePlan/series-1");
  assert.equal(fhir.media[0]?.partOf?.[0]?.reference, "Procedure/session-1");
  assert.equal(fhir.media[0]?.content.data, DATA);
  assert.deepEqual(fhir.sources, ["mcp/longitudinal_imaging", "mcp/longitudinal_imaging"]);
  assert.equal((result.body as { defaultLens: string }).defaultLens, "compare");
  const consentSearch = fhir.searches.find((search) => search.resourceType === "QuestionnaireResponse");
  assert.equal(consentSearch?.params.patient, "Patient/p1");
  assert.equal(consentSearch?.params.status, "completed");
  assert.equal(consentSearch?.params.questionnaire, undefined);
});

test("timeline read returns patient images and suggests the same-series comparison", async () => {
  const fhir = new PhotoFhir();
  fhir.media.push(
    photo("current", "2026-07-18T15:00:00.000Z", "CarePlan/series-1"),
    photo("baseline", "2026-06-18T15:00:00.000Z", "CarePlan/series-1"),
  );
  const result = await handleLongitudinalImagingListRequest(deps(fhir), {
    authHeader: AUTH,
    query: { patient: "Patient/p1" },
  });

  assert.equal(result.status, 200);
  assert.deepEqual((result.body as { suggestedPair: string[] }).suggestedPair, [
    "Media/baseline",
    "Media/current",
  ]);
});

test("pair suggestion prefers matching series and structure over chronology alone", () => {
  const images: LongitudinalImageSummary[] = [
    summary("new", "CarePlan/series-2", "Lid margin"),
    summary("current", "CarePlan/series-1", "Lid margin"),
    summary("other-structure", "CarePlan/series-1", "Full face"),
    summary("baseline", "CarePlan/series-1", "Lid margin"),
  ];
  assert.deepEqual(suggestComparisonPair(images), ["Media/baseline", "Media/current"]);
});

function consent(): QuestionnaireResponse {
  return {
    resourceType: "QuestionnaireResponse",
    status: "completed",
    questionnaire: `${AESTHETICS_COSMETIC_CONSENT_URL}|0.1.0`,
    subject: { reference: "Patient/p1" },
    item: [{
      linkId: AESTHETICS_CONSENT_ACKNOWLEDGEMENT_LINK_ID,
      answer: [{ valueBoolean: true }],
    }],
  };
}

function photo(id: string, createdDateTime: string, seriesReference: string): Media {
  return {
    resourceType: "Media",
    id,
    status: "completed",
    subject: { reference: "Patient/p1" },
    bodySite: { text: "Lid margin" },
    basedOn: [{ reference: seriesReference }],
    createdDateTime,
    note: [{ text: `Procedure definition: ${BODY.procedureDefinitionStableKey}` }],
    content: { contentType: "image/jpeg", data: DATA, title: `${id}.jpg` },
  };
}

function summary(id: string, seriesReference: string, structure: string): LongitudinalImageSummary {
  return {
    mediaReference: `Media/${id}`,
    createdAt: "2026-07-18T15:00:00.000Z",
    title: `${id}.jpg`,
    contentType: "image/jpeg",
    data: DATA,
    structure,
    seriesReference,
  };
}
