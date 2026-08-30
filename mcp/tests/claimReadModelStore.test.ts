import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import {
  PgClaimReadModelStore,
  type ClaimReadModelRow,
} from "../src/claims/claim-read-model-store.js";
import { loadRepoEnv } from "./integration-helpers.js";

const MIGRATION_FILE = fileURLToPath(
  new URL("../../data/migrations/2026-08-30-claim-touch-ledger.sql", import.meta.url),
);
const AT = "2026-08-30T12:00:00.000Z";
const schema = `claim_read_model_${randomUUID().replaceAll("-", "")}`;
let pool: Pool;
let store: PgClaimReadModelStore;

before(async () => {
  loadRepoEnv();
  pool = new Pool({
    connectionString: process.env.ODOS_POSTGRES_URL
      ?? "postgresql://medplum:medplum@127.0.0.1:5433/medplum",
    max: 1,
  });
  await pool.query(`CREATE SCHEMA ${schema}`);
  await pool.query(`SET search_path TO ${schema}, public`);
  await pool.query(await readFile(MIGRATION_FILE, "utf8"));
  store = new PgClaimReadModelStore({ pool, initializeSchema: false });
});

after(async () => {
  await pool.query("SET search_path TO public");
  await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
});

test("rebuild is atomic and server-side worklist grouping returns honest untouched facts", async () => {
  await store.rebuild([row({ claimReference: "Claim/old", billedAt: "2026-05-01T12:00:00.000Z", reasonCode: "cob-review", reasonDisplay: "COB review", resolutionPath: "Review plan benefits" }), row({ claimReference: "Claim/new", billedAt: "2026-08-20T12:00:00.000Z", reasonCode: "cob-review", reasonDisplay: "COB review", resolutionPath: "Review plan benefits" })], AT);

  const groups = await store.worklist({ at: AT, thresholds: [30, 60, 90] });

  assert.equal(groups.length, 1);
  assert.equal(groups[0].count, 2);
  assert.equal(groups[0].totalOutstandingCents, 25_000);
  assert.deepEqual(groups[0].rows.map((candidate) => candidate.claimReference), ["Claim/old", "Claim/new"]);
  assert.equal(groups[0].rows[0].touchCount, 0);
  assert.equal(groups[0].rows[0].lastTouchedAt, null);
  assert.equal(groups[0].rows[0].daysSinceTouched, null);
  assert.equal(groups[0].rows[0].untouchedRankingDays, 121);
});

test("never-paid-untouched aggregation is performed by payer and month in PostgreSQL", async () => {
  await store.rebuild([
    row({ claimReference: "Claim/a", billedAt: "2026-06-02T12:00:00.000Z" }),
    row({ claimReference: "Claim/b", billedAt: "2026-06-20T12:00:00.000Z", collectedCents: 5_000 }),
    row({ claimReference: "Claim/c", billedAt: "2026-06-21T12:00:00.000Z", touchCount: 1, lastTouchedAt: "2026-06-22T12:00:00.000Z", lastTouchedBy: "Practitioner/staff-1" }),
  ], AT);

  assert.deepEqual(await store.neverPaidUntouchedMetric(), [{
    payerReference: "Organization/payer-1",
    payer: "Synthetic Payer",
    billedMonth: "2026-06",
    billedClaimCount: 3,
    neverPaidUntouchedCount: 1,
    neverPaidUntouchedRate: 1 / 3,
  }]);
});

test("reconciliation detects a corrupted money row and a rebuild restores exact FHIR-derived truth", async () => {
  const truth = [row({ claimReference: "Claim/a" }), row({ claimReference: "Claim/b" })];
  await store.rebuild(truth, AT);
  await pool.query(
    "UPDATE odos_claim_work_state SET total_charged_cents = total_charged_cents + 1 WHERE claim_reference = $1",
    ["Claim/b"],
  );

  assert.deepEqual(await store.reconcile(truth), {
    inSync: false,
    truthCount: 2,
    readModelCount: 2,
    divergences: [{ claimReference: "Claim/b", kind: "mismatch", fields: ["totalChargedCents"] }],
  });
  await store.rebuild(truth, AT);
  assert.deepEqual(await store.reconcile(truth), {
    inSync: true,
    truthCount: 2,
    readModelCount: 2,
    divergences: [],
  });
});

function row(overrides: Partial<ClaimReadModelRow>): ClaimReadModelRow {
  return {
    claimReference: "Claim/default",
    claimNumber: "ODOS-1",
    patientReference: "Patient/patient-1",
    patient: "Synthetic Patient",
    providerReference: "Practitioner/provider-1",
    provider: "Synthetic Provider",
    cptCodes: ["PROC-A"],
    totalChargedCents: 12_500,
    collectedCents: 0,
    patientResponsibilityCents: 0,
    status: "submitted",
    payerReference: "Organization/payer-1",
    payer: "Synthetic Payer",
    billedAt: "2026-06-01T12:00:00.000Z",
    open: true,
    touchCount: 0,
    lastTouchedAt: null,
    lastTouchedBy: null,
    reasonCode: null,
    reasonDisplay: null,
    resolutionPath: null,
    ...overrides,
  };
}
