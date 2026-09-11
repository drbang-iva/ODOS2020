import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create } from "react-test-renderer";
import { RouteSwitch } from "../src/App";
import { AppShell, breadcrumbItems } from "../src/components/AppShell";
import type { PracticeRoleId } from "../src/lib/practice-roles";
import { createServer as createHttpServer } from "node:http";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const route = "/communications/consent-evidence";
const gap = { patientReference: "Patient/synthetic-one", purpose: "marketing-promo", channel: "sms", tier: 1, source: "explicit" };
const first = { rows: [gap], suppressed: [{ ...gap, patientReference: "Patient/synthetic-stop", source: "suppression" }], counts: { "1": 1, "2": 0, "3": 0 }, truncated: true, cursor: "synthetic_cursor" };
const second = { rows: [{ ...gap, patientReference: "Patient/synthetic-two" }], suppressed: [], counts: { "1": 1, "2": 0, "3": 0 }, truncated: false };
function text(renderer: ReturnType<typeof create>): string { return renderer.root.findAll(() => true).flatMap(node => node.children.filter((child): child is string => typeof child === "string")).join(" "); }
function button(renderer: ReturnType<typeof create>, label: string) { return renderer.root.findAllByType("button").find(node => node.children.includes(label))!; }
async function mount(roles: readonly PracticeRoleId[], fetcher: typeof fetch, check: (renderer: ReturnType<typeof create>) => Promise<void>) {
  const prior = globalThis.fetch; globalThis.fetch = fetcher; let renderer!: ReturnType<typeof create>;
  try { await act(async () => { renderer = create(<AppShell path={route} roles={roles} homePath="/clinic" side="clinic" email="synthetic@example.test"><RouteSwitch path={route} view={{ kind: "picker" }} roles={roles} /></AppShell>); }); await check(renderer); }
  finally { if (renderer) act(() => renderer.unmount()); globalThis.fetch = prior; }
}
for (const role of ["staff", "provider", "admin"] as const) test(`consent evidence actual route and drawer are available to ${role}`, async () => {
  await mount([role], async () => new Response(JSON.stringify(first)), async renderer => {
    assert.ok(renderer.root.findByProps({ href: route }));
    assert.deepEqual(breadcrumbItems(route), [{ label: "Communications" }, { label: "Consent evidence" }]);
    assert.equal(renderer.root.findByProps({ "aria-label": "Tier 1 gap count" }).children.join(""), "1");
    assert.equal(renderer.root.findByProps({ href: "/clinic?patientId=synthetic-one" }).children.join(""), "Patient/synthetic-one");
    assert.match(text(renderer), /suppressed/);
  });
});
test("M12 truncated banner and cursor Load more append patients and counts", async () => {
  const requests: URLSearchParams[] = [];
  await mount(["staff"], async url => {
    const query = new URL(String(url), "http://localhost").searchParams; requests.push(query);
    return new Response(JSON.stringify(query.has("cursor") ? second : first));
  }, async renderer => {
    assert.match(text(renderer), /This report is truncated/);
    await act(async () => { button(renderer, "Load more").props.onClick(); });
    assert.equal(requests[1].get("cursor"), "synthetic_cursor");
    assert.equal(renderer.root.findByProps({ "aria-label": "Tier 1 gap count" }).children.join(""), "2");
    assert.ok(renderer.root.findByProps({ href: "/clinic?patientId=synthetic-one" })); assert.ok(renderer.root.findByProps({ href: "/clinic?patientId=synthetic-two" }));
    assert.doesNotMatch(text(renderer), /This report is truncated/);
  });
});
test("filters restart the report without a cursor and unset values are omitted", async () => {
  const requests: URLSearchParams[] = [];
  await mount(["provider"], async url => { requests.push(new URL(String(url), "http://localhost").searchParams); return new Response(JSON.stringify(second)); }, async renderer => {
    for (const [label, value] of [["Tier", "3"], ["Purpose", "education"], ["Channel", "email"]]) await act(async () => { renderer.root.findByProps({ "aria-label": label }).props.onChange({ target: { value } }); });
    assert.deepEqual(Object.fromEntries(requests.at(-1)!), { format: "json", tier: "3", purpose: "education", channel: "email" });
    await act(async () => { renderer.root.findByProps({ "aria-label": "Tier" }).props.onChange({ target: { value: "" } }); });
    assert.equal(requests.at(-1)!.has("tier"), false); assert.equal(requests.at(-1)!.has("cursor"), false);
  });
});
test("unknown roles get an access message, no report request, and no drawer entry", async () => {
  let requests = 0;
  await mount([], async () => { requests++; return new Response(JSON.stringify(first)); }, async renderer => {
    assert.match(text(renderer), /don't have permission to view consent evidence/); assert.equal(requests, 0);
    assert.equal(renderer.root.findAllByProps({ href: route }).length, 0); assert.equal(renderer.root.findAllByType("table").length, 0);
  });
});
test("server 403 hides the report and export controls with an access message", async () => {
  await mount(["admin"], async () => new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }), async renderer => {
    assert.match(text(renderer), /don't have permission to view consent evidence/);
    assert.equal(renderer.root.findAllByType("table").length, 0); assert.equal(button(renderer, "Export CSV"), undefined);
  });
});
test("consent evidence direct navigation keeps exact document bypass and CSV downloads through the real client", async () => {
  const requests: string[] = [];
  const upstream = createHttpServer((req, res) => {
    requests.push(req.url ?? "");
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/communications/preferences/evidence-gaps") { res.statusCode = 404; res.end("Not found"); return; }
    if (url.searchParams.get("format") === "csv") { res.setHeader("Content-Type", "text/csv"); res.setHeader("X-ODOS-Truncated", "true"); res.setHeader("X-ODOS-Cursor", "synthetic_cursor"); res.end("patientReference,purpose,channel,tier,status,truncated\r\nPatient/synthetic-one,marketing-promo,sms,1,gap,true"); return; }
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(first));
  });
  await new Promise<void>(done => upstream.listen(0, "127.0.0.1", done)); const upstreamAddress = upstream.address(); assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
  const server = await createServer({ root: resolve(import.meta.dirname, ".."), logLevel: "silent", server: { host: "127.0.0.1", port: 0, proxy: { "/communications": { target: `http://127.0.0.1:${upstreamAddress.port}` } } }, plugins: [{ name: "consent-evidence-route-proof", transformIndexHtml(html) { return html.replace('/src/main.tsx', '/consent-proof.js'); }, resolveId(id) { if (id === "/consent-proof.js") return id; }, load(id) { if (id === "/consent-proof.js") return `import React from 'react'; import {createRoot} from 'react-dom/client'; import {RouteSwitch} from '/src/App.tsx'; import {AppShell} from '/src/components/AppShell.tsx'; import '/src/styles/globals.css'; const roles=['staff']; createRoot(document.getElementById('root')).render(React.createElement(AppShell,{path:location.pathname,roles,homePath:'/clinic',side:'clinic',email:'synthetic@example.test'},React.createElement(RouteSwitch,{view:{kind:'picker'},path:location.pathname,roles})));`; } }] });
  await server.listen(); const address = server.httpServer!.address(); assert.ok(address && typeof address !== "string");
  const browser = await chromium.launch({ channel: "chrome", args: process.platform === "linux" ? ["--no-sandbox"] : [] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } }); const url = `http://127.0.0.1:${address.port}${route}`;
    assert.equal((await fetch(url, { headers: { Accept: "application/json" } })).status, 404);
    assert.equal((await fetch(`${url}/other`, { headers: { Accept: "text/html" } })).status, 404);
    assert.equal((await page.goto(url))?.status(), 200);
    await page.getByRole("heading", { name: "Consent evidence", exact: true }).waitFor();
    await page.getByText("This report is truncated. More patients remain; counts cover the loaded results.").waitFor();
    await page.getByRole("button", { name: "Sections", exact: true }).click();
    assert.equal(await page.getByRole("link", { name: /Consent evidence.*preference gaps by tier/ }).getAttribute("href"), route);
    await page.getByRole("button", { name: "Close sections", exact: true }).last().click();
    if (process.env.CONSENT_EVIDENCE_CAPTURE) { await mkdir(resolve(process.env.CONSENT_EVIDENCE_CAPTURE, ".."), { recursive: true }); await page.screenshot({ path: process.env.CONSENT_EVIDENCE_CAPTURE, fullPage: true, animations: "disabled" }); }
    const downloadPromise = page.waitForEvent("download"); await page.getByRole("button", { name: "Export CSV", exact: true }).click();
    const download = await downloadPromise; assert.equal(download.suggestedFilename(), "consent-evidence.csv");
    const stream = await download.createReadStream(); assert.ok(stream); const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    assert.match(Buffer.concat(chunks).toString(), /Patient\/synthetic-one,marketing-promo,sms,1,gap,true/);
    assert.ok(requests.some(request => new URL(request, "http://localhost").searchParams.get("format") === "csv"));
    await page.getByText("The CSV contains a partial report. Use Load more to review remaining results.").waitFor();
  } finally { await browser.close(); await server.close(); await new Promise<void>(done => upstream.close(() => done())); }
});
