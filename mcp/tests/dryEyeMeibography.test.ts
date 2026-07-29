import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  handleDryEyeMeibographyImageRequest,
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
  const rows = (listed.body as { rows: Array<Record<string, unknown>> }).rows;
  assert.deepEqual(rows, [{
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
    title: "synthetic-meibography.png",
    size: undefined,
    imageUrl:
      `/clinical-graph/dry-eye/meibography/image?patient=Patient%2Fdry-eye-1&document=DocumentReference%2F${body.documentReference.id}`,
  }]);
  assert.equal(Object.hasOwn(rows[0]!, "data"), false);

  const image = await handleDryEyeMeibographyImageRequest(deps(fhir), {
    authHeader: AUTH,
    query: {
      patient: "Patient/dry-eye-1",
      document: `DocumentReference/${body.documentReference.id}`,
    },
  });
  assert.deepEqual(image, {
    status: 200,
    body: {
      contentType: "image/png",
      data: "iVBORw==",
      title: "synthetic-meibography.png",
    },
  });
});

test("meibography capture distinguishes input validation from upstream persistence failures", async () => {
  const invalid = new MemoryFhir();
  const invalidResult = await handleDryEyeMeibographyCaptureRequest(deps(invalid), {
    authHeader: AUTH,
    body: captureBody({ totalScore: 99 }),
  });
  assert.equal(invalidResult.status, 400);
  assert.equal(invalid.writes.length, 0);

  const unavailable = new MemoryFhir();
  unavailable.failCreate = true;
  const unavailableResult = await handleDryEyeMeibographyCaptureRequest(
    deps(unavailable),
    {
      authHeader: AUTH,
      body: captureBody(),
    },
  );
  assert.equal(unavailableResult.status, 502);
  assert.match(
    (unavailableResult.body as { error: string }).error,
    /persistence failed: synthetic FHIR unavailable/,
  );

  const missingId = new MemoryFhir();
  missingId.omitIdFor = "DocumentReference";
  const missingIdResult = await handleDryEyeMeibographyCaptureRequest(
    deps(missingId),
    {
      authHeader: AUTH,
      body: captureBody(),
    },
  );
  assert.equal(missingIdResult.status, 502);
  assert.match(
    (missingIdResult.body as { error: string }).error,
    /DocumentReference create response did not include an id/,
  );
});

test("meibography capture rejects a decoded payload one byte above 1 MiB", async () => {
  const fhir = new MemoryFhir();
  const result = await handleDryEyeMeibographyCaptureRequest(deps(fhir), {
    authHeader: AUTH,
    body: captureBody({
      file: {
        name: "oversized-meibography.png",
        contentType: "image/png",
        data: Buffer.alloc(1 * 1024 * 1024 + 1).toString("base64"),
      },
    }),
  });
  assert.deepEqual(result, {
    status: 400,
    body: { error: "Meibography images may not exceed 1 MB." },
  });
  assert.equal(fhir.writes.length, 0);
});

test("meibography history keeps score metadata when one image read fails", async () => {
  const fhir = new MemoryFhir();
  const captured = await handleDryEyeMeibographyCaptureRequest(deps(fhir), {
    authHeader: AUTH,
    body: captureBody(),
  });
  const documentReference = (captured.body as {
    documentReference: DocumentReference;
  }).documentReference;
  fhir.failReads.add(`DocumentReference/${documentReference.id}`);
  const listed = await handleDryEyeMeibographyListRequest(deps(fhir), {
    authHeader: AUTH,
    query: { patient: "Patient/dry-eye-1" },
  });
  assert.equal(listed.status, 200);
  assert.deepEqual(
    (listed.body as { rows: Array<Record<string, unknown>> }).rows,
    [{
      observationReference: "Observation/observation-2",
      documentReference: `DocumentReference/${documentReference.id}`,
      recordedAt: NOW,
      eye: "OD",
      lid: "upper",
      score: 4,
      scoringSystem: "meiboscore",
      contentType: undefined,
      title: undefined,
      size: undefined,
      imageUnavailable: true,
    }],
  );
});

test("the meibography upload parser overrides the global four-megabyte JSON limit", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const scoped = source.indexOf(
    '"/clinical-graph/dry-eye/meibography",\n        express.json({ limit: "21mb" })',
  );
  const global = source.indexOf('app.use(express.json({ limit: "4mb" }))');
  assert.notEqual(scoped, -1);
  assert.ok(scoped < global);
});

class MemoryFhir implements DryEyeMeibographyFhirClient {
  readonly resources: Resource[] = [];
  readonly writes: Array<{ resourceType: string; source?: string }> = [];
  readonly failReads = new Set<string>();
  failCreate = false;
  omitIdFor: Resource["resourceType"] | undefined;

  async create<T extends DocumentReference | Observation | Provenance>(
    resource: T,
    headers?: Record<string, string>,
  ): Promise<T> {
    if (this.failCreate) throw new Error("synthetic FHIR unavailable");
    const saved = {
      ...resource,
      ...(this.omitIdFor === resource.resourceType
        ? {}
        : { id: `${resource.resourceType.toLowerCase()}-${this.resources.length + 1}` }),
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
    if (this.failReads.has(`${resourceType}/${id}`)) {
      throw new Error("synthetic FHIR unavailable");
    }
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

function captureBody(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
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
