#!/usr/bin/env tsx
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { exchangeClientCredentials } from "../data/medplum-adapters/migration-importer-adapter.js";
import { createOperatorScriptFhirClient } from "../mcp/src/fhir-client.js";
import {
  importLegacyCcda,
  LEGACY_CCDA_RESOURCE_TYPES,
  type LegacyCcdaImportResult,
} from "../mcp/src/legacy-import/ccda-import.js";
import { assertLocalBaseUrl } from "./setup-legacy-importer.js";

export async function runLegacyCcdaImportCli(input: {
  baseUrl: string;
  inputPath: string;
  ehrPatientId: string;
  clientId: string;
  clientSecret: string;
}): Promise<LegacyCcdaImportResult> {
  assertLocalBaseUrl(input.baseUrl);
  const accessToken = await exchangeClientCredentials({
    baseUrl: input.baseUrl,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
  });
  const fhir = createOperatorScriptFhirClient({
    baseUrl: input.baseUrl,
    accessToken,
    reason: "Operator legacy C-CDA import runs outside request handling.",
  });
  const projectId = await fhir.getActiveProjectId();
  return importLegacyCcda({
    fhir,
    projectId,
    ehrPatientId: input.ehrPatientId,
    documents: readLegacyCcdaInput(input.inputPath),
  });
}

export function readLegacyCcdaInput(inputPath: string): unknown {
  try {
    return JSON.parse(readFileSync(inputPath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read or parse C-CDA input ${inputPath}: ${detail}`, {
      cause: error,
    });
  }
}

export function formatLegacyCcdaReport(result: LegacyCcdaImportResult): string {
  const lines = [`patient=${result.patientReference}`];
  for (const resourceType of LEGACY_CCDA_RESOURCE_TYPES) {
    const counts = result.resources[resourceType];
    lines.push(
      `${resourceType} created=${counts.created} already_existed=${counts.skipped} `
      + `encounter_linked=${counts.encounterLinked} encounter_unlinked=${counts.encounterUnlinked}`,
    );
  }
  for (const nonMatch of result.encounterNonMatches) {
    lines.push(
      `encounter_non_match file=${JSON.stringify(nonMatch.file)} date=${nonMatch.date} `
      + `matches=${nonMatch.matchCount}`,
    );
  }
  lines.push(`provenance=${result.provenanceReference ?? "none-created"}`);
  return lines.join("\n");
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function positionalArguments(args: readonly string[]): {
  inputPath: string;
  ehrPatientId: string;
} {
  if (args.length !== 2 || !args[0]?.trim() || !args[1]?.trim()) {
    throw new Error(
      "Usage: import-legacy-ccda.ts <parsed-dedup.json> <ehr-patient-id>",
    );
  }
  return {
    inputPath: resolve(args[0]),
    ehrPatientId: args[1].trim(),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runLegacyCcdaImportCli({
      baseUrl: requireEnv("MEDPLUM_BASE_URL").replace(/\/$/, ""),
      ...positionalArguments(process.argv.slice(2)),
      clientId: requireEnv("ODOS_MIGRATION_IMPORTER_CLIENT_ID"),
      clientSecret: requireEnv("ODOS_MIGRATION_IMPORTER_CLIENT_SECRET"),
    });
    console.log(formatLegacyCcdaReport(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
