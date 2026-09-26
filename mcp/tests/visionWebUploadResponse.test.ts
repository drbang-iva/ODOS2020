import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { parseVisionWebUploadResponse } from "../src/integrations/visionweb/uploadResponse.js";
import { escapeVisionWebXml } from "../src/integrations/visionweb/vwOrderSerializer.js";

test("V8a vendor samples and SOAP string preserve ids, including leading zeroes", () => {
  for (const status of ["Sent", "Review", "Error"]) {
    const raw = readFileSync(new URL(`./fixtures/visionweb/FileUpload_Order_CallResponse${status}.xml`, import.meta.url), "utf8");
    const result = parseVisionWebUploadResponse(raw);
    assert.equal(result.status, status);
    const soap = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><UploadFileResponse xmlns="http://services.visionweb.com"><UploadFileResult>${escapeVisionWebXml(raw)}</UploadFileResult></UploadFileResponse></soap:Body></soap:Envelope>`;
    assert.deepEqual(parseVisionWebUploadResponse(soap), result);
    if (status === "Sent") { assert.equal(result.orderId, "6522"); assert.equal(result.supplierId, "0140"); assert.equal(result.vwebOrderId, "SP1XXUH1"); assert.equal(result.vwebExchangeId, "51102439"); }
    if (status === "Review") { assert.equal(result.orderId,"99999998"); assert.equal(result.supplierId,"9901"); assert.equal(result.vwebOrderId,undefined); assert.match(result.errorList!, /mapping is missing/); }
    if (status === "Error") { assert.equal(result.orderId,"11082021_2"); assert.equal(result.vwebExchangeId,"1798564"); assert.match(result.errorList!, /TRN008/); }
  }
});
test("V8a malformed, missing, multiple and unknown upload results fail closed", () => {
  for (const raw of ["garbage", "<Other/>", "<SingleOrder><OrderId>x</OrderId><SupplierId>9992</SupplierId><Status>Surprise</Status></SingleOrder>", "<SingleOrder><Status>Sent</Status></SingleOrder>"]) {
    assert.throws(() => parseVisionWebUploadResponse(raw), {message:"VisionWeb returned a response ODOS could not read."});
  }
});

test("V8b captured SOAP service error has no invented order identity or acceptance", () => {
  const raw = readFileSync(new URL("./fixtures/visionweb/qa-upload-response.xml", import.meta.url), "utf8");
  assert.match(raw, /REDACTED-VISIONWEB_USERNAME/);
  assert.deepEqual(parseVisionWebUploadResponse(raw), { status: "Error", errorList: "Error occurred - see log for details." });
});
