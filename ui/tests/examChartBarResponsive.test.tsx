import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const VIEWPORTS = [
  { width: 768, rows: 2 },
  { width: 1440, rows: 1 },
  { width: 2560, rows: 1 },
] as const;

test("the real chart bar stays inside its viewport with touch-sized controls", {
  timeout: 60_000,
}, async () => {
  const server = await createServer({
    root: resolve(import.meta.dirname, ".."),
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== "string", "Vite did not expose its test port");

  const browser = await chromium.launch({
    executablePath: chromeExecutable(),
    headless: true,
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
  });
  try {
    for (const fixture of ["production", "worst-case"] as const) {
      for (const expected of VIEWPORTS) {
        const page = await browser.newPage({
          viewport: { width: expected.width, height: 900 },
          deviceScaleFactor: 1,
        });
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        await page.goto(
          `http://127.0.0.1:${address.port}/tests/fixtures/exam-chart-bar-responsive.html${fixture === "worst-case" ? "?worst=1" : ""}`,
          { waitUntil: "networkidle" },
        );

        const measurement = await page.locator('[data-testid="exam-chart-bar"]').evaluate((bar) => {
          const barRect = bar.getBoundingClientRect();
          const slots = Array.from(bar.querySelectorAll<HTMLElement>("[data-chart-bar-slot]"));
          const slotRects = slots.map((slot) => {
            const rect = slot.getBoundingClientRect();
            return {
              name: slot.dataset.chartBarSlot,
              left: rect.left,
              right: rect.right,
              top: rect.top,
              width: rect.width,
              height: rect.height,
            };
          });
          const controls = [
            bar.querySelector<HTMLElement>('[data-chart-bar-slot="exam-sections"] button'),
            bar.querySelector<HTMLElement>('[data-chart-bar-slot="visit"]'),
            bar.querySelector<HTMLElement>('[data-chart-bar-slot="blackout"]'),
            bar.querySelector<HTMLElement>('[data-chart-bar-slot="sign"]'),
          ].filter((control): control is HTMLElement => control !== null).map((control) => {
            const rect = control.getBoundingClientRect();
            return { width: rect.width, height: rect.height };
          });
          return {
            clientWidth: bar.clientWidth,
            scrollWidth: bar.scrollWidth,
            slotCount: slots.length,
            outsideSlotCount: slotRects.filter((rect) =>
              rect.width <= 0 || rect.height <= 0 ||
              rect.left < barRect.left - 0.5 || rect.right > barRect.right + 0.5
            ).length,
            rows: new Set(slotRects.map((rect) => Math.round(rect.top))).size,
            controls,
          };
        });

        assert.deepEqual(pageErrors, [], `${fixture} ${expected.width}px browser errors`);
        assert.equal(measurement.slotCount, 8, `${fixture} ${expected.width}px slot inventory`);
        assert.equal(measurement.rows, expected.rows, `${fixture} ${expected.width}px row count`);
        assert.equal(measurement.outsideSlotCount, 0, `${fixture} ${expected.width}px hidden/outside slots`);
        assert.ok(
          measurement.scrollWidth <= measurement.clientWidth,
          `${fixture} ${expected.width}px overflow: ${measurement.scrollWidth}px > ${measurement.clientWidth}px`,
        );
        assert.equal(measurement.controls.length, 4, `${fixture} ${expected.width}px controls`);
        for (const control of measurement.controls) {
          assert.ok(
            control.width >= 44 && control.height >= 44,
            `${fixture} ${expected.width}px undersized control: ${control.width}x${control.height}`,
          );
        }
        await page.close();
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }
});

test("the confrontation-field diagram keeps seeing field light and restriction dark across appearances", {
  timeout: 60_000,
}, async () => {
  const server = await createServer({
    root: resolve(import.meta.dirname, ".."),
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== "string", "Vite did not expose its test port");

  const browser = await chromium.launch({
    executablePath: chromeExecutable(),
    headless: true,
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(
      `http://127.0.0.1:${address.port}/tests/fixtures/exam-chart-bar-responsive.html?board=1`,
      { waitUntil: "networkidle" },
    );
    const appearances = ["unset", "midnight", "space-black", "light"] as const;
    const fills: Record<string, { ground: string; restricted: string }> = {};
    for (const appearance of appearances) {
      await page.evaluate((surface) => {
        if (surface === "unset") {
          delete document.documentElement.dataset.surface;
        } else {
          document.documentElement.dataset.surface = surface;
        }
      }, appearance);
      fills[appearance] = await page.locator('[data-testid="visual-field-diagram"][data-eye="OD"]').evaluate((diagram) => ({
        ground: getComputedStyle(diagram).backgroundColor,
        restricted: getComputedStyle(diagram.querySelector<HTMLElement>(".is-restricted")!).backgroundColor,
      }));
    }
    assert.deepEqual(fills, Object.fromEntries(appearances.map((appearance) => [
      appearance,
      { ground: "rgb(242, 244, 248)", restricted: "rgb(17, 21, 31)" },
    ])));
    await page.close();
  } finally {
    await browser.close();
    await server.close();
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
  assert.ok(executable, "Chrome or Chromium is required for the responsive chart-bar contract");
  return executable;
}
