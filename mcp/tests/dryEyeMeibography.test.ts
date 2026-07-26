import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  Bundle,
  DocumentReference,
  Observation,
  Provenance,
  Resource,
} from "@medplum/fhirtypes";
import {
  handleDryEyeMeibographyCaptureRequest,
  handleDryEyeMeibographyListRequest,
  type DryEyeMeibographyFhirClient,
} from "../src/clinical-graph/dry-eye-meibography-endpoint.js";
import { buildMeibographyObservation } from "../src/fhir/meibography.js";

const AUTH = "Bearer good";
const NOW = "2026-07-26T18:00:00.000Z";

test("dry-eye gland structure writes the exact shared meibography Observation shape and reads it back", async () => {
  const fhir = new MemoryFhir();
  const captured = await handleDryEyeMeibographyCaptureRequest(deps(fhir), {
    authHeader: AUTH,
    body: {
      patientReference: "Patient/dry-eye-1",
      encounterReference: "Encounter/dry-eye-1",
      eye: "OD",
      lid: "upper",
      scoringSystem: "meiboscore",
      totalScore: 4,
      glandScores: [1, 2, 1],
      file: {
        name: "synthetic-meibography.png",
        contentType: "image/png",
        data: "iVBORw==",
      },
    },
  });
  assert.equal(captured.status, 201, JSON.stringify(captured.body));
  const body = captured.body as {
    documentReference: DocumentReference;
    observation: Observation;
    provenanceReference: string;
  };
  assert.ok(body.documentReference.id);
  assert.ok(body.observation.id);
  const expected = buildMeibographyObservation({
    patientReference: "Patient/dry-eye-1",
    encounterReference: "Encounter/dry-eye-1",
    documentReference: `DocumentReference/${body.documentReference.id}`,
    eye: "OD",
    lid: "upper",
    scoringSystem: "meiboscore",
    totalScore: 4,
    glandScores: [1, 2, 1],
    effectiveDateTime: NOW,
  });
  const { id: _id, ...actualShape } = body.observation;
  assert.deepEqual(actualShape, expected);
  assert.deepEqual(
    fhir.writes.map((write) => [write.resourceType, write.source]),
    [
      ["DocumentReference", "mcp/create_meibography_observation"],
      ["Observation", "mcp/create_meibography_observation"],
      ["Provenance", "mcp/create_meibography_observation"],
    ],
  );

  const listed = await handleDryEyeMeibographyListRequest(deps(fhir), {
    authHeader: AUTH,
    query: { patient: "Patient/dry-eye-1" },
  });
  assert.equal(listed.status, 200);
  assert.deepEqual((listed.body as { rows: unknown[] }).rows, [{
    observationReference: body.observation.id
      ? `Observation/${body.observation.id}`
      : undefined,
    documentReference: `DocumentReference/${body.documentReference.id}`,
    recordedAt: NOW,
    eye: "OD",
    lid: "upper",
    score: 4,
    scoringSystem: "meiboscore",
    contentType: "image/png",
    data: "iVBORw==",
    title: "synthetic-meibography.png",
  }]);
});

class MemoryFhir implements DryEyeMeibographyFhirClient {
  readonly resources: Resource[] = [];
  readonly writes: Array<{ resourceType: string; source?: string }> = [];

  async create<T extends DocumentReference | Observation | Provenance>(
    resource: T,
    headers?: Record<string, string>,
  ): Promise<T> {
    const saved = {
      ...resource,
      id: `${resource.resourceType.toLowerCase()}-${this.resources.length + 1}`,
    };
    this.resources.push(saved);
    this.writes.push({
      resourceType: resource.resourceType,
      source: headers?.["X-ODOS-Source"],
    });
    return saved as T;
  }

  async read<T extends Resource>(
    resourceType: T["resourceType"],
    id: string,
  ): Promise<T> {
    const resource = this.resources.find(
      (candidate) => candidate.resourceType === resourceType && candidate.id === id,
    );
    if (!resource) throw new Error(`${resourceType}/${id} not found`);
    return resource as T;
  }

  async search<T extends Resource>(
    resourceType: T["resourceType"],
    params: Record<string, string> = {},
  ): Promise<Bundle<T>> {
    const resources = this.resources.filter((resource) =>
      resource.resourceType === resourceType &&
      (
        resource.resourceType !== "Observation" ||
        resource.subject?.reference === params.subject
      )
    );
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: resources.map((resource) => ({ resource: resource as T })),
    };
  }
}

function deps(fhir: MemoryFhir) {
  return {
    authenticate: async (authHeader: string | undefined) => authHeader === AUTH
      ? {
          staffReference: "Practitioner/dry-eye-doc",
          actorRole: "clinician" as const,
          fhir,
        }
      : null,
    now: () => NOW,
  };
}
