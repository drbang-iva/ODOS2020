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

test("followup recommendations can be explicitly confirmed or edited", async () => {
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

test("dirty followup requires saving the displayed change", async () => {
  const tree = create(
    <FollowUpConfirmation
      action={{
        id: "a",
        payload: { interval: 3, unit: "months", needsConfirmation: true },
      }}
      protocolTitles={{}}
      onSave={async () => {}}
    />,
  );
  await act(async () =>
    tree.root
      .findByProps({ "aria-label": "Follow-up interval" })
      .props.onChange({ target: { value: "4" } }),
  );
  assert.equal(
    tree.root
      .findAllByType("button")
      .find((b) => b.props.children === "Confirm follow-up")!.props.disabled,
    true,
  );
});

test("Assessment preserves unmatched plan item undo alongside a current offer", async () => {
  const savedFetch = globalThis.fetch,
    savedWindow = globalThis.window,
    read = fhir.read,
    search = fhir.search;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: new EventTarget(),
  });
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
    entry: [
      {
        resource: {
          resourceType: "Condition",
          id: "c1",
          subject: { reference: "Patient/p1" },
          encounter: { reference: "Encounter/e1" },
          category: [
            {
              coding: [
                {
                  system:
                    "http://terminology.hl7.org/CodeSystem/condition-category",
                  code: "encounter-diagnosis",
                },
              ],
            },
          ],
          verificationStatus: {
            coding: [
              {
                system:
                  "http://terminology.hl7.org/CodeSystem/condition-ver-status",
                code: "confirmed",
              },
            ],
          },
          code: { coding: [{ code: "synthetic-diagnosis" }] },
        },
      },
    ],
  })) as typeof fhir.search;
  const writes: string[] = [];
  let undone = false;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/unapply")) {
      writes.push(url);
      undone = true;
      return Response.json({ removed: [] });
    }
    if (url.includes("/protocols/applications"))
      return Response.json({
        applications: [
          {
            id: "app-A",
            protocolId: "Plan-A",
            scope: "item",
            confirmed: true,
            undoState: undone ? "unapplied" : "active",
            itemKeys: ["synthetic-item"],
          },
        ],
      });
    if (url.endsWith("/protocols/offers"))
      return Response.json({
        protocols: [
          {
            id: "Plan-B",
            title: "Plan B",
            version: 1,
            trigger: { kind: "diagnosis", dxKeys: ["synthetic-diagnosis"] },
            statusScope: [],
            items: [],
          },
        ],
      });
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
    assert.match(JSON.stringify(tree!.toJSON()), /Plan B/);
    const undo = tree!.root
      .findAllByType("button")
      .find((b) => String(b.props.children).includes("synthetic item"));
    assert.ok(undo, "unmatched application retains its own Undo");
    await act(async () => {
      await undo.props.onClick();
      await new Promise((r) => setTimeout(r, 0));
    });
    assert.ok(writes[0]?.endsWith("/clinical-graph/protocols/app-A/unapply"));
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

test("followup fields stay fixed while saving", async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const tree = create(
    <FollowUpConfirmation
      action={{
        id: "a",
        payload: { interval: 3, unit: "months", needsConfirmation: true },
      }}
      protocolTitles={{}}
      onSave={() => pending}
    />,
  );
  let save!: Promise<void>;
  await act(async () => {
    save = tree.root
      .findAllByType("button")
      .find((b) => b.props.children === "Confirm follow-up")!
      .props.onClick();
  });
  assert.equal(
    tree.root.findByProps({ "aria-label": "Follow-up interval" }).props
      .disabled,
    true,
  );
  assert.equal(
    tree.root.findByProps({ "aria-label": "Follow-up unit" }).props.disabled,
    true,
  );
  await act(async () => {
    finish();
    await save;
  });
  tree.unmount();
});
