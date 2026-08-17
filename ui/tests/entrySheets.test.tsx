import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, before, test } from "node:test";
import { resolve } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { createServer, type ViteDevServer } from "vite";

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

test("mapped sections expose truthful layout-only contracts while Refraction stays full-page", async () => {
  const entrySheets = await import("../src/components/charting/ExamEntrySheet").catch(() => undefined);
  assert.ok(entrySheets, "the exam entry-sheet module must exist");
  assert.deepEqual(entrySheets.EXAM_ENTRY_SHEET_CONFIG, {
    pupils: { title: "Pupils", layout: "laterality-finding" },
    iop: { title: "Intraocular Pressure", layout: "paired-measurement" },
    gonioscopy: { title: "Gonioscopy", layout: "quadrant-grid" },
    va: { title: "Visual Acuity", layout: "paired-row-form" },
  });
  assert.doesNotMatch(
    JSON.stringify(entrySheets.EXAM_ENTRY_SHEET_CONFIG),
    /battery|per-row-save|ou-acuity/i,
    "layout names must not claim deferred editor behavior",
  );
});

for (const viewport of [
  { width: 1440, height: 1000, expectedMin: 750, expectedMax: 770 },
  { width: 1200, height: 900, expectedMin: 530, expectedMax: 650 },
  { width: 1000, height: 900, expectedMin: 529, expectedMax: 531 },
  { width: 901, height: 900, expectedMin: 529, expectedMax: 531 },
] as const) {
  test(`the widest mapped shape uses the packet width without covering the exam column at ${viewport.width}px`, { timeout: 30_000 }, async () => {
    const page = await browser.newPage({ viewport });
    page.setDefaultTimeout(3_000);
    try {
      await page.goto(`${origin}/tests/fixtures/entry-sheets.html`, { waitUntil: "networkidle" });
      await page.getByRole("button", { name: "Open Visual Acuity" }).click();
      const dialog = page.getByRole("dialog", { name: "Visual Acuity" });
      await dialog.waitFor();

      const geometry = await page.evaluate(() => {
        const exam = document.querySelector<HTMLElement>("[data-testid=fixture-exam-column]")!.getBoundingClientRect();
        const sheet = document.querySelector<HTMLElement>("[data-testid=exam-entry-sheet]")!.getBoundingClientRect();
        return { examRight: exam.right, sheetLeft: sheet.left, sheetWidth: sheet.width };
      });
      assert.ok(geometry.sheetWidth >= viewport.expectedMin, `sheet width ${geometry.sheetWidth}px`);
      assert.ok(geometry.sheetWidth <= viewport.expectedMax, `sheet width ${geometry.sheetWidth}px`);
      assert.ok(geometry.examRight <= geometry.sheetLeft, `exam right ${geometry.examRight}px must not cross sheet left ${geometry.sheetLeft}px`);
      await page.getByTestId("exam-entry-restore-bar").waitFor();
    } finally {
      await page.close();
    }
  });
}

for (const width of [1200, 1000, 901]) {
  test(`real Visual Acuity controls have a horizontal reachability path at ${width}px`, { timeout: 30_000 }, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(3_000);
    try {
      await page.goto(`${origin}/tests/fixtures/entry-sheets.html`, { waitUntil: "networkidle" });
      await page.getByRole("button", { name: "Open Visual Acuity" }).click();
      await page.getByRole("dialog", { name: "Visual Acuity" }).waitFor();

      const before = await page.evaluate(() => {
        const content = document.querySelector<HTMLElement>(".odos-exam-entry-sheet-content")!;
        const correction = Array.from(content.querySelectorAll<HTMLElement>("select")).at(-1)!;
        const contentRect = content.getBoundingClientRect();
        const correctionRect = correction.getBoundingClientRect();
        return {
          clientWidth: content.clientWidth,
          scrollWidth: content.scrollWidth,
          overflowX: getComputedStyle(content).overflowX,
          correctionRight: correctionRect.right,
          contentRight: contentRect.right,
        };
      });
      const clipped = before.correctionRight > before.contentRight + 1;
      assert.ok(clipped, `the ${width}px rung must exercise VA overflow`);
      assert.ok(
        before.overflowX === "auto" || before.overflowX === "scroll",
        `VA content is clipped at ${width}px with overflow-x ${before.overflowX}`,
      );
      assert.ok(before.scrollWidth > before.clientWidth, `VA must expose scroll width at ${width}px`);

      await page.evaluate(() => {
        const content = document.querySelector<HTMLElement>(".odos-exam-entry-sheet-content")!;
        content.scrollLeft = content.scrollWidth;
      });
      const after = await page.evaluate(() => {
        const content = document.querySelector<HTMLElement>(".odos-exam-entry-sheet-content")!;
        const correction = Array.from(content.querySelectorAll<HTMLElement>("select")).at(-1)!;
        return {
          correctionRight: correction.getBoundingClientRect().right,
          contentRight: content.getBoundingClientRect().right,
        };
      });
      assert.ok(after.correctionRight <= after.contentRight + 1, `Correction must be reachable after scrolling at ${width}px`);
    } finally {
      await page.close();
    }
  });
}

test("real Refraction returns to the full-page editor instead of a narrow entry sheet", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(3_000);
  try {
    await page.goto(`${origin}/tests/fixtures/entry-sheets.html`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Open Refraction" }).click();
    await page.getByTestId("fixture-full-page-refraction").waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0);
    await page.getByRole("heading", { name: "Refraction" }).waitFor();
    await page.getByRole("combobox", { name: "OD distance visual acuity" }).waitFor();
  } finally {
    await page.close();
  }
});

test("entry-sheet chrome is 44px-class and the shared layer traps, closes, and restores focus", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(3_000);
  try {
    await page.goto(`${origin}/tests/fixtures/entry-sheets.html`, { waitUntil: "networkidle" });
    const opener = page.getByRole("button", { name: "Open IOP" });
    await opener.focus();
    await opener.click();

    const dialog = page.getByRole("dialog", { name: "Intraocular Pressure" });
    await dialog.waitFor();
    const cancel = page.getByRole("button", { name: "Cancel Intraocular Pressure entry" });
    const save = dialog.getByRole("button", { name: "Fixture save" });
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Cancel Intraocular Pressure entry");

    const chromeMeasurements = await page.locator("[data-entry-sheet-chrome]").evaluateAll((nodes) => nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    }));
    assert.ok(chromeMeasurements.length >= 2);
    for (const measurement of chromeMeasurements) {
      assert.ok(measurement.width >= 44, `chrome width ${measurement.width}px`);
      assert.ok(measurement.height >= 44, `chrome height ${measurement.height}px`);
    }

    await save.focus();
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Cancel Intraocular Pressure entry");
    await cancel.focus();
    await page.keyboard.press("Shift+Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Fixture save");

    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Open IOP");
  } finally {
    await page.close();
  }
});

test("the widest mapped shape uses a bottom sheet while retaining visible exam context", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 768, height: 900 } });
  page.setDefaultTimeout(3_000);
  try {
    await page.goto(`${origin}/tests/fixtures/entry-sheets.html`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Open Visual Acuity" }).click();
    const geometry = await page.evaluate(() => {
      const context = document.querySelector<HTMLElement>("[data-testid=fixture-exam-context]")!.getBoundingClientRect();
      const sheet = document.querySelector<HTMLElement>("[data-testid=exam-entry-sheet]")!.getBoundingClientRect();
      return { contextBottom: context.bottom, sheetTop: sheet.top, sheetBottom: sheet.bottom, viewportHeight: window.innerHeight };
    });
    assert.ok(geometry.contextBottom <= geometry.sheetTop, "exam context must stay visible above the bottom sheet");
    assert.equal(Math.round(geometry.sheetBottom), geometry.viewportHeight);
  } finally {
    await page.close();
  }
});

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
  assert.ok(executable, "Chrome or Chromium is required for the entry-sheet behavior contract");
  return executable;
}
