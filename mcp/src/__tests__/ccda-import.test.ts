import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type {
  AllergyIntolerance,
  Bundle,
  Condition,
  Identifier,
  MedicationStatement,
  Patient,
  Procedure,
  Resource,
} from "@medplum/fhirtypes";
import type { FhirSearchParams } from "../fhir-client.js";
import {
  importLegacyCcda,
  LEGACY_CCDA_FDB_ALLERGEN_SYSTEM,
  legacyCcdaDocumentsSchema,
} from "../legacy-import/ccda-import.js";
import { EHR_PATIENT_IDENTIFIER_SYSTEM } from "../legacy-import/patient-import.js";

test("C-CDA v2 schema accepts narrative-only entries and rejects entries with no identity", () => {
  const documents = [{
    file: "EMA_20200101T090000_Synthetic_ClinicalSummary_CCD_Final.ccda.xml",
    sections: {
      Problems: [{
        kind: "observation",
        date: "20200101",
        codes: [],
        text: "  Recovered narrative  ",
      }],
    },
  }];

  const parsed = legacyCcdaDocumentsSchema.parse(documents);
  assert.deepEqual(parsed[0]!.sections.Problems?.[0], {
    kind: "observation",
    date: "20200101",
    codes: [],
    text: "Recovered narrative",
  });

  const invalid = structuredClone(documents) as Array<{
    sections: { Problems: Array<{ text?: string }> };
  }>;
  delete invalid[0]!.sections.Problems[0]!.text;
  const result = legacyCcdaDocumentsSchema.safeParse(invalid);
  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.error.issues.some((issue) =>
      issue.message === "C-CDA entry must include at least one code or narrative text."
      && JSON.stringify(issue.path) === JSON.stringify([0, "sections", "Problems", 0])
    ));
  }
});

test("C-CDA v2 schema applies the code-or-text invariant only to imported sections", () => {
  const parsed = legacyCcdaDocumentsSchema.parse([{
    file: "EMA_20200101T090000_Synthetic_ClinicalSummary_CCD_Final.ccda.xml",
    sections: {
      "Past Illness": [{ kind: "observation", date: null, codes: [] }],
      Unsupported: [{}],
    },
  }]);

  assert.equal(parsed.length, 1);
});

test("C-CDA v2 schema normalizes null and empty coded-entry text to absent", async () => {
  const documents = [{
    file: "EMA_20200101T090000_Synthetic_ClinicalSummary_CCD_Final.ccda.xml",
    sections: {
      Problems: [
        {
          kind: "observation",
          date: "20200101",
          codes: [{ system: "ICD-10-CM", code: "SYNTHETIC-NULL", display: null }],
          text: null,
        },
        {
          kind: "observation",
          date: "20200101",
          codes: [{ system: "ICD-10-CM", code: "SYNTHETIC-EMPTY", display: null }],
          text: "",
        },
        {
          kind: "observation",
          date: "20200101",
          codes: [{ system: "ICD-10-CM", code: "SYNTHETIC-WHITESPACE", display: null }],
          text: "   ",
        },
      ],
    },
  }];

  const parsed = legacyCcdaDocumentsSchema.parse(documents);
  assert.deepEqual(
    parsed[0]!.sections.Problems?.map((entry) => entry.text),
    [undefined, undefined, undefined],
  );

  const fhir = new MemoryCcdaFhir([syntheticPatient()]);
  await importLegacyCcda({
    fhir,
    projectId: "project-1",
    ehrPatientId: "synthetic-ehr-1",
    documents,
  });
  assert.deepEqual(
    fhir.ofType<Condition>("Condition").map((condition) => condition.code?.text),
    ["SYNTHETIC-NULL", "SYNTHETIC-EMPTY", "SYNTHETIC-WHITESPACE"],
  );
});

test("C-CDA v2 omits coding instead of emitting an empty array", async () => {
  const fhir = new MemoryCcdaFhir([syntheticPatient()]);
  await importLegacyCcda({
    fhir,
    projectId: "project-1",
    ehrPatientId: "synthetic-ehr-1",
    documents: [{
      file: "EMA_20200101T090000_Synthetic_ClinicalSummary_CCD_Final.ccda.xml",
      sections: {
        Problems: [{
          kind: "observation",
          date: "20200101",
          codes: [],
          text: "Narrative only",
        }],
      },
    }],
  });

  const concept = fhir.ofType<Condition>("Condition")[0]!.code!;
  assert.deepEqual(concept, { text: "Narrative only" });
  assert.equal("coding" in concept, false);
  assert.equal(JSON.stringify(fhir.resources).includes('"coding":[]'), false);
});

test("C-CDA v2 import preserves narrative, FDB coding, medication grouping, and text identity", async () => {
  const documents = [
    {
      file: "EMA_20200101T090000_Synthetic_ClinicalSummary_CCD_Final.ccda.xml",
      sections: {
        Problems: [
          { kind: "observation", date: "20200101", codes: [], text: "First problem" },
          { kind: "observation", date: "20200101", codes: [], text: "Second problem" },
          {
            kind: "observation",
            date: "20200101",
            codes: [{ system: "SNOMED-CT", code: "SYNTHETIC-PROBLEM", display: null }],
          },
        ],
        Allergies: [
          {
            kind: "observation",
            date: "20200101",
            codes: [],
            text: "Recovered allergy",
          },
          {
            kind: "observation",
            date: "20200101",
            codes: [{ system: "FDB", code: "SYNTHETIC-FDB-1", display: "Synthetic allergen" }],
            text: "Recovered allergen",
          },
        ],
        Procedures: [{
          kind: "procedure",
          date: "20200101",
          codes: [],
          text: "Recovered procedure",
        }, {
          kind: "procedure",
          date: "20200101",
          codes: [{ system: "CPT-4", code: "SYNTHETIC-PROCEDURE", display: null }],
        }],
        Medications: [
          {
            kind: "substanceAdministration",
            date: "20200101",
            codes: [],
            text: "Recovered Drug",
          },
          {
            kind: "substanceAdministration",
            date: "20200102",
            codes: [],
            text: "Other Drug",
          },
        ],
      },
    },
    {
      file: "EMA_20200201T090000_Synthetic_ClinicalSummary_CCD_Final.ccda.xml",
      sections: {
        Medications: [{
          kind: "substanceAdministration",
          date: "20200201",
          codes: [],
          text: "RECOVERED DRUG",
        }],
      },
    },
  ];
  const fhir = new MemoryCcdaFhir([syntheticPatient()]);

  const result = await importLegacyCcda({
    fhir,
    projectId: "project-1",
    ehrPatientId: "synthetic-ehr-1",
    documents,
    now: new Date("2026-08-02T12:00:00Z"),
  });

  assert.equal(result.resources.Condition.created, 3);
  const conditions = fhir.ofType<Condition>("Condition");
  assert.deepEqual(
    conditions.slice(0, 2).map((condition) => condition.code),
    [
      { text: "First problem" },
      { text: "Second problem" },
    ],
  );
  assert.deepEqual(
    conditions.map((condition) => condition.verificationStatus?.coding?.[0]?.code),
    ["unconfirmed", "unconfirmed", "confirmed"],
  );
  assert.notEqual(conditions[0]!.identifier?.[0]?.value, conditions[1]!.identifier?.[0]?.value);

  const allergies = fhir.ofType<AllergyIntolerance>("AllergyIntolerance");
  assert.deepEqual(allergies[0]!.code, { text: "Recovered allergy" });
  assert.equal(allergies[0]!.verificationStatus?.coding?.[0]?.code, "unconfirmed");
  const allergy = allergies[1]!;
  assert.deepEqual(allergy.code, {
    coding: [{
      system: LEGACY_CCDA_FDB_ALLERGEN_SYSTEM,
      code: "SYNTHETIC-FDB-1",
      display: "Synthetic allergen",
    }],
    text: "Recovered allergen",
  });
  assert.equal(allergy.verificationStatus?.coding?.[0]?.code, "confirmed");
  assert.equal(
    allergy.identifier?.[0]?.value,
    createHash("sha256")
      .update(JSON.stringify([
        "synthetic-ehr-1",
        "20200101T090000",
        "Allergies",
        "20200101",
        [["FDB", "SYNTHETIC-FDB-1"]],
      ]))
      .digest("hex"),
  );

  const procedures = fhir.ofType<Procedure>("Procedure");
  assert.deepEqual(procedures[0]!.code, { text: "Recovered procedure" });
  assert.deepEqual(procedures.map((procedure) => procedure.status), ["completed", "completed"]);

  assert.equal(result.resources.MedicationStatement.created, 2);
  const medications = fhir.ofType<MedicationStatement>("MedicationStatement");
  assert.deepEqual(
    medications.map((medication) => medication.medicationCodeableConcept),
    [
      { text: "Recovered Drug" },
      { text: "Other Drug" },
    ],
  );
  assert.notEqual(
    medications[0]!.identifier?.[0]?.value,
    medications[1]!.identifier?.[0]?.value,
  );
  assert.equal(
    medications[0]!.identifier?.[0]?.value,
    createHash("sha256")
      .update("synthetic-ehr-1|Medications|text|recovered drug")
      .digest("hex"),
  );
  assert.equal(JSON.stringify(fhir.resources).includes('"coding":[]'), false);

  const rerun = await importLegacyCcda({
    fhir,
    projectId: "project-1",
    ehrPatientId: "synthetic-ehr-1",
    documents,
    now: new Date("2026-08-02T12:01:00Z"),
  });
  assert.deepEqual(rerun.resources, {
    Condition: { created: 0, skipped: 3, encounterLinked: 0, encounterUnlinked: 3 },
    AllergyIntolerance: { created: 0, skipped: 2, encounterLinked: 0, encounterUnlinked: 2 },
    MedicationStatement: { created: 0, skipped: 2, encounterLinked: 0, encounterUnlinked: 2 },
    Procedure: { created: 0, skipped: 2, encounterLinked: 0, encounterUnlinked: 2 },
  });
});

test("C-CDA v2 normalizes whitespace and Unicode in narrative identity", async () => {
  const documents = [
    {
      file: "EMA_20200101T090000_Synthetic_ClinicalSummary_CCD_Final.ccda.xml",
      sections: {
        Problems: [
          { kind: "observation", date: "20200101", codes: [], text: "Alpha  Drug" },
          { kind: "observation", date: "20200101", codes: [], text: "alpha\u00a0drug" },
        ],
        Medications: [{
          kind: "substanceAdministration",
          date: "20200101",
          codes: [],
          text: "Cafe\u0301 Drug",
        }, {
          kind: "substanceAdministration",
          date: "20200101",
          codes: [],
          text: "5 µg Drug",
        }],
      },
    },
    {
      file: "EMA_20200201T090000_Synthetic_ClinicalSummary_CCD_Final.ccda.xml",
      sections: {
        Medications: [{
          kind: "substanceAdministration",
          date: "20200201",
          codes: [],
          text: "CAFÉ\u00a0DRUG",
        }, {
          kind: "substanceAdministration",
          date: "20200201",
          codes: [],
          text: "5 μg Drug",
        }],
      },
    },
  ];
  const fhir = new MemoryCcdaFhir([syntheticPatient()]);

  const result = await importLegacyCcda({
    fhir,
    projectId: "project-1",
    ehrPatientId: "synthetic-ehr-1",
    documents,
  });

  assert.deepEqual(result.resources.Condition, {
    created: 1,
    skipped: 0,
    encounterLinked: 0,
    encounterUnlinked: 1,
  });
  assert.equal(result.resources.MedicationStatement.created, 2);
  assert.equal(fhir.ofType<MedicationStatement>("MedicationStatement").length, 2);
});

test("C-CDA v2 schema accepts a synthetic 60-document batch with 202 narrative-only entries", () => {
  const documents = Array.from({ length: 60 }, (_, documentIndex) => {
    const entryCount = documentIndex < 22 ? 4 : 3;
    return {
      file: `EMA_20200101T${String(documentIndex).padStart(6, "0")}_Synthetic_ClinicalSummary_CCD_Final.ccda.xml`,
      sections: {
        Problems: Array.from({ length: entryCount }, (_, entryIndex) => ({
          kind: "observation",
          date: "20200101",
          codes: [],
          text: `Recovered narrative ${documentIndex}-${entryIndex}`,
        })),
      },
    };
  });

  const parsed = legacyCcdaDocumentsSchema.parse(documents);
  assert.equal(parsed.length, 60);
  assert.equal(
    parsed.reduce((count, document) => count + (document.sections.Problems?.length ?? 0), 0),
    202,
  );
});

function syntheticPatient(): Patient {
  return {
    resourceType: "Patient",
    id: "patient-1",
    identifier: [{
      system: EHR_PATIENT_IDENTIFIER_SYSTEM,
      value: "synthetic-ehr-1",
    }],
  };
}

class MemoryCcdaFhir {
  readonly baseUrl = "http://localhost:8103/";
  readonly resources: Resource[];

  constructor(resources: Resource[]) {
    this.resources = [...resources];
  }

  async search<T extends Resource>(
    resourceType: T["resourceType"],
    params?: FhirSearchParams,
  ): Promise<Bundle<T>> {
    const query = params instanceof URLSearchParams
      ? Object.fromEntries(params)
      : Array.isArray(params)
        ? Object.fromEntries(params)
        : params;
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
      matches = [];
    }
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: matches.map((resource) => ({ resource: resource as T })),
    };
  }

  async create<T extends Resource>(
    resource: T,
    _extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const count = this.resources.filter(
      (candidate) => candidate.resourceType === resource.resourceType,
    ).length;
    const created = {
      ...resource,
      id: `${resource.resourceType.toLowerCase()}-${count + 1}`,
    } as T;
    this.resources.push(created);
    return created;
  }

  ofType<T extends Resource>(resourceType: T["resourceType"]): T[] {
    return this.resources.filter(
      (resource): resource is T => resource.resourceType === resourceType,
    );
  }
}
