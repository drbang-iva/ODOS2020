import assert from "node:assert/strict";
import { test } from "node:test";
import { interceptAppNavigation } from "../src/lib/navigation";

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
