import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { PreviousExams } from "../src/components/charting/PreviousExams";
import { DiagnosisFindingsTable } from "../src/components/charting/DiagnosisFindingsTable";
import {
  appendPreviousExamsPage,
  formatDiagnosisHistoryDate,
  loadPreviousExamsPage,
  previousDiagnosisRowLabel,
  type PreviousExamDiagnosis,
  type PreviousExamGroup,
  type PreviousExamsPage,
} from "../src/lib/diagnosis-carry-forward";
import type { DiagnosisFindingsPayload } from "../src/lib/diagnosis-findings";

test("previous-exam helpers append unique encounters in server order and summarize exact recorded findings", () => {
  const first = exam("Encounter/older-1", "2026-08-02", "Comprehensive", []);
  const second = exam("Encounter/older-2", "2026-07-10", "Medical", []);
  const duplicate = exam("Encounter/older-1", "2026-08-02", "Comprehensive", []);
  const diagnosis = priorDiagnosis("Condition/source", "Keratoconjunctivitis sicca", "OD", false, [
    { observationReference: "Observation/spk", code: "spk", display: "SPK", presence: "present", grade: "2+", laterality: "OD" },
    { observationReference: "Observation/tbut", code: "tbut", display: "TBUT", presence: "absent", laterality: "OU" },
  ]);

  assert.deepEqual(
    appendPreviousExamsPage([first], page([duplicate, second])).map((row) => row.encounterReference),
    ["Encounter/older-1", "Encounter/older-2"],
  );
  assert.equal(
    previousDiagnosisRowLabel(diagnosis),
    "Keratoconjunctivitis sicca · OD · SPK: present, grade 2+, OD · TBUT: absent, OU",
  );
});

test("previous-exam client rejects malformed successful rows and does not surface unsafe error detail", async () => {
  await assert.rejects(
    loadPreviousExamsPage("Encounter/current", undefined, async () => jsonResponse({ pageSize: 4, encounters: [{ diagnoses: [null] }] })),
    /Previous exams could not be loaded\. Try again\./,
  );
  await assert.rejects(
    loadPreviousExamsPage("Encounter/current", undefined, async () => jsonResponse({ error: "internal\nstack detail" }, 502)),
    /Previous exams could not be loaded\. Try again\./,
  );
  await assert.rejects(
    loadPreviousExamsPage("Encounter/current", undefined, async () => jsonResponse(page([
      exam("Encounter/prior", "2026-08-01", "Medical", [
        priorDiagnosis("Condition/source", "Dry eye syndrome", "OU", true),
      ]),
    ]))),
    /Previous exams could not be loaded\. Try again\./,
  );
});

test("previous-exam client enforces four-row pages, FHIR dates, and trimmed clinical labels", async () => {
  const validDiagnosis = priorDiagnosis("Condition/source", "Dry eye syndrome", "OU", false, [
    { observationReference: "Observation/source", code: "spk", display: "SPK", presence: "present", laterality: "OU" },
  ]);
  const invalidPages = [
    page(Array.from({ length: 5 }, (_, index) => exam(`Encounter/e${index}`, "2026-08-01", "Medical", []))),
    page([exam("Encounter/prior", "not-a-date", "Medical", [])]),
    page([exam("Encounter/prior", "2026-02-30", "Medical", [])]),
    page([exam("Encounter/prior", "2026-08-01T12:00:00+15:00", "Medical", [])]),
    page([exam("Encounter/prior", "2026-08-01", "   ", [])]),
    page([exam("Encounter/prior", "2026-08-01", "Medical", [{ ...validDiagnosis, display: " \t " }])]),
    page([exam("Encounter/prior", "2026-08-01", "Medical", [{
      ...validDiagnosis,
      findings: [{ ...validDiagnosis.findings[0]!, display: " " }],
    }])]),
  ];

  for (const invalid of invalidPages) {
    await assert.rejects(
      loadPreviousExamsPage("Encounter/current", undefined, async () => jsonResponse(invalid)),
      /Previous exams could not be loaded\. Try again\./,
    );
  }

  assert.deepEqual(
    await loadPreviousExamsPage("Encounter/current", undefined, async () => jsonResponse(page([
      exam("Encounter/prior", "2026-08-01T12:30:45-04:00", "Medical", [validDiagnosis]),
    ]))),
    page([exam("Encounter/prior", "2026-08-01T12:30:45-04:00", "Medical", [validDiagnosis])]),
  );
});

test("FHIR history dates preserve partial precision and validate leap seconds and boundary offsets", async () => {
  const validDates = [
    "2026",
    "2026-08",
    "2026-08-01",
    "2016-12-31T23:59:60Z",
    "2026-08-01T00:00:00+14:00",
    "2026-08-01T00:00:00-14:00",
  ];
  for (const date of validDates) {
    const result = await loadPreviousExamsPage(
      "Encounter/current",
      undefined,
      async () => jsonResponse(page([exam("Encounter/prior", date, "Medical", [])])),
    );
    assert.equal(result.encounters[0]?.date, date);
  }

  for (const date of [
    "2026-02-29",
    "2026-08-01T00:00:00+14:01",
    "2026-08-01T00:00:00-14:01",
    "2026-08-01T00:00:00+13:60",
  ]) {
    await assert.rejects(
      loadPreviousExamsPage(
        "Encounter/current",
        undefined,
        async () => jsonResponse(page([exam("Encounter/prior", date, "Medical", [])])),
      ),
      /Previous exams could not be loaded\. Try again\./,
    );
  }

  assert.equal(formatDiagnosisHistoryDate("2026"), "2026");
  assert.equal(formatDiagnosisHistoryDate("2026-08"), "Aug 2026");
  assert.equal(formatDiagnosisHistoryDate("2026-08-01"), "Aug 1, 2026");
  assert.equal(formatDiagnosisHistoryDate("2016-12-31T23:59:60Z"), "Dec 31, 2016");
  assert.equal(formatDiagnosisHistoryDate("2026-08-02T01:00:00+02:00"), "Aug 1, 2026");
});

test("previous exams loads four encounters automatically, keeps them through paging failure, and retries the same cursor", async () => {
  const calls: string[] = [];
  let olderAttempt = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (!url.includes("cursor=")) {
      return jsonResponse(page([
        exam("Encounter/e4", "2026-08-04", "Comprehensive", [priorDiagnosis("Condition/c4", "Fourth", "OU", false)]),
        exam("Encounter/e3", "2026-08-03", "Medical", [priorDiagnosis("Condition/c3", "Third", "OS", false)]),
        exam("Encounter/e2", "2026-08-02", "Follow-up", [priorDiagnosis("Condition/c2", "Second", "OD", false)]),
        exam("Encounter/e1", "2026-08-01", "Annual", [priorDiagnosis("Condition/c1", "First", "OU", false)]),
      ], "cursor-one"));
    }
    olderAttempt += 1;
    if (olderAttempt === 1) {
      return jsonResponse({ error: "Previous exams are temporarily unavailable." }, 502);
    }
    return jsonResponse(page([
      exam("Encounter/e0", "2026-07-01", "Medical", [priorDiagnosis("Condition/c0", "Older", "OD", false)]),
    ]));
  }) as typeof fetch;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<PreviousExams canWriteDiagnosis encounterReference="Encounter/current" onSelectDiagnosis={() => undefined} fetchImpl={fetchImpl} />);
      await flush();
    });

    assert.deepEqual(encounterReferences(renderer), ["Encounter/e4", "Encounter/e3", "Encounter/e2", "Encounter/e1"]);
    const older = () => renderer.root.findByProps({ "aria-label": "Load older encounters" });
    await act(async () => {
      older().props.onClick();
      await flush();
    });
    assert.deepEqual(encounterReferences(renderer), ["Encounter/e4", "Encounter/e3", "Encounter/e2", "Encounter/e1"]);
    assert.equal(renderer.root.findByProps({ role: "alert" }).children.join(""), "Previous exams are temporarily unavailable.");
    assert.equal(older().props.disabled, false);

    await act(async () => {
      older().props.onClick();
      await flush();
    });
    assert.deepEqual(encounterReferences(renderer), ["Encounter/e4", "Encounter/e3", "Encounter/e2", "Encounter/e1", "Encounter/e0"]);
    assert.equal(renderer.root.findAllByProps({ "aria-label": "Load older encounters" }).length, 0);
    assert.equal(calls.filter((url) => url.includes("cursor=cursor-one")).length, 2);
  } finally {
    act(() => renderer?.unmount());
  }
});

test("previous exams renders the exact plain empty state", async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <PreviousExams canWriteDiagnosis
        encounterReference="Encounter/new-patient"
        onSelectDiagnosis={() => undefined}
        fetchImpl={async () => jsonResponse(page([]))}
      />,
    );
    await flush();
  });
  assert.equal(text(renderer), "No previous exams recorded.");
  assert.equal(renderer.root.findAllByProps({ "data-encounter-reference": "Encounter/new-patient" }).length, 0);
  act(() => renderer.unmount());
});

test("visible paging sentinel starts one request per cursor and ignores repeated observer delivery", async () => {
  const previousObserver = globalThis.IntersectionObserver;
  let observerCallback!: IntersectionObserverCallback;
  let resolveOlder!: (response: Response) => void;
  let olderCalls = 0;
  class ObserverStub {
    constructor(callback: IntersectionObserverCallback) { observerCallback = callback; }
    observe() {}
    disconnect() {}
    unobserve() {}
    takeRecords() { return []; }
    readonly root = null;
    readonly rootMargin = "0px";
    readonly thresholds = [0];
  }
  Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: ObserverStub });
  const fetchImpl = (async (input: string | URL | Request) => {
    if (!String(input).includes("cursor=")) {
      return jsonResponse(page([exam("Encounter/e1", "2026-08-01", "Annual", [])], "cursor-two"));
    }
    olderCalls += 1;
    return new Promise<Response>((resolve) => { resolveOlder = resolve; });
  }) as typeof fetch;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <PreviousExams canWriteDiagnosis encounterReference="Encounter/current" onSelectDiagnosis={() => undefined} fetchImpl={fetchImpl} />,
        { createNodeMock: (element) => element.type === "button" ? { nodeType: 1 } : null },
      );
      await flush();
    });
    await act(async () => {
      const entry = { isIntersecting: true } as IntersectionObserverEntry;
      observerCallback([entry], {} as IntersectionObserver);
      observerCallback([entry], {} as IntersectionObserver);
      await flush();
    });
    assert.equal(olderCalls, 1);
    await act(async () => {
      resolveOlder(jsonResponse(page([exam("Encounter/e0", "2026-07-01", "Medical", [])])));
      await flush();
    });
    assert.deepEqual(encounterReferences(renderer), ["Encounter/e1", "Encounter/e0"]);
  } finally {
    act(() => renderer?.unmount());
    Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: previousObserver });
  }
});

test("consumed observer cursors cannot replay or restore paging after a terminal next page", async () => {
  const previousObserver = globalThis.IntersectionObserver;
  const callbacks: IntersectionObserverCallback[] = [];
  const staleCursorOne = deferred<Response>();
  const cursorTwo = deferred<Response>();
  let cursorOneCalls = 0;
  let cursorTwoCalls = 0;
  class ObserverStub {
    constructor(callback: IntersectionObserverCallback) { callbacks.push(callback); }
    observe() {}
    disconnect() {}
    unobserve() {}
    takeRecords() { return []; }
    readonly root = null;
    readonly rootMargin = "0px";
    readonly thresholds = [0];
  }
  Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: ObserverStub });
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (!url.includes("cursor=")) {
      return jsonResponse(page([exam("Encounter/e2", "2026-08-02", "Annual", [])], "cursor-one"));
    }
    if (url.includes("cursor=cursor-one")) {
      cursorOneCalls += 1;
      return cursorOneCalls === 1
        ? jsonResponse(page([exam("Encounter/e1", "2026-08-01", "Medical", [])], "cursor-two"))
        : staleCursorOne.promise;
    }
    cursorTwoCalls += 1;
    return cursorTwo.promise;
  }) as typeof fetch;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <PreviousExams canWriteDiagnosis encounterReference="Encounter/current" onSelectDiagnosis={() => undefined} fetchImpl={fetchImpl} />,
        { createNodeMock: (element) => element.type === "button" ? { nodeType: 1 } : null },
      );
      await flush();
    });
    const visible = [{ isIntersecting: true } as IntersectionObserverEntry];
    await act(async () => {
      callbacks[0]!(visible, {} as IntersectionObserver);
      await flush();
    });
    assert.equal(callbacks.length, 2);

    await act(async () => {
      callbacks[0]!(visible, {} as IntersectionObserver);
      callbacks[1]!(visible, {} as IntersectionObserver);
      await flush();
    });
    await act(async () => {
      cursorTwo.resolve(jsonResponse(page([exam("Encounter/e0", "2026-07-01", "Follow-up", [])])));
      await flush();
      staleCursorOne.resolve(jsonResponse(page([exam("Encounter/replayed", "2026-06-01", "Medical", [])], "cursor-two")));
      await flush();
    });

    assert.equal(cursorOneCalls, 1);
    assert.equal(cursorTwoCalls, 1);
    assert.deepEqual(encounterReferences(renderer), ["Encounter/e2", "Encounter/e1", "Encounter/e0"]);
    assert.equal(renderer.root.findAllByProps({ "aria-label": "Load older encounters" }).length, 0);
  } finally {
    act(() => renderer?.unmount());
    Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: previousObserver });
  }
});

test("encounter changes ignore stale previous-exam responses", async () => {
  let resolveFirst!: (response: Response) => void;
  const fetchImpl = ((input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/first/")) return new Promise<Response>((resolve) => { resolveFirst = resolve; });
    return Promise.resolve(jsonResponse(page([exam("Encounter/second-history", "2026-08-02", "Medical", [])])));
  }) as typeof fetch;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<PreviousExams canWriteDiagnosis encounterReference="Encounter/first" onSelectDiagnosis={() => undefined} fetchImpl={fetchImpl} />);
  });
  await act(async () => {
    renderer.update(<PreviousExams canWriteDiagnosis encounterReference="Encounter/second" onSelectDiagnosis={() => undefined} fetchImpl={fetchImpl} />);
    await flush();
  });
  await act(async () => {
    resolveFirst(jsonResponse(page([exam("Encounter/first-history", "2026-08-01", "Annual", [])])));
    await flush();
  });
  assert.deepEqual(encounterReferences(renderer), ["Encounter/second-history"]);
  act(() => renderer.unmount());
});

test("read-only checked prior diagnoses select without POST while provider pulls are idempotent and row-specific", async () => {
  const selections: string[] = [];
  const requests: Array<{ url: string; body: unknown }> = [];
  let resolveFirstPull!: (response: Response) => void;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!init?.method) {
      return jsonResponse(page([
        exam("Encounter/recent", "2026-08-03", "Medical", [
          priorDiagnosis("Condition/source-checked", "Glaucoma suspect", "OU", true, [], "Condition/current-checked"),
          priorDiagnosis("Condition/source-a", "Dry eye syndrome", "OS", false),
        ]),
        exam("Encounter/older", "2026-07-03", "Follow-up", [
          priorDiagnosis("Condition/source-b", "Dry eye syndrome", "OS", false),
        ]),
      ]));
    }
    requests.push({ url, body: JSON.parse(String(init.body)) });
    if (requests.length === 1) return new Promise<Response>((resolve) => { resolveFirstPull = resolve; });
    return jsonResponse({ conditionReference: "Condition/current-b", alreadyPresent: false });
  }) as typeof fetch;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<PreviousExams encounterReference="Encounter/current" onSelectDiagnosis={(reference) => selections.push(reference)} fetchImpl={fetchImpl} />);
    await flush();
  });
  const row = (reference: string) => renderer.root.findByProps({ "data-source-condition-reference": reference });

  act(() => row("Condition/source-checked").props.onClick());
  assert.deepEqual(selections, ["Condition/current-checked"]);
  assert.equal(requests.length, 0);
  await act(async () => renderer.update(<PreviousExams canWriteDiagnosis encounterReference="Encounter/current" onSelectDiagnosis={(reference) => selections.push(reference)} fetchImpl={fetchImpl} />));

  await act(async () => {
    row("Condition/source-a").props.onClick();
    row("Condition/source-a").props.onClick();
    await flush();
  });
  assert.equal(requests.length, 1);
  assert.match((requests[0]?.body as { commandId: string }).commandId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.deepEqual(requests[0]?.body, {
    commandId: (requests[0]?.body as { commandId: string }).commandId,
    sourceEncounterReference: "Encounter/recent",
    sourceConditionReference: "Condition/source-a",
  });
  await act(async () => {
    resolveFirstPull(jsonResponse({ conditionReference: "Condition/current-a", alreadyPresent: false }));
    await flush();
  });
  assert.equal(row("Condition/source-a").props["aria-pressed"], true);
  assert.equal(row("Condition/source-b").props["aria-pressed"], false);
  assert.deepEqual(selections, ["Condition/current-checked", "Condition/current-a"]);

  await act(async () => {
    row("Condition/source-b").props.onClick();
    await flush();
  });
  assert.equal(requests.length, 2);
  assert.notEqual((requests[1]?.body as { commandId: string }).commandId, (requests[0]?.body as { commandId: string }).commandId);
  assert.deepEqual(requests[1]?.body, {
    commandId: (requests[1]?.body as { commandId: string }).commandId,
    sourceEncounterReference: "Encounter/older",
    sourceConditionReference: "Condition/source-b",
  });
  assert.equal(row("Condition/source-a").props["aria-pressed"], true);
  assert.equal(row("Condition/source-b").props["aria-pressed"], true);
  assert.deepEqual(selections, ["Condition/current-checked", "Condition/current-a", "Condition/current-b"]);
  act(() => renderer.unmount());
});

test("a stale pull cannot release the same row lock owned by the next encounter generation", async () => {
  const pulls: Array<ReturnType<typeof deferred<Response>>> = [];
  const selections: string[] = [];
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    if (!init?.method) {
      return jsonResponse(page([exam("Encounter/source-exam", "2026-08-01", "Medical", [
        priorDiagnosis("Condition/source", "Dry eye syndrome", "OU", false),
      ])]));
    }
    const pending = deferred<Response>();
    pulls.push(pending);
    return pending.promise;
  }) as typeof fetch;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<PreviousExams canWriteDiagnosis encounterReference="Encounter/current-one" onSelectDiagnosis={(reference) => selections.push(reference)} fetchImpl={fetchImpl} />);
      await flush();
    });
    const row = () => renderer.root.findByProps({ "data-source-condition-reference": "Condition/source" });
    await act(async () => {
      row().props.onClick();
      await flush();
    });
    assert.equal(pulls.length, 1);

    await act(async () => {
      renderer.update(<PreviousExams canWriteDiagnosis encounterReference="Encounter/current-two" onSelectDiagnosis={(reference) => selections.push(reference)} fetchImpl={fetchImpl} />);
      await flush();
      row().props.onClick();
      await flush();
    });
    assert.equal(pulls.length, 2);

    await act(async () => {
      pulls[0]!.resolve(jsonResponse({ conditionReference: "Condition/stale-current", alreadyPresent: false }));
      await flush();
      row().props.onClick();
      await flush();
    });
    assert.equal(pulls.length, 2);
    assert.deepEqual(selections, []);

    await act(async () => {
      pulls[1]!.resolve(jsonResponse({ conditionReference: "Condition/new-current", alreadyPresent: false }));
      await flush();
    });
    assert.deepEqual(selections, ["Condition/new-current"]);
  } finally {
    act(() => renderer?.unmount());
  }
});

test("a deferred pull settling after true unmount schedules no state update warning", async () => {
  const pull = deferred<Response>();
  const messages: string[] = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = (...args: unknown[]) => { messages.push(args.map(String).join(" ")); };
  console.warn = (...args: unknown[]) => { messages.push(args.map(String).join(" ")); };
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => init?.method
    ? pull.promise
    : jsonResponse(page([exam("Encounter/source-exam", "2026-08-01", "Medical", [
        priorDiagnosis("Condition/source", "Dry eye syndrome", "OU", false),
      ])]))) as typeof fetch;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<PreviousExams canWriteDiagnosis encounterReference="Encounter/current" onSelectDiagnosis={() => undefined} fetchImpl={fetchImpl} />);
      await flush();
    });
    await act(async () => {
      renderer.root.findByProps({ "data-source-condition-reference": "Condition/source" }).props.onClick();
      await flush();
    });
    act(() => renderer.unmount());
    pull.resolve(jsonResponse({ conditionReference: "Condition/current", alreadyPresent: false }));
    await flush();
    assert.deepEqual(messages, []);
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }
});

test("finding rows distinguish unchanged carried presence, prior absence, and fresh assertions", () => {
  const payload = carryFindingsPayload();
  const renderer = create(
    <DiagnosisFindingsTable
      payload={payload}
      patientReference="Patient/p1"
      conditionReference="Condition/current"
      disabled={false}
      onMutate={() => undefined}
    />,
  );
  const rowText = (display: string) => text(renderer.root.findAllByType("tr").find((row) => text(row).includes(display))!);

  assert.match(rowText("Carried present"), /Chartedcarried/);
  assert.doesNotMatch(rowText("Fresh present"), /carried/);
  assert.match(rowText("Prior absent"), /OfferedPrior: absent · Grade historical-grade · OD/);
  assert.doesNotMatch(rowText("Prior absent"), /Charted/);
  assert.equal(renderer.root.findByProps({ "aria-label": "Record Prior absent present" }).props["aria-pressed"], false);
  assert.equal(renderer.root.findByProps({ "aria-label": "Record Prior absent absent" }).props["aria-pressed"], false);
  assert.doesNotMatch(rowText("Reasserted absent"), /carried/);
  act(() => renderer.unmount());
});

for (const scenario of ["complete", "partial-confirmed", "unconfirmed"] as const) {
  test(`V25 W135 carry refresh event follows ${scenario} server evidence`, async () => {
    const originalWindow = globalThis.window;
    const events: string[] = [];
    const target = new EventTarget();
    target.addEventListener("odos:encounter-findings-changed", event => events.push((event as CustomEvent).detail.encounterReference));
    Object.defineProperty(globalThis, "window", {configurable:true, writable:true, value:target});
    const fetchImpl = (async (_input, init) => {
      if (!init?.method) return jsonResponse(page([exam("Encounter/prior", "2026-08-01", "Medical", [priorDiagnosis("Condition/source", "Dry eye", "OU", false)])]));
      if (scenario === "unconfirmed") throw new Error("response lost before confirmation");
      return scenario === "complete" ? jsonResponse({conditionReference:"Condition/carried",alreadyPresent:false}) : jsonResponse({conditionReference:"Condition/carried",alreadyPresent:false,conditionStep:"applied",planStep:"applied",linkStep:"applied",lineageStep:"not-attempted",findings:{result:"command",complete:false,outcomes:[{target:"OD",status:"unconfirmed",clinicalWrite:"unknown"}]}},502);
    }) as typeof fetch;
    let renderer!: ReactTestRenderer;
    try {
      await act(async()=>{renderer=create(<PreviousExams canWriteDiagnosis encounterReference="Encounter/current" onSelectDiagnosis={()=>undefined} fetchImpl={fetchImpl}/>);await flush();});
      await act(async()=>{renderer.root.findByProps({"data-source-condition-reference":"Condition/source"}).props.onClick();await flush();});
      assert.deepEqual(events, scenario === "unconfirmed" ? [] : ["Encounter/current"], "V25 confirmed carry refreshes overview and the other finding door; unconfirmed transport never claims a write");
    } finally {act(()=>renderer?.unmount());Object.defineProperty(globalThis,"window",{configurable:true,writable:true,value:originalWindow});}
  });
}

test("W142 partial carry shows steps and Finish carrying resends the identical command body", async () => {
  const bodies: string[] = [];
  const selections: string[] = [];
  const fetchImpl = (async (_input, init) => {
    if (!init?.method) return jsonResponse(page([exam("Encounter/prior", "2026-08-01", "Medical", [priorDiagnosis("Condition/source", "Dry eye", "OU", false)])]));
    bodies.push(String(init.body));
    if (bodies.length === 1) return jsonResponse({ conditionReference: "Condition/carried", alreadyPresent: false,
      conditionStep: "applied", planStep: "applied", linkStep: "applied", lineageStep: "not-attempted",
      findings: { result: "command", commandId: JSON.parse(bodies[0]!).commandId, complete: false, executionOrder: [0],
        outcomes: [{ target: "OD", status: "unconfirmed", clinicalWrite: "unknown", cause: "verify-read" }] } }, 502);
    return jsonResponse({ conditionReference: "Condition/carried", alreadyPresent: false,
      conditionStep: "applied", planStep: "applied", linkStep: "applied", lineageStep: "applied",
      findings: { result: "command", commandId: JSON.parse(bodies[0]!).commandId, complete: true, executionOrder: [], outcomes: [] } });
  }) as typeof fetch;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(<PreviousExams canWriteDiagnosis encounterReference="Encounter/current" onSelectDiagnosis={reference => selections.push(reference)} fetchImpl={fetchImpl} />); await flush(); });
    await act(async () => { renderer.root.findByProps({ "data-source-condition-reference": "Condition/source" }).props.onClick(); await flush(); });
    assert.deepEqual(selections, []);
    assert.match(text(renderer), /Diagnosis: applied/);
    assert.match(text(renderer), /Plan: applied/);
    assert.match(text(renderer), /Visit link: applied/);
    assert.match(text(renderer), /Findings: incomplete/);
    assert.match(text(renderer), /Lineage: not-attempted/);
    const retry = renderer.root.findAllByType("button").find(button => text(button) === "Finish carrying");
    assert.ok(retry, "partial carry must remain resumable");
    assert.match(JSON.parse(bodies[0]!).commandId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    await act(async () => { retry.props.onClick(); await flush(); });
    assert.equal(bodies.length, 2);
    assert.equal(bodies[1], bodies[0]);
    assert.deepEqual(selections, ["Condition/carried"]);
  } finally { act(() => renderer?.unmount()); }
});

for (const incomplete of [true,false]) test(`V25 V36 W143 remounted checked carry ${incomplete ? "discovers incomplete plan" : "selects already complete without replan"}`, async () => {
  const requests: any[] = [], selections: string[] = [];
  let reads=0;
  const fetchImpl=(async(_input,init)=>{
    if(!init?.method){reads++;return jsonResponse(page([exam("Encounter/prior","2026-08-01","Medical",[priorDiagnosis("Condition/source","Dry eye","OU",true,[],"Condition/carried")])]));}
    requests.push(JSON.parse(String(init.body)));
    if(incomplete&&requests.length===1)return jsonResponse({reason:"carry-incomplete",conditionReference:"Condition/carried",error:"Another carry is incomplete."},409);
    return jsonResponse({conditionReference:"Condition/carried",alreadyPresent:true});
  }) as typeof fetch;
  let renderer!:ReactTestRenderer;
  try {
    await act(async()=>{renderer=create(<PreviousExams canWriteDiagnosis encounterReference="Encounter/current" onSelectDiagnosis={ref=>selections.push(ref)} fetchImpl={fetchImpl}/>);await flush();});
    await act(async()=>{renderer.root.findByProps({"data-source-condition-reference":"Condition/source"}).props.onClick();await flush();});
    assert.equal(requests.length,1,"W143 checked is not proof that the persisted carry finished");
    assert.equal(requests[0].replan,undefined,"initial verification never forces a new carry plan");
    if(incomplete){
      assert.deepEqual(selections,[]);
      const retry=renderer.root.findAllByType("button").find(button=>text(button)==="Reload and carry findings again");
      assert.ok(retry,"remounted incomplete carry exposes recovery");
      await act(async()=>{retry.props.onClick();await flush();});
      assert.equal(reads,2,"replan first reloads");assert.equal(requests.length,2);assert.equal(requests[1].replan,true);assert.notEqual(requests[0].commandId,requests[1].commandId);
    }
    assert.deepEqual(selections,["Condition/carried"]);
    await act(async()=>{renderer.root.findByProps({"data-source-condition-reference":"Condition/source"}).props.onClick();await flush();});
    assert.equal(requests.length,incomplete?2:1,"confirmed completed carry selects without another POST");
  }finally{act(()=>renderer?.unmount());}
});

test("W143 carry-incomplete reloads before replan with a new command and blocks while reload is unresolved", async () => {
  const order: string[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  const reload = deferred<Response>();
  let gets = 0;
  const prior = page([exam("Encounter/prior", "2026-08-01", "Medical", [priorDiagnosis("Condition/source", "Dry eye", "OU", false)])]);
  const fetchImpl = (async (_input, init) => {
    if (!init?.method) { gets++; order.push("GET"); return gets === 1 ? jsonResponse(prior) : reload.promise; }
    order.push("POST"); bodies.push(JSON.parse(String(init.body)));
    return bodies.length === 1 ? jsonResponse({ reason: "carry-incomplete", error: "Another carry is incomplete.", commandId: "other-command", conditionReference: "Condition/carried" }, 409)
      : jsonResponse({ conditionReference: "Condition/carried", alreadyPresent: true });
  }) as typeof fetch;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(<PreviousExams canWriteDiagnosis encounterReference="Encounter/current" onSelectDiagnosis={() => undefined} fetchImpl={fetchImpl} />); await flush(); });
    await act(async () => { renderer.root.findByProps({ "data-source-condition-reference": "Condition/source" }).props.onClick(); await flush(); });
    const replan = renderer.root.findAllByType("button").find(button => text(button) === "Reload and carry findings again");
    assert.ok(replan, "carry-incomplete must offer a reload and a new plan");
    await act(async () => { replan.props.onClick(); await flush(); });
    assert.deepEqual(order, ["GET", "POST", "GET"]);
    assert.equal(bodies.length, 1);
    await act(async () => { reload.resolve(jsonResponse(prior)); await flush(); });
    assert.deepEqual(order, ["GET", "POST", "GET", "POST"]);
    assert.equal(bodies[1]?.replan, true);
    assert.notEqual(bodies[1]?.commandId, bodies[0]?.commandId);
    assert.notEqual(bodies[1]?.commandId, "other-command");
    assert.equal(bodies[1]?.sourceConditionReference, "Condition/source");
  } finally { act(() => renderer?.unmount()); }
});

test("W145 previous-exams unscoped records display their notice, including an empty page", async () => {
  for (const unscopedCount of [2, 0]) {
    let renderer!: ReactTestRenderer;
    try {
      await act(async () => { renderer = create(<PreviousExams encounterReference="Encounter/current" onSelectDiagnosis={() => undefined} fetchImpl={async () => jsonResponse({ ...page([]), unscopedCount })} />); await flush(); });
      assert.equal(text(renderer).includes("Some older records could not be placed on a visit"), unscopedCount > 0);
    } finally { act(() => renderer?.unmount()); }
  }
});

test("W142 a dropped pull response keeps its request for Finish carrying", async () => {
  const bodies: string[] = [];
  const fetchImpl = (async (_input, init) => {
    if (!init?.method) return jsonResponse(page([exam("Encounter/prior", "2026-08-01", "Medical", [priorDiagnosis("Condition/source", "Dry eye", "OU", false)])]));
    bodies.push(String(init.body));
    if (bodies.length === 1) throw new TypeError("Network connection lost");
    return jsonResponse({ conditionReference: "Condition/carried", alreadyPresent: true });
  }) as typeof fetch;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(<PreviousExams canWriteDiagnosis encounterReference="Encounter/current" onSelectDiagnosis={() => undefined} fetchImpl={fetchImpl} />); await flush(); });
    await act(async () => { renderer.root.findByProps({ "data-source-condition-reference": "Condition/source" }).props.onClick(); await flush(); });
    const retry = renderer.root.findAllByType("button").find(button => text(button) === "Finish carrying");
    assert.ok(retry);
    await act(async () => { retry.props.onClick(); await flush(); });
    assert.equal(bodies.length, 2);
    assert.equal(bodies[1], bodies[0]);
    assert.equal(renderer.root.findByProps({ "data-source-condition-reference": "Condition/source" }).props["aria-pressed"], true);
  } finally { act(() => renderer?.unmount()); }
});

test("W143 failed reload preserves the prior carry and never posts a replan", async () => {
  let gets = 0, posts = 0;
  const fetchImpl = (async (_input, init) => {
    if (!init?.method) return ++gets === 1 ? jsonResponse(page([exam("Encounter/prior", "2026-08-01", "Medical", [priorDiagnosis("Condition/source", "Dry eye", "OU", false)])])) : jsonResponse({ error: "Reload unavailable" }, 503);
    posts++;
    return jsonResponse({ reason: "carry-incomplete", error: "Another carry is incomplete.", commandId: "other-command", conditionReference: "Condition/carried" }, 409);
  }) as typeof fetch;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(<PreviousExams canWriteDiagnosis encounterReference="Encounter/current" onSelectDiagnosis={() => undefined} fetchImpl={fetchImpl} />); await flush(); });
    await act(async () => { renderer.root.findByProps({ "data-source-condition-reference": "Condition/source" }).props.onClick(); await flush(); });
    const retry = renderer.root.findAllByType("button").find(button => text(button) === "Reload and carry findings again");
    assert.ok(retry);
    await act(async () => { retry.props.onClick(); await flush(); });
    assert.equal(gets, 2);
    assert.equal(posts, 1);
    assert.match(text(renderer), /Reload unavailable/);
    assert.equal(renderer.root.findByProps({ "data-source-condition-reference": "Condition/source" }).props["aria-pressed"], false);
  } finally { act(() => renderer?.unmount()); }
});

function priorDiagnosis(
  conditionReference: string,
  display: string,
  laterality: "OD" | "OS" | "OU" | "UNKNOWN",
  checked: boolean,
  findings: PreviousExamDiagnosis["findings"] = [],
  currentConditionReference?: string,
): PreviousExamDiagnosis {
  return {
    conditionReference,
    display,
    identity: { coding: [{ system: "urn:test", code: conditionReference }], laterality },
    findings,
    checked,
    ...(currentConditionReference ? { currentConditionReference } : {}),
  };
}

function exam(encounterReference: string, date: string, visitType: string, diagnoses: PreviousExamDiagnosis[]): PreviousExamGroup {
  return { encounterReference, date, visitType, diagnoses };
}

function page(encounters: PreviousExamGroup[], nextCursor?: string): PreviousExamsPage {
  return { pageSize: 4, encounters, ...(nextCursor ? { nextCursor } : {}) };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function encounterReferences(renderer: ReactTestRenderer): string[] {
  return renderer.root.findAll((node) => typeof node.props["data-encounter-reference"] === "string")
    .map((node) => node.props["data-encounter-reference"]);
}

function text(node: ReactTestRenderer | ReactTestRenderer["root"]): string {
  const value = "toJSON" in node ? node.toJSON() : node;
  return collectText(value);
}

function collectText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(collectText).join("");
  if (!value || typeof value !== "object") return "";
  if ("children" in value) return collectText((value as { children?: unknown }).children);
  return "";
}

function carryFindingsPayload(): DiagnosisFindingsPayload {
  const base = {
    findingDefinitionId: "definition",
    findingDefinitionKey: "section",
    fieldCode: "field",
    sectionKey: "lens",
    gradeScale: [] as string[],
    diagnosisKeys: ["selected"],
    origin: "shipped" as const,
    laterality: "OD" as const,
    eye: "OD" as const,
    qualifiers: {}, editable: true,
  };
  const findings = [
    { ...base, atomicFindingId: "section::field::carried", optionCode: "carried", display: "Carried present", kind: "fact" as const, status: "live" as const, presence: "present" as const, conditionReference: "Condition/current", carried: true },
    { ...base, atomicFindingId: "section::field::fresh", optionCode: "fresh", display: "Fresh present", kind: "fact" as const, status: "live" as const, presence: "present" as const, conditionReference: "Condition/current" },
    { ...base, atomicFindingId: "section::field::prior", optionCode: "prior", display: "Prior absent", kind: "offered" as const, status: "offered" as const, priorPresence: "absent" as const, priorGrade: "historical-grade", priorLaterality: "OD" as const },
    { ...base, atomicFindingId: "section::field::reasserted", optionCode: "reasserted", display: "Reasserted absent", kind: "fact" as const, status: "live" as const, presence: "absent" as const, conditionReference: "Condition/current" },
  ].map((row) => {
    const key = { v: 1 as const, patientId: "p1", encounterId: "e1", stableKey: "section", fieldCode: "field", optionCode: row.optionCode, eye: row.eye };
    const reference = `Observation/${row.optionCode}`;
    return { ...row, rowKey: `${row.optionCode}:OD`, key,
      homes: row.kind === "fact" ? ["Condition/current"] : [],
      homeSources: row.kind === "fact" ? [{ condition: "Condition/current", sources: [{ kind: "finding-extension" as const, contributor: { reference, versionId: "1" } }] }] : [],
      baseline: row.kind === "fact" ? { kind: "canonical" as const, reference, versionId: "1" } : { kind: "absent" as const, key },
      contributors: row.kind === "fact" ? [{ reference, versionId: "1", kind: "canonical-fact" }] : [],
    };
  });
  return {
    encounterEditable: true, searchIndex: findings, auditDebt: [],
    canWrite: true, canWriteDiagnosis: true,
    findings,
    catalog: findings.map(({ atomicFindingId, findingDefinitionId, findingDefinitionKey, fieldCode, optionCode, display, sectionKey, gradeScale, diagnosisKeys, origin }) => ({ atomicFindingId, findingDefinitionId, findingDefinitionKey, fieldCode, optionCode, display, sectionKey, gradeScale, diagnosisKeys, origin })),
    unassigned: [],
    bySection: { lens: findings },
    visitDiagnoses: [],
  };
}

for (const canWriteDiagnosis of [false, undefined]) {
  test(`STAFF-DX-GATE carry-forward permits existing selection and refuses new pulls: ${canWriteDiagnosis}`, async () => {
    const selections: string[] = [];
    let writes = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.method) {
        writes += 1;
        return jsonResponse({ conditionReference: "Condition/unexpected", alreadyPresent: false });
      }
      return jsonResponse(page([exam("Encounter/recent", "2026-08-03", "Medical", [
        priorDiagnosis("Condition/checked", "Existing diagnosis", "OU", true, [], "Condition/current"),
        priorDiagnosis("Condition/unpulled", "Prior diagnosis", "OS", false),
      ])]));
    };
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<PreviousExams encounterReference="Encounter/current" canWriteDiagnosis={canWriteDiagnosis} onSelectDiagnosis={(reference) => selections.push(reference)} fetchImpl={fetchImpl} />);
      await flush();
    });
    try {
      const checked = renderer.root.findByProps({ "data-source-condition-reference": "Condition/checked" });
      const unpulled = renderer.root.findByProps({ "data-source-condition-reference": "Condition/unpulled" });
      assert.equal(checked.props.disabled, false);
      assert.equal(unpulled.props.disabled, true);
      await act(async () => { await checked.props.onClick(); await unpulled.props.onClick(); });
      assert.deepEqual(selections, ["Condition/current"]);
      assert.equal(writes, 0);
    } finally {
      act(() => renderer.unmount());
    }
  });
}
