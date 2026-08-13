import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import type {
  Bundle,
  Condition,
  Encounter,
  Observation,
  Provenance,
  Resource,
} from "@medplum/fhirtypes";
import express from "express";
import type { PracticeRoleId } from "../src/authz/roles.js";
import {
  handleDiagnosisFindingsMutationRequest,
  handleDiagnosisFindingsReadRequest,
  type DiagnosisFindingsFhirClient,
} from "../src/clinical-graph/diagnosis-findings-endpoint.js";
import { DIAGNOSIS_KEY_IDENTIFIER_SYSTEM } from "../src/clinical-graph/diagnosis-pick-endpoint.js";
import type {
  ClinicalFindingDefinition,
  DiagnosisCatalogRow,
} from "../src/clinical-graph/glaucoma-suspect.js";
import { buildEncounterDiagnosisCondition } from "../src/fhir/condition.js";
import { ODOS_OPHTHALMOLOGY_CODE_SYSTEM } from "../src/fhir/ophthalmology/codeBindings.js";
import { ODOS_EXTENSION_URLS, lateralityConcept } from "../src/fhir/ophthalmology/extensions.js";

const FORBIDDEN_AUTH = "Bearer forbidden";

test("GET encounter findings returns 401 when unauthenticated", async (t) => {
  const base = await startFindingsRoutes(t, "admin");

  const response = await fetch(`${base}/clinical-graph/encounters/e1/findings`);

  assert.equal(response.status, 401);
});

test("PUT encounter findings returns 401 when unauthenticated", async (t) => {
  const base = await startFindingsRoutes(t, "admin");

  const response = await fetch(`${base}/clinical-graph/encounters/e1/findings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "assert" }),
  });

  assert.equal(response.status, 401);
});

test("PUT encounter findings returns 403 for read-only Admin", async (t) => {
  const base = await startFindingsRoutes(t, "admin");

  const response = await fetch(`${base}/clinical-graph/encounters/e1/findings`, {
    method: "PUT",
    headers: {
      Authorization: FORBIDDEN_AUTH,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action: "assert" }),
  });

  assert.equal(response.status, 403);
});

test("GET expands offered rows and normalizes only the latest section snapshot", async () => {
  const fhir = readModelFhir();
  const response = await handleDiagnosisFindingsReadRequest(clinicalDeps(fhir), {
    authHeader: "Bearer clinician",
    params: { encounterId: "e1" },
    query: { condition: "Condition/unique" },
  });

  assert.equal(response.status, 200, JSON.stringify(response.body));
  const body = response.body as {
    diagnosis: DiagnosisCatalogRow;
    findings: Array<{
      atomicFindingId: string;
      presence?: string;
      grade?: string;
      conditionReference?: string;
      source: string;
    }>;
    catalog: Array<{
      atomicFindingId: string;
      findingDefinitionId: string;
      findingDefinitionKey: string;
      fieldCode: string;
      optionCode: string;
      display: string;
      sectionKey: string;
      gradeScale: string[];
      diagnosisKeys: string[];
      origin: string;
    }>;
    unassigned: Array<{ atomicFindingId: string; source: string }>;
    bySection: Record<string, Array<{ atomicFindingId: string }>>;
  };
  assert.deepEqual(body.diagnosis.applicableFindingDefinitionIds, [LENS_DEFINITION.id]);
  assert.deepEqual(body.catalog, [
    {
      atomicFindingId: atomicId("ambiguous-section"),
      findingDefinitionId: LENS_DEFINITION.id,
      findingDefinitionKey: LENS_DEFINITION.stableKey,
      fieldCode: LENS_FIELD,
      optionCode: "ambiguous-section",
      display: "Ambiguous section finding",
      sectionKey: LENS_DEFINITION.sectionKey,
      gradeScale: [],
      diagnosisKeys: ["dx_second", "dx_unique"],
      origin: "shipped",
    },
    {
      atomicFindingId: atomicId("offered-only"),
      findingDefinitionId: LENS_DEFINITION.id,
      findingDefinitionKey: LENS_DEFINITION.stableKey,
      fieldCode: LENS_FIELD,
      optionCode: "offered-only",
      display: "Offered only finding",
      sectionKey: LENS_DEFINITION.sectionKey,
      gradeScale: [],
      diagnosisKeys: ["dx_unique"],
      origin: "shipped",
    },
    {
      atomicFindingId: atomicId("unique-section"),
      findingDefinitionId: LENS_DEFINITION.id,
      findingDefinitionKey: LENS_DEFINITION.stableKey,
      fieldCode: LENS_FIELD,
      optionCode: "unique-section",
      display: "Unique section finding",
      sectionKey: LENS_DEFINITION.sectionKey,
      gradeScale: ["1+", "2+"],
      diagnosisKeys: ["dx_unique"],
      origin: "shipped",
    },
    {
      atomicFindingId: atomicId("unmatched-section"),
      findingDefinitionId: LENS_DEFINITION.id,
      findingDefinitionKey: LENS_DEFINITION.stableKey,
      fieldCode: LENS_FIELD,
      optionCode: "unmatched-section",
      display: "Unmatched section finding",
      sectionKey: LENS_DEFINITION.sectionKey,
      gradeScale: [],
      diagnosisKeys: ["dx_missing"],
      origin: "shipped",
    },
  ]);
  assert.deepEqual(
    body.findings.map((row) => ({
      id: row.atomicFindingId,
      presence: row.presence,
      grade: row.grade,
      condition: row.conditionReference,
      source: row.source,
    })),
    [
      {
        id: atomicId("unique-section"),
        presence: "present",
        grade: "2+",
        condition: "Condition/unique",
        source: "section",
      },
      {
        id: atomicId("offered-only"),
        presence: undefined,
        grade: undefined,
        condition: undefined,
        source: "offered",
      },
    ],
  );
  assert.deepEqual(
    body.unassigned.map((row) => [row.atomicFindingId, row.source]),
    [
      [atomicId("ambiguous-section"), "section"],
      [atomicId("unmatched-section"), "section"],
    ],
  );
  assert.deepEqual(
    body.bySection[LENS_DEFINITION.sectionKey!]?.map((row) => row.atomicFindingId),
    [
      atomicId("ambiguous-section"),
      atomicId("unique-section"),
      atomicId("unmatched-section"),
    ],
  );
});

test("GET finds the selected encounter Condition on a later safe Bundle page", async () => {
  const fhir = readModelFhir();
  const conditions = fhir.resources.filter((resource): resource is Condition => resource.resourceType === "Condition");
  fhir.pages.set("Condition", [
    conditions.filter((condition) => condition.id !== "unique"),
    conditions.filter((condition) => condition.id === "unique"),
  ]);

  const response = await handleDiagnosisFindingsReadRequest(clinicalDeps(fhir), {
    authHeader: "Bearer clinician",
    params: { encounterId: "e1" },
    query: { condition: "Condition/unique" },
  });

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal((response.body as { diagnosis?: DiagnosisCatalogRow }).diagnosis?.stableKey, "dx_unique");
  assert.deepEqual(fhir.followedUrls, ["/fhir/R4/Condition?_page=2"]);
});

test("GET projects carried present findings and merges prior absence into the exact offered eye only", async () => {
  const fhir = carryFindingsFhir();
  const response = await handleDiagnosisFindingsReadRequest(clinicalDeps(fhir), {
    authHeader: "Bearer clinician",
    params: { encounterId: "e1" },
    query: { condition: "Condition/unique" },
  });

  assert.equal(response.status, 200, JSON.stringify(response.body));
  const body = response.body as {
    carryProvenance?: {
      pulledFromDate?: string;
      unchangedSinceDate?: string;
      edited: boolean;
    };
    findings: Array<{
      atomicFindingId: string;
      source: string;
      presence?: string;
      carried?: boolean;
      priorPresence?: string;
      priorGrade?: string;
      priorLaterality?: string;
      observationReference?: string;
    }>;
    bySection: Record<string, Array<{ atomicFindingId: string }>>;
  };
  assert.deepEqual(body.carryProvenance, {
    pulledFromDate: "2026-07-10T09:00:00.000Z",
    unchangedSinceDate: "2026-07-10T09:00:00.000Z",
    edited: false,
  });
  assert.deepEqual(body.findings.filter((row) =>
    row.atomicFindingId === atomicId("unique-section") ||
    row.atomicFindingId === atomicId("offered-only")
  ).map((row) => ({
    id: row.atomicFindingId,
    source: row.source,
    presence: row.presence,
    carried: row.carried,
    priorPresence: row.priorPresence,
    priorGrade: row.priorGrade,
    priorLaterality: row.priorLaterality,
    observationReference: row.observationReference,
  })), [
    {
      id: atomicId("unique-section"),
      source: "atomic",
      presence: "present",
      carried: true,
      priorPresence: undefined,
      priorGrade: undefined,
      priorLaterality: undefined,
      observationReference: "Observation/current-unique-present",
    },
    {
      id: atomicId("offered-only"),
      source: "offered",
      presence: undefined,
      carried: undefined,
      priorPresence: "absent",
      priorGrade: "historical-grade",
      priorLaterality: "OD",
      observationReference: undefined,
    },
  ]);
  assert.deepEqual(body.bySection[LENS_DEFINITION.sectionKey!]?.map((row) => row.atomicFindingId), [
    atomicId("unique-section"),
  ]);
});

test("GET keeps a selected carry prior absence offered when the matching current atomic finding belongs only to another diagnosis", async () => {
  const fhir = carryFindingsFhir();
  const second = fhir.resources.find((resource): resource is Condition =>
    resource.resourceType === "Condition" && resource.id === "second"
  )!;
  second.evidence = [{ detail: [{ reference: "Observation/current-second-offered-only" }] }];
  fhir.resources.push(atomicObservation(
    "current-second-offered-only",
    "e1",
    "offered-only",
    true,
    "OD",
  ));

  const response = await handleDiagnosisFindingsReadRequest(clinicalDeps(fhir), {
    authHeader: "Bearer clinician",
    params: { encounterId: "e1" },
    query: { condition: "Condition/unique" },
  });

  assert.equal(response.status, 200, JSON.stringify(response.body));
  const rows = (response.body as {
    findings: Array<{
      atomicFindingId: string;
      source: string;
      presence?: string;
      priorPresence?: string;
      conditionReference?: string;
      observationReference?: string;
    }>;
  }).findings.filter((row) => row.atomicFindingId === atomicId("offered-only"));
  assert.deepEqual(rows.map((row) => ({
    atomicFindingId: atomicId("offered-only"),
    source: row.source,
    presence: row.presence,
    priorPresence: row.priorPresence,
    conditionReference: row.conditionReference,
    observationReference: row.observationReference,
  })), [{
    atomicFindingId: atomicId("offered-only"),
    source: "offered",
    presence: undefined,
    priorPresence: "absent",
    conditionReference: undefined,
    observationReference: undefined,
  }]);
});

test("reasserting a prior absent offer creates a fresh current row without a carried tag", async () => {
  const fhir = carryFindingsFhir();
  const asserted = await mutate(fhir, {
    action: "assert",
    patientReference: "Patient/p1",
    conditionReference: "Condition/unique",
    atomicFindingId: atomicId("offered-only"),
    presence: "absent",
  });
  assert.equal(asserted.status, 200, JSON.stringify(asserted.body));

  const response = await handleDiagnosisFindingsReadRequest(clinicalDeps(fhir), {
    authHeader: "Bearer clinician",
    params: { encounterId: "e1" },
    query: { condition: "Condition/unique" },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const rows = (response.body as {
    carryProvenance?: { pulledFromDate?: string };
    findings: Array<{
      atomicFindingId: string;
      source: string;
      presence?: string;
      carried?: boolean;
      priorPresence?: string;
      observationReference?: string;
    }>;
  });
  assert.equal(rows.carryProvenance?.pulledFromDate, "2026-07-10T09:00:00.000Z");
  const reassertedRows = rows.findings.filter((row) => row.atomicFindingId === atomicId("offered-only"));
  assert.equal(reassertedRows.length, 1);
  assert.equal(reassertedRows[0]?.source, "atomic");
  assert.equal(reassertedRows[0]?.presence, "absent");
  assert.equal(reassertedRows[0]?.carried, undefined);
  assert.equal(reassertedRows[0]?.priorPresence, undefined);
  assert.match(reassertedRows[0]?.observationReference ?? "", /^Observation\//);
});

test("asserting absence round-trips and repeated assertions update one logical Observation", async () => {
  const fhir = mutationFhir();
  const input = {
    authHeader: "Bearer clinician",
    params: { encounterId: "e1" },
    body: {
      action: "assert",
      patientReference: "Patient/p1",
      conditionReference: "Condition/unique",
      atomicFindingId: atomicId("offered-only"),
      presence: "absent",
    },
  };

  const first = await handleDiagnosisFindingsMutationRequest(clinicalDeps(fhir), input);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(atomicObservations(fhir)[0]?.valueBoolean, false);
  const second = await handleDiagnosisFindingsMutationRequest(clinicalDeps(fhir), input);

  assert.equal(second.status, 200, JSON.stringify(second.body));
  const observations = atomicObservations(fhir);
  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.status, "preliminary");
  assert.equal(observations[0]?.valueBoolean, false);
  assert.equal(observations[0]?.component?.some((row) => row.code.coding?.some((coding) => coding.code === "GRADE")), false);
  assert.equal(observations[0]?.focus, undefined);
  assert.equal(observationLateralityCode(observations[0]!), "OD");
  assert.equal(componentString(observations[0]!, "LATERALITY_SOURCE"), "inherited");
  const reference = `Observation/${observations[0]!.id}`;
  assert.deepEqual(conditionEvidence(fhir, "unique"), [reference]);
  assert.equal(fhir.resources.filter((resource) => resource.resourceType === "Provenance").length, 2);

  const reloaded = await handleDiagnosisFindingsReadRequest(clinicalDeps(fhir), {
    authHeader: "Bearer clinician",
    params: { encounterId: "e1" },
    query: { condition: "Condition/unique" },
  });
  assert.equal(reloaded.status, 200, JSON.stringify(reloaded.body));
  const reloadedBody = reloaded.body as {
    findings: Array<{ atomicFindingId: string; presence?: string }>;
    bySection: Record<string, Array<{ atomicFindingId: string; presence?: string; source: string }>>;
  };
  const finding = reloadedBody.findings
    .find((row) => row.atomicFindingId === atomicId("offered-only"));
  assert.equal(finding?.presence, "absent");
  assert.deepEqual(
    reloadedBody.bySection[LENS_DEFINITION.sectionKey!]?.filter((row) =>
      row.atomicFindingId === atomicId("offered-only")
    ).map((row) => ({
      atomicFindingId: row.atomicFindingId,
      presence: row.presence,
      source: row.source,
    })),
    [{ atomicFindingId: atomicId("offered-only"), presence: "absent", source: "atomic" }],
  );
});

test("assertion finds an existing same-eye Observation on page two and never creates a duplicate", async () => {
  const fhir = mutationFhir();
  const existing = atomicObservation("existing-page-two", "e1", "offered-only", true, "OD");
  fhir.resources.push(existing);
  fhir.pages.set("Observation", [[], [existing]]);

  const response = await mutate(fhir, {
    action: "assert",
    patientReference: "Patient/p1",
    conditionReference: "Condition/unique",
    atomicFindingId: atomicId("offered-only"),
    presence: "absent",
  });

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(response.body, { observationReference: "Observation/existing-page-two" });
  assert.equal(atomicObservations(fhir).length, 1);
  assert.equal(atomicObservations(fhir)[0]?.valueBoolean, false);
  assert.deepEqual(fhir.followedUrls, ["/fhir/R4/Observation?_page=2"]);
});

for (const scenario of ["cross-origin", "off-root", "unavailable", "cycle", "upstream"] as const) {
  test(`findings pagination fails closed for a ${scenario} next page`, async () => {
    const fhir = readModelFhir();
    const conditions = fhir.resources.filter((resource): resource is Condition => resource.resourceType === "Condition");
    fhir.pages.set("Condition", [conditions, []]);
    if (scenario === "cross-origin") {
      fhir.pageLinks.set("Condition:1", "https://evil.example/fhir/R4/Condition?_page=2");
    }
    if (scenario === "off-root") {
      fhir.pageLinks.set("Condition:1", "/admin/Condition?_page=2");
    }
    if (scenario === "cycle") {
      fhir.pageLinks.set("Condition:2", "/fhir/R4/Condition?_page=2");
    }
    if (scenario === "upstream") {
      fhir.searchUrlFailures.set("/fhir/R4/Condition?_page=2", 503);
    }
    const client = scenario === "unavailable" ? withoutSearchUrl(fhir) : fhir;

    const response = await handleDiagnosisFindingsReadRequest(clinicalDeps(client), {
      authHeader: "Bearer clinician",
      params: { encounterId: "e1" },
      query: {},
    });

    assert.equal(response.status, 502, scenario);
    assert.deepEqual(response.body, { error: "FHIR diagnosis findings dependency failed." }, scenario);
  });
}

for (const status of [401, 403, 500]) {
  test(`findings maps a FHIR ${status} dependency response without a generic route 500`, async () => {
    const fhir = mutationFhir();
    fhir.readFailures.set("Encounter/e1", status);

    const response = await handleDiagnosisFindingsReadRequest(clinicalDeps(fhir), {
      authHeader: "Bearer clinician",
      params: { encounterId: "e1" },
      query: {},
    });

    assert.equal(response.status, status === 500 ? 502 : 403, String(status));
    assert.deepEqual(response.body, {
      error: status === 500
        ? "FHIR diagnosis findings dependency failed."
        : "Diagnosis findings are outside the caller's patient compartment.",
    }, String(status));
  });
}

for (const status of [401, 403, 500]) {
  test(`GET findings route preserves the named FHIR ${status} dependency response`, async (t) => {
    const fhir = mutationFhir();
    fhir.readFailures.set("Encounter/e1", status);
    const base = await startFindingsRoutes(t, "admin", fhir);

    const response = await fetch(`${base}/clinical-graph/encounters/e1/findings`, {
      headers: { Authorization: "Bearer clinician" },
    });

    assert.equal(response.status, status === 500 ? 502 : 403);
    assert.deepEqual(await response.json(), {
      error: status === 500
        ? "FHIR diagnosis findings dependency failed."
        : "Diagnosis findings are outside the caller's patient compartment.",
    });
  });
}

for (const [dependency, status] of [
  ["Encounter", 404],
  ["Encounter", 410],
  ["Condition", 404],
  ["Condition", 410],
  ["Observation", 404],
  ["Observation", 410],
] as const) {
  test(`findings maps ${dependency} FHIR ${status} to a non-leaking 404`, async () => {
    const fhir = readModelFhir();
    if (dependency === "Encounter") {
      fhir.readFailures.set("Encounter/e1", status);
    } else {
      fhir.searchFailures.set(dependency, status);
    }

    const response = await handleDiagnosisFindingsReadRequest(clinicalDeps(fhir), {
      authHeader: "Bearer clinician",
      params: { encounterId: "e1" },
      query: {},
    });

    assert.equal(response.status, 404, `${dependency} ${status}: ${JSON.stringify(response.body)}`);
    assert.deepEqual(response.body, { error: "Diagnosis findings resources were not found." });
  });
}

test("findings gives Condition bodySite laterality precedence over a stale catalog identifier", async () => {
  const fhir = readModelFhir();
  const unique = fhir.resources.find((resource): resource is Condition =>
    resource.resourceType === "Condition" && resource.id === "unique"
  )!;
  unique.bodySite = [{ text: "OS" }];

  const response = await handleDiagnosisFindingsReadRequest(clinicalDeps(fhir), {
    authHeader: "Bearer clinician",
    params: { encounterId: "e1" },
    query: {},
  });

  assert.equal(response.status, 200, JSON.stringify(response.body));
  const visit = (response.body as { visitDiagnoses: Array<{ conditionReference: string; laterality: string }> })
    .visitDiagnoses.find((row) => row.conditionReference === "Condition/unique");
  assert.equal(visit?.laterality, "OS");
});

test("GET findings route returns missing lineage as visible state and a cyclic next link as 502", async (t) => {
  const missingLineage = carryFindingsFhir();
  missingLineage.readFailures.set("Condition/prior-unique", 410);
  const missingBase = await startFindingsRoutes(t, "admin", missingLineage);

  const missingResponse = await fetch(
    `${missingBase}/clinical-graph/encounters/e1/findings?condition=Condition%2Funique`,
    { headers: { Authorization: "Bearer clinician" } },
  );

  assert.equal(missingResponse.status, 200);
  const missingBody = await missingResponse.json() as {
    carryProvenance?: { edited: boolean; integrityWarning?: string };
  };
  assert.equal(missingBody.carryProvenance?.edited, true);
  assert.match(missingBody.carryProvenance?.integrityWarning ?? "", /missing|gone|unavailable/i);

  const cyclic = readModelFhir();
  const conditions = cyclic.resources.filter((resource): resource is Condition => resource.resourceType === "Condition");
  cyclic.pages.set("Condition", [conditions, []]);
  cyclic.pageLinks.set("Condition:2", "/fhir/R4/Condition?_page=2");
  const cyclicBase = await startFindingsRoutes(t, "admin", cyclic);
  const cyclicResponse = await fetch(`${cyclicBase}/clinical-graph/encounters/e1/findings`, {
    headers: { Authorization: "Bearer clinician" },
  });

  assert.equal(cyclicResponse.status, 502);
  assert.deepEqual(await cyclicResponse.json(), { error: "FHIR diagnosis findings dependency failed." });
});

for (const status of [404, 410]) {
  for (const reference of [
    "Condition/prior-unique",
    "Encounter/prior-e1",
    "Observation/prior-offered-absent-od",
  ]) {
    test(`${status} ${reference} lineage stays a 200 visible integrity state`, async () => {
      const fhir = carryFindingsFhir();
      fhir.readFailures.set(reference, status);

      const response = await handleDiagnosisFindingsReadRequest(clinicalDeps(fhir), {
        authHeader: "Bearer clinician",
        params: { encounterId: "e1" },
        query: { condition: "Condition/unique" },
      });

      assert.equal(response.status, 200, `${status} ${reference}`);
      const carry = (response.body as {
        carryProvenance?: { edited: boolean; integrityWarning?: string };
      }).carryProvenance;
      assert.equal(carry?.edited, true, `${status} ${reference}`);
      assert.match(carry?.integrityWarning ?? "", /missing|gone|unavailable/i, `${status} ${reference}`);
    });
  }
}

test("asserting the same finding for another eye preserves the existing eye assertion", async () => {
  const fhir = mutationFhir();
  const base = {
    action: "assert" as const,
    patientReference: "Patient/p1",
    conditionReference: "Condition/unique",
    atomicFindingId: atomicId("offered-only"),
  };

  assert.equal((await mutate(fhir, { ...base, presence: "present" })).status, 200);
  assert.equal((await mutate(fhir, { ...base, presence: "absent", laterality: "OS" })).status, 200);

  const observations = atomicObservations(fhir).sort((left, right) =>
    (observationLateralityCode(left) ?? "").localeCompare(observationLateralityCode(right) ?? "")
  );
  assert.deepEqual(observations.map((observation) => ({
    laterality: observationLateralityCode(observation),
    presence: observation.valueBoolean,
  })), [
    { laterality: "OD", presence: true },
    { laterality: "OS", presence: false },
  ]);
  assert.deepEqual(conditionEvidence(fhir, "unique").sort(), observations
    .map((observation) => `Observation/${observation.id}`).sort());
});

test("grade and laterality mutations enforce the configured scale and restore inherited laterality", async () => {
  const fhir = mutationFhir();
  const asserted = await mutate(fhir, {
    action: "assert",
    patientReference: "Patient/p1",
    conditionReference: "Condition/unique",
    atomicFindingId: atomicId("unique-section"),
    presence: "present",
  });
  assert.equal(asserted.status, 200, JSON.stringify(asserted.body));
  const observationReference = (asserted.body as { observationReference: string }).observationReference;

  const invalidGrade = await mutate(fhir, {
    action: "grade",
    patientReference: "Patient/p1",
    observationReference,
    grade: "3+",
  });
  assert.equal(invalidGrade.status, 400);
  assert.equal(componentString(atomicObservations(fhir)[0]!, "GRADE"), undefined);

  assert.equal((await mutate(fhir, {
    action: "grade",
    patientReference: "Patient/p1",
    observationReference,
    grade: "2+",
  })).status, 200);
  assert.equal(componentString(atomicObservations(fhir)[0]!, "GRADE"), "2+");
  assert.equal((await mutate(fhir, {
    action: "grade",
    patientReference: "Patient/p1",
    observationReference,
    grade: null,
  })).status, 200);
  assert.equal(componentString(atomicObservations(fhir)[0]!, "GRADE"), undefined);

  assert.equal((await mutate(fhir, {
    action: "laterality",
    patientReference: "Patient/p1",
    observationReference,
    laterality: "OS",
  })).status, 200);
  assert.equal(observationLateralityCode(atomicObservations(fhir)[0]!), "OS");
  assert.equal(componentString(atomicObservations(fhir)[0]!, "LATERALITY_SOURCE"), "explicit");
  assert.equal((await mutate(fhir, {
    action: "laterality",
    patientReference: "Patient/p1",
    observationReference,
    laterality: null,
  })).status, 200);
  assert.equal(observationLateralityCode(atomicObservations(fhir)[0]!), "OD");
  assert.equal(componentString(atomicObservations(fhir)[0]!, "LATERALITY_SOURCE"), "inherited");
});

test("clear enters the atomic Observation in error and rejects cross-encounter patient and Condition boundaries", async () => {
  const fhir = mutationFhir();
  fhir.resources.push({
    ...condition("other-encounter", "dx_unique", "right"),
    encounter: { reference: "Encounter/e2" },
    subject: { reference: "Patient/p2" },
  });
  const wrongPatient = await mutate(fhir, {
    action: "assert",
    patientReference: "Patient/p2",
    conditionReference: "Condition/unique",
    atomicFindingId: atomicId("offered-only"),
    presence: "present",
  });
  assert.equal(wrongPatient.status, 400);
  const wrongCondition = await mutate(fhir, {
    action: "assert",
    patientReference: "Patient/p1",
    conditionReference: "Condition/other-encounter",
    atomicFindingId: atomicId("offered-only"),
    presence: "present",
  });
  assert.equal(wrongCondition.status, 400);

  const asserted = await mutate(fhir, {
    action: "assert",
    patientReference: "Patient/p1",
    conditionReference: "Condition/unique",
    atomicFindingId: atomicId("offered-only"),
    presence: "present",
  });
  const observationReference = (asserted.body as { observationReference: string }).observationReference;
  const cleared = await mutate(fhir, {
    action: "clear",
    patientReference: "Patient/p1",
    observationReference,
  });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.equal(atomicObservations(fhir)[0]?.status, "entered-in-error");
  assert.deepEqual(conditionEvidence(fhir, "unique"), []);
});

test("assign rehomes Condition evidence idempotently and standalone removes the only binding home", async () => {
  const fhir = mutationFhir();
  const asserted = await mutate(fhir, {
    action: "assert",
    patientReference: "Patient/p1",
    conditionReference: "Condition/unique",
    atomicFindingId: atomicId("offered-only"),
    presence: "present",
  });
  const observationReference = (asserted.body as { observationReference: string }).observationReference;

  assert.equal((await mutate(fhir, {
    action: "assign",
    patientReference: "Patient/p1",
    observationReference,
    conditionReference: "Condition/second",
  })).status, 200);
  assert.equal((await mutate(fhir, {
    action: "assign",
    patientReference: "Patient/p1",
    observationReference,
    conditionReference: "Condition/second",
  })).status, 200);
  assert.deepEqual(conditionEvidence(fhir, "unique"), []);
  assert.deepEqual(conditionEvidence(fhir, "second"), [observationReference]);
  assert.equal(atomicObservations(fhir)[0]?.focus, undefined);

  assert.equal((await mutate(fhir, {
    action: "standalone",
    patientReference: "Patient/p1",
    observationReference,
  })).status, 200);
  assert.deepEqual(conditionEvidence(fhir, "unique"), []);
  assert.deepEqual(conditionEvidence(fhir, "second"), []);
  assert.equal(atomicObservations(fhir)[0]?.focus, undefined);
});

async function startFindingsRoutes(
  t: TestContext,
  forbiddenRole: PracticeRoleId,
  clinicianFhir?: DiagnosisFindingsFhirClient,
): Promise<string> {
  const authenticate = async (header: string | undefined) => header === FORBIDDEN_AUTH
    ? {
        staffReference: "Practitioner/forbidden",
        actorRole: forbiddenRole,
        fhir: unreachableFhir,
      }
    : header === "Bearer clinician" && clinicianFhir
      ? {
          staffReference: "Practitioner/doc",
          actorRole: "provider" as const,
          fhir: clinicianFhir,
        }
    : null;
  const deps = {
    fhirBaseUrl: "https://fhir.local",
    authenticate,
    findingDefinitions: async () => [LENS_DEFINITION],
    diagnosisCatalog: async () => DIAGNOSES,
    now: () => NOW,
  };
  const app = express();
  app.use(express.json());
  app.get("/clinical-graph/encounters/:encounterId/findings", async (req, res) => {
    const result = await handleDiagnosisFindingsReadRequest(deps, {
      authHeader: req.header("authorization"),
      params: req.params,
      query: req.query,
    });
    res.status(result.status).json(result.body);
  });
  app.put("/clinical-graph/encounters/:encounterId/findings", async (req, res) => {
    const result = await handleDiagnosisFindingsMutationRequest(deps, {
      authHeader: req.header("authorization"),
      params: req.params,
      body: req.body,
    });
    res.status(result.status).json(result.body);
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => listener.once("listening", resolve));
  t.after(() => listener.close());
  return `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
}

const unreachableFhir = new Proxy({}, {
  get() {
    throw new Error("FHIR must not be reached before route authorization succeeds.");
  },
});

const NOW = "2026-08-10T12:00:00.000Z";
const LENS_FIELD = "CUSTOM_ABNORMAL";
const LENS_DEFINITION: ClinicalFindingDefinition = {
  id: "finding-definition-lens",
  stableKey: "ocular-health:anterior:lens",
  display: "Lens",
  sectionKey: "ocular-health:anterior:lens",
  anatomyTarget: "eye",
  valueSchema: {
    type: "ocular-health-structure",
    perEye: true,
    fields: {
      [LENS_FIELD]: {
        localCode: LENS_FIELD,
        display: "Abnormal findings",
        origin: "practice",
        valueType: "multi-select",
        options: [
          {
            code: "unique-section",
            display: "Unique section finding",
            active: true,
            qualifiers: [{ kind: "graded", key: "grade", display: "Grade", options: ["1+", "2+"] }],
          },
          { code: "ambiguous-section", display: "Ambiguous section finding", active: true },
          { code: "unmatched-section", display: "Unmatched section finding", active: true },
          { code: "offered-only", display: "Offered only finding", active: true },
        ],
        order: 0,
        active: true,
      },
    },
  },
  sourceStatus: "verified-seed",
  diagnosisCandidates: [
    mapping("map-unique", "unique-section", "dx_unique"),
    mapping("map-ambiguous-a", "ambiguous-section", "dx_unique"),
    mapping("map-ambiguous-b", "ambiguous-section", "dx_second"),
    mapping("map-unmatched", "unmatched-section", "dx_missing"),
    mapping("map-offered", "offered-only", "dx_unique"),
  ],
  allowDiagnosisMapping: true,
  notBillReady: true,
  active: true,
  provenance: { source: "manual", recordedAt: NOW },
};

const DIAGNOSES: DiagnosisCatalogRow[] = [
  diagnosis("dx_unique", "Unique diagnosis"),
  diagnosis("dx_second", "Second diagnosis"),
  diagnosis("dx_missing", "Missing diagnosis"),
];

function mapping(id: string, option: string, diagnosisKey: string) {
  return {
    id,
    diagnosisKey,
    trigger: { kind: "option" as const, field: LENS_FIELD, anyOf: [option] },
    origin: "seed" as const,
    active: true,
  };
}

function diagnosis(stableKey: string, display: string): DiagnosisCatalogRow {
  return {
    id: `diagnosis-${stableKey}`,
    stableKey,
    display,
    clinicalFamily: "test",
    codingStatus: "verified",
    lateralityRequired: true,
    applicableFindingDefinitionIds: [],
    separatesSeverityStagePayerRisk: true,
    active: true,
    origin: "seed",
    provenance: { source: "manual", recordedAt: NOW },
  };
}

function atomicId(optionCode: string): string {
  return `${LENS_DEFINITION.stableKey}::${LENS_FIELD}::${optionCode}`;
}

function readModelFhir(): MemoryFhir {
  const fhir = new MemoryFhir();
  fhir.resources.push({
    resourceType: "Encounter",
    id: "e1",
    status: "in-progress",
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
    subject: { reference: "Patient/p1" },
  });
  fhir.resources.push(condition("unique", "dx_unique", "right"));
  fhir.resources.push(condition("second", "dx_second", "right", "provisional"));
  const missingVerification = condition("missing-verification", "dx_missing", "right");
  delete missingVerification.verificationStatus;
  fhir.resources.push(missingVerification);
  fhir.resources.push(sectionObservation("old", "2026-08-10T10:00:00.000Z", [
    component("unique-section", true),
    gradeComponent("unique-section", "1+"),
  ]));
  fhir.resources.push(sectionObservation("latest", "2026-08-10T11:00:00.000Z", [
    component("unique-section", true),
    gradeComponent("unique-section", "2+"),
    component("ambiguous-section", true),
    component("unmatched-section", true),
  ]));
  return fhir;
}

function condition(
  id: string,
  diagnosisKey: string,
  laterality: string,
  verificationStatus: "confirmed" | "provisional" = "confirmed",
): Condition {
  return {
    ...buildEncounterDiagnosisCondition({
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      code: { text: diagnosisKey },
      verificationStatus,
      identifiers: [{
        system: DIAGNOSIS_KEY_IDENTIFIER_SYSTEM,
        value: `e1::${diagnosisKey}::${laterality}`,
      }],
    }),
    id,
  };
}

function sectionObservation(
  id: string,
  effectiveDateTime: string,
  components: NonNullable<Observation["component"]>,
): Observation {
  return {
    resourceType: "Observation",
    id,
    status: "preliminary",
    code: {
      coding: [{
        system: ODOS_OPHTHALMOLOGY_CODE_SYSTEM,
        code: LENS_DEFINITION.stableKey,
        display: LENS_DEFINITION.display,
      }],
    },
    subject: { reference: "Patient/p1" },
    encounter: { reference: "Encounter/e1" },
    effectiveDateTime,
    extension: [{
      url: ODOS_EXTENSION_URLS.eyeLaterality,
      valueCodeableConcept: lateralityConcept("OD"),
    }],
    component: components,
  };
}

function component(optionCode: string, value: boolean): NonNullable<Observation["component"]>[number] {
  return {
    code: { coding: [{ system: ODOS_OPHTHALMOLOGY_CODE_SYSTEM, code: `OD_${LENS_FIELD}::${optionCode}` }] },
    valueBoolean: value,
  };
}

function gradeComponent(optionCode: string, value: string): NonNullable<Observation["component"]>[number] {
  return {
    code: { coding: [{ system: ODOS_OPHTHALMOLOGY_CODE_SYSTEM, code: `OD_${LENS_FIELD}::${optionCode}::grade` }] },
    valueString: value,
  };
}

function clinicalDeps(fhir: DiagnosisFindingsFhirClient) {
  return {
    fhirBaseUrl: "https://fhir.local",
    authenticate: async (header: string | undefined) => header === "Bearer clinician"
      ? { staffReference: "Practitioner/doc", actorRole: "provider" as const, fhir }
      : null,
    findingDefinitions: async () => [LENS_DEFINITION],
    diagnosisCatalog: async () => DIAGNOSES,
    now: () => NOW,
  };
}

function mutate(fhir: MemoryFhir, body: unknown) {
  return handleDiagnosisFindingsMutationRequest(clinicalDeps(fhir), {
    authHeader: "Bearer clinician",
    params: { encounterId: "e1" },
    body,
  });
}

function mutationFhir(): MemoryFhir {
  const fhir = new MemoryFhir();
  fhir.resources.push({
    resourceType: "Encounter",
    id: "e1",
    status: "in-progress",
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
    subject: { reference: "Patient/p1" },
  });
  fhir.resources.push(condition("unique", "dx_unique", "right"));
  fhir.resources.push(condition("second", "dx_second", "right", "provisional"));
  return fhir;
}

function carryFindingsFhir(): MemoryFhir {
  const fhir = mutationFhir();
  const currentCondition = fhir.resources.find((resource): resource is Condition =>
    resource.resourceType === "Condition" && resource.id === "unique"
  )!;
  currentCondition.evidence = [{ detail: [{ reference: "Observation/current-unique-present" }] }];
  fhir.resources.push({
    resourceType: "Encounter",
    id: "prior-e1",
    status: "finished",
    class: {},
    subject: { reference: "Patient/p1" },
    period: { start: "2026-07-10T09:00:00.000Z" },
  });
  const priorCondition = condition("prior-unique", "dx_unique", "right");
  priorCondition.encounter = { reference: "Encounter/prior-e1" };
  priorCondition.evidence = [{
    detail: [
      { reference: "Observation/prior-offered-absent-od" },
      { reference: "Observation/prior-offered-absent-os" },
    ],
  }];
  fhir.resources.push(
    priorCondition,
    atomicObservation(
      "current-unique-present",
      "e1",
      "unique-section",
      true,
      "OD",
      "1+",
    ),
    atomicObservation(
      "prior-offered-absent-od",
      "prior-e1",
      "offered-only",
      false,
      "OD",
      "historical-grade",
    ),
    atomicObservation(
      "prior-offered-absent-os",
      "prior-e1",
      "offered-only",
      false,
      "OS",
      "wrong-eye-grade",
    ),
    carryProvenance(),
  );
  return fhir;
}

function atomicObservation(
  id: string,
  encounterId: string,
  optionCode: string,
  present: boolean,
  laterality: "OD" | "OS" | "OU",
  grade?: string,
): Observation {
  return {
    resourceType: "Observation",
    id,
    status: "preliminary",
    code: {
      coding: [{
        system: ODOS_OPHTHALMOLOGY_CODE_SYSTEM,
        code: atomicId(optionCode),
        display: optionCode,
      }],
    },
    subject: { reference: "Patient/p1" },
    encounter: { reference: `Encounter/${encounterId}` },
    valueBoolean: present,
    extension: [{
      url: ODOS_EXTENSION_URLS.eyeLaterality,
      valueCodeableConcept: lateralityConcept(laterality),
    }],
    ...(grade ? {
      component: [{
        code: { coding: [{ system: ODOS_OPHTHALMOLOGY_CODE_SYSTEM, code: "GRADE" }] },
        valueString: grade,
      }],
    } : {}),
  };
}

function carryProvenance(): Provenance {
  return {
    resourceType: "Provenance",
    id: "carry-provenance",
    target: [
      { reference: "Condition/unique" },
      { reference: "Encounter/e1" },
      { reference: "Observation/current-unique-present" },
    ],
    recorded: "2026-08-10T11:00:00.000Z",
    activity: {
      coding: [{
        system: "http://terminology.hl7.org/CodeSystem/v3-DataOperation",
        code: "CREATE",
      }],
      text: "Diagnosis pull-forward",
    },
    agent: [{ who: { display: "Synthetic test actor" } }],
    entity: [
      { role: "source", what: { reference: "Condition/prior-unique" } },
      { role: "source", what: { reference: "Observation/prior-offered-absent-od" } },
      { role: "source", what: { reference: "Observation/prior-offered-absent-os" } },
    ],
  };
}

function atomicObservations(fhir: MemoryFhir): Observation[] {
  return fhir.resources.filter((resource): resource is Observation =>
    resource.resourceType === "Observation" &&
    resource.code.coding?.some((coding) => coding.code?.includes(`::${LENS_FIELD}::`)) === true
  );
}

function conditionEvidence(fhir: MemoryFhir, id: string): string[] {
  const condition = fhir.resources.find((resource): resource is Condition =>
    resource.resourceType === "Condition" && resource.id === id
  );
  return condition?.evidence?.flatMap((evidence) => evidence.detail ?? [])
    .flatMap((reference) => reference.reference ? [reference.reference] : []) ?? [];
}

function componentString(observation: Observation, code: string): string | undefined {
  return observation.component?.find((component) => component.code.coding?.some((coding) => coding.code === code))
    ?.valueString;
}

function observationLateralityCode(observation: Observation): string | undefined {
  return observation.extension?.find((extension) => extension.url === ODOS_EXTENSION_URLS.eyeLaterality)
    ?.valueCodeableConcept?.coding?.[0]?.code;
}

class MemoryFhir {
  readonly resources: Resource[] = [];
  readonly readFailures = new Map<string, number>();
  readonly searchFailures = new Map<string, number>();
  readonly pages = new Map<string, Resource[][]>();
  readonly pageLinks = new Map<string, string>();
  readonly searchUrlFailures = new Map<string, number>();
  readonly followedUrls: string[] = [];

  async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
    const failureStatus = this.readFailures.get(`${resourceType}/${id}`);
    if (failureStatus) {
      throw Object.assign(new Error(`Synthetic FHIR ${failureStatus}`), { status: failureStatus });
    }
    const resource = this.resources.find((candidate) =>
      candidate.resourceType === resourceType && candidate.id === id
    );
    if (!resource) throw new Error(`Missing ${resourceType}/${id}`);
    return structuredClone(resource as T);
  }

  async search<T extends Resource>(
    resourceType: T["resourceType"],
    params: Record<string, string> = {},
  ): Promise<Bundle<T>> {
    const failureStatus = this.searchFailures.get(resourceType);
    if (failureStatus) {
      throw Object.assign(new Error(`Synthetic FHIR ${failureStatus}`), { status: failureStatus });
    }
    const resources = this.resources.filter((resource) => {
      if (resource.resourceType !== resourceType) return false;
      if (params.encounter) {
        const reference = (resource as Condition | Observation).encounter?.reference;
        if (reference !== params.encounter) return false;
      }
      if (params.subject) {
        const reference = (resource as Condition | Observation).subject?.reference;
        if (reference !== params.subject) return false;
      }
      return true;
    });
    const pages = this.pages.get(resourceType);
    return this.searchBundle(
      resourceType,
      (pages?.[0] ?? resources) as T[],
      pages && pages.length > 1 ? 1 : undefined,
    );
  }

  async searchUrl<T extends Resource>(url: string, resourceType: T["resourceType"]): Promise<Bundle<T>> {
    this.followedUrls.push(url);
    const failureStatus = this.searchUrlFailures.get(url);
    if (failureStatus) {
      throw Object.assign(new Error(`Synthetic FHIR ${failureStatus}`), { status: failureStatus });
    }
    const parsed = new URL(url, "https://fhir.local");
    const page = Number(parsed.searchParams.get("_page"));
    const pages = this.pages.get(resourceType) ?? [];
    return this.searchBundle(
      resourceType,
      (pages[page - 1] ?? []) as T[],
      page < pages.length || this.pageLinks.has(`${resourceType}:${page}`) ? page : undefined,
    );
  }

  private searchBundle<T extends Resource>(
    resourceType: T["resourceType"],
    resources: T[],
    pageWithNext?: number,
  ): Bundle<T> {
    const next = pageWithNext === undefined
      ? undefined
      : this.pageLinks.get(`${resourceType}:${pageWithNext}`) ??
        `/fhir/R4/${resourceType}?_page=${pageWithNext + 1}`;
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: resources.map((resource) => ({ resource: structuredClone(resource as T) })),
      ...(next ? { link: [{ relation: "next", url: next }] } : {}),
    };
  }

  async create<T extends Resource>(resource: T): Promise<T> {
    const persisted = {
      ...resource,
      id: resource.id ?? `${resource.resourceType.toLowerCase()}-${this.resources.length + 1}`,
      meta: { versionId: "1", lastUpdated: NOW },
    } as T;
    this.resources.push(structuredClone(persisted));
    return structuredClone(persisted);
  }

  async update<T extends Resource>(
    resourceType: T["resourceType"],
    id: string,
    resource: T,
  ): Promise<T> {
    const index = this.resources.findIndex((candidate) =>
      candidate.resourceType === resourceType && candidate.id === id
    );
    if (index < 0) throw new Error(`Missing ${resourceType}/${id}`);
    const versionId = String(Number(this.resources[index]!.meta?.versionId ?? "0") + 1);
    const persisted = {
      ...resource,
      id,
      meta: { versionId, lastUpdated: NOW },
    } as T;
    this.resources[index] = structuredClone(persisted);
    return structuredClone(persisted);
  }
}

function withoutSearchUrl(fhir: MemoryFhir): DiagnosisFindingsFhirClient {
  return {
    read: fhir.read.bind(fhir),
    search: fhir.search.bind(fhir),
    create: fhir.create.bind(fhir),
    update: fhir.update.bind(fhir),
  };
}
