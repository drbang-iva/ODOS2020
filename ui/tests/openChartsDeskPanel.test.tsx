import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { Desk } from "../src/lib/open-charts";
import type { PracticeRoleId } from "../src/lib/practice-roles";
import { useSchedulingStore } from "../src/lib/scheduling-store";
import { DeskHome } from "../src/scenes/DeskHome";
import { FrontDeskCockpit } from "../src/scenes/frontdesk/FrontDeskCockpit";

const SCREENS = [DeskHome, FrontDeskCockpit];
const REASONS = ["Needs interpretation", "Fee not classified", "Duplicate fee", "No interpreted result", "No interpretation blockers found", "Nothing charted", "Signature missing", "Checks unavailable"];
function desk(overrides: Partial<Desk> = {}): Desk {
  return {
    timeZone: "America/Denver", timeZoneSource: "setting", complete: true,
    today: { date: "2026-09-23", count: 3, rows: [{ patient: { reference: "Patient/today", name: "Today Patient" }, owner: { reference: "Practitioner/one", name: "Dr One" }, serviceStart: "2026-09-23T16:00:00Z", serviceDate: "2026-09-23", status: "chart open", priorDay: false }] },
    lastClinicDay: { date: "2026-09-21", count: 2, rows: [{ patient: { reference: "Patient/prior", name: "Prior Patient" }, owner: { unassigned: true }, serviceStart: "2026-09-21T16:00:00Z", serviceDate: "2026-09-21", status: "chart open", priorDay: true }] },
    older: { count: 5, byOwner: [{ owner: { reference: "Practitioner/one", name: "Dr One" }, count: 3, oldestServiceDate: "2026-09-01" }, { owner: { unassigned: true }, count: 2, oldestServiceDate: "2026-08-20" }] },
    ...overrides,
  };
}
function text(node: ReactTestInstance): string { return node.children.map((child) => typeof child === "string" ? child : text(child)).join(""); }
function button(renderer: ReactTestRenderer) { return renderer.root.find((node) => node.type === "button" && node.props["aria-label"] === "Open charts"); }
function badge(renderer: ReactTestRenderer) { return button(renderer).findAll((node) => node.type === "span" && String(node.props.className).includes("rounded-full")); }
function panel(renderer: ReactTestRenderer) { return renderer.root.findByProps({ "data-testid": "open-charts-desk-panel" }); }
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }); }
async function withScreen(Screen: typeof DeskHome | typeof FrontDeskCockpit, respond: () => Response | Promise<Response>, run: (renderer: ReactTestRenderer, calls: string[], ticks: (() => void)[]) => Promise<void>, roles: PracticeRoleId[] = ["provider", "staff"]) {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const originalStore = useSchedulingStore.getState();
  const calls: string[] = [];
  const ticks: (() => void)[] = [];
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location: { search: "", href: "http://localhost/desk", origin: "http://localhost" },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    setInterval: (tick: () => void, delay: number) => { assert.equal(delay, 60_000); ticks.push(tick); return ticks.length; }, clearInterval: () => undefined,
    addEventListener: () => undefined, removeEventListener: () => undefined,
  } });
  useSchedulingStore.setState({ loadDay: async () => undefined, loadWindow: async () => undefined });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/clinic/open-charts")) { calls.push(url); return respond(); }
    return json({}, 503);
  }) as typeof fetch;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(<Screen roles={roles} initialOfficeMessages={[]} initialWatcherProjection={{ status: "healthy", alerts: [] } as never} />); });
    await run(renderer, calls, ticks);
  } finally {
    act(() => renderer?.unmount());
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    useSchedulingStore.setState(originalStore, true);
  }
}
for (const Screen of SCREENS) {
  test(`C2 ${Screen.name}: behind alarms, today stays plain, zeros/loading hide badges; exact tooltip and cap`, async () => {
    for (const [data, count, alarm, title] of [
      [desk(), "7", true, "Open charts: 3 today · 2 from Mon, Sep 21 · 5 older"],
      [desk({ lastClinicDay: null, older: { count: 0, byOwner: [] } }), "3", false, "Open charts: 3 today · 0 older"],
      [desk({ today: { date: "2026-09-23", count: 120, rows: [] }, lastClinicDay: null, older: { count: 0, byOwner: [] } }), "99+", false, "Open charts: 120 today · 0 older"],
      [desk({ older: { count: 101, byOwner: [] } }), "99+", true, "Open charts: 3 today · 2 from Mon, Sep 21 · 101 older"],
      [desk({ today: { date: "2026-09-23", count: 0, rows: [] }, lastClinicDay: null, older: { count: 0, byOwner: [] } }), null, false, "Open charts: 0 today · 0 older"],
    ] as const) {
      await withScreen(Screen, () => json(data), async (renderer) => {
        assert.equal(button(renderer).props.title, title);
        assert.equal(badge(renderer).length, count === null ? 0 : 1);
        if (count !== null) { assert.equal(text(badge(renderer)[0]), count); assert.equal(badge(renderer)[0].props.className.includes("bg-red-500"), alarm); }
      });
    }
    await withScreen(Screen, () => new Promise<Response>(() => {}), async (renderer) => { assert.equal(badge(renderer).length, 0); });
  });
  test(`C3 ${Screen.name}: provider-inclusive callers request only desk, one shared 60-second refresh`, async () => {
    await withScreen(Screen, () => json(desk()), async (renderer, calls, ticks) => {
      assert.deepEqual(calls, ["/clinic/open-charts/desk"]);
      await act(async () => button(renderer).props.onClick());
      assert.deepEqual(calls, ["/clinic/open-charts/desk"]);
      assert.equal(ticks.length, 1);
      await act(async () => ticks[0]());
      assert.deepEqual(calls, ["/clinic/open-charts/desk", "/clinic/open-charts/desk"]);
    });
  });
  test(`C4 C5 C6 C8 C9 ${Screen.name}: real panel has inert desk rows, owner summaries, zone times and incomplete note`, async () => {
    const oldZone = process.env.TZ;
    process.env.TZ = "Asia/Tokyo";
    try {
      await withScreen(Screen, () => json(desk({ complete: false })), async (renderer) => {
        await act(async () => button(renderer).props.onClick());
        const body = panel(renderer);
        const content = text(body);
        for (const phrase of ["Today Patient", "Dr One", "Prior Patient", "Unassigned", "10:00 AM", "chart open", "from Mon, Sep 21", "Dr One — 3 older · oldest Tue, Sep 1", "Unassigned — 2 older · oldest Thu, Aug 20", "Some counts may be incomplete."]) assert.ok(content.includes(phrase), phrase);
        assert.equal(body.findAll((node) => node.type === "a" || node.type === "button").length, 0);
        assert.equal(body.findAll((node) => Object.keys(node.props).some((key) => /^on[A-Z]/.test(key))).length, 0);
        for (const phrase of [...REASONS, "Show older", "Open charts are unavailable right now."]) assert.ok(!content.includes(phrase), phrase);
        assert.equal(body.findAllByProps({ className: "odos-desk-open-older-owner" }).length, 2);
        assert.equal(body.findAllByProps({ className: "odos-desk-open-row" }).length, 2);
      });
    } finally { if (oldZone === undefined) delete process.env.TZ; else process.env.TZ = oldZone; }
  });
  test(`C4 ${Screen.name}: empty days and absent sections stay explicit`, async () => {
    for (const lastClinicDay of [null, { date: "2026-09-21", count: 0, rows: [] }]) {
      await withScreen(Screen, () => json(desk({ today: { date: "2026-09-23", count: 0, rows: [] }, lastClinicDay, older: { count: 0, byOwner: [] } })), async (renderer) => {
        await act(async () => button(renderer).props.onClick());
        const content = text(panel(renderer));
        assert.ok(content.includes("No open charts today."));
        assert.equal(content.includes("Mon, Sep 21 is clear ✓"), lastClinicDay !== null);
        assert.ok(!content.includes("Older"));
        assert.ok(!content.includes("Some counts may be incomplete."));
      });
    }
  });
  test(`C7 ${Screen.name}: every error sentence replaces data and removes the badge`, async () => {
    for (const [code, status, sentence] of [
      ["practice-time-zone-unset", 409, "Set the practice time zone in Settings → Practice time zone."],
      ["practice-time-zone-invalid", 409, "The practice time-zone setting is invalid — fix it in Settings."],
      ["practice-time-zone-unreadable", 502, "Open charts are unavailable right now."],
    ] as const) {
      let fail = false;
      await withScreen(Screen, () => fail ? json({ code }, status) : json(desk()), async (renderer, _calls, ticks) => {
        assert.equal(text(badge(renderer)[0]), "7");
        fail = true;
        await act(async () => ticks[0]());
        await act(async () => button(renderer).props.onClick());
        assert.equal(badge(renderer).length, 0);
        assert.equal(text(panel(renderer)), sentence);
      });
    }
  });
}
