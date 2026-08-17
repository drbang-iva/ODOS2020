import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Bundle, Condition, Encounter, Provenance, Resource } from "@medplum/fhirtypes";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DiagnosisProblemStatusField,
  DiagnosisRankActions,
} from "../src/components/charting/AssessmentSection";
import { MdmProblemsAxis } from "../src/components/charting/EncounterHeader";
import {
  DIAGNOSIS_KEY_IDENTIFIER_SYSTEM,
  diagnosisRankForTier,
  encounterDiagnosisProblemStatusPatchOperations,
  markConditionEnteredInError,
  principalDiagnosisOrder,
  updateConditionBodySite,
  updateConditionCode,
  updateEncounterDiagnosisProblemStatus,
} from "../src/lib/clinical-actions";
import { encounterDiagnosisProblemStatus } from "../src/lib/fhir-clinical/condition";
import { computeMdmHint } from "../src/lib/clinical-view-model";
import { buildProfessionalClaimInput, initialClaimDraft } from "../src/lib/submit-claims";

const CONDITIONS = ["principal", "secondary-a", "secondary-b"].map((id) => ({
  resourceType: "Condition" as const,
  id,
}));

test("assessment protocol routing delegates diagnosis matching and charge acceptance to server offers", () => {
  const source = readFileSync(
    new URL("../src/components/charting/AssessmentSection.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /clinical-graph\/protocols\/offers/);
  assert.match(source, /protocolDiagnoses\.map/);
  assert.match(source, /const acceptCharges = protocolOffer\?\.acceptCharges === true/);
  assert.doesNotMatch(source, /dry-eye-evaluation/);
  assert.doesNotMatch(source, /PROTOCOL_TRIGGER_CONFIGS/);
});

test("creation rank rules retain the duplicate-principal guard and append secondaries", () => {
  const encounter = rankedEncounter([1, 2]);
  assert.throws(
    () => diagnosisRankForTier(encounter, "principal"),
    /already has a principal diagnosis/,
  );
  assert.equal(diagnosisRankForTier(encounter, "secondary"), 3);
});

test("Make Principal computes one complete exact permutation without losing a diagnosis", () => {
  const encounter = rankedEncounter([1, 2, 3]);
  assert.deepEqual(principalDiagnosisOrder(encounter, encounterCondition("secondary-a")), [
    "Condition/secondary-a",
    "Condition/principal",
    "Condition/secondary-b",
  ]);
});

test("Make Principal moves a non-adjacent diagnosis first and shifts earlier diagnoses down in order", () => {
  const encounter = rankedEncounter([1, 2, 3]);
  assert.deepEqual(principalDiagnosisOrder(encounter, encounterCondition("secondary-b")), [
    "Condition/secondary-b",
    "Condition/principal",
    "Condition/secondary-a",
  ]);
});

test("Make Principal normalizes a rank-gap encounter through the complete permutation", () => {
  const encounter = rankedEncounter([2, 3, 4]);
  assert.deepEqual(principalDiagnosisOrder(encounter, encounterCondition("secondary-a")), [
    "Condition/secondary-a",
    "Condition/principal",
    "Condition/secondary-b",
  ]);
});

test("Make Principal refuses a provisional target before the endpoint call", () => {
  const encounter = rankedEncounter([1, 2, 3]);
  const provisional = encounterCondition("secondary-a");
  provisional.verificationStatus = {
    coding: [{
      system: "http://terminology.hl7.org/CodeSystem/condition-ver-status",
      code: "provisional",
    }],
  };
  assert.throws(() => principalDiagnosisOrder(encounter, provisional), /provisional diagnosis cannot be principal/i);
});

test("rank actions retain one-click Make Principal without legacy secondary move controls", () => {
  const props = {
    busy: false,
    onMakePrincipal: () => undefined,
  };
  const secondary = renderToStaticMarkup(
    <DiagnosisRankActions {...props} possible={false} principal={false} />,
  );
  assert.match(secondary, /Make Principal/);
  assert.doesNotMatch(secondary, /Move up|Move down/);
  assert.doesNotMatch(
    renderToStaticMarkup(<DiagnosisRankActions {...props} possible={true} principal={false} />),
    /Make Principal|Move up|Move down/,
  );
  assert.doesNotMatch(
    renderToStaticMarkup(<DiagnosisRankActions {...props} possible={false} principal={true} />),
    /Make Principal|Move up|Move down/,
  );
});

test("problem status patch targets one diagnosis entry and preserves unrelated extensions", async () => {
  const encounter = rankedEncounter([1, 2]);
  encounter.diagnosis![1]!.extension = [{
    url: "https://example.test/fhir/StructureDefinition/unrelated",
    valueString: "keep me",
  }];
  const operations = encounterDiagnosisProblemStatusPatchOperations(
    encounter,
    CONDITIONS[1]!,
    "stable-chronic",
  );

  assert.deepEqual(operations, [{
    op: "add",
    path: "/diagnosis/1/extension/-",
    value: {
      url: "https://odos2020.com/fhir/StructureDefinition/odos-encounter-diagnosis-problem-status",
      valueCodeableConcept: {
        coding: [{
          system: "https://odos2020.com/fhir/CodeSystem/mdm-problem-status",
          code: "stable-chronic",
          display: "Stable chronic illness",
        }],
        text: "Stable chronic illness",
      },
    },
  }]);

  encounter.diagnosis![1]!.extension!.push(operations[0]!.value as NonNullable<Encounter["diagnosis"]>[number]["extension"][number]);
  assert.equal(encounter.diagnosis![1]!.extension![0]!.valueString, "keep me");
  assert.equal(encounterDiagnosisProblemStatus(encounter.diagnosis![1]!), "stable-chronic");
});

test("problem status Provenance directly targets the Patient, Encounter, and affected Condition", async () => {
  const encounter = rankedEncounter([1, 2]);
  const condition = encounterCondition("secondary-a");
  const originalFetch = globalThis.fetch;
  let provenance: Provenance | undefined;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith(`/Encounter/${encounter.id}`) && init?.method === "PATCH") {
      return jsonResponse({ ...encounter, meta: { versionId: "8" } });
    }
    if (url.endsWith("/Provenance") && init?.method === "POST") {
      provenance = JSON.parse(String(init.body)) as Provenance;
      return jsonResponse({ ...provenance, id: "problem-status-provenance" });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  };
  try {
    await updateEncounterDiagnosisProblemStatus({
      encounter,
      condition,
      problemStatus: "stable-chronic",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(provenance?.target.map((target) => target.reference), [
    "Encounter/encounter-1",
    "Condition/secondary-a",
    "Patient/patient-1",
  ]);
  assert.equal(provenance?.activity?.coding?.[0]?.code, "UPDATE");
});

test("diagnosis laterality Provenance directly targets the Patient and affected Condition", async () => {
  const originalFetch = globalThis.fetch;
  let provenance: Provenance | undefined;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/BodyStructure?") && (!init?.method || init.method === "GET")) {
      return jsonResponse({
        resourceType: "Bundle",
        type: "searchset",
        entry: [{
          resource: {
            resourceType: "BodyStructure",
            id: "right-eye",
            patient: { reference: "Patient/patient-1" },
          },
        }],
      });
    }
    if (url.endsWith("/Condition/secondary-a") && init?.method === "PATCH") {
      return jsonResponse({ ...encounterCondition("secondary-a"), meta: { versionId: "5" } });
    }
    if (url.endsWith("/Provenance") && init?.method === "POST") {
      provenance = JSON.parse(String(init.body)) as Provenance;
      return jsonResponse({ ...provenance, id: "laterality-provenance" });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  };
  try {
    await updateConditionBodySite({
      condition: encounterCondition("secondary-a"),
      patientReference: "Patient/patient-1",
      laterality: "OD",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(provenance?.target.map((target) => target.reference), [
    "Condition/secondary-a",
    "Patient/patient-1",
  ]);
  assert.equal(provenance?.activity?.coding?.[0]?.code, "UPDATE");
});

test("diagnosis laterality PATCH atomically reconciles the existing catalog identifier suffix", async () => {
  const originalFetch = globalThis.fetch;
  let operations: Array<{ op: string; path: string; value?: unknown }> | undefined;
  const condition: Condition = {
    ...encounterCondition("secondary-a"),
    meta: { versionId: "4" },
    bodySite: [{ text: "OD" }],
    identifier: [
      {
        system: DIAGNOSIS_KEY_IDENTIFIER_SYSTEM,
        value: "encounter-1::dry_eye::right",
      },
      { system: "urn:example:preserved", value: "retain-me" },
    ],
  };
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/BodyStructure?") && (!init?.method || init.method === "GET")) {
      return jsonResponse({
        resourceType: "Bundle",
        type: "searchset",
        entry: [{
          resource: {
            resourceType: "BodyStructure",
            id: "left-eye",
            patient: { reference: "Patient/patient-1" },
          },
        }],
      });
    }
    if (url.endsWith("/Condition/secondary-a") && init?.method === "PATCH") {
      operations = JSON.parse(String(init.body));
      return jsonResponse({ ...condition, meta: { versionId: "5" } });
    }
    if (url.endsWith("/Provenance") && init?.method === "POST") {
      const provenance = JSON.parse(String(init.body)) as Provenance;
      return jsonResponse({ ...provenance, id: "laterality-provenance" });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  };
  try {
    await updateConditionBodySite({
      condition,
      patientReference: "Patient/patient-1",
      laterality: "OS",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(operations?.map(({ op, path }) => ({ op, path })), [
    { op: "replace", path: "/bodySite" },
    { op: "replace", path: "/identifier" },
  ]);
  assert.equal((operations?.[0]?.value as Array<{ text?: string }>)?.[0]?.text, "OS");
  assert.deepEqual(operations?.[1]?.value, [
    {
      system: DIAGNOSIS_KEY_IDENTIFIER_SYSTEM,
      value: "encounter-1::dry_eye::left",
    },
    { system: "urn:example:preserved", value: "retain-me" },
  ]);
});

test("diagnosis stage PATCH atomically replaces the code and stable catalog key", async () => {
  const originalFetch = globalThis.fetch;
  let operations: Array<{ op: string; path: string; value?: unknown }> | undefined;
  let provenance: Provenance | undefined;
  const condition: Condition = {
    ...encounterCondition("secondary-a"),
    meta: { versionId: "4" },
    bodySite: [{ text: "OD" }],
    identifier: [
      {
        system: DIAGNOSIS_KEY_IDENTIFIER_SYSTEM,
        value: "encounter-1::primary-open-angle-glaucoma::right",
      },
      { system: "urn:example:preserved", value: "retain-me" },
    ],
    code: { text: "Primary open-angle glaucoma" },
  };
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/Condition/secondary-a") && init?.method === "PATCH") {
      operations = JSON.parse(String(init.body));
      return jsonResponse({ ...condition, meta: { versionId: "5" } });
    }
    if (url.endsWith("/Provenance") && init?.method === "POST") {
      provenance = JSON.parse(String(init.body)) as Provenance;
      return jsonResponse({ ...provenance, id: "stage-provenance" });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  };
  try {
    await updateConditionCode({
      condition,
      diagnosisKey: "poag_mild",
      code: {
        system: "http://hl7.org/fhir/sid/icd-10-cm",
        code: "H40.1111",
        display: "Primary open-angle glaucoma, mild stage",
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(operations?.map(({ op, path }) => ({ op, path })), [
    { op: "replace", path: "/code" },
    { op: "replace", path: "/identifier" },
  ]);
  assert.deepEqual(operations?.[1]?.value, [
    {
      system: DIAGNOSIS_KEY_IDENTIFIER_SYSTEM,
      value: "encounter-1::poag_mild::right",
    },
    { system: "urn:example:preserved", value: "retain-me" },
  ]);
  assert.equal(provenance?.entity?.[0]?.role, "revision");
  assert.match(provenance?.entity?.[0]?.what?.display ?? "", /prior Condition\.code/);
});

test("bilateral eyelid laterality PATCH atomically replaces singular ICD coding with the catalog concept", async () => {
  const originalFetch = globalThis.fetch;
  let operations: Array<{ op: string; path: string; value?: unknown }> | undefined;
  const condition: Condition = {
    ...encounterCondition("secondary-a"),
    meta: { versionId: "4" },
    bodySite: [{ text: "OD" }],
    identifier: [{
      system: DIAGNOSIS_KEY_IDENTIFIER_SYSTEM,
      value: "encounter-1::meibomian_gland_dysfunction::right",
    }],
    code: {
      coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: "H02.88A", display: "Meibomian gland dysfunction" }],
      text: "Meibomian gland dysfunction",
    },
  };
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/BodyStructure?") && (!init?.method || init.method === "GET")) {
      return jsonResponse({
        resourceType: "Bundle",
        type: "searchset",
        entry: [{ resource: { resourceType: "BodyStructure", id: "both-eyes", patient: { reference: "Patient/patient-1" } } }],
      });
    }
    if (url.endsWith("/Condition/secondary-a") && init?.method === "PATCH") {
      operations = JSON.parse(String(init.body));
      return jsonResponse({ ...condition, meta: { versionId: "5" } });
    }
    if (url.endsWith("/Provenance") && init?.method === "POST") {
      return jsonResponse({ resourceType: "Provenance", id: "laterality-provenance", target: [], recorded: "2026-08-10T12:00:00Z", agent: [] });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  };
  try {
    await updateConditionBodySite({
      condition,
      patientReference: "Patient/patient-1",
      laterality: "OU",
      diagnosis: {
        stableKey: "meibomian_gland_dysfunction",
        display: "Meibomian gland dysfunction",
        bilateralResolution: "emit-both-eyes",
        icd10: { pattern: { right: "H02.88A", left: "H02.88B" } },
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(operations?.map(({ op, path }) => ({ op, path })), [
    { op: "replace", path: "/bodySite" },
    { op: "replace", path: "/identifier" },
    { op: "replace", path: "/code" },
  ]);
  assert.deepEqual(operations?.[2]?.value, {
    coding: [{
      system: "https://odos2020.com/fhir/CodeSystem/diagnosis-catalog",
      code: "meibomian_gland_dysfunction",
      display: "Meibomian gland dysfunction",
    }],
    text: "Meibomian gland dysfunction",
  });
});

test("diagnosis laterality PATCH atomically reconciles a legacy two-part catalog identifier suffix", async () => {
  const originalFetch = globalThis.fetch;
  let operations: Array<{ op: string; path: string; value?: unknown }> | undefined;
  const condition: Condition = {
    ...encounterCondition("secondary-a"),
    meta: { versionId: "4" },
    bodySite: [{ text: "OD" }],
    identifier: [
      {
        system: DIAGNOSIS_KEY_IDENTIFIER_SYSTEM,
        value: "dry_eye::right",
      },
      { system: "urn:example:preserved", value: "retain-me" },
    ],
  };
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/BodyStructure?") && (!init?.method || init.method === "GET")) {
      return jsonResponse({
        resourceType: "Bundle",
        type: "searchset",
        entry: [{
          resource: {
            resourceType: "BodyStructure",
            id: "left-eye",
            patient: { reference: "Patient/patient-1" },
          },
        }],
      });
    }
    if (url.endsWith("/Condition/secondary-a") && init?.method === "PATCH") {
      operations = JSON.parse(String(init.body));
      return jsonResponse({ ...condition, meta: { versionId: "5" } });
    }
    if (url.endsWith("/Provenance") && init?.method === "POST") {
      const provenance = JSON.parse(String(init.body)) as Provenance;
      return jsonResponse({ ...provenance, id: "laterality-provenance" });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  };
  try {
    await updateConditionBodySite({
      condition,
      patientReference: "Patient/patient-1",
      laterality: "OS",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(operations?.map(({ op, path }) => ({ op, path })), [
    { op: "replace", path: "/bodySite" },
    { op: "replace", path: "/identifier" },
  ]);
  assert.equal((operations?.[0]?.value as Array<{ text?: string }>)?.[0]?.text, "OS");
  assert.deepEqual(operations?.[1]?.value, [
    {
      system: DIAGNOSIS_KEY_IDENTIFIER_SYSTEM,
      value: "dry_eye::left",
    },
    { system: "urn:example:preserved", value: "retain-me" },
  ]);
});

test("problem status control renders a conspicuous required-empty state without unspecified", () => {
  const markup = renderToStaticMarkup(React.createElement(DiagnosisProblemStatusField, {
    disabled: false,
    onChange: () => undefined,
  }));

  assert.match(markup, /Problem status/);
  assert.match(markup, /Required — select status/);
  assert.match(markup, /data-required="true"/);
  assert.doesNotMatch(markup, /unspecified/i);
});

test("unavailable MDM axis renders the missing problem-status reason where a tier would appear", () => {
  const mdmHint = computeMdmHint({ encounter: rankedEncounter([1, 2]) });

  const markup = renderToStaticMarkup(React.createElement(MdmProblemsAxis, {
    mdmHint,
    procedureFamily: "em",
  }));

  assert.match(markup, /Problem-status facts unavailable/);
  assert.doesNotMatch(markup, /Blocked/);
  assert.match(markup, /problem status unset on 2 diagnoses/);
  assert.doesNotMatch(markup, /Moderate MDM threshold/);
});

test("one bilateral eyelid diagnosis contributes exactly one MDM problem", () => {
  const encounter = rankedEncounter([1]);
  encounter.diagnosis![0]!.condition.reference = "Condition/mgd-ou";
  encounter.diagnosis![0]!.extension = [mdmStatusExtension("stable-chronic")];

  const mdm = computeMdmHint({ encounter });

  assert.equal(mdm.sourceDiagnosisCount, 1);
  assert.equal(mdm.counts.stableChronic, 1);
  assert.equal(mdm.tier, "Low");
});

test("retracting a classified diagnosis atomically removes its High MDM contribution", async () => {
  const target = encounterCondition("principal");
  const encounter = rankedEncounter([1, 3]);
  encounter.diagnosis![0]!.extension = [mdmStatusExtension("threat-to-life-or-bodily-function")];
  encounter.diagnosis![1]!.extension = [mdmStatusExtension("stable-chronic")];

  const result = await retractInMemory(target, encounter);

  assert.deepEqual(computeMdmHint({ encounter: result.encounter }), {
    status: "ready",
    tier: "Low",
    counts: {
      minimalSelfLimited: 0,
      stableChronic: 1,
      chronicExacerbationProgression: 0,
      chronicSevereExacerbation: 0,
      acuteUncomplicated: 0,
      acuteComplicatedOrSystemic: 0,
      undiagnosedNewProblemUncertainPrognosis: 0,
      threatToLifeOrBodilyFunction: 0,
    },
    sourceDiagnosisCount: 1,
  });
  assert.deepEqual(result.encounter.diagnosis?.map((diagnosis) => ({
    reference: diagnosis.condition.reference,
    rank: diagnosis.rank,
  })), [{ reference: "Condition/secondary-a", rank: 1 }]);
  assert.equal(result.condition.verificationStatus?.coding?.[0]?.code, "entered-in-error");
  assert.equal(result.condition.clinicalStatus, undefined);
  assert.equal(result.transactionRequests, 1);
});

test("retracting an unclassified diagnosis removes the permanent blocked MDM state", async () => {
  const target = encounterCondition("secondary-a");
  const encounter = rankedEncounter([1, 4]);
  encounter.diagnosis![0]!.extension = [mdmStatusExtension("stable-chronic")];

  const result = await retractInMemory(target, encounter);

  const mdm = computeMdmHint({ encounter: result.encounter });
  assert.equal(mdm.status, "ready");
  assert.equal(mdm.tier, "Low");
  assert.deepEqual(result.encounter.diagnosis?.map((diagnosis) => diagnosis.condition.reference), [
    "Condition/principal",
  ]);
  assert.equal(result.condition.verificationStatus?.coding?.[0]?.code, "entered-in-error");
  assert.equal(result.transactionRequests, 1);
});

test("the free-form diagnosis rank input and state wiring are removed", () => {
  const source = readFileSync(
    new URL("../src/components/charting/AssessmentSection.tsx", import.meta.url),
    "utf8",
  );
  assert.equal(source.includes(["next", "Rank"].join("")), false);
  assert.doesNotMatch(source, /Save tier|Tier rank|inputMode="numeric"/);
});

test("both diagnosis surfaces retain Make Principal on the authoritative reorder write path", () => {
  const assessment = readFileSync(
    new URL("../src/components/charting/AssessmentSection.tsx", import.meta.url),
    "utf8",
  );
  const workspace = readFileSync(
    new URL("../src/components/charting/DiagnosisWorkspace.tsx", import.meta.url),
    "utf8",
  );
  assert.match(assessment, /updateDiagnosisOrder\(encounterId, principalDiagnosisOrder\(encounter, condition\)\)/);
  assert.match(workspace, /updateDiagnosisOrder\(encounterId, principalDiagnosisOrder\(encounter, selectedCondition\)\)/);
  for (const source of [assessment, workspace]) {
    assert.match(source, /ReorderImpressionsModal/);
    assert.doesNotMatch(source, /makeConditionPrincipal|swapConditionRanks|diagnosisRankMoveNeighbors/);
  }
});

test("principal permutation fails closed for invalid or duplicate encounter ranks", () => {
  for (const ranks of [[1, 0, 3], [1, -1, 3], [1, 2, 2]]) {
    const encounter = rankedEncounter(ranks);
    assert.throws(
      () => principalDiagnosisOrder(encounter, encounterCondition("secondary-a")),
      /invalid or duplicate diagnosis ranks and must be corrected before reordering/,
    );
  }

  const unranked = rankedEncounter([1, 2, 3]);
  delete unranked.diagnosis![2]!.rank;
  assert.throws(
    () => principalDiagnosisOrder(unranked, encounterCondition("secondary-a")),
    /invalid or duplicate diagnosis ranks and must be corrected before reordering/,
  );

  const multiplePrincipals = rankedEncounter([1, 1, 3]);
  assert.throws(
    () => principalDiagnosisOrder(multiplePrincipals, encounterCondition("secondary-b")),
    /multiple principal diagnoses/,
  );
});

test("rank action has no competing arbitrary-order buttons", () => {
  const html = renderToStaticMarkup(
    <DiagnosisRankActions
      possible={false}
      principal={false}
      busy={false}
      onMakePrincipal={() => undefined}
    />,
  );
  assert.match(html, /Make Principal/);
  assert.doesNotMatch(html, /Move up|Move down/);
});

test("claim prefill keeps diagnosis order as the source of per-line pointer positions", () => {
  const draft = initialClaimDraft("2026-07-21");
  Object.assign(draft, {
    patientReference: "Patient/pat-1",
    providerReference: "Practitioner/prov-1",
    insurerReference: "Organization/payer-1",
    coverageReference: "Coverage/cov-1",
    patientAccountNumber: "PCN-1",
    payerId: "PAYER-1",
    billingProvider: { npi: "1111111112", phone: "5555550100" },
    renderingProvider: { npi: "2222222223", lastName: "Provider" },
    patient: { firstName: "Jane", lastName: "Test", dateOfBirth: "1980-01-01", sex: "F" },
    subscriber: {
      firstName: "Jane",
      lastName: "Test",
      dateOfBirth: "1980-01-01",
      sex: "F",
      relationshipCode: "18",
      address1: "1 Test Way",
      city: "Testville",
      state: "NY",
      zip: "10001",
    },
    diagnoses: [
      { code: "PRINCIPAL", description: "Principal" },
      { code: "SECONDARY", description: "Secondary" },
    ],
    charges: [{
      id: "charge-1",
      codeType: "CPT",
      code: "PROC-A",
      description: "Procedure A",
      feeDollars: "100.00",
      quantity: "1",
      diagnosisSequence: [2],
    }],
  });
  const claim = buildProfessionalClaimInput(draft);
  assert.deepEqual(claim.diagnoses.map(({ code }) => code), ["PRINCIPAL", "SECONDARY"]);
  assert.deepEqual(claim.chargeItems[0].diagnosisSequence, [2]);
});

function rankedEncounter(ranks: number[]): Encounter {
  return {
    resourceType: "Encounter",
    id: "encounter-1",
    meta: { versionId: "7" },
    status: "in-progress",
    class: {},
    diagnosis: ranks.map((rank, index) => ({
      condition: { reference: `Condition/${CONDITIONS[index]!.id}` },
      rank,
    })),
  };
}

function encounterCondition(id: string): Condition {
  return {
    resourceType: "Condition",
    id,
    meta: { versionId: "4" },
    clinicalStatus: {
      coding: [{
        system: "http://terminology.hl7.org/CodeSystem/condition-clinical",
        code: "active",
      }],
    },
    verificationStatus: {
      coding: [{
        system: "http://terminology.hl7.org/CodeSystem/condition-ver-status",
        code: "confirmed",
      }],
    },
    category: [],
    code: { text: id },
    subject: { reference: "Patient/patient-1" },
    encounter: { reference: "Encounter/encounter-1" },
  };
}

function mdmStatusExtension(code: "stable-chronic" | "threat-to-life-or-bodily-function") {
  return {
    url: "https://odos2020.com/fhir/StructureDefinition/odos-encounter-diagnosis-problem-status",
    valueCodeableConcept: {
      coding: [{
        system: "https://odos2020.com/fhir/CodeSystem/mdm-problem-status",
        code,
      }],
    },
  };
}

async function retractInMemory(
  target: Condition,
  initialEncounter: Encounter,
): Promise<{
  condition: Condition;
  encounter: Encounter;
  transactionRequests: number;
}> {
  const originalFetch = globalThis.fetch;
  let condition = structuredClone(target);
  let encounter = structuredClone(initialEncounter);
  let transactionRequests = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith(`/Encounter/${encounter.id}`) && (!init?.method || init.method === "GET")) {
      return jsonResponse(encounter);
    }
    if (url.endsWith(`/Condition/${target.id}`) && init?.method === "PATCH") {
      condition = {
        ...condition,
        verificationStatus: {
          coding: [{
            system: "http://terminology.hl7.org/CodeSystem/condition-ver-status",
            code: "entered-in-error",
          }],
        },
      };
      delete condition.clinicalStatus;
      return jsonResponse(condition);
    }
    if (url.endsWith("/fhir/R4") && init?.method === "POST") {
      transactionRequests += 1;
      const bundle = JSON.parse(String(init.body)) as Bundle;
      for (const entry of bundle.entry ?? []) {
        if (entry.resource?.resourceType === "Condition") condition = structuredClone(entry.resource);
        if (entry.resource?.resourceType === "Encounter") encounter = structuredClone(entry.resource);
      }
      return jsonResponse({
        resourceType: "Bundle",
        type: "transaction-response",
        entry: (bundle.entry ?? []).map((entry) => ({
          resource: entry.resource,
          response: { status: "200 OK" },
        })),
      });
    }
    if (url.endsWith("/Provenance") && init?.method === "POST") {
      return jsonResponse({ resourceType: "Provenance", id: "provenance-1" });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  };
  try {
    await markConditionEnteredInError(condition);
  } finally {
    globalThis.fetch = originalFetch;
  }
  return { condition, encounter, transactionRequests };
}

async function captureEncounterPatch(
  encounter: Encounter,
  action: () => Promise<void>,
): Promise<{ encounterRequests: number; operations: Array<Record<string, unknown>> }> {
  const originalFetch = globalThis.fetch;
  let encounterRequests = 0;
  let operations: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith(`/Encounter/${encounter.id}`) && init?.method === "PATCH") {
      encounterRequests += 1;
      operations = JSON.parse(String(init.body)) as Array<Record<string, unknown>>;
      return jsonResponse({ ...encounter, meta: { versionId: "8" } });
    }
    if (String(input).endsWith("/Provenance") && init?.method === "POST") {
      return jsonResponse({ resourceType: "Provenance", id: "provenance-1" } satisfies Provenance);
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${String(input)}`);
  };
  try {
    await action();
  } finally {
    globalThis.fetch = originalFetch;
  }
  return { encounterRequests, operations };
}

async function assertRejectedWithoutEncounterPatch(
  encounter: Encounter,
  action: () => Promise<void>,
  expectedError: RegExp = /invalid or duplicate diagnosis ranks and must be corrected before reordering/,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  let encounterRequests = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith(`/Encounter/${encounter.id}`) && init?.method === "PATCH") {
      encounterRequests += 1;
      return jsonResponse(encounter);
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${String(input)}`);
  };
  try {
    await assert.rejects(action, expectedError);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(encounterRequests, 0);
}

function applyRanks(encounter: Encounter, operations: Array<Record<string, unknown>>): number[] {
  const ranks = (encounter.diagnosis ?? []).map((diagnosis) => diagnosis.rank);
  for (const operation of operations) {
    const index = Number(String(operation.path).split("/")[2]);
    ranks[index] = operation.op === "remove" ? undefined : operation.value as number;
  }
  return ranks.filter((rank): rank is number => rank !== undefined);
}

function jsonResponse(resource: Resource | Bundle): Response {
  return new Response(JSON.stringify(resource), {
    status: 200,
    headers: { "Content-Type": "application/fhir+json" },
  });
}
