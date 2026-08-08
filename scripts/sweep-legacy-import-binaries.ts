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
  ?? "postgresql://medplum:medplum@127.0.0.1:5433/medplum";
assertLocalBaseUrl(baseUrl);
const execute = process.argv.includes("--execute");
if (execute && process.env.ODOS_SWEEP_ALLOW_DESTRUCTIVE !== "1") {
  throw new Error(
    "Refusing Binary disposal. This would delete unreferenced Binary metadata/storage. "
    + "Stop all legacy import workers, review a dry run, then set ODOS_SWEEP_ALLOW_DESTRUCTIVE=1.",
  );
}
if (execute) {
  console.error(
    "DESTRUCTIVE MODE: legacy import workers must remain stopped; each Binary is rechecked immediately before DELETE.",
  );
}
const binaryIds = process.argv
  .filter((argument) => argument.startsWith("--binary-id="))
  .map((argument) => argument.slice("--binary-id=".length));
for (const binaryId of binaryIds) assertUuid(binaryId);
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
    execute,
    ...(binaryIds.length > 0 ? { binaryIds } : {}),
  });
  console.log(JSON.stringify({
    mode: execute ? "execute" : "dry-run",
    concurrentImportSafe: false,
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

function assertUuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`Expected Binary UUID; received ${value}.`);
  }
}
