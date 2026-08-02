#!/usr/bin/env tsx
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { exchangeClientCredentials } from "../data/medplum-adapters/migration-importer-adapter.js";
import { createOperatorScriptFhirClient } from "../mcp/src/fhir-client.js";
import {
  importLegacyVisitDocumentsForPid,
  type LegacyVisitDocumentPidResult,
  type LegacyVisitDocumentSource,
  type LegacyVisitDocumentType,
} from "../mcp/src/legacy-import/visit-document-import.js";
import { assertLocalBaseUrl } from "./setup-legacy-importer.js";

export async function runLegacyVisitDocumentImportCli(input: {
  readonly baseUrl: string;
  readonly archiveRoot: string;
  readonly clientId: string;
  readonly clientSecret: string;
}): Promise<LegacyVisitDocumentPidResult[]> {
  assertLocalBaseUrl(input.baseUrl);
  const accessToken = await exchangeClientCredentials({
    baseUrl: input.baseUrl,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
  });
  const fhir = createOperatorScriptFhirClient({
    baseUrl: input.baseUrl,
    accessToken,
    reason: "Operator legacy per-visit document import runs outside request handling.",
  });
  const projectId = await fhir.getActiveProjectId();
  const groups = await discoverLegacyVisitDocumentSources(input.archiveRoot);
  return importLegacyVisitDocumentGroups({
    groups,
    importPid: (pid, sources) => importLegacyVisitDocumentsForPid({
      fhir,
      projectId,
      pid,
      sources,
      auth: { baseUrl: input.baseUrl, accessToken },
    }),
    onFailure: (pid, error) => {
      console.error(
        `pid=${pid} import failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });
}

export async function importLegacyVisitDocumentGroups(input: {
  readonly groups: ReadonlyMap<string, readonly LegacyVisitDocumentSource[]>;
  readonly importPid: (
    pid: string,
    sources: readonly LegacyVisitDocumentSource[],
  ) => Promise<LegacyVisitDocumentPidResult>;
  readonly onFailure: (pid: string, error: unknown) => void;
}): Promise<LegacyVisitDocumentPidResult[]> {
  const results: LegacyVisitDocumentPidResult[] = [];
  for (const [pid, sources] of input.groups) {
    try {
      results.push(await input.importPid(pid, sources));
    } catch (error) {
      input.onFailure(pid, error);
    }
  }
  return results;
}

export async function discoverLegacyVisitDocumentSources(
  archiveRoot: string,
): Promise<Map<string, LegacyVisitDocumentSource[]>> {
  const groups = new Map<string, LegacyVisitDocumentSource[]>();
  const seen = new Set<string>();
  const batches = (await readdir(archiveRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^g\d+$/.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const batch of batches) {
    const batchPath = join(archiveRoot, batch.name);
    const patients = (await readdir(batchPath, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const patient of patients) {
      const notesPath = join(batchPath, patient.name, "notes");
      let encounters;
      try {
        encounters = await readdir(notesPath, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const encounter of encounters
        .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
        .sort((left, right) => left.name.localeCompare(right.name))) {
        const encounterPath = join(notesPath, encounter.name);
        const files = (await readdir(encounterPath, { withFileTypes: true }))
          .filter((entry) => entry.isFile())
          .sort((left, right) => left.name.localeCompare(right.name));
        for (const file of files) {
          const documentType = documentTypeOf(file.name);
          if (!documentType) continue;
          const key = `${patient.name}|${encounter.name}|${documentType}`;
          if (seen.has(key)) {
            throw new Error(`Duplicate legacy visit document key ${key}.`);
          }
          seen.add(key);
          const filePath = join(encounterPath, file.name);
          const source: LegacyVisitDocumentSource = {
            pid: patient.name,
            encounterId: encounter.name,
            documentType,
            fileName: file.name,
            readBytes: async () => new Uint8Array(await readFile(filePath)),
          };
          const patientSources = groups.get(patient.name) ?? [];
          patientSources.push(source);
          groups.set(patient.name, patientSources);
        }
      }
    }
  }
  return new Map([...groups.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

export function formatLegacyVisitDocumentReport(
  results: readonly LegacyVisitDocumentPidResult[],
): string {
  const lines: string[] = [];
  for (const result of results) {
    if (result.action === "skipped-patient") {
      lines.push(`pid=${result.pid} skipped patient_matches=${result.patientMatchCount}`);
      continue;
    }
    const created = result.documents.filter((document) => document.action === "created").length;
    const existing = result.documents.filter(
      (document) => document.action === "already-imported"
    ).length;
    lines.push(
      `pid=${result.pid} patient=${result.patientReference} created=${created} `
      + `already_imported=${existing}`,
    );
    for (const nonMatch of result.encounterNonMatches) {
      lines.push(
        `encounter_non_match pid=${result.pid} file=${JSON.stringify(nonMatch.fileName)} `
        + `date=${nonMatch.date} matches=${nonMatch.matchCount}`,
      );
    }
  }
  return lines.join("\n");
}

function documentTypeOf(fileName: string): LegacyVisitDocumentType | undefined {
  if (fileName.endsWith("_Encounter_Final.pdf")) return "Encounter";
  if (fileName.endsWith("_Visit_Final.pdf")) return "Visit";
  return undefined;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function positionalArchiveRoot(args: readonly string[]): string {
  if (args.length !== 1 || !args[0]?.trim()) {
    throw new Error(
      "Usage: import-legacy-visit-documents.ts <Edocs/full_extract_tmp>",
    );
  }
  return resolve(args[0]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const results = await runLegacyVisitDocumentImportCli({
      baseUrl: requireEnv("MEDPLUM_BASE_URL").replace(/\/$/, ""),
      archiveRoot: positionalArchiveRoot(process.argv.slice(2)),
      clientId: requireEnv("ODOS_MIGRATION_IMPORTER_CLIENT_ID"),
      clientSecret: requireEnv("ODOS_MIGRATION_IMPORTER_CLIENT_SECRET"),
    });
    console.log(formatLegacyVisitDocumentReport(results));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
