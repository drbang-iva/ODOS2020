import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import { createServer, type ViteDevServer } from "vite";

let server: ViteDevServer;
let browser: Browser;
let origin: string;
const capture = process.env.ODOS_WALKTHROUGH_CAPTURE_DIR;
before(async () => {
  server = await createServer({ root: resolve(import.meta.dirname, ".."), logLevel: "silent", server: { host: "127.0.0.1", port: 19866, strictPort: true } });
  await server.listen();
  origin = "http://127.0.0.1:19866";
  const executablePath = [
    process.env.ODOS_CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].find((candidate) => candidate && existsSync(candidate));
  assert.ok(executablePath, "Chrome or Chromium is required for the UI walkthrough regressions");
  browser = await chromium.launch({ executablePath, headless: true, args: process.platform === "linux" ? ["--no-sandbox"] : [] });
  if (capture) await mkdir(capture, { recursive: true });
});
after(async () => { await browser?.close(); await server?.close(); });

async function assertReadable(input: Locator, minimumMargin = 0) {
  const geometry = await input.evaluate((node) => {
    const element = node as HTMLInputElement;
    const style = getComputedStyle(element);
    const context = document.createElement("canvas").getContext("2d")!;
    context.font = style.font;
    const available = element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const textWidth = context.measureText(element.value).width;
    return { available, textWidth, margin: available - textWidth, scrollLeft: element.scrollLeft };
  });
  assert.ok(geometry.margin >= minimumMargin, `numeric text margin is below ${minimumMargin}px: ${JSON.stringify(geometry)}`);
  assert.equal(geometry.scrollLeft, 0, "the whole number must be visible without internal scrolling");
  return geometry;
}

async function assertResponsiveConfirmation(page: Page, act: () => Promise<unknown>, expectedText: string) {
  const nativeDialogs: string[] = [];
  page.on("dialog", async (dialog) => {
    nativeDialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await act();
  assert.deepEqual(nativeDialogs, [], `native confirm blocked the renderer: ${JSON.stringify(nativeDialogs)}`);
  const dialog = page.getByRole("alertdialog");
  await dialog.waitFor();
  const copy = await dialog.locator("h2, p").allTextContents();
  assert.equal(copy.filter(Boolean).join(" "), expectedText);
  const ticks = await page.evaluate(() => new Promise<number>((resolve) => {
    let count = 0;
    const timer = setInterval(() => { if (++count === 3) { clearInterval(timer); resolve(count); } }, 10);
  }));
  assert.equal(ticks, 3, "the event loop stays live while the confirmation is open");
  await dialog.getByRole("button", { name: "Keep", exact: true }).click();
}

interface NumericReadabilityCase {
  section: string;
  expectedCount?: number;
  prepare?: (page: Page) => Promise<void>;
  widestByLabel: Record<string, string>;
}

async function measureAllNumericInputs(page: Page, widestByLabel: Record<string, string>, expectedCount = Object.keys(widestByLabel).length) {
  await page.evaluate(() => document.fonts.ready);
  const inputs = page.locator('input[inputmode="decimal"]');
  await inputs.first().waitFor();
  const labels = await inputs.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")));
  assert.equal(await inputs.count(), expectedCount, `every numeric input in the sheet must have a range-derived widest-value case: ${JSON.stringify(labels)}`);
  const measurements: Array<{ label: string; value: string; available: number; textWidth: number; margin: number; scrollLeft: number }> = [];
  for (let index = 0; index < await inputs.count(); index += 1) {
    const input = inputs.nth(index);
    const label = await input.getAttribute("aria-label");
    assert.ok(label && Object.hasOwn(widestByLabel, label), `numeric input ${label ?? index} has no widest legitimate value`);
    const value = widestByLabel[label];
    await input.fill(value);
    assert.equal(await input.inputValue(), value, `${label} accepts its range-derived widest value`);
    const geometry = await assertReadable(input, 8);
    measurements.push({ label, value, ...geometry });
    await input.press("Tab");
  }
  return measurements;
}

async function newWalkthroughPage(height = 1000) {
  const page = await browser.newPage({ viewport: { width: 1440, height } });
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(15_000);
  return page;
}

for (const [section, label, typed] of [
  ["wearing", "OD axis", "120"],
  ["auto-refraction", "OD auto-refraction axis", "175"],
] as const) {
  test(`P1 ${section}: continuous axis typing displays every digit and retains it on blur`, { timeout: 30_000 }, async () => {
    const page = await newWalkthroughPage();
    try {
      await page.goto(`${origin}/tests/fixtures/entry-sheets.html?section=${section}`, { waitUntil: "networkidle" });
      const input = page.getByRole("combobox", { name: label, exact: true });
      await input.click();
      await input.pressSequentially(typed);
      assert.equal(await input.inputValue(), typed);
      if (capture) await page.screenshot({ path: `${capture}/${section}.png` });
      await assertReadable(input);
      await page.getByRole("heading", { name: section === "wearing" ? "Wearing (WRx)" : "Auto-Refraction / Auto-K", exact: true }).click();
      assert.equal(await input.inputValue(), typed);
    } finally { await page.close(); }
  });
}

test("P1 refraction: Wearing pull displays the supplied 180 axis without keystrokes", { timeout: 30_000 }, async () => {
  const page = await newWalkthroughPage();
  try {
    await page.goto(`${origin}/tests/fixtures/entry-sheets.html?section=refraction&walkthrough=1`, { waitUntil: "networkidle" });
    await page.getByRole("combobox", { name: "Pull values into refraction 1", exact: true }).click();
    await page.getByRole("option", { name: /^Wearing Rx/ }).click();
    const input = page.getByRole("combobox", { name: "OD axis", exact: true }).first();
    assert.equal(await input.inputValue(), "180");
    if (capture) await page.screenshot({ path: `${capture}/refraction.png` });
    await assertReadable(input);
  } finally { await page.close(); }
});

test("P1 IOP: Enter keeps typed 16 even when scrolling puts another option under the pointer", { timeout: 30_000 }, async () => {
  const page = await newWalkthroughPage();
  try {
    await page.goto(`${origin}/tests/fixtures/entry-sheets.html?section=iop`, { waitUntil: "networkidle" });
    const input = page.getByRole("combobox", { name: "OD IOP value", exact: true });
    await input.click();
    await input.pressSequentially("16");
    assert.equal(await input.inputValue(), "16");
    const list = page.getByRole("listbox", { name: "OD IOP value options", exact: true });
    await list.getByRole("option", { name: "15", exact: true }).hover();
    await input.press("Enter");
    if (capture) await page.screenshot({ path: `${capture}/iop.png` });
    assert.equal(await input.inputValue(), "16");
    await assertReadable(input);
    await input.click();
    await input.press("ArrowDown");
    await input.press("Enter");
    assert.equal(await input.inputValue(), "17", "explicit arrow selection still works");
    await input.fill("16");
    await input.press("Enter");
    await page.getByRole("button", { name: "Save IOP", exact: true }).click();
    const savedValue = await page.evaluate(() => {
      const writes = (window as typeof window & { __odosFixtureWrites: Array<{ url: string; body: { eyes?: { OD?: { value?: number } } } }> }).__odosFixtureWrites;
      return writes.findLast((write) => write.url.endsWith("/clinical-graph/iop"))?.body.eyes?.OD?.value;
    });
    assert.equal(savedValue, 16, "Save must receive the same IOP value the clinician typed and saw");
  } finally { await page.close(); }
});

test("P3 exam-section summary text fits inside its button alongside the chevron", { timeout: 30_000 }, async () => {
  const page = await newWalkthroughPage(900);
  try {
    await page.goto(`${origin}/tests/fixtures/exam-chart-bar-responsive.html`, { waitUntil: "networkidle" });
    const trigger = page.getByTestId("exam-completeness-trigger");
    assert.equal(await trigger.textContent(), "Exam sections: 8 of 12");
    if (capture) await page.screenshot({ path: `${capture}/completeness.png` });
    const geometry = await trigger.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(element);
      const text = range.getBoundingClientRect();
      return { right: bounds.right, textRight: text.right, width: bounds.width, textWidth: text.width };
    });
    assert.ok(geometry.textRight <= geometry.right - 12, `label overflows the control: ${JSON.stringify(geometry)}`);
    await trigger.click();
    assert.equal(await trigger.getAttribute("aria-expanded"), "true");
  } finally { await page.close(); }
});

test("P4 both binocular PD pickers offer whole-millimeter steps centered on 63", { timeout: 30_000 }, async () => {
  const page = await newWalkthroughPage();
  try {
    await page.goto(`${origin}/tests/fixtures/entry-sheets.html?section=auto-refraction`, { waitUntil: "networkidle" });
    for (const eye of ["distance", "near"]) {
      await page.getByRole("combobox", { name: `Binocular PD ${eye}`, exact: true }).click();
      const options = await page.getByRole("listbox", { name: `Binocular PD ${eye} options`, exact: true }).getByRole("option").allTextContents();
      assert.deepEqual(options.filter((option) => Number.parseFloat(option) >= 62 && Number.parseFloat(option) <= 64), ["62 mm", "63 mm", "64 mm"]);
      await page.keyboard.press("Escape");
    }
  } finally { await page.close(); }
});

test("P5 Add complaint follows complaint articles and precedes the first History subject section", { timeout: 30_000 }, async () => {
  const page = await newWalkthroughPage();
  try {
    await page.goto(`${origin}/tests/fixtures/entry-sheets.html?section=hpi`, { waitUntil: "networkidle" });
    const adder = page.getByText("Add complaint", { exact: true }).locator("..");
    const subject = page.locator('article[data-testid^="history-"]').first();
    await subject.waitFor();
    assert.equal(await adder.evaluate((element) => {
      const firstSubject = document.querySelector('article[data-testid^="history-"]')!;
      return Boolean(element.compareDocumentPosition(firstSubject) & Node.DOCUMENT_POSITION_FOLLOWING);
    }), true, "Add complaint must precede the first subject-section article in DOM order");
    await adder.getByRole("button", { name: "Glaucoma", exact: true }).click();
    const complaint = page.locator("article").filter({ has: page.getByRole("heading", { name: /1\. Glaucoma/ }) });
    await complaint.waitFor();
    if (capture) await page.screenshot({ path: `${capture}/hpi-complaint-order.png` });
    assert.equal(await adder.evaluate((element) => element.previousElementSibling?.tagName), "ARTICLE");
    assert.equal(await adder.evaluate((element) => element.nextElementSibling?.getAttribute("data-testid")), "history-family-history");
  } finally { await page.close(); }
});

for (const [surface, act, expectedText] of [
  ["ocular", async (page: Page) => page.getByRole("button", { name: "Normal", exact: true }).first().click(), "Changing the exam state will discard recorded details for Synthetic Finding. Continue?"],
  ["prescription", async (page: Page) => page.getByRole("button", { name: "Cancel prescription", exact: true }).click(), "This prescription is already at the pharmacy. Cancelling it cannot be undone from ODOS. Continue?"],
] as const) {
  test(`close-out ${surface}: destructive action uses a responsive in-app confirmation`, { timeout: 30_000 }, async () => {
    const page = await newWalkthroughPage();
    try {
      const section = surface === "prescription" ? "&section=prescription" : "";
      await page.goto(`${origin}/tests/fixtures/entry-sheets.html?walkthrough=1&confirmSurface=${surface}${section}`, { waitUntil: "networkidle" });
      await assertResponsiveConfirmation(page, () => act(page), expectedText);
    } finally { await page.close(); }
  });
}

for (const action of ["regenerate", "template"] as const) {
  test(`close-out referral ${action}: edited letter uses a responsive in-app confirmation`, { timeout: 30_000 }, async () => {
    const page = await newWalkthroughPage();
    try {
      await page.goto(`${origin}/tests/fixtures/entry-sheets.html?walkthrough=1&confirmSurface=referral`, { waitUntil: "networkidle" });
      await page.getByRole("button", { name: /Retina Group/ }).click();
      const letter = page.getByRole("textbox", { name: "Referral letter", exact: true });
      await letter.waitFor();
      await letter.evaluate((element) => {
        element.innerHTML = "Edited clinician letter";
        element.dispatchEvent(new InputEvent("input", { bubbles: true }));
      });
      const expectedText = action === "regenerate"
        ? "Regenerate this letter and discard your edits?"
        : "Change templates and discard your letter edits?";
      await assertResponsiveConfirmation(page, () => action === "regenerate"
        ? page.getByRole("button", { name: "↺ Regenerate", exact: true }).click()
        : page.getByRole("combobox", { name: "Referral letter template", exact: true }).selectOption("retina"), expectedText);
    } finally { await page.close(); }
  });
}

test("close-out numeric guard measures every numeric input at its widest legitimate value", { timeout: 60_000 }, async () => {
  const eyeFields = (prefix: string, fields: Record<string, string>) => Object.fromEntries(
    ["OD", "OS"].flatMap((eye) => Object.entries(fields).map(([field, value]) => [`${eye} ${prefix}${field}`, value])),
  );
  const cases: NumericReadabilityCase[] = [
    {
      section: "refraction",
      expectedCount: 18,
      prepare: async (page) => { await page.getByRole("switch", { name: "Prism for refraction 1", exact: true }).click(); },
      widestByLabel: eyeFields("", { sphere: "-20.00", cylinder: "-20.00", axis: "180", add: "-20.00", "prism amount": "20.00" }),
    },
    {
      section: "wearing",
      widestByLabel: eyeFields("", { sphere: "-16.00", cylinder: "-8.00", axis: "180", add: "5.00", "prism amount": "20.00" }),
    },
    {
      section: "auto-refraction",
      widestByLabel: {
        ...eyeFields("auto-refraction ", { sphere: "-16.00", cylinder: "-8.00", axis: "180" }),
        "Binocular PD distance": "75",
        "Binocular PD near": "75",
        ...eyeFields("", { "flat K": "60.00", "flat axis": "180", "steep K": "60.00", "steep axis": "180" }),
      },
    },
    {
      section: "iop",
      widestByLabel: eyeFields("", { "IOP value": "80", "corneal hysteresis": "15.00" }),
    },
  ];
  const page = await newWalkthroughPage();
  const allMeasurements: Array<{ section: string; label: string; value: string; available: number; textWidth: number; margin: number; scrollLeft: number }> = [];
  try {
    for (const entry of cases) {
      await page.goto(`${origin}/tests/fixtures/entry-sheets.html?section=${entry.section}`, { waitUntil: "networkidle" });
      await entry.prepare?.(page);
      const measurements = await measureAllNumericInputs(page, entry.widestByLabel, entry.expectedCount);
      console.log(`NUMERIC_READABILITY ${entry.section} ${JSON.stringify(measurements)}`);
      if (capture) await page.screenshot({ path: `${capture}/numeric-${entry.section}.png` });
      allMeasurements.push(...measurements.map((measurement) => ({ section: entry.section, ...measurement })));
    }
  } finally { await page.close(); }
  const clipped = allMeasurements.filter(({ margin, scrollLeft }) => margin < 8 || scrollLeft !== 0);
  assert.deepEqual(clipped, [], `numeric fields need at least 8px text margin at their widest legitimate value: ${JSON.stringify(allMeasurements)}`);
});

for (const interaction of ["iop", "assessment-search", "assessment-status"] as const) {
  test(`P0 ${interaction}: immediate navigation uses a responsive in-app discard confirmation`, { timeout: 30_000 }, async () => {
    const page = await newWalkthroughPage();
    const nativeDialogs: string[] = [];
    const blockedStacks: string[] = [];
    page.on("console", (message) => { if (message.text().startsWith("BLOCKED_CONFIRM")) blockedStacks.push(message.text()); });
    page.on("dialog", async (dialog) => { nativeDialogs.push(dialog.message()); await dialog.dismiss(); });
    await page.addInitScript(() => {
      const originalConfirm = window.confirm;
      window.confirm = (message) => {
        console.log("BLOCKED_CONFIRM", new Error(message).stack);
        return originalConfirm(message);
      };
    });
    try {
      const section = interaction === "iop" ? "iop" : "assessment";
      await page.goto(`${origin}/tests/fixtures/entry-sheets.html?section=${section}&walkthrough=1`, { waitUntil: "networkidle" });
      if (interaction === "iop") {
        const field = page.getByRole("combobox", { name: "OD IOP value", exact: true });
        await field.click();
        await field.pressSequentially("16");
        await field.press("ControlOrMeta+A");
        await field.press("Backspace");
        await field.click();
      } else if (interaction === "assessment-search") {
        await page.getByText("Selected: Myopia, bilateral", { exact: true }).waitFor();
        await page.getByRole("combobox", { name: "Diagnosis laterality", exact: true }).click();
        await page.getByRole("option", { name: "OD", exact: true }).click();
      } else {
        await page.getByRole("combobox", { name: "Problem status", exact: true }).click();
        await page.getByRole("option").filter({ hasText: "Stable chronic illness" }).click();
      }
      const navigate = () => interaction === "assessment-search"
        ? page.getByRole("button", { name: "Open Prescription", exact: true }).click()
        : page.getByTestId("cancel-exam-entry-sheet").click();
      await navigate();
      if (blockedStacks.length) console.log(`${interaction} ${blockedStacks.join("\n")}`);
      assert.deepEqual(nativeDialogs, [], "native confirm suspends the renderer until the browser host answers");
      const confirmation = page.getByRole("alertdialog");
      await confirmation.waitFor();
      const ticks = await page.evaluate(() => new Promise<number>((resolve) => {
        let count = 0;
        const timer = setInterval(() => { if (++count === 3) { clearInterval(timer); resolve(count); } }, 10);
      }));
      assert.equal(ticks, 3, "the event loop stays live while the question is open");
      if (capture) await page.screenshot({ path: `${capture}/${interaction}-confirmation.png` });
      await confirmation.getByRole("button", { name: "Keep", exact: true }).click();
      await navigate();
      await page.getByRole("alertdialog").getByRole("button", { name: "Discard changes", exact: true }).click();
      if (interaction === "assessment-search") await page.getByRole("heading", { name: "Prescriptions", exact: true }).waitFor();
      else await page.getByTestId("cancel-exam-entry-sheet").waitFor({ state: "detached" });
      assert.deepEqual(nativeDialogs, []);
    } finally { await page.close(); }
  });
}
