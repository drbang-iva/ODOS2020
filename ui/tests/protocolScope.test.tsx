import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create } from "react-test-renderer";
import {
  ProtocolApplicationStatus,
  FollowUpConfirmation,
} from "../src/components/charting/ProtocolApplicationStatus";

test("whole and item applications retain separate badges and undo targets", async () => {
  const undone: string[] = [];
  const tree = create(
    <ProtocolApplicationStatus
      applications={[
        {
          id: "item",
          protocolId: "p",
          confirmed: true,
          undoState: "active",
          scope: "item",
          itemKeys: ["gonioscopy"],
        },
        {
          id: "whole",
          protocolId: "p",
          confirmed: true,
          undoState: "active",
          scope: "whole",
        },
      ]}
      items={[
        {
          itemKey: "gonioscopy",
          itemType: "order",
          payload: { orderableKey: "gonioscopy" },
          defaultSelected: true,
          lateralityMode: "OU-always",
        },
      ]}
      busy={false}
      onUndo={async (id) => {
        undone.push(id);
      }}
    />,
  );
  assert.match(JSON.stringify(tree.toJSON()), /Applied/);
  assert.match(JSON.stringify(tree.toJSON()), /item added/);
  const buttons = tree.root.findAllByType("button");
  await act(async () => {
    buttons.find((b) => b.props.children === "Undo plan")!.props.onClick();
  });
  await act(async () => {
    buttons
      .find((b) => String(b.props.children).includes("Gonioscopy"))!
      .props.onClick();
  });
  assert.deepEqual(undone, ["whole", "item"]);
  tree.update(
    <ProtocolApplicationStatus
      applications={[
        {
          id: "legacy-item",
          protocolId: "p",
          confirmed: true,
          undoState: "active",
          itemClaimLeaseExpiresAt: "past",
        },
      ]}
      items={[]}
      busy={false}
      onUndo={async () => {}}
    />,
  );
  assert.doesNotMatch(JSON.stringify(tree.toJSON()), /Applied|Undo plan/);
});

test("followup recommendations can be confirmed or changed without blocking visit completion", async () => {
  const saves: unknown[] = [];
  const tree = create(
    <FollowUpConfirmation
      action={{
        id: "a",
        payload: {
          interval: 3,
          unit: "months",
          needsConfirmation: true,
          alternatives: [
            {
              protocolId: "p",
              interval: 3,
              unit: "months",
              reason: "Pressure review",
            },
            {
              protocolId: "q",
              interval: 6,
              unit: "months",
              reason: "Monitoring",
            },
          ],
        },
      }}
      protocolTitles={{ p: "Plan P", q: "Plan Q" }}
      onSave={async (change) => {
        saves.push(change);
      }}
    />,
  );
  assert.match(JSON.stringify(tree.toJSON()), /Plan P/);
  assert.match(JSON.stringify(tree.toJSON()), /Plan Q/);
  await act(async () => {
    await tree.root
      .findAllByType("button")
      .find((b) => b.props.children === "Confirm follow-up")!
      .props.onClick();
  });
  assert.deepEqual(saves, [{}]);
  await act(async () => {
    tree.root
      .findByProps({ "aria-label": "Follow-up interval" })
      .props.onChange({ target: { value: "4" } });
  });
  await act(async () => {
    await tree.root
      .findAllByType("button")
      .find((b) => b.props.children === "Save change")!
      .props.onClick();
  });
  assert.deepEqual(saves[1], { interval: 4, unit: "months" });
});

import { AssessmentSection } from "../src/components/charting/AssessmentSection";
import { RoleProvider } from "../src/lib/role-context";
import { fhir } from "../src/lib/fhir";

for (const editing of [false, true]) {
  test(`Assessment route loads persisted followup without matching offers and refreshes after ${editing ? "editing" : "confirmation"}`, async () => {
    const savedFetch = globalThis.fetch,
      savedWindow = globalThis.window,
      read = fhir.read,
      search = fhir.search;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: new EventTarget(),
    });
    let confirmed = false,
      loads = 0;
    const writes: string[] = [];
    fhir.read = (async () => ({
      resourceType: "Encounter",
      id: "e1",
      status: "in-progress",
      class: {},
      subject: { reference: "Patient/p1" },
    })) as typeof fhir.read;
    fhir.search = (async () => ({
      resourceType: "Bundle",
      type: "searchset",
      entry: [],
    })) as typeof fhir.search;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/confirm-follow-up")) {
        writes.push(url);
        assert.equal(
          init?.body,
          editing ? JSON.stringify({ interval: 4, unit: "months" }) : "{}",
        );
        confirmed = true;
        return Response.json({ action: {} });
      }
      if (url.includes("/protocols/applications")) {
        loads++;
        return Response.json({
          applications: [],
          actions: [
            {
              id: "followup",
              payload: {
                interval: 3,
                unit: "months",
                needsConfirmation: !confirmed,
                alternatives: [
                  { protocolId: "Plan A", interval: 3, unit: "months" },
                  { protocolId: "Plan B", interval: 6, unit: "months" },
                ],
              },
            },
          ],
        });
      }
      if (url.includes("/diagnosis-statuses"))
        return Response.json({ statuses: [] });
      if (url.includes("/procedure-charges"))
        return Response.json({
          options: [],
          diagnoses: [],
          proposals: [],
          attachedProcedures: [],
        });
      return Response.json({ diagnoses: [], rows: [] });
    };
    let tree: ReturnType<typeof create> | undefined;
    try {
      await act(async () => {
        tree = create(
          <RoleProvider initialRole="provider">
            <AssessmentSection
              patientReference="Patient/p1"
              encounterReference="Encounter/e1"
              onSaved={() => {}}
            />
          </RoleProvider>,
        );
        await new Promise((r) => setTimeout(r, 0));
      });
      if (editing)
        await act(async () => {
          tree!.root
            .findByProps({ "aria-label": "Follow-up interval" })
            .props.onChange({ target: { value: "4" } });
        });
      const confirm = tree!.root
        .findAllByType("button")
        .find(
          (b) =>
            b.props.children ===
            (editing ? "Save change" : "Confirm follow-up"),
        );
      assert.ok(confirm);
      await act(async () => {
        await confirm.props.onClick();
        await new Promise((r) => setTimeout(r, 0));
      });
      assert.equal(
        writes[0]?.endsWith(
          "/clinical-graph/protocols/encounters/e1/actions/followup/confirm-follow-up",
        ),
        true,
      );
      assert.ok(loads >= 2);
      assert.equal(
        tree!.root
          .findAllByType("button")
          .some((b) => b.props.children === "Confirm follow-up"),
        false,
      );
    } finally {
      await act(async () => tree?.unmount());
      globalThis.fetch = savedFetch;
      fhir.read = read;
      fhir.search = search;
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: savedWindow,
      });
    }
  });
}
