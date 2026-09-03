import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  WESTFAX_BASE_URL,
  WESTFAX_REQUEST_TIMEOUT_MS,
  createWestFaxAdapter,
  westFaxConfigFromEnv,
} from "../src/fax/westfax-adapter.js";
import { WESTFAX_DESCRIPTION } from "./fixtures/westfax.js";

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

test("WestFax adapter performs each documented inbound call with the required multipart fields", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-03T12:00:00Z") });
  const calls: Array<{ url: string; form: FormData }> = [];
  const responses: unknown[] = [
    { Success: true, Result: [{ Id: "product-inbound", InboundNumber: "8645550100" }] },
    { Success: true, Result: [{ Id: "fax-1", Direction: "Inbound", Date: "2026-07-31T14:00:00Z", Tag: "None" }] },
    {
      Success: true,
      Result: [WESTFAX_DESCRIPTION],
    },
    {
      Success: true,
      Result: [{
        Id: "fax-1",
        Direction: "Inbound",
        Date: "2026-07-31T14:00:00Z",
        PageCount: 2,
        FaxFiles: [{
          ContentType: "application/pdf",
          FileContents: Buffer.from("%PDF-synthetic-inbound").toString("base64"),
        }],
      }],
    },
    { Success: true, Result: true },
  ];
  const adapter = createWestFaxAdapter(CONFIG, {
    fetchImpl: (async (url, init) => {
      calls.push({ url: String(url), form: init?.body as FormData });
      return new Response(JSON.stringify(responses.shift()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch,
  });

  const products = await adapter.getProductsWithInboundFaxes("None");
  const ids = await adapter.getFaxIdentifiers(products[0]!.id, "Inbound");
  const descriptions = await adapter.getFaxDescriptions(products[0]!.id, ids);
  const documents = await adapter.getFaxDocuments(products[0]!.id, ids, "pdf");
  await adapter.changeFaxFilterValue(products[0]!.id, ids, "Retrieved");

  assert.deepEqual(calls.map((call) => call.url), [
    `${WESTFAX_BASE_URL}/REST/Fax_GetProductsWithInboundFaxes/json`,
    `${WESTFAX_BASE_URL}/REST/Fax_GetFaxIdentifiers/json`,
    `${WESTFAX_BASE_URL}/REST/Fax_GetFaxDescriptionsUsingIds/json`,
    `${WESTFAX_BASE_URL}/REST/Fax_GetFaxDocuments/json`,
    `${WESTFAX_BASE_URL}/REST/Fax_ChangeFaxFilterValue/json`,
  ]);
  assert.equal(calls[0]!.form.get("Filter"), "None");
  assert.equal(calls[0]!.form.get("ProductId"), null);
  assert.equal(calls[1]!.form.get("ProductId"), "product-inbound");
  assert.equal(calls[1]!.form.get("FaxDirection"), "Inbound");
  for (const call of [calls[1]!, calls[2]!]) {
    assert.ok(call.form instanceof FormData);
    assert.equal(call.form.get("StartDate"), "2026-08-04T12:00:00.000Z");
    assert.equal(call.form.get("FaxDirection"), "Inbound");
  }
  const faxIdParameter = JSON.stringify({ Id: "fax-1", Direction: "Inbound" });
  assert.equal(calls[2]!.form.get("FaxIds1"), faxIdParameter);
  assert.equal(calls[3]!.form.get("FaxIds1"), faxIdParameter);
  assert.equal(calls[3]!.form.get("Format"), "pdf");
  assert.equal(calls[4]!.form.get("FaxIds1"), faxIdParameter);
  assert.equal(calls[4]!.form.get("Filter"), "Retrieved");
  assert.equal(products[0]?.inboundNumber, "8645550100");
  assert.equal(descriptions[0]?.senderNumber, "0123456789");
  assert.equal(documents[0]?.pageCount, 2);
  assert.match(documents[0]?.fileContents ?? "", /^JVBER/);
});

test("WestFax descriptions capture OrigCSID independently of the sender number", async () => {
  const adapter = createWestFaxAdapter(CONFIG, {
    fetchImpl: (async () => new Response(JSON.stringify({
      Success: true,
      Result: [WESTFAX_DESCRIPTION, {
        ...WESTFAX_DESCRIPTION,
        Id: "fax-csid-only",
        FaxCallInfoList: [{ ...WESTFAX_DESCRIPTION.FaxCallInfoList[0], OrigNumber: "", OrigCSID: "  Synthetic Person  " }],
      }],
    }))) as typeof fetch,
  });
  const records = await adapter.getFaxDescriptions("product-1", [{ id: "fax-1", direction: "Inbound" }]);
  assert.equal(records[0]?.senderIdentifier, "Synthetic Referral Practice");
  assert.equal(records[1]?.senderIdentifier, "Synthetic Person");
  assert.equal(records[1]?.senderNumber, undefined);
});

test("WestFax descriptions ignore an unexpected Reference field", async () => {
  const adapter = createWestFaxAdapter(CONFIG, {
    fetchImpl: (async () => new Response(JSON.stringify({
      Success: true,
      Result: [{ ...WESTFAX_DESCRIPTION, Reference: "must never be parsed" }],
    }))) as typeof fetch,
  });
  const [record] = await adapter.getFaxDescriptions("product-1", [{ id: "fax-1", direction: "Inbound" }]);
  assert.ok(record);
  assert.equal(Object.hasOwn(record, "reference"), false);
  assert.equal(Object.hasOwn(record, "Reference"), false);
});

test("WestFax lookback configuration bounds every inbound request and advances with the clock", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-03T12:00:00Z") });
  const config = westFaxConfigFromEnv({
    WESTFAX_USERNAME: "synthetic", WESTFAX_PASSWORD: "synthetic",
    WESTFAX_PRODUCT_ID: "product-1", WESTFAX_CALLBACK_BASE_URL: CONFIG.callbackBaseUrl,
    WESTFAX_INBOUND_LOOKBACK_DAYS: "7",
  })!;
  const dates: unknown[] = [];
  const adapter = createWestFaxAdapter(config, {
    fetchImpl: (async (_url, init) => {
      dates.push((init?.body as FormData).get("StartDate"));
      return new Response(JSON.stringify({ Success: true, Result: [] }));
    }) as typeof fetch,
  });
  await adapter.getFaxIdentifiers("product-1", "Inbound");
  t.mock.timers.tick(86_400_000);
  await adapter.getFaxDescriptions("product-1", Array.from({ length: 26 }, (_, index) => ({ id: `fax-${index}`, direction: "Inbound" })));
  assert.deepEqual(dates, ["2026-08-27T12:00:00.000Z", "2026-08-28T12:00:00.000Z", "2026-08-28T12:00:00.000Z"]);
  for (const invalid of ["0", "-1", "1.5", "Infinity", "NaN", "366", "9999999999999999999999"]) {
    assert.throws(() => westFaxConfigFromEnv({
      WESTFAX_USERNAME: "synthetic", WESTFAX_PASSWORD: "synthetic",
      WESTFAX_PRODUCT_ID: "product-1", WESTFAX_CALLBACK_BASE_URL: CONFIG.callbackBaseUrl,
      WESTFAX_INBOUND_LOOKBACK_DAYS: invalid,
    }), /WESTFAX_INBOUND_LOOKBACK_DAYS/);
  }
});

test("WestFax adapter rejects multi-file fax documents instead of dropping later files", async () => {
  const adapter = createWestFaxAdapter(CONFIG, {
    fetchImpl: (async () => new Response(JSON.stringify({
      Success: true,
      Result: [{
        Id: "fax-1",
        Direction: "Inbound",
        FaxFiles: [
          { ContentType: "application/pdf", FileContents: Buffer.from("%PDF-one").toString("base64") },
          { ContentType: "application/pdf", FileContents: Buffer.from("%PDF-two").toString("base64") },
        ],
      }],
    }), { status: 200 })) as typeof fetch,
  });

  await assert.rejects(
    adapter.getFaxDocuments("product-1", [{ id: "fax-1", direction: "Inbound" }], "pdf"),
    /exactly one PDF file.*2/i,
  );
});

test("WestFax description and document retrieval batches identifiers in stable order", async () => {
  const calls: Array<{ method: string; ids: string[] }> = [];
  const adapter = createWestFaxAdapter(CONFIG, {
    fetchImpl: (async (url, init) => {
      const form = init?.body as FormData;
      const ids = [...form.entries()]
        .filter(([key]) => key.startsWith("FaxIds"))
        .map(([, value]) => JSON.parse(String(value)).Id as string);
      const method = String(url).match(/REST\/(.+)\/json/)?.[1] ?? "";
      calls.push({ method, ids });
      return new Response(JSON.stringify({
        Success: true,
        Result: ids.map((id) => method === "Fax_GetFaxDocuments"
          ? {
              Id: id,
              Direction: "Inbound",
              FaxFiles: [{ ContentType: "application/pdf", FileContents: Buffer.from(`%PDF-${id}`).toString("base64") }],
            }
          : { Id: id, Direction: "Inbound", FaxCallInfoList: [] }),
      }), { status: 200 });
    }) as typeof fetch,
  });
  const ids = Array.from({ length: 26 }, (_, index) => ({
    id: `fax-${String(index + 1).padStart(2, "0")}`,
    direction: "Inbound" as const,
  }));

  const descriptions = await adapter.getFaxDescriptions("product-1", ids);
  const documents = await adapter.getFaxDocuments("product-1", ids, "pdf");

  assert.deepEqual(calls.map((call) => [call.method, call.ids.length]), [
    ["Fax_GetFaxDescriptionsUsingIds", 25],
    ["Fax_GetFaxDescriptionsUsingIds", 1],
    ["Fax_GetFaxDocuments", 25],
    ["Fax_GetFaxDocuments", 1],
  ]);
  assert.deepEqual(descriptions.map((fax) => fax.id), ids.map((fax) => fax.id));
  assert.deepEqual(documents.map((fax) => fax.id), ids.map((fax) => fax.id));
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
  ].map((path) => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n");
  assert.doesNotMatch(clientSource, /WESTFAX_USERNAME|WESTFAX_PASSWORD|Fax_SendFax|api2\.westfax\.com/);
});
