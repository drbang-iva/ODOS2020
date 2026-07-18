import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "pg";
import {
  ingestWenoDrugDatabaseFile,
  parseWenoDrugDatabase,
  PostgresWenoDrugDatabaseStorage,
  searchDrugs,
  WENO_NON_CONTROLLED_DEA_SCHEDULE_CODE,
  type WenoDrugRow,
} from "../src/jobs/syncWenoDrugDatabase.js";

const HEADERS = [
  "RXCUI(DrugCoded)",
  "GENERIC_RXCUI",
  "TTY(DrugDBCodeQualifier)",
  "FULL_NAME",
  "RXN_DOSE_FORM",
  "FULL_GENERIC_NAME",
  "BRAND_NAME",
  "DISPLAY_NAME",
  "ROUTE",
  "NEW_DOSE_FORM",
  "STRENGTH",
  "SUPPRESS_FOR",
  "DISPLAY_NAME_SYNONYM",
  "IS_RETIRED",
  "SXDG_RXCUI",
  "SXDG_TTY",
  "SXDG_NAME",
  "PSN(DrugDescription)",
  "NCPDP Quantity Term",
  "Potency Unit Code",
  "DEA Schedule #",
  "DEA Schedule",
  "Ingredients",
  "Drug Interaction (Source:ONCHigh)",
  "Unit Source Code",
  "Code List Qualifier",
] as const;

test("drug parser finds the header, maps by name, tolerates appended columns, and reconciles filters", () => {
  const text = syntheticDrugDatabase([
    syntheticDrug({
      "RXCUI(DrugCoded)": "100",
      "PSN(DrugDescription)": "Alpha ophthalmic solution",
    }),
    syntheticDrug({
      "RXCUI(DrugCoded)": "101",
      "DEA Schedule #": "2",
      "DEA Schedule": "CONTROLLED_TEST_CODE",
      "PSN(DrugDescription)": "Controlled sample",
    }),
    syntheticDrug({
      "RXCUI(DrugCoded)": "102",
      SUPPRESS_FOR: "FUTURE-CODE",
      "PSN(DrugDescription)": "Suppressed sample",
    }),
    syntheticDrug({
      "RXCUI(DrugCoded)": "103",
      IS_RETIRED: "1",
      "PSN(DrugDescription)": "Retired sample",
    }),
    syntheticDrug({
      "RXCUI(DrugCoded)": "",
      "PSN(DrugDescription)": "Malformed sample",
    }),
  ], true);

  const parsed = parseWenoDrugDatabase(text);
  assert.deepEqual(parsed.rows.map((row) => row.drugDbCode), ["100"]);
  assert.deepEqual({
    total: parsed.totalRows,
    kept: parsed.parsed,
    controlled: parsed.filteredControlled,
    retired: parsed.filteredRetired,
    suppressed: parsed.filteredSuppressed,
    malformed: parsed.malformed,
  }, {
    total: 5,
    kept: 1,
    controlled: 1,
    retired: 1,
    suppressed: 1,
    malformed: 1,
  });
  assert.equal(parsed.filteredRetiredOrSuppressed, 2);
  assert.deepEqual(parsed.malformedByReason, { requiredCodedField: 1 });
  assert.equal(parsed.rows[0].deaScheduleCode, WENO_NON_CONTROLLED_DEA_SCHEDULE_CODE);
  assert.equal(parsed.rows[0].quantityUnitOfMeasureCode, "TEST_UOM_CODE");
  assert.equal(parsed.rows[0].quantityUnitOfMeasureDisplay, "Milliliter");
});

test("drug parser falls back PSN to DISPLAY_NAME to FULL_NAME and audits every chosen source", () => {
  const parsed = parseWenoDrugDatabase(syntheticDrugDatabase([
    syntheticDrug({
      "RXCUI(DrugCoded)": "200",
      "PSN(DrugDescription)": "Preferred PSN",
      DISPLAY_NAME: "Ignored display",
      FULL_NAME: "Ignored full",
    }),
    syntheticDrug({
      "RXCUI(DrugCoded)": "201",
      "PSN(DrugDescription)": "",
      DISPLAY_NAME: "Display fallback",
      FULL_NAME: "Ignored full",
    }),
    syntheticDrug({
      "RXCUI(DrugCoded)": "202",
      "PSN(DrugDescription)": "",
      DISPLAY_NAME: "",
      FULL_NAME: "Full fallback",
    }),
    syntheticDrug({
      "RXCUI(DrugCoded)": "203",
      "PSN(DrugDescription)": "",
      DISPLAY_NAME: "",
      FULL_NAME: "",
    }),
  ]));

  assert.deepEqual(parsed.rows.map((row) => [row.psnDescription, row.nameSource]), [
    ["Preferred PSN", "psn"],
    ["Display fallback", "displayName"],
    ["Full fallback", "fullName"],
  ]);
  assert.deepEqual(parsed.nameSourceCounts, { psn: 1, displayName: 1, fullName: 1 });
  assert.equal(parsed.malformed, 1);
  assert.deepEqual(parsed.malformedByReason, { displayName: 1 });
});

test("drug parser rejects a non-controlled row whose DEA code violates the stored invariant", () => {
  const parsed = parseWenoDrugDatabase(syntheticDrugDatabase([
    syntheticDrug({
      "RXCUI(DrugCoded)": "300",
      "DEA Schedule": "TEST_WRONG_SCHEDULE_CODE",
      "PSN(DrugDescription)": "Wrong schedule code",
    }),
  ]));
  assert.equal(parsed.parsed, 0);
  assert.equal(parsed.malformed, 1);
  assert.deepEqual(parsed.malformedByReason, { deaScheduleCode: 1 });
});

test("drug search ranks case-insensitive prefix matches before substring matches", () => {
  const rows = [
    drugRow("400", "Something Alpha"),
    drugRow("401", "Alpha Beta"),
    drugRow("402", "alpha Ace"),
  ];
  assert.deepEqual(
    searchDrugs(rows, "ALPHA").map((row) => row.psnDescription),
    ["alpha Ace", "Alpha Beta", "Something Alpha"],
  );
  assert.throws(() => searchDrugs(rows, " "), /non-blank query/);
});

test("file ingestion parses operator-staged bytes and stores only kept rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "odos-weno-drugs-"));
  const path = join(directory, "synthetic.txt");
  const received: WenoDrugRow[][] = [];
  try {
    await writeFile(path, syntheticDrugDatabase([
      syntheticDrug({ "RXCUI(DrugCoded)": "500", "PSN(DrugDescription)": "Kept row" }),
      syntheticDrug({
        "RXCUI(DrugCoded)": "501",
        "DEA Schedule #": "3",
        "DEA Schedule": "CONTROLLED_TEST_CODE",
        "PSN(DrugDescription)": "Excluded row",
      }),
    ]));
    const result = await ingestWenoDrugDatabaseFile(path, {
      async store(rows) {
        received.push([...rows]);
        return rows.length;
      },
    });
    assert.deepEqual(received.map((rows) => rows.map((row) => row.drugDbCode)), [["500"]]);
    assert.equal(result.stored, 1);
    assert.equal(result.filteredControlled, 1);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("Postgres drug replacement is atomic and a failed stage load preserves the prior catalog", async (t) => {
  const adminUrl = process.env.ODOS_POSTGRES_URL;
  if (!adminUrl) {
    t.skip("ODOS_POSTGRES_URL is required for the WENO drug database storage fixture.");
    return;
  }

  const databaseName = `odos_weno_drugs_${randomUUID().replaceAll("-", "")}`;
  const testUrl = new URL(adminUrl);
  testUrl.pathname = `/${databaseName}`;
  const admin = new Client({ connectionString: adminUrl });
  const storage = new PostgresWenoDrugDatabaseStorage({ postgresUrl: testUrl.toString() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${databaseName} TEMPLATE template0`);
    await storage.store([drugRow("600", "Original row")]);
    await assert.rejects(
      storage.store([drugRow("601", "Duplicate one"), drugRow("601", "Duplicate two")]),
    );
    assert.deepEqual((await storage.list()).map((row) => row.psnDescription), ["Original row"]);
    await storage.store([drugRow("602", "Replacement row")]);
    assert.deepEqual((await storage.list()).map((row) => row.psnDescription), ["Replacement row"]);
    await assert.rejects(storage.store([]), /at least one parsed row/);
  } finally {
    await storage.close();
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await admin.end();
  }
});

function syntheticDrugDatabase(
  rows: Array<Partial<Record<typeof HEADERS[number], string>>>,
  appendedColumn = false,
): string {
  const headers = appendedColumn ? [...HEADERS, "FUTURE APPENDED COLUMN"] : [...HEADERS];
  const records = rows.map((row) => [
    ...HEADERS.map((header) => row[header] ?? ""),
    ...(appendedColumn ? ["ignored"] : []),
  ].join("|"));
  return [
    "WENO Exchange LLC Drug Database Record (Confidential) updated at: synthetic",
    "WENO Exchange LLC copyright synthetic",
    "Disclaimer: synthetic fixture only",
    "Source: synthetic",
    headers.join("|"),
    ...records,
    "",
  ].join("\r\n");
}

function syntheticDrug(
  overrides: Partial<Record<typeof HEADERS[number], string>>,
): Partial<Record<typeof HEADERS[number], string>> {
  return {
    "RXCUI(DrugCoded)": "1",
    "TTY(DrugDBCodeQualifier)": "SCD",
    FULL_NAME: "Synthetic full name",
    DISPLAY_NAME: "Synthetic display name",
    ROUTE: "Ophthalmic",
    STRENGTH: "1%",
    "PSN(DrugDescription)": "Synthetic PSN",
    "NCPDP Quantity Term": "Milliliter",
    "Potency Unit Code": "TEST_UOM_CODE",
    "DEA Schedule #": "0",
    "DEA Schedule": WENO_NON_CONTROLLED_DEA_SCHEDULE_CODE,
    ...overrides,
  };
}

function drugRow(drugDbCode: string, psnDescription: string): WenoDrugRow {
  return {
    drugDbCode,
    drugDbCodeQualifier: "SCD",
    quantityUnitOfMeasureCode: "TEST_UOM_CODE",
    quantityUnitOfMeasureDisplay: "Milliliter",
    deaScheduleCode: WENO_NON_CONTROLLED_DEA_SCHEDULE_CODE,
    psnDescription,
    nameSource: "psn",
    route: "Ophthalmic",
    strength: "1%",
  };
}
