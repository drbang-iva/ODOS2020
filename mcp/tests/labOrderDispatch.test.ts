import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, Resource } from "@medplum/fhirtypes";
import {
  createLabOrderDispatch,
  isLabOrderVendorId,
  labOrderRoutingFromEnv,
  selectLabOrderAdapter,
} from "../src/lab-orders/lab-order-dispatch.js";

function fakeFhir() {
  return {
    read: async <T extends Resource>(): Promise<T> => ({}) as T,
    search: async <T extends Resource>(): Promise<Bundle<T>> => ({ resourceType: "Bundle", type: "searchset" }),
    update: async <T extends Resource>(_rt: T["resourceType"], _id: string, resource: T): Promise<T> => resource,
    create: async <T extends Resource>(resource: T): Promise<T> => resource,
  };
}

test("lab-order dispatch resolves and lists the registered manual adapter", () => {
  const dispatch = createLabOrderDispatch([{ vendor: "manual" }]);
  assert.deepEqual(dispatch.vendors(), ["manual"]);
  const adapter = dispatch.getAdapter("manual", fakeFhir());
  assert.equal(adapter.vendorId, "manual");
  assert.equal(adapter.name, "manual-lab-order");
});

test("lab-order selection and environment routing default to manual", () => {
  const manual = createLabOrderDispatch([{ vendor: "manual" }]).getAdapter("manual", fakeFhir());
  assert.equal(selectLabOrderAdapter({ manual }, undefined), manual);
  assert.deepEqual(labOrderRoutingFromEnv({}), { vendor: "manual" });
  assert.deepEqual(labOrderRoutingFromEnv({ OSOD_LAB_ORDER_VENDOR_DEFAULT: "manual" }), { vendor: "manual" });
});

test("unknown or unconfigured lab-order vendors fail closed with explicit messages", () => {
  const dispatch = createLabOrderDispatch([]);
  assert.throws(() => dispatch.getAdapter("manual", fakeFhir()), /manual.*not configured|not configured.*manual/i);
  assert.throws(() => selectLabOrderAdapter({}, undefined), /manual.*not configured|not configured.*manual/i);
  assert.throws(
    () => labOrderRoutingFromEnv({ OSOD_LAB_ORDER_VENDOR_DEFAULT: "visionweb" }),
    /manual/,
  );
});

test("isLabOrderVendorId recognizes only shipped vendors", () => {
  assert.equal(isLabOrderVendorId("manual"), true);
  assert.equal(isLabOrderVendorId("visionweb"), false);
  assert.equal(isLabOrderVendorId(undefined), false);
});
