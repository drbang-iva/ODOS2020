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

for (const scenario of ["comprehensive burst and explicit immutable reviews", "follow-up self-folds", "review-only History clear", "bulk denial is resumable and transient"]) test(`ROS browser: ${scenario}`, async () => {
  const followUp = scenario === "follow-up self-folds";
  const seed = { ...buildHistoryItemReview({ sectionKey: "review-of-systems", gestureId: "11111111-1111-4111-8111-111111111111", method: "individual", targets: [{ sectionKey: "review-of-systems", sectionId: "systems", optionCode: "scalp-tenderness" }], patientReference: "Patient/ros-test", encounterReference: "Encounter/old", actorReference: "Practitioner/test", recordedAt: "2019-02-06T12:00:00Z" }), id: "old-review" };
  const s = historyRosFixture([seed]);
  const statuses: number[] = [], posted: any[] = [];
  let releaseFinalBulkUnit = () => undefined;
  let markFinalBulkUnitHeld = () => undefined;
  let orderProofEnabled = false;
  let orderProofReads = 0;
  let releaseOrderProofStale = () => undefined;
  let markOrderProofStaleCaptured = () => undefined;
  const finalBulkUnitReleased = new Promise<void>(resolve => { releaseFinalBulkUnit = resolve; });
  const finalBulkUnitHeld = new Promise<void>(resolve => { markFinalBulkUnitHeld = resolve; });
  const orderProofStaleReleased = new Promise<void>(resolve => { releaseOrderProofStale = resolve; });
  const orderProofStaleCaptured = new Promise<void>(resolve => { markOrderProofStaleCaptured = resolve; });
  const server = await createServer({ root: resolve(import.meta.dirname, ".."), logLevel: "silent", server: { host: "127.0.0.1", port: 0 }, plugins: [{
    name: "ros-proof",
    resolveId(id) { if (id === "/ros-proof.js") return id; },
    load(id) {
      if (id === "/ros-proof.js") {
        const proof = scenario === "bulk denial is resumable and transient" ? ",React.createElement(Proof)" : "";
        return `import React,{useState} from 'react'; import {createRoot} from 'react-dom/client'; import {HpiSection} from '/src/components/charting/HpiSection.tsx'; import {useHistoryItemReview} from '/src/components/charting/useHistoryItemReview.tsx'; import '/src/styles/globals.css'; function Proof(){const [done,setDone]=useState(0); const review=useHistoryItemReview({patientReference:'Patient/ros-test',encounterReference:'Encounter/current',historyVersion:0,onChanged:()=>{},enabled:true}); return React.createElement('aside',null,React.createElement('span',{'data-order-proof-ready':review.ready},'proof completed '+done),React.createElement('button',{onClick:()=>void review.refresh().then(()=>setDone(v=>v+1))},'Refresh order proof'),review.bulkProgress&&React.createElement('span',{'data-order-proof-progress':true},review.bulkProgress.recorded+' of '+review.bulkProgress.total+' recorded'));} createRoot(document.getElementById('root')).render(React.createElement(React.Fragment,null,React.createElement(HpiSection,{patientReference:'Patient/ros-test',encounterReference:'Encounter/current',onSaved:()=>{}})${proof}));`;
      }
    },
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
        else if (req.url.endsWith("/history/items")) {
          if (orderProofEnabled) {
            orderProofReads += 1;
            result = { status: 200, body: { reviews: [], retractions: [], bulkDenials: orderProofReads === 1 ? [{ sectionKey: "review-of-systems", gestureId: "stale", status: "in-progress", recorded: 7, total: 53, persistedTargets: [], targets: [{ sectionKey: "review-of-systems", sectionId: "systems", optionCode: "eye-pain" }] }] : [] } };
            if (orderProofReads === 1) { markOrderProofStaleCaptured(); await orderProofStaleReleased; }
          } else result = await api.handleHistoryItemActsRequest(s.deps, input);
        }
        else if (req.url.endsWith("/items/review")) { posted.push(body); result = await api.handleHistoryItemReviewRequest(s.deps, input); }
        else if (req.url.endsWith("/items/retract")) { posted.push(body); result = await api.handleHistoryItemRetractionRequest(s.deps, input); }
        else if (req.url.endsWith("/void")) result = await handleEncounterVoidRequest(s.deps, input);
        else if (req.method === "POST") { posted.push(body); await new Promise(r => setTimeout(r, 150)); result = await api.handleHpiCaptureRequest(s.deps, input); }
        else {
          result = await api.handleHpiRecordRequest(s.deps, input);
          if (followUp) result.body.answers.push({ id: "presentation", complaintId: "c1", templateKey: "glaucoma", sectionId: "presentation", value: { kind: "selection", code: "follow-up" } });
        }
        statuses.push(result.status); res.statusCode = result.status; res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result.body));
      } catch (error) { res.statusCode = 500; res.end(JSON.stringify({error: String(error)})); }
    }); },
  }] });
  await server.listen(); const address = server.httpServer!.address(); assert.ok(address && typeof address !== "string");
  const browser = await chromium.launch({ channel: "chrome", args: process.platform === "linux" ? ["--no-sandbox"] : [] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(`http://127.0.0.1:${address.port}/ros-proof`);
    const ros = page.getByTestId("history-review-of-systems"); await ros.waitFor({ timeout: 5000 });
    const fold = ros.getByRole("button", { name: /Review of Systems/ });
    assert.equal(await fold.getAttribute("aria-expanded"), String(!followUp));
    if (followUp) { assert.match(await ros.innerText(), /Complaint-directed/); assert.equal(await ros.getByRole("table").count(), 0); await fold.click(); }
    await ros.getByRole("table").waitFor(); assert.equal(await ros.locator('[data-ros-system]').count(), 14);
    assert.equal(await ros.getByRole("button", { name: /Mark all/ }).count(), 0);
    if (followUp) return;
    if (scenario === "bulk denial is resumable and transient") {
      const positive = ros.locator('[data-ros-item="eye-pain"]');
      await positive.getByRole("button", { name: "Yes: eye pain" }).click();
      await page.waitForFunction(() => document.querySelector('[data-testid="history-review-of-systems"]')?.textContent?.includes("saved · just now"));
      s.failTransactionAt(s.transactionAttempts() + 2);
      const bulk = ros.getByTestId("history-bulk-denial");
      assert.equal(await bulk.count(), 1);
      assert.equal(await bulk.getAttribute("class").then(value => value?.includes("min-h-11")), true);
      await bulk.click();
      await ros.getByRole("status").filter({ hasText: "of 53 recorded" }).waitFor();
      await ros.getByRole("button", { name: "Resume marking unanswered No" }).waitFor();
      assert.match(await ros.getByRole("alert").innerText(), /7 of 53 recorded/);
      s.failTransactionAt(undefined);
      s.raceAt(s.transactionAttempts() + 7, async () => { markFinalBulkUnitHeld(); await finalBulkUnitReleased; });
      await ros.getByRole("button", { name: "Resume marking unanswered No" }).click();
      await finalBulkUnitHeld;
      assert.equal(await bulk.isDisabled(), true);
      const pendingYesResponse = page.waitForResponse(response => {
        if (response.request().method() !== "POST") return false;
        const body = response.request().postDataJSON();
        return body?.templateAnswers?.some((answer: any) => answer.optionCode === "poor-vision" && answer.value?.status === "positive");
      }, { timeout: 3000 });
      await ros.locator('[data-ros-item="poor-vision"]').getByRole("button", { name: "Yes: poor vision" }).click();
      releaseFinalBulkUnit();
      await page.waitForFunction(() => !document.querySelector('[data-history-bulk-progress]'));
      await pendingYesResponse;
      assert.equal(await ros.getByText(/of 53 recorded/).count(), 0);
      const saved = await api.handleHpiRecordRequest(s.deps, { authHeader: "synthetic", params: { encounterId: "current" } });
      assert.equal((saved.body as any).answers.length, 54);
      assert.equal((saved.body as any).answers.find((answer: any) => answer.optionCode === "eye-pain").value.status, "positive");
      assert.equal((saved.body as any).answers.find((answer: any) => answer.optionCode === "poor-vision").value.status, "positive");
      const act = s.rows.find((row): row is Observation => row.resourceType === "Observation" && row.encounter?.reference === "Encounter/current" && row.code.coding?.some(coding => coding.code === HISTORY_ITEM_REVIEW_CODE));
      assert.ok(act); assert.equal(parseHistoryItemReview(act).targets.length, 53);
      await page.locator('[data-order-proof-ready="true"]').waitFor();
      orderProofEnabled = true;
      await page.getByRole("button", { name: "Refresh order proof" }).click();
      await orderProofStaleCaptured;
      await page.getByRole("button", { name: "Refresh order proof" }).click();
      await page.getByText("proof completed 1").waitFor();
      releaseOrderProofStale();
      await page.getByText("proof completed 2").waitFor();
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      assert.equal(await page.locator('[data-order-proof-progress]').count(), 0);
      return;
    }
    if (scenario === "review-only History clear") {
      const clear = page.getByRole("button", { name: "Clear History", exact: true });
      assert.equal(await clear.count(), 0);
      const row = ros.locator('[data-ros-item="headache"]');
      await row.getByRole("checkbox").click();
      await page.waitForFunction(() => (document.querySelector('[data-ros-item="headache"] input') as HTMLInputElement)?.checked);
      assert.equal(await clear.count(), 1, "a persisted review without answers must enable History clear");
      await page.reload(); await ros.waitFor();
      await page.waitForFunction(() => (document.querySelector('[data-ros-item="headache"] input') as HTMLInputElement)?.checked);
      assert.equal(await clear.count(), 1, "rehydrated item acts must enable History clear");
      await row.getByRole("checkbox").click();
      await row.getByRole("button", { name: /Undo/ }).waitFor();
      assert.equal(await clear.count(), 1, "retracted reviews remain recorded and clearable");
      page.on("dialog", dialog => dialog.accept());
      await clear.click();
      await row.getByRole("button", { name: /Undo/ }).waitFor({ state: "detached" });
      assert.equal(await clear.count(), 0);
      const record = await api.handleHistoryItemActsRequest(s.deps, { authHeader: "synthetic", params: { encounterId: "current" } });
      assert.deepEqual((record.body as any).reviews, []);
      assert.deepEqual((record.body as any).retractions, []);
      assert.equal(s.rows.filter(r => r.resourceType === "Observation" && r.encounter?.reference === "Encounter/current" && r.status === "entered-in-error").length, 2);
      return;
    }
    assert.match(await ros.locator('[data-ros-item="scalp-tenderness"]').innerText(), /02\/06\/2019/);
    assert.equal(await ros.locator('[data-ros-item="scalp-tenderness"] [data-stale="true"]').count(), 1);
    await ros.getByRole("button", { name: /^No: / }).evaluateAll(buttons => buttons.slice(0, 10).forEach(button => (button as HTMLButtonElement).click()));
    await page.waitForFunction(() => document.querySelector('[data-testid="history-review-of-systems"]')?.textContent?.includes('saved · just now') || Boolean(document.querySelector('[role="alert"]')), undefined, { timeout: 12000 });
    assert.equal(statuses.includes(413), false, `Burst returned HTTP 413: ${statuses}`);
    const saved = await api.handleHpiRecordRequest(s.deps, { authHeader: "synthetic", params: { encounterId: "current" } });
    assert.equal((saved.body as any).answers.length, 10, "all ten rapid taps must persist");
    const acts = () => s.rows.filter((r): r is Observation => r.resourceType === "Observation" && r.encounter?.reference === "Encounter/current" && r.code.coding?.some(c => c.code === HISTORY_ITEM_REVIEW_CODE) === true);
    assert.equal(acts().length, 0, "answering must write zero review acts");
    const row = ros.locator('[data-ros-item="headache"]');
    await row.getByRole("checkbox", { name: "Reviewed: headache" }).click();
    await page.waitForFunction(() => document.querySelector('[data-ros-item="headache"]')?.textContent?.includes('09/05/2026'));
    assert.equal(acts().length, 1); assert.deepEqual(parseHistoryItemReview(acts()[0]), { method: "individual", targets: [{sectionKey:"review-of-systems",sectionId:"systems",optionCode:"headache"}] });
    const original = structuredClone(acts()[0]);
    await page.reload(); await ros.waitFor();
    await row.getByRole("checkbox", { name: "Reviewed: headache" }).click();
    await row.getByRole("button", { name: /Undo/ }).waitFor(); assert.match(await row.innerText(), /Never asked/);
    assert.deepEqual(s.rows.find(r => r.id === original.id), original, "unmark must never edit the original act");
    await row.getByRole("button", { name: /Undo/ }).click();
    await page.waitForFunction(() => document.querySelector('[data-ros-item="headache"]')?.textContent?.includes('09/05/2026'));
    assert.deepEqual(s.rows.find(r => r.id === original.id), original);
    if (process.env.HISTORY_ROS_CAPTURE) { await mkdir(resolve(process.env.HISTORY_ROS_CAPTURE, ".."), {recursive:true}); await ros.screenshot({ path: process.env.HISTORY_ROS_CAPTURE }); }
    console.log(`ROS: 10 persisted answers, 0 answer-side acts; 1 tick; immutable retraction/undo; HTTP ${[...new Set(statuses)]}; delta sizes ${posted.filter(p=>p.templateAnswers).map(p=>p.templateAnswers.length)}`);
  } finally { await browser.close(); await server.close(); }
});
