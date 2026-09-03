import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { WESTFAX_DESCRIPTION } from "./fixtures/westfax.js";

const env = {
  WESTFAX_USERNAME: "synthetic-user",
  WESTFAX_PASSWORD: "synthetic-password",
  WESTFAX_PRODUCT_ID: "synthetic-product",
  WESTFAX_INBOUND_LOOKBACK_DAYS: "7",
};

test("operator verification reads descriptions once with multipart StartDate and the production parser", async (t) => {
  const { verifyWestFaxLive } = await import("../scripts/verify-westfax-live.mjs");
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-03T12:00:00Z") });
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const records = await verifyWestFaxLive(env, async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ Success: true, Result: [{ ...WESTFAX_DESCRIPTION, Reference: "unexpected" }] }));
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://api2.westfax.com/REST/Fax_GetFaxDescriptions/json");
  assert.equal(calls[0]?.init.method, "POST");
  const form = calls[0]!.init.body as FormData;
  assert.ok(form instanceof FormData);
  assert.equal(form.get("StartDate"), "2026-08-27T12:00:00.000Z");
  assert.equal(form.get("FaxDirection"), "Inbound");
  assert.equal(form.get("Filter"), null);
  assert.equal(form.get("Username"), env.WESTFAX_USERNAME);
  assert.equal(form.get("Password"), env.WESTFAX_PASSWORD);
  assert.equal(form.get("ProductId"), env.WESTFAX_PRODUCT_ID);
  assert.equal(form.get("Cookies"), "false");
  assert.deepEqual(records, [{ id: "fax-1", direction: "Inbound", date: "2026-09-02T14:00:00Z", tag: "None", pageCount: 2, senderNumber: "0123456789", senderIdentifier: "Synthetic Referral Practice" }]);
});

test("operator verification never exposes vendor or transport error payloads", async () => {
  const { verifyWestFaxLive } = await import("../scripts/verify-westfax-live.mjs");
  for (const fetchImpl of [
    async () => new Response(JSON.stringify({ Success: false, ErrorString: JSON.stringify(env) })),
    async () => { throw new Error(JSON.stringify(env)); },
  ]) {
    await assert.rejects(verifyWestFaxLive(env, fetchImpl), (error: Error) => {
      assert.equal(error.message, "WestFax verification failed; check configuration and connectivity locally. Provider details were suppressed.");
      return true;
    });
  }
});

test("operator verification CLI fails closed without env credentials", () => {
  const result = spawnSync(process.execPath, ["scripts/verify-westfax-live.mjs"], {
    cwd: new URL("../", import.meta.url),
    env: { PATH: process.env.PATH }, encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /WESTFAX_USERNAME, WESTFAX_PASSWORD, and WESTFAX_PRODUCT_ID must be set in the environment/);
});
