#!/usr/bin/env tsx
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { exchangeClientCredentials } from "../data/medplum-adapters/migration-importer-adapter.js";
import { createOperatorScriptFhirClient } from "../mcp/src/fhir-client.js";
import {
  DEFAULT_M2A_STATE_DIR,
  ImportLedger,
} from "../mcp/src/legacy-import/import-ledger.js";
import {
  importLegacyPatient,
  patientImportManifestSchema,
} from "../mcp/src/legacy-import/patient-import.js";
import { assertLocalMedplumBaseUrl } from "./reseed-practice-role-tags.js";

const DEFAULT_BASE_URL = "http://localhost:8103";

export async function runPatientImportCli(input: {
  readonly baseUrl: string;
  readonly manifestPath: string;
  readonly stateDirectory: string;
  readonly runId?: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly allowOperatorTestDataChart?: boolean;
}): Promise<{
  readonly runId: string;
  readonly action: string;
  readonly patientReference?: string;
  readonly junkRejections: number;
  readonly reportPath: string;
}> {
  assertLocalMedplumBaseUrl(input.baseUrl);
  const manifest = patientImportManifestSchema.parse(
    JSON.parse(readFileSync(input.manifestPath, "utf8")),
  );
  const accessToken = await exchangeClientCredentials({
    baseUrl: input.baseUrl,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
  });
  const fhir = createOperatorScriptFhirClient({
    baseUrl: input.baseUrl,
    accessToken,
    reason: "Operator legacy patient import runs outside request handling.",
  });
  const projectId = await fhir.getActiveProjectId();
  const ledger = new ImportLedger({ stateDirectory: input.stateDirectory });
  try {
    const runId = ledger.startRun(input.runId);
    try {
      const result = await importLegacyPatient({
        fhir,
        ledger,
        runId,
        projectId,
        manifest,
        allowOperatorTestDataChart: input.allowOperatorTestDataChart,
      });
      if (result.action === "conflict") {
        throw new Error(`Patient source ${result.sourceKey} requires adjudication; no write was made.`);
      }
      ledger.finishRun(runId, "patient-imported");
      const reportPath = ledger.writeReport(runId);
      return {
        runId,
        action: result.action,
        patientReference: result.patientReference,
        junkRejections: result.junkRejections,
        reportPath,
      };
    } catch (error) {
      ledger.finishRun(runId, "failed");
      ledger.writeReport(runId);
      throw error;
    }
  } finally {
    ledger.close();
  }
}

export function parsePatientImportCliArguments(args: readonly string[]): {
  manifestPath: string;
  stateDirectory: string;
  runId?: string;
  allowOperatorTestDataChart: boolean;
} {
  const manifestPath = requiredArgument(args, "--manifest");
  const stateDirectory = optionalArgument(args, "--state-dir") ?? DEFAULT_M2A_STATE_DIR;
  return {
    manifestPath: resolve(manifestPath),
    stateDirectory: resolve(stateDirectory),
    runId: optionalArgument(args, "--run-id"),
    allowOperatorTestDataChart: args.includes("--allow-operator-test-data-chart"),
  };
}

function requiredArgument(args: readonly string[], name: string): string {
  const value = optionalArgument(args, name);
  if (!value) throw new Error(`${name} requires a value.`);
  return value;
}

function optionalArgument(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1]?.trim() : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parsePatientImportCliArguments(process.argv.slice(2));
    const result = await runPatientImportCli({
      baseUrl: (process.env.MEDPLUM_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, ""),
      ...args,
      clientId: requireEnv("ODOS_MIGRATION_IMPORTER_CLIENT_ID"),
      clientSecret: requireEnv("ODOS_MIGRATION_IMPORTER_CLIENT_SECRET"),
    });
    console.log(
      `M2A patient run=${result.runId} action=${result.action} `
      + `patient=${result.patientReference ?? "none"} junk_rejections=${result.junkRejections} `
      + `report=${result.reportPath}`,
    );
  } catch (error) {
    const status = (error as { status?: number }).status;
    const suffix = status === 412
      ? " The Patient changed during import; rerun to re-evaluate current state."
      : "";
    console.error(`${error instanceof Error ? error.message : String(error)}${suffix}`);
    process.exitCode = 1;
  }
}
