import assert from "node:assert/strict";
import { test } from "node:test";
import type { Patient, RelatedPerson } from "@medplum/fhirtypes";
import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestInstance } from "react-test-renderer";
import { EngageSheet } from "../src/components/comms/EngageSheet";
import type { EducationDispatchInput } from "../src/lib/communications-client";
import { guarantorReaderFixture } from "../../mcp/tests/helpers/guarantor-reader-fixture";

test("L7: default consent-guardian list and primary selection retain the moved party through an actual transfer", async () => {
  const f = guarantorReaderFixture();
  const originalFetch = globalThis.fetch;
  const dispatches: EducationDispatchInput[] = [];
  const unrelatedBefore = ["Patient/sam", "RelatedPerson/secondary", "RelatedPerson/no-consent", "RelatedPerson/inactive"].map(reference => f.get(reference));
  const beforeChildren = ["r1", "r2"].map(id => f.get<RelatedPerson>(`RelatedPerson/${id}`));
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), "http://guarantor-reader-proof.test");
    if (url.pathname === "/fhir/R4/RelatedPerson") {
      assert.equal(init?.method ?? "GET", "GET");
      return Response.json(await f.fhir.search("RelatedPerson", Object.fromEntries(url.searchParams)));
    }
    if (url.pathname === "/communications/education") return Response.json({
      items: [{ id: "synthetic-guide", version: 1, title: "Synthetic guide", kind: "handout", audience: "patient", dxCodes: [], channels: ["sms"], laneHint: "clinical", consentClass: "transactional", urls: { web: "https://synthetic.invalid/guide" } }],
      chartDispatchLane: "staff_switchable", availableChannels: { clinicalSms: true, frontdeskSms: false, email: false, print: false },
    });
    if (url.pathname === "/communications/opt-out") return Response.json({ patientReference: "Patient/sam", smsOptedOut: false, remainingOptOuts: { global: false, numbers: [] }, smsLanes: [] });
    if (url.pathname === "/communications/preferences") return Response.json({ error: "Synthetic preference service unavailable" }, { status: 503 });
    if (url.pathname === "/communications/education/dispatch") {
      assert.equal(init?.method, "POST");
      dispatches.push(JSON.parse(String(init.body)) as EducationDispatchInput);
      return Response.json({ outcome: "sent", providerMessageId: "synthetic-transport-only" });
    }
    throw new Error(`Unexpected reader request ${url.pathname}`);
  };
  async function selection(expectedName: string): Promise<void> {
    let renderer!: ReactTestRenderer;
    try {
      await act(async () => { renderer = create(<EngageSheet open patient={f.get<Patient>("Patient/sam")} onClose={() => undefined} idempotencyKeyFactory={() => `synthetic-dispatch-${dispatches.length + 1}`} />); });
      const recipientSection = renderer.root.findByProps({ "aria-label": "Education recipients" });
      const labels = recipientSection.findAllByType("label").filter(label => label.findAllByType("input").some(input => input.props.type === "checkbox" || input.props.type === "radio"));
      assert.equal(labels.length, 2, "default API excludes inactive and non-consent candidates");
      const text = (node: ReactTestInstance | string): string => typeof node === "string" ? node : node.children.map(text).join("");
      assert.match(text(labels[0]), new RegExp(expectedName));
      assert.match(text(labels[1]), /secondary/);
      assert.equal(labels[0].findByType("input").props.checked, true);
      assert.equal(labels[1].findByType("input").props.checked, false);
      await act(async () => { renderer.root.findByProps({ "aria-label": "Text Synthetic guide" }).props.onClick(); });
      await act(async () => { await renderer.root.findByProps({ "aria-label": "Confirm education send" }).props.onClick(); });
      assert.equal(dispatches.at(-1)?.recipientOverride?.reference, "RelatedPerson/r1", "the actual selected recipient is the same RelatedPerson, regardless of its changed name");
    } finally { if (renderer) act(() => renderer.unmount()); }
  }
  try {
    await selection("Source");
    await f.transfer();
    await selection("Destination");
    assert.deepEqual(dispatches.map(dispatch => dispatch.recipientOverride?.reference), ["RelatedPerson/r1", "RelatedPerson/r1"]);
    assert.deepEqual(dispatches.map(dispatch => dispatch.channel), ["sms", "sms"]);
    assert.ok(f.reads.filter(read => read.type === "RelatedPerson" && read.params.patient === "Patient/sam").every(read => read.ids.includes("no-consent")), "transport does not perform the consent filter for the production component");
    for (const [index, reference] of ["Patient/sam", "RelatedPerson/secondary", "RelatedPerson/no-consent", "RelatedPerson/inactive"].entries()) assert.deepEqual(f.get(reference), unrelatedBefore[index]);
    for (const [index, id] of ["r1", "r2"].entries()) {
      const after = f.get<RelatedPerson>(`RelatedPerson/${id}`);
      for (const field of ["active", "patient", "period", "relationship"] as const) assert.deepEqual(after[field], beforeChildren[index][field]);
      assert.deepEqual(after.extension, beforeChildren[index].extension?.filter(e => !e.url.endsWith("/odos-no-textable-number")));
    }
  } finally { globalThis.fetch = originalFetch; }
});
