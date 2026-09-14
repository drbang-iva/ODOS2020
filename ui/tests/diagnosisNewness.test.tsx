import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { AssessmentSection } from "../src/components/charting/AssessmentSection";
import { RoleProvider } from "../src/lib/role-context";
import { rankProtocolOffers } from "../../mcp/src/clinical-graph/protocol-service";
import type { ProtocolDefinition, ProtocolOfferDiagnosis } from "../../mcp/src/clinical-graph/protocol-types";

const definitions = [
  { id: "new", title: "New protocol", trigger: { kind: "diagnosis", dxKeys: ["H52.13"], statusScope: ["new"] } },
  { id: "unscoped", title: "Unscoped protocol", trigger: { kind: "diagnosis", dxKeys: ["H52.13"] } },
].map((entry) => ({ ...entry, version: 1, status: "active", ownership: { ownerId: "test", sharing: "private" }, categories: [], items: [], authoring: { origin: "clinician", at: "", actor: "" }, audit: { createdBy: "", createdAt: "" } })) as ProtocolDefinition[];

for (const scenario of ["suggested-new", "doctor-new", "doctor-established", "suggested-established"] as const) {
  test(`Assessment ranking feed follows ${scenario}`, async () => {
    const originalFetch = globalThis.fetch;
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() });
    let lastRanking: string[] = [];
    let lastDiagnoses: ProtocolOfferDiagnosis[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/fhir/R4/Encounter/e1")) return Response.json({ resourceType: "Encounter", id: "e1", status: "in-progress", diagnosis: [{ condition: { reference: "Condition/a" }, rank: 1 }] });
      if (url.includes("/fhir/R4/Condition")) return Response.json({ resourceType: "Bundle", type: "searchset", entry: [{ resource: {
        resourceType: "Condition", id: "a", subject: { reference: "Patient/p1" }, encounter: { reference: "Encounter/e1" },
        category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-category", code: "encounter-diagnosis" }] }],
        verificationStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code: "confirmed" }] },
        code: { coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: "H52.13" }] },
      } }] });
      if (url.endsWith("/diagnosis-statuses")) return Response.json({ statuses: [{ conditionReference: "Condition/a", status: scenario === "doctor-established" ? "new" : "stable" }] });
      if (url.endsWith("/diagnosis-newness")) return Response.json({ rows: [{ conditionReference: "Condition/a", value: scenario.endsWith("-new") ? "new" : "established", source: scenario.startsWith("doctor") ? "doctor" : "suggestion" }] });
      if (url.endsWith("/protocols/offers")) {
        lastDiagnoses = JSON.parse(String(init?.body)).diagnoses;
        lastRanking = rankProtocolOffers(definitions, lastDiagnoses).map((row) => row.id);
        return Response.json({ protocols: [] });
      }
      return Response.json({ diagnoses: [], applications: [], attachedProcedures: [] });
    }) as typeof fetch;
    let renderer!: ReactTestRenderer;
    try {
      await act(async () => {
        renderer = create(<RoleProvider initialRole="doctor"><AssessmentSection patientReference="Patient/p1" encounterReference="Encounter/e1" onSaved={() => undefined} /></RoleProvider>);
      });
      assert.equal(lastRanking[0], scenario.endsWith("-new") ? "new" : "unscoped");
      assert.equal(lastDiagnoses[0]?.visitStatus === "new", scenario.endsWith("-new"));
    } finally {
      act(() => renderer?.unmount());
      globalThis.fetch = originalFetch;
      Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    }
  });
}
