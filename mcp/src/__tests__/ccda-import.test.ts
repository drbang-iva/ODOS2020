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

test("C-CDA v2 import preserves narrative, FDB coding, medication grouping, and text identity", async () => {
  const documents = [
    {
      file: "EMA_20200101T090000_Synthetic_ClinicalSummary_CCD_Final.ccda.xml",
      sections: {
        Problems: [
          { kind: "observation", date: "20200101", codes: [], text: "First problem" },
          { kind: "observation", date: "20200101", codes: [], text: "Second problem" },
        ],
        Allergies: [{
          kind: "observation",
          date: "20200101",
          codes: [{ system: "FDB", code: "SYNTHETIC-FDB-1", display: "Synthetic allergen" }],
          text: "Recovered allergen",
        }],
        Procedures: [{
          kind: "procedure",
          date: "20200101",
          codes: [],
          text: "Recovered procedure",
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

  assert.equal(result.resources.Condition.created, 2);
  const conditions = fhir.ofType<Condition>("Condition");
  assert.deepEqual(
    conditions.map((condition) => condition.code),
    [
      { coding: [], text: "First problem" },
      { coding: [], text: "Second problem" },
    ],
  );
  assert.notEqual(conditions[0]!.identifier?.[0]?.value, conditions[1]!.identifier?.[0]?.value);

  const allergy = fhir.ofType<AllergyIntolerance>("AllergyIntolerance")[0]!;
  assert.deepEqual(allergy.code, {
    coding: [{
      system: "urn:oid:2.16.840.1.113883.3.3710.200.401",
      code: "SYNTHETIC-FDB-1",
      display: "Synthetic allergen",
    }],
    text: "Recovered allergen",
  });
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

  const procedure = fhir.ofType<Procedure>("Procedure")[0]!;
  assert.deepEqual(procedure.code, { coding: [], text: "Recovered procedure" });

  assert.equal(result.resources.MedicationStatement.created, 2);
  const medications = fhir.ofType<MedicationStatement>("MedicationStatement");
  assert.deepEqual(
    medications.map((medication) => medication.medicationCodeableConcept),
    [
      { coding: [], text: "Recovered Drug" },
      { coding: [], text: "Other Drug" },
    ],
  );
  assert.notEqual(
    medications[0]!.identifier?.[0]?.value,
    medications[1]!.identifier?.[0]?.value,
  );
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
