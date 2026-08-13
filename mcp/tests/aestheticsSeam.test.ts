import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  Basic,
  Bundle,
  Encounter,
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
import { ODOS_DISCIPLINE_SYSTEM } from "../src/scheduling/clinic-mode.js";

const AUTH = "Bearer good";
const NOW = "2026-07-16T12:00:00.000Z";

class MemoryFhir {
  readonly basics: Basic[] = [];
  readonly encounters: Encounter[] = [{
    resourceType: "Encounter",
    id: "aesthetics-1",
    status: "in-progress",
    class: { code: "AMB" },
    subject: { reference: "Patient/shared-1" },
    serviceType: {
      coding: [{ system: ODOS_DISCIPLINE_SYSTEM, code: "aesthetics" }],
    },
  }];
  readonly procedures: Procedure[] = [];
  readonly questionnaireResponses: QuestionnaireResponse[] = [];
  readonly provenances: Provenance[] = [];
  readonly writes: Array<{ resourceType: string; source?: string }> = [];
  encounterReadError?: Error;

  async read<T extends Encounter>(
    _resourceType: T["resourceType"],
    id: string,
  ): Promise<T> {
    if (this.encounterReadError) throw this.encounterReadError;
    const encounter = this.encounters.find((candidate) => candidate.id === id);
    if (!encounter) throw new Error(`Missing Encounter/${id}`);
    return encounter as T;
  }

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
      source: headers?.["X-ODOS-Source"],
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
      source: headers?.["X-ODOS-Source"],
    });
    return persisted;
  }
}

test("three aesthetics procedure types are seeded as procedure-definition data and round-trip through Basic", () => {
  const seeds = buildProcedureDefinitionSeeds().filter((definition) =>
    definition.discipline === "aesthetics"
  );
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
    assert.equal(seed.photo_posture, "compare");
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

test("procedure definitions reject an empty FHIR procedure code and accept a valid CodeableConcept coding", () => {
  const seed = buildProcedureDefinitionSeeds()[0]!;
  const local = {
    ...seed,
    sourceStatus: "local-practice" as const,
    provenance: { ...seed.provenance, recordedAt: NOW },
  };

  assert.throws(
    () => buildProcedureDefinitionResource({ ...local, fhirProcedureCode: {} as never }),
    /requires a searchable FHIR coding/,
  );
  assert.throws(
    () => buildProcedureDefinitionResource({
      ...local,
      fhirProcedureCode: {
        system: AESTHETICS_PROCEDURE_TYPE_SYSTEM,
        code: "hidden-by-empty-coding",
        coding: [],
      } as never,
    }),
    /requires a searchable FHIR coding/,
  );
  assert.doesNotThrow(() => buildProcedureDefinitionResource({
    ...local,
    fhirProcedureCode: {
      coding: [{ system: AESTHETICS_PROCEDURE_TYPE_SYSTEM, code: "local-neurotoxin" }],
    },
  }));
});

test("the procedure-definition endpoint serves the same persisted data store used by captures", async () => {
  const fhir = new MemoryFhir();
  const store = new FhirProcedureDefinitionStore(fhir);
  const seed = buildProcedureDefinitionSeeds()[0]!;
  const mutation = await handleProcedureDefinitionMutationRequest(
    deps("admin", fhir, await store.list()),
    {
      authHeader: AUTH,
      params: { stableKey: seed.stableKey },
      body: {
        action: "update-definition",
        display: "Local glabella neurotoxin",
        photo_posture: "timeline",
      },
    },
  );
  assert.equal(mutation.status, 200);
  const definitions = await store.list();
  const catalog = await handleProcedureDefinitionCatalogRequest(
    deps("provider", fhir, definitions),
    { authHeader: AUTH },
  );
  assert.equal(catalog.status, 200);
  const rows = (catalog.body as {
    definitions: Array<{ stableKey: string; display: string; sourceStatus: string }>;
  }).definitions;
  assert.equal(rows.length, buildProcedureDefinitionSeeds().length);
  assert.equal(rows[0]?.display, "Local glabella neurotoxin");
  assert.equal(rows[0]?.sourceStatus, "local-practice");
  assert.equal((rows[0] as unknown as { photo_posture: string }).photo_posture, "timeline");
  assert.deepEqual(fhir.writes[0], {
    resourceType: "Basic",
    source: PROCEDURE_DEFINITION_WRITE_HEADERS["X-ODOS-Source"],
  });
});

test("an aesthetics procedure definition constructs and persists a shared-Patient FHIR Procedure", async () => {
  const fhir = new MemoryFhir();
  const definitions = buildProcedureDefinitionSeeds();
  const stableKey = definitions[0]!.stableKey;
  const result = await handleProcedureDefinitionCaptureRequest(
    deps("provider", fhir, definitions),
    {
      authHeader: AUTH,
      params: { stableKey },
      body: {
        patientReference: "Patient/shared-1",
        encounterReference: "Encounter/aesthetics-1",
        performedDateTime: NOW,
        remarks: "  Applied conservatively after discussing expected effect.  ",
      },
    },
  );
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(fhir.procedures.length, 1);
  assert.equal(fhir.procedures[0]?.subject.reference, "Patient/shared-1");
  assert.equal(fhir.procedures[0]?.encounter?.reference, "Encounter/aesthetics-1");
  assert.equal(fhir.procedures[0]?.code?.coding?.[0]?.system, AESTHETICS_PROCEDURE_TYPE_SYSTEM);
  assert.equal(fhir.procedures[0]?.code?.coding?.[0]?.code, "neurotoxin-injection-glabella");
  assert.equal(
    fhir.procedures[0]?.note?.[0]?.text,
    "Applied conservatively after discussing expected effect.",
  );
  assert.equal(fhir.provenances[0]?.target?.[1]?.reference, "Patient/shared-1");

  const history = await handleProcedureDefinitionHistoryRequest(
    deps("provider", fhir, definitions),
    {
      authHeader: AUTH,
      params: { stableKey },
      query: { patient: "Patient/shared-1", encounter: "Encounter/aesthetics-1" },
    },
  );
  assert.equal(history.status, 200);
  const rows = (history.body as { rows: Array<{ remarks?: string }> }).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.remarks, "Applied conservatively after discussing expected effect.");
});

test("procedure capture rejects mismatched and unreadable Encounters before writing", async () => {
  const definitions = buildProcedureDefinitionSeeds();
  const stableKey = definitions[0]!.stableKey;
  const mismatched = new MemoryFhir();
  mismatched.encounters[0]!.subject = { reference: "Patient/different" };
  const mismatch = await handleProcedureDefinitionCaptureRequest(
    deps("provider", mismatched, definitions),
    {
      authHeader: AUTH,
      params: { stableKey },
      body: {
        patientReference: "Patient/shared-1",
        encounterReference: "Encounter/aesthetics-1",
      },
    },
  );
  assert.equal(mismatch.status, 422);
  assert.match(JSON.stringify(mismatch.body), /does not belong to Patient\/shared-1/);
  assert.equal(mismatched.writes.length, 0);

  const unreadable = new MemoryFhir();
  unreadable.encounterReadError = new Error("FHIR unavailable");
  const readFailure = await handleProcedureDefinitionCaptureRequest(
    deps("provider", unreadable, definitions),
    {
      authHeader: AUTH,
      params: { stableKey },
      body: {
        patientReference: "Patient/shared-1",
        encounterReference: "Encounter/aesthetics-1",
      },
    },
  );
  assert.equal(readFailure.status, 422);
  assert.match(JSON.stringify(readFailure.body), /Encounter could not be read/);
  assert.equal(unreadable.writes.length, 0);
});

test("procedure capture rejects an eyecare Encounter before writing", async () => {
  const fhir = new MemoryFhir();
  fhir.encounters[0]!.serviceType = {
    coding: [{ system: ODOS_DISCIPLINE_SYSTEM, code: "eyecare" }],
  };
  const definitions = buildProcedureDefinitionSeeds();
  const result = await handleProcedureDefinitionCaptureRequest(
    deps("provider", fhir, definitions),
    {
      authHeader: AUTH,
      params: { stableKey: definitions[0]!.stableKey },
      body: {
        patientReference: "Patient/shared-1",
        encounterReference: "Encounter/aesthetics-1",
      },
    },
  );

  assert.deepEqual(result, {
    status: 422,
    body: { error: "Encounter/aesthetics-1 is not an aesthetics Encounter." },
  });
  assert.equal(fhir.writes.length, 0);
});

test("cosmetic consent persists as QuestionnaireResponse on the existing shared Patient", async () => {
  const fhir = new MemoryFhir();
  const definition = await handleAestheticsConsentDefinitionRequest(
    deps("provider", fhir, buildProcedureDefinitionSeeds()),
    { authHeader: AUTH },
  );
  assert.equal(definition.status, 200);

  const result = await handleAestheticsConsentSubmissionRequest(
    deps("provider", fhir, buildProcedureDefinitionSeeds()),
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
  assert.equal(
    fhir.questionnaireResponses[0]?.questionnaire,
    `${AESTHETICS_COSMETIC_CONSENT_URL}|0.1.0`,
  );
  assert.equal(fhir.questionnaireResponses[0]?.subject?.reference, "Patient/shared-1");
  assert.equal(fhir.questionnaireResponses[0]?.encounter?.reference, "Encounter/aesthetics-1");
  assert.equal(fhir.questionnaireResponses[0]?.item?.[0]?.answer?.[0]?.valueBoolean, true);
  assert.equal(fhir.provenances[0]?.target?.[1]?.reference, "Patient/shared-1");
});

test("cosmetic consent rejects mismatched and unreadable Encounters before writing", async () => {
  const definitions = buildProcedureDefinitionSeeds();
  const mismatched = new MemoryFhir();
  mismatched.encounters[0]!.subject = { reference: "Patient/different" };
  const mismatch = await handleAestheticsConsentSubmissionRequest(
    deps("provider", mismatched, definitions),
    {
      authHeader: AUTH,
      body: {
        patientReference: "Patient/shared-1",
        encounterReference: "Encounter/aesthetics-1",
        acknowledged: true,
      },
    },
  );
  assert.equal(mismatch.status, 422);
  assert.match(JSON.stringify(mismatch.body), /does not belong to Patient\/shared-1/);
  assert.equal(mismatched.writes.length, 0);

  const unreadable = new MemoryFhir();
  unreadable.encounterReadError = new Error("FHIR unavailable");
  const readFailure = await handleAestheticsConsentSubmissionRequest(
    deps("provider", unreadable, definitions),
    {
      authHeader: AUTH,
      body: {
        patientReference: "Patient/shared-1",
        encounterReference: "Encounter/aesthetics-1",
        acknowledged: true,
      },
    },
  );
  assert.equal(readFailure.status, 422);
  assert.match(JSON.stringify(readFailure.body), /Encounter could not be read/);
  assert.equal(unreadable.writes.length, 0);
});

test("cosmetic consent rejects an eyecare Encounter before writing", async () => {
  const fhir = new MemoryFhir();
  fhir.encounters[0]!.serviceType = {
    coding: [{ system: ODOS_DISCIPLINE_SYSTEM, code: "eyecare" }],
  };
  const result = await handleAestheticsConsentSubmissionRequest(
    deps("provider", fhir, buildProcedureDefinitionSeeds()),
    {
      authHeader: AUTH,
      body: {
        patientReference: "Patient/shared-1",
        encounterReference: "Encounter/aesthetics-1",
        acknowledged: true,
      },
    },
  );

  assert.deepEqual(result, {
    status: 422,
    body: { error: "Encounter/aesthetics-1 is not an aesthetics Encounter." },
  });
  assert.equal(fhir.writes.length, 0);
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
