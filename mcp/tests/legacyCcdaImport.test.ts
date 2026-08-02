import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type {
  AllergyIntolerance,
  Bundle,
  Condition,
  Encounter,
  Identifier,
  MedicationStatement,
  Patient,
  Procedure,
  Provenance,
  Resource,
} from "@medplum/fhirtypes";
import type { FhirSearchParams } from "../src/fhir-client.js";
import { buildMedicationStatement } from "../src/fhir/medicationStatement.js";
import {
  importLegacyCcda,
  LEGACY_CCDA_FDB_ALLERGEN_SYSTEM,
  LEGACY_CCDA_ITEM_IDENTIFIER_SYSTEM,
  LEGACY_CCDA_TAG_CODE,
  LEGACY_CCDA_TAG_SYSTEM,
  legacyCcdaDocumentsSchema,
} from "../src/legacy-import/ccda-import.js";
import { EHR_PATIENT_IDENTIFIER_SYSTEM } from "../src/legacy-import/patient-import.js";
import {
  formatLegacyCcdaReport,
  readLegacyCcdaInput,
  runLegacyCcdaImportCli,
} from "../../scripts/import-legacy-ccda.js";

const FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/legacy-ccda-synthetic.json", import.meta.url),
);
const DOCUMENTS = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as unknown[];

test("general MedicationStatement builder does not invent ophthalmic route or current assertion time", () => {
  const statement = buildMedicationStatement({
    patientReference: "Patient/patient-1",
    medication: {
      system: "http://www.nlm.nih.gov/research/umls/rxnorm",
      code: "860975",
    },
  });

  assert.equal(statement.status, "unknown");
  assert.equal(statement.dateAsserted, undefined);
  assert.equal(statement.dosage, undefined);
  assert.deepEqual(statement.medicationCodeableConcept, {
    coding: [{
      system: "http://www.nlm.nih.gov/research/umls/rxnorm",
      code: "860975",
    }],
  });
});

test("general MedicationStatement builder gives effectiveDateTime precedence over effectivePeriod", () => {
  const statement = buildMedicationStatement({
    patientReference: "Patient/patient-1",
    medication: { system: "https://example.test/medication", code: "synthetic" },
    effectiveDateTime: "2020-01-01",
    effectivePeriodStart: "2019-01-01",
    effectivePeriodEnd: "2019-12-31",
  });

  assert.equal(statement.effectiveDateTime, "2020-01-01");
  assert.equal(statement.effectivePeriod, undefined);
});

test("C-CDA import maps source facts, links exactly one Encounter, and converges on rerun", async () => {
  const fhir = new MemoryCcdaFhir([
    patient("patient-1"),
    {
      resourceType: "Encounter",
      id: "encounter-1",
      status: "finished",
      class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
      subject: { reference: "Patient/patient-1" },
      period: {
        start: "2021-02-01T00:30:00.000Z",
        end: "2021-02-01T01:00:00.000Z",
      },
    } satisfies Encounter,
  ]);

  const first = await importLegacyCcda({
    fhir,
    projectId: "project-1",
    ehrPatientId: "synthetic-ehr-1",
    documents: DOCUMENTS,
    now: new Date("2026-08-01T12:00:00Z"),
  });

  assert.deepEqual(first.resources, {
    Condition: { created: 3, skipped: 0, encounterLinked: 2, encounterUnlinked: 1 },
    AllergyIntolerance: { created: 2, skipped: 0, encounterLinked: 2, encounterUnlinked: 0 },
    MedicationStatement: { created: 1, skipped: 0, encounterLinked: 0, encounterUnlinked: 1 },
    Procedure: { created: 1, skipped: 0, encounterLinked: 1, encounterUnlinked: 0 },
  });
  assert.deepEqual(first.encounterNonMatches, [{
    file: "EMA_20200131T100000_Synthetic_ClinicalSummary_CCD_Final.ccda.xml",
    date: "2020-01-31",
    matchCount: 0,
  }]);

  const conditions = fhir.ofType<Condition>("Condition");
  assert.equal(conditions.length, 3);
  const dualCoded = conditions.find((condition) => condition.encounter?.reference);
  assert.equal(dualCoded?.category?.[0]?.coding?.[0]?.code, "problem-list-item");
  assert.equal(dualCoded?.encounter?.reference, "Encounter/encounter-1");
  assert.deepEqual(dualCoded?.code?.coding, [
    { system: "http://snomed.info/sct", code: "SYNTHETIC-SNOMED-1" },
    {
      system: "http://hl7.org/fhir/sid/icd-10-cm",
      code: "SYNTHETIC-ICD10-1",
      display: "Synthetic dual-coded problem",
    },
  ]);
  assert.equal(
    conditions.find((condition) => !condition.encounter)?.code?.coding?.[0]?.system,
    "http://terminology.hl7.org/CodeSystem/icd9cm",
  );
  const narrativeCondition = conditions.find((condition) => condition.code?.text);
  assert.deepEqual(narrativeCondition?.code, { text: "Synthetic narrative-only problem" });
  assert.equal(narrativeCondition?.verificationStatus?.coding?.[0]?.code, "unconfirmed");
  assert.ok(conditions.filter((condition) => condition.code?.coding?.length)
    .every((condition) => condition.verificationStatus?.coding?.[0]?.code === "confirmed"));

  const allergies = fhir.ofType<AllergyIntolerance>("AllergyIntolerance");
  const allergy = allergies[0]!;
  assert.equal(allergy.encounter?.reference, "Encounter/encounter-1");
  const fdbAllergy = allergies.find((candidate) =>
    candidate.code?.coding?.some((coding) => coding.system === LEGACY_CCDA_FDB_ALLERGEN_SYSTEM)
  );
  assert.equal(fdbAllergy?.code?.coding?.[0]?.code, "SYNTHETIC-FDB-ALLERGEN-1");
  assert.ok(allergies.every((candidate) =>
    candidate.verificationStatus?.coding?.[0]?.code === "confirmed"
  ));
  const procedure = fhir.ofType<Procedure>("Procedure")[0]!;
  assert.equal(procedure.encounter?.reference, "Encounter/encounter-1");
  assert.equal(procedure.code?.coding?.[0]?.display, undefined);

  const medication = fhir.ofType<MedicationStatement>("MedicationStatement")[0]!;
  assert.equal(medication.status, "unknown");
  assert.equal(medication.effectiveDateTime, "2019-12-15");
  assert.equal(medication.dateAsserted, "2020-01-31");
  assert.equal(medication.context, undefined);
  assert.equal(medication.dosage, undefined);
  assert.deepEqual(medication.medicationCodeableConcept?.coding, [
    {
      system: "http://snomed.info/sct",
      code: "SYNTHETIC-SNOMED-MED-1",
      display: "Synthetic translated medication",
    },
    {
      system: "http://www.nlm.nih.gov/research/umls/rxnorm",
      code: "860975",
      display: "24 HR metformin hydrochloride 500 MG Extended Release Oral Tablet",
    },
    {
      system: "http://snomed.info/sct",
      code: "SYNTHETIC-SNOMED-MED-LATER",
      display: "Synthetic later-source medication translation",
    },
  ]);

  for (const resource of [
    ...conditions,
    ...allergies,
    medication,
    procedure,
  ]) {
    assert.equal(resource.identifier?.[0]?.system, LEGACY_CCDA_ITEM_IDENTIFIER_SYSTEM);
    assert.equal(resource.identifier?.[0]?.value?.length, 64);
    assert.ok(resource.meta?.tag?.some(
      (tag) => tag.system === LEGACY_CCDA_TAG_SYSTEM && tag.code === LEGACY_CCDA_TAG_CODE,
    ));
  }

  const provenance = fhir.ofType<Provenance>("Provenance")[0]!;
  assert.equal(provenance.target.length, 7);
  assert.deepEqual(
    provenance.entity?.map((entity) => entity.what.display),
    [
      "EMA_20210131T090000_Synthetic_ClinicalSummary_CCD_Final.ccda.xml",
      "EMA_20200131T100000_Synthetic_ClinicalSummary_CCD_Final.ccda.xml",
    ],
  );
  assert.equal(first.provenanceReference, `Provenance/${provenance.id}`);
  assert.equal(
    fhir.searches.filter((search) => search.resourceType === "Encounter").length,
    1,
  );
  assert.equal(fhir.createHeaders.length, 8);
  assert.ok(fhir.createHeaders.every(
    (headers) => headers?.["X-ODOS-Source"] === "scripts/import-legacy-ccda",
  ));
  assert.equal(JSON.stringify(fhir.created).includes('"coding":[]'), false);

  const second = await importLegacyCcda({
    fhir,
    projectId: "project-1",
    ehrPatientId: "synthetic-ehr-1",
    documents: DOCUMENTS,
    now: new Date("2026-08-01T12:01:00Z"),
  });
  assert.deepEqual(second.resources, {
    Condition: { created: 0, skipped: 3, encounterLinked: 2, encounterUnlinked: 1 },
    AllergyIntolerance: { created: 0, skipped: 2, encounterLinked: 2, encounterUnlinked: 0 },
    MedicationStatement: { created: 0, skipped: 1, encounterLinked: 0, encounterUnlinked: 1 },
    Procedure: { created: 0, skipped: 1, encounterLinked: 1, encounterUnlinked: 0 },
  });
  assert.equal(second.provenanceReference, undefined);
  assert.equal(fhir.ofType<Provenance>("Provenance").length, 1);
  assert.match(formatLegacyCcdaReport(second), /MedicationStatement created=0 already_existed=1/);
  assert.match(formatLegacyCcdaReport(second), /encounter_non_match .*matches=0/);

  const subset = await importLegacyCcda({
    fhir,
    projectId: "project-1",
    ehrPatientId: "synthetic-ehr-1",
    documents: [DOCUMENTS[0]],
    now: new Date("2026-08-01T12:02:00Z"),
  });
  assert.deepEqual(subset.resources.MedicationStatement, {
    created: 0,
    skipped: 1,
    encounterLinked: 0,
    encounterUnlinked: 1,
  });
});

test("C-CDA allergy identity preserves distinct code sets and dated recurrences across reruns", async () => {
  const documents = [{
    file: "EMA_20210131T090000_Synthetic_ClinicalSummary_CCD_Final.ccda.xml",
    sections: {
      Allergies: [
        {
          kind: "observation",
          date: "20210101",
          codes: [
            { system: "SNOMED-CT", code: "SYNTHETIC-ALLERGY-SHARED", display: null },
            { system: "ICD-10-CM", code: "SYNTHETIC-ALLERGY-A", display: null },
          ],
        },
        {
          kind: "observation",
          date: "20210101",
          codes: [
            { system: "SNOMED-CT", code: "SYNTHETIC-ALLERGY-SHARED", display: null },
            { system: "ICD-10-CM", code: "SYNTHETIC-ALLERGY-B", display: null },
          ],
        },
        {
          kind: "observation",
          date: "20210201",
          codes: [
            { system: "SNOMED-CT", code: "SYNTHETIC-ALLERGY-SHARED", display: null },
            { system: "ICD-10-CM", code: "SYNTHETIC-ALLERGY-A", display: null },
          ],
        },
      ],
    },
  }];
  const fhir = new MemoryCcdaFhir([patient("patient-1")]);

  const first = await importLegacyCcda({
    fhir,
    projectId: "project-1",
    ehrPatientId: "synthetic-ehr-1",
    documents,
  });

  assert.deepEqual(first.resources.AllergyIntolerance, {
    created: 3,
    skipped: 0,
    encounterLinked: 0,
    encounterUnlinked: 3,
  });
  assert.equal(fhir.ofType<AllergyIntolerance>("AllergyIntolerance").length, 3);

  const second = await importLegacyCcda({
    fhir,
    projectId: "project-1",
    ehrPatientId: "synthetic-ehr-1",
    documents,
  });

  assert.deepEqual(second.resources.AllergyIntolerance, {
    created: 0,
    skipped: 3,
    encounterLinked: 0,
    encounterUnlinked: 3,
  });

  const reordered = structuredClone(documents);
  for (const allergy of reordered[0]!.sections.Allergies) allergy.codes.reverse();
  const third = await importLegacyCcda({
    fhir,
    projectId: "project-1",
    ehrPatientId: "synthetic-ehr-1",
    documents: reordered,
  });

  assert.deepEqual(third.resources.AllergyIntolerance, {
    created: 0,
    skipped: 3,
    encounterLinked: 0,
    encounterUnlinked: 3,
  });
  assert.equal(fhir.ofType<AllergyIntolerance>("AllergyIntolerance").length, 3);
});

test("C-CDA encounter matching treats an offset-less legacy dateTime as Eyefinity local time", async () => {
  const originalTimeZone = process.env.TZ;
  process.env.TZ = "UTC";
  try {
    const documents = structuredClone([DOCUMENTS[0]]) as Array<{ file: string }>;
    documents[0]!.file =
      "EMA_20210201T090000_Synthetic_ClinicalSummary_CCD_Final.ccda.xml";
    const fhir = new MemoryCcdaFhir([
      patient("patient-1"),
      {
        resourceType: "Encounter",
        id: "encounter-offsetless",
        status: "finished",
        class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
        subject: { reference: "Patient/patient-1" },
        period: {
          start: "2021-02-01T00:30:00",
          end: "2021-02-01T01:00:00",
        },
      } satisfies Encounter,
    ]);

    const result = await importLegacyCcda({
      fhir,
      projectId: "project-1",
      ehrPatientId: "synthetic-ehr-1",
      documents,
    });

    assert.equal(result.resources.Condition.encounterLinked, 2);
    assert.deepEqual(result.encounterNonMatches, []);
  } finally {
    if (originalTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimeZone;
  }
});

test("C-CDA schema normalizes an omitted entry date to null", () => {
  const documents = structuredClone(DOCUMENTS) as Array<{
    sections: { Problems: Array<{ date?: string | null }> };
  }>;
  delete documents[0]!.sections.Problems[0]!.date;

  const parsed = legacyCcdaDocumentsSchema.parse(documents);

  assert.equal(parsed[0]!.sections.Problems?.[0]?.date, null);
});

test("C-CDA import refuses zero or multiple Patient identifier matches before writing", async () => {
  const none = new MemoryCcdaFhir([]);
  await assert.rejects(
    importLegacyCcda({
      fhir: none,
      projectId: "project-1",
      ehrPatientId: "synthetic-ehr-1",
      documents: DOCUMENTS,
    }),
    /Expected exactly one Patient .* found 0/,
  );
  assert.equal(none.created.length, 0);

  const multiple = new MemoryCcdaFhir([patient("patient-1"), patient("patient-2")]);
  await assert.rejects(
    importLegacyCcda({
      fhir: multiple,
      projectId: "project-1",
      ehrPatientId: "synthetic-ehr-1",
      documents: DOCUMENTS,
    }),
    /Expected exactly one Patient .* found 2/,
  );
  assert.equal(multiple.created.length, 0);
});

test("C-CDA CLI refuses a non-local target before authentication", async () => {
  await assert.rejects(
    runLegacyCcdaImportCli({
      baseUrl: "https://example.test",
      inputPath: FIXTURE_PATH,
      ehrPatientId: "synthetic-ehr-1",
      clientId: "synthetic-client",
      clientSecret: "synthetic-secret",
    }),
    /restricted to a local self-hosted Medplum/,
  );
});

test("C-CDA input errors name the source path", () => {
  const missingPath = `${FIXTURE_PATH}.missing`;
  assert.throws(
    () => readLegacyCcdaInput(missingPath),
    (error: unknown) =>
      error instanceof Error
      && error.message.includes(missingPath)
      && error.message.includes("Could not read or parse C-CDA input"),
  );
});

function patient(id: string): Patient {
  return {
    resourceType: "Patient",
    id,
    identifier: [{
      system: EHR_PATIENT_IDENTIFIER_SYSTEM,
      value: "synthetic-ehr-1",
    }],
  };
}

class MemoryCcdaFhir {
  readonly resources: Resource[];
  readonly created: Resource[] = [];
  readonly createHeaders: Array<Record<string, string> | undefined> = [];
  readonly searches: Array<{
    resourceType: Resource["resourceType"];
    params?: FhirSearchParams;
  }> = [];

  constructor(resources: Resource[]) {
    this.resources = [...resources];
  }

  async search<T extends Resource>(
    resourceType: T["resourceType"],
    params?: FhirSearchParams,
  ): Promise<Bundle<T>> {
    this.searches.push({ resourceType, params });
    const query = params as Record<string, string> | undefined;
    let matches = this.resources.filter((resource) => resource.resourceType === resourceType);
    if (query?.identifier) {
      const [system, value] = query.identifier.split("|");
      matches = matches.filter((resource) =>
        ((resource as { identifier?: Identifier[] }).identifier ?? []).some(
          (identifier) => identifier.system === system && identifier.value === value,
        )
      );
    }
    if (resourceType === "Encounter" && query?.patient) {
      matches = matches.filter((resource) => {
        const encounter = resource as Encounter;
        return encounter.subject?.reference === query.patient;
      });
    }
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: matches.map((resource) => ({ resource: resource as T })),
    };
  }

  async create<T extends Resource>(
    resource: T,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    this.createHeaders.push(extraHeaders);
    const count = this.resources.filter(
      (candidate) => candidate.resourceType === resource.resourceType,
    ).length;
    const created = {
      ...resource,
      id: `${resource.resourceType.toLowerCase()}-${count + 1}`,
    } as T;
    this.resources.push(created);
    this.created.push(created);
    return created;
  }

  ofType<T extends Resource>(resourceType: T["resourceType"]): T[] {
    return this.resources.filter(
      (resource): resource is T => resource.resourceType === resourceType,
    );
  }
}
