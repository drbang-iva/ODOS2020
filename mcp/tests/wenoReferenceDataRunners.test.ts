import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { zipSync } from "fflate";
import {
  runWenoDrugDatabaseIngest,
} from "../../scripts/ingest-weno-drug-database.js";
import {
  runWenoPharmacyDirectoryIngest,
} from "../../scripts/ingest-weno-pharmacy-directory.js";
import {
  WENO_NON_CONTROLLED_DEA_SCHEDULE_CODE,
  type WenoDrugRow,
} from "../src/jobs/syncWenoDrugDatabase.js";
import type { PharmacyDirectoryRow } from "../src/jobs/syncWenoPharmacyDirectory.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(import.meta.dirname, "../..");
const SECRET_POSTGRES_URL = "postgresql://operator:do-not-print@localhost:5433/medplum";

test("pharmacy runner names the required local file when its path is missing", async () => {
  await assert.rejects(
    runWenoPharmacyDirectoryIngest(undefined, { log() {} }),
    /WENO pharmacy directory local file path is required/,
  );
});

test("pharmacy runner names an unreadable local file", async () => {
  const path = join(tmpdir(), "missing-weno-pharmacy-directory.csv");
  await assert.rejects(
    runWenoPharmacyDirectoryIngest(path, { log() {} }),
    (error: unknown) => error instanceof Error
      && error.message.includes(path)
      && /could not be read/.test(error.message),
  );
});

test("pharmacy runner wraps a bare CSV for the real parser and reports stored counts without credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "odos-weno-pharmacy-runner-"));
  const path = join(directory, "WENO Pharmacy Directory.csv");
  const storedRows: PharmacyDirectoryRow[][] = [];
  const output: string[] = [];
  let closed = false;
  try {
    await writeFile(path, pharmacyDirectoryCsv());
    const result = await runWenoPharmacyDirectoryIngest(path, {
      postgresUrl: SECRET_POSTGRES_URL,
      storage: {
        async store(rows, mode) {
          assert.equal(mode, "replace");
          storedRows.push([...rows]);
          return rows.length;
        },
        async close() {
          closed = true;
        },
      },
      log(line) {
        output.push(line);
      },
    });

    assert.equal(result.parsed, 1);
    assert.equal(result.stored, 1);
    assert.equal(result.malformedRows, 0);
    assert.equal(result.deduplicatedRows, 0);
    assert.equal(storedRows[0][0].ncpdpId, "0123456");
    assert.equal(closed, true);
    assert.match(output.join("\n"), /parsed=1 stored=1 malformed=0 deduplicated=0/);
    assert.equal(output.join("\n").includes(SECRET_POSTGRES_URL), false);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("pharmacy runner passes a ZIP file directly to the existing parser", async () => {
  const directory = await mkdtemp(join(tmpdir(), "odos-weno-pharmacy-zip-runner-"));
  const path = join(directory, "directory.zip");
  const storedRows: PharmacyDirectoryRow[][] = [];
  try {
    await writeFile(path, zipSync({ "directory.csv": new TextEncoder().encode(pharmacyDirectoryCsv()) }));
    await runWenoPharmacyDirectoryIngest(path, {
      storage: {
        async store(rows) {
          storedRows.push([...rows]);
          return rows.length;
        },
        async close() {},
      },
      log() {},
    });
    assert.equal(storedRows[0][0].businessName, "Runner Pharmacy");
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("drug runner names the required local file when its path is missing", async () => {
  await assert.rejects(
    runWenoDrugDatabaseIngest(undefined, { log() {} }),
    /WENO drug database local file path is required/,
  );
});

test("drug runner names an unreadable local file", async () => {
  const path = join(tmpdir(), "missing-weno-drug-database.txt");
  await assert.rejects(
    runWenoDrugDatabaseIngest(path, { log() {} }),
    (error: unknown) => error instanceof Error
      && error.message.includes(path)
      && /could not be read/.test(error.message),
  );
});

test("drug runner calls the existing file ingest and reports real counts without credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "odos-weno-drug-runner-"));
  const path = join(directory, "WENO Drug Database.txt");
  const storedRows: WenoDrugRow[][] = [];
  const output: string[] = [];
  let closed = false;
  try {
    await writeFile(path, drugDatabaseFile());
    const result = await runWenoDrugDatabaseIngest(path, {
      postgresUrl: SECRET_POSTGRES_URL,
      storage: {
        async store(rows) {
          storedRows.push([...rows]);
          return rows.length;
        },
        async close() {
          closed = true;
        },
      },
      log(line) {
        output.push(line);
      },
    });

    assert.equal(result.totalRows, 2);
    assert.equal(result.parsed, 1);
    assert.equal(result.stored, 1);
    assert.equal(result.filteredControlled, 1);
    assert.equal(result.malformed, 0);
    assert.deepEqual(storedRows.map((rows) => rows.map((row) => row.drugDbCode)), [["100"]]);
    assert.equal(closed, true);
    assert.match(output.join("\n"), /total=2 parsed=1 stored=1 controlled=1 retired=0 suppressed=0 malformed=0/);
    assert.equal(output.join("\n").includes(SECRET_POSTGRES_URL), false);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("both runner CLIs exit non-zero and name the missing path argument", async () => {
  for (const script of [
    "scripts/ingest-weno-pharmacy-directory.ts",
    "scripts/ingest-weno-drug-database.ts",
  ]) {
    await assert.rejects(
      execFileAsync(process.execPath, ["--import", "tsx", script], { cwd: REPO_ROOT }),
      (error: unknown) => {
        if (!(error instanceof Error) || !("code" in error) || !("stderr" in error)) return false;
        assert.equal(error.code, 1, basename(script));
        assert.match(String(error.stderr), /local file path is required/, basename(script));
        return true;
      },
    );
  }
});

function pharmacyDirectoryCsv(): string {
  return [
    "WENO Pharmacy Directory synthetic runner fixture",
    [
      "Created",
      "Modified",
      "Deleted",
      "NCPDP_safe",
      "Mutually_Defined_ID_safe",
      "NPI_safe",
      "Business_Name",
      "Address_Line_1",
      "Address_Line_2",
      "City",
      "State",
      "ZipCode_safe",
      "Country_Code",
      "International",
      "Latitude",
      "Longitude",
      "Pharmacy_Phone_safe",
      "Test_Pharmacy",
      "State_Wide_Mail_Order",
      "Mail_Order_US_State_Serviced",
      "Mail_Order_US_Territories_Serviced",
      "On_WENO",
      "24HR",
    ].join(","),
    [
      "01/01/2026",
      "",
      "",
      "[0123456]",
      "[runner-1]",
      "[1234567890]",
      "Runner Pharmacy",
      "1 Main Street",
      "",
      "Austin",
      "TX",
      "[78701]",
      "US",
      "No",
      "30.2672",
      "-97.7431",
      "[5125550100]",
      "No",
      "Local",
      "TX",
      "",
      "Yes",
      "No",
    ].join(","),
  ].join("\n");
}

function drugDatabaseFile(): string {
  const headers = [
    "RXCUI(DrugCoded)",
    "TTY(DrugDBCodeQualifier)",
    "FULL_NAME",
    "DISPLAY_NAME",
    "ROUTE",
    "STRENGTH",
    "SUPPRESS_FOR",
    "IS_RETIRED",
    "PSN(DrugDescription)",
    "NCPDP Quantity Term",
    "Potency Unit Code",
    "DEA Schedule #",
    "DEA Schedule",
  ];
  const kept = [
    "100", "SCD", "Kept full name", "Kept display", "oral", "10 mg", "", "",
    "Kept PSN", "Each", "TEST_UOM_CODE", "0", WENO_NON_CONTROLLED_DEA_SCHEDULE_CODE,
  ];
  const controlled = [
    "101", "SCD", "Controlled full name", "Controlled display", "oral", "5 mg", "", "",
    "Controlled PSN", "Each", "TEST_UOM_CODE", "2", "CONTROLLED",
  ];
  return ["Synthetic WENO drug database", headers.join("|"), kept.join("|"), controlled.join("|")].join("\n");
}
