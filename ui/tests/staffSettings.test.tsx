import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { StaffSettings } from "../src/scenes/settings/StaffSettings";
import { SettingsIndex } from "../src/scenes/settings/SettingsIndex";
import type { StaffInvitePayload } from "../src/lib/auth-api";

test("StaffSettings renders all five roles and submits the invite with a named confirmation", async () => {
  const calls: StaffInvitePayload[] = [];
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<StaffSettings invite={async (payload) => {
      calls.push(payload);
      return { ...payload, membershipReference: "ProjectMembership/m1" };
    }} />);
  });
  const root = renderer.root;
  const inputs = root.findAllByType("input");
  assert.equal(root.findAllByType("option").length, 5);
  await act(async () => {
    inputs[0].props.onChange({ target: { value: "Hannah" } });
    inputs[1].props.onChange({ target: { value: "Desk" } });
    inputs[2].props.onChange({ target: { value: "hannah@example.test" } });
    root.findByType("select").props.onChange({ target: { value: "practice-admin" } });
  });
  await act(async () => {
    await root.findByType("form").props.onSubmit({ preventDefault: () => undefined });
  });
  assert.deepEqual(calls, [{
    email: "hannah@example.test",
    firstName: "Hannah",
    lastName: "Desk",
    roleId: "practice-admin",
  }]);
  const status = root.findByProps({ role: "status" });
  assert.match(status.children.join(""), /Hannah Desk/);
  assert.match(status.children.join(""), /Practice admin/);
  act(() => renderer.unmount());
});

test("SettingsIndex exposes Staff only to practice-admin", () => {
  const admin = renderToStaticMarkup(<SettingsIndex roles={["practice-admin"]} />);
  const clinician = renderToStaticMarkup(<SettingsIndex roles={["clinician"]} />);
  assert.match(admin, /href="\/settings\/staff"/);
  assert.doesNotMatch(clinician, /href="\/settings\/staff"/);
});
