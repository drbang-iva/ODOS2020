import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OPTICAL_ORDER_STATUSES,
  OSOD_OPTICAL_ORDER_STATUS_SYSTEM,
  assertOpticalOrderStatus,
  opticalOrderStatusConcept,
} from "../src/fhir/opticalOrderStatus.js";

test("the optical order status vocabulary is the 17 Foxfire-corpus statuses", () => {
  assert.equal(OPTICAL_ORDER_STATUSES.length, 17);
  const codes = OPTICAL_ORDER_STATUSES.map((s) => s.code);
  for (const expected of ["quote", "waiting-on-payment", "at-lab", "dispensed", "cancelled", "vsp-ordered"]) {
    assert.ok(codes.includes(expected), `missing status code: ${expected}`);
  }
});

test("opticalOrderStatusConcept binds a status to the local CodeSystem with its display", () => {
  const concept = opticalOrderStatusConcept("at-lab");
  const coding = concept.coding?.[0];
  assert.equal(coding?.system, OSOD_OPTICAL_ORDER_STATUS_SYSTEM);
  assert.equal(coding?.code, "at-lab");
  assert.equal(coding?.display, "At Lab");
});

test("status displays match live Foxfire verbatim (2026-07-03 harvest: lowercase 'for', plain hyphens)", () => {
  const displayByCode = new Map(OPTICAL_ORDER_STATUSES.map((s) => [s.code, s.display]));
  assert.equal(displayByCode.get("waiting-for-pre-auth"), "Waiting for Pre Auth");
  assert.equal(displayByCode.get("notified-left-message"), "Notified - Left Message");
  assert.equal(displayByCode.get("complete-unable-to-notify"), "Complete - Unable to Notify");
});

test("assertOpticalOrderStatus rejects a code outside the 17-value vocabulary", () => {
  assert.throws(() => assertOpticalOrderStatus("shipped"), /optical order status/i);
});
