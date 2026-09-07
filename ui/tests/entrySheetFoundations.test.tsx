import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { after, before, test } from "node:test";
import { resolve } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium, type Browser } from "playwright-core";
import { createServer, type ViteDevServer } from "vite";
import { CollectPanel } from "../src/components/CollectPanel";
import { BalancePanel } from "../src/components/commercial/BalancePanel";
import { CreditBankDepositSheet } from "../src/components/commercial/CreditBankDepositSheet";
import { SaleSheet } from "../src/components/commercial/SaleSheet";
import type { PatientCreditBank, PatientPackageInstance } from "../src/lib/commercial-engine";
import type { OpenChargeLine } from "../src/lib/collect";

const CHARGES: OpenChargeLine[] = [
  { id: "charge-1", amountCents: 10_000, openCents: 10_000, attributedCents: 0, description: "Exam balance", date: "2026-08-16", source: "other" },
];

const CREDIT_BANK: PatientCreditBank = {
  patientFhirId: "patient-1",
  balanceCents: 1_500,
  ledger: [],
};

const PACKAGES: PatientPackageInstance[] = [{
  id: "package-1",
  patientFhirId: "patient-1",
  definitionId: "definition-1",
  name: "Dry eye care",
  eligibleProcedureTypeCodes: ["dry-eye"],
  sessionCount: 4,
  priceCents: 40_000,
  expiryDate: "2027-08-16",
  refundPolicy: "store_credit_only",
  sourceSaleInvoiceId: "invoice-1",
  remainingSessions: 3,
  createdAt: "2026-08-16T12:00:00Z",
  ledger: [],
}];

const PANEL_CONTRACTS = [
  { panel: "collect", dialogLabel: "Collect payment", closeLabel: "Close collect panel" },
  { panel: "balance", dialogLabel: "Prepaid balances", closeLabel: "Close prepaid balances" },
  { panel: "sale", dialogLabel: "Sell care package", closeLabel: "Close package sale" },
  { panel: "credit", dialogLabel: "Deposit to Credit Bank", closeLabel: "Close Credit Bank deposit" },
] as const;

let server: ViteDevServer;
let browser: Browser;
let origin: string;

before(async () => {
  server = await createServer({
    root: resolve(import.meta.dirname, ".."),
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== "string", "Vite did not expose its test port");
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({
    executablePath: chromeExecutable(),
    headless: true,
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
  });
});

after(async () => {
  await browser?.close();
  await server?.close();
});

for (const contract of PANEL_CONTRACTS) {
  test(`${contract.dialogLabel} owns focus, traps both tab directions, restores focus, and suppresses the background`, { timeout: 30_000 }, async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    try {
      await page.goto(`${origin}/tests/fixtures/docked-panels.html?panel=${contract.panel}`, { waitUntil: "networkidle" });
      const opener = page.locator("#panel-opener");
      await opener.focus();
      await opener.click();

      const dialog = page.getByRole("dialog", { name: contract.dialogLabel });
      await dialog.waitFor();
      const close = page.getByRole("button", { name: contract.closeLabel });

      await assertActiveLabel(page, contract.closeLabel, `${contract.dialogLabel} initial focus`);

      const labelledBy = await dialog.getAttribute("aria-labelledby");
      assert.ok(labelledBy, `${contract.dialogLabel} must use aria-labelledby`);
      assert.equal(await page.locator(`#${labelledBy}`).count(), 1, `${contract.dialogLabel} labelled title`);

      const controls = dialog.locator(focusableSelector());
      const controlCount = await controls.count();
      assert.ok(controlCount >= 1, `${contract.dialogLabel} focusable controls`);
      const last = controls.nth(controlCount - 1);
      await last.focus();
      await page.keyboard.press("Tab");
      await assertActiveLabel(page, contract.closeLabel, `${contract.dialogLabel} forward wrap`);
      await close.focus();
      await page.keyboard.press("Shift+Tab");
      assert.equal(await activeElementIdentity(page), await controlIdentity(last), `${contract.dialogLabel} reverse wrap`);

      await close.focus();
      const backgroundFocus = await page.locator("#background-action").evaluate((node) => {
        (node as HTMLElement).focus();
        return document.activeElement?.id ?? "";
      });
      assert.notEqual(backgroundFocus, "background-action", `${contract.dialogLabel} background must be unreachable`);

      await close.focus();
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      assert.equal(await page.locator("#panel-state").textContent(), "closed");
      assert.equal(await page.evaluate(() => document.activeElement?.id), "panel-opener", `${contract.dialogLabel} focus restore`);
    } finally {
      await page.close();
    }
  });
}

for (const child of [
  { button: "Add package", dialogLabel: "Sell care package", closeLabel: "Close package sale" },
  { button: "Deposit Credit Bank", dialogLabel: "Deposit to Credit Bank", closeLabel: "Close Credit Bank deposit" },
] as const) {
  test(`Collect payment resolves nested ${child.dialogLabel} as the topmost focus and inert layer`, { timeout: 30_000 }, async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    try {
      await page.goto(`${origin}/tests/fixtures/docked-panels.html?panel=collect`, { waitUntil: "networkidle" });
      await page.locator("#panel-opener").click();
      const outer = page.getByRole("dialog", { name: "Collect payment" });
      const childOpener = outer.getByRole("button", { name: child.button });
      await childOpener.click();

      const inner = page.getByRole("dialog", { name: child.dialogLabel });
      await inner.waitFor();
      await assertActiveLabel(page, child.closeLabel, `${child.dialogLabel} initial topmost focus`);
      const layers = await Promise.all([outer, inner].map((dialog) => dialog.evaluate((node) => Number.parseInt(getComputedStyle(node).zIndex, 10))));
      assert.deepEqual(layers, [50, 70], `${child.dialogLabel} nested layers`);

      const escapedFocus = await outer.getByRole("button", { name: "Close collect panel" }).evaluate((node) => {
        (node as HTMLElement).focus();
        return (document.activeElement as HTMLElement | null)?.getAttribute("aria-label");
      });
      assert.equal(escapedFocus, child.closeLabel, `${child.dialogLabel} must keep focus on the topmost layer`);

      const innerControls = inner.locator(focusableSelector());
      const last = innerControls.nth((await innerControls.count()) - 1);
      await last.focus();
      await page.keyboard.press("Tab");
      await assertActiveLabel(page, child.closeLabel, `${child.dialogLabel} owns nested focus wrap`);

      await page.keyboard.press("Escape");
      await inner.waitFor({ state: "detached" });
      await outer.waitFor();
      assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), child.button, `${child.dialogLabel} restores its outer-panel opener`);
      const backgroundFocus = await page.locator("#background-action").evaluate((node) => {
        (node as HTMLElement).focus();
        return document.activeElement?.id ?? "";
      });
      assert.notEqual(backgroundFocus, "background-action", "Collect payment remains the active modal");
    } finally {
      await page.close();
    }
  });
}

test("the four panel visual DOM snapshots stay byte-stable through extraction", () => {
  const snapshots = {
    collect: visualMarkupHash(<CollectPanel patientReference="Patient/patient-1" patientName="Alex Rivera" onClose={() => undefined} initialCharges={CHARGES} />),
    balance: visualMarkupHash(<BalancePanel patientReference="Patient/patient-1" packages={PACKAGES} creditBank={CREDIT_BANK} canAdminister onPackageChanged={() => undefined} onClose={() => undefined} />),
    sale: visualMarkupHash(<SaleSheet patientReference="Patient/patient-1" patientName="Alex Rivera" onClose={() => undefined} />),
    credit: visualMarkupHash(<CreditBankDepositSheet patientReference="Patient/patient-1" patientName="Alex Rivera" onClose={() => undefined} />),
  };
  assert.deepEqual(snapshots, {
    collect: "84f31330c04de38b58e9868826da44c5cd495938c9433f351ac5f46badd01858",
    balance: "89af89896350849df87ec0a6f77cb8e45045fbe8ed9b68c1141c39e46f048fbb",
    sale: "3cbfac718febae35f5c67d6012dcae6adb55260a9259210687f3a6c837a8de51",
    credit: "56c926d16c451f89988fa0e90aaf190d2b1bd76a7d1015a0d9bb99bbf1cbccd5",
  });
});

test("shared panel utilities preserve tenders, money, and messages", async () => {
  const shared = await import("../src/components/commercial/panel-shared").catch(() => undefined);
  assert.ok(shared, "shared panel utilities must be importable");
  assert.deepEqual(shared.TENDERS, [
    { code: "CASH", label: "Cash" },
    { code: "CHECK", label: "Check" },
    { code: "CARD_MANUAL", label: "Card — manual entry" },
  ]);
  assert.equal(shared.money(10_000), "$100.00");
  assert.equal(shared.money(100.5), "$1.01");
  assert.equal(shared.messageOf(new Error("failed")), "failed");
  assert.equal(shared.messageOf("failed"), "failed");
});

test("finding worksheet controls are importable from their shared module", async () => {
  const worksheet = await import("../src/components/charting/FindingWorksheetControls").catch(() => undefined);
  assert.ok(worksheet, "shared finding worksheet controls must be importable");
  assert.equal(typeof worksheet.FindingWorksheetRow, "function");
  assert.equal(typeof worksheet.FindingQualifierControl, "function");
  assert.equal(typeof worksheet.NumericFindingQualifier, "function");
});

function visualMarkupHash(element: React.ReactNode): string {
  const markup = renderToStaticMarkup(element)
    .replace(/\s(?:aria-[\w-]+|role|id)="[^"]*"/g, "")
    .replace(/\s(?:aria-hidden|inert)=""/g, "");
  return createHash("sha256").update(markup).digest("hex");
}

function focusableSelector(): string {
  return 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
}

async function assertActiveLabel(page: import("playwright-core").Page, expected: string, context: string): Promise<void> {
  assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute("aria-label")), expected, context);
}

async function activeElementIdentity(page: import("playwright-core").Page): Promise<string> {
  return page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    return `${active?.tagName ?? ""}|${active?.getAttribute("aria-label") ?? ""}|${active?.textContent?.trim() ?? ""}`;
  });
}

async function controlIdentity(control: import("playwright-core").Locator): Promise<string> {
  return control.evaluate((node) => `${node.tagName}|${node.getAttribute("aria-label") ?? ""}|${node.textContent?.trim() ?? ""}`);
}

function chromeExecutable(): string {
  const candidates = [
    process.env.ODOS_CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((candidate): candidate is string => Boolean(candidate));
  const executable = candidates.find(existsSync);
  assert.ok(executable, "Chrome or Chromium is required for the docked-panel behavior contract");
  return executable;
}
