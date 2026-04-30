#!/usr/bin/env tsx
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createLiveOsodAuditRuntime } from "../mcp/src/authz/liveAudit.js";
import {
  OSOD_AUDIT_EVENT_TYPES,
  buildOsodAuditEventRow,
  type OsodAuditEventType,
} from "../mcp/src/authz/osodAudit.js";

loadRepoEnv();

const eventType = process.argv[2] as OsodAuditEventType | undefined;
if (!eventType || !OSOD_AUDIT_EVENT_TYPES.includes(eventType)) {
  throw new Error(`Usage: tsx scripts/record-audit-event.ts <event-type> [reason]`);
}

const reason = process.argv.slice(3).join(" ") || undefined;
const audit = createLiveOsodAuditRuntime({
  postgresUrl: process.env.OSOD_POSTGRES_URL,
  medplumBaseUrl: process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103",
  medplumAccessToken: process.env.OSOD_AUDIT_MEDPLUM_ACCESS_TOKEN ?? process.env.MEDPLUM_ACCESS_TOKEN,
  medplumEmail: process.env.OSOD_AUDIT_MEDPLUM_EMAIL ?? process.env.MEDPLUM_ADMIN_EMAIL,
  medplumPassword: process.env.OSOD_AUDIT_MEDPLUM_PASSWORD ?? process.env.MEDPLUM_ADMIN_PASSWORD,
});

await audit.record(
  buildOsodAuditEventRow({
    eventType,
    actorId: process.env.OSOD_AUDIT_ACTOR_ID ?? "osod-operator",
    actorRole: "system",
    actionOutcome: eventType.includes("failed") ? "denied" : "granted",
    actionReason: reason,
  }),
  () => undefined,
);
await audit.drainProjectionQueue();
await audit.close();

function loadRepoEnv(): void {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) {
    return;
  }

  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) {
      continue;
    }

    process.env[key] = stripEnvQuotes(rawValue.trim());
  }
}

function stripEnvQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
