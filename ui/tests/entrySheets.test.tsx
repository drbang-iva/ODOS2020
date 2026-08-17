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

test("all width-safe static sections expose truthful layout-only contracts", async () => {
  const entrySheets = await import("../src/components/charting/ExamEntrySheet").catch(() => undefined);
  assert.ok(entrySheets, "the exam entry-sheet module must exist");
  assert.deepEqual(entrySheets.EXAM_ENTRY_SHEET_CONFIG, {
    hpi: { title: "Chief Complaint / HPI / ROS", layout: "paired-row-form" },
    "manual-keratometry": { title: "Manual Keratometry", layout: "paired-measurement" },
    pachymetry: { title: "Pachymetry", layout: "paired-measurement" },
    va: { title: "Visual Acuity", layout: "paired-row-form" },
    pupils: { title: "Pupils", layout: "laterality-finding" },
    stereopsis: { title: "Stereopsis", layout: "laterality-finding" },
    "color-vision": { title: "Color Vision", layout: "laterality-finding" },
    eom: { title: "EOM / Diplopia", layout: "quadrant-grid" },
    cvf: { title: "Visual Field", layout: "quadrant-grid" },
    "cover-test": { title: "Cover Test", layout: "paired-row-form" },
    iop: { title: "Intraocular Pressure", layout: "paired-measurement" },
    dilation: { title: "Dilation", layout: "paired-row-form" },
    "ortho-k": { title: "Ortho-K", layout: "paired-row-form" },
    "myopia-management": { title: "Myopia Management", layout: "paired-row-form" },
    "cup-disc": { title: "Cup/Disc", layout: "paired-measurement" },
    gonioscopy: { title: "Gonioscopy", layout: "quadrant-grid" },
    "dry-eye": { title: "Dry Eye", layout: "paired-row-form" },
    imaging: { title: "Manual imaging", layout: "paired-row-form" },
    assessment: { title: "Assessment", layout: "paired-row-form" },
    prescription: { title: "Plan · Prescriptions", layout: "paired-row-form" },
  });
  assert.doesNotMatch(
    JSON.stringify(entrySheets.EXAM_ENTRY_SHEET_CONFIG),
    /battery|per-row-save|ou-acuity/i,
    "layout names must not claim deferred editor behavior",
  );
});

const REAL_SECTION_AUDIT = [
  "hpi", "wearing", "auto-refraction", "manual-keratometry", "pachymetry", "va",
  "pupils", "stereopsis", "color-vision", "eom", "cvf", "cover-test", "iop",
  "dilation", "refraction", "eye-growth", "soft-contact-lens",
  "specialty-contact-lens", "ortho-k", "myopia-management", "cup-disc",
  "gonioscopy", "dry-eye", "imaging", "assessment", "prescription",
] as const;

const ENTRY_SHEET_VIEWPORTS = [
  { width: 1440, height: 1000 },
  { width: 1200, height: 900 },
  { width: 1000, height: 900 },
  { width: 901, height: 900 },
  { width: 768, height: 900 },
] as const;

const PLANNED_SHEET_SECTIONS = new Set<string>([
  "hpi", "manual-keratometry", "pachymetry", "va", "pupils", "stereopsis",
  "color-vision", "eom", "cvf", "cover-test", "iop", "dilation", "ortho-k",
  "myopia-management", "cup-disc", "gonioscopy", "dry-eye", "imaging",
  "assessment", "prescription",
]);

const USABLE_HORIZONTAL_SCROLL = new Set<string>(["va", "cup-disc"]);

const DEFERRED_MEASURED_MINIMUMS = {
  wearing: 1510,
  "auto-refraction": 1380,
  refraction: 1500,
  "eye-growth": 1550,
  "soft-contact-lens": 1600,
  "specialty-contact-lens": 1800,
} as const;

test("every static editor is mounted for a real-browser width and height gate", { timeout: 240_000 }, async () => {
  const measurements: Record<string, unknown> = {};
  for (const sectionId of REAL_SECTION_AUDIT) {
    measurements[sectionId] = {};
    for (const viewport of ENTRY_SHEET_VIEWPORTS) {
      const page = await browser.newPage({ viewport });
      page.setDefaultTimeout(5_000);
      page.on("pageerror", (error) => console.log(`ENTRY_SHEET_FIXTURE_ERROR ${sectionId}: ${error.message}`));
      try {
        await page.goto(
          `${origin}/tests/fixtures/entry-sheets.html?audit=sheet&section=${sectionId}`,
          { waitUntil: "networkidle" },
        );
        await page.locator(`[data-fixture-section="${sectionId}"]`).waitFor({ state: "attached" });
        await page.waitForTimeout(50);
        const geometry = await page.evaluate(() => {
          const content = document.querySelector<HTMLElement>(".odos-exam-entry-sheet-content")!;
          const fixture = content.querySelector<HTMLElement>("[data-fixture-section]")!;
          const contentRect = content.getBoundingClientRect();
          const elements = [fixture, ...Array.from(fixture.querySelectorAll<HTMLElement>("*"))];
          const requiredWidth = Math.ceil(Math.max(content.scrollWidth, ...elements.map((element) => {
            const rect = element.getBoundingClientRect();
            const offset = Math.max(0, rect.left - contentRect.left + content.scrollLeft);
            return offset + Math.max(rect.width, element.scrollWidth);
          })));
          const requiredHeight = Math.ceil(Math.max(content.scrollHeight, ...elements.map((element) => element.scrollHeight)));
          const declaredEditorWidth = Math.ceil(Math.max(0, ...elements.flatMap((element) => {
            const style = getComputedStyle(element);
            return [style.minWidth, style.maxWidth].flatMap((value) => {
              const parsed = Number.parseFloat(value);
              const viewportBound = Math.abs(parsed - (window.innerWidth - 32)) < 1;
              return Number.isFinite(parsed) && !viewportBound ? [parsed] : [];
            });
          })));
          const innerScrollers = elements.filter((element) => {
            const style = getComputedStyle(element);
            return element.scrollHeight > element.clientHeight + 1
              && (style.overflowY === "auto" || style.overflowY === "scroll");
          }).length;
          return {
            sheetWidth: Math.round(document.querySelector<HTMLElement>("[data-testid=exam-entry-sheet]")!.getBoundingClientRect().width),
            contentWidth: content.clientWidth,
            requiredWidth,
            contentHeight: content.clientHeight,
            requiredHeight,
            declaredEditorWidth,
            overflowX: getComputedStyle(content).overflowX,
            overflowY: getComputedStyle(content).overflowY,
            innerScrollers,
          };
        });
        (measurements[sectionId] as Record<string, unknown>)[String(viewport.width)] = geometry;
        if (PLANNED_SHEET_SECTIONS.has(sectionId)) {
          if (geometry.requiredWidth > geometry.contentWidth + 1) {
            assert.ok(
              USABLE_HORIZONTAL_SCROLL.has(sectionId),
              `${sectionId} requires ${geometry.requiredWidth}px in ${geometry.contentWidth}px at ${viewport.width}px`,
            );
            assert.ok(
              geometry.overflowX === "auto" || geometry.overflowX === "scroll",
              `${sectionId} has no horizontal reachability path at ${viewport.width}px`,
            );
          }
          if (geometry.requiredHeight > geometry.contentHeight + 1) {
            assert.ok(
              geometry.overflowY === "auto" || geometry.overflowY === "scroll" || geometry.innerScrollers > 0,
              `${sectionId} requires ${geometry.requiredHeight}px vertically in ${geometry.contentHeight}px at ${viewport.width}px`,
            );
          }
        }
      } finally {
        await page.close();
      }
    }
    if (sectionId in DEFERRED_MEASURED_MINIMUMS) {
      const desktop = (measurements[sectionId] as Record<string, { requiredWidth: number; declaredEditorWidth: number }>)["1440"]!;
      const measuredMinimum = sectionId === "eye-growth"
        ? desktop.requiredWidth
        : desktop.declaredEditorWidth;
      assert.equal(
        measuredMinimum,
        DEFERRED_MEASURED_MINIMUMS[sectionId as keyof typeof DEFERRED_MEASURED_MINIMUMS],
        `${sectionId} deferred minimum`,
      );
    }
    const sectionMeasurements = measurements[sectionId] as Record<string, {
      contentWidth: number;
      requiredWidth: number;
      contentHeight: number;
      requiredHeight: number;
    }>;
    console.log(
      `ENTRY_SHEET_SECTION_GEOMETRY ${sectionId} ` +
      ENTRY_SHEET_VIEWPORTS.map(({ width }) => {
        const row = sectionMeasurements[String(width)]!;
        return `${width}:w${row.requiredWidth}/${row.contentWidth},h${row.requiredHeight}/${row.contentHeight}`;
      }).join(" "),
    );
  }
  assert.equal(Object.keys(measurements).length, REAL_SECTION_AUDIT.length);
});

test("a tall real editor has a vertical reachability path in the capped bottom sheet", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 768, height: 900 } });
  page.setDefaultTimeout(5_000);
  try {
    await page.goto(
      `${origin}/tests/fixtures/entry-sheets.html?audit=sheet&section=prescription`,
      { waitUntil: "networkidle" },
    );
    const content = page.locator(".odos-exam-entry-sheet-content");
    const before = await content.evaluate((node) => {
      const element = node as HTMLElement;
      return {
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        overflowY: getComputedStyle(element).overflowY,
      };
    });
    assert.ok(before.scrollHeight > before.clientHeight, "the real Prescription editor must exercise vertical overflow");
    assert.ok(
      before.overflowY === "auto" || before.overflowY === "scroll",
      `Prescription is vertically clipped with overflow-y ${before.overflowY}`,
    );
    await content.evaluate((node) => {
      const element = node as HTMLElement;
      element.scrollTop = element.scrollHeight;
    });
    const lastControl = page.locator("[data-fixture-section=prescription] button").last();
    assert.ok(await lastControl.isVisible(), "the final Prescription control must be reachable after scrolling");
  } finally {
    await page.close();
  }
});

for (const sectionId of [
  "wearing",
  "auto-refraction",
  "refraction",
  "eye-growth",
  "soft-contact-lens",
  "specialty-contact-lens",
] as const) {
  test(`${sectionId} remains on the truthful full-page route`, { timeout: 30_000 }, async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(5_000);
    try {
      await page.goto(`${origin}/tests/fixtures/entry-sheets.html?section=${sectionId}`, { waitUntil: "networkidle" });
      await page.locator(`[data-testid=fixture-full-page-editor][data-fixture-section="${sectionId}"]`).waitFor();
      assert.equal(await page.getByRole("dialog").count(), 0);
    } finally {
      await page.close();
    }
  });
}

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
    await page.locator('[data-testid="fixture-full-page-editor"][data-fixture-section="refraction"]').waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0);
    await page.getByRole("heading", { name: "Refraction" }).waitFor();
    await page.getByRole("combobox", { name: "OD distance visual acuity", exact: true }).first().waitFor();
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
    const lastControl = dialog.locator('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])').last();
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

    await lastControl.focus();
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Cancel Intraocular Pressure entry");
    await cancel.focus();
    await page.keyboard.press("Shift+Tab");
    assert.equal(await lastControl.evaluate((node) => node === document.activeElement), true);

    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Open IOP");
  } finally {
    await page.close();
  }
});

test("distributed editor rows are 44px-class and disclose their interaction before activation", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(5_000);
  try {
    await page.goto(`${origin}/tests/fixtures/entry-sheets.html`, { waitUntil: "networkidle" });
    const rows = page.getByTestId("exam-editor-entry-row");
    assert.ok(await rows.count() >= REAL_SECTION_AUDIT.length);
    const measurements = await rows.evaluateAll((nodes) => nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    }));
    for (const measurement of measurements) {
      assert.ok(measurement.width >= 44, `editor-row width ${measurement.width}px`);
      assert.ok(measurement.height >= 44, `editor-row height ${measurement.height}px`);
    }
    await page.locator('[data-editor-section-id="va"][data-editor-presentation="sheet"]').waitFor();
    await page.locator('[data-editor-section-id="refraction"][data-editor-presentation="full-page"]').waitFor();
    assert.match(await page.locator('[data-editor-section-id="va"]').innerText(), /Entry sheet/);
    assert.match(await page.locator('[data-editor-section-id="refraction"]').innerText(), /Full page/);
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
