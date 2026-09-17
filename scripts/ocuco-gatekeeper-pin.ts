#!/usr/bin/env tsx
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  requestOcucoGatekeeperPinCredentials,
  type OcucoGatekeeperPinCredentials,
  type OcucoGatekeeperPinRequest,
} from "../mcp/src/integrations/ocuco-gatekeeper/pinBootstrap.js";

export interface OcucoGatekeeperBootstrapInput extends OcucoGatekeeperPinRequest {
  envPath: string;
}

export async function bootstrapOcucoGatekeeperPin(input: OcucoGatekeeperBootstrapInput): Promise<void> {
  assertUnconfigured(readEnv(input.envPath), input.baseUrl);

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
  let settings: string;
  try {
    settings = renderEnvSettings(input.baseUrl, credentials.jwtKey, credentials.jwtSecret);
  } catch {
    const recovery = persistRecovery(JSON.stringify(credentials), credentials, temporaryPath, recoveryDirectory);
    throw new Error(`Ocuco Gatekeeper credentials could not be encoded for .env; they remain in private recovery file ${recovery}.`);
  }
  const recovery = persistRecovery(settings, credentials, temporaryPath, recoveryDirectory);
  if (recovery !== temporaryPath) {
    throw new Error(`Ocuco Gatekeeper credentials could not be staged for .env; they remain in private recovery file ${recovery}.`);
  }
  try {
    assertUnconfigured(readEnv(input.envPath), input.baseUrl);
    const fd = openSync(input.envPath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, 0o600);
    try {
      fchmodSync(fd, 0o600);
      writeFileSync(fd, `\n${settings}`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Read-back catches a filesystem write fault or external replacement after append; this synchronous section has no test interleaving.
    if (!readEnv(input.envPath).includes(settings)) {
      throw new Error("The env file changed while credentials were being saved.");
    }
  } catch {
    throw new Error(`Ocuco Gatekeeper credentials could not be installed; they remain in private recovery file ${temporaryPath}.`);
  }
  try {
    unlinkSync(temporaryPath);
  } catch {
    process.stderr.write(`WARNING: Ocuco Gatekeeper credentials were installed in ${input.envPath}, but recovery file ${temporaryPath} remains. Delete it by hand.\n`);
  }
}

function persistRecovery(
  contents: string,
  credentials: OcucoGatekeeperPinCredentials,
  temporaryPath: string,
  recoveryDirectory: string,
): string {
  try {
    writeFileSync(temporaryPath, contents, { mode: 0o600 });
    return temporaryPath;
  } catch {
    const alternatePath = join(recoveryDirectory, `ocuco-gatekeeper-${randomUUID()}.env`);
    try {
      writeFileSync(alternatePath, JSON.stringify(credentials), { flag: "wx", mode: 0o600 });
      return alternatePath;
    } catch {
      process.stderr.write(`WARNING: Ocuco Gatekeeper PIN was consumed, no recovery file could be written. Save these credentials from stderr now: ${JSON.stringify(credentials)}\n`);
      throw new Error("Ocuco Gatekeeper credentials were printed to stderr because no recovery file could be written.");
    }
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

function renderEnvSettings(baseUrl: string, jwtKey: string, jwtSecret: string): string {
  return [
    `OCUCO_GATEKEEPER_BASE_URL=${encodeEnvValue(baseUrl)}`,
    `OCUCO_GATEKEEPER_JWT_KEY=${encodeEnvValue(jwtKey)}`,
    `OCUCO_GATEKEEPER_JWT_SECRET=${encodeEnvValue(jwtSecret)}`,
    "",
  ].join("\n");
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
