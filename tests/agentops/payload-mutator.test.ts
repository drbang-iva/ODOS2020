import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { stripAttachmentDataForAgent } from "../../mcp/src/agentops/runtime/payload-mutator.js";

test("v0.55d Attachment.data mutator strips base64 bytes before agent delivery", () => {
  const original = Buffer.from("fake-image-bytes");
  const resource = {
    resourceType: "DocumentReference",
    id: "doc-1",
    content: [
      {
        attachment: {
          contentType: "image/png",
          data: original.toString("base64"),
        },
      },
    ],
  };
  const result = stripAttachmentDataForAgent(resource, () => "http://medplum-server:8103/fhir/R4/DocumentReference/doc-1");
  const attachment = result.resource.content[0].attachment;
  assert.equal(result.strippedAttachmentCount, 1);
  assert.equal("data" in attachment, false);
  assert.equal(attachment.hash, createHash("sha1").update(original).digest("base64"));
  assert.equal(attachment.url, "http://medplum-server:8103/fhir/R4/DocumentReference/doc-1");
  assert.equal(
    attachment.extension[0].valueString,
    createHash("sha256").update(original).digest("hex"),
  );
});
