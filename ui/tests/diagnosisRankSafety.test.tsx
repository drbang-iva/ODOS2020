import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Condition, Encounter, Provenance } from "@medplum/fhirtypes";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DiagnosisRankActions,
  diagnosisRankMoveNeighbors,
} from "../src/components/charting/AssessmentSection";
import {
  diagnosisRankForTier,
  makeConditionPrincipal,
  swapConditionRanks,
} from "../src/lib/clinical-actions";
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

test("Make Principal swaps both ranks in one atomic Encounter PATCH", async () => {
  const encounter = rankedEncounter([1, 2, 3]);
  const capture = await captureEncounterPatch(encounter, async () => {
    await makeConditionPrincipal({ encounter, condition: CONDITIONS[1]! });
  });

  assert.equal(capture.encounterRequests, 1);
  assert.deepEqual(capture.operations, [
    { op: "replace", path: "/diagnosis/1/rank", value: 1 },
    { op: "replace", path: "/diagnosis/0/rank", value: 2 },
  ]);
  assert.deepEqual(applyRanks(encounter, capture.operations), [2, 1, 3]);
  assert.equal(new Set(applyRanks(encounter, capture.operations)).size, 3);
});

test("Make Principal without an existing principal updates only the target rank", async () => {
  const encounter = rankedEncounter([2, 3, 4]);
  const capture = await captureEncounterPatch(encounter, async () => {
    await makeConditionPrincipal({ encounter, condition: CONDITIONS[1]! });
  });

  assert.equal(capture.encounterRequests, 1);
  assert.deepEqual(capture.operations, [
    { op: "replace", path: "/diagnosis/1/rank", value: 1 },
  ]);
  assert.deepEqual(applyRanks(encounter, capture.operations), [2, 1, 4]);
});

test("Move up and Move down atomically swap adjacent secondary ranks", async () => {
  const encounter = rankedEncounter([1, 2, 3]);
  const movedUp = await captureEncounterPatch(encounter, async () => {
    await swapConditionRanks({
      encounter,
      condition: CONDITIONS[2]!,
      adjacentCondition: CONDITIONS[1]!,
    });
  });
  assert.equal(movedUp.encounterRequests, 1);
  assert.deepEqual(applyRanks(encounter, movedUp.operations), [1, 3, 2]);

  const movedDown = await captureEncounterPatch(encounter, async () => {
    await swapConditionRanks({
      encounter,
      condition: CONDITIONS[1]!,
      adjacentCondition: CONDITIONS[2]!,
    });
  });
  assert.equal(movedDown.encounterRequests, 1);
  assert.deepEqual(applyRanks(encounter, movedDown.operations), [1, 3, 2]);
});

test("rank actions render only for confirmed secondary diagnoses", () => {
  const props = {
    busy: false,
    canMoveUp: true,
    canMoveDown: true,
    onMakePrincipal: () => undefined,
    onMoveUp: () => undefined,
    onMoveDown: () => undefined,
  };
  const secondary = renderToStaticMarkup(
    <DiagnosisRankActions {...props} possible={false} principal={false} />,
  );
  assert.match(secondary, /Make Principal/);
  assert.match(secondary, /Move up/);
  assert.match(secondary, /Move down/);
  assert.doesNotMatch(
    renderToStaticMarkup(<DiagnosisRankActions {...props} possible={true} principal={false} />),
    /Make Principal|Move up|Move down/,
  );
  assert.doesNotMatch(
    renderToStaticMarkup(<DiagnosisRankActions {...props} possible={false} principal={true} />),
    /Make Principal|Move up|Move down/,
  );
});

test("the free-form diagnosis rank input and state wiring are removed", () => {
  const source = readFileSync(
    new URL("../src/components/charting/AssessmentSection.tsx", import.meta.url),
    "utf8",
  );
  assert.equal(source.includes(["next", "Rank"].join("")), false);
  assert.doesNotMatch(source, /Save tier|Tier rank|inputMode="numeric"/);
});

test("rank actions fail closed before PATCH for invalid or duplicate encounter ranks", async () => {
  for (const ranks of [[1, 0, 3], [1, -1, 3], [1, 2, 2]]) {
    const encounter = rankedEncounter(ranks);
    await assertRejectedWithoutEncounterPatch(encounter, () => makeConditionPrincipal({
      encounter,
      condition: CONDITIONS[1]!,
    }));
    await assertRejectedWithoutEncounterPatch(encounter, () => swapConditionRanks({
      encounter,
      condition: CONDITIONS[1]!,
      adjacentCondition: CONDITIONS[2]!,
    }));
  }

  const multiplePrincipals = rankedEncounter([1, 1, 3]);
  await assertRejectedWithoutEncounterPatch(multiplePrincipals, () => makeConditionPrincipal({
    encounter: multiplePrincipals,
    condition: CONDITIONS[2]!,
  }), /multiple principal diagnoses/);
  await assertRejectedWithoutEncounterPatch(multiplePrincipals, () => swapConditionRanks({
    encounter: multiplePrincipals,
    condition: CONDITIONS[1]!,
    adjacentCondition: CONDITIONS[2]!,
  }), /multiple principal diagnoses/);
});

test("unranked, invalid, and duplicate-rank secondaries have no enabled Move action", () => {
  const unranked = rankedEncounter([1, 2, 3]);
  delete unranked.diagnosis![2]!.rank;
  const invalid = rankedEncounter([1, 2, 0]);
  const duplicate = rankedEncounter([1, 2, 2]);

  assert.deepEqual(diagnosisRankMoveNeighbors(unranked, CONDITIONS, CONDITIONS[2]!), {});
  assert.deepEqual(diagnosisRankMoveNeighbors(invalid, CONDITIONS, CONDITIONS[2]!), {});
  assert.deepEqual(diagnosisRankMoveNeighbors(duplicate, CONDITIONS, CONDITIONS[2]!), {});

  const html = renderToStaticMarkup(
    <DiagnosisRankActions
      possible={false}
      principal={false}
      busy={false}
      canMoveUp={false}
      canMoveDown={false}
      onMakePrincipal={() => undefined}
      onMoveUp={() => undefined}
      onMoveDown={() => undefined}
    />,
  );
  assert.match(html, /Make Principal/);
  assert.match(html, /<button disabled=""[^>]*>Move up<\/button>/);
  assert.match(html, /<button disabled=""[^>]*>Move down<\/button>/);
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

function jsonResponse(resource: Encounter | Provenance): Response {
  return new Response(JSON.stringify(resource), {
    status: 200,
    headers: { "Content-Type": "application/fhir+json" },
  });
}
