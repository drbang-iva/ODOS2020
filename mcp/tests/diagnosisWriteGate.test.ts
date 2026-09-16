import assert from "node:assert/strict";
import { test } from "node:test";
import type { BusinessAction, PracticeRoleId } from "../src/authz/roles.js";
import { handleDiagnosisPickRequest } from "../src/clinical-graph/diagnosis-pick-endpoint.js";
import { handleDiagnosisOrderRequest, handleDiagnosisProblemStatusRequest } from "../src/clinical-graph/diagnosis-order-endpoint.js";
import { handleDiagnosisPullRequest } from "../src/clinical-graph/diagnosis-carry-forward-endpoint.js";
import { handleDiagnosisVisitStatusUpdateRequest } from "../src/clinical-graph/diagnosis-visit-status-endpoint.js";
import { handleDiagnosisNewnessUpdateRequest } from "../src/clinical-graph/diagnosis-newness-endpoint.js";

for (const identity of [
  { actorRole: "staff" },
  { actorRole: "admin" },
  { actorRole: "provider", businessActions: ["chart.read", "chart.write"] },
  { actorRole: "staff", roles: ["staff", "provider"], businessActions: ["chart.read", "chart.write"] },
] satisfies Array<{ actorRole: PracticeRoleId; roles?: PracticeRoleId[]; businessActions?: BusinessAction[] }>) {
  test(`diagnosis entrypoints refuse ${identity.actorRole}${identity.businessActions ? " with diagnosis action revoked" : ""} before any dependency call`, async (t) => {
    let dependencyCalls = 0;
    const unexpected = async (): Promise<never> => {
      dependencyCalls += 1;
      throw new Error("The diagnosis action must be checked before reads or writes.");
    };
    const fhir = {
      baseUrl: "http://127.0.0.1/fhir/R4", read: unexpected, search: unexpected,
      searchUrl: unexpected, create: unexpected, update: unexpected, patch: unexpected,
      executeTransaction: unexpected,
    };
    const authenticate = async () => ({ staffReference: "Practitioner/synthetic", ...identity, fhir });
    const store = {
      listByEncounter: unexpected, upsert: unexpected,
      listNewnessOverrides: unexpected, upsertNewnessOverride: unexpected,
    };
    const input = { authHeader: "Bearer synthetic", params: { encounterId: "e1", conditionId: "c1" } };
    const requests = {
      pick: () => handleDiagnosisPickRequest({ authenticate, diagnosisVisitStatusStore: store }, {
        ...input, body: { action: "confirm", diagnosisKey: "presbyopia" },
      }),
      order: () => handleDiagnosisOrderRequest({ authenticate }, {
        ...input, body: { conditionReferences: ["Condition/c1"] },
      }),
      pull: () => handleDiagnosisPullRequest({ authenticate, fhirBaseUrl: fhir.baseUrl }, {
        ...input, body: { sourceEncounterReference: "Encounter/prior", sourceConditionReference: "Condition/prior" },
      }),
      status: () => handleDiagnosisVisitStatusUpdateRequest({ authenticate, store }, {
        ...input, body: { status: "stable" },
      }),
      newness: () => handleDiagnosisNewnessUpdateRequest({ authenticate, store }, {
        ...input, body: { value: "established" },
      }),
      complexity: () => handleDiagnosisProblemStatusRequest({ authenticate }, {
        ...input, body: { problemStatus: "stable-chronic", expectedEncounterVersion: "1" },
      }),
    };
    for (const [name, request] of Object.entries(requests)) {
      await t.test(name, async () => {
        const result = await request();
        assert.equal(result.status, 403, JSON.stringify(result.body));
        assert.equal(dependencyCalls, 0);
      });
    }
  });
}
