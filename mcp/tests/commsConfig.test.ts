import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import type { Bundle, Patient, Resource } from "@medplum/fhirtypes";
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

test("communications dispatch resolves configured Google Workspace and Twilio providers", () => {
  const registrations = commsAdapterRegistrationsFromEnv({
    ODOS_COMMS_PROVIDERS: "google-workspace,twilio",
    GOOGLE_WORKSPACE_SERVICE_ACCOUNT_EMAIL: "odos@synthetic.iam.gserviceaccount.com",
    GOOGLE_WORKSPACE_PRIVATE_KEY: "synthetic-private-key",
    GOOGLE_WORKSPACE_DELEGATED_USER: "info@synthetic-practice.example",
    GOOGLE_WORKSPACE_DOMAIN: "synthetic-practice.example",
    GOOGLE_WORKSPACE_FROM_ADDRESS: "info@synthetic-practice.example",
    GOOGLE_WORKSPACE_PLAN_CONFIRMED: "true",
    TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`,
    TWILIO_AUTH_TOKEN: "synthetic-auth-token",
    TWILIO_MESSAGING_SERVICE_SID: `MG${"2".repeat(32)}`,
    TWILIO_VOICE_FROM_NUMBER: "+18645550100",
    TWILIO_VOICE_FORWARD_TO_NUMBER: "+18645550101",
    TWILIO_WEBHOOK_BASE_URL: "https://practice.example",
    TWILIO_VOICE_API_KEY_SID: `SK${"8".repeat(32)}`,
    TWILIO_VOICE_API_KEY_SECRET: "synthetic-voice-api-key-secret",
  });
  const dispatch = createCommsDispatch(registrations, {
    practiceTimeZone: "America/New_York",
    fetchImpl: (async () => Response.json({ sid: `SM${"3".repeat(32)}` })) as typeof fetch,
  });

  assert.deepEqual(dispatch.providers(), ["google-workspace", "twilio"]);
  const adapter = dispatch.getAdapter("twilio", fakeFhir());
  assert.equal(adapter.name, "twilio");
  assert.equal(adapter.capabilities.sms, true);
  assert.equal(adapter.capabilities.calls, true);
  assert.equal(adapter.capabilities.email, false);
  assert.equal(typeof adapter.sendSms, "function");
  assert.equal(typeof adapter.initiateCall, "function");
});

test("Twilio Voice env configuration is all-or-nothing and stays disabled for the existing SMS-only shape", () => {
  const [smsOnly] = commsAdapterRegistrationsFromEnv({
    ODOS_COMMS_PROVIDERS: "twilio",
    TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`,
    TWILIO_AUTH_TOKEN: "synthetic-auth-token",
    TWILIO_MESSAGING_SERVICE_SID: `MG${"2".repeat(32)}`,
    TWILIO_WEBHOOK_BASE_URL: "https://practice.example",
  });
  if (smsOnly.provider !== "twilio") throw new Error("Expected Twilio registration.");
  assert.equal(smsOnly.config.voiceFromNumber, undefined);
  assert.equal(smsOnly.config.webhookBaseUrl, "https://practice.example");

  assert.throws(() => commsAdapterRegistrationsFromEnv({
    ODOS_COMMS_PROVIDERS: "twilio",
    TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`,
    TWILIO_AUTH_TOKEN: "synthetic-auth-token",
    TWILIO_MESSAGING_SERVICE_SID: `MG${"2".repeat(32)}`,
    TWILIO_VOICE_FROM_NUMBER: "+18645550100",
  }), /Voice configuration is partial.*TWILIO_VOICE_FORWARD_TO_NUMBER/i);
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
  assert.throws(
    () => commsAdapterRegistrationsFromEnv({
      ODOS_COMMS_PROVIDERS: "twilio",
      TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`,
    }),
    /missing TWILIO_AUTH_TOKEN/i,
  );
  assert.throws(
    () => commsAdapterRegistrationsFromEnv({
      ODOS_COMMS_PROVIDERS: "twilio",
      TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`,
      TWILIO_AUTH_TOKEN: "synthetic-auth-token",
    }),
    /TWILIO_MESSAGING_SERVICE_SID.*TWILIO_FROM_NUMBER/i,
  );
});

test("communications env config trims Twilio single-line secrets", () => {
  const [registration] = commsAdapterRegistrationsFromEnv({
    ODOS_COMMS_PROVIDERS: "twilio",
    TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`,
    TWILIO_AUTH_TOKEN: " synthetic-auth-token\n",
    TWILIO_API_KEY_SID: `SK${"2".repeat(32)}`,
    TWILIO_API_KEY_SECRET: " synthetic-key-secret\n",
    TWILIO_MESSAGING_SERVICE_SID: `MG${"3".repeat(32)}`,
  });

  assert.equal(registration.provider, "twilio");
  if (registration.provider !== "twilio") throw new Error("Expected Twilio registration.");
  assert.equal(registration.config.authToken, "synthetic-auth-token");
  assert.equal(registration.config.apiKeySecret, "synthetic-key-secret");
});

test("communications dispatch reuses one Google adapter token cache across resolved sends", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let tokenCalls = 0;
  let gmailCalls = 0;
  const dispatch = createCommsDispatch([{
    provider: "google-workspace",
    config: {
      serviceAccountEmail: "odos@synthetic.iam.gserviceaccount.com",
      privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      delegatedUserEmail: "info@synthetic-practice.example",
      workspaceDomain: "synthetic-practice.example",
      fromAddress: "info@synthetic-practice.example",
      workspacePlanConfirmed: true,
    },
  }], {
    practiceTimeZone: "America/New_York",
    now: () => new Date("2026-07-30T14:00:00.000Z"),
    fetchImpl: (async (input) => {
      if (String(input).includes("oauth2.googleapis.com")) {
        tokenCalls += 1;
        return Response.json({ access_token: "synthetic-token", expires_in: 3600 });
      }
      gmailCalls += 1;
      return Response.json({ id: `message-${gmailCalls}` });
    }) as typeof fetch,
  });
  const fhir = {
    ...fakeFhir(),
    read: async <T extends Resource>(): Promise<T> => ({
      resourceType: "Patient",
      id: "synthetic-1",
      telecom: [{ system: "email", value: "patient@example.test" }],
    } satisfies Patient) as T,
  };
  const request = {
    patientReference: "Patient/synthetic-1",
    subject: "Appointment reminder",
    body: "Your appointment is tomorrow at Main Office.",
    campaignType: "appointment-reminder",
    suppression: {},
  };

  const adapter = dispatch.getAdapter("google-workspace", fhir);
  assert.ok(adapter.sendEmail);
  await adapter.sendEmail(request);
  await adapter.sendEmail(request);

  assert.equal(gmailCalls, 2);
  assert.equal(tokenCalls, 1);
});
