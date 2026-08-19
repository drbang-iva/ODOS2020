import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LoginScreen, PASSWORD_RESET_CONFIRMATION, requestPasswordReset, submitLogin } from "../src/scenes/LoginScreen";
import { PasswordResetTransportError } from "../src/lib/auth-api";
import { fetchWhoAmI } from "../src/lib/practice-roles";
import { fetchDeskSummary, type DeskSummary } from "../src/lib/desk-summary";
import { triageInboundFax } from "../src/lib/inbound-fax";
import { submitSetPassword } from "../src/scenes/SetPasswordScreen";
import { CLINIC_PATH, COCKPIT_HOVER_CLOSE_DELAY_MS, DESK_CARD_STORAGE_KEY, DESK_HOME_PATH, DeskHome, displayStat, loadDeskCardIds, reorderDeskCards, sanitizeDeskCardIds } from "../src/scenes/DeskHome";
import { clearCockpitPanelPosition, COCKPIT_PANEL_POSITION_STORAGE_KEY, loadCockpitPanelPosition, saveCockpitPanelPosition } from "../src/scenes/frontdesk/CockpitGuestPanel";

test("login screen renders real email and password fields with no environment credential fallback", () => {
  const html = renderToStaticMarkup(<LoginScreen returnTo={DESK_HOME_PATH} onAuthenticated={() => undefined} />);
  assert.match(html, /type="email"/);
  assert.match(html, /autoComplete="username"/);
  assert.match(html, /type="password"/);
  assert.match(html, /autoComplete="current-password"/);
  assert.doesNotMatch(html, /VITE_MEDPLUM_ADMIN/);
});

test("successful login navigates to the requested Desk home and authenticates", async () => {
  const events: string[] = [];
  await submitLogin({
    email: "admin@example.test",
    password: "valid",
    returnTo: DESK_HOME_PATH,
    login: async () => { events.push("login"); },
    navigate: (path) => events.push(`navigate:${path}`),
    onAuthenticated: () => events.push("authenticated"),
  });
  assert.deepEqual(events, ["login", `navigate:${DESK_HOME_PATH}`, "authenticated"]);
});

test("failed login never navigates or authenticates", async () => {
  const events: string[] = [];
  await assert.rejects(() => submitLogin({
    email: "admin@example.test",
    password: "invalid",
    returnTo: DESK_HOME_PATH,
    login: async () => { throw new Error("Invalid credentials"); },
    navigate: (path) => events.push(`navigate:${path}`),
    onAuthenticated: () => events.push("authenticated"),
  }), /Invalid credentials/);
  assert.deepEqual(events, []);
});

test("set-password submit passes the email-link credentials and new password", async () => {
  const calls: unknown[][] = [];
  await submitSetPassword({
    id: "user-id",
    secret: "email-secret",
    password: "new-password",
    confirmPassword: "new-password",
    setPassword: async (...args) => { calls.push(args); },
  });
  assert.deepEqual(calls, [["user-id", "email-secret", "new-password"]]);
});

test("set-password submit surfaces server failures", async () => {
  await assert.rejects(() => submitSetPassword({
    id: "user-id",
    secret: "expired-secret",
    password: "new-password",
    confirmPassword: "new-password",
    setPassword: async () => { throw new Error("FHIR 400 Bad Request: Reset link expired"); },
  }), /Reset link expired/);
});

test("forgot-password confirmation is neutral on success and failure", async () => {
  const success = await requestPasswordReset("known@example.test", async () => undefined);
  const failure = await requestPasswordReset("unknown@example.test", async () => {
    throw new Error("Account not found");
  });
  assert.equal(success, PASSWORD_RESET_CONFIRMATION);
  assert.equal(failure, PASSWORD_RESET_CONFIRMATION);
});

test("forgot-password transport failure does not claim an email is coming", async () => {
  await assert.rejects(
    () => requestPasswordReset("person@example.test", async () => {
      throw new PasswordResetTransportError(new Error("connection refused"));
    }),
    /could not reach ODOS/,
  );
});

test("whoami no-role errors render the server detail instead of only the machine code", async () => {
  await assert.rejects(
    () => fetchWhoAmI(async () => new Response(JSON.stringify({
      error: "no-practice-role",
      detail: "Account person@example.test has no practice role. An administrator must grant one.",
    }), { status: 403, headers: { "Content-Type": "application/json" } })),
    /Account person@example.test has no practice role/,
  );
});

test("whoami and Desk summary empty error bodies surface their HTTP status", async () => {
  await assert.rejects(
    () => fetchWhoAmI(async () => new Response(null, { status: 502 })),
    /Practice role lookup failed with HTTP 502\./,
  );
  await assert.rejects(
    () => fetchDeskSummary(async () => new Response(null, { status: 503 })),
    /Desk summary failed with HTTP 503\./,
  );
});

test("whoami and Desk summary reject successful empty or non-JSON bodies", async () => {
  await assert.rejects(
    () => fetchWhoAmI(async () => new Response(null, { status: 200 })),
    /Practice role lookup failed with HTTP 200\./,
  );
  await assert.rejects(
    () => fetchDeskSummary(async () => new Response("not-json", { status: 200 })),
    /Desk summary failed with HTTP 200\./,
  );
});

test("inbound fax actions accept empty success bodies and preserve JSON error details", async () => {
  await triageInboundFax(
    "fax-1",
    "inbox",
    {},
    async () => new Response(null, { status: 200 }),
  );
  await assert.rejects(
    triageInboundFax(
      "fax-1",
      "attach",
      { patientReference: "Patient/p1" },
      async () => new Response(JSON.stringify({ error: "Synthetic conflict" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    ),
    /Synthetic conflict/,
  );
});

test("Desk home keeps Customize on-page and leaves global navigation to AppShell", () => {
  const html = renderToStaticMarkup(<DeskHome />);
  assert.match(html, /The Desk/);
  assert.match(html, /Customize/);
  assert.match(html, /Electronic remits/);
  assert.match(html, /href="\/billing\/statements"/);
  assert.doesNotMatch(html, /odos-desk-topbar/);
  assert.doesNotMatch(html, new RegExp(`href="${CLINIC_PATH}"[^>]*target="_blank"`));
});

test("Desk card configuration sanitizes and reorders only catalog cards", () => {
  assert.deepEqual(sanitizeDeskCardIds(["claims", "claims", "bogus", "schedule"]), ["claims", "schedule"]);
  assert.deepEqual(reorderDeskCards(["schedule", "attention", "claims"], "claims", "schedule"), ["claims", "schedule", "attention"]);
});

test("Desk customization persists reorder, remove, add-back, and Reset for all eleven cards", () => {
  const defaults = loadDeskCardIds(undefined);
  assert.equal(defaults.length, 11);
  assert.ok(defaults.includes("correspondence"));
  assert.ok(defaults.includes("front-line"));
  assert.ok(defaults.includes("office"));
  const reordered = reorderDeskCards(defaults, "statements", "schedule");
  const removed = reordered.filter((id) => id !== "front-line");
  const addedBack = [...removed, "front-line"];
  const storage = { getItem: (key: string) => key === DESK_CARD_STORAGE_KEY ? JSON.stringify(addedBack) : null };
  assert.deepEqual(loadDeskCardIds(storage), addedBack);
  assert.deepEqual(sanitizeDeskCardIds(defaults), defaults);
});

test("Front Line without a CommsProvider renders one wiring panel and no zero placeholders", () => {
  const html = renderToStaticMarkup(<DeskHome initialSummary={emptyDeskSummary()} />);
  const frontLine = html.match(/Front Line[\s\S]*?Open desk inbox →/)?.[0] ?? "";
  assert.match(frontLine, /Comms counts arrive with the GHL adapter — Phase 3b/);
  assert.doesNotMatch(frontLine, />0</);
  assert.doesNotMatch(frontLine, /Need reply/);
});

test("Desk home keeps the Correspondence card available when its summary block is absent", () => {
  const summary = emptyDeskSummary();
  const { correspondence: _correspondence, ...cards } = summary.cards;
  const withoutCorrespondence: DeskSummary = { ...summary, cards };
  const html = renderToStaticMarkup(<DeskHome initialSummary={withoutCorrespondence} />);
  assert.match(html, /Correspondence/);
  assert.match(html, /Correspondence <i>· unavailable<\/i>/);
  assert.match(html, /Correspondence counts are unavailable from this ODOS server\./);
});

test("Needs attention renders the exact all-clear state when every target is met", () => {
  const html = renderToStaticMarkup(<DeskHome initialSummary={emptyDeskSummary()} />);
  assert.match(html, /All clear — nothing needs you\./);
  assert.match(html, /Day open · \$0\.00 collected/);
  assert.match(html, /href="\/desk\/ledger"/);
});

test("Desk Correspondence renders inbound fax metadata, advisory matching, PDF view, and all three actions", () => {
  const summary = emptyDeskSummary();
  summary.cards.correspondence.inboundFaxes = { value: 1, tone: "warn" };
  summary.cards.correspondence.items = [{
    kind: "inbound-fax",
    title: "Inbound fax from 8645550199",
    patientReference: "Patient/unknown",
    severity: "info",
    ageMinutes: 5,
    action: "Review and triage",
    owner: "front-desk",
    status: "open",
    faxId: "fax-1",
    receivedAt: "2026-07-31T14:30:00.000Z",
    senderNumber: "8645550199",
    pageCount: 2,
    documentUrl: "/fax/inbound/fax-1/document",
    triageStatus: "received",
    suggestedPatient: { reference: "Patient/p1", display: "Suggested Patient" },
  }];

  const html = renderToStaticMarkup(<DeskHome initialSummary={summary} />);
  assert.match(html, /8645550199/);
  assert.match(html, /2 pages/);
  assert.match(html, /suggestion only; no chart action happens until staff confirms/i);
  assert.match(html, /View PDF/);
  assert.match(html, /Attach to chart/);
  assert.match(html, /Promote to referral/);
  assert.match(html, /General inbox/);
});

test("successful inbound fax triage updates the Desk count and removes the completed row", async () => {
  const summary = emptyDeskSummary();
  summary.cards.correspondence.inboundFaxes = { value: 1, tone: "warn" };
  summary.cards.correspondence.items = [inboundFaxDeskItem()];
  const calls: unknown[][] = [];
  const originalWindow = globalThis.window;
  const windowStub = {
    localStorage: memoryStorage(),
    setInterval: () => 1,
    clearInterval: () => undefined,
  } as unknown as Window & typeof globalThis;
  Object.defineProperty(globalThis, "window", { configurable: true, value: windowStub });
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<DeskHome
        initialSummary={summary}
        initialOfficeMessages={[]}
        inboundFaxApi={{
          triage: async (...args) => { calls.push(args); },
          open: async () => undefined,
        }}
      />);
    });
    const inbox = renderer.root.findAllByType("button").find(
      (button) => button.children.join("") === "General inbox",
    );
    assert.ok(inbox);

    await act(async () => { inbox.props.onClick(); });

    assert.deepEqual(calls, [["fax-1", "inbox", {}]]);
    const inboundStat = renderer.root.findAllByType("div").find((node) =>
      node.props.className?.startsWith("odos-stat-tone-")
      && node.findAllByType("span").some((span) => span.children.includes("Inbound faxes"))
    );
    assert.ok(inboundStat);
    assert.deepEqual(inboundStat.findByType("strong").children, ["0"]);
    assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /General inbox/);
  } finally {
    act(() => renderer?.unmount());
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("inbound fax attach and promote buttons send the confirmed payloads", async () => {
  const originalWindow = globalThis.window;
  const windowStub = {
    localStorage: memoryStorage(),
    setInterval: () => 1,
    clearInterval: () => undefined,
  } as unknown as Window & typeof globalThis;
  Object.defineProperty(globalThis, "window", { configurable: true, value: windowStub });
  let renderer!: ReactTestRenderer;
  const calls: unknown[][] = [];
  const renderFax = async () => {
    const summary = emptyDeskSummary();
    summary.cards.correspondence.inboundFaxes = { value: 1, tone: "warn" };
    summary.cards.correspondence.items = [inboundFaxDeskItem()];
    await act(async () => {
      renderer = create(<DeskHome
        initialSummary={summary}
        initialOfficeMessages={[]}
        inboundFaxApi={{
          triage: async (...args) => { calls.push(args); },
          open: async () => undefined,
        }}
      />);
    });
  };
  try {
    await renderFax();
    const attach = renderer.root.findAllByType("button").find(
      (button) => button.children.join("") === "Attach to chart",
    );
    assert.ok(attach);
    await act(async () => { attach.props.onClick(); });
    assert.deepEqual(calls.shift(), ["fax-1", "attach", { patientReference: "Patient/p1" }]);
    act(() => renderer.unmount());

    await renderFax();
    const inputs = renderer.root.findAllByType("input");
    const performerReference = inputs.find((input) => input.props.placeholder === "Practitioner/…");
    assert.ok(performerReference);
    const performerIndex = inputs.indexOf(performerReference);
    const performerDisplay = inputs[performerIndex + 1];
    assert.ok(performerDisplay);
    act(() => {
      performerReference.props.onChange({ target: { value: "Practitioner/doctor-1" } });
      performerDisplay.props.onChange({ target: { value: "Doctor One" } });
    });
    const promote = renderer.root.findAllByType("button").find(
      (button) => button.children.join("") === "Promote to referral",
    );
    assert.ok(promote);
    assert.equal(promote.props.disabled, false);
    await act(async () => { promote.props.onClick(); });
    assert.deepEqual(calls.shift(), ["fax-1", "promote", {
      patientReference: "Patient/p1",
      patientDisplay: "Suggested Patient",
      referrerDisplay: "Fax sender 8645550199",
      performerReference: "Practitioner/doctor-1",
      performerDisplay: "Doctor One",
      reasonText: "Review inbound fax correspondence",
    }]);
  } finally {
    act(() => renderer?.unmount());
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("inbound fax actions disable while pending and surface failures without removing the row", async () => {
  const summary = emptyDeskSummary();
  summary.cards.correspondence.inboundFaxes = { value: 1, tone: "warn" };
  summary.cards.correspondence.items = [inboundFaxDeskItem()];
  const originalWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: memoryStorage(),
      setInterval: () => 1,
      clearInterval: () => undefined,
    } as unknown as Window & typeof globalThis,
  });
  let rejectAction!: (reason: Error) => void;
  const pending = new Promise<void>((_resolve, reject) => { rejectAction = reject; });
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<DeskHome
        initialSummary={summary}
        initialOfficeMessages={[]}
        inboundFaxApi={{ triage: async () => pending, open: async () => undefined }}
      />);
    });
    const inbox = renderer.root.findAllByType("button").find(
      (button) => button.children.join("") === "General inbox",
    );
    assert.ok(inbox);
    act(() => { inbox.props.onClick(); });
    assert.equal(renderer.root.findAllByType("button").find(
      (button) => button.children.join("") === "General inbox",
    )?.props.disabled, true);

    await act(async () => { rejectAction(new Error("Synthetic triage conflict")); });

    assert.match(renderer.root.findByProps({ role: "alert" }).children.join(""), /Synthetic triage conflict/);
    assert.ok(renderer.root.findAllByType("button").some(
      (button) => button.children.join("") === "General inbox",
    ));
  } finally {
    act(() => renderer?.unmount());
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("Desk statement date-time formatting degrades malformed values to an em dash", () => {
  assert.equal(displayStat("not-a-date", "date-time"), "—");
});

test("Desk comms rail resolves hover, delayed retract, pinning, switching, Escape, close, and touch input", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  let keydown: ((event: KeyboardEvent) => void) | undefined;
  let resize: (() => void) | undefined;
  const storage = memoryStorage();
  const windowStub = {
    innerHeight: 900,
    innerWidth: 1200,
    localStorage: storage,
    matchMedia: () => ({ matches: true }),
    addEventListener: (type: string, listener: EventListener) => {
      if (type === "resize") resize = listener as () => void;
    },
    removeEventListener: (type: string, listener: EventListener) => {
      if (type === "resize" && resize === listener) resize = undefined;
    },
  } as unknown as Window & typeof globalThis;
  const documentStub = {
    addEventListener: (type: string, listener: EventListener) => {
      if (type === "keydown") keydown = listener as (event: KeyboardEvent) => void;
    },
    removeEventListener: (type: string, listener: EventListener) => {
      if (type === "keydown" && keydown === listener) keydown = undefined;
    },
  } as unknown as Document;
  Object.defineProperty(globalThis, "window", { configurable: true, value: windowStub });
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentStub });

  let renderer!: ReactTestRenderer;
  let capturedPointer: number | undefined;
  let releasedPointer: number | undefined;
  const panelRect = () => {
    const style = renderer.root.findByType("aside").props.style;
    const x = Number.parseFloat(style?.["--odos-cockpit-panel-x"] ?? "0");
    const y = Number.parseFloat(style?.["--odos-cockpit-panel-y"] ?? "0");
    return { left: 760 + x, top: 40 + y, width: 380, height: 820 };
  };
  const panelNode = {
    getBoundingClientRect: panelRect,
    querySelector: (selector: string) => selector === "header" ? headerNode : null,
  };
  const headerNode = {
    getBoundingClientRect: () => ({ left: 760, top: 40, width: 380, height: 48 }),
    setPointerCapture: (pointerId: number) => { capturedPointer = pointerId; },
    hasPointerCapture: (pointerId: number) => capturedPointer === pointerId,
    releasePointerCapture: (pointerId: number) => { releasedPointer = pointerId; capturedPointer = undefined; },
  };
  const button = (label: string) => renderer.root.findAllByType("button").find((candidate) => candidate.props["aria-label"] === label)!;
  const dock = () => renderer.root.findByProps({ "aria-label": "Cockpit dock" });
  const panel = () => renderer.root.findByType("aside");
  const dragHandle = () => renderer.root.findByProps({ "data-testid": "cockpit-panel-drag-handle" });
  const panelBody = () => renderer.root.findAllByType("div").find((candidate) => candidate.props.className?.includes("select-text"))!;
  const panelOpen = () => panel().props.role === "dialog";

  try {
    act(() => {
      renderer = create(<DeskHome initialSummary={emptyDeskSummary()} initialOfficeMessages={[]} />, {
        createNodeMock: (element) => element.type === "aside" ? panelNode : {},
      });
    });
    assert.equal(panelOpen(), false);

    act(() => button("Messages").props.onPointerEnter({ pointerType: "mouse" }));
    assert.equal(button("Messages").props["aria-expanded"], true);
    assert.equal(button("Messages").props["aria-pressed"], false);
    assert.equal(panelOpen(), true);
    assert.match(panel().findAllByType("div").flatMap((node) => node.children).join(" "), /Two-way messaging/);

    act(() => dock().props.onPointerLeave({ pointerType: "mouse" }));
    act(() => context.mock.timers.tick(COCKPIT_HOVER_CLOSE_DELAY_MS - 1));
    assert.equal(panelOpen(), true);
    act(() => context.mock.timers.tick(1));
    assert.equal(panelOpen(), false);

    act(() => button("Messages").props.onPointerEnter({ pointerType: "mouse" }));
    act(() => dock().props.onPointerLeave({ pointerType: "mouse" }));
    act(() => context.mock.timers.tick(100));
    act(() => panel().props.onPointerEnter({ pointerType: "mouse" }));
    act(() => context.mock.timers.tick(COCKPIT_HOVER_CLOSE_DELAY_MS));
    assert.equal(panelOpen(), true);

    act(() => button("Messages").props.onClick());
    assert.equal(button("Messages").props["aria-pressed"], true);
    act(() => button("Calls").props.onPointerEnter({ pointerType: "mouse" }));
    assert.equal(button("Messages").props["aria-expanded"], true);
    assert.equal(button("Messages").props["aria-pressed"], true);
    assert.equal(button("Calls").props["aria-expanded"], false);
    assert.equal(button("Calls").props["aria-pressed"], false);
    assert.match(panel().findAllByType("div").flatMap((node) => node.children).join(" "), /Two-way messaging/);
    act(() => dock().props.onPointerLeave({ pointerType: "mouse" }));
    act(() => context.mock.timers.tick(COCKPIT_HOVER_CLOSE_DELAY_MS));
    assert.equal(panelOpen(), true);
    act(() => button("Messages").props.onClick());
    assert.equal(panelOpen(), false);

    act(() => button("Messages").props.onClick());
    act(() => button("Calls").props.onClick());
    assert.equal(button("Messages").props["aria-expanded"], false);
    assert.equal(button("Calls").props["aria-expanded"], true);
    assert.equal(button("Calls").props["aria-pressed"], true);
    assert.match(panel().findAllByType("div").flatMap((node) => node.children).join(" "), /Call history/);

    assert.ok(keydown);
    act(() => keydown?.({ key: "Escape" } as KeyboardEvent));
    assert.equal(panelOpen(), false);

    act(() => button("Requests").props.onPointerEnter({ pointerType: "touch" }));
    assert.equal(panelOpen(), false);
    act(() => button("Requests").props.onClick());
    assert.equal(panelOpen(), true);
    act(() => button("Close panel").props.onClick());
    assert.equal(panelOpen(), false);

    act(() => button("Messages").props.onPointerEnter({ pointerType: "mouse" }));
    assert.equal(panelBody().props.onPointerDown, undefined);
    act(() => dragHandle().props.onPointerDown({
      button: 0,
      clientX: 900,
      clientY: 60,
      currentTarget: headerNode,
      pointerId: 6,
    }));
    act(() => dragHandle().props.onPointerUp({ currentTarget: headerNode, pointerId: 6 }));
    assert.equal(storage.getItem(COCKPIT_PANEL_POSITION_STORAGE_KEY), null);
    act(() => dragHandle().props.onPointerDown({
      button: 0,
      clientX: 900,
      clientY: 60,
      currentTarget: headerNode,
      pointerId: 7,
    }));
    assert.equal(capturedPointer, 7);
    act(() => dragHandle().props.onPointerMove({
      clientX: 2_000,
      clientY: 2_000,
      currentTarget: headerNode,
      pointerId: 7,
      preventDefault: () => undefined,
    }));
    assert.equal(panel().props.style["--odos-cockpit-panel-x"], "60px");
    assert.equal(panel().props.style["--odos-cockpit-panel-y"], "812px");
    assert.match(panel().props.className, /is-floating/);
    assert.equal(button("Messages").props["aria-pressed"], true);
    assert.equal(storage.getItem(COCKPIT_PANEL_POSITION_STORAGE_KEY), null);
    act(() => dock().props.onPointerLeave({ pointerType: "mouse" }));
    act(() => context.mock.timers.tick(COCKPIT_HOVER_CLOSE_DELAY_MS));
    assert.equal(panelOpen(), true);
    act(() => dragHandle().props.onPointerUp({ currentTarget: headerNode, pointerId: 7 }));
    assert.equal(releasedPointer, 7);
    assert.deepEqual(JSON.parse(storage.getItem(COCKPIT_PANEL_POSITION_STORAGE_KEY)!), { floating: true, x: 60, y: 812 });

    windowStub.innerWidth = 900;
    windowStub.innerHeight = 500;
    assert.ok(resize);
    act(() => resize?.());
    assert.equal(panel().props.style["--odos-cockpit-panel-x"], "-240px");
    assert.equal(panel().props.style["--odos-cockpit-panel-y"], "412px");
    assert.deepEqual(JSON.parse(storage.getItem(COCKPIT_PANEL_POSITION_STORAGE_KEY)!), { floating: true, x: -240, y: 412 });
    assert.equal(panelRect().left, 520);
    assert.equal(panelRect().top + 48, 500);
    assert.ok(button("Dock panel to rail"));

    windowStub.innerWidth = 1200;
    windowStub.innerHeight = 900;
    act(() => dragHandle().props.onPointerDown({
      button: 0,
      clientX: 900,
      clientY: 860,
      currentTarget: headerNode,
      pointerId: 8,
    }));
    act(() => dragHandle().props.onPointerMove({
      clientX: -2_000,
      clientY: -2_000,
      currentTarget: headerNode,
      pointerId: 8,
      preventDefault: () => undefined,
    }));
    assert.equal(panel().props.style["--odos-cockpit-panel-x"], "-760px");
    assert.equal(panel().props.style["--odos-cockpit-panel-y"], "-40px");
    assert.deepEqual(JSON.parse(storage.getItem(COCKPIT_PANEL_POSITION_STORAGE_KEY)!), { floating: true, x: -240, y: 412 });
    act(() => dragHandle().props.onPointerUp({ currentTarget: headerNode, pointerId: 8 }));
    assert.deepEqual(JSON.parse(storage.getItem(COCKPIT_PANEL_POSITION_STORAGE_KEY)!), { floating: true, x: -760, y: -40 });

    act(() => button("Calls").props.onClick());
    assert.equal(button("Calls").props["aria-pressed"], true);
    assert.match(panel().findAllByType("div").flatMap((node) => node.children).join(" "), /Call history/);
    act(() => button("Dock panel to rail").props.onClick());
    assert.doesNotMatch(panel().props.className, /is-floating/);
    assert.equal(panel().props.style, undefined);
    assert.equal(storage.getItem(COCKPIT_PANEL_POSITION_STORAGE_KEY), null);
    act(() => dock().props.onPointerLeave({ pointerType: "mouse" }));
    act(() => context.mock.timers.tick(COCKPIT_HOVER_CLOSE_DELAY_MS));
    assert.equal(panelOpen(), false);
  } finally {
    if (renderer) act(() => renderer.unmount());
    context.mock.timers.reset();
    Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("Desk comms panel position storage round-trips and swallows unavailable storage", () => {
  const storage = memoryStorage();
  const position = { floating: true as const, x: -145, y: 212 };
  saveCockpitPanelPosition(position, storage);
  assert.deepEqual(loadCockpitPanelPosition(storage), position);
  clearCockpitPanelPosition(storage);
  assert.equal(loadCockpitPanelPosition(storage), null);

  const throwingStorage = {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); },
    removeItem: () => { throw new Error("blocked"); },
  };
  assert.doesNotThrow(() => saveCockpitPanelPosition(position, throwingStorage));
  assert.doesNotThrow(() => clearCockpitPanelPosition(throwingStorage));
  assert.equal(loadCockpitPanelPosition(throwingStorage), null);
});

test("Desk comms panel uses a reduced-motion-safe translate transition", () => {
  const css = readFileSync(new URL("../src/styles/desk-home.css", import.meta.url), "utf8");
  assert.match(css, /\.odos-cockpit-panel \{[^}]*right: 60px;[^}]*width: min\(380px, calc\(100vw - 76px\)\);[^}]*height: min\(820px, calc\(100vh - 32px\)\);[^}]*border-radius: 28px;/);
  assert.match(css, /\.odos-cockpit-panel \{[^}]*translate3d\(calc\(100% \+ 60px\), -50%, 0\)/);
  assert.match(css, /\.odos-cockpit-panel\.is-open \{[^}]*translate3d\(0, -50%, 0\)/);
  assert.match(css, /\.odos-cockpit-panel\.is-floating \{[^}]*--odos-cockpit-panel-x[^}]*--odos-cockpit-panel-y/);
  assert.match(css, /prefers-reduced-motion: reduce[^}]*\.odos-cockpit-panel \{ transition: none/);
});

function emptyDeskSummary(): DeskSummary {
  const n = { value: 0, tone: "ok" as const };
  const off = { value: null, tone: "off" as const, unavailableReason: "Not wired." };
  return {
    day: { collectedCents: { value: 0, tone: "info" } },
    cards: {
      schedule: { today: n, confirmed: n, checkedIn: { value: 0, tone: "info" }, webRequests: n, agenda: [] },
      attention: { items: [] },
      correspondence: {
        draftsAwaitingSignature: n,
        repliesOwed: n,
        sendFailures: n,
        inboundFaxes: n,
        items: [],
      },
      frontLine: { available: false, message: "Comms counts arrive with the GHL adapter — Phase 3b", needsReply: off, missedCalls: off, voicemails: off, urgent: off, messages: [] },
      pendingRx: { spectacle: { value: 0, tone: "info" }, contactLens: off, labOrdersUnsent: off, oldestWaiting: { value: null, tone: "off" } },
      productPickup: { openOrders: { value: 0, tone: "info" }, atLab: { value: 0, tone: "info" }, readyNotNotified: off, awaitingPickup: { value: 0, tone: "info" } },
      claims: { failed: n, inProcess: { value: 0, tone: "info" }, paperQueue: off, heldCents: n, lastTransmission: { value: null, tone: "off" } },
      payments: { unappliedCount: n, unappliedCents: n, patientCreditsOpen: n, patientOpenBalanceCents: { value: 0, tone: "info" }, terminalMode: { value: "LIVE", tone: "ok" } },
      remits: { waitingToPost: n, unpostedCents: n },
      statements: { available: true, cadence: { value: "Weekly · Wednesdays recommended", tone: "info" }, invalidRejects: n, lastStatement: { value: null, tone: "off" } },
    },
    pulse: { itemsNeedingYou: 0, everythingElseAtTarget: true, lastClaimTransmission: null, lastClaimTransmissionTone: "off" },
  };
}

function inboundFaxDeskItem(): NonNullable<DeskSummary["cards"]["correspondence"]>["items"][number] {
  return {
    kind: "inbound-fax",
    title: "Inbound fax from 8645550199",
    patientReference: "Patient/unknown",
    severity: "info",
    ageMinutes: 5,
    action: "Review and triage",
    owner: "front-desk",
    status: "open",
    faxId: "fax-1",
    receivedAt: "2026-07-31T14:30:00.000Z",
    senderNumber: "8645550199",
    pageCount: 2,
    documentUrl: "/fax/inbound/fax-1/document",
    triageStatus: "received",
    suggestedPatient: { reference: "Patient/p1", display: "Suggested Patient" },
  };
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}
