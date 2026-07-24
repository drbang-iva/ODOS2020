import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  WESTFAX_BASE_URL,
  WESTFAX_REQUEST_TIMEOUT_MS,
  createWestFaxAdapter,
  westFaxConfigFromEnv,
} from "../src/fax/westfax-adapter.js";

const CONFIG = {
  baseUrl: WESTFAX_BASE_URL,
  username: "server-only-user",
  password: "server-only-password",
  productId: "product-1",
  callbackBaseUrl: "https://odos.practice.test",
};

test("WestFax adapter sends the documented multipart fields and returns the JobId", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const adapter = createWestFaxAdapter(CONFIG, {
    fetchImpl: (async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ Success: true, Result: "job-900" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch,
  });

  const result = await adapter.sendFax({
    destinationNumbers: ["8645550100", "8645550101"],
    files: [
      { content: Buffer.from("%PDF-synthetic-one"), filename: "referral.pdf" },
      { content: Buffer.from("%PDF-synthetic-two").toString("base64"), filename: "attachment.pdf" },
    ],
    billingCode: "referral-1",
    header: "Integrated Vision Associates",
    feedbackEmail: "fax-status@example.test",
    faxQuality: "Fine",
    callbackUrl: "https://odos.practice.test/fax/callback/fax-1",
  });

  assert.deepEqual(result, { success: true, jobId: "job-900" });
  assert.equal(calls[0]?.url, `${WESTFAX_BASE_URL}/REST/Fax_SendFax/json`);
  const form = calls[0]?.init.body as FormData;
  assert.equal(form.get("Username"), "server-only-user");
  assert.equal(form.get("Password"), "server-only-password");
  assert.equal(form.get("Cookies"), "false");
  assert.equal(form.get("ProductId"), "product-1");
  assert.equal(form.get("Numbers1"), "8645550100");
  assert.equal(form.get("Numbers2"), "8645550101");
  assert.equal((form.get("Files0") as File).name, "referral.pdf");
  assert.equal((form.get("Files1") as File).name, "attachment.pdf");
  assert.equal(form.get("BillingCode"), "referral-1");
  assert.equal(form.get("Header"), "Integrated Vision Associates");
  assert.equal(form.get("FaxQuality"), "Fine");
  assert.equal(form.get("FeedbackEmail"), "fax-status@example.test");
  assert.equal(form.get("CallbackUrl"), "https://odos.practice.test/fax/callback/fax-1");
});

test("WestFax adapter surfaces ErrorString and InfoString on failure", async () => {
  const adapter = createWestFaxAdapter(CONFIG, {
    fetchImpl: (async () => new Response(JSON.stringify({
      Success: false,
      ErrorString: "Bad fax number",
      InfoString: "Check Numbers1",
    }), { status: 200 })) as typeof fetch,
  });

  assert.deepEqual(await adapter.sendFax({
    destinationNumbers: ["8645550199"],
    files: [{ content: Buffer.from("%PDF-synthetic"), filename: "referral.pdf" }],
  }), {
    success: false,
    errorString: "Bad fax number",
    infoString: "Check Numbers1",
  });
});

test("WestFax adapter aborts a stalled request at 30 seconds with a clear error", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let requestSignal: AbortSignal | null | undefined;
  const adapter = createWestFaxAdapter(CONFIG, {
    fetchImpl: (async (_url, init) => {
      requestSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener(
          "abort",
          () => reject(new DOMException("This operation was aborted", "AbortError")),
          { once: true },
        );
      });
    }) as typeof fetch,
  });

  const request = adapter.sendFax({
    destinationNumbers: ["8645550199"],
    files: [{ content: Buffer.from("%PDF-synthetic"), filename: "referral.pdf" }],
  });
  assert.equal(requestSignal?.aborted, false);

  t.mock.timers.tick(WESTFAX_REQUEST_TIMEOUT_MS);

  await assert.rejects(request, /WestFax request timed out after 30 seconds/);
  assert.equal(requestSignal?.aborted, true);
});

test("WestFax config is all-or-nothing, HTTPS-only, and never appears in client code", () => {
  assert.equal(westFaxConfigFromEnv({}), null);
  assert.throws(
    () => westFaxConfigFromEnv({ WESTFAX_USERNAME: "user" }),
    /WESTFAX_PASSWORD/,
  );
  assert.throws(
    () => westFaxConfigFromEnv({
      WESTFAX_USERNAME: "user",
      WESTFAX_PASSWORD: "password",
      WESTFAX_PRODUCT_ID: "product",
      WESTFAX_CALLBACK_BASE_URL: "http://odos.local",
    }),
    /must use HTTPS/,
  );

  const clientSource = [
    "../../ui/src/components/referral/referral-api.ts",
    "../../ui/src/components/referral/ReferralCompose.tsx",
    "../../ui/src/components/referral/referral-pdf.ts",
  ].map((path) => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n");
  assert.doesNotMatch(clientSource, /WESTFAX_USERNAME|WESTFAX_PASSWORD|Fax_SendFax|api2\.westfax\.com/);
});
