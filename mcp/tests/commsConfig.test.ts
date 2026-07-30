import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, Resource } from "@medplum/fhirtypes";
import {
  commsAdapterRegistrationsFromEnv,
  createCommsDispatch,
} from "../src/comms/comms-config.js";

function fakeFhir() {
  return {
    read: async <T extends Resource>(): Promise<T> => ({}) as T,
    search: async <T extends Resource>(): Promise<Bundle<T>> => ({
      resourceType: "Bundle",
      type: "searchset",
    }),
  };
}

test("communications dispatch is inert without practice config and reports a clear resolution error", () => {
  const dispatch = createCommsDispatch([]);
  assert.deepEqual(dispatch.providers(), []);
  assert.throws(
    () => dispatch.getAdapter("google-workspace", fakeFhir()),
    /not configured for this practice/i,
  );
  assert.deepEqual(commsAdapterRegistrationsFromEnv({}), []);
});

test("communications dispatch resolves the configured Google Workspace provider behind the suppression gate", () => {
  const registrations = commsAdapterRegistrationsFromEnv({
    ODOS_COMMS_PROVIDERS: "google-workspace",
    GOOGLE_WORKSPACE_SERVICE_ACCOUNT_EMAIL: "odos@synthetic.iam.gserviceaccount.com",
    GOOGLE_WORKSPACE_PRIVATE_KEY: "synthetic-private-key",
    GOOGLE_WORKSPACE_DELEGATED_USER: "info@synthetic-practice.example",
    GOOGLE_WORKSPACE_DOMAIN: "synthetic-practice.example",
    GOOGLE_WORKSPACE_FROM_ADDRESS: "info@synthetic-practice.example",
    GOOGLE_WORKSPACE_PLAN_CONFIRMED: "true",
  });
  const dispatch = createCommsDispatch(registrations, {
    practiceTimeZone: "America/New_York",
  });

  assert.deepEqual(dispatch.providers(), ["google-workspace"]);
  const adapter = dispatch.getAdapter("google-workspace", fakeFhir());
  assert.equal(adapter.name, "google-workspace");
  assert.equal(adapter.capabilities.email, true);
  assert.equal(adapter.capabilities.sms, false);
});

test("communications env config fails closed when selected provider credentials are partial", () => {
  assert.throws(
    () => commsAdapterRegistrationsFromEnv({
      ODOS_COMMS_PROVIDERS: "google-workspace",
      GOOGLE_WORKSPACE_SERVICE_ACCOUNT_EMAIL: "odos@synthetic.iam.gserviceaccount.com",
    }),
    /partially configured|missing GOOGLE_WORKSPACE_PRIVATE_KEY/i,
  );
  assert.throws(
    () => commsAdapterRegistrationsFromEnv({ ODOS_COMMS_PROVIDERS: "unknown" }),
    /unsupported communications provider/i,
  );
});
