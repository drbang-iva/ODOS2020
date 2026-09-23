import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Encounter } from "@medplum/fhirtypes";
import { EncounterHeader } from "../src/components/charting/EncounterHeader";
import { ConfirmDestructiveProvider } from "../src/components/charting/ConfirmDestructive";
import { fhir } from "../src/lib/fhir";
import { RoleProvider } from "../src/lib/role-context";
function text(node: { children?: unknown[] }): string { return (node.children ?? []).map(child => typeof child === "string" ? child : child && typeof child === "object" ? text(child as { children?: unknown[] }) : "").join(" "); }
async function harness(status: Encounter["status"], run: (renderer: ReactTestRenderer, calls: () => number) => Promise<void>) {
  const oldFetch = globalThis.fetch, oldRead = fhir.read, oldTransaction = fhir.executeTransaction;
  let renderer: ReactTestRenderer | undefined, calls = 0;
  try {
    globalThis.fetch = async request => {
      const url = String(request);
      if (url.includes("/exam-scope")) return Response.json({ examScope: "office-visit", canWrite: true });
      if (url.endsWith("/abandon")) { calls++; return Response.json({ code: "encounter-has-content", content: [{ kind: "Observation", count: 1 }, { kind: "ChargeItem", count: 2 }, { kind: "Media", count: 1 }] }, { status: 409 }); }
      throw new Error(`Unexpected request ${url}`);
    };
    fhir.read = (async () => ({ resourceType: "Encounter", id: "e1", status, class: { code: "AMB" }, subject: { reference: "Patient/p1" } })) as typeof fhir.read;
    fhir.executeTransaction = (async () => { calls++; throw new Error("UI must not submit abandonment FHIR transaction"); }) as typeof fhir.executeTransaction;
    await act(async () => { renderer = create(<RoleProvider initialRole="doctor"><ConfirmDestructiveProvider><EncounterHeader patient={{ resourceType: "Patient", id: "p1" }} encounterId="e1" /></ConfirmDestructiveProvider></RoleProvider>); });
    await run(renderer!, () => calls);
  } finally {
    await act(async () => renderer?.unmount()); globalThis.fetch = oldFetch; fhir.read = oldRead; fhir.executeTransaction = oldTransaction;
  }
}
test("A11 confirmation precedes any write, Keep refuses, and content refusal names kinds", async () => {
  await harness("in-progress", async (renderer, calls) => {
    const button = () => renderer.root.findAllByType("button").find(node => text(node) === "Abandon encounter")!;
    let pending: Promise<void> | undefined;
    await act(async () => { pending = button().props.onClick(); });
    assert.equal(calls(), 0);
    assert.match(text(renderer.root.findByProps({ role: "alertdialog" })), /Abandon this visit\? Use only when the exam did not happen\. The visit is closed and cannot be reopened\./);
    await act(async () => { renderer.root.findAllByType("button").find(node => text(node) === "Keep")!.props.onClick(); await pending; });
    assert.equal(calls(), 0);
    await act(async () => { pending = button().props.onClick(); });
    assert.equal(calls(), 0);
    await act(async () => { renderer.root.findAllByType("button").find(node => text(node) === "Abandon visit")!.props.onClick(); await pending; });
    assert.equal(calls(), 1);
    assert.match(text(renderer.root), /findings.*charges.*images/);
    assert.match(text(renderer.root), /remove them first or sign the visit/i);
  });
});
test("A11 finished visit disables abandonment with its reason", async () => {
  await harness("finished", async (renderer, calls) => {
    const button = renderer.root.findAllByType("button").find(node => text(node) === "Abandon encounter")!;
    assert.equal(button.props.disabled, true);
    assert.match(button.props.title, /signed/i);
    assert.equal(calls(), 0);
  });
});

test("A13 encounter reload during confirmation sends once or shows a visible reason", async () => {
  await harness("in-progress", async (renderer, calls) => {
    const button = renderer.root.findAllByType("button").find(node => text(node) === "Abandon encounter")!;
    let pending: Promise<void> | undefined;
    await act(async () => { pending = button.props.onClick(); });
    assert.equal(calls(), 0);
    await act(async () => {
      renderer.update(<RoleProvider initialRole="doctor"><ConfirmDestructiveProvider><EncounterHeader patient={{ resourceType: "Patient", id: "p2" }} encounterId="e1" /></ConfirmDestructiveProvider></RoleProvider>);
    });
    await act(async () => {
      renderer.root.findAllByType("button").find(node => text(node) === "Abandon visit")!.props.onClick();
      await pending;
    });
    assert.equal(calls(), 1);
    assert.match(text(renderer.root), /remove them first or sign the visit/i);
  });
});

test("A13 changing visits during confirmation refuses the old request visibly", async () => {
  await harness("in-progress", async (renderer, calls) => {
    const button = renderer.root.findAllByType("button").find(node => text(node) === "Abandon encounter")!;
    let pending: Promise<void> | undefined;
    await act(async () => { pending = button.props.onClick(); });
    await act(async () => {
      renderer.update(<RoleProvider initialRole="doctor"><ConfirmDestructiveProvider><EncounterHeader patient={{ resourceType: "Patient", id: "p1" }} encounterId="e2" /></ConfirmDestructiveProvider></RoleProvider>);
    });
    await act(async () => {
      renderer.root.findAllByType("button").find(node => text(node) === "Abandon visit")!.props.onClick();
      await pending;
    });
    assert.equal(calls(), 0);
    assert.match(text(renderer.root), /visit changed while confirmation was open/i);
  });
});
