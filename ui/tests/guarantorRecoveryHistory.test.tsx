import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create } from "react-test-renderer";
import { GuarantorLinkScreens } from "../src/components/patient/GuarantorLinkScreens";

for (const correctionInProgress of [true, false]) test(`R6 UI: history ${correctionInProgress ? "hides" : "offers"} Undo when correctionInProgress is ${correctionInProgress}`, async () => {
  const originalFetch = globalThis.fetch;
  let tree: ReturnType<typeof create> | undefined;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "/guarantors/link-operations?relatedPersonId=r1");
    assert.equal(init?.method, "GET");
    return Response.json([{ kind: "transfer", correctionInProgress, task: { id: "original", status: "completed" }, patients: [{ name: "Synthetic child" }] }]);
  };
  try {
    await act(async () => { tree = create(<GuarantorLinkScreens person={{ resourceType: "Person", id: "D", name: [{ family: "Destination" }] }} relatedPersonId="r1" disabled={false} onReload={async () => {}} />); });
    const history = tree!.root.findAllByType("button").find(button => button.children.join("") === "Guarantor changes")!;
    await act(async () => { await history.props.onClick(); });
    assert.ok(JSON.stringify(tree!.toJSON()).includes("Synthetic child"));
    const undo = tree!.root.findAllByType("button").filter(button => button.children.join("") === "Undo");
    const reasons = tree!.root.findAllByType("label").filter(label => label.children[0] === "Reason to undo original");
    assert.equal(undo.length, correctionInProgress ? 0 : 1);
    assert.equal(reasons.length, correctionInProgress ? 0 : 1);
  } finally {
    await act(async () => { tree?.unmount(); });
    globalThis.fetch = originalFetch;
  }
});
