#!/usr/bin/env tsx
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  ingestWenoDrugDatabaseFile,
  PostgresWenoDrugDatabaseStorage,
  type IngestWenoDrugDatabaseResult,
  type WenoDrugDatabaseStorageClient,
} from "../mcp/src/jobs/syncWenoDrugDatabase.js";

type CloseableWenoDrugDatabaseStorage = WenoDrugDatabaseStorageClient & {
  close(): Promise<void>;
};

export interface WenoDrugDatabaseRunnerOptions {
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
    await readFile(filePath);
  } catch (error) {
    throw new Error(`WENO drug database file could not be read: ${filePath}`, { cause: error });
  }

  const storage = options.storage ?? new PostgresWenoDrugDatabaseStorage(
    options.postgresUrl ? { postgresUrl: options.postgresUrl } : {},
  );
  try {
    const result = await ingestWenoDrugDatabaseFile(filePath, storage);
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
