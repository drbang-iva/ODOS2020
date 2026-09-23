import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Encounter, Patient } from "@medplum/fhirtypes";
import { EncounterHeader } from "../src/components/charting/EncounterHeader";
import { fhir } from "../src/lib/fhir";
import { RoleProvider } from "../src/lib/role-context";

function content(node: { children?: unknown[] }): string {
  return (node.children ?? []).map(child => typeof child === "string" ? child :
    child && typeof child === "object" ? content(child as { children?: unknown[] }) : "").join("");
}

for (const [status, body, expected] of [
  [409, { code: "interpretation-required", error: "Fundus photography needs an interpretation and report before this visit can be signed (or remove its charge)." }, "Fundus photography needs an interpretation and report"],
  [500, { error: "Synthetic failure" }, "Protocol sign cleanup failed: 500"],
] as const) {
  test(`G12 sign cleanup ${status} shows the right error and never finishes the encounter`, async () => {
    const oldFetch = globalThis.fetch, oldRead = fhir.read, oldTransaction = fhir.executeTransaction;
    let finishes = 0, cleanupCalls = 0;
    let renderer: ReactTestRenderer | undefined;
    try {
      globalThis.fetch = async (request) => {
        const url = String(request);
        if (url.includes("/exam-scope")) return Response.json({ examScope: "office-visit", canWrite: true });
        if (url.includes("/diagnosis-completeness")) return Response.json({ diagnoses: [] });
        if (url.includes("/sign-cleanup")) { cleanupCalls++; return Response.json(body, { status }); }
        throw new Error(`Unexpected request: ${url}`);
      };
      fhir.read = (async () => ({ resourceType: "Encounter", id: "e1", status: "in-progress", class: { code: "AMB" }, subject: { reference: "Patient/p1" } } satisfies Encounter)) as typeof fhir.read;
      fhir.executeTransaction = (async () => { finishes++; throw new Error("finish transaction must not be called"); }) as typeof fhir.executeTransaction;
      await act(async () => { renderer = create(<RoleProvider initialRole="doctor"><EncounterHeader patient={{ resourceType: "Patient", id: "p1" } satisfies Patient} encounterId="e1" /></RoleProvider>); });
      await act(async () => { await renderer!.root.findByProps({ "data-chart-bar-slot": "sign" }).props.onClick(); });
      assert.equal(cleanupCalls, 1);
      assert.equal(finishes, 0);
      assert.match(content(renderer!.root), new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
      await act(async () => renderer?.unmount());
      globalThis.fetch = oldFetch;
      fhir.read = oldRead;
      fhir.executeTransaction = oldTransaction;
    }
  });
}
