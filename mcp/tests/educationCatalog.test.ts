import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  createManifestEducationCatalogReader,
  type EducationCatalogLedger,
  type EducationCatalogManifest,
} from "../src/comms/education-catalog.js";

const REPO_ROOT = new URL("../../", import.meta.url);

function validLedger(): EducationCatalogLedger {
  return {
    ledger: "patient-education-catalog",
    status: "verified",
    mandate: 14,
    accessDate: "2026-08-31",
    sources: [
      {
        id: "cdc-fy2026",
        publisher: "CDC/NCHS",
        title: "FY 2026 ICD-10-CM Code Descriptions",
        url: "https://ftp.cdc.gov/pub/health_statistics/nchs/publications/ICD10CM/2026/",
        accessed: "2026-08-31",
        authority: "primary",
      },
      {
        id: "cms-fy2026",
        publisher: "CMS",
        title: "FY 2026 ICD-10-CM Full Code Manual",
        url: "https://www.cms.gov/icd10m/FY2026-nprm-version43-fullcode-cms/fullcode_cms/",
        accessed: "2026-08-31",
        authority: "primary",
      },
    ],
    diagnosisCodes: [
      {
        code: "H04.123",
        display: "Dry eye syndrome of bilateral lacrimal glands",
        sourceRefs: ["cdc-fy2026", "cms-fy2026"],
      },
      {
        code: "H52.13",
        display: "Myopia, bilateral",
        sourceRefs: ["cdc-fy2026", "cms-fy2026"],
      },
    ],
  };
}

function validManifest(): EducationCatalogManifest {
  return {
    status: "seed-placeholder-only",
    placeholderUrlHost: "education.invalid",
    notice: "Seed metadata only. VisionForge has not published these renders. Every URL is an intentional placeholder and must not be sent to patients.",
    items: [
      {
        id: "dry-eye-basics",
        version: 1,
        title: "Dry eye basics",
        kind: "handout",
        audience: "patient",
        dxCodes: ["H04.123"],
        channels: ["sms", "email", "print"],
        laneHint: "clinical",
        consentClass: "transactional",
        urls: {
          web: "https://education.invalid/dry-eye-basics/v1",
          email: "https://education.invalid/dry-eye-basics/v1/email",
          print: "https://education.invalid/dry-eye-basics/v1/print",
        },
      },
      {
        id: "dry-eye-basics",
        version: 2,
        title: "Dry eye basics",
        kind: "handout",
        audience: "patient",
        dxCodes: ["H04.123"],
        channels: ["sms", "email", "print"],
        laneHint: "clinical",
        consentClass: "transactional",
        urls: {
          web: "https://education.invalid/dry-eye-basics/v2",
          email: "https://education.invalid/dry-eye-basics/v2/email",
          print: "https://education.invalid/dry-eye-basics/v2/print",
        },
      },
      {
        id: "internal-counseling-guide",
        version: 1,
        title: "Internal counseling guide",
        kind: "page",
        audience: "internal",
        dxCodes: [],
        channels: ["print"],
        laneHint: "clinical",
        consentClass: "transactional",
        urls: { print: "https://education.invalid/internal-counseling-guide/v1/print" },
      },
    ],
  };
}

test("catalog rejects unknown manifest fields and duplicate id-version pairs", () => {
  const unknownField = structuredClone(validManifest()) as EducationCatalogManifest & { unexpected: boolean };
  unknownField.unexpected = true;
  assert.throws(
    () => createManifestEducationCatalogReader(unknownField, validLedger()),
    /manifest/i,
  );

  const unknownItemField = structuredClone(validManifest()) as EducationCatalogManifest;
  (unknownItemField.items[0] as EducationCatalogManifest["items"][number] & { unexpected: boolean }).unexpected = true;
  assert.throws(
    () => createManifestEducationCatalogReader(unknownItemField, validLedger()),
    /manifest/i,
  );

  const duplicate = structuredClone(validManifest());
  duplicate.items.push(structuredClone(duplicate.items[0]));
  assert.throws(
    () => createManifestEducationCatalogReader(duplicate, validLedger()),
    /duplicate.*dry-eye-basics.*version 1/i,
  );
});

test("catalog returns the newest version by default and the exact pinned version", () => {
  const reader = createManifestEducationCatalogReader(validManifest(), validLedger());
  assert.equal(reader.get("dry-eye-basics")?.version, 2);
  assert.equal(reader.get("dry-eye-basics", 1)?.version, 1);
  assert.equal(reader.get("dry-eye-basics", 3), undefined);
});

test("catalog rejects a plausible-looking seed URL instead of allowing a patient-sendable dead link", () => {
  const manifest = validManifest();
  manifest.items[0].urls.web = "https://patient-education.example/dry-eye-basics/v1";
  assert.throws(
    () => createManifestEducationCatalogReader(manifest, validLedger()),
    /placeholder host/i,
  );
});

test("catalog refuses unverified diagnosis codes when a JSON ledger entry is removed", () => {
  const ledger = validLedger();
  ledger.diagnosisCodes = ledger.diagnosisCodes.filter(({ code }) => code !== "H04.123");
  assert.throws(
    () => createManifestEducationCatalogReader(validManifest(), ledger),
    /H04\.123.*verified JSON ledger/i,
  );
});

test("checked-in catalog is placeholder-only, includes a real internal leak sentinel, and loads against its ledger", () => {
  const manifest = JSON.parse(readFileSync(new URL("data/education-catalog.json", REPO_ROOT), "utf8"));
  const ledger = JSON.parse(readFileSync(new URL("data/code-bindings/patient-education-catalog-ledger.json", REPO_ROOT), "utf8"));
  const reader = createManifestEducationCatalogReader(manifest, ledger);
  const items = reader.list();

  assert.equal(new Set(items.map(({ id }) => id)).size >= 6, true);
  assert.equal(items.some(({ audience }) => audience === "internal"), true);
  assert.equal(items.every(({ urls }) =>
    Object.values(urls).every((url) => new URL(url).hostname === "education.invalid")), true);
});
