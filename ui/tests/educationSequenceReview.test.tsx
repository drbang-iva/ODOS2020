import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer as createHttpServer } from "node:http";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "playwright-core";

test("education review uses the real route, proxy, client, and server capabilities", async (t) => {
  const baseItem = { id: "work-1", enrollmentId: "enrollment-1", rowId: "row-1", reason: "patient-seen", patientReference: "Patient/synthetic-1", at: "2026-09-10T12:00:00Z", state: "open", expectedVersion: "7", disposition: "held", holdReason: "patient-seen", channel: "sms", encounterReference: "Encounter/synthetic-visit", allowedActions: ["resume", "skip"] };
  let items: Array<Omit<typeof baseItem, "allowedActions"> & { allowedActions?: string[] }> = [{ ...baseItem }];
  let conflict = false;
  const posts: unknown[] = [];
  const upstream = createHttpServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/communications/education/sequence-work") { res.end(JSON.stringify({ items })); return; }
    if (req.method === "POST" && req.url === "/communications/education/enrollments/enrollment-1/scheduled-sends/row-1/review") {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      posts.push(JSON.parse(Buffer.concat(chunks).toString()));
      if (conflict) { res.statusCode = 409; res.end(JSON.stringify({ outcome: "refused", reason: "stale-enrollment-version" })); return; }
      items = items.map(item => ({ ...item, state: "settled", allowedActions: [], expectedVersion: "8" }));
      res.end(JSON.stringify({ enrollment: { id: "enrollment-1" }, expectedVersion: "8" })); return;
    }
    res.statusCode = 404; res.end(JSON.stringify({ error: "No synthetic backend route" }));
  });
  await new Promise<void>(done => upstream.listen(0, "127.0.0.1", done));
  const upstreamAddress = upstream.address(); assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
  const server = await createServer({ root: resolve(import.meta.dirname, ".."), logLevel: "silent", server: { host: "127.0.0.1", port: 0, proxy: { "/communications": { target: `http://127.0.0.1:${upstreamAddress.port}` } } }, plugins: [{
    name: "education-review-route-proof",
    transformIndexHtml(html) { return html.replace('/src/main.tsx', '/review-proof.js'); },
    resolveId(id) { if (id === "/review-proof.js") return id; },
    load(id) { if (id === "/review-proof.js") return `import React from 'react'; import {createRoot} from 'react-dom/client'; import {RouteSwitch} from '/src/App.tsx'; import {AppShell} from '/src/components/AppShell.tsx'; import '/src/styles/globals.css'; const roles = new URLSearchParams(location.search).has('staff') ? ['staff'] : ['provider']; createRoot(document.getElementById('root')).render(React.createElement(AppShell,{path:location.pathname,roles,homePath:'/clinic',side:'clinic',email:'synthetic@example.test'},React.createElement(RouteSwitch,{view:{kind:'picker'},path:location.pathname,roles})));`; },
  }] });
  await server.listen(); const address = server.httpServer!.address(); assert.ok(address && typeof address !== "string");
  const browser = await chromium.launch({ channel: "chrome", args: process.platform === "linux" ? ["--no-sandbox"] : [] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    const url = `http://127.0.0.1:${address.port}/communications/education/review`;
    await t.test("direct navigation and Sections link reach the page; reason and encounter review are required", async () => {
      const jsonResponse = await fetch(url, { headers: { Accept: "application/json" } });
      assert.equal(jsonResponse.status, 404, "API-shaped request stays at backend");
      const otherDocument = await fetch(`${url}/other`, { headers: { Accept: "text/html" } });
      assert.equal(otherDocument.status, 404, "other communications documents are not bypassed");
      const response = await page.goto(url); assert.equal(response?.status(), 200);
      await page.getByRole("heading", { name: "Education sequence review", exact: true }).waitFor({ timeout: 10000 });
      await page.getByRole("button", { name: "Sections", exact: true }).click();
      assert.equal(await page.getByRole("link", { name: /Education review/ }).getAttribute("href"), "/communications/education/review");
      await page.getByRole("button", { name: "Close sections", exact: true }).last().click();
      const resume = page.getByRole("button", { name: "Resume sequence step", exact: true });
      await resume.waitFor(); assert.equal(await resume.isDisabled(), true);
      await page.getByRole("textbox", { name: "Clinician reason", exact: true }).fill("Reviewed the new visit; continue this step.");
      assert.equal(await resume.isDisabled(), true, "patient-seen resume requires explicit review of the held encounter");
      await page.getByRole("checkbox", { name: /I reviewed Encounter\/synthetic-visit/ }).check();
      if (process.env.EDUCATION_REVIEW_CAPTURE) {
        await mkdir(resolve(process.env.EDUCATION_REVIEW_CAPTURE, ".."), { recursive: true });
        await page.screenshot({ path: process.env.EDUCATION_REVIEW_CAPTURE, fullPage: true, animations: "disabled" });
      }
      await resume.click();
      await page.getByRole("status").filter({ hasText: "Review recorded" }).waitFor();
      assert.deepEqual(posts, [{ action: "resume", reason: "Reviewed the new visit; continue this step.", expectedVersion: "7", reviewedEncounterReference: "Encounter/synthetic-visit" }]);
      assert.equal(await resume.count(), 0);
    });
    await t.test("409 stays visible and blocks repeat actions until a fresh list is loaded", async () => {
      items = [{ ...baseItem }]; conflict = true; await page.reload();
      await page.getByRole("textbox", { name: "Clinician reason", exact: true }).fill("Clinician reviewed this step.");
      await page.getByRole("button", { name: "Skip sequence step", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: /409.*stale-enrollment-version/ }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Skip sequence step", exact: true }).isDisabled(), true);
      await page.getByRole("button", { name: "Refresh review list", exact: true }).click();
      await page.getByRole("textbox", { name: "Clinician reason", exact: true }).fill("Reviewed the refreshed record.");
      assert.equal(await page.getByRole("button", { name: "Skip sequence step", exact: true }).isEnabled(), true);
      conflict = false;
    });
    await t.test("staff can read work without clinician controls even if capabilities are returned", async () => {
      await page.goto(`${url}?staff=1`);
      await page.getByText("Patient/synthetic-1", { exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: /sequence step/ }).count(), 0);
      assert.equal(await page.getByRole("textbox", { name: "Clinician reason", exact: true }).count(), 0);
    });
    await t.test("missing capabilities and settled work cannot expose clinician actions", async () => {
      items = [{ ...baseItem, allowedActions: undefined }]; await page.goto(url);
      await page.getByText("No review action is currently available for this item.", { exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: /sequence step/ }).count(), 0);
      items = [{ ...baseItem, state: "settled" }]; await page.reload();
      await page.getByText("Review settled", { exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: /sequence step/ }).count(), 0);
    });
    await t.test("unavailable capabilities stay read-only and print work is a handout task", async () => {
      const priorPosts = posts.length;
      items = [{ ...baseItem, channel: "print", reason: "print-staff-task", allowedActions: [] }];
      await page.goto(url);
      await page.getByText("Staff handout task", { exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: /sequence step/ }).count(), 0);
      assert.equal(posts.length, priorPosts);
      if (process.env.EDUCATION_REVIEW_CAPTURE) {
        await mkdir(resolve(process.env.EDUCATION_REVIEW_CAPTURE, ".."), { recursive: true });
        await page.screenshot({ path: process.env.EDUCATION_REVIEW_CAPTURE.replace(/\.png$/, "-handout.png"), fullPage: true, animations: "disabled" });
      }
    });
  } finally { await browser.close(); await server.close(); await new Promise<void>(done => upstream.close(() => done())); }
});
