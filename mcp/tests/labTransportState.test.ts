import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LAB_TRANSPORT_STATES,
  ODOS_LAB_TRANSPORT_STATE_SYSTEM,
  assertLabTransportState,
  canTransitionLabTransportState,
  isTerminalLabTransportState,
  labTransportStateConcept,
} from "../src/fhir/labTransportState.js";

test("lab transport state is its own eight-code CodeSystem", () => {
  assert.equal(ODOS_LAB_TRANSPORT_STATE_SYSTEM, "https://odos2020.com/fhir/CodeSystem/lab-transport-state");
  assert.deepEqual(LAB_TRANSPORT_STATES.map(({ code }) => code), [
    "queued",
    "sent",
    "received",
    "cancelled",
    "error",
    "acknowledged",
    "in-production",
    "shipped",
  ]);
  assert.doesNotThrow(() => assertLabTransportState("sent"));
  assert.throws(() => assertLabTransportState("at-lab"), /Unknown lab transport state/);
  assert.deepEqual(labTransportStateConcept("received"), {
    coding: [{
      system: ODOS_LAB_TRANSPORT_STATE_SYSTEM,
      code: "received",
      display: "Received",
    }],
    text: "Received",
  });
});

test("manual lab transport transitions are independent from the clinical optical-order lifecycle", () => {
  assert.equal(canTransitionLabTransportState("queued", "sent"), true);
  assert.equal(canTransitionLabTransportState("sent", "received"), true);
  assert.equal(canTransitionLabTransportState("sent", "cancelled"), true);
  for (const state of ["queued", "sent", "error"] as const) {
    assert.equal(canTransitionLabTransportState(state, "error"), true, `${state} -> error`);
  }

  assert.equal(canTransitionLabTransportState("queued", "received"), false);
  assert.equal(canTransitionLabTransportState("received", "sent"), false);
  assert.equal(canTransitionLabTransportState("cancelled", "error"), false);
  assert.equal(isTerminalLabTransportState("received"), true);
  assert.equal(isTerminalLabTransportState("cancelled"), true);
  assert.equal(isTerminalLabTransportState("error"), false);
});

test("vendor transport states progress forward and permit skipped polling milestones", () => {
  assert.equal(canTransitionLabTransportState("sent", "acknowledged"), true);
  assert.equal(canTransitionLabTransportState("sent", "in-production"), true);
  assert.equal(canTransitionLabTransportState("sent", "shipped"), true);
  assert.equal(canTransitionLabTransportState("acknowledged", "in-production"), true);
  assert.equal(canTransitionLabTransportState("acknowledged", "shipped"), true);
  assert.equal(canTransitionLabTransportState("in-production", "shipped"), true);
  assert.equal(canTransitionLabTransportState("shipped", "received"), true);
  assert.equal(canTransitionLabTransportState("in-production", "acknowledged"), false);
  assert.equal(canTransitionLabTransportState("shipped", "in-production"), false);
});
