import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { fetchClinicSummary, type ClinicFlowRow, type ClinicSummary } from "../src/lib/clinic-summary";
import type { Desk, Doctor, DoctorRow, Owner, Reason, ReviewRow } from "../src/lib/open-charts";
import { ClinicHome } from "../src/scenes/ClinicHome";

const ME: Owner = { reference: "Practitioner/me", name: "Dr Me" };
const OTHER: Owner = { reference: "Practitioner/other", name: "Dr Other" };
const UNASSIGNED: Owner = { unassigned: true };

function chartRow(id: string, owner: Owner, serviceDate: string, extra: Partial<DoctorRow> = {}): DoctorRow {
  return {
    encounterId: `enc-${id}`,
    patient: { reference: `Patient/${id}`, name: `Patient ${id}` },
    visitType: "Comprehensive exam",
    serviceStart: `${serviceDate}T16:00:00Z`,
    serviceDate,
    owner,
    kind: "open",
    reasons: [{ code: "none-found", label: "No interpretation blockers found" }],
    ...extra,
  };
}

function reviewRow(id: string, owner: Owner): ReviewRow {
  return { encounterId: `enc-${id}`, patient: { reference: `Patient/${id}`, name: `Patient ${id}` }, owner, reason: "Status planned is not one ODOS writes" };
}

function doctor(overrides: Partial<Doctor> = {}): Doctor {
  return {
    timeZone: "America/Denver",
    timeZoneSource: "setting",
    caller: { practitioner: "Practitioner/me" },
    complete: true,
    today: { date: "2026-09-23", rows: [chartRow("today-mine", ME, "2026-09-23", { liveState: "with you" })] },
    lastClinicDay: { date: "2026-09-21", rows: [chartRow("last-mine", ME, "2026-09-21")] },
    older: { count: 1, oldestServiceDate: "2026-09-14", byOwner: [{ owner: ME, count: 1, oldestServiceDate: "2026-09-14" }] },
    needsReview: [reviewRow("review-mine", ME)],
    counts: { open: 2, nothingCharted: 0, signatureMissing: 0, needsReview: 1 },
    ...overrides,
  };
}

function desk(overrides: Partial<Desk> = {}): Desk {
  return {
    timeZone: "America/Denver",
    timeZoneSource: "setting",
    complete: true,
    today: { date: "2026-09-23", count: 3, rows: [] },
    lastClinicDay: { date: "2026-09-21", count: 2, rows: [] },
    older: { count: 4, byOwner: [] },
    ...overrides,
  };
}

function summary(): ClinicSummary {
  const row: ClinicFlowRow = { appointmentId: "appt-1", patientId: "flow-patient", time: "9:00", patient: "Flow Patient", visitType: "Exam", state: "scheduled", stateDetail: "Scheduled", flags: { unsigned: false } };
  return {
    flow: [row],
    signatures: { count: 0, olderThan24Hours: 0, rows: [] },
    orders: { activeCount: 0, rollups: { preLab: 0, outbound: 0, atLab: 0, inbound: 0, notified: 0 }, items: [] } as never,
    erx: { available: false, message: "E-Rx is not wired yet." },
    review: { available: false, message: "Results review is not wired yet." },
  };
}

function staticCard(openCharts: Doctor | Desk): { html: string; card: string; text: string } {
  const html = renderToStaticMarkup(<ClinicHome initialSummary={summary()} initialOpenCharts={openCharts} />);
  const card = html.match(/data-testid="clinic-open-charts-card"[\s\S]*?<\/section>/)?.[0] ?? "";
  return { html, card, text: card.replace(/<[^>]+>/g, "\n").replace(/\n+/g, "\n").replace(/&#x27;/g, "'") };
}

function group(card: string, name: string): string {
  return card.match(new RegExp(`<div class="[^"]*" data-group="${name}">[\\s\\S]*?(?=<div class="[^"]*" data-group=|<div class="odos-clinic-target")`))?.[0] ?? "";
}

function rowNames(html: string): string[] {
  return [...html.matchAll(/<span class="odos-open-charts-who">([^<]*)<\/span>/g)].map((match) => match[1]);
}

function textOf(node: ReturnType<ReactTestRenderer["toJSON"]>): string {
  if (node === null) return "";
  if (Array.isArray(node)) return node.map(textOf).join("\n");
  if (typeof node === "string") return node;
  return (node.children ?? []).map((child) => textOf(child as never)).join("");
}

type FetchCall = { url: string; authorization?: string };

async function withBrowser<T>(respond: (url: string) => Response, run: (calls: FetchCall[]) => Promise<T>): Promise<T> {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: { setInterval: () => 1, clearInterval: () => undefined } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, authorization: (init?.headers as Record<string, string> | undefined)?.Authorization });
    return respond(url);
  }) as typeof fetch;
  try {
    return await run(calls);
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    globalThis.fetch = originalFetch;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function mount(element: React.ReactElement): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(element); });
  return renderer;
}

test("B3 the doctor card renders Today, the last clinic day, Older and Needs review in order with their tones", () => {
  const { card, text } = staticCard(doctor());
  const order = ["today", "last-clinic-day", "older", "needs-review"].map((name) => card.indexOf(`data-group="${name}"`));
  assert.ok(order.every((position) => position > 0), String(order));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.match(card, /class="odos-open-charts-group is-today" data-group="today"/);
  assert.match(card, /class="odos-open-charts-group is-alert" data-group="last-clinic-day"/);
  assert.match(card, /class="odos-open-charts-group is-warn" data-group="older"/);
  assert.doesNotMatch(group(card, "today"), /is-alert|is-warn/);
  assert.match(group(card, "last-clinic-day"), /<h3>Monday, Sep 21<\/h3>/);
  assert.match(group(card, "needs-review"), /Status planned is not one ODOS writes/);
  assert.match(text, /Today's charts stay open until you sign them\. The last clinic day should be clear\./);

  const empty = staticCard(doctor({ today: { date: "2026-09-23", rows: [] }, lastClinicDay: { date: "2026-09-21", rows: [] }, needsReview: [] }));
  assert.match(group(empty.card, "today"), />No open charts today\.</);
  assert.match(group(empty.card, "last-clinic-day"), />Monday, Sep 21 is clear ✓</);
  assert.doesNotMatch(empty.card, /data-group="needs-review"/);

  const noLastDay = staticCard(doctor({ lastClinicDay: null }));
  assert.doesNotMatch(noLastDay.card, /data-group="last-clinic-day"/);
  assert.match(noLastDay.card, /data-group="today"/);
});

test("B4 rows keep the server's newest-first order within each group", () => {
  const rows = [chartRow("zed", ME, "2026-09-23"), chartRow("amy", UNASSIGNED, "2026-09-23"), chartRow("mia", ME, "2026-09-23")];
  const { card } = staticCard(doctor({ today: { date: "2026-09-23", rows } }));
  assert.deepEqual(rowNames(group(card, "today")), ["Patient zed", "Patient amy", "Patient mia"]);
});

test("B5 My charts shows the caller's and Unassigned rows in every group; All providers shows every row with owners", async () => {
  const openCharts = doctor({
    today: { date: "2026-09-23", rows: [chartRow("t-mine", ME, "2026-09-23"), chartRow("t-other", OTHER, "2026-09-23"), chartRow("t-unassigned", UNASSIGNED, "2026-09-23")] },
    lastClinicDay: { date: "2026-09-21", rows: [chartRow("l-other", OTHER, "2026-09-21"), chartRow("l-unassigned", UNASSIGNED, "2026-09-21")] },
    needsReview: [reviewRow("r-other", OTHER), reviewRow("r-unassigned", UNASSIGNED)],
  });
  const renderer = await mount(<ClinicHome initialSummary={summary()} initialOpenCharts={openCharts} roles={["provider"]} />);
  try {
    const card = () => renderer.root.findByProps({ "data-testid": "clinic-open-charts-card" });
    const names = () => card().findAllByProps({ className: "odos-open-charts-who" }).map((node) => node.children.join(""));
    assert.deepEqual(names(), ["Patient t-mine", "Patient t-unassigned", "Patient l-unassigned", "Patient r-unassigned"]);
    assert.doesNotMatch(textOf(renderer.toJSON()), /Dr Other/);

    const toggle = card().findByProps({ role: "group" });
    await act(async () => toggle.findAllByType("button")[1].props.onClick());
    assert.deepEqual(names(), ["Patient t-mine", "Patient t-other", "Patient t-unassigned", "Patient l-other", "Patient l-unassigned", "Patient r-other", "Patient r-unassigned"]);
    const meta = card().findAllByProps({ className: "odos-open-charts-meta" }).map((node) => node.children.join(""));
    assert.match(meta[1], /Dr Other$/);
    assert.match(meta[2], /Unassigned$/);
  } finally {
    await act(async () => renderer.unmount());
  }

  const noCaller = staticCard(doctor({ caller: {}, today: { date: "2026-09-23", rows: [chartRow("t-other", OTHER, "2026-09-23")] } }));
  assert.doesNotMatch(noCaller.card, /My charts|All providers/);
  assert.deepEqual(rowNames(group(noCaller.card, "today")), ["Patient t-other"]);
});

test("B6 Older in My charts counts the caller's and Unassigned byOwner entries and takes their oldest date", () => {
  const older = {
    count: 9,
    oldestServiceDate: "2026-09-01",
    byOwner: [
      { owner: ME, count: 2, oldestServiceDate: "2026-09-12" },
      { owner: UNASSIGNED, count: 1, oldestServiceDate: "2026-09-08" },
      { owner: OTHER, count: 6, oldestServiceDate: "2026-09-01" },
    ],
  };
  const { card } = staticCard(doctor({ older }));
  assert.match(group(card, "older"), />3 older · oldest Sep 8</);
});

test("B7 every reason code renders its exact chip text and nothing claims a chart is ready to sign", () => {
  const reasons: [Reason, string][] = [
    [{ code: "needs-interpretation", label: "OCT macula" }, "Needs interpretation: OCT macula"],
    [{ code: "unclassified-fee", label: "92134" }, "Fee not classified: 92134"],
    [{ code: "duplicate-fee", label: "92250" }, "Duplicate fee: 92250"],
    [{ code: "no-interpreted-result", label: "Visual field" }, "No interpreted result: Visual field"],
    [{ code: "none-found", label: "No interpretation blockers found" }, "No interpretation blockers found"],
    [{ code: "nothing-charted" }, "Nothing charted"],
    [{ code: "signature-missing" }, "Signature missing"],
    [{ code: "checks-unavailable" }, "Checks unavailable"],
  ];
  const rows = reasons.map(([reason], index) => chartRow(`r${index}`, ME, "2026-09-23", { reasons: [reason] }));
  const { card, html } = staticCard(doctor({ today: { date: "2026-09-23", rows } }));
  const chips = [...group(card, "today").matchAll(/<span class="odos-open-charts-chip" data-reason="([^"]+)">([^<]*)<\/span>/g)].map((match) => [match[1], match[2]]);
  assert.deepEqual(chips, reasons.map(([reason, text]) => [reason.code, text]));
  assert.doesNotMatch(html.replace(/<[^>]+>/g, " "), /ready to sign/i);
});

test("B8 Show older issues one expand=older request, renders its rows with chips, and Hide collapses without changing counts", async () => {
  const expandedRow = chartRow("older-1", ME, "2026-09-14", { reasons: [{ code: "duplicate-fee", label: "92250" }] });
  await withBrowser(() => json(doctor({ older: { count: 1, oldestServiceDate: "2026-09-14", byOwner: [{ owner: ME, count: 1, oldestServiceDate: "2026-09-14" }], rows: [expandedRow] } })), async (calls) => {
    const renderer = await mount(<ClinicHome initialSummary={summary()} initialOpenCharts={doctor()} roles={["provider"]} />);
    try {
      assert.equal(calls.length, 0);
      const olderGroup = () => renderer.root.findByProps({ "data-group": "older" });
      const olderText = () => textOf(renderer.toJSON()).match(/\d+ older · oldest [A-Z][a-z]{2} \d+/)?.[0];
      assert.equal(olderText(), "1 older · oldest Sep 14");
      await act(async () => olderGroup().findByType("button").props.onClick());
      assert.deepEqual(calls.map((call) => call.url), ["/clinic/open-charts?expand=older"]);
      assert.deepEqual(olderGroup().findAllByProps({ className: "odos-open-charts-who" }).map((node) => node.children.join("")), ["Patient older-1"]);
      assert.deepEqual(olderGroup().findAllByProps({ className: "odos-open-charts-chip" }).map((node) => node.children.join("")), ["Duplicate fee: 92250"]);
      assert.equal(olderText(), "1 older · oldest Sep 14");
      const hide = olderGroup().findByProps({ className: "odos-open-charts-older" }).findByType("button");
      assert.equal(hide.children.join(""), "Hide");
      await act(async () => hide.props.onClick());
      assert.equal(olderGroup().findAllByProps({ className: "odos-open-charts-who" }).length, 0);
      assert.equal(olderText(), "1 older · oldest Sep 14");
      assert.equal(calls.length, 1);
    } finally {
      await act(async () => renderer.unmount());
    }
  });
});

test("B9 an incomplete projection says so and qualifies the Older count", () => {
  const incomplete = staticCard(doctor({ complete: false, incomplete: ["unfinished"] }));
  assert.match(incomplete.card, />Some counts may be incomplete\.</);
  assert.match(group(incomplete.card, "older"), />at least 1 older · oldest Sep 14</);
  const complete = staticCard(doctor());
  assert.doesNotMatch(complete.card, /incomplete|at least/);
});

test("B10 card errors render the practice sentences while the flow board keeps working; the summary maps the same codes", async () => {
  const cases: [number, unknown, string][] = [
    [409, { code: "practice-time-zone-unset" }, "Set the practice time zone in Settings → Practice time zone."],
    [409, { code: "practice-time-zone-invalid" }, "The practice time-zone setting is invalid — fix it in Settings."],
    [502, { code: "practice-time-zone-unreadable" }, "Open charts are unavailable right now."],
    [500, { error: "Open charts route failed." }, "Open charts are unavailable right now."],
  ];
  for (const [status, body, sentence] of cases) {
    await withBrowser(() => json(body, status), async () => {
      const renderer = await mount(<ClinicHome initialSummary={summary()} roles={["provider"]} />);
      try {
        const card = renderer.root.findByProps({ "data-testid": "clinic-open-charts-card" });
        const cardText = textOf(card.findByProps({ className: "odos-clinic-error" }).children as never);
        assert.equal(cardText, sentence);
        assert.doesNotMatch(textOf(renderer.toJSON()), /practice-time-zone-/);
        assert.equal(renderer.root.findAllByProps({ className: "odos-clinic-flow-row" }).length, 1);
      } finally {
        await act(async () => renderer.unmount());
      }
    });
  }

  for (const [status, body, sentence] of cases.slice(0, 3)) {
    await assert.rejects(fetchClinicSummary(async () => json(body, status)), { message: sentence });
  }
  await withBrowser((url) => url === "/clinic/summary" ? json({ code: "practice-time-zone-unset" }, 409) : json(doctor()), async () => {
    const renderer = await mount(<ClinicHome roles={["provider"]} />);
    try {
      const flowCard = renderer.root.findByProps({ className: "odos-clinic-card odos-clinic-flow-card odos-tone-sapphire" });
      assert.equal(textOf(flowCard.findByProps({ className: "odos-clinic-error" }).children as never), "Set the practice time zone in Settings → Practice time zone.");
    } finally {
      await act(async () => renderer.unmount());
    }
  });
});

test("B11 service times use the response time zone, not the process zone", () => {
  const originalTz = process.env.TZ;
  process.env.TZ = "Asia/Tokyo";
  try {
    const row = chartRow("denver", ME, "2026-09-23", { serviceStart: "2026-09-23T16:00:00Z" });
    const { card } = staticCard(doctor({ timeZone: "America/Denver", today: { date: "2026-09-23", rows: [row] } }));
    assert.match(group(card, "today"), /Comprehensive exam · 10:00 AM/);
  } finally {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  }
});

test("B12 providers call only the doctor route; other roles call only the desk route and get one summary line", async () => {
  await withBrowser((url) => url === "/clinic/open-charts/desk" ? json(desk()) : json(doctor()), async (calls) => {
    const renderer = await mount(<ClinicHome initialSummary={summary()} roles={["staff"]} />);
    try {
      assert.deepEqual(calls.map((call) => call.url), ["/clinic/open-charts/desk"]);
      const card = renderer.root.findByProps({ "data-testid": "clinic-open-charts-card" });
      assert.equal(textOf(card.findByProps({ className: "odos-open-charts-desk-line" }).children as never), "Open charts: 3 today · 2 from Monday, Sep 21 · 4 older");
      assert.equal(card.findAllByProps({ className: "odos-open-charts-row" }).length, 0);
      assert.equal(card.findAllByProps({ className: "odos-open-charts-chip" }).length, 0);
    } finally {
      await act(async () => renderer.unmount());
    }
  });
  await withBrowser((url) => url === "/clinic/open-charts" ? json(doctor()) : json(desk()), async (calls) => {
    const renderer = await mount(<ClinicHome initialSummary={summary()} roles={["provider"]} />);
    try {
      assert.deepEqual(calls.map((call) => call.url), ["/clinic/open-charts"]);
      assert.equal(renderer.root.findByProps({ "data-testid": "clinic-open-charts-card" }).findAllByProps({ className: "odos-open-charts-row" }).length, 3);
    } finally {
      await act(async () => renderer.unmount());
    }
  });
});

test("B13 the waiting chip counts what is behind (last clinic day + Older, mine) and shows today separately", () => {
  const chip = (openCharts: Doctor | Desk) => staticCard(openCharts).html.match(/<a class="([^"]*)" data-testid="clinic-wait-unsigned"[\s\S]*?<\/a>/) ?? [];
  const behind = doctor({
    today: { date: "2026-09-23", rows: [chartRow("t1", ME, "2026-09-23"), chartRow("t2", UNASSIGNED, "2026-09-23"), chartRow("t3", OTHER, "2026-09-23")] },
    lastClinicDay: { date: "2026-09-21", rows: [chartRow("l1", ME, "2026-09-21"), chartRow("l2", OTHER, "2026-09-21")] },
    older: { count: 5, oldestServiceDate: "2026-09-01", byOwner: [{ owner: UNASSIGNED, count: 2, oldestServiceDate: "2026-09-05" }, { owner: OTHER, count: 3, oldestServiceDate: "2026-09-01" }] },
  });
  const [markup, className] = chip(behind);
  assert.match(className, /\bis-alert\b/);
  assert.match(markup, /<strong>3<\/strong><small>Open charts<\/small><small class="odos-clinic-wait-sub">2 today<\/small>/);

  const [clearMarkup, clearClass] = chip(doctor({ lastClinicDay: { date: "2026-09-21", rows: [chartRow("l2", OTHER, "2026-09-21")] }, older: { count: 0, byOwner: [] } }));
  assert.match(clearClass, /\bis-ok\b/);
  assert.doesNotMatch(clearClass, /is-alert/);
  assert.match(clearMarkup, /<strong>0<\/strong><small>Open charts<\/small>/);

  const [deskMarkup, deskClass] = chip(desk());
  assert.match(deskClass, /\bis-alert\b/);
  assert.match(deskMarkup, /<strong>6<\/strong><small>Open charts<\/small><small class="odos-clinic-wait-sub">3 today<\/small>/);
});
