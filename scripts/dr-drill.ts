#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const project = process.env.OSOD_DR_COMPOSE_PROJECT ?? "osod-dr-drill";
const composeFile = process.env.OSOD_DR_COMPOSE_FILE ?? "docker-compose.dr-drill.yml";
const backupDir = resolve(process.env.OSOD_BACKUP_DIR ?? "backup-dr-drill");
const framesBackupDir = resolve(process.env.OSOD_V06A_DR_BACKUP_DIR ?? "backup-dr-drill-v06a");
const timestamp = process.env.OSOD_BACKUP_TIMESTAMP ?? new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const manifestPath = resolve(backupDir, `manifest-${timestamp}.json`);

const drillEnv = {
  ...process.env,
  MEDPLUM_BASE_URL: process.env.MEDPLUM_BASE_URL ?? "http://localhost:18103",
  OSOD_POSTGRES_URL:
    process.env.OSOD_POSTGRES_URL ?? "postgresql://medplum:medplum@127.0.0.1:15432/medplum",
  OSOD_REDIS_PORT: process.env.OSOD_REDIS_PORT ?? "16379",
  OSOD_REDIS_PASSWORD: process.env.OSOD_REDIS_PASSWORD ?? "medplum",
  OSOD_COMPOSE_PROJECT: project,
  OSOD_COMPOSE_FILE: composeFile,
  OSOD_BACKUP_DIR: backupDir,
  OSOD_BACKUP_TIMESTAMP: timestamp,
  OSOD_V06A_DR_BACKUP_DIR: framesBackupDir,
  MEDPLUM_ADMIN_EMAIL: process.env.MEDPLUM_ADMIN_EMAIL ?? "drill-admin@osod.local",
  MEDPLUM_ADMIN_PASSWORD: process.env.MEDPLUM_ADMIN_PASSWORD ?? "Osod-dr-drill-Password-1!",
};

mkdirSync(backupDir, { recursive: true });
mkdirSync(framesBackupDir, { recursive: true });

try {
  console.log("OSOD DR drill: broad isolated restore + v0.6a frames integrity");
  console.log(`compose project: ${project}`);
  console.log(`backup manifest: ${manifestPath}`);

  runCompose("reset isolated drill stack", ["down", "-v"]);
  runCompose("start isolated drill stack", ["up", "-d"]);
  run("seed broad audit/Provenance/Binary/AccessPolicy fixtures", "npx", ["tsx", "scripts/seed-dr-drill.ts"]);
  run("backup isolated drill stack", "scripts/backup.sh", []);
  runCompose("destroy isolated drill stack after backup", ["down", "-v"]);
  runCompose("start empty isolated drill stack for restore", ["up", "-d"]);
  run("restore isolated drill stack", "scripts/restore.sh", [manifestPath]);
  run("post-restore broad fixtures", "node", [
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=1",
    "tests/v05b-audit-ib-backup.test.ts",
    "../tests/boundaries/mandate-8-auth-flow.test.ts",
  ], resolve("mcp"));

  runCompose("reset isolated stack before v0.6a frames drill", ["down", "-v"]);
  runCompose("start isolated Postgres for v0.6a frames drill", ["up", "-d", "postgres"]);
  await waitForPostgres();
  run("v0.6a frames DR drill", "npx", ["tsx", "scripts/v06a-frames-dr-drill.ts"]);

  console.log("\nDR drill complete.");
  console.log("Broad restore integrity printed 5 PASS checks.");
  console.log("v0.6a frames drill printed canonicalChecks 32/32 and tableIntegrity 5/5.");
} finally {
  if (process.env.OSOD_DR_KEEP_STACK !== "true") {
    runCompose("cleanup isolated drill stack", ["down", "-v"], { allowFailure: true });
  }
}

function runCompose(label: string, args: string[], options: { allowFailure?: boolean } = {}): void {
  const compose = composeCommand();
  run(label, compose.command, [...compose.args, ...args], process.cwd(), options);
}

function composeCommand(): { command: string; args: string[] } {
  if (hasCommand("docker-compose")) {
    return { command: "docker-compose", args: ["-p", project, "-f", composeFile] };
  }
  return { command: "docker", args: ["compose", "-p", project, "-f", composeFile] };
}

function hasCommand(command: string): boolean {
  try {
    execFileSync("which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function waitForPostgres(): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      execFileSync("psql", [drillEnv.OSOD_POSTGRES_URL, "-Atc", "select 1"], {
        env: drillEnv,
        stdio: "ignore",
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  throw new Error(`Timed out waiting for Postgres at ${drillEnv.OSOD_POSTGRES_URL}.`);
}

function run(
  label: string,
  command: string,
  args: string[],
  cwd = process.cwd(),
  options: { allowFailure?: boolean } = {},
): void {
  console.log(`\n== ${label} ==`);
  try {
    execFileSync(command, args, {
      cwd,
      env: drillEnv,
      stdio: "inherit",
    });
  } catch (error) {
    if (options.allowFailure) {
      return;
    }
    throw error;
  }
}
