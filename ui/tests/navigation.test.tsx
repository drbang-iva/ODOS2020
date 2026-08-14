import assert from "node:assert/strict";
import { test } from "node:test";
import {
  confirmPopstateNavigation,
  initializeAppHistory,
  interceptAppNavigation,
  markProgrammaticNavigationConfirmed,
  restoreCancelledHistoryNavigation,
  registerNavigationBlocker,
} from "../src/lib/navigation";

function anchor(href: string, attributes: Record<string, string> = {}): HTMLAnchorElement {
  return {
    target: attributes.target ?? "",
    getAttribute: (name: string) => name === "href" ? href : attributes[name] ?? null,
    hasAttribute: (name: string) => name in attributes,
  } as HTMLAnchorElement;
}

function clickEvent(link: HTMLAnchorElement, options: Partial<MouseEvent> = {}) {
  let prevented = false;
  const event = {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    target: { closest: () => link },
    preventDefault: () => { prevented = true; },
    ...options,
  } as unknown as MouseEvent;
  return { event, wasPrevented: () => prevented };
}

test("same-origin anchor clicks use pushState without assigning location", () => {
  const location = { href: "http://odos.local/settings", origin: "http://odos.local" };
  const pushes: string[] = [];
  const history = { pushState: (_state: unknown, _title: string, url?: string | URL | null) => pushes.push(String(url)) };
  const click = clickEvent(anchor("/settings/staff?from=index#roles"));

  assert.equal(interceptAppNavigation(click.event, location, history), true);
  assert.equal(click.wasPrevented(), true);
  assert.deepEqual(pushes, ["/settings/staff?from=index#roles"]);
  assert.deepEqual(location, { href: "http://odos.local/settings", origin: "http://odos.local" });
});

test("modified, middle, and target-blank anchor clicks retain native navigation", () => {
  const location = { href: "http://odos.local/settings", origin: "http://odos.local" };
  const pushes: string[] = [];
  const history = { pushState: (_state: unknown, _title: string, url?: string | URL | null) => pushes.push(String(url)) };
  const clicks = [
    clickEvent(anchor("/settings/staff"), { metaKey: true }),
    clickEvent(anchor("/settings/staff"), { ctrlKey: true }),
    clickEvent(anchor("/settings/staff"), { shiftKey: true }),
    clickEvent(anchor("/settings/staff"), { altKey: true }),
    clickEvent(anchor("/settings/staff"), { button: 1 }),
    clickEvent(anchor("/settings/staff", { target: "_blank" })),
  ];

  for (const click of clicks) {
    assert.equal(interceptAppNavigation(click.event, location, history), false);
    assert.equal(click.wasPrevented(), false);
  }
  assert.deepEqual(pushes, []);
});

test("external, native, download, hash, and full-page routes retain native navigation", () => {
  const location = { href: "http://odos.local/settings", origin: "http://odos.local" };
  const pushes: string[] = [];
  const history = { pushState: (_state: unknown, _title: string, url?: string | URL | null) => pushes.push(String(url)) };
  const links = [
    anchor("https://example.com/help"),
    anchor("mailto:desk@odos.local"),
    anchor("tel:+15551234567"),
    anchor("/settings/staff", { "data-native": "" }),
    anchor("/exports/report.csv", { download: "" }),
    anchor("#roles"),
    anchor("/setpassword/user/secret"),
    anchor("/oauth2/authorize"),
    anchor("/oauth2/grants"),
  ];

  for (const link of links) {
    const click = clickEvent(link);
    assert.equal(interceptAppNavigation(click.event, location, history), false);
    assert.equal(click.wasPrevented(), false);
  }
  assert.deepEqual(pushes, []);
});

test("already-handled internal clicks do not create a second history entry", () => {
  const location = { href: "http://odos.local/desk", origin: "http://odos.local" };
  const pushes: string[] = [];
  const history = { pushState: (_state: unknown, _title: string, url?: string | URL | null) => pushes.push(String(url)) };
  const click = clickEvent(anchor("/settings"), { defaultPrevented: true });

  assert.equal(interceptAppNavigation(click.event, location, history), false);
  assert.deepEqual(pushes, []);
});

test("a blocked settings navigation prevents the same-origin history change", () => {
  const location = { href: "http://odos.local/settings/visit-types", origin: "http://odos.local" };
  const pushes: string[] = [];
  const history = { pushState: (_state: unknown, _title: string, url?: string | URL | null) => pushes.push(String(url)) };
  const click = clickEvent(anchor("/settings"));

  assert.equal(
    interceptAppNavigation(click.event, location, history, () => false),
    false,
  );
  assert.equal(click.wasPrevented(), true);
  assert.deepEqual(pushes, []);
});

test("browser history prompts unless the navigation was already confirmed", () => {
  const unregister = registerNavigationBlocker(() => true);
  try {
    assert.equal(confirmPopstateNavigation(() => false), false);
    markProgrammaticNavigationConfirmed();
    assert.equal(confirmPopstateNavigation(() => false), true);
    assert.equal(confirmPopstateNavigation(() => false), false);
  } finally {
    unregister();
  }
});

test("declining browser Back restores the prior index without changing the history stack", () => {
  const entries = [
    { state: { __odosHistoryIndex: 0 }, url: "/settings" },
    { state: { __odosHistoryIndex: 1 }, url: "/settings/visit-types" },
  ];
  let index = 1;
  let pushes = 0;
  const history = {
    get state() { return entries[index]?.state; },
    get length() { return entries.length; },
    replaceState(state: unknown, _title: string, url?: string | URL | null) {
      entries[index] = { state: state as { __odosHistoryIndex: number }, url: String(url) };
    },
    pushState(state: unknown, _title: string, url?: string | URL | null) {
      pushes += 1;
      entries.splice(index + 1, entries.length, {
        state: state as { __odosHistoryIndex: number },
        url: String(url),
      });
      index += 1;
    },
    go(delta: number) { index += delta; },
  };
  const priorIndex = initializeAppHistory(history, "/settings/visit-types");
  const originalLength = history.length;

  index = 0;
  assert.equal(
    restoreCancelledHistoryNavigation(history, priorIndex, entries[index]!.state),
    true,
  );
  assert.equal(index, 1);
  assert.equal(history.length, originalLength);
  assert.equal(pushes, 0);
});

test("declining browser Forward restores the prior index without truncating forward history", () => {
  const entries = [
    { state: { __odosHistoryIndex: 0 }, url: "/settings" },
    { state: { __odosHistoryIndex: 1 }, url: "/settings/visit-types" },
    { state: { __odosHistoryIndex: 2 }, url: "/desk" },
  ];
  let index = 1;
  let pushes = 0;
  const history = {
    get state() { return entries[index]?.state; },
    pushState() { pushes += 1; },
    go(delta: number) { index += delta; },
  };
  const originalLength = entries.length;

  index = 2;
  assert.equal(
    restoreCancelledHistoryNavigation(history, 1, entries[index]!.state),
    true,
  );
  assert.equal(index, 1);
  assert.equal(entries.length, originalLength);
  assert.equal(pushes, 0);
  assert.equal(entries[2]?.url, "/desk");
});

test("an unindexed pre-app history target uses the browser position without adding an entry", () => {
  let index = 0;
  let pushes = 0;
  const history = {
    pushState() { pushes += 1; },
    go(delta: number) { index += delta; },
  };

  assert.equal(
    restoreCancelledHistoryNavigation(history, 1, {}, 0),
    true,
  );
  assert.equal(index, 1);
  assert.equal(pushes, 0);
});

test("an unindexed target without a browser position is reported as unrestorable", () => {
  let traversals = 0;
  const history = {
    pushState() {},
    go() { traversals += 1; },
  };

  assert.equal(restoreCancelledHistoryNavigation(history, 1, {}), false);
  assert.equal(traversals, 0);
});
