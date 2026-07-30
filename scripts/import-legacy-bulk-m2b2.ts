#!/usr/bin/env tsx
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Patient } from "@medplum/fhirtypes";
import { exchangeClientCredentials } from "../data/medplum-adapters/migration-importer-adapter.js";
import { createMedplumClient } from "../mcp/src/fhir-client.js";
import { applyDecisionFile, listPendingDecisions } from "../mcp/src/legacy-import/adjudication-loop.js";
import {
  appointmentEncounterImportManifestSchema,
  importLegacyAppointmentsAndEncounters,
} from "../mcp/src/legacy-import/appointment-encounter-import.js";
import {
  legacyVisitBulkManifestSchema,
  runLegacyVisitBulk,
  type LegacyVisitBulkFileChart,
  type LegacyVisitBulkChartResult,
} from "../mcp/src/legacy-import/bulk-visit-import.js";
import {
  DEFAULT_M2A_STATE_DIR,
  ImportLedger,
} from "../mcp/src/legacy-import/import-ledger.js";
import {
  EHR_PATIENT_IDENTIFIER_SYSTEM,
  EPM_PATIENT_IDENTIFIER_SYSTEM,
} from "../mcp/src/legacy-import/patient-import.js";
import { assertLocalBaseUrl } from "./setup-legacy-importer.js";

const DEFAULT_BASE_URL = "http://localhost:8103";

export async function runBulkImportCli(input: {
  readonly baseUrl: string;
  readonly bulkManifestPath: string;
  readonly stateDirectory: string;
  readonly runId?: string;
  readonly decisionsPath?: string;
  readonly clientId: string;
  readonly clientSecret: string;
}): Promise<{
  readonly runId: string;
  readonly reportPath: string;
  readonly charts: readonly LegacyVisitBulkChartResult[];
}> {
  assertLocalBaseUrl(input.baseUrl);
  const bulkDirectory = dirname(input.bulkManifestPath);
  const bulk = legacyVisitBulkManifestSchema.parse(
    JSON.parse(readFileSync(input.bulkManifestPath, "utf8")),
  );
  const charts = bulk.charts.map((chart) => ({
    ...chart,
    manifestPath: resolve(bulkDirectory, chart.manifestPath),
    appointmentsPath: resolve(bulkDirectory, chart.appointmentsPath),
    examsPath: resolve(bulkDirectory, chart.examsPath),
  }));
  const accessToken = await exchangeClientCredentials({
    baseUrl: input.baseUrl,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
  });
  const fhir = createMedplumClient({ baseUrl: input.baseUrl, accessToken });
  const projectId = await fhir.getActiveProjectId();
  const ledger = new ImportLedger({ stateDirectory: input.stateDirectory });

  try {
    if (input.decisionsPath) {
      applyDecisionFile(
        ledger,
        JSON.parse(readFileSync(input.decisionsPath, "utf8")),
      );
    }
    return await runLegacyVisitBulk({
      ledger,
      runId: input.runId ?? `m2b2-bulk-${randomUUID()}`,
      charts,
      runChart: async (chart: LegacyVisitBulkFileChart, runId) => {
        const manifest = appointmentEncounterImportManifestSchema.parse(
          JSON.parse(readFileSync(chart.manifestPath, "utf8")),
        );
        const patient = await fhir.read<Patient>(
          "Patient",
          manifest.patientReference.slice("Patient/".length),
        );
        assertPatientIdentifiers(patient, manifest.epmPatientId, manifest.ehrPatientId);
        const result = await importLegacyAppointmentsAndEncounters({
          fhir,
          ledger,
          runId,
          projectId,
          manifest,
          appointmentsCsv: readFileSync(chart.appointmentsPath, "utf8"),
          examsTsv: readFileSync(chart.examsPath, "utf8"),
        });
        const conflicts =
          result.appointments.conflict
          + result.encounters.conflict
          + result.practitioners.conflict
          + listPendingDecisions(ledger, { runId }).length;
        return { conflicts };
      },
    });
  } finally {
    ledger.close();
  }
}

function assertPatientIdentifiers(
  patient: Patient,
  epmPatientId: string,
  ehrPatientId: string,
): void {
  if (!patient.identifier?.some(
    (identifier) =>
      identifier.system === EPM_PATIENT_IDENTIFIER_SYSTEM
      && identifier.value === epmPatientId,
  )) {
    throw new Error("The selected Patient does not carry the manifest EPM patient identifier.");
  }
  if (!patient.identifier?.some(
    (identifier) =>
      identifier.system === EHR_PATIENT_IDENTIFIER_SYSTEM
      && identifier.value === ehrPatientId,
  )) {
    throw new Error("The selected Patient does not carry the manifest EHR patient identifier.");
  }
}

function cliArguments(args: readonly string[]): {
  bulkManifestPath: string;
  stateDirectory: string;
  runId?: string;
  decisionsPath?: string;
} {
  const decisionsPath = optionalArgument(args, "--decisions");
  return {
    bulkManifestPath: resolve(requiredArgument(args, "--bulk-manifest")),
    stateDirectory: resolve(optionalArgument(args, "--state-dir") ?? DEFAULT_M2A_STATE_DIR),
    ...(optionalArgument(args, "--run-id")
      ? { runId: optionalArgument(args, "--run-id") }
      : {}),
    ...(decisionsPath ? { decisionsPath: resolve(decisionsPath) } : {}),
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
    const result = await runBulkImportCli({
      baseUrl: (process.env.MEDPLUM_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, ""),
      ...cliArguments(process.argv.slice(2)),
      clientId: requireEnv("ODOS_MIGRATION_IMPORTER_CLIENT_ID"),
      clientSecret: requireEnv("ODOS_MIGRATION_IMPORTER_CLIENT_SECRET"),
    });
    const completed = result.charts.filter((chart) => chart.status === "completed").length;
    const conflicted = result.charts.filter((chart) => chart.status === "conflict").length;
    const failed = result.charts.filter((chart) => chart.status === "failed").length;
    console.log(
      `M2B2 bulk run=${result.runId} completed=${completed} conflict=${conflicted} `
      + `failed=${failed} report=${result.reportPath}`,
    );
    for (const chart of result.charts) {
      console.log(
        `chart=${chart.chartKey} status=${chart.status} run=${chart.runId} report=${chart.reportPath}`,
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
