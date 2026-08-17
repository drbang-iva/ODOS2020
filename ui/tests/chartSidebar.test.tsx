import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Bundle, Resource } from "@medplum/fhirtypes";
import { ChartSidebar } from "../src/components/ChartSidebar";
import { fhir } from "../src/lib/fhir";
import { RoleProvider } from "../src/lib/role-context";

const patient = { resourceType: "Patient", id: "patient-1" } as const;

test("one forbidden sidebar search names its resource while the other seven results still render", async () => {
  const renderer = await renderSidebar("CareTeam");
  try {
    const rendered = JSON.stringify(renderer.toJSON());
    assert.match(rendered, /CareTeam.*unavailable:.*FHIR 403 : Forbidden/);
    assert.doesNotMatch(rendered, /No care team recorded/);
    assert.match(rendered, /1 active chart lists/);
    assert.match(rendered, /Penicillin/);
    assert.match(rendered, /Never smoker/);
    assert.match(rendered, /2026-08-17/);
    assert.match(rendered, /Dry eye/);
    assert.match(rendered, /1 linked visits/);
    assert.match(rendered, /Latanoprost/);
    assert.match(rendered, /Scleral lens/);
    assert.match(rendered, /Primary open-angle glaucoma/);
  } finally {
    renderer.unmount();
  }
});

test("a forbidden Condition read cannot render as an empty zero-count problem list", async () => {
  const renderer = await renderSidebar("Condition");
  try {
    const rendered = JSON.stringify(renderer.toJSON());
    assert.match(rendered, /Active chart lists unavailable/);
    assert.match(rendered, /Condition.*unavailable:.*FHIR 403 : Forbidden/);
    assert.doesNotMatch(rendered, /0 active chart lists/);
    assert.doesNotMatch(rendered, /No active longitudinal problems/);
  } finally {
    renderer.unmount();
  }
});

test("an empty CareTeam read keeps the distinct recorded-empty state", async () => {
  const renderer = await renderSidebar(undefined, "CareTeam");
  try {
    const rendered = JSON.stringify(renderer.toJSON());
    assert.match(rendered, /No care team recorded/);
    assert.doesNotMatch(rendered, /CareTeam.*unavailable/);
  } finally {
    renderer.unmount();
  }
});

async function renderSidebar(
  failingResourceType?: string,
  emptyResourceType?: string,
): Promise<ReactTestRenderer> {
  const originalSearch = fhir.search;
  const originalFetch = globalThis.fetch;
  fhir.search = async <T extends Resource>(resourceType: T["resourceType"]): Promise<Bundle<T>> => {
    if (resourceType === failingResourceType) throw new Error("FHIR 403 : Forbidden");
    if (resourceType === emptyResourceType) return bundleFor("") as Bundle<T>;
    return bundleFor(resourceType) as Bundle<T>;
  };
  globalThis.fetch = async () => new Response(JSON.stringify({ definitions: [], images: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <RoleProvider initialRole="doctor">
          <ChartSidebar patient={patient} />
        </RoleProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    return renderer;
  } finally {
    fhir.search = originalSearch;
    globalThis.fetch = originalFetch;
  }
}

function bundleFor(resourceType: string): Bundle {
  const resource = resources[resourceType];
  return {
    resourceType: "Bundle",
    type: "searchset",
    ...(resource ? { entry: [{ resource }] } : {}),
  };
}

const resources: Record<string, Resource> = {
  AllergyIntolerance: {
    resourceType: "AllergyIntolerance",
    id: "allergy-1",
    patient: { reference: "Patient/patient-1" },
    code: { text: "Penicillin" },
  },
  Observation: {
    resourceType: "Observation",
    id: "smoking-1",
    status: "final",
    code: { coding: [{ system: "http://loinc.org", code: "72166-2" }] },
    subject: { reference: "Patient/patient-1" },
    effectiveDateTime: "2026-08-17T12:00:00Z",
    valueCodeableConcept: { text: "Never smoker" },
  },
  EpisodeOfCare: {
    resourceType: "EpisodeOfCare",
    id: "program-1",
    status: "active",
    patient: { reference: "Patient/patient-1" },
    type: [{ text: "Dry eye" }],
  },
  Encounter: {
    resourceType: "Encounter",
    id: "encounter-1",
    status: "in-progress",
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
    subject: { reference: "Patient/patient-1" },
    episodeOfCare: [{ reference: "EpisodeOfCare/program-1" }],
  },
  MedicationStatement: {
    resourceType: "MedicationStatement",
    id: "medication-1",
    status: "active",
    subject: { reference: "Patient/patient-1" },
    medicationCodeableConcept: { text: "Latanoprost" },
  },
  DeviceUseStatement: {
    resourceType: "DeviceUseStatement",
    id: "device-use-1",
    status: "active",
    subject: { reference: "Patient/patient-1" },
    device: { reference: "Device/device-1", display: "Scleral lens" },
  },
  Condition: {
    resourceType: "Condition",
    id: "condition-1",
    subject: { reference: "Patient/patient-1" },
    category: [{
      coding: [{
        system: "http://terminology.hl7.org/CodeSystem/condition-category",
        code: "problem-list-item",
      }],
    }],
    clinicalStatus: {
      coding: [{
        system: "http://terminology.hl7.org/CodeSystem/condition-clinical",
        code: "active",
      }],
    },
    code: { text: "Primary open-angle glaucoma" },
  },
};
