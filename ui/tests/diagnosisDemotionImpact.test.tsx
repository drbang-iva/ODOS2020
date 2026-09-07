import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, Condition, Encounter } from "@medplum/fhirtypes";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { AssessmentSection } from "../src/components/charting/AssessmentSection";
import { DiagnosisDemotionImpactNotice } from "../src/components/charting/DiagnosisDemotionImpactNotice";
import { DiagnosisPicker } from "../src/components/charting/DiagnosisPicker";
import { fhir } from "../src/lib/fhir";
import { RoleProvider } from "../src/lib/role-context";

const impact = {
  strandedCharges: [{
    reference: "ChargeItem/charge-1",
    display: "Synthetic procedure",
    amount: { value: 70.25, currency: "USD" },
  }],
  unaffectedChargeCount: 0,
  strandedChargesComputed: true,
};

test("the shared demotion presenter shows the charge, line-total amount, and claim consequence", () => {
  const html = renderToStaticMarkup(<DiagnosisDemotionImpactNotice impact={impact} />);

  assert.match(html, /Synthetic procedure/);
  assert.match(html, /\$70\.25/);
  assert.doesNotMatch(html, /\$210\.75/);
  assert.match(html, /will not reach claim until re-pointed/);
});

test("the shared demotion presenter makes an unavailable post-write impact computation explicit", () => {
  const html = renderToStaticMarkup(<DiagnosisDemotionImpactNotice impact={{
    strandedCharges: [],
    unaffectedChargeCount: 0,
    strandedChargesComputed: false,
  }} />);

  assert.match(html, /Charge impact could not be computed/);
});

test("DiagnosisPicker surfaces a stranded-charge warning after its variable Possible action", async () => {
  const originalFetch = globalThis.fetch;
  const restoreWindow = installWindow();
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("diagnosis-candidates")) {
      return Response.json({
        findings: [{
          findingInstanceId: "finding-1",
          observationReference: "Observation/finding-1",
          candidates: [{
            diagnosisKey: "presbyopia",
            display: "Presbyopia",
            codingStatus: "verified",
            priority: true,
            source: "rule",
          }],
        }],
      });
    }
    if (url.includes("diagnosis-catalog")) return Response.json({ diagnoses: [] });
    if (url.includes("diagnosis-picks") && init?.method === "POST") {
      return Response.json({
        condition: { resourceType: "Condition", id: "condition-1" },
        action: "possible",
        ...impact,
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<DiagnosisPicker
        encounterReference="Encounter/e1"
        observationReferences={["Observation/finding-1"]}
      />);
      await flushEffects();
    });
    const toggle = renderer.root.findAllByType("button").find((button) => textContent(button).includes("dx ▾"));
    assert.ok(toggle);
    act(() => toggle.props.onClick());
    const possible = renderer.root.findAllByType("button").find((button) => textContent(button) === "Possible");
    assert.ok(possible);
    await act(async () => {
      await possible.props.onClick();
      await flushEffects();
    });

    assert.match(JSON.stringify(renderer.toJSON()), /Synthetic procedure/);
    assert.match(JSON.stringify(renderer.toJSON()), /will not reach claim until re-pointed/);

    await act(async () => {
      renderer.update(<DiagnosisPicker
        encounterReference="Encounter/e1"
        observationReferences={["Observation/finding-1"]}
        refreshKey={1}
      />);
      await flushEffects();
    });
    assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /will not reach claim until re-pointed/);
  } finally {
    act(() => renderer?.unmount());
    globalThis.fetch = originalFetch;
    restoreWindow();
  }
});

test("AssessmentSection surfaces a stranded-charge warning after its variable Discard action", async () => {
  const originalFetch = globalThis.fetch;
  const restoreWindow = installWindow();
  const originalRead = fhir.read;
  const originalSearch = fhir.search;
  const possibleCondition: Condition = {
    resourceType: "Condition",
    id: "condition-1",
    subject: { reference: "Patient/p1" },
    encounter: { reference: "Encounter/e1" },
    category: [{ coding: [{
      system: "http://terminology.hl7.org/CodeSystem/condition-category",
      code: "encounter-diagnosis",
    }] }],
    verificationStatus: { coding: [{
      system: "http://terminology.hl7.org/CodeSystem/condition-ver-status",
      code: "provisional",
    }] },
    identifier: [{
      system: "https://odos2020.com/fhir/NamingSystem/diagnosis-catalog-stable-key",
      value: "e1::presbyopia::none",
    }],
    code: { text: "Presbyopia" },
  };
  fhir.read = (async (resourceType: string) => {
    if (resourceType === "Encounter") {
      return {
        resourceType: "Encounter",
        id: "e1",
        status: "in-progress",
        class: {},
        subject: { reference: "Patient/p1" },
        diagnosis: [{ condition: { reference: "Condition/condition-1" }, rank: 1 }],
      } as Encounter;
    }
    throw new Error(`Unexpected read: ${resourceType}`);
  }) as typeof fhir.read;
  fhir.search = (async (resourceType: string) => {
    if (resourceType === "Condition") {
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: [{ resource: possibleCondition }],
      } as Bundle<Condition>;
    }
    throw new Error(`Unexpected search: ${resourceType}`);
  }) as typeof fhir.search;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/diagnosis-picks") && init?.method === "POST") {
      return Response.json({
        condition: {
          ...possibleCondition,
          verificationStatus: { coding: [{
            system: "http://terminology.hl7.org/CodeSystem/condition-ver-status",
            code: "refuted",
          }] },
        },
        action: "discard",
        ...impact,
      });
    }
    if (url.includes("/diagnosis-statuses")) return Response.json({ statuses: [] });
    if (url.includes("/procedure-charges")) {
      return Response.json({ options: [], diagnoses: [], proposals: [], attachedProcedures: [] });
    }
    if (url.includes("/protocols/applications")) return Response.json({ applications: [] });
    if (url.includes("/diagnosis-catalog")) return Response.json({ diagnoses: [] });
    throw new Error(`Unexpected request: ${url}`);
  };
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <RoleProvider initialRole="provider">
          <AssessmentSection
            patientReference="Patient/p1"
            encounterReference="Encounter/e1"
            onSaved={() => undefined}
          />
        </RoleProvider>,
      );
      await flushEffects();
      await flushEffects();
    });
    const discard = renderer.root.findAllByType("button").find((button) => textContent(button) === "Discard");
    assert.ok(discard);
    await act(async () => {
      await discard.props.onClick();
      await flushEffects();
    });

    assert.match(JSON.stringify(renderer.toJSON()), /Synthetic procedure/);
    assert.match(JSON.stringify(renderer.toJSON()), /will not reach claim until re-pointed/);

    await act(async () => {
      window.dispatchEvent(new CustomEvent("odos:diagnosis-picked", {
        detail: { encounterReference: "Encounter/e1" },
      }));
      await flushEffects();
    });
    assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /will not reach claim until re-pointed/);
  } finally {
    act(() => renderer?.unmount());
    globalThis.fetch = originalFetch;
    fhir.read = originalRead;
    fhir.search = originalSearch;
    restoreWindow();
  }
});

async function flushEffects(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function textContent(node: { children?: unknown[] }): string {
  return (node.children ?? []).map((child) => typeof child === "string" ? child : "").join("");
}

function installWindow(): () => void {
  const originalWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: new EventTarget(),
  });
  return () => Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
}
