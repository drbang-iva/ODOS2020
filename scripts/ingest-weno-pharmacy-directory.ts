#!/usr/bin/env tsx
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { zipSync } from "fflate";
import {
  PostgresWenoPharmacyDirectoryStorage,
  parsePharmacyDirectoryZip,
  type SyncWenoPharmacyDirectoryResult,
  type WenoPharmacyDirectoryStorageClient,
} from "../mcp/src/jobs/syncWenoPharmacyDirectory.js";

type PharmacyDirectoryIngestResult = Pick<
  SyncWenoPharmacyDirectoryResult,
  "parsed" | "stored" | "malformedRows" | "deduplicatedRows"
>;

type CloseablePharmacyDirectoryStorage = WenoPharmacyDirectoryStorageClient & {
  close(): Promise<void>;
};

export interface WenoPharmacyDirectoryRunnerOptions {
  postgresUrl?: string;
  storage?: CloseablePharmacyDirectoryStorage;
  log?: (line: string) => void;
}

export async function runWenoPharmacyDirectoryIngest(
  filePath: string | undefined,
  options: WenoPharmacyDirectoryRunnerOptions = {},
): Promise<PharmacyDirectoryIngestResult> {
  if (!filePath?.trim()) {
    throw new Error("WENO pharmacy directory local file path is required.");
  }

  let fileBytes: Uint8Array;
  try {
    fileBytes = await readFile(filePath);
  } catch (error) {
    throw new Error(`WENO pharmacy directory file could not be read: ${filePath}`, { cause: error });
  }

  const extension = extname(filePath).toLowerCase();
  let zipBytes: Uint8Array;
  if (extension === ".zip") {
    zipBytes = fileBytes;
  } else if (extension === ".csv") {
    zipBytes = zipSync({ [basename(filePath)]: fileBytes });
  } else {
    throw new Error(`WENO pharmacy directory file must be .zip or .csv: ${filePath}`);
  }

  const parsed = parsePharmacyDirectoryZip(Uint8Array.from(zipBytes).buffer);
  if (parsed.rows.length === 0) {
    throw new Error(`WENO pharmacy directory file yielded zero rows; replacement refused: ${filePath}`);
  }
  const storage = options.storage ?? new PostgresWenoPharmacyDirectoryStorage(
    options.postgresUrl ? { postgresUrl: options.postgresUrl } : {},
  );
  try {
    const result: PharmacyDirectoryIngestResult = {
      parsed: parsed.rows.length,
      stored: await storage.store(parsed.rows, "replace"),
      malformedRows: parsed.malformedRows,
      deduplicatedRows: parsed.deduplicatedRows,
    };
    (options.log ?? console.log)(
      `WENO pharmacy directory ingest complete: parsed=${result.parsed} stored=${result.stored} `
      + `malformed=${result.malformedRows ?? 0} deduplicated=${result.deduplicatedRows ?? 0}`,
    );
    return result;
  } finally {
    await storage.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWenoPharmacyDirectoryIngest(process.argv[2], {
    postgresUrl: process.env.ODOS_POSTGRES_URL,
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
