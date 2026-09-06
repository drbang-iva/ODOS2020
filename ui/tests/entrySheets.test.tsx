import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, before, test } from "node:test";
import { resolve } from "node:path";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
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

async function settleDiscardDialog(page: Page, expected: string, answer: "Keep" | "Discard changes") {
  const dialog = page.getByRole("alertdialog");
  await dialog.waitFor();
  const copy = [
    await dialog.locator("h2").textContent(),
    await dialog.locator("p").textContent(),
  ].filter(Boolean).join(" ");
  assert.equal(copy, expected);
  await dialog.getByRole("button", { name: answer, exact: true }).click();
  await dialog.waitFor({ state: "detached" });
}

test("all width-safe static sections expose truthful layout-only contracts", async () => {
  const entrySheets = await import("../src/components/charting/ExamEntrySheet").catch(() => undefined);
  assert.ok(entrySheets, "the exam entry-sheet module must exist");
  assert.deepEqual(entrySheets.EXAM_ENTRY_SHEET_CONFIG, {
    hpi: { title: "Chief Complaint & HPI", layout: "paired-row-form" },
    "manual-keratometry": { title: "Manual Keratometry", layout: "paired-measurement" },
    pachymetry: { title: "Pachymetry", layout: "paired-measurement" },
    va: { title: "Visual Acuity", layout: "paired-row-form" },
    pupils: { title: "Pupils", layout: "laterality-finding" },
    stereopsis: { title: "Stereopsis", layout: "laterality-finding" },
    "color-vision": { title: "Color Vision", layout: "laterality-finding" },
    eom: { title: "EOM / Diplopia", layout: "quadrant-grid" },
    cvf: { title: "Confrontation visual fields", layout: "quadrant-grid" },
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
  "hpi", "wearing", "auto-refraction", "pretest-vitals", "manual-keratometry", "pachymetry", "va",
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
  wearing: 1600,
  "auto-refraction": 1380,
  "pretest-vitals": 1152,
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
      page.setDefaultTimeout(15_000);
      page.on("pageerror", (error) => console.log(`ENTRY_SHEET_FIXTURE_ERROR ${sectionId}: ${error.message}`));
      try {
        await page.goto(
          `${origin}/tests/fixtures/entry-sheets.html?audit=sheet&section=${sectionId}`,
          { waitUntil: "domcontentloaded" },
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

test("switching to Images parks an in-progress entry sheet and resumes its local state", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(5_000);
  try {
    await page.goto(`${origin}/tests/fixtures/entry-sheets.html`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Open IOP" }).click();
    const value = page.getByRole("combobox", { name: "OD IOP value" });
    await value.fill("16");

    await page.getByRole("tab", { name: /^Images/ }).click();
    assert.equal(await page.locator('[data-entry-sheet-section="iop"]').count(), 1, "parking must keep the entry sheet mounted");
    assert.equal(await page.getByRole("tab", { name: "Intraocular Pressure" }).getAttribute("data-parked"), "true");

    await page.getByRole("tab", { name: "Intraocular Pressure" }).click();
    assert.equal(await page.getByRole("combobox", { name: "OD IOP value" }).inputValue(), "16");
  } finally {
    await page.close();
  }
});

test("Done returns the right panel to the tab that was forward before entry opened", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(5_000);
  try {
    await page.goto(`${origin}/tests/fixtures/entry-sheets.html`, { waitUntil: "networkidle" });
    await page.getByRole("tab", { name: "Engage" }).click();
    await page.getByRole("button", { name: "Open IOP" }).click();
    await page.getByRole("combobox", { name: "OD IOP value" }).fill("16");
    await page.getByRole("button", { name: "Save IOP" }).click();

    await page.getByRole("tabpanel", { name: "Engage" }).waitFor();
    assert.equal(await page.getByRole("tab", { name: "Engage" }).getAttribute("aria-selected"), "true");
    assert.equal(await page.getByRole("tab", { name: "Intraocular Pressure" }).count(), 0);
  } finally {
    await page.close();
  }
});

test("the entry tab exists only while an entry sheet is open", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(5_000);
  try {
    await page.goto(`${origin}/tests/fixtures/entry-sheets.html`, { waitUntil: "networkidle" });
    assert.equal(await page.getByRole("tab", { name: /^Images/ }).count(), 1);
    assert.equal(await page.getByRole("tab", { name: "Engage" }).count(), 1);
    assert.equal(await page.locator(".odos-exam-right-panel-count-badge").first().textContent(), "2");
    assert.equal(await page.locator('[role="tab"][data-entry-tab="true"]').count(), 0);

    await page.getByRole("button", { name: "Open IOP" }).click();
    const entryTab = page.getByRole("tab", { name: "Intraocular Pressure" });
    assert.equal(await entryTab.getAttribute("data-entry-tab"), "true");
    assert.equal(await entryTab.locator('button, [aria-label*="close" i]').count(), 0);

    await page.getByRole("button", { name: "Back to exam overview from Intraocular Pressure" }).click();
    assert.equal(await page.locator('[role="tab"][data-entry-tab="true"]').count(), 0);
    assert.equal(await page.getByRole("tab", { name: /^Images/ }).getAttribute("aria-selected"), "true");
  } finally {
    await page.close();
  }
});

test("the History entry tab uses the worksheet section title", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(5_000);
  try {
    await page.goto(`${origin}/tests/fixtures/entry-sheets.html`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Open Hpi" }).click();
    await page.getByRole("tab", { name: "History", exact: true }).waitFor();
  } finally {
    await page.close();
  }
});

test("the panel tabs expose associations and use roving arrow-key focus", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(5_000);
  try {
    await page.goto(`${origin}/tests/fixtures/entry-sheets.html`, { waitUntil: "networkidle" });
    const imagesTab = page.getByRole("tab", { name: /^Images/ });
    const imagesPanel = page.getByRole("tabpanel", { name: "Images" });
    assert.equal(await imagesTab.getAttribute("tabindex"), "0");
    assert.equal(await imagesTab.getAttribute("aria-controls"), "exam-right-panel-images");
    assert.equal(await imagesPanel.getAttribute("id"), "exam-right-panel-images");
    assert.equal(await imagesPanel.getAttribute("aria-labelledby"), await imagesTab.getAttribute("id"));

    await imagesTab.press("ArrowRight");
    const engageTab = page.getByRole("tab", { name: "Engage" });
    await page.getByRole("tabpanel", { name: "Engage" }).waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-panel-tab") === "engage");
    assert.equal(await engageTab.getAttribute("tabindex"), "0");
    assert.equal(await engageTab.evaluate((node) => node === document.activeElement), true);

    await engageTab.press("ArrowLeft");
    await imagesPanel.waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-panel-tab") === "images");
    assert.equal(await page.getByRole("tab", { name: /^Images/ }).evaluate((node) => node === document.activeElement), true);
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
  { width: 2000, height: 1000, expectedMin: 1050, expectedMax: 1070 },
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
      await page.getByRole("tab", { name: "Visual Acuity" }).waitFor();
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

test("a pristine clinical sheet swaps from HPI to VA through a real overview click", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(3_000);
  try {
    await page.goto(`${origin}/tests/fixtures/entry-sheets.html`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Open HPI" }).click();

    const hpiDialog = page.getByRole("dialog", { name: "Chief Complaint & HPI" });
    await hpiDialog.waitFor();
    await openChartAnotherGroup(page, "va");
    await page.locator('[data-editor-section-id="va"]').click();

    await hpiDialog.waitFor({ state: "detached" });
    const vaDialog = page.getByRole("dialog", { name: "Visual Acuity" });
    await vaDialog.waitFor();
    assert.equal(await vaDialog.getAttribute("aria-modal"), null);
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
      "Back to exam overview from Visual Acuity",
    );
  } finally {
    await page.close();
  }
});

for (const contract of [
  {
    sectionId: "hpi",
    opener: "Open HPI",
    currentTitle: "Chief Complaint & HPI",
    edit: async (page: Page) => {
      await page.getByRole("button", { name: "Glaucoma", exact: true }).click();
      await page.getByRole("button", { name: "Follow Up", exact: true }).click();
    },
  },
  {
    sectionId: "iop",
    opener: "Open IOP",
    currentTitle: "Intraocular Pressure",
    edit: async (page: Page) => {
      const field = page.getByRole("combobox", { name: "OD IOP value" });
      await field.waitFor();
      await field.fill("16");
    },
  },
  {
    sectionId: "cover-test",
    opener: "Open Cover Test",
    currentTitle: "Cover Test",
    edit: async (page: Page) => {
      await page.getByRole("button", { name: "Ortho", exact: true }).first().click();
    },
  },
] as const) {
  test(`${contract.sectionId} edits warn before an overview swap`, { timeout: 30_000 }, async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(5_000);
    try {
      await page.goto(`${origin}/tests/fixtures/entry-sheets.html`, { waitUntil: "networkidle" });
      await page.getByRole("button", { name: contract.opener }).click();
      await contract.edit(page);
      await openChartAnotherGroup(page, "va");
      await page.locator('[data-editor-section-id="va"]').click();
      await settleDiscardDialog(page,
        `Discard unsaved changes in ${contract.currentTitle} and open Visual Acuity? Unsaved edits will be discarded. Saved entries remain in the chart.`,
        "Keep",
      );
      await page.getByRole("dialog", { name: contract.currentTitle }).waitFor();
      if (contract.focusLabel) {
        assert.equal(
          await page.getByLabel(contract.focusLabel).evaluate((node) => node === document.activeElement),
          true,
        );
      }
    } finally {
      await page.close();
    }
  });
}

test("focusing a pristine field does not warn before a clinical sheet swap", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(5_000);
  try {
    await page.goto(`${origin}/tests/fixtures/entry-sheets.html`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Open IOP" }).click();
    const field = page.getByRole("combobox", { name: "OD IOP value" });
    await field.waitFor();
    await field.click();
    await openChartAnotherGroup(page, "va");
    await page.locator('[data-editor-section-id="va"]').click();

    await page.getByRole("dialog", { name: "Visual Acuity" }).waitFor();
    assert.equal(await page.getByRole("alertdialog").count(), 0);
  } finally {
    await page.close();
  }
});

test("presentational sheet controls do not warn before a clinical sheet swap", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(5_000);
  try {
    await page.goto(`${origin}/tests/fixtures/entry-sheets.html`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Open Gonioscopy" }).click();
    await page.getByRole("button", { name: /Show quadrants/ }).first().click();
    await openChartAnotherGroup(page, "va");
    await page.locator('[data-editor-section-id="va"]').click();

    await page.getByRole("dialog", { name: "Visual Acuity" }).waitFor();
    assert.equal(await page.getByRole("alertdialog").count(), 0);
  } finally {
    await page.close();
  }
});

test("dirty Escape and Cancel share the discard guard while pristine Escape remains silent", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(5_000);
  try {
    await page.goto(`${origin}/tests/fixtures/entry-sheets.html`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Open IOP" }).click();
    const field = page.getByRole("combobox", { name: "OD IOP value" });
    await field.waitFor();
    await field.fill("16");

    await page.keyboard.press("Escape");
    await settleDiscardDialog(
      page,
      "Discard unsaved changes in Intraocular Pressure? Unsaved edits will be discarded. Saved entries remain in the chart.",
      "Keep",
    );
    await page.getByRole("dialog", { name: "Intraocular Pressure" }).waitFor();
    await page.getByRole("button", { name: "Back to exam overview from Intraocular Pressure" }).click();
    await settleDiscardDialog(
      page,
      "Discard unsaved changes in Intraocular Pressure? Unsaved edits will be discarded. Saved entries remain in the chart.",
      "Discard changes",
    );
    await page.getByRole("dialog", { name: "Intraocular Pressure" }).waitFor({ state: "detached" });
  } finally {
    await page.close();
  }
});

test("clinical entry-sheet chrome is 44px-class, releases Tab, closes on pristine Escape, and restores focus", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(3_000);
  try {
    await page.goto(`${origin}/tests/fixtures/entry-sheets.html`, { waitUntil: "networkidle" });
    const opener = page.getByRole("button", { name: "Open IOP" });
    await opener.focus();
    await opener.click();

    const dialog = page.getByRole("dialog", { name: "Intraocular Pressure" });
    await dialog.waitFor();
    const cancel = page.getByRole("button", { name: "Back to exam overview from Intraocular Pressure" });
    const lastControl = dialog.locator('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])').last();
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Back to exam overview from Intraocular Pressure");
    assert.equal(await dialog.getAttribute("aria-modal"), null);

    const chromeMeasurements = await page.locator("[data-entry-sheet-chrome]:visible").evaluateAll((nodes) => nodes.map((node) => {
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
    assert.notEqual(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Back to exam overview from Intraocular Pressure");

    const overviewControl = page.getByTestId("refresh-exam-overview");
    await overviewControl.focus();
    assert.equal(await overviewControl.evaluate((node) => node === document.activeElement), true);

    await cancel.focus();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Open IOP");
  } finally {
    await page.close();
  }
});

test("editor launch rows are 44px-class and disclosures reveal their interaction after expansion", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(5_000);
  try {
    await page.goto(`${origin}/tests/fixtures/entry-sheets.html`, { waitUntil: "networkidle" });
    const chartAnotherGroups = page.getByTestId("chart-another-finding");
    const chartAnotherCount = await chartAnotherGroups.count();
    assert.ok(chartAnotherCount > 0);
    for (let index = 0; index < chartAnotherCount; index += 1) {
      await chartAnotherGroups.nth(index).locator("summary").click();
    }
    const rows = page.locator('[data-testid="exam-editor-entry-row"], [data-testid="exam-section-blank"]');
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
    const fullPageRow = page.locator('[data-editor-section-id="refraction"]');
    const sheetPill = page.locator('[data-editor-section-id="va"] .odos-exam-editor-entry-presentation');
    const expandPill = fullPageRow.locator(".odos-exam-editor-entry-presentation");
    const [sheetStyle, expandStyle, emeraldColor] = await Promise.all([
      sheetPill.evaluate((element) => ({ borderStyle: getComputedStyle(element).borderStyle })),
      expandPill.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          backdropFilter: style.backdropFilter,
          backgroundColor: style.backgroundColor,
          borderStyle: style.borderStyle,
          boxShadow: style.boxShadow,
          color: style.color,
        };
      }),
      page.evaluate(() => {
        const probe = document.createElement("span");
        probe.style.color = "var(--odos-emerald)";
        document.body.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      }),
    ]);
    assert.equal(expandStyle.borderStyle, "solid");
    assert.equal(expandStyle.color, emeraldColor);
    assert.notEqual(expandStyle.backgroundColor, "rgba(0, 0, 0, 0)");
    assert.match(expandStyle.backdropFilter, /blur/);
    assert.match(expandStyle.boxShadow, /inset/);
    assert.equal(sheetStyle.borderStyle, "solid");
    assert.match(await fullPageRow.innerText(), /Expand/);
    assert.doesNotMatch(await fullPageRow.innerText(), /Full page/);
  } finally {
    await page.close();
  }
});

test("every comprehensive worksheet section exposes all rows without an inner scroller", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(5_000);
  try {
    await page.goto(`${origin}/tests/fixtures/entry-sheets.html?comprehensive=true&worksheet=true`, { waitUntil: "networkidle" });
    const sections = await page.getByTestId("exam-overview-section").evaluateAll((nodes) => nodes.map((section) => {
      const body = section.querySelector<HTMLElement>('[data-testid="exam-section-body"]')!;
      return {
        sectionKey: section.getAttribute("data-section-key"),
        clientHeight: body.clientHeight,
        scrollHeight: body.scrollHeight,
      };
    }));
    assert.equal(sections.length, 6);
    for (const section of sections) {
      assert.ok(
        section.scrollHeight <= section.clientHeight,
        `${section.sectionKey} body scrollHeight ${section.scrollHeight}px exceeds clientHeight ${section.clientHeight}px`,
      );
    }
  } finally {
    await page.close();
  }
});

test("the comprehensive worksheet renders all 17 Ocular Health rows in anatomical order", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(5_000);
  try {
    await page.goto(`${origin}/tests/fixtures/entry-sheets.html?comprehensive=true&worksheet=true`, { waitUntil: "networkidle" });
    const ocular = page.locator('[data-section-key="ocular-health"]');
    const rowIds = await ocular.locator('[data-testid="exam-section-body"] > *').evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-editor-section-id")),
    );
    assert.deepEqual(rowIds, [
      "ocular-health:anterior:periocular-adnexa",
      "ocular-health:anterior:lids-lashes",
      "ocular-health:anterior:palpebral-conjunctiva",
      "ocular-health:anterior:conjunctiva",
      "ocular-health:anterior:tear-film",
      "ocular-health:anterior:cornea",
      "ocular-health:anterior:anterior-chamber",
      "ocular-health:anterior:iris",
      "ocular-health:anterior:lens",
      "ocular-health:posterior:vitreous",
      "cup-disc",
      "ocular-health:posterior:fundus",
      "ocular-health:posterior:macula",
      "ocular-health:posterior:vessels",
      "ocular-health:posterior:periphery",
      "gonioscopy",
      "dry-eye",
    ]);
  } finally {
    await page.close();
  }
});

test("the permanent panel keeps dense worksheet sections full width within the left half", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(5_000);
  try {
    await page.goto(`${origin}/tests/fixtures/entry-sheets.html?comprehensive=true&worksheet=true`, { waitUntil: "networkidle" });
    const geometry = await page.getByTestId("exam-overview-section").evaluateAll((nodes) => Object.fromEntries(nodes.map((section) => {
      const sectionRect = section.getBoundingClientRect();
      const bodyRect = section.querySelector<HTMLElement>('[data-testid="exam-section-body"]')!.getBoundingClientRect();
      return [section.getAttribute("data-section-key"), {
        x: Math.round(sectionRect.x),
        y: Math.round(sectionRect.y),
        width: Math.round(sectionRect.width),
        bodyWidth: Math.round(bodyRect.width),
      }];
    })) as Record<string, { x: number; y: number; width: number; bodyWidth: number }>);

    for (const sectionKey of ["history", "pretest", "ocular-health"]) {
      assert.ok(geometry[sectionKey]!.width >= 500, `${sectionKey} width is ${geometry[sectionKey]!.width}px`);
      assert.ok(geometry[sectionKey]!.width < 700, `${sectionKey} exceeds the worksheet half at ${geometry[sectionKey]!.width}px`);
      assert.ok(geometry[sectionKey]!.bodyWidth <= geometry[sectionKey]!.width, `${sectionKey} row content is ${geometry[sectionKey]!.bodyWidth}px wide`);
    }
    assert.ok(geometry.history!.y < geometry.pretest!.y);
    assert.ok(geometry.pretest!.y < geometry.refraction!.y);
    assert.equal(geometry.refraction!.y, geometry["contact-lenses"]!.y);
    assert.notEqual(geometry.refraction!.x, geometry["contact-lenses"]!.x);
    assert.ok(geometry["contact-lenses"]!.y < geometry["ocular-health"]!.y);
    assert.ok(geometry["ocular-health"]!.y < geometry.assessment!.y);

    await page.setViewportSize({ width: 1179, height: 1000 });
    const narrowGeometry = await page.getByTestId("exam-overview-section").evaluateAll((nodes) => nodes.map((section) => {
      const rect = section.getBoundingClientRect();
      return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width) };
    }));
    assert.equal(new Set(narrowGeometry.map((section) => section.x)).size, 1);
    assert.equal(new Set(narrowGeometry.map((section) => section.width)).size, 1);
    assert.deepEqual(
      narrowGeometry.map((section) => section.y),
      narrowGeometry.map((section) => section.y).toSorted((left, right) => left - right),
    );
  } finally {
    await page.close();
  }
});

test("dense worksheet rows pair across while narrative rows stay vertical", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(5_000);
  try {
    await page.goto(`${origin}/tests/fixtures/entry-sheets.html?comprehensive=true&worksheet=true`, { waitUntil: "networkidle" });
    const geometry = await page.getByTestId("exam-overview-section").evaluateAll((nodes) => Object.fromEntries(nodes.map((section) => {
      const body = section.querySelector<HTMLElement>('[data-testid="exam-section-body"]')!;
      return [section.getAttribute("data-section-key"), {
        rowLayout: body.getAttribute("data-row-layout"),
        rows: Array.from(body.children).map((row) => {
          const rect = row.getBoundingClientRect();
          return {
            editorId: row.getAttribute("data-editor-section-id"),
            x: Math.round(rect.x),
            y: Math.round(rect.y),
          };
        }),
      }];
    })) as Record<string, { rowLayout: string | null; rows: Array<{ editorId: string | null; x: number; y: number }> }>);

    for (const sectionKey of ["pretest", "ocular-health"]) {
      const section = geometry[sectionKey]!;
      assert.equal(section.rowLayout, "two-column");
      assert.ok(section.rows.length >= 2, `${sectionKey} must exercise at least two rows`);
      assert.equal(section.rows[0]!.y, section.rows[1]!.y, `${sectionKey} first pair must share a y-coordinate`);
      assert.notEqual(section.rows[0]!.x, section.rows[1]!.x, `${sectionKey} first pair must occupy different columns`);
    }

    for (const sectionKey of ["history", "assessment"]) {
      const section = geometry[sectionKey]!;
      assert.equal(section.rowLayout, "single");
      assert.ok(section.rows.length >= 1, `${sectionKey} must exercise at least one row`);
      assert.equal(new Set(section.rows.map((row) => row.y)).size, section.rows.length, `${sectionKey} rows must not share a y-coordinate`);
    }

    await page.setViewportSize({ width: 900, height: 1000 });
    const narrowGeometry = await page.locator('[data-section-key="pretest"] [data-testid="exam-section-body"] > *').evaluateAll((rows) =>
      rows.map((row) => {
        const rect = row.getBoundingClientRect();
        return { x: Math.round(rect.x), y: Math.round(rect.y) };
      }),
    );
    assert.ok(narrowGeometry.length >= 2, "narrow pretest must exercise at least two rows");
    assert.equal(new Set(narrowGeometry.map((row) => row.x)).size, 1, "dense rows must collapse to one column at 900px");
    assert.equal(new Set(narrowGeometry.map((row) => row.y)).size, narrowGeometry.length, "collapsed dense rows must not share a y-coordinate");
  } finally {
    await page.close();
  }
});

test("worksheet row labels align with section titles in full-width and paired cards", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(5_000);
  try {
    await page.goto(`${origin}/tests/fixtures/entry-sheets.html?comprehensive=true&worksheet=true`, { waitUntil: "networkidle" });
    const geometry = await page.getByTestId("exam-overview-section").evaluateAll((nodes) => nodes.map((section) => {
      const sectionRect = section.getBoundingClientRect();
      const titleRect = section.querySelector<HTMLElement>(".odos-exam-section-heading h2")!.getBoundingClientRect();
      const firstRowLabelRect = section.querySelector<HTMLElement>(
        '[data-testid="exam-section-body"] > :first-child .odos-exam-section-blank-label',
      )!.getBoundingClientRect();
      return {
        sectionKey: section.getAttribute("data-section-key"),
        sectionWidth: Math.round(sectionRect.width),
        titleLeft: Math.round(titleRect.left),
        firstRowLeft: Math.round(firstRowLabelRect.left),
      };
    }));

    assert.equal(geometry.length, 6);
    assert.ok(geometry.some((section) => section.sectionWidth >= 500), "fixture must include full-width worksheet cards");
    assert.ok(geometry.some((section) => section.sectionWidth < 400), "fixture must include paired worksheet cards");
    for (const section of geometry) {
      assert.ok(
        Math.abs(section.firstRowLeft - section.titleLeft) <= 3,
        `${section.sectionKey} first row left ${section.firstRowLeft}px differs from title left ${section.titleLeft}px`,
      );
    }
  } finally {
    await page.close();
  }
});

test("an open entry sheet does not reopen a hidden per-finding launcher behind the modal", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(5_000);
  try {
    await page.goto(
      `${origin}/tests/fixtures/entry-sheets.html?audit=sheet&section=va`,
      { waitUntil: "networkidle" },
    );
    await page.getByRole("dialog", { name: "Visual Acuity" }).waitFor();
    assert.equal(await page.locator('[data-editor-section-id="va"].is-active').isVisible(), false);
    assert.equal(await page.getByTestId("chart-another-finding").filter({
      has: page.locator('[data-editor-section-id="va"]'),
    }).getAttribute("open"), null);
  } finally {
    await page.close();
  }
});

test("the distributed editor row hover visibly engages and resolves to the document accent", { timeout: 30_000 }, async () => {
  const page = await openExamOverviewPage();
  try {
    await openChartAnotherGroup(page, "iop");
    await assertHoverBorderResolvesAccent(page, page.locator('[data-editor-section-id="iop"]'));
  } finally {
    await page.close();
  }
});

test("the return-button hover visibly engages and resolves to the document accent", { timeout: 30_000 }, async () => {
  const page = await openExamOverviewPage(true);
  try {
    await assertHoverBorderResolvesAccent(page, page.getByTestId("return-to-exam-overview"));
  } finally {
    await page.close();
  }
});

test("the overview-refresh hover visibly engages and resolves to the document accent", { timeout: 30_000 }, async () => {
  const page = await openExamOverviewPage();
  try {
    await assertHoverBorderResolvesAccent(page, page.getByTestId("refresh-exam-overview"));
  } finally {
    await page.close();
  }
});

test("the widest mapped shape uses a bottom sheet while retaining visible exam context", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 768, height: 900 } });
  page.setDefaultTimeout(3_000);
  try {
    await page.goto(`${origin}/tests/fixtures/entry-sheets.html`, { waitUntil: "networkidle" });
    assert.equal(await page.getByRole("tabpanel", { name: "Images" }).count(), 0, "Images must not land forward on narrow viewports");
    await page.getByRole("button", { name: "Open Visual Acuity" }).click();
    await page.getByRole("tab", { name: "Visual Acuity" }).waitFor();
    await page.getByRole("tab", { name: /^Images/ }).waitFor();
    await page.getByRole("tab", { name: "Engage" }).waitFor();
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

test("an open clinical sheet disables Sign and Abandon in the encounter header", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(5_000);
  page.on("pageerror", (error) => console.log(`ENTRY_SHEET_HEADER_ERROR: ${error.message}`));
  try {
    await page.goto(
      `${origin}/tests/fixtures/entry-sheets.html?header=true&section=va`,
      { waitUntil: "networkidle" },
    );
    await page.getByRole("dialog", { name: "Visual Acuity" }).waitFor();
    const reason = "Finish or cancel Visual Acuity first";
    const sign = page.getByRole("button", { name: "Sign & finish" });
    const abandon = page.getByRole("button", { name: "Abandon encounter" });

    assert.equal(await sign.isDisabled(), true);
    assert.equal(await sign.getAttribute("title"), reason);
    assert.equal(await abandon.isDisabled(), true);
    assert.equal(await abandon.getAttribute("title"), reason);
  } finally {
    await page.close();
  }
});

for (const viewport of [
  { width: 2000, height: 1000, expectedWidth: 1059 },
  { width: 1440, height: 1000, expectedWidth: 762 },
  { width: 1200, height: 900, expectedWidth: 635 },
  { width: 1000, height: 900, expectedWidth: 529 },
  { width: 901, height: 900, expectedWidth: 529 },
  { width: 768, height: 900, expectedWidth: 768 },
] as const) {
  test(`the real Visit and charges composition is reachable at ${viewport.width}px`, { timeout: 30_000 }, async () => {
    const page = await browser.newPage({ viewport });
    page.setDefaultTimeout(5_000);
    try {
      await page.goto(`${origin}/tests/fixtures/entry-sheets.html?audit=sheet&section=visit-charges`, { waitUntil: "networkidle" });
      const sheet = page.getByRole("dialog");
      await sheet.waitFor();
      assert.equal(await sheet.getByRole("heading", { name: "Visit & charges", level: 2 }).innerText(), "Visit & charges");
      await page.getByRole("combobox", { name: "Visit billing code" }).waitFor();
      await page.getByRole("combobox", { name: "Visit billing diagnosis" }).waitFor();
      await page.getByTestId("procedure-charge-list").waitFor();
      await page.getByRole("button", { name: /Credit Bank/ }).waitFor();

      const geometry = await page.evaluate(() => {
        const sheet = document.querySelector<HTMLElement>("[data-testid=exam-entry-sheet]")!;
        const content = document.querySelector<HTMLElement>(".odos-exam-entry-sheet-content")!;
        const controls = Array.from(content.querySelectorAll<HTMLElement>("button, select, input, textarea"));
        return {
          sheetWidth: Math.round(sheet.getBoundingClientRect().width),
          contentWidth: content.clientWidth,
          scrollWidth: content.scrollWidth,
          overflowX: getComputedStyle(content).overflowX,
          smallestControl: Math.min(...controls.map((control) => control.getBoundingClientRect().height)),
        };
      });
      assert.ok(Math.abs(geometry.sheetWidth - viewport.expectedWidth) <= 1, `sheet width ${geometry.sheetWidth}px`);
      assert.ok(
        geometry.scrollWidth <= geometry.contentWidth + 1 || geometry.overflowX === "auto" || geometry.overflowX === "scroll",
        `horizontal content is unreachable at ${viewport.width}px`,
      );
      assert.ok(geometry.smallestControl >= 44, `smallest control is ${geometry.smallestControl}px at ${viewport.width}px`);
      console.log(`VISIT_CHARGES_GEOMETRY ${viewport.width}:w${geometry.sheetWidth},content${geometry.scrollWidth}/${geometry.contentWidth},control${geometry.smallestControl}`);
    } finally {
      await page.close();
    }
  });
}

async function openChartAnotherGroup(page: Page, sectionId: string): Promise<void> {
  const group = page.getByTestId("chart-another-finding").filter({
    has: page.locator(`[data-editor-section-id="${sectionId}"]`),
  });
  await group.locator("summary").click();
}

async function openExamOverviewPage(showReturnButton = false): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(5_000);
  const returnButton = showReturnButton ? "?returnButton=true" : "";
  try {
    await page.goto(`${origin}/tests/fixtures/entry-sheets.html${returnButton}`, { waitUntil: "networkidle" });
    await page.getByTestId("refresh-exam-overview").waitFor();
    return page;
  } catch (error) {
    await page.close();
    throw error;
  }
}

async function resolveTokenColor(page: Page, token: string): Promise<string> {
  return page.evaluate((cssToken) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${cssToken})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);
}

async function assertHoverBorderResolvesAccent(page: Page, target: Locator): Promise<void> {
  await target.waitFor();
  const before = await target.evaluate((element) => getComputedStyle(element).borderColor);
  await target.hover();
  const after = await target.evaluate((element) => getComputedStyle(element).borderColor);
  const accentColor = await resolveTokenColor(page, "--odos-accent");
  assert.notEqual(after, before, `hover border must change from ${before}`);
  assert.equal(after, accentColor);
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
  assert.ok(executable, "Chrome or Chromium is required for the entry-sheet behavior contract");
  return executable;
}
