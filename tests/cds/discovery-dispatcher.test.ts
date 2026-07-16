import assert from "node:assert/strict";
import { test } from "node:test";
import { createSmartTestServer } from "../smart/helpers.ts";
import { SNOMED_CT_SYSTEM } from "../../mcp/src/cds/types.js";

test("v0.55c CDS discovery advertises ODOS-default services and SMART config extension", async () => {
  const server = await createSmartTestServer();
  try {
    const discovery = await fetch(`${server.origin}/cds-services`);
    assert.equal(discovery.status, 200);
    const discoveryJson = await discovery.json() as { services: Array<{ id: string; hook: string }> };
    assert.deepEqual(
      discoveryJson.services.map((service) => service.id).sort(),
      ["odos-contact-lens-finalize", "odos-dry-eye-escalation", "odos-myopia-control-plan"].sort(),
    );

    const smart = await fetch(`${server.origin}/.well-known/smart-configuration`);
    const smartJson = await smart.json() as {
      registration_endpoint: string;
      cds_hooks_endpoint: string;
      cds_capabilities: string[];
    };
    assert.equal(smartJson.registration_endpoint, `${server.origin}/oauth2/register`);
    assert.equal(smartJson.cds_hooks_endpoint, `${server.origin}/cds-services`);
    assert.equal(smartJson.cds_capabilities.includes("odos-contact-lens-finalize"), true);
  } finally {
    await server.close();
  }
});

test("v0.55c dispatcher fires a local ODOS-default CDS service and returns HTI-1 DSI fields", async () => {
  const server = await createSmartTestServer({
    now: () => new Date("2026-05-02T12:00:00.000Z"),
  });
  try {
    const response = await fetch(`${server.origin}/cds-services/odos-contact-lens-finalize`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-ODOS-Actor-Id": "practitioner-1" },
      body: JSON.stringify({
        hook: "order-sign",
        hookInstance: "62b8b6ee-0abc-4b08-ae3a-b53c83a2db6d",
        context: { patientId: "patient-1", encounterId: "encounter-1" },
        prefetch: {
          serviceRequests: {
            resourceType: "Bundle",
            entry: [
              {
                resource: {
                  resourceType: "ServiceRequest",
                  status: "active",
                  intent: "order",
                  subject: { reference: "Patient/patient-1" },
                  code: {
                    coding: [
                      {
                        system: SNOMED_CT_SYSTEM,
                        code: "2488002",
                        display: "Prescription, fitting and dispensing of contact lens",
                      },
                    ],
                  },
                },
              },
            ],
          },
        },
      }),
    });
    assert.equal(response.status, 200);
    const json = await response.json() as { cards: Array<Record<string, unknown>> };
    assert.equal(json.cards.length, 1);
    assert.equal(json.cards[0]?.dsi_type, "rules-based");
    assert.ok(json.cards[0]?.intervention_risk_management);
    assert.ok(json.cards[0]?.source_attributes);
  } finally {
    await server.close();
  }
});
