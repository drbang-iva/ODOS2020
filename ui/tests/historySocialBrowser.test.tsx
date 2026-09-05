import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { historyRosFixture } from "../../mcp/tests/helpers/historyRosFixture.js";
import * as api from "../../mcp/src/clinical-graph/hpi-endpoint.js";
import { handleEncounterVoidRequest } from "../../mcp/src/clinical-graph/encounter-void-endpoint.js";
import { buildHistoryItemReview, HISTORY_ITEM_REVIEW_CODE, parseHistoryItemReview } from "../../mcp/src/clinical-graph/history-answer-observation.js";
import type { Observation } from "@medplum/fhirtypes";

test("Social browser: dated review preserves reminder until a persisted answer", async () => {
  const followUp = false;
  const seed = { ...buildHistoryItemReview({ sectionKey: "social-history", gestureId: "11111111-1111-4111-8111-111111111111", method: "individual", targets: [{ sectionKey: "social-history", sectionId: "tobacco" }], patientReference: "Patient/ros-test", encounterReference: "Encounter/old", actorReference: "Practitioner/test", recordedAt: "2019-02-06T12:00:00Z" }), id: "old-review" };
  const s = historyRosFixture([seed]);
  const statuses: number[] = [], posted: any[] = [];
  const server = await createServer({ root: resolve(import.meta.dirname, ".."), logLevel: "silent", server: { host: "127.0.0.1", port: 0 }, plugins: [{
    name: "ros-proof",
    resolveId(id) { if (id === "/ros-proof.js") return id; },
    load(id) { if (id === "/ros-proof.js") return `import React from 'react'; import {createRoot} from 'react-dom/client'; import {HpiSection} from '/src/components/charting/HpiSection.tsx'; import '/src/styles/globals.css'; createRoot(document.getElementById('root')).render(React.createElement(HpiSection,{patientReference:'Patient/ros-test',encounterReference:'Encounter/current',onSaved:()=>{}}));`; },
    configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
      if (req.url === "/ros-proof") { res.setHeader("Content-Type", "text/html"); res.end(await vite.transformIndexHtml(req.url, '<html><body><div id="root"></div><script type="module" src="/ros-proof.js"></script></body></html>')); return; }
      if (!req.url?.startsWith("/clinical-graph/")) return next();
      try {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
        const input = { authHeader: "synthetic", body, params: { encounterId: "current" } };
        let result: { status: number; body: any };
        if (req.url.endsWith("/definition")) result = await api.handleHpiDefinitionRequest(s.deps, input);
        else if (req.url.endsWith("/complaints")) result = { status: 200, body: { complaints: followUp ? [{ id: "c1", ordinal: 1, templateKey: "glaucoma", renderedNarrative: "Glaucoma follow-up" }] : [] } };
        else if (req.url.endsWith("/history/items")) result = await api.handleHistoryItemActsRequest(s.deps, input);
        else if (req.url.endsWith("/items/review")) { posted.push(body); result = await api.handleHistoryItemReviewRequest(s.deps, input); }
        else if (req.url.endsWith("/items/retract")) { posted.push(body); result = await api.handleHistoryItemRetractionRequest(s.deps, input); }
        else if (req.url.endsWith("/void")) result = await handleEncounterVoidRequest(s.deps, input);
        else if (req.method === "POST") { posted.push(body); await new Promise(r => setTimeout(r, 150)); result = await api.handleHpiCaptureRequest(s.deps, input); }
        else {
          result = await api.handleHpiRecordRequest(s.deps, input);
          if (followUp) result.body.answers.push({ id: "presentation", complaintId: "c1", templateKey: "glaucoma", sectionId: "presentation", value: { kind: "selection", code: "follow-up" } });
        }
        statuses.push(result.status); res.statusCode = result.status; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(result.body));
      } catch (error) { res.statusCode = 500; res.end(JSON.stringify({error: String(error)})); }
    }); },
  }] });
  await server.listen(); const address = server.httpServer!.address(); assert.ok(address && typeof address !== "string");
  const browser = await chromium.launch({ channel: "chrome", args: process.platform === "linux" ? ["--no-sandbox"] : [] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(`http://127.0.0.1:${address.port}/ros-proof`);
    const social = page.getByTestId("history-social-history");
    await social.waitFor({ timeout: 5000 });
    const reminder = social.getByText("Tobacco status not documented this performance period.", { exact: true });
    await reminder.waitFor();
    const tobacco = social.locator('[data-history-item="social-history|tobacco||"]');
    assert.match(await tobacco.innerText(), /02\/06\/2019/);
    assert.equal(await tobacco.locator('[data-stale="true"]').count(), 1);
    await tobacco.getByRole("checkbox").click();
    await page.waitForFunction(() => (document.querySelector('[data-history-item="social-history|tobacco||"] input') as HTMLInputElement)?.checked);
    assert.equal(await reminder.count(), 1);
    assert.match(await social.innerText(), /Not started/);
    assert.deepEqual(posted.find(p => p.action === "items-reviewed").targets, [{ sectionKey: "social-history", sectionId: "tobacco" }]);
    assert.match(await tobacco.innerText(), /09\/05\/2026/);
    await page.reload(); await social.waitFor(); await reminder.waitFor();
    await social.getByRole("button", { name: "Never: unselected", exact: true }).click();
    await reminder.waitFor({ state: "detached", timeout: 10000 });
    assert.match(await social.innerText(), /Started/);
    const result = await api.handleHpiRecordRequest(s.deps, { authHeader: "synthetic", params: { encounterId: "current" } });
    assert.equal((result.body as any).answers.filter((a:any) => a.templateKey === "social-history").length, 1);
    await social.getByRole("button", { name: "Never: selected", exact: true }).click();
    await reminder.waitFor({ timeout: 10000 });
    assert.equal(await tobacco.getByRole("checkbox").isChecked(), true);
    const clear = social.getByRole("button", { name: "Clear Social History", exact: true });
    assert.equal(await clear.count(), 1, "a review-only Social section remains clearable");
    page.on("dialog", dialog => dialog.accept());
    await clear.click();
    await page.waitForFunction(() => !(document.querySelector('[data-history-item="social-history|tobacco||"] input') as HTMLInputElement)?.checked);
    assert.equal(await reminder.count(), 1);
    const ros = page.getByTestId("history-review-of-systems");
    assert.doesNotMatch(await ros.innerText(), /\d+ of \d+ items reviewed|Review method:|· bulk/);
    assert.equal(await ros.locator('[data-ros-item="headache"] [data-stale="true"]').count(), 1);
    if (process.env.HISTORY_SOCIAL_CAPTURE) { await mkdir(resolve(process.env.HISTORY_SOCIAL_CAPTURE, ".."), { recursive: true }); await social.screenshot({path: process.env.HISTORY_SOCIAL_CAPTURE}); }
    assert.ok(statuses.every(s => s === 200), JSON.stringify(statuses));
  } finally { await browser.close(); await server.close(); }
});
