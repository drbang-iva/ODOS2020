import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OPTICAL_ORDER_STATUSES as MCP_STATUSES,
  ODOS_OPTICAL_ORDER_STATUS_SYSTEM as MCP_STATUS_SYSTEM,
} from "../src/fhir/opticalOrderStatus.js";
import {
  OPTICAL_ORDER_TYPES as MCP_TYPES,
  ODOS_OPTICAL_ORDER_TYPE_SYSTEM as MCP_TYPE_SYSTEM,
} from "../src/fhir/opticalOrderType.js";
import {
  PAYMENT_TENDERS as MCP_TENDERS,
  ODOS_PAYMENT_TENDER_EXTENSION_URL as MCP_TENDER_EXTENSION_URL,
  ODOS_PAYMENT_TENDER_SYSTEM as MCP_TENDER_SYSTEM,
} from "../src/fhir/odosPaymentTender.js";
import {
  OPTICAL_ADJUSTMENTS as MCP_ADJUSTMENTS,
  ODOS_OPTICAL_ADJUSTMENT_SYSTEM as MCP_ADJUSTMENT_SYSTEM,
} from "../src/fhir/odosOpticalAdjustment.js";
import { HCPCS_SYSTEM as MCP_HCPCS_SYSTEM } from "../src/catalog/frame-types.js";
import {
  OPTICAL_ORDER_STATUSES as UI_STATUSES,
  OPTICAL_ORDER_TYPES as UI_TYPES,
  PAYMENT_TENDERS as UI_TENDERS,
  OPTICAL_ADJUSTMENTS as UI_ADJUSTMENTS,
  ODOS_OPTICAL_ORDER_STATUS_SYSTEM as UI_STATUS_SYSTEM,
  ODOS_OPTICAL_ORDER_TYPE_SYSTEM as UI_TYPE_SYSTEM,
  ODOS_PAYMENT_TENDER_EXTENSION_URL as UI_TENDER_EXTENSION_URL,
  ODOS_PAYMENT_TENDER_SYSTEM as UI_TENDER_SYSTEM,
  ODOS_OPTICAL_ADJUSTMENT_SYSTEM as UI_ADJUSTMENT_SYSTEM,
  HCPCS_SYSTEM as UI_HCPCS_SYSTEM,
} from "../../ui/src/lib/optical-order.js";

// The UI re-declares the optical vocabularies (separate package — cannot import mcp/src). Per the
// repo's MCP↔UI mirror convention (builder-mirror-parity.test.ts), this guard makes any drift
// between the two copies a test failure instead of a silent UI/service divergence.

function codeDisplayPairs(entries: readonly { code: string; display: string }[]) {
  return entries.map(({ code, display }) => ({ code, display }));
}

test("UI optical-order vocabularies mirror the MCP builders verbatim (statuses, types, tenders, adjustments)", () => {
  assert.deepEqual(codeDisplayPairs(UI_STATUSES), codeDisplayPairs(MCP_STATUSES));
  assert.deepEqual(codeDisplayPairs(UI_TYPES), codeDisplayPairs(MCP_TYPES));
  assert.deepEqual(codeDisplayPairs(UI_TENDERS), codeDisplayPairs(MCP_TENDERS));
  assert.deepEqual(codeDisplayPairs(UI_ADJUSTMENTS), codeDisplayPairs(MCP_ADJUSTMENTS));
});

test("UI optical-order system URIs mirror the MCP builders verbatim", () => {
  assert.equal(UI_STATUS_SYSTEM, MCP_STATUS_SYSTEM);
  assert.equal(UI_TYPE_SYSTEM, MCP_TYPE_SYSTEM);
  assert.equal(UI_TENDER_EXTENSION_URL, MCP_TENDER_EXTENSION_URL);
  assert.equal(UI_TENDER_SYSTEM, MCP_TENDER_SYSTEM);
  assert.equal(UI_ADJUSTMENT_SYSTEM, MCP_ADJUSTMENT_SYSTEM);
  assert.equal(UI_HCPCS_SYSTEM, MCP_HCPCS_SYSTEM);
});
