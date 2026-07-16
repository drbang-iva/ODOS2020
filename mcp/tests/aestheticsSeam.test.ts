import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  Basic,
  Bundle,
  Procedure,
  Provenance,
  QuestionnaireResponse,
} from "@medplum/fhirtypes";
import {
  handleAestheticsConsentDefinitionRequest,
  handleAestheticsConsentSubmissionRequest,
} from "../src/clinical-graph/aesthetics-consent-endpoint.js";
import {
  handleProcedureDefinitionCaptureRequest,
  handleProcedureDefinitionCatalogRequest,
  handleProcedureDefinitionHistoryRequest,
  handleProcedureDefinitionMutationRequest,
} from "../src/clinical-graph/procedure-definition-endpoint.js";
import {
  AESTHETICS_PROCEDURE_TYPE_SYSTEM,
  FhirProcedureDefinitionStore,
  PROCEDURE_DEFINITION_WRITE_HEADERS,
  buildProcedureDefinitionResource,
  buildProcedureDefinitionSeeds,
  parseProcedureDefinitionResource,
} from "../src/clinical-graph/procedure-definition-store.js";
import {
  AESTHETICS_COSMETIC_CONSENT_URL,
} from "../src/fhir/aestheticsConsent.js";
import type { PracticeRoleId } from "../src/authz/roles.js";

const AUTH = "Bearer good";
const NOW = "2026-07-16T12:00:00.000Z";

class MemoryFhir {
  readonly basics: Basic[] = [];
  readonly procedures: Procedure[] = [];
  readonly questionnaireResponses: QuestionnaireResponse[] = [];
  readonly provenances: Provenance[] = [];
  readonly writes: Array<{ resourceType: string; source?: string }> = [];

  async search<T extends Basic | Procedure>(
    resourceType: T["resourceType"],
    params?: Record<string, string>,
  ): Promise<Bundle<T>> {
    const rows = resourceType === "Basic"
      ? this.basics
      : this.procedures.filter((procedure) => {
          if (params?.subject && procedure.subject.reference !== params.subject) return false;
          if (params?.encounter && procedure.encounter?.reference !== params.encounter) return false;
          if (params?.code) {
            const [system, code] = params.code.split("|");
            if (!procedure.code?.coding?.some((coding) =>
              coding.system === system && coding.code === code
            )) return false;
          }
          return true;
        });
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: rows.map((resource) => ({ resource: resource as T })),
    };
  }

  async create<T extends Basic | Procedure | Provenance | QuestionnaireResponse>(
    resource: T,
    headers?: Record<string, string>,
  ): Promise<T> {
    const persisted = {
      ...resource,
      id: resource.id ?? `${resource.resourceType.toLowerCase()}-${this.writes.length + 1}`,
    };
    if (persisted.resourceType === "Basic") this.basics.push(persisted);
    if (persisted.resourceType === "Procedure") this.procedures.push(persisted);
    if (persisted.resourceType === "QuestionnaireResponse") {
      this.questionnaireResponses.push(persisted);
    }
    if (persisted.resourceType === "Provenance") this.provenances.push(persisted);
    this.writes.push({
      resourceType: persisted.resourceType,
      source: headers?.["X-OSOD-Source"],
    });
    return persisted as T;
  }

  async update<T extends Basic>(
    _resourceType: T["resourceType"],
    id: string,
    resource: T,
    headers?: Record<string, string>,
  ): Promise<T> {
    const index = this.basics.findIndex((candidate) => candidate.id === id);
    if (index < 0) throw new Error(`Missing Basic/${id}`);
    const persisted = { ...resource, id };
    this.basics[index] = persisted;
    this.writes.push({
      resourceType: persisted.resourceType,
      source: headers?.["X-OSOD-Source"],
    });
    return persisted;
  }
}

test("three aesthetics procedure types are seeded as procedure-definition data and round-trip through Basic", () => {
  const seeds = buildProcedureDefinitionSeeds();
  assert.deepEqual(
    seeds.map((definition) => definition.display),
    [
      "Neurotoxin injection — glabella",
      "Dermal filler — nasolabial fold",
      "Chemical peel — full face",
    ],
  );
  for (const seed of seeds) {
    assert.equal(seed.discipline, "aesthetics");
    assert.equal(seed.sourceStatus, "verified-seed");
    assert.equal(seed.notBillReady, true);
    assert.equal(seed.fhirProcedureCode.coding, undefined);
    assert.equal("system" in seed.fhirProcedureCode && seed.fhirProcedureCode.system, AESTHETICS_PROCEDURE_TYPE_SYSTEM);
    const local = {
      ...seed,
      sourceStatus: "local-practice" as const,
      provenance: {
        ...seed.provenance,
        recordedAt: NOW,
        actorReference: "Practitioner/admin-1",
      },
    };
    assert.deepEqual(parseProcedureDefinitionResource(buildProcedureDefinitionResource(local)), local);
  }
});

test("the procedure-definition endpoint serves the same persisted data store used by captures", async () => {
  const fhir = new MemoryFhir();
  const store = new FhirProcedureDefinitionStore(fhir);
  const seed = buildProcedureDefinitionSeeds()[0]!;
  const mutation = await handleProcedureDefinitionMutationRequest(
    deps("practice-admin", fhir, await store.list()),
    {
      authHeader: AUTH,
      params: { stableKey: seed.stableKey },
      body: {
        action: "update-definition",
        display: "Local glabella neurotoxin",
      },
    },
  );
  assert.equal(mutation.status, 200);
  const definitions = await store.list();
  const catalog = await handleProcedureDefinitionCatalogRequest(
    deps("aesthetics-provider", fhir, definitions),
    { authHeader: AUTH },
  );
  assert.equal(catalog.status, 200);
  const rows = (catalog.body as {
    definitions: Array<{ stableKey: string; display: string; sourceStatus: string }>;
  }).definitions;
  assert.equal(rows.length, 3);
  assert.equal(rows[0]?.display, "Local glabella neurotoxin");
  assert.equal(rows[0]?.sourceStatus, "local-practice");
  assert.deepEqual(fhir.writes[0], {
    resourceType: "Basic",
    source: PROCEDURE_DEFINITION_WRITE_HEADERS["X-OSOD-Source"],
  });
});

test("an aesthetics procedure definition constructs and persists a shared-Patient FHIR Procedure", async () => {
  const fhir = new MemoryFhir();
  const definitions = buildProcedureDefinitionSeeds();
  const stableKey = definitions[0]!.stableKey;
  const result = await handleProcedureDefinitionCaptureRequest(
    deps("aesthetics-provider", fhir, definitions),
    {
      authHeader: AUTH,
      params: { stableKey },
      body: {
        patientReference: "Patient/shared-1",
        encounterReference: "Encounter/aesthetics-1",
        performedDateTime: NOW,
      },
    },
  );
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(fhir.procedures.length, 1);
  assert.equal(fhir.procedures[0]?.subject.reference, "Patient/shared-1");
  assert.equal(fhir.procedures[0]?.encounter?.reference, "Encounter/aesthetics-1");
  assert.equal(fhir.procedures[0]?.code?.coding?.[0]?.system, AESTHETICS_PROCEDURE_TYPE_SYSTEM);
  assert.equal(fhir.procedures[0]?.code?.coding?.[0]?.code, "neurotoxin-injection-glabella");
  assert.equal(fhir.provenances[0]?.target?.[1]?.reference, "Patient/shared-1");

  const history = await handleProcedureDefinitionHistoryRequest(
    deps("aesthetics-provider", fhir, definitions),
    {
      authHeader: AUTH,
      params: { stableKey },
      query: { patient: "Patient/shared-1", encounter: "Encounter/aesthetics-1" },
    },
  );
  assert.equal(history.status, 200);
  assert.equal((history.body as { rows: unknown[] }).rows.length, 1);
});

test("cosmetic consent persists as QuestionnaireResponse on the existing shared Patient", async () => {
  const fhir = new MemoryFhir();
  const definition = await handleAestheticsConsentDefinitionRequest(
    deps("aesthetics-provider", fhir, buildProcedureDefinitionSeeds()),
    { authHeader: AUTH },
  );
  assert.equal(definition.status, 200);

  const result = await handleAestheticsConsentSubmissionRequest(
    deps("aesthetics-provider", fhir, buildProcedureDefinitionSeeds()),
    {
      authHeader: AUTH,
      body: {
        patientReference: "Patient/shared-1",
        encounterReference: "Encounter/aesthetics-1",
        acknowledged: true,
      },
    },
  );
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(fhir.questionnaireResponses.length, 1);
  assert.equal(fhir.questionnaireResponses[0]?.questionnaire, AESTHETICS_COSMETIC_CONSENT_URL);
  assert.equal(fhir.questionnaireResponses[0]?.subject?.reference, "Patient/shared-1");
  assert.equal(fhir.questionnaireResponses[0]?.encounter?.reference, "Encounter/aesthetics-1");
  assert.equal(fhir.questionnaireResponses[0]?.item?.[0]?.answer?.[0]?.valueBoolean, true);
  assert.equal(fhir.provenances[0]?.target?.[1]?.reference, "Patient/shared-1");
});

function deps(
  role: PracticeRoleId,
  fhir: MemoryFhir,
  procedureDefinitions: ReturnType<typeof buildProcedureDefinitionSeeds>,
) {
  return {
    authenticate: async (authHeader: string | undefined) => authHeader === AUTH
      ? {
          staffReference: "Practitioner/aesthetics-1",
          actorRole: role,
          fhir,
        }
      : null,
    procedureDefinitions: () => procedureDefinitions,
    now: () => NOW,
  };
}
