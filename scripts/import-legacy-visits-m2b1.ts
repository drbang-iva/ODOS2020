#!/usr/bin/env tsx
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Patient } from "@medplum/fhirtypes";
import { exchangeClientCredentials } from "../data/medplum-adapters/migration-importer-adapter.js";
import { createMedplumClient } from "../mcp/src/fhir-client.js";
import {
  appointmentEncounterImportManifestSchema,
  importLegacyAppointmentsAndEncounters,
} from "../mcp/src/legacy-import/appointment-encounter-import.js";
import {
  DEFAULT_M2A_STATE_DIR,
  ImportLedger,
} from "../mcp/src/legacy-import/import-ledger.js";
import { EPM_PATIENT_IDENTIFIER_SYSTEM } from "../mcp/src/legacy-import/patient-import.js";
import { assertLocalMedplumBaseUrl } from "./reseed-practice-role-tags.js";

const DEFAULT_BASE_URL = "http://localhost:8103";

export async function runVisitImportCli(input: {
  readonly baseUrl: string;
  readonly manifestPath: string;
  readonly appointmentsPath: string;
  readonly examsPath: string;
  readonly stateDirectory: string;
  readonly runId?: string;
  readonly clientId: string;
  readonly clientSecret: string;
}): Promise<{
  readonly runId: string;
  readonly reportPath: string;
  readonly result: Awaited<ReturnType<typeof importLegacyAppointmentsAndEncounters>>;
}> {
  assertLocalMedplumBaseUrl(input.baseUrl);
  const manifest = appointmentEncounterImportManifestSchema.parse(
    JSON.parse(readFileSync(input.manifestPath, "utf8")),
  );
  const accessToken = await exchangeClientCredentials({
    baseUrl: input.baseUrl,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
  });
  const fhir = createMedplumClient({ baseUrl: input.baseUrl, accessToken });
  const projectId = await fhir.getActiveProjectId();
  const patientId = manifest.patientReference.slice("Patient/".length);
  const patient = await fhir.read<Patient>("Patient", patientId);
  if (!patient.identifier?.some(
    (identifier) =>
      identifier.system === EPM_PATIENT_IDENTIFIER_SYSTEM
      && identifier.value === manifest.epmPatientId,
  )) {
    throw new Error("The selected Patient does not carry the manifest EPM patient identifier.");
  }

  const ledger = new ImportLedger({ stateDirectory: input.stateDirectory });
  try {
    const runId = ledger.startRun(input.runId ?? `m2b1-${randomUUID()}`);
    try {
      const result = await importLegacyAppointmentsAndEncounters({
        fhir,
        ledger,
        runId,
        projectId,
        manifest,
        appointmentsCsv: readFileSync(input.appointmentsPath, "utf8"),
        examsTsv: readFileSync(input.examsPath, "utf8"),
      });
      ledger.finishRun(runId, "completed");
      return {
        runId,
        result,
        reportPath: ledger.writeReport(runId),
      };
    } catch (error) {
      try {
        ledger.finishRun(runId, "failed");
      } catch (bookkeepingError) {
        console.error(`Failed to mark M2b-1 run as failed: ${String(bookkeepingError)}`);
      }
      try {
        ledger.writeReport(runId);
      } catch (bookkeepingError) {
        console.error(`Failed to write the M2b-1 failure report: ${String(bookkeepingError)}`);
      }
      throw error;
    }
  } finally {
    ledger.close();
  }
}

function cliArguments(args: readonly string[]): {
  manifestPath: string;
  appointmentsPath: string;
  examsPath: string;
  stateDirectory: string;
  runId?: string;
} {
  return {
    manifestPath: resolve(requiredArgument(args, "--manifest")),
    appointmentsPath: resolve(requiredArgument(args, "--appointments")),
    examsPath: resolve(requiredArgument(args, "--exams")),
    stateDirectory: resolve(optionalArgument(args, "--state-dir") ?? DEFAULT_M2A_STATE_DIR),
    runId: optionalArgument(args, "--run-id"),
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
    const result = await runVisitImportCli({
      baseUrl: (process.env.MEDPLUM_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, ""),
      ...cliArguments(process.argv.slice(2)),
      clientId: requireEnv("ODOS_MIGRATION_IMPORTER_CLIENT_ID"),
      clientSecret: requireEnv("ODOS_MIGRATION_IMPORTER_CLIENT_SECRET"),
    });
    const analysis = result.result.analysis;
    console.log(
      `M2B1 run=${result.runId} rows=${analysis.sourceRows} exact_duplicates=${analysis.exactDuplicates} `
      + `post_dedupe=${analysis.rowsAfterExactDedupe} collision_groups=${analysis.collisionGroups} `
      + `collision_rows=${analysis.collisionRows} cancel_resolved=${analysis.resolvedCancelGroups} `
      + `all_cancelled_skipped=${analysis.allCancelledSkipped} `
      + `queued_collisions=${analysis.ambiguousCollisionGroups}`,
    );
    console.log(
      `appointments=${JSON.stringify(result.result.appointments)} `
      + `encounters=${JSON.stringify(result.result.encounters)} `
      + `practitioners=${JSON.stringify(result.result.practitioners)} `
      + `visit_days=${result.result.visitDays} report=${result.reportPath}`,
    );
  } catch (error) {
    const status = (error as { status?: number }).status;
    const suffix = status === 412
      ? " A matched resource changed during import; rerun with a new M2a run to re-evaluate current state."
      : "";
    console.error(`${error instanceof Error ? error.message : String(error)}${suffix}`);
    process.exitCode = 1;
  }
}
