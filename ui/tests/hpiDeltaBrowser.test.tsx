import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { chromium } from "playwright-core";
import { createServer } from "vite";

test("browser chip autosave carries one answer and an unchanged refresh carries none", async () => {
  const server = await createServer({
    root: process.env.HISTORY_PROOF_ROOT ?? resolve(import.meta.dirname, ".."), logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 },
    plugins: [{
      name: "history-delta-proof",
      resolveId(id) { if (id === "/history-delta-fixture.js") return id; },
      load(id) {
        if (id === "/history-delta-fixture.js") return `
          import React from 'react';
          import { createRoot } from 'react-dom/client';
          import { HpiSection } from '/src/components/charting/HpiSection.tsx';
          import '/src/styles/globals.css';
          createRoot(document.getElementById('root')).render(React.createElement(HpiSection, {
            patientReference: 'Patient/p1', encounterReference: 'Encounter/e1', onSaved: () => {}
          }));`;
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url !== "/history-delta-proof") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(await vite.transformIndexHtml(req.url, '<!doctype html><html><body><div id="root"></div><script type="module" src="/history-delta-fixture.js"></script></body></html>'));
        });
      },
    }],
  });
  await server.listen();
  const address = server.httpServer!.address();
  assert.ok(address && typeof address !== "string");
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: process.platform === "linux" ? ["--no-sandbox"] : [] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const answers = [
      { id: "presentation", complaintId: "c1", templateKey: "glaucoma", sectionId: "presentation", value: { kind: "selection", code: "follow-up" } },
      { id: "pain", complaintId: "c1", templateKey: "glaucoma", sectionId: "symptoms", optionCode: "ocular-pain", value: { kind: "tri-state", status: "negative" } },
    ];
    const requests: unknown[][] = [];
    await page.route("**/clinical-graph/**", async (route) => {
      const url = route.request().url();
      let body: unknown;
      if (url.endsWith("/definition")) body = {
        templates: [{ complaint: "glaucoma", label: "Glaucoma", presentations: "presentations", narrative: "", sections: [{ id: "symptoms", type: "symptoms", label: "Symptoms", catalog: "symptoms" }] }],
        catalogs: { presentations: [{ code: "follow-up", display: "Follow Up" }], symptoms: [{ code: "ocular-pain", display: "ocular pain" }, { code: "blur", display: "blur" }] },
      };
      else if (url.endsWith("/complaints")) body = { complaints: [{ id: "c1", ordinal: 1, templateKey: "glaucoma", renderedNarrative: "Synthetic history proof" }] };
      else if (url.endsWith("/encounters/e1/hpi")) body = { answers, requiresAggregateRefresh: true };
      else {
        const payload = route.request().postDataJSON();
        requests.push(payload.templateAnswers);
        body = { answers: payload.templateAnswers, templateNarratives: [] };
      }
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.goto(`http://127.0.0.1:${address.port}/history-delta-proof`);
    await page.getByText("saved · just now", { exact: true }).waitFor();
    const saved = page.waitForResponse((response) => response.url().endsWith("/clinical-graph/hpi") && response.request().method() === "POST");
    await page.getByRole("button", { name: "blur: unasked", exact: true }).click();
    await saved;
    console.log(`BROWSER_REQUEST_BODIES ${JSON.stringify(requests)}`);
    if (process.env.HISTORY_PROOF_CAPTURE) {
      await mkdir(resolve(process.env.HISTORY_PROOF_CAPTURE, ".."), { recursive: true });
      await page.screenshot({ path: process.env.HISTORY_PROOF_CAPTURE, animations: "disabled" });
    }
    assert.deepEqual(requests[0], []);
    assert.equal(requests[1]?.length, 1);
    assert.equal((requests[1]![0] as { optionCode: string }).optionCode, "blur");
  } finally { await browser.close(); await server.close(); }
});
