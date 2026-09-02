// Usage (from repo root, with ui/dev-harness/ holding restraint.html + restraint.tsx and two Vite dev
// servers up — base checkout on :5174, head on :5173):
//   node docs/build-log/delete-controls-restraint-2026-09-02/harness/shoot.mjs <out-dir>
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const { chromium } = createRequire(fileURLToPath(new URL("../../../../ui/package.json", import.meta.url)))("playwright-core");
import { writeFileSync, mkdirSync } from "node:fs";
const OUT = process.argv[2];
const SETS = [
  { name: "before", base: "http://localhost:5174", after: false },
  { name: "after", base: "http://localhost:5173", after: true },
];
const SURFACES = ["pupils", "iop", "va", "arx"];
const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = [];
async function count(page) { return page.evaluate(() => window.__alertCount()); }
async function shot(page, file, blur = false) {
  if (blur) await page.addStyleTag({ content: "#root{filter:blur(6px)}" });
  await page.screenshot({ path: file, clip: { x: 0, y: 0, width: 1440, height: 1000 } });
  if (blur) await page.evaluate(() => { document.querySelectorAll("style").forEach((s) => { if (s.textContent.includes("blur(6px)")) s.remove(); }); });
}
for (const set of SETS) {
  mkdirSync(`${OUT}/${set.name}`, { recursive: true });
  for (const surface of SURFACES) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on("dialog", async (d) => { results.push({ set: set.name, surface, state: "native-confirm", message: d.message() }); await d.dismiss(); });
    await page.goto(`${set.base}/dev-harness/restraint.html?surface=${surface}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    const rest = await count(page);
    await shot(page, `${OUT}/${set.name}/${surface}-rest.png`);
    await shot(page, `${OUT}/${set.name}/${surface}-rest-squint.png`, true);
    results.push({ set: set.name, surface, state: "rest", ...rest, removes: await page.locator('button[aria-label^="Remove "]').count() });
    if (set.after) {
      const edit = page.getByRole("button", { name: "Edit", exact: true });
      if (await edit.count()) {
        await edit.first().click();
        await page.waitForTimeout(200);
        const editing = await count(page);
        await shot(page, `${OUT}/${set.name}/${surface}-edit.png`);
        results.push({ set: set.name, surface, state: "edit", ...editing, removes: await page.locator('button[aria-label^="Remove "]').count() });
        await page.getByRole("button", { name: "Done", exact: true }).first().click();
        await page.waitForTimeout(200);
      } else {
        results.push({ set: set.name, surface, state: "edit", note: "no Edit toggle rendered" });
      }
      const clear = page.locator('button[aria-label^="Clear "]').first();
      await clear.click();
      await page.waitForTimeout(400);
      const dialog = await count(page);
      const focused = await page.evaluate(() => document.activeElement ? `${document.activeElement.className} '${document.activeElement.textContent}'` : null);
      await shot(page, `${OUT}/${set.name}/${surface}-dialog.png`);
      results.push({ set: set.name, surface, state: "dialog", ...dialog, focused, alertdialog: await page.locator('[role="alertdialog"]').count() });
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
      results.push({ set: set.name, surface, state: "after-escape", alertdialog: await page.locator('[role="alertdialog"]').count(), ...(await count(page)) });
      if (surface !== "arx") {
        await page.getByRole("button", { name: "Clear chart", exact: true }).click();
        await page.waitForTimeout(400);
        const chart = await count(page);
        await shot(page, `${OUT}/${set.name}/${surface}-clear-chart-dialog.png`);
        results.push({ set: set.name, surface, state: "clear-chart-dialog", ...chart, alertdialog: await page.locator('[role="alertdialog"]').count(), consequence: await page.locator('[role="alertdialog"] p').textContent() });
        await page.keyboard.press("Escape");
      }
    } else {
      // Base: a Clear opens window.confirm (recorded via the dialog handler above and dismissed).
      const clear = page.locator("button", { hasText: /^Clear / }).first();
      if (await clear.count()) { await clear.click(); await page.waitForTimeout(400); }
    }
    await page.close();
    // Signed
    const signed = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await signed.goto(`${set.base}/dev-harness/restraint.html?surface=${surface}&signed=1`, { waitUntil: "networkidle" });
    await signed.waitForTimeout(600);
    await shot(signed, `${OUT}/${set.name}/${surface}-signed.png`);
    results.push({ set: set.name, surface, state: "signed", ...(await count(signed)), removes: await signed.locator('button[aria-label^="Remove "]').count(), disabledControls: await signed.locator('button:disabled').allTextContents() });
    await signed.close();
  }
}
await browser.close();
writeFileSync(`${OUT}/counts.json`, JSON.stringify(results, null, 2));
for (const r of results) console.log(JSON.stringify(r));
