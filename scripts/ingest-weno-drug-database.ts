#!/usr/bin/env tsx
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  ingestWenoDrugDatabaseFile,
  PostgresWenoDrugDatabaseStorage,
  type IngestWenoDrugDatabaseResult,
  type WenoDrugDatabaseStorageClient,
} from "../mcp/src/jobs/syncWenoDrugDatabase.js";

const MINIMUM_DRUG_DATABASE_REPLACEMENT_ROWS = 9_000;

type CloseableWenoDrugDatabaseStorage = WenoDrugDatabaseStorageClient & {
  close(): Promise<void>;
};

export interface WenoDrugDatabaseRunnerOptions {
  minimumReplacementRows?: number;
  postgresUrl?: string;
  storage?: CloseableWenoDrugDatabaseStorage;
  log?: (line: string) => void;
}

export async function runWenoDrugDatabaseIngest(
  filePath: string | undefined,
  options: WenoDrugDatabaseRunnerOptions = {},
): Promise<IngestWenoDrugDatabaseResult> {
  if (!filePath?.trim()) {
    throw new Error("WENO drug database local file path is required.");
  }

  try {
    await access(filePath, constants.R_OK);
  } catch (error) {
    throw new Error(`WENO drug database file could not be read: ${filePath}`, { cause: error });
  }

  const storage = options.storage ?? new PostgresWenoDrugDatabaseStorage(
    options.postgresUrl ? { postgresUrl: options.postgresUrl } : {},
  );
  try {
    const minimumReplacementRows = options.minimumReplacementRows
      ?? MINIMUM_DRUG_DATABASE_REPLACEMENT_ROWS;
    const result = await ingestWenoDrugDatabaseFile(filePath, {
      async store(rows) {
        if (rows.length < minimumReplacementRows) {
          throw new Error(
            `WENO drug database file yielded ${rows.length} storable rows; `
            + `minimum ${minimumReplacementRows} required for replacement: ${filePath}`,
          );
        }
        return storage.store(rows);
      },
    });
    (options.log ?? console.log)(
      `WENO drug database ingest complete: total=${result.totalRows} parsed=${result.parsed} `
      + `stored=${result.stored} controlled=${result.filteredControlled} `
      + `retired=${result.filteredRetired} suppressed=${result.filteredSuppressed} `
      + `malformed=${result.malformed}`,
    );
    return result;
  } finally {
    await storage.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWenoDrugDatabaseIngest(process.argv[2], {
    postgresUrl: process.env.ODOS_POSTGRES_URL,
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
