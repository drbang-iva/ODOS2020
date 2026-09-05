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

for (const scenario of ["comprehensive burst and explicit immutable reviews", "follow-up self-folds", "review-only History clear"]) test(`ROS browser: ${scenario}`, async () => {
  const followUp = scenario === "follow-up self-folds";
  const seed = { ...buildHistoryItemReview({ sectionKey: "review-of-systems", gestureId: "11111111-1111-4111-8111-111111111111", method: "individual", targets: [{ sectionKey: "review-of-systems", sectionId: "systems", optionCode: "scalp-tenderness" }], patientReference: "Patient/ros-test", encounterReference: "Encounter/old", actorReference: "Practitioner/test", recordedAt: "2019-02-06T12:00:00Z" }), id: "old-review" };
  const s = historyRosFixture([seed]);
  const statuses: number[] = [], posted: any[] = [];
  let releaseFinalBulkUnit = () => undefined;
  let markFinalBulkUnitHeld = () => undefined;
  const finalBulkUnitReleased = new Promise<void>(resolve => { releaseFinalBulkUnit = resolve; });
  const finalBulkUnitHeld = new Promise<void>(resolve => { markFinalBulkUnitHeld = resolve; });
  const actHold = deferred(), historyHold = deferred(), ownerHold = deferred(), autosaveHold = deferred();
  let holdFinalHistory = false;
  let holdAutosave = false;
  const server = await createServer({ root: resolve(import.meta.dirname, ".."), logLevel: "silent", server: { host: "127.0.0.1", port: 15364, strictPort: true }, plugins: [{
    name: "ros-proof",
    resolveId(id) { if (id === "/ros-proof.js") return id; },
    load(id) {
      if (id === "/ros-proof.js") {
        const proof = scenario === "comprehensive burst and explicit immutable reviews" ? ",React.createElement(OwnerProof)" : "";
        return `import React,{useState} from 'react'; import {createRoot} from 'react-dom/client'; import {HpiSection} from '/src/components/charting/HpiSection.tsx'; import {ClearEncounterButton} from '/src/components/charting/ClearControls.tsx'; import {useHistoryItemReview} from '/src/components/charting/useHistoryItemReview.tsx'; import {useSectionWriteBusy} from '/src/components/charting/encounter-edit-context.tsx'; import '/src/styles/globals.css'; function OwnerProof(){const [encounter,setEncounter]=useState('Encounter/obsolete'),[applied,setApplied]=useState(false),[settled,setSettled]=useState(false); const review=useHistoryItemReview({patientReference:'Patient/ros-test',encounterReference:encounter,historyVersion:0,onChanged:()=>{},enabled:true}); const obsoleteBusy=useSectionWriteBusy('Encounter/obsolete',['review-of-systems']); return React.createElement('aside',null,React.createElement('span',{'data-obsolete-lease':true},obsoleteBusy?'held':'free'),React.createElement('button',{disabled:!review.ready,onClick:()=>void review.bulkDeny([{sectionKey:'review-of-systems',sectionId:'systems',optionCode:'eye-pain'}],{onRecorded:()=>setApplied(true)}).then(()=>setSettled(true))},'Start obsolete request'),React.createElement('button',{onClick:()=>setEncounter('Encounter/replacement')},'Change request owner'),applied&&React.createElement('span',null,'obsolete response applied'),settled&&React.createElement('span',null,'obsolete request settled'));} createRoot(document.getElementById('root')).render(React.createElement(React.Fragment,null,React.createElement(ClearEncounterButton,{encounterReference:'Encounter/current',encounterStatus:'in-progress',onCleared:()=>{}}),React.createElement(HpiSection,{patientReference:'Patient/ros-test',encounterReference:'Encounter/current',onSaved:()=>{}})${proof}));`;
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
        if (body?.encounterReference === "Encounter/obsolete") {
          ownerHold.mark(); await ownerHold.released;
          res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ status: "complete" })); return;
        }
        if (req.url.endsWith("/definition")) result = await api.handleHpiDefinitionRequest(s.deps, input);
        else if (req.url.endsWith("/complaints")) result = { status: 200, body: { complaints: followUp ? [{ id: "c1", ordinal: 1, templateKey: "glaucoma", renderedNarrative: "Glaucoma follow-up" }] : [] } };
        else if (req.url.endsWith("/history/items")) result = await api.handleHistoryItemActsRequest(s.deps, input);
        else if (req.url.endsWith("/items/review")) { posted.push(body); result = await api.handleHistoryItemReviewRequest(s.deps, input); }
        else if (req.url.endsWith("/items/retract")) { posted.push(body); result = await api.handleHistoryItemRetractionRequest(s.deps, input); }
        else if (req.url.endsWith("/void")) result = await handleEncounterVoidRequest(s.deps, input);
        else if (req.method === "POST") {
          posted.push(body);
          if (holdAutosave && body?.templateAnswers?.some((answer: any) => answer.optionCode === "hives")) {
            holdAutosave = false; autosaveHold.mark(); await autosaveHold.released;
          }
          await new Promise(r => setTimeout(r, 150)); result = await api.handleHpiCaptureRequest(s.deps, input);
        }
        else {
          result = await api.handleHpiRecordRequest(s.deps, input);
          if (followUp) result.body.answers.push({ id: "presentation", complaintId: "c1", templateKey: "glaucoma", sectionId: "presentation", value: { kind: "selection", code: "follow-up" } });
          if (holdFinalHistory) { historyHold.mark(); await historyHold.released; }
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

    const bulk = ros.getByTestId("history-bulk-denial");
    assert.equal(await bulk.count(), 1);
    s.failTransactionAt(s.transactionAttempts() + 2);
    const partialResponse = page.waitForResponse(response => response.url().endsWith("/history/items/review") && response.request().method() === "POST");
    await bulk.click();
    assert.equal((await partialResponse).status(), 503);
    await ros.getByRole("button", { name: "Mark unanswered No", exact: true }).waitFor();
    assert.equal(await ros.getByRole("button", { name: "Resume marking unanswered No" }).count(), 0,
      "a failed click must return to live unanswered targets, not stale resume state");
    assert.equal(await ros.locator('[data-history-bulk-progress]').count(), 0, "retired progress UI must stay absent");
    assert.equal(await ros.locator('[data-ros-item="hives"]').getByRole("button", { name: "Yes: hives" }).isEnabled(), true,
      "a failed click must restore row editing");

    s.failTransactionAt(undefined);
    holdAutosave = true;
    const hives = ros.locator('[data-ros-item="hives"]');
    await hives.getByRole("button", { name: "Yes: hives" }).click();
    const beforeSecond = s.transactionAttempts();
    s.raceAt(beforeSecond + 7, async () => { markFinalBulkUnitHeld(); await finalBulkUnitReleased; });
    s.raceAt(beforeSecond + 8, async () => { actHold.mark(); await actHold.released; holdFinalHistory = true; });
    const secondResponse = page.waitForResponse(response => response.url().endsWith("/history/items/review") && response.request().method() === "POST");
    await bulk.click();
    await autosaveHold.held;
    assert.equal(posted.filter(body => body.method === "bulk").length, 1,
      "the next gesture must wait for the explicit Yes to persist");
    assert.equal(await hives.getByRole("button", { name: "Yes: hives" }).isDisabled(), true,
      "rows freeze while the gesture owns the section");
    autosaveHold.release();

    assert.equal(await Promise.race([
      finalBulkUnitHeld.then(() => "final unit held"),
      secondResponse.then(response => `unexpected HTTP ${response.status()}`),
    ]), "final unit held");
    const rowEditors = ros.locator('tbody button, tbody input, textarea');
    assert.ok(await rowEditors.count() > 150);
    assert.equal(await rowEditors.evaluateAll(elements => elements.every(element => element.matches(':disabled'))), true,
      "every ROS row editor stays frozen while the final answer unit is held");
    assert.equal(await page.getByRole("button", { name: "Clear History", exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Clear chart", exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Glaucoma", exact: true }).isEnabled(), true,
      "another section remains editable");
    const postCount = posted.length;
    await rowEditors.evaluateAll(elements => elements.forEach(element => { if (element instanceof HTMLButtonElement) element.click(); }));
    assert.equal(posted.length, postCount, "disabled row controls must not dispatch a write");
    if (process.env.HISTORY_BULK_CAPTURE) {
      await mkdir(process.env.HISTORY_BULK_CAPTURE, { recursive: true });
      await page.screenshot({ path: resolve(process.env.HISTORY_BULK_CAPTURE, "bulk-busy.png") });
    }

    releaseFinalBulkUnit();
    await actHold.held;
    assert.equal(await rowEditors.evaluateAll(elements => elements.every(element => element.matches(':disabled'))), true,
      "rows stay frozen until the act commits");
    actHold.release();
    await historyHold.held;
    assert.equal(await rowEditors.evaluateAll(elements => elements.every(element => element.matches(':disabled'))), true,
      "rows stay frozen until the committed response is applied");
    const atCommit = await api.handleHpiRecordRequest(s.deps, { authHeader: "synthetic", params: { encounterId: "current" } });
    assert.equal((atCommit.body as any).answers.filter((answer: any) => answer.value.status === "negative").length, 53);
    assert.equal((atCommit.body as any).answers.find((answer: any) => answer.optionCode === "hives").value.status, "positive");
    holdFinalHistory = false;
    historyHold.release();
    await page.waitForFunction(() => !document.querySelector('[data-ros-item="hives"] button')?.matches(':disabled'));

    const bulkRequests = posted.filter(body => body.method === "bulk");
    assert.equal(bulkRequests.length, 2);
    assert.notEqual(bulkRequests[0].gestureId, bulkRequests[1].gestureId, "each click is a new gesture");
    assert.equal(bulkRequests[0].targets.length, 44);
    assert.equal(bulkRequests[1].targets.length, 36);
    assert.equal(bulkRequests[1].targets.some((target: any) => target.optionCode === "hives"), false,
      "the second click recomputes targets after the intervening Yes");
    const bulkActs = acts().filter(act => parseHistoryItemReview(act).method === "bulk");
    assert.deepEqual(bulkActs.map(act => parseHistoryItemReview(act).targets.length), [7, 36],
      "each act covers only negatives persisted by its own click");
    assert.equal(await ros.getByText(/of \d+ recorded/).count(), 0);
    if (process.env.HISTORY_BULK_CAPTURE) await page.screenshot({ path: resolve(process.env.HISTORY_BULK_CAPTURE, "bulk-complete.png") });

    await page.getByRole("button", { name: "Start obsolete request" }).click();
    await ownerHold.held;
    await page.getByRole("button", { name: "Change request owner" }).click();
    ownerHold.release();
    await page.getByText("obsolete request settled").waitFor();
    assert.equal(await page.getByText("obsolete response applied").count(), 0, "a response cannot repaint after its request loses ownership");
    assert.equal(await page.locator('[data-obsolete-lease]').innerText(), "held",
      "a lost request owner cannot release the in-flight section lease");
    if (process.env.HISTORY_ROS_CAPTURE) { await mkdir(resolve(process.env.HISTORY_ROS_CAPTURE, ".."), {recursive:true}); await ros.screenshot({ path: process.env.HISTORY_ROS_CAPTURE }); }
    console.log(`ROS: 54 answers; per-click bulk acts 7/36; immutable retraction/undo; HTTP ${[...new Set(statuses)]}; delta sizes ${posted.filter(p=>p.templateAnswers).map(p=>p.templateAnswers.length)}`);
  } finally { releaseFinalBulkUnit(); actHold.release(); historyHold.release(); ownerHold.release(); autosaveHold.release(); await browser.close(); await server.close(); }
});

function deferred() {
  let mark!: () => void, release!: () => void;
  const held = new Promise<void>(resolve => { mark = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  return { held, released, mark, release };
}
