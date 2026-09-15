import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create } from "react-test-renderer";
import { ProtocolStagingList } from "../src/components/charting/ProtocolStagingList";
import { FollowUpConfirmation } from "../src/components/charting/ProtocolApplicationStatus";

test("staging shows authored titles and hides unavailable items", () => {
  const tree = create(<ProtocolStagingList selections={{}} items={[
    { itemKey: "photo", itemType: "order", title: "Optic nerve photos", defaultSelected: true, lateralityMode: "OU-always", payload: { orderableKey: "fundus-photography" }, offered: true },
    { itemKey: "series-ipl", itemType: "series-prescription", title: "IPL treatment", defaultSelected: true, lateralityMode: "OU-always", payload: {}, offered: false },
  ]} />);
  assert.match(JSON.stringify(tree.toJSON()), /Optic nerve photos/);
  assert.doesNotMatch(JSON.stringify(tree.toJSON()), /IPL treatment|series-ipl/);
  assert.equal(tree.root.findAllByType("input").length, 1);
});

test("follow-up with missing interval and unit can be confirmed before editing", async () => {
  const saves: unknown[] = [];
  const tree = create(<FollowUpConfirmation action={{ id: "follow", payload: { needsConfirmation: true } }} protocolTitles={{}} onSave={async change => { saves.push(change); }} />);
  const confirm = tree.root.findAllByType("button").find(button => button.props.children === "Confirm follow-up")!;
  assert.equal(confirm.props.disabled, false);
  await act(async () => { await confirm.props.onClick(); });
  assert.deepEqual(saves, [{}]);
});
