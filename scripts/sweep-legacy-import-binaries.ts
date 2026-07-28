#!/usr/bin/env tsx
import { PgBinaryAttemptStore } from "../mcp/src/legacy-import/binary-attempt-store.js";
import {
  PgBinaryReferenceScanner,
  sweepLegacyImportBinaries,
} from "../mcp/src/legacy-import/orphan-sweep.js";
import { exchangeClientCredentials } from "../data/medplum-adapters/migration-importer-adapter.js";

const baseUrl = process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103";
const postgresUrl =
  process.env.ODOS_POSTGRES_URL
  ?? process.env.OSOD_POSTGRES_URL
  ?? "postgresql://medplum:medplum@127.0.0.1:5432/medplum";
assertLocalBaseUrl(baseUrl);
const clientId = requireEnv("ODOS_MIGRATION_IMPORTER_CLIENT_ID");
const clientSecret = requireEnv("ODOS_MIGRATION_IMPORTER_CLIENT_SECRET");
const accessToken = await exchangeClientCredentials({
  baseUrl,
  clientId,
  clientSecret,
});
const attempts = new PgBinaryAttemptStore({ postgresUrl });
const scanner = new PgBinaryReferenceScanner({ postgresUrl });
try {
  const results = await sweepLegacyImportBinaries({
    attempts,
    scanner,
    auth: { baseUrl, accessToken },
    execute: process.argv.includes("--execute"),
  });
  console.log(JSON.stringify({
    mode: process.argv.includes("--execute") ? "execute" : "dry-run",
    openAttempts: results.length,
    results,
  }, null, 2));
} finally {
  await attempts.close();
  await scanner.close();
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function assertLocalBaseUrl(value: string): void {
  const url = new URL(value);
  if (!["localhost", "127.0.0.1", "::1", "medplum-server"].includes(url.hostname)) {
    throw new Error("Legacy-import Binary sweep is restricted to a local self-hosted Medplum.");
  }
}
