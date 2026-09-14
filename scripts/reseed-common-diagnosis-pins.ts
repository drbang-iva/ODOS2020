#!/usr/bin/env tsx
import type { Basic } from "@medplum/fhirtypes";
import { pathToFileURL } from "node:url";
import { createOperatorScriptFhirClient } from "../mcp/src/fhir-client.js";
import { searchAll, type FhirSearchClient } from "../mcp/src/fhir-search.js";
import { FhirDiagnosisCatalogStore } from "../mcp/src/clinical-graph/diagnosis-catalog-store.js";
import { resolveStarterDiagnosisPins } from "../mcp/src/clinical-graph/diagnosis-quick-list-endpoint.js";
import {
  buildDiagnosisPickTallyResource,
  DX_PICK_TALLY_CODE,
  DX_PICK_TALLY_CODE_SYSTEM,
  DX_PICK_TALLY_IDENTIFIER_SYSTEM,
  DX_PICK_TALLY_WRITE_HEADERS,
  parseDiagnosisPickTallyResource,
  withStarterDiagnosisPins,
  type DiagnosisPickTallyFhirClient,
} from "../mcp/src/clinical-graph/diagnosis-pick-tally-store.js";
import { assertLocalMedplumBaseUrl, resolvePracticeRoleTagReseedCredentials } from "./reseed-practice-role-tags.js";

export async function reseedCommonDiagnosisPins(
  fhir: DiagnosisPickTallyFhirClient & FhirSearchClient,
  options: { apply?: boolean; now?: string } = {},
) {
  const starter = resolveStarterDiagnosisPins(await new FhirDiagnosisCatalogStore(fhir).list());
  const resources = await searchAll<Basic>(fhir, "Basic", {
    code: `${DX_PICK_TALLY_CODE_SYSTEM}|${DX_PICK_TALLY_CODE}`,
  });
  const changes: Array<{
    recordReference: string;
    practitionerReference: string;
    action: "would-seed" | "seeded";
    pinnedDiagnosisKeys: string[];
  }> = [];
  const conflicts: Array<{ recordReference: string; reason: string }> = [];
  let skipped = 0;
  for (const resource of resources) {
    const row = parseDiagnosisPickTallyResource(resource);
    if (row.pinState !== undefined || row.pinnedDiagnosisKeys.length !== 0) {
      skipped += 1;
      continue;
    }
    const practitionerReference = resource.identifier!.find((entry) => entry.system === DX_PICK_TALLY_IDENTIFIER_SYSTEM)!.value!;
    const recordReference = `Basic/${resource.id ?? "unknown"}`;
    if (!resource.id || !resource.meta?.versionId) {
      conflicts.push({ recordReference, reason: "Missing id or version; no safe conditional write possible." });
      continue;
    }
    if (options.apply) {
      const next = withStarterDiagnosisPins(row, starter.pinnedDiagnosisKeys, options.now ?? new Date().toISOString());
      try {
        await fhir.update("Basic", resource.id, buildDiagnosisPickTallyResource(practitionerReference, next, resource), {
          ...DX_PICK_TALLY_WRITE_HEADERS,
          "If-Match": `W/"${resource.meta.versionId}"`,
        });
      } catch (error) {
        if ((error as { status?: number }).status !== 412) throw error;
        conflicts.push({ recordReference, reason: "Tally changed after search; rerun to reassess." });
        continue;
      }
    }
    changes.push({ recordReference, practitionerReference, action: options.apply ? "seeded" : "would-seed", pinnedDiagnosisKeys: starter.pinnedDiagnosisKeys });
  }
  return { mode: options.apply ? "apply" : "dry-run", changes, skipped, conflicts, missingStarter: starter.missing, exitCode: conflicts.length ? 1 : 0 };
}

async function runCli(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--apply")) throw new Error("Usage: npm run reseed-common-diagnosis-pins -- [--apply]. Default: dry run.");
  const baseUrl = process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103";
  assertLocalMedplumBaseUrl(baseUrl);
  const credentials = resolvePracticeRoleTagReseedCredentials({
    accessToken: process.env.MEDPLUM_ACCESS_TOKEN,
    adminEmail: process.env.MEDPLUM_ADMIN_EMAIL,
    adminPassword: process.env.MEDPLUM_ADMIN_PASSWORD,
  });
  const fhir = createOperatorScriptFhirClient({
    baseUrl,
    ...(credentials.source === "access-token" ? { accessToken: credentials.accessToken } : {}),
    reason: "Operator Common diagnosis starter reseed runs outside request handling.",
  });
  if (credentials.source === "admin-login") await fhir.login(credentials.adminEmail, credentials.adminPassword);
  const result = await reseedCommonDiagnosisPins(fhir, { apply: args.includes("--apply") });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
