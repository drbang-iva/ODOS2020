import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Encounter, Patient } from "@medplum/fhirtypes";
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
        if (url.endsWith("/exam-overview")) return Response.json({ patientReference: "Patient/p1", encounterReference: "Encounter/e1", sections: [], findings: [], completeness: { status: "unconfigured", requiredSectionCount: 0, resolvedSectionCount: 0, trace: [], documentationIssues: [] } });
        if (url.endsWith("/exam-view-state")) return Response.json({ collapsed: [], shelved: [] });
        if (url.endsWith("/void/ledger")) return Response.json({ ledger: { encounterId: "e1", encounter: null, sections: {} }, canWriteDiagnosis: false });
        if (url.includes("finding-section-groups")) return Response.json({ canWrite: false, canPullIn: false, groups: [], overrideGroupKeys: [], effectiveGroupKeys: [] });
        if (url.includes("finding-definitions") || url.includes("procedure-definitions")) return Response.json({ canWrite: false, definitions: [] });
        if (url.includes("eye-growth/visibility")) return Response.json({ defaultVisible: false });
        if (url.endsWith("/findings")) return Response.json({ canWrite: false, findings: [], catalog: [], unassigned: [], bySection: {}, visitDiagnoses: [] });
        if (url.endsWith("/diagnosis-candidates")) return Response.json({ findings: [] });
        if (url.endsWith("/previous-exams")) return Response.json({ pageSize: 4, encounters: [] });
        if (url.includes("/longitudinal-imaging") || url.includes("/clinical-graph/imaging")) return Response.json({ images: [] });
        if (url.endsWith("/follow-up-queue")) return Response.json({ state: "not-recorded", rows: [] });
        if (url.endsWith("/visit-charge")) return Response.json({ options: [], diagnoses: [] });
        if (url.endsWith("/procedure-charges")) return Response.json({ options: [], diagnoses: [], proposals: [], attachedProcedures: [] });
        throw new Error(`Unexpected request: ${url}`);
      };
      fhir.read = (async () => ({ resourceType: "Encounter", id: "e1", status: "in-progress", class: { code: "AMB" }, subject: { reference: "Patient/p1" } } satisfies Encounter)) as typeof fhir.read;
      fhir.executeTransaction = (async () => { finishes++; throw new Error("finish transaction must not be called"); }) as typeof fhir.executeTransaction;
      const { EncounterCharting } = await import("../src/scenes/EncounterCharting");
      await act(async () => { renderer = create(<RoleProvider initialRole="doctor"><EncounterCharting patient={{ resourceType: "Patient", id: "p1" } satisfies Patient} encounterId="e1" /></RoleProvider>); });
      await act(async () => { await renderer!.root.findByProps({ "data-chart-bar-slot": "sign" }).props.onClick(); });
      assert.equal(cleanupCalls, 0);
      assert.equal(finishes, 0);
      const review = renderer!.root.findByProps({ "aria-labelledby": "exam-review-title" });
      await act(async () => { await review.findByType("button").props.onClick(); });
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
