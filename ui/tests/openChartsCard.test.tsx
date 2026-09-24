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

type Timers = { active: Map<number, { tick: () => void; delay: number }>; registered: { handle: number; delay: number }[]; cleared: number[] };

async function withBrowser<T>(respond: (url: string) => Response | Promise<Response>, run: (calls: FetchCall[], timers: Timers) => Promise<T>): Promise<T> {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  const timers: Timers = { active: new Map(), registered: [], cleared: [] };
  let nextHandle = 0;
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    setInterval: (tick: () => void, delay: number) => { const handle = ++nextHandle; timers.active.set(handle, { tick, delay }); timers.registered.push({ handle, delay }); return handle; },
    clearInterval: (handle: number) => { timers.cleared.push(handle); timers.active.delete(handle); },
  } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, authorization: (init?.headers as Record<string, string> | undefined)?.Authorization });
    return respond(url);
  }) as typeof fetch;
  try {
    return await run(calls, timers);
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

/** One refresh period: fire every interval still registered, then let responses settle. */
async function tick(timers: Timers): Promise<void> {
  await act(async () => {
    for (const { tick: fire } of [...timers.active.values()]) fire();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

test("a failed refresh drops the old counts from the chip and the card", async () => {
  let fail = false;
  await withBrowser(() => fail ? json({ code: "practice-time-zone-unreadable" }, 502) : json(doctor()), async (_calls, timers) => {
    const renderer = await mount(<ClinicHome initialSummary={summary()} roles={["provider"]} />);
    try {
      const chip = () => textOf(renderer.root.findByProps({ "data-testid": "clinic-wait-unsigned" }).children as never);
      assert.equal(chip(), "2\nOpen charts\n1 today");
      fail = true;
      await tick(timers);
      assert.equal(chip(), "—\nOpen charts");
      const card = renderer.root.findByProps({ "data-testid": "clinic-open-charts-card" });
      assert.equal(textOf(card.findByProps({ className: "odos-clinic-error" }).children as never), "Open charts are unavailable right now.");
      assert.equal(card.findAllByProps({ className: "odos-open-charts-row" }).length, 0);
    } finally {
      await act(async () => renderer.unmount());
    }
  });
});

test("a slow older refresh cannot overwrite a newer one", async () => {
  let releaseFirst!: () => void;
  const first = new Promise<Response>((resolve) => { releaseFirst = () => resolve(json(doctor({ today: { date: "2026-09-23", rows: [chartRow("stale", ME, "2026-09-23")] } }))); });
  let request = 0;
  await withBrowser(() => ++request === 1 ? first : json(doctor({ today: { date: "2026-09-23", rows: [chartRow("fresh", ME, "2026-09-23")] } })), async (_calls, timers) => {
    const renderer = await mount(<ClinicHome initialSummary={summary()} roles={["provider"]} />);
    try {
      await tick(timers);
      await act(async () => { releaseFirst(); await new Promise((resolve) => setTimeout(resolve, 0)); });
      const names = renderer.root.findByProps({ "data-group": "today" }).findAllByProps({ className: "odos-open-charts-who" }).map((node) => node.children.join(""));
      assert.deepEqual(names, ["Patient fresh"]);
    } finally {
      await act(async () => renderer.unmount());
    }
  });
});

test("while Older is open each refresh carries expand=older, so a signed chart leaves the list even when the summary is unchanged", async () => {
  const withOlder = (id: string) => doctor({ older: { ...doctor().older, rows: [chartRow(id, ME, "2026-09-14")] } });
  let olderRow = "older-1";
  await withBrowser((url) => json(url.includes("expand=older") ? withOlder(olderRow) : doctor()), async (calls, timers) => {
    const renderer = await mount(<ClinicHome initialSummary={summary()} roles={["provider"]} />);
    try {
      const olderNames = () => renderer.root.findByProps({ "data-group": "older" }).findAllByProps({ className: "odos-open-charts-who" }).map((node) => node.children.join(""));
      const olderButton = () => renderer.root.findByProps({ className: "odos-open-charts-older" }).findByType("button");
      await act(async () => olderButton().props.onClick());
      await settle();
      assert.deepEqual(olderNames(), ["Patient older-1"]);
      olderRow = "older-2";
      await tick(timers);
      assert.deepEqual(olderNames(), ["Patient older-2"]);
      await act(async () => olderButton().props.onClick());
      await tick(timers);
      assert.deepEqual(olderNames(), []);
      assert.deepEqual(calls.map((call) => call.url), ["/clinic/open-charts", "/clinic/open-charts?expand=older", "/clinic/open-charts?expand=older", "/clinic/open-charts"]);
    } finally {
      await act(async () => renderer.unmount());
    }
  });
});

test("reopening Older before the previous request settles cannot let the older response win", async () => {
  const releases: (() => void)[] = [];
  const withOlder = (id: string) => doctor({ older: { ...doctor().older, rows: [chartRow(id, ME, "2026-09-14")] } });
  await withBrowser(() => new Promise<Response>((resolve) => {
    const id = releases.length === 0 ? "stale" : "fresh";
    releases.push(() => resolve(json(withOlder(id))));
  }), async (calls) => {
    const renderer = await mount(<ClinicHome initialSummary={summary()} initialOpenCharts={doctor()} roles={["provider"]} />);
    try {
      const olderButton = () => renderer.root.findByProps({ className: "odos-open-charts-older" }).findByType("button");
      await act(async () => olderButton().props.onClick());
      await act(async () => olderButton().props.onClick());
      await act(async () => olderButton().props.onClick());
      assert.deepEqual(calls.map((call) => call.url), ["/clinic/open-charts?expand=older", "/clinic/open-charts?expand=older"]);
      await act(async () => { releases[1](); await new Promise((resolve) => setTimeout(resolve, 0)); });
      await act(async () => { releases[0](); await new Promise((resolve) => setTimeout(resolve, 0)); });
      const names = renderer.root.findByProps({ "data-group": "older" }).findAllByProps({ className: "odos-open-charts-who" }).map((node) => node.children.join(""));
      assert.deepEqual(names, ["Patient fresh"]);
    } finally {
      await act(async () => renderer.unmount());
    }
  });
});

test("the 60-second refresh is registered once and cleared on unmount, and nothing fetches afterwards", async () => {
  await withBrowser(() => json(doctor()), async (calls, timers) => {
    const renderer = await mount(<ClinicHome initialSummary={summary()} roles={["provider"]} />);
    assert.deepEqual(timers.registered.map((timer) => timer.delay), [60_000]);
    await tick(timers);
    assert.equal(calls.length, 2);
    await act(async () => renderer.unmount());
    assert.deepEqual(timers.cleared, [timers.registered[0].handle]);
    await tick(timers);
    assert.equal(calls.length, 2);
  });
});

test("the waiting chip counts the caller's charts whichever way the card is toggled", async () => {
  const openCharts = doctor({
    lastClinicDay: { date: "2026-09-21", rows: [chartRow("l-mine", ME, "2026-09-21"), chartRow("l-other-1", OTHER, "2026-09-21"), chartRow("l-other-2", OTHER, "2026-09-21")] },
    older: { count: 4, oldestServiceDate: "2026-09-01", byOwner: [{ owner: ME, count: 1, oldestServiceDate: "2026-09-10" }, { owner: OTHER, count: 3, oldestServiceDate: "2026-09-01" }] },
  });
  const renderer = await mount(<ClinicHome initialSummary={summary()} initialOpenCharts={openCharts} roles={["provider"]} />);
  try {
    const chip = () => {
      const node = renderer.root.findByProps({ "data-testid": "clinic-wait-unsigned" });
      return { text: textOf(node.children as never), className: node.props.className as string };
    };
    const rows = () => renderer.root.findByProps({ "data-testid": "clinic-open-charts-card" }).findAllByProps({ className: "odos-open-charts-row" }).length;
    const before = chip();
    assert.equal(before.text, "2\nOpen charts\n1 today");
    assert.match(before.className, /\bis-alert\b/);
    const rowsBefore = rows();
    await act(async () => renderer.root.findByProps({ role: "group" }).findAllByType("button")[1].props.onClick());
    assert.ok(rows() > rowsBefore, "the toggle took effect on the card");
    assert.deepEqual(chip(), before);
  } finally {
    await act(async () => renderer.unmount());
  }
});

test("Show older groups rows by age from the practice date, keeping server order within each group", async () => {
  const ages: [string, string][] = [["d3", "2026-09-20"], ["d7", "2026-09-16"], ["d8", "2026-09-15"], ["d30", "2026-08-24"], ["d31", "2026-08-23"], ["d60", "2026-07-25"], ["d61", "2026-07-24"], ["d90", "2026-06-25"], ["d91", "2026-06-24"], ["d114", "2026-06-01"]];
  const rows = ages.map(([id, date]) => chartRow(id, ME, date));
  await withBrowser(() => json(doctor({ older: { count: rows.length, oldestServiceDate: "2026-06-01", byOwner: [{ owner: ME, count: rows.length, oldestServiceDate: "2026-06-01" }], rows } })), async () => {
    const renderer = await mount(<ClinicHome initialSummary={summary()} initialOpenCharts={doctor()} roles={["provider"]} />);
    try {
      await act(async () => renderer.root.findByProps({ className: "odos-open-charts-older" }).findByType("button").props.onClick());
      await settle();
      const bands = renderer.root.findAllByProps({ className: "odos-open-charts-band" }).map((band) => [
        band.findByType("h4").children.join(""),
        band.findAllByProps({ className: "odos-open-charts-who" }).map((node) => node.children.join("")),
      ]);
      assert.deepEqual(bands, [
        ["Up to a week", ["Patient d3", "Patient d7"]],
        ["Over 1 week", ["Patient d8", "Patient d30"]],
        ["Over 30 days", ["Patient d31", "Patient d60"]],
        ["Over 60 days", ["Patient d61", "Patient d90"]],
        ["Over 90 days", ["Patient d91", "Patient d114"]],
      ]);
    } finally {
      await act(async () => renderer.unmount());
    }
  });
});

function deferredResponses(): { respond: () => Promise<Response>; release(index: number, response: Response): void } {
  const pending: ((response: Response) => void)[] = [];
  return {
    respond: () => new Promise<Response>((resolve) => { pending.push(resolve); }),
    release: (index, response) => pending[index](response),
  };
}

async function showThenHideOlder(renderer: ReactTestRenderer): Promise<void> {
  const olderButton = () => renderer.root.findByProps({ className: "odos-open-charts-older" }).findByType("button");
  await act(async () => olderButton().props.onClick());
  assert.equal(olderButton().children.join(""), "Hide");
  await act(async () => olderButton().props.onClick());
  assert.equal(olderButton().children.join(""), "Show older");
}

const chipText = (renderer: ReactTestRenderer) => textOf(renderer.root.findByProps({ "data-testid": "clinic-wait-unsigned" }).children as never);
const cardRowNames = (renderer: ReactTestRenderer) => renderer.root.findByProps({ "data-testid": "clinic-open-charts-card" }).findAllByProps({ className: "odos-open-charts-who" }).map((node) => node.children.join(""));

test("hiding Older retires its in-flight request, so a late 502 cannot blank the card", async () => {
  const responses = deferredResponses();
  await withBrowser(responses.respond, async (calls) => {
    const renderer = await mount(<ClinicHome initialSummary={summary()} initialOpenCharts={doctor()} roles={["provider"]} />);
    try {
      assert.equal(chipText(renderer), "2\nOpen charts\n1 today");
      const rowsBefore = cardRowNames(renderer);
      await showThenHideOlder(renderer);
      assert.deepEqual(calls.map((call) => call.url), ["/clinic/open-charts?expand=older"]);
      await act(async () => { responses.release(0, json({ code: "practice-time-zone-unreadable" }, 502)); await new Promise((resolve) => setTimeout(resolve, 0)); });
      const card = renderer.root.findByProps({ "data-testid": "clinic-open-charts-card" });
      assert.equal(card.findAllByProps({ className: "odos-clinic-error" }).length, 0);
      assert.doesNotMatch(textOf(renderer.toJSON()), /unavailable right now/);
      assert.deepEqual(cardRowNames(renderer), rowsBefore);
      assert.ok(rowsBefore.includes("Patient today-mine"));
      assert.equal(chipText(renderer), "2\nOpen charts\n1 today");
    } finally {
      await act(async () => renderer.unmount());
    }
  });
});

test("hiding Older retires its in-flight request, so a late 200 with other counts changes nothing shown", async () => {
  const responses = deferredResponses();
  await withBrowser(responses.respond, async () => {
    const renderer = await mount(<ClinicHome initialSummary={summary()} initialOpenCharts={doctor()} roles={["provider"]} />);
    try {
      const olderLine = () => textOf(renderer.root.findByProps({ className: "odos-open-charts-older" }).findByType("span").children as never);
      assert.equal(olderLine(), "1 older · oldest Sep 14");
      await showThenHideOlder(renderer);
      const changed = doctor({
        lastClinicDay: { date: "2026-09-21", rows: [] },
        older: { count: 6, oldestServiceDate: "2026-08-01", byOwner: [{ owner: ME, count: 6, oldestServiceDate: "2026-08-01" }], rows: [] },
      });
      await act(async () => { responses.release(0, json(changed)); await new Promise((resolve) => setTimeout(resolve, 0)); });
      assert.equal(olderLine(), "1 older · oldest Sep 14");
      assert.equal(chipText(renderer), "2\nOpen charts\n1 today");
      assert.ok(cardRowNames(renderer).includes("Patient last-mine"));
    } finally {
      await act(async () => renderer.unmount());
    }
  });
});

test("expanded Older rows follow My charts / All providers like every other group", async () => {
  const rows = [chartRow("older-mine", ME, "2026-09-14"), chartRow("older-other", OTHER, "2026-09-12"), chartRow("older-unassigned", UNASSIGNED, "2026-09-10")];
  const older = { count: 3, oldestServiceDate: "2026-09-10", byOwner: [{ owner: ME, count: 1, oldestServiceDate: "2026-09-14" }, { owner: OTHER, count: 1, oldestServiceDate: "2026-09-12" }, { owner: UNASSIGNED, count: 1, oldestServiceDate: "2026-09-10" }], rows };
  await withBrowser(() => json(doctor({ older })), async () => {
    const renderer = await mount(<ClinicHome initialSummary={summary()} initialOpenCharts={doctor({ older: { ...older, rows: undefined } })} roles={["provider"]} />);
    try {
      const olderNames = () => renderer.root.findByProps({ "data-group": "older" }).findAllByProps({ className: "odos-open-charts-who" }).map((node) => node.children.join(""));
      await act(async () => renderer.root.findByProps({ className: "odos-open-charts-older" }).findByType("button").props.onClick());
      await settle();
      assert.deepEqual(olderNames(), ["Patient older-mine", "Patient older-unassigned"]);
      await act(async () => renderer.root.findByProps({ role: "group" }).findAllByType("button")[1].props.onClick());
      assert.deepEqual(olderNames(), ["Patient older-mine", "Patient older-other", "Patient older-unassigned"]);
    } finally {
      await act(async () => renderer.unmount());
    }
  });
});

test("new supplied data replaces data an earlier Show older fetched", async () => {
  const expanded = doctor({ older: { ...doctor().older, rows: [chartRow("older-1", ME, "2026-09-14")] } });
  await withBrowser(() => json(expanded), async () => {
    const renderer = await mount(<ClinicHome initialSummary={summary()} initialOpenCharts={doctor()} roles={["provider"]} />);
    try {
      await act(async () => renderer.root.findByProps({ className: "odos-open-charts-older" }).findByType("button").props.onClick());
      await settle();
      assert.deepEqual(renderer.root.findByProps({ "data-group": "older" }).findAllByProps({ className: "odos-open-charts-who" }).map((node) => node.children.join("")), ["Patient older-1"]);
      const replacement = doctor({ today: { date: "2026-09-23", rows: [chartRow("replacement", ME, "2026-09-23")] } });
      await act(async () => renderer.update(<ClinicHome initialSummary={summary()} initialOpenCharts={replacement} roles={["provider"]} />));
      const todayNames = renderer.root.findByProps({ "data-group": "today" }).findAllByProps({ className: "odos-open-charts-who" }).map((node) => node.children.join(""));
      assert.deepEqual(todayNames, ["Patient replacement"]);
      assert.equal(renderer.root.findByProps({ className: "odos-open-charts-older" }).findByType("button").children.join(""), "Show older");
    } finally {
      await act(async () => renderer.unmount());
    }
  });
});

test("a doctor response still pending when supplied data switches to the desk shape cannot land", async () => {
  const responses = deferredResponses();
  await withBrowser(responses.respond, async (calls) => {
    const renderer = await mount(<ClinicHome initialSummary={summary()} initialOpenCharts={doctor()} roles={["provider"]} />);
    try {
      await act(async () => renderer.root.findByProps({ className: "odos-open-charts-older" }).findByType("button").props.onClick());
      assert.deepEqual(calls.map((call) => call.url), ["/clinic/open-charts?expand=older"]);
      await act(async () => renderer.update(<ClinicHome initialSummary={summary()} initialOpenCharts={desk()} roles={["staff"]} />));
      await act(async () => { responses.release(0, json(doctor({ older: { ...doctor().older, rows: [chartRow("older-1", ME, "2026-09-14")] } }))); await new Promise((resolve) => setTimeout(resolve, 0)); });
      const card = renderer.root.findByProps({ "data-testid": "clinic-open-charts-card" });
      assert.equal(card.findAllByProps({ className: "odos-open-charts-row" }).length, 0);
      assert.equal(textOf(card.findByProps({ className: "odos-open-charts-desk-line" }).children as never), "Open charts: 3 today · 2 from Monday, Sep 21 · 4 older");
    } finally {
      await act(async () => renderer.unmount());
    }
  });
});

test("without supplied data, a doctor response still pending at a switch to the desk shape cannot land", async () => {
  const pending: { url: string; resolve(response: Response): void }[] = [];
  await withBrowser((url) => new Promise<Response>((resolve) => { pending.push({ url, resolve }); }), async () => {
    const renderer = await mount(<ClinicHome initialSummary={summary()} roles={["provider"]} />);
    try {
      await act(async () => renderer.update(<ClinicHome initialSummary={summary()} roles={["staff"]} />));
      assert.deepEqual(pending.map((request) => request.url), ["/clinic/open-charts", "/clinic/open-charts/desk"]);
      await act(async () => { pending[1].resolve(json(desk())); await new Promise((resolve) => setTimeout(resolve, 0)); });
      await act(async () => { pending[0].resolve(json(doctor())); await new Promise((resolve) => setTimeout(resolve, 0)); });
      const card = renderer.root.findByProps({ "data-testid": "clinic-open-charts-card" });
      assert.equal(card.findAllByProps({ className: "odos-open-charts-row" }).length, 0);
      assert.equal(textOf(card.findByProps({ className: "odos-open-charts-desk-line" }).children as never), "Open charts: 3 today · 2 from Monday, Sep 21 · 4 older");
    } finally {
      await act(async () => renderer.unmount());
    }
  });
});
