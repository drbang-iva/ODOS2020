import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryCdsFeedbackRepository } from "../../mcp/src/cds/feedback.js";
import { InMemoryCdsServiceRegistryStore } from "../../mcp/src/cds/service-registry.js";
import { createSmartTestServer } from "../smart/helpers.ts";

const validRegistration = {
  service_id: "external-local-cds",
  title: "External local CDS",
  description: "Practice-reviewed external CDS service.",
  endpoint_url: "https://cds.example.test/hooks/local",
  cds_risk_class: "LOW",
  phi_boundary: "read-only",
  launch_mode: "cds-service",
  network_egress: "none",
  external_services_required: false,
  baa_required: false,
  image_analysis_prohibited: true,
  allowedJurisdictions: [],
  prohibitedStates: [],
  scope_request_canonical: "system/Observation.rs",
  hook_subscriptions: ["order-sign"],
  card_ttl_minutes: 60,
  request_timeout_seconds: 10,
};

test("v0.55c CDS registration stages admin review before activation", async () => {
  const store = new InMemoryCdsServiceRegistryStore();
  const server = await createSmartTestServer({ cdsServiceRegistryStore: store });
  try {
    const response = await postJson(`${server.origin}/cds-services/register`, validRegistration);
    assert.equal(response.status, 202);
    assert.equal(store.records.size, 0);
  } finally {
    await server.close();
  }
});

test("v0.55c CDS registration blocks image-analysis payloads and activates approved metadata", async () => {
  const store = new InMemoryCdsServiceRegistryStore();
  const server = await createSmartTestServer({ cdsServiceRegistryStore: store });
  try {
    const blocked = await postJson(`${server.origin}/cds-services/register`, {
      ...validRegistration,
      admin_review_approved: true,
      image_analysis_payload: true,
    });
    assert.equal(blocked.status, 400);

    const approved = await postJson(`${server.origin}/cds-services/register`, {
      ...validRegistration,
      admin_review_approved: true,
    });
    assert.equal(approved.status, 201);
    assert.equal(store.records.size, 1);

    const discovery = await fetch(`${server.origin}/cds-services`);
    const json = await discovery.json() as { services: Array<{ id: string }> };
    assert.equal(json.services.some((service) => service.id === "external-local-cds"), true);
  } finally {
    await server.close();
  }
});

test("v0.55c CDS feedback endpoint persists acceptance and override outcomes", async () => {
  const repository = new InMemoryCdsFeedbackRepository();
  const server = await createSmartTestServer({ cdsFeedbackRepository: repository });
  try {
    const response = await postJson(`${server.origin}/cds-services/osod-contact-lens-finalize/feedback`, {
      feedback: [
        {
          card: "afc5fd88-3c05-4a7c-b7ce-74851ef713bd",
          outcome: "accepted",
          acceptedSuggestions: ["osod-contact-lens-finalize-review"],
          outcomeTimestamp: "2026-05-02T12:00:00.000Z",
        },
        {
          card: "8e4546b9-4da1-46ea-88ac-0d9e51f897dd",
          outcome: "overridden",
          overrideReason: {
            reason: { code: "clinician-judgment", system: "https://osod.dev/fhir/CodeSystem/cds-override" },
            userComment: "Not applicable to this lens order.",
          },
          outcomeTimestamp: "2026-05-02T12:01:00.000Z",
        },
      ],
    });
    assert.equal(response.status, 201);
    assert.equal(repository.rows.length, 2);
    assert.equal(repository.rows[0]?.outcome, "accepted");
    assert.equal(repository.rows[1]?.overrideReasonCode, "clinician-judgment");
  } finally {
    await server.close();
  }
});

function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-OSOD-Actor-Id": "admin-1", "X-OSOD-Role": "practice-admin" },
    body: JSON.stringify(body),
  });
}
