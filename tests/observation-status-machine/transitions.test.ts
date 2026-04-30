import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMedplumAccessPolicy, getRoleDeclaration } from "../../mcp/src/authz/roles.js";
import {
  ALLOWED_OBSERVATION_STATUS_TRANSITIONS,
  FHIR_OBSERVATION_STATUSES,
  OBSERVATION_STATUS_WRITE_CONSTRAINT_EXPRESSION,
  ObservationStatusTransitionError,
  accessPolicyConstraintRejectsObservationStatusPatch,
  assertObservationStatusTransition,
  type ObservationStatusActorRole,
  type ObservationStatusBefore,
} from "../../policy/observation-status-machine.js";

test("v0.5c Observation.status machine allows every canonical transition", () => {
  for (const transition of ALLOWED_OBSERVATION_STATUS_TRANSITIONS) {
    assert.doesNotThrow(() =>
      assertObservationStatusTransition({
        from: transition.from,
        to: transition.to,
        actorRole: transition.actorRole,
      }),
    );
    assert.equal(
      accessPolicyConstraintRejectsObservationStatusPatch({
        from: transition.from,
        to: transition.to,
        actorRole: transition.actorRole,
      }),
      false,
    );
  }
});

test("v0.5c Observation.status machine rejects every disallowed transition", () => {
  const statuses: ObservationStatusBefore[] = [undefined, ...FHIR_OBSERVATION_STATUSES];
  const roles: ObservationStatusActorRole[] = ["scribe", "clinician"];

  for (const from of statuses) {
    for (const to of FHIR_OBSERVATION_STATUSES) {
      for (const actorRole of roles) {
        const allowed = ALLOWED_OBSERVATION_STATUS_TRANSITIONS.some(
          (transition) =>
            (transition.from ?? undefined) === (from ?? undefined) &&
            transition.to === to &&
            transition.actorRole === actorRole,
        );
        if (allowed) {
          continue;
        }

        assert.throws(
          () => assertObservationStatusTransition({ from, to, actorRole }),
          ObservationStatusTransitionError,
          `${from ?? "(none)"} -> ${to} by ${actorRole} should fail at MCP layer`,
        );
        assert.equal(
          accessPolicyConstraintRejectsObservationStatusPatch({ from, to, actorRole }),
          true,
          `${from ?? "(none)"} -> ${to} by ${actorRole} should fail at AccessPolicy guard`,
        );
      }
    }
  }
});

test("v0.5c Observation AccessPolicy emits the status-machine writeConstraint", () => {
  const policy = buildMedplumAccessPolicy(getRoleDeclaration("clinician"));
  const observationRule = policy.resource?.find((resource) => resource.resourceType === "Observation");

  assert.ok(observationRule?.writeConstraint?.length);
  assert.ok(
    observationRule.writeConstraint.some(
      (constraint) => constraint.expression === OBSERVATION_STATUS_WRITE_CONSTRAINT_EXPRESSION,
    ),
  );
  assert.match(JSON.stringify(observationRule.writeConstraint), /%before\.status != 'final'/);
  assert.match(OBSERVATION_STATUS_WRITE_CONSTRAINT_EXPRESSION, /status = 'entered-in-error'/);
});

test("v0.5c Observation.status rejects non-ValueSet status strings", () => {
  assert.throws(
    () =>
      assertObservationStatusTransition({
        from: "preliminary",
        to: "review-pending",
        actorRole: "clinician",
      }),
    /FHIR R4 ObservationStatus ValueSet/,
  );
});
