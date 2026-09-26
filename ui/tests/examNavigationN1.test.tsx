import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { before, after, test } from "node:test";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { createServer, type ViteDevServer } from "vite";
let server: ViteDevServer, browser: Browser, origin: string;
const items = [
  ["overview", "Overview"], ["history", "History"], ["entrance", "Entrance"], ["pretest", "Pretest"],
  ["refraction", "Refraction"], ["ocular-health", "Ocular health"], ["diagnoses", "Diagnoses"], ["plan-rx", "Plan & Rx"],
  ["tests", "Tests for today"], ["results", "Results"], ["billing", "Billing"], ["review", "Review"],
] as const;
before(async () => {
  server = await createServer({ root: resolve(import.meta.dirname, ".."), logLevel: "silent", server: { host: "127.0.0.1", port: 18892, strictPort: true } });
  await server.listen();
  const address = server.httpServer!.address(); assert.ok(address && typeof address !== "string"); origin = `http://127.0.0.1:${address.port}`;
  const executablePath = [process.env.CHROME_EXECUTABLE, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(path => path && existsSync(path));
  assert.ok(executablePath);
  browser = await chromium.launch({ executablePath, headless: true, args: process.platform === "linux" ? ["--no-sandbox"] : [] });
});
after(async () => { await browser?.close(); await server?.close(); });
async function open(query = "", width = 1280) {
  const page = await browser.newPage({ viewport: { width, height: 1100 } }); page.setDefaultTimeout(5000); page.setDefaultNavigationTimeout(30_000);
  await page.goto(`${origin}/tests/fixtures/exam-navigation-n1.html${query}`, { waitUntil: "networkidle" });
  return page;
}
const menu = (page: Page) => page.getByRole("navigation", { name: "Exam sections", exact: true });
async function go(page: Page, key: string) {
  const item = items.find(row => row[0] === key)!;
  await menu(page).getByRole("button", { name: item[1], exact: true }).click();
  assert.equal(await menu(page).getByRole("button", { name: item[1], exact: true }).getAttribute("aria-current"), "page");
}
async function surface(page: Page, key: string) {
  if (key === "diagnoses") await page.getByTestId("diagnosis-workspace").waitFor();
  else if (key === "review") await page.getByRole("heading", { name: "Review", exact: true }).waitFor();
  else if (key === "plan-rx") await page.getByRole("dialog", { name: "Plan · Prescriptions", exact: true }).waitFor();
  else if (key === "billing") await page.getByRole("dialog", { name: /Visit.*charges/i }).waitFor();
  else if (key === "tests") await page.getByRole("tabpanel", { name: "Follow-up", exact: true }).waitFor();
  else if (key === "results") await page.getByRole("tabpanel", { name: "Imaging", exact: true }).waitFor();
  else {
    const section = key === "overview" ? "history" : key === "entrance" ? "pretest" : key;
    await page.locator(`#exam-section-${section}`).waitFor({ state: "attached" });
    if (key === "overview") assert.equal(await page.locator(".odos-exam-overview").evaluate(element => element.scrollTop), 0);
    if (key !== "overview") assert.equal(await page.evaluate(() => window.n1.scrolls.at(-1)), `exam-section-${section}`);
  }
}
test("N1 G1 all twelve destinations remain one menu move away from every destination", { timeout: 180_000 }, async () => {
  const page = await open();
  try {
    await menu(page).getByRole("button").first().focus();
    for (const [, label] of items) {
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), label);
      await page.keyboard.press("Tab");
    }
    for (const [from] of items) for (const [to] of items) {
      await go(page, from); await surface(page, from);
      assert.deepEqual(await menu(page).getByRole("button").allTextContents(), items.map(row => row[1]));
      await go(page, to); await surface(page, to);
      if (from === "billing" && to !== "billing") {
        assert.equal(await page.locator('[data-testid="exam-entry-layer"]').filter({ has: page.locator('#visit-charges-sheet') }).getAttribute("hidden"), "");
        assert.equal(await page.getByRole("dialog", { name: "Visit & charges", exact: true }).count(), 0);
      }
    }
  } finally { await page.close(); }
});
test("N1 G2 the real exam neither renders the toggle nor accesses its old preference", async () => {
  const page = await open();
  try {
    assert.equal(await page.getByRole("button", { name: /^By (diagnosis|structure)$/ }).count(), 0);
    await go(page, "diagnoses"); await go(page, "overview");
    assert.equal(await page.evaluate(() => window.n1.storage.some(key => key.includes("odos:encounter-chart-view"))), false);
  } finally { await page.close(); }
});
test("N1 G3 address wins over Tech, which wins over Overview landing", async () => {
  for (const [query, key] of [["", "overview"], ["?role=tech", "pretest"], ["?role=tech&exam=diagnoses", "diagnoses"]]) {
    const page = await open(query);
    try { assert.equal(await menu(page).locator('[aria-current="page"]').textContent(), items.find(row => row[0] === key)![1]); await surface(page, key); }
    finally { await page.close(); }
  }
});
test("N1 G4 menu destinations reload from the address and StartExam writes the encounter", { timeout: 180_000 }, async () => {
  for (const [key, label] of items) {
    const fresh = await open(`?exam=${key}`);
    try {
      await fresh.waitForTimeout(500);
      assert.equal(await menu(fresh).locator('[aria-current="page"]').textContent(), label);
      await surface(fresh, key);
    } finally { await fresh.close(); }
  }
  const page = await open();
  try {
    await go(page, "review"); assert.equal(new URL(page.url()).searchParams.get("exam"), "review");
    await page.reload({ waitUntil: "networkidle" }); await surface(page, "review");
    await page.goto(`${origin}/tests/fixtures/exam-navigation-n1.html?start=true`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Start today's visit →", exact: true }).click();
    await page.waitForURL(url => url.searchParams.get("encounterId") === "n1-encounter");
    assert.equal(new URL(page.url()).searchParams.get("patientId"), "n1-patient");
  } finally { await page.close(); }
});
test("N1 G5 declining a dirty History transition retains its text and sheet", async () => {
  const page = await open();
  try {
    await page.locator('[data-editor-section-id="hpi"]').click();
    const sheet = page.getByRole("dialog", { name: "Chief Complaint & HPI", exact: true });
    const text = sheet.locator("textarea").first(); await text.fill("Synthetic unsaved text");
    await menu(page).getByRole("button", { name: "Diagnoses", exact: true }).click();
    const dialog = page.getByRole("alertdialog"); await dialog.waitFor();
    assert.equal(await dialog.locator("h2").textContent(), "Discard unsaved changes in Chief Complaint & HPI and open Diagnoses?");
    await dialog.getByRole("button", { name: "Keep", exact: true }).click();
    assert.equal(await text.inputValue(), "Synthetic unsaved text"); assert.equal(await sheet.isVisible(), true);
  } finally { await page.close(); }
});
test("N1 G6 header opens Review without signing and Review preserves advisory signing", async () => {
  const page = await open();
  try {
    for (const width of [1280, 1188, 1024, 834]) {
      await page.setViewportSize({ width, height: 1100 });
      assert.equal(await page.locator(".odos-chart-bar-sign-short").textContent(), "Review");
    }
    await page.setViewportSize({ width: 1280, height: 1100 });
    await page.getByRole("button", { name: "Review & sign", exact: true }).click(); await surface(page, "review");
    assert.equal(await page.evaluate(() => window.n1.finishCalls), 0);
    assert.equal(await page.evaluate(() => window.n1.completenessReads), 0);
    assert.equal(await page.locator(".odos-exam-review li").count(), 6);
    assert.deepEqual(await page.locator(".odos-exam-review li span").allTextContents(), ["In progress", "Not examined", "Not examined", "Not examined", "Not examined", "Not examined"]);
    await page.getByRole("button", { name: "Sign & finish", exact: true }).click();
    const advisory = page.getByRole("dialog", { name: "Diagnosis key findings advisory" }); await advisory.waitFor();
    assert.equal(await page.evaluate(() => window.n1.finishCalls), 0);
    await advisory.getByRole("button", { name: "Add findings", exact: true }).click();
    await page.getByRole("button", { name: "Sign & finish", exact: true }).click(); await advisory.waitFor();
    await advisory.getByRole("button", { name: "Sign anyway", exact: true }).click();
    await page.waitForFunction(() => window.n1.finishCalls === 1);
    const complete = await open("?exam=review&complete=true");
    try { assert.equal(await complete.getByText("Nothing open", { exact: true }).count(), 1); }
    finally { await complete.close(); }
  } finally { await page.close(); }
});
test("N1 G7 partial History reads In progress", async () => {
  const page = await open();
  try { assert.equal(await page.locator('[data-trace-section-key="history"]').textContent(), "In progress"); }
  finally { await page.close(); }
});
test("N1 G8 all menu labels fit two rows at every required width", { timeout: 90_000 }, async () => {
  for (const width of [1280, 1188, 1024, 834]) {
    const page = await open("", width);
    try { for (const key of ["overview", "diagnoses"]) {
      await go(page, key); await surface(page, key);
      const geometry = await menu(page).evaluate(nav => {
        const bounds = nav.getBoundingClientRect();
        const buttons = [...nav.querySelectorAll("button")].map(button => {
          const rect = button.getBoundingClientRect(); const range = document.createRange(); range.selectNodeContents(button); const text = range.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, visible: rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= window.innerHeight && text.top >= rect.top && text.bottom <= rect.bottom && button.scrollHeight <= button.clientHeight && rect.left >= bounds.left && rect.right <= bounds.right + 1 && rect.right <= window.innerWidth && text.width <= rect.width && button.scrollWidth <= button.clientWidth, disabled: button.disabled };
        });
        return { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, buttons };
      });
      console.log(`N1 WIDTH ${width} ${key}: ${geometry.scrollWidth}/${geometry.clientWidth}; items=${geometry.buttons.length}; rows=${new Set(geometry.buttons.map(b => b.y)).size}`);
      assert.ok(geometry.scrollWidth <= geometry.clientWidth); assert.equal(geometry.buttons.length, 12);
      assert.ok(geometry.buttons.every(b => b.visible && !b.disabled)); assert.equal(new Set(geometry.buttons.map(b => b.y)).size, 2);
      for (const offset of [0, 6]) assert.equal(new Set(geometry.buttons.slice(offset, offset + 6).map(b => b.y)).size, 1);
    }
    if (width === 1280 || width === 834) {
      await go(page, "billing"); await surface(page, "billing");
      const hits = await menu(page).getByRole("button").evaluateAll(buttons => buttons.map(button => {
        const rect = button.getBoundingClientRect();
        return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      }));
      console.log(`N1 BILLING ${width}: menu hit targets=${hits.filter(Boolean).length}/12`);
      assert.equal(hits.length, 12); assert.ok(hits.every(Boolean));
      await go(page, "diagnoses"); await surface(page, "diagnoses");
      assert.equal(await page.getByRole("dialog", { name: "Visit & charges", exact: true }).count(), 0);
    }
    } finally { await page.close(); }
  }
});

test("N1 F2 unconfigured Review does not claim Nothing open", async () => {
  const page = await open("?exam=review&unconfigured=true");
  try {
    await page.getByText("Not tracked — no exam scope set", { exact: true }).waitFor();
    assert.equal(await page.getByText("Nothing open", { exact: true }).count(), 0);
    assert.equal(await page.getByText("Loading completeness…", { exact: true }).count(), 0);
  } finally { await page.close(); }
});
test("N1 F2 failed projection Review reports unavailable", async () => {
  const page = await open("?exam=review&load-failure=true");
  try {
    await page.getByText("Status unavailable", { exact: true }).waitFor();
    assert.equal(await page.getByText("Nothing open", { exact: true }).count(), 0);
    assert.equal(await page.getByText("Loading completeness…", { exact: true }).count(), 0);
  } finally { await page.close(); }
});
test("N1 F3 migrated Review preserves header sign disable rule and title", async () => {
  const page = await open("?exam=review&migrated=true");
  try {
    const header = page.getByRole("button", { name: "Review & sign", exact: true });
    const review = page.getByRole("button", { name: "Sign & finish", exact: true });
    await review.waitFor();
    assert.equal(await header.isDisabled(), true);
    assert.equal(await review.isDisabled(), true);
    assert.equal(await review.getAttribute("title"), await header.getAttribute("title"));
  } finally { await page.close(); }
});

test("N1 fixback2 G2 Review never flashes unavailable before its first load settles", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
  page.setDefaultTimeout(5000); page.setDefaultNavigationTimeout(30_000);
  try {
    await page.addInitScript(() => {
      window.n1UnavailableTexts = [];
      new MutationObserver(records => {
        for (const record of records) {
          for (const node of [record.target, ...record.addedNodes]) {
            if (node.textContent?.includes("Status unavailable")) window.n1UnavailableTexts.push(node.textContent);
          }
        }
      }).observe(document, { childList: true, subtree: true, characterData: true });
    });
    await page.goto(`${origin}/tests/fixtures/exam-navigation-n1.html?exam=review`, { waitUntil: "networkidle" });
    await page.locator(".odos-exam-review").getByText("In progress", { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.n1UnavailableTexts), []);
  } finally { await page.close(); }
});
