import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { validateCdsCard } from "../../mcp/src/cds/card-schema.js";
import { InMemoryCdsServiceRegistryStore } from "../../mcp/src/cds/service-registry.js";
import { createSmartTestServer } from "../smart/helpers.ts";

test("v0.55c no-agent-auth-flow boundary: CDS registration does not auto-activate before review", async () => {
  const store = new InMemoryCdsServiceRegistryStore();
  const server = await createSmartTestServer({ cdsServiceRegistryStore: store });
  try {
    const response = await fetch(`${server.origin}/cds-services/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service_id: "pending-cds",
        title: "Pending CDS",
        description: "Pending review.",
      }),
    });
    assert.equal(response.status, 202);
    assert.equal(store.records.size, 0);
  } finally {
    await server.close();
  }
});

test("v0.55c no-agent-auth-flow boundary: CDS key material storage uses pgp_sym_encrypt", () => {
  const sql = readFileSync(
    new URL("../../data/migrations/2026-05-02-v055c-cds-service-keys.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /pgp_sym_encrypt/);
  assert.match(sql, /encrypted_key_material BYTEA NOT NULL/);
});

test("v0.55c no-agent-auth-flow boundary: CDS cards cannot carry executable payloads", () => {
  const result = validateCdsCard({
    uuid: "a8a6f156-f08d-4a64-8e7d-247b4e74546a",
    summary: "Bad executable card",
    indicator: "critical",
    source: { label: "test" },
    detail: "javascript:alert(1)",
    dsi_type: "rules-based",
    intervention_risk_management: {
      risk_identification: "test",
      risk_mitigation: "test",
      continual_monitoring: "test",
    },
    source_attributes: {
      developer_identity: "test",
      funding_source: "test",
      evidence_basis_citation: "test",
    },
  });
  assert.equal(result.valid, false);
  assert.equal(result.errors.includes("card contains executable content"), true);
});
