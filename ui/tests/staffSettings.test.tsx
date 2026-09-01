import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { StaffSettings } from "../src/scenes/settings/StaffSettings";
import { SettingsIndex } from "../src/scenes/settings/SettingsIndex";
import type {
  StaffInvitePayload,
  StaffPermissionMember,
  StaffPermissionsResponse,
} from "../src/lib/auth-api";

const permissionFixture: StaffPermissionsResponse = {
  actions: [
    { action: "chart.read", class: "baseline", reason: "Required for every active staff account." },
    { action: "protocols.author", class: "credential-bound", reason: "Professional-role capability." },
    { action: "payment.void", class: "grantable" },
    { action: "payment.seal-day", class: "grantable" },
    { action: "identity.manage", class: "owner-only", reason: "Only the practice owner can hold this action." },
  ],
  members: [
    permissionMember({ membershipReference: "ProjectMembership/staff", display: "Hannah Desk" }),
    permissionMember({
      membershipReference: "ProjectMembership/provider",
      display: "Drew Doctor",
      roles: ["provider"],
      roleActions: ["chart.read", "protocols.author"],
      effective: ["chart.read", "protocols.author"],
    }),
    permissionMember({
      membershipReference: "ProjectMembership/owner",
      display: "Olivia Owner",
      roles: ["admin"],
      roleActions: ["chart.read", "identity.manage"],
      effective: ["chart.read", "identity.manage"],
      owner: true,
      toggleImmune: true,
    }),
  ],
};

test("StaffSettings renders the three canonical roles and submits the invite with a named confirmation", async () => {
  const calls: StaffInvitePayload[] = [];
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<StaffSettings invite={async (payload) => {
      calls.push(payload);
      return { ...payload, membershipReference: "ProjectMembership/m1" };
    }} loadPermissions={async () => ({ actions: [], members: [] })} />);
  });
  const root = renderer.root;
  const inputs = root.findAllByType("input");
  assert.equal(root.findAllByType("option").length, 3);
  await act(async () => {
    inputs[0].props.onChange({ target: { value: "Hannah" } });
    inputs[1].props.onChange({ target: { value: "Desk" } });
    inputs[2].props.onChange({ target: { value: "hannah@example.test" } });
    root.findByProps({ "aria-label": "Invite role" }).props.onChange({ target: { value: "admin" } });
  });
  await act(async () => {
    await root.findByType("form").props.onSubmit({ preventDefault: () => undefined });
  });
  assert.deepEqual(calls, [{
    email: "hannah@example.test",
    firstName: "Hannah",
    lastName: "Desk",
    roleId: "admin",
  }]);
  const status = root.findByProps({ role: "status" });
  assert.match(status.children.join(""), /Hannah Desk/);
  assert.match(status.children.join(""), /Admin \/ Manager/);
  act(() => renderer.unmount());
});

test("StaffSettings renders grouped person-level actions with locked reasons and saves grant/revoke deltas", async () => {
  const saved: Array<{ membershipId: string; granted: string[]; revoked: string[] }> = [];
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<StaffSettings
      invite={async (payload) => payload}
      loadPermissions={async () => permissionFixture}
      savePermissions={async (membershipId, granted, revoked) => {
        saved.push({ membershipId, granted, revoked });
        return permissionFixture.members[0]!;
      }}
    />);
  });
  const root = renderer.root;
  assert.equal(root.findByProps({ "aria-label": "Staff member" }).findAllByType("option")[0]!.children.join(""), "Hannah Desk");
  assert.equal(root.findByProps({ "aria-label": "chart.read for Hannah Desk" }).props.disabled, true);
  assert.equal(root.findByProps({ "aria-label": "protocols.author for Hannah Desk" }).props.disabled, true);
  assert.equal(root.findByProps({ "aria-label": "identity.manage for Hannah Desk" }).props.disabled, true);
  assert.ok(root.findAllByType("span").some((node) => node.children.join("").includes("Professional-role capability")));

  await act(async () => {
    root.findByProps({ "aria-label": "payment.void for Hannah Desk" }).props.onChange({ target: { checked: true } });
  });
  await act(async () => {
    await root.findByProps({ "aria-label": "Save permission changes" }).props.onClick();
  });
  assert.deepEqual(saved, [{ membershipId: "staff", granted: ["payment.void"], revoked: [] }]);
  act(() => renderer.unmount());
});

test("StaffSettings master grant-all excludes credential actions, while a credential holder can switch theirs off and owner rows are immune", async () => {
  const saved: Array<{ membershipId: string; granted: string[]; revoked: string[] }> = [];
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<StaffSettings
      invite={async (payload) => payload}
      loadPermissions={async () => permissionFixture}
      savePermissions={async (membershipId, granted, revoked) => {
        saved.push({ membershipId, granted, revoked });
        return permissionFixture.members.find((member) => member.membershipReference.endsWith(membershipId))!;
      }}
    />);
  });
  const root = renderer.root;
  await act(async () => root.findByProps({ "aria-label": "Grant all available actions" }).props.onChange({ target: { checked: true } }));
  await act(async () => root.findByProps({ "aria-label": "Save permission changes" }).props.onClick());
  assert.deepEqual(saved[0], { membershipId: "staff", granted: ["payment.void", "payment.seal-day"], revoked: [] });

  await act(async () => root.findByProps({ "aria-label": "Staff member" }).props.onChange({ target: { value: "ProjectMembership/provider" } }));
  assert.equal(root.findByProps({ "aria-label": "protocols.author for Drew Doctor" }).props.disabled, false);
  await act(async () => root.findByProps({ "aria-label": "protocols.author for Drew Doctor" }).props.onChange({ target: { checked: false } }));
  await act(async () => root.findByProps({ "aria-label": "Save permission changes" }).props.onClick());
  assert.deepEqual(saved[1], { membershipId: "provider", granted: [], revoked: ["protocols.author"] });

  await act(async () => root.findByProps({ "aria-label": "Staff member" }).props.onChange({ target: { value: "ProjectMembership/owner" } }));
  assert.ok(root.findAllByType("input").filter((input) => input.props.type === "checkbox").every((input) => input.props.disabled));
  act(() => renderer.unmount());
});

test("SettingsIndex exposes Staff only to Admin", () => {
  const admin = renderToStaticMarkup(<SettingsIndex roles={["admin"]} />);
  const clinician = renderToStaticMarkup(<SettingsIndex roles={["provider"]} />);
  assert.match(admin, /href="\/settings\/staff"/);
  assert.doesNotMatch(clinician, /href="\/settings\/staff"/);
});

function permissionMember(overrides: Partial<StaffPermissionMember>): StaffPermissionMember {
  return {
    membershipReference: "ProjectMembership/member",
    display: "Staff Member",
    roles: ["staff"],
    roleActions: ["chart.read"],
    granted: [],
    revoked: [],
    effective: ["chart.read"],
    ignoredGranted: [],
    ignoredRevoked: [],
    malformed: false,
    owner: false,
    toggleImmune: false,
    ...overrides,
  };
}
