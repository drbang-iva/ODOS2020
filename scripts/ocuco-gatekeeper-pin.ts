#!/usr/bin/env tsx
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  requestOcucoGatekeeperPinCredentials,
  type OcucoGatekeeperPinRequest,
} from "../mcp/src/integrations/ocuco-gatekeeper/pinBootstrap.js";

export interface OcucoGatekeeperBootstrapInput extends OcucoGatekeeperPinRequest {
  envPath: string;
}

export async function bootstrapOcucoGatekeeperPin(input: OcucoGatekeeperBootstrapInput): Promise<void> {
  const original = readEnv(input.envPath);
  assertUnconfigured(original, input.baseUrl);

  const recoveryDirectory = join(dirname(input.envPath), ".odos");
  mkdirSync(recoveryDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(recoveryDirectory, `ocuco-gatekeeper-${randomUUID()}.env`);
  writeFileSync(temporaryPath, "", { flag: "wx", mode: 0o600 });

  let credentials;
  try {
    credentials = await requestOcucoGatekeeperPinCredentials(input);
  } catch (error) {
    unlinkSync(temporaryPath);
    throw error;
  }
  let saved: string;
  try {
    saved = updateEnv(original, input.baseUrl, credentials.jwtKey, credentials.jwtSecret);
  } catch {
    writeFileSync(temporaryPath, JSON.stringify(credentials), { mode: 0o600 });
    throw new Error(`Ocuco Gatekeeper credentials could not be encoded for .env; they remain in private recovery file ${temporaryPath}.`);
  }
  writeFileSync(temporaryPath, saved, { mode: 0o600 });
  if (readEnv(input.envPath) !== original) {
    throw new Error(`Ocuco Gatekeeper .env changed during the PIN exchange; credentials remain in private recovery file ${temporaryPath}.`);
  }
  try {
    renameSync(temporaryPath, input.envPath);
  } catch {
    throw new Error(`Ocuco Gatekeeper credentials could not be installed; they remain in private recovery file ${temporaryPath}.`);
  }
  if ((statSync(input.envPath).mode & 0o777) !== 0o600) {
    throw new Error("Ocuco Gatekeeper credential file permissions are not private.");
  }
}

function readEnv(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function assertUnconfigured(content: string, baseUrl: string): void {
  for (const name of ["OCUCO_GATEKEEPER_JWT_KEY", "OCUCO_GATEKEEPER_JWT_SECRET"]) {
    const values = envValues(content, name);
    if (values.length > 1 || values.some((value) => value.trim().replace(/^['"]|['"]$/g, ""))) {
      throw new Error(`Ocuco Gatekeeper ${name} is already configured; the one-time PIN was not used.`);
    }
  }
  const storedBaseUrls = envValues(content, "OCUCO_GATEKEEPER_BASE_URL");
  if (storedBaseUrls.length > 1 || (storedBaseUrls[0]?.trim()
    && storedBaseUrls[0].trim().replace(/^['"]|['"]$/g, "").replace(/\/$/, "") !== baseUrl.replace(/\/$/, ""))) {
    throw new Error("Ocuco Gatekeeper .env base URL differs from the bootstrap URL; the one-time PIN was not used.");
  }
}

function envValues(content: string, name: string): string[] {
  return content.split(/\r?\n/)
    .map((line) => line.match(new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=(.*)$`))?.[1])
    .filter((value): value is string => value !== undefined);
}

function updateEnv(content: string, baseUrl: string, jwtKey: string, jwtSecret: string): string {
  const lines = content ? content.replace(/\n$/, "").split(/\r?\n/) : [];
  const settings = new Map([
    ["OCUCO_GATEKEEPER_BASE_URL", encodeEnvValue(baseUrl)],
    ["OCUCO_GATEKEEPER_JWT_KEY", encodeEnvValue(jwtKey)],
    ["OCUCO_GATEKEEPER_JWT_SECRET", encodeEnvValue(jwtSecret)],
  ]);
  for (let index = 0; index < lines.length; index += 1) {
    const name = lines[index].match(/^\s*(?:export\s+)?(OCUCO_GATEKEEPER_(?:BASE_URL|JWT_KEY|JWT_SECRET))\s*=/)?.[1];
    if (!name) continue;
    if (settings.has(name)) {
      lines[index] = `${name}=${settings.get(name)}`;
      settings.delete(name);
    }
  }
  for (const [name, value] of settings) lines.push(`${name}=${value}`);
  return `${lines.join("\n")}\n`;
}

function encodeEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./+=:@%-]+$/.test(value)) return value;
  if (!value || /['\x00-\x1f\x7f]/.test(value)) {
    throw new Error("Ocuco Gatekeeper returned a credential that cannot be safely stored in .env.");
  }
  return `'${value}'`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--lab-id") {
    throw new Error("Usage: npm run bootstrap:ocuco-gatekeeper -- --lab-id <webrx_lab_id>");
  }
  if (process.env.OCUCO_GATEKEEPER_JWT_KEY?.trim()
    || process.env.OCUCO_GATEKEEPER_JWT_SECRET?.trim()) {
    throw new Error("Ocuco Gatekeeper JWT credentials are already present in the environment; the one-time PIN was not used.");
  }
  const labId = Number(args[1]);
  await bootstrapOcucoGatekeeperPin({
    baseUrl: process.env.OCUCO_GATEKEEPER_BASE_URL ?? "",
    webrxLabId: labId,
    pinCode: process.env.OCUCO_GATEKEEPER_PIN ?? "",
    envPath: resolve(".env"),
  });
  process.stdout.write("Ocuco Gatekeeper JWT credentials saved to the private root .env file.\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Ocuco Gatekeeper bootstrap failed."}\n`);
    process.exitCode = 1;
  });
}
