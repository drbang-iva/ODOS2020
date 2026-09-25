import { buildAgeOfMajorityConfigResource } from "../../mcp/src/clinic/age-of-majority-config";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { NewPatient } from "../src/scenes/NewPatient";

function reply(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

test("registration failure is shown directly above Create patient", async () => {
  const previous = globalThis.fetch;
  let registrationPosts = 0;
  globalThis.fetch = async input => {
    if (String(input).includes("Basic?")) return reply({ resourceType: "Bundle", entry: [{ resource: buildAgeOfMajorityConfigResource({ ageOfMajorityYears: 18 }) }] });
    if (String(input).includes("preferences/defaults")) return reply({ version: "synthetic", defaults: {} });
    registrationPosts++;
    return reply({ error: "A guarantor mailing address is required." }, 400);
  };
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => { renderer = create(<NewPatient />); });
    for (const [key, value] of Object.entries({ firstName: "Synthetic", lastName: "Adult", gender: "female" })) {
      const input = renderer!.root.findAll(node => node.type === "input" || node.type === "select").find(node => {
        for (let parent = node.parent; parent; parent = parent.parent) if (parent.props.field?.key === key) return true;
        return false;
      })!;
      await act(async () => input.props.onChange({ target: { value } }));
    }
    for (const [label, value] of Object.entries({ "Date of birth": "1980-01-02", "Phone 1": "864-555-0100" })) {
      const input = renderer!.root.findAllByType("label").find(node => node.children.includes(label))!.findByType("input");
      await act(async () => input.props.onChange({ target: { value } }));
    }
    const button = renderer!.root.findAllByType("button").find(node => node.children.includes("Create patient"))!;
    await act(async () => button.props.onClick());
    assert.equal(registrationPosts, 1);
    const parent = button.parent!;
    const alert = parent.findAllByProps({ role: "alert" });
    assert.equal(alert.length, 1);
    assert.match(alert[0]!.children.join(""), /A guarantor mailing address is required/);
    assert.equal(parent.children.indexOf(alert[0]!), parent.children.indexOf(button) - 1);
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    globalThis.fetch = previous;
  }
});
