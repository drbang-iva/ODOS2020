import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Patient } from "@medplum/fhirtypes";
import type { ClinicSummary } from "../src/lib/clinic-summary";
import {
  fetchPatientOverview,
  type PatientOverviewPayload,
  type PatientOverviewVisitDetail,
} from "../src/lib/patient-overview";
import { openPatientOverview, patientOverviewView, useViewState } from "../src/lib/view-state";
import { normalizeFhirReference, opticalOrderPath } from "../src/lib/optical-order";
import { ClinicHome } from "../src/scenes/ClinicHome";
import { ConsultReportDraftPanel, PatientOverview } from "../src/scenes/PatientOverview";

test("Clinic flow and unsigned-chart clicks both route through PatientOverview", () => {
  useViewState.setState({ view: { kind: "picker" } });
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<ClinicHome initialSummary={clinicSummary} />);
  });
  const root = renderer.root;

  const flowButton = root.findByProps({ className: "odos-clinic-flow-open" });
  act(() => flowButton.props.onClick());
  assert.deepEqual(useViewState.getState().view, { kind: "overview", patientId: "flow-patient" });

  useViewState.setState({ view: { kind: "picker" } });
  const signatureCard = root.findByProps({ "data-testid": "clinic-signatures-card" });
  const signatureButton = signatureCard.findByType("button");
  act(() => signatureButton.props.onClick());
  assert.deepEqual(useViewState.getState().view, { kind: "overview", patientId: "signature-patient" });
});

test("every remaining patient-opening entry point uses the shared overview transition", () => {
  assert.deepEqual(patientOverviewView("patient-1"), { kind: "overview", patientId: "patient-1" });
  for (const relativePath of [
    "../src/scenes/ClinicHome.tsx",
    "../src/scenes/PatientPicker.tsx",
    "../src/scenes/NewPatient.tsx",
    "../src/components/charting/EncounterHeader.tsx",
  ]) {
    const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
    assert.match(source, /openPatientOverview\(/, `${relativePath} must enter the overview`);
  }
});

test("the shared patient transition keeps the selected patient in browser URL state", () => {
  const originalWindow = globalThis.window;
  const originalView = useViewState.getState().view;
  let pushed = "";
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    history: { pushState: (_state: unknown, _unused: string, url?: string | URL | null) => { pushed = String(url); } },
    dispatchEvent: () => true,
  } });
  try {
    openPatientOverview("patient/with spaces");
    assert.equal(pushed, "/clinic?patientId=patient%2Fwith%20spaces");
    assert.deepEqual(useViewState.getState().view, { kind: "overview", patientId: "patient/with spaces" });
  } finally {
    useViewState.setState({ view: originalView });
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("patient overview builds a concrete optical-order route from patient and active Rx", () => {
  assert.equal(
    opticalOrderPath("patient-1", "rx-1"),
    "/dispensary/orders?patient=Patient%2Fpatient-1&rx=VisionPrescription%2Frx-1",
  );
  assert.equal(normalizeFhirReference("https://fhir.example.test/R4/Patient/patient-1", "Patient"), "Patient/patient-1");
  assert.equal(
    opticalOrderPath(
      "https://fhir.example.test/R4/Patient/patient-1",
      "https://fhir.example.test/R4/VisionPrescription/rx-1",
    ),
    "/dispensary/orders?patient=Patient%2Fpatient-1&rx=VisionPrescription%2Frx-1",
  );
});

test("seeded overview renders real snapshot data, newest-first visits, and linked dx chips", () => {
  const html = renderToStaticMarkup(<PatientOverview patient={patient} initialOverview={fixture()} />);
  assert.match(html, /Howard Enwright/);
  assert.match(html, /Ocular condition/);
  assert.match(html, /One drop nightly/);
  assert.match(html, /Former smoker/);
  assert.ok(html.indexOf("Jun 30") < html.indexOf("Feb 02"));
  assert.match(html, /DX-NEW/);
  assert.match(html, /Deposit Credit Bank/);
  assert.match(html, /Start correspondence/);
  assert.match(html, /Start today&#x27;s visit →/);
});

test("patient-record correspondence drafts from the latest signed encounter without an open visit", async () => {
  const inbound = {
    resourceType: "ServiceRequest" as const,
    id: "inbound-1",
    status: "active" as const,
    intent: "order" as const,
    subject: { reference: "Patient/patient-1" },
    requester: { display: "Dr. Outside" },
    reasonCode: [{ text: "Retinal concern" }],
  };
  const calls: string[] = [];
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <ConsultReportDraftPanel
        patientId="patient-1"
        onClose={() => undefined}
        api={{
          listInboundReferrals: async () => [inbound],
          previewConsultReport: async (_patientId, referralId) => {
            calls.push(referralId);
            return {
              serviceRequestReference: "ServiceRequest/inbound-1",
              pdfBase64: "JVBERi1zeW50aGV0aWM=",
              bodyHtml: "<p>Synthetic report</p>",
              documentReference: "DocumentReference/draft-1",
              sourceEncounter: {
                reference: "Encounter/signed-1",
                date: "2026-07-30",
                label: "Clinical content from signed encounter 2026-07-30",
              },
            };
          },
        }}
      />,
    );
    await Promise.resolve();
  });
  const createDraft = renderer.root.findAllByType("button")
    .find((button) => button.children.join("") === "Create consult-report draft");
  assert.ok(createDraft);
  await act(async () => createDraft.props.onClick());

  assert.deepEqual(calls, ["inbound-1"]);
  assert.match(JSON.stringify(renderer.toJSON()), /Clinical content from signed encounter 2026-07-30/);
  assert.equal(renderer.root.findByType("iframe").props.src, "data:application/pdf;base64,JVBERi1zeW50aGV0aWM=");
  renderer.unmount();
});

test("a migrated ledger row is visibly tagged and opens its encounter without requiring a diagnosis chip", () => {
  const migrated = fixture();
  migrated.visits[1] = {
    ...migrated.visits[1]!,
    status: "Migrated",
    diagnoses: [],
  };
  useViewState.setState({ view: { kind: "overview", patientId: "patient-1" } });
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<PatientOverview patient={patient} initialOverview={migrated} />);
  });

  const row = renderer.root.findAllByProps({ className: "odos-visit-row" })
    .find((candidate) => candidate.findAllByProps({ "data-testid": "visit-status-older" }).length > 0);
  assert.ok(row);
  const status = row.findByProps({ "data-testid": "visit-status-older" });
  assert.deepEqual(status.children, ["Migrated"]);
  assert.equal(row.props.role, "button");
  assert.equal(row.props.tabIndex, 0);
  assert.equal(row.props["aria-expanded"], false);
  const openVisit = row.findAllByType("button")
    .find((button) => button.children.join("") === "Open visit");
  assert.ok(openVisit);
  act(() => openVisit.props.onClick({ stopPropagation: () => undefined }));
  assert.deepEqual(useViewState.getState().view, {
    kind: "encounter",
    patientId: "patient-1",
    encounterId: "older",
  });
  for (const key of ["Enter", " "]) {
    useViewState.setState({ view: { kind: "overview", patientId: "patient-1" } });
    act(() => openVisit.props.onKeyDown({
      key,
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    }));
    assert.deepEqual(useViewState.getState().view, {
      kind: "encounter",
      patientId: "patient-1",
      encounterId: "older",
    });
  }
});

test("visit rows lazy-load one accordion summary and drill horizontally with OCT-only numeric depth", async () => {
  const calls: string[] = [];
  const api = {
    fetchOverview: async () => fixture(),
    fetchVisitDetail: async (_patientId: string, encounterId: string) => {
      calls.push(encounterId);
      return detailFixture(encounterId);
    },
    saveNote: async () => fixture().stickyNote!,
    fetchHistory: async () => [],
  };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<PatientOverview patient={patient} initialOverview={fixture()} api={api} />);
  });
  assert.equal(renderer.root.findAllByProps({ className: "odos-visit-explode" }).length, 0);
  assert.equal(renderer.root.findAllByProps({ className: "odos-visit-row" }).length, 2);

  const initialRows = renderer.root.findAll((node) => node.type === "article" && node.props.className === "odos-visit-row");
  await act(async () => initialRows[0]!.props.onClick());
  assert.deepEqual(calls, ["newer"]);
  let rows = renderer.root.findAll((node) => node.type === "article" && String(node.props.className).includes("odos-visit-row"));
  assert.match(rows[0]!.props.className, /is-open/);
  assert.match(rows[1]!.props.className, /is-quiet/);

  const findingsTrigger = renderer.root.findAllByProps({ className: "odos-visit-summary-trigger" })
    .find((button) => button.findByProps({ className: "odos-visit-summary-label" }).children.join("") === "Findings");
  assert.ok(findingsTrigger);
  act(() => findingsTrigger.props.onClick());
  const cards = renderer.root.findAllByProps({ className: "odos-visit-detail-card" });
  const octCard = cards.find((card) => card.findByProps({ className: "odos-visit-card-kicker" }).children.join("") === "OCT RNFL");
  const tearCard = cards.find((card) => card.findByProps({ className: "odos-visit-card-kicker" }).children.join("") === "Tear break-up time");
  assert.ok(octCard);
  assert.ok(tearCard);
  assert.equal(octCard.type, "button");
  assert.equal(tearCard.type, "article");
  act(() => octCard.props.onClick());
  assert.match(JSON.stringify(renderer.toJSON()), /OD average.*84 um/);

  act(() => rows[1]!.props.onClick());
  await act(async () => Promise.resolve());
  assert.deepEqual(calls, ["newer", "older"]);
  rows = renderer.root.findAll((node) => node.type === "article" && String(node.props.className).includes("odos-visit-row"));
  assert.match(rows[0]!.props.className, /is-quiet/);
  assert.match(rows[1]!.props.className, /is-open/);
  assert.equal(renderer.root.findAllByProps({ className: "odos-visit-explode" }).length, 1);

  act(() => rows[1]!.props.onClick());
  rows = renderer.root.findAll((node) => node.type === "article" && String(node.props.className).includes("odos-visit-row"));
  assert.deepEqual(rows.map((row) => row.props.className), ["odos-visit-row", "odos-visit-row"]);
  act(() => rows[1]!.props.onClick());
  assert.deepEqual(calls, ["newer", "older"]);
});

test("focused visit rows toggle Level 1 with Enter and Space", async () => {
  const calls: string[] = [];
  const api = {
    fetchOverview: async () => fixture(),
    fetchVisitDetail: async (_patientId: string, encounterId: string) => {
      calls.push(encounterId);
      return detailFixture(encounterId);
    },
    saveNote: async () => fixture().stickyNote!,
    fetchHistory: async () => [],
  };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<PatientOverview patient={patient} initialOverview={fixture()} api={api} />);
  });
  const row = renderer.root.findAll((node) => node.type === "article" && node.props.className === "odos-visit-row")[0]!;
  assert.equal(row.props.role, "button");
  assert.equal(row.props.tabIndex, 0);
  assert.equal(row.props["aria-expanded"], false);

  const focusedRow = {};
  let prevented = false;
  await act(async () => row.props.onKeyDown({
    key: "Enter",
    target: focusedRow,
    currentTarget: focusedRow,
    preventDefault: () => { prevented = true; },
  }));
  assert.equal(prevented, true);
  assert.deepEqual(calls, ["newer"]);
  assert.equal(renderer.root.findAllByProps({ className: "odos-visit-explode" }).length, 1);
  let currentRow = renderer.root.findAll((node) => node.type === "article" && String(node.props.className).includes("odos-visit-row"))[0]!;
  assert.equal(currentRow.props["aria-expanded"], true);

  prevented = false;
  await act(async () => currentRow.props.onKeyDown({
    key: " ",
    target: focusedRow,
    currentTarget: focusedRow,
    preventDefault: () => { prevented = true; },
  }));
  assert.equal(prevented, true);
  assert.deepEqual(calls, ["newer"]);
  assert.equal(renderer.root.findAllByProps({ className: "odos-visit-explode" }).length, 0);
  currentRow = renderer.root.findAll((node) => node.type === "article" && String(node.props.className).includes("odos-visit-row"))[0]!;
  assert.equal(currentRow.props["aria-expanded"], false);
});

test("an expanded migrated row with no diagnoses keeps the existing empty state and reports only not recorded", async () => {
  const migrated = fixture();
  migrated.visits[1] = { ...migrated.visits[1]!, status: "Migrated", diagnoses: [] };
  const api = {
    fetchOverview: async () => migrated,
    fetchVisitDetail: async (_patientId: string, encounterId: string) => emptyDetailFixture(encounterId),
    saveNote: async () => migrated.stickyNote!,
    fetchHistory: async () => [],
  };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<PatientOverview patient={patient} initialOverview={migrated} api={api} />);
  });
  const migratedRow = renderer.root.findAll((node) => node.type === "article" && node.props.className === "odos-visit-row")
    .find((row) => row.findAllByProps({ "data-testid": "visit-status-older" }).length === 1);
  assert.ok(migratedRow);
  await act(async () => migratedRow.props.onClick());
  const rendered = JSON.stringify(renderer.toJSON());
  assert.match(rendered, /No confirmed diagnoses recorded for this visit/);
  assert.equal((rendered.match(/not recorded/g) ?? []).length >= 6, true);
  assert.doesNotMatch(rendered, /placeholder|sample|synthetic/i);
});

test("zero-data overview renders an honest empty state for every snapshot section", () => {
  const empty = fixture();
  empty.insurance = [];
  empty.stickyNote = undefined;
  empty.snapshot = {
    ocularHistory: [], ocularSurgicalHistory: [], medicalConditions: [], socialHistory: [], ophthalmicMedications: [], systemicMedications: [],
  };
  empty.visits = [];
  const html = renderToStaticMarkup(<PatientOverview patient={patient} initialOverview={empty} />);
  assert.equal((html.match(/None recorded/g) ?? []).length, 6);
  assert.match(html, /No sticky note recorded/);
  assert.match(html, /Insurance not recorded/);
  assert.match(html, /No matching visits recorded/);
});

test("visit and diagnosis filters produce a new server request instead of filtering a prefetched page", async () => {
  const calls: string[] = [];
  const fetchImpl = async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(JSON.stringify(fixture()), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  await fetchPatientOverview("patient-1", { filter: "eye-exams" }, fetchImpl as typeof fetch);
  await fetchPatientOverview("patient-1", {
    filter: "office-visits",
    diagnosisSystem: "https://example.test/diagnosis",
    diagnosisCode: "DX-NEW",
  }, fetchImpl as typeof fetch);
  assert.equal(calls.length, 2);
  assert.match(calls[0] ?? "", /filter=eye-exams/);
  assert.match(calls[1] ?? "", /filter=office-visits/);
  assert.match(calls[1] ?? "", /diagnosisCode=DX-NEW/);
});

test("sticky note edit persists and history reveals the returned FHIR versions", async () => {
  const saved: Array<{ patientId: string; text: string }> = [];
  let resolveHistory!: (entries: Array<{ versionId: string; text: string; editedAt?: string; editedBy?: string }>) => void;
  const historyPromise = new Promise<Array<{ versionId: string; text: string; editedAt?: string; editedBy?: string }>>((resolve) => {
    resolveHistory = resolve;
  });
  const api = {
    fetchOverview: async () => fixture(),
    saveNote: async (patientId: string, text: string) => {
      saved.push({ patientId, text });
      return { id: "sticky-1", text, editedAt: "2026-07-11T16:00:00Z", editedBy: "Practitioner/one" };
    },
    fetchHistory: async () => historyPromise,
  };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<PatientOverview patient={patient} initialOverview={fixture()} api={api} />);
  });

  const editButton = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Edit");
  assert.ok(editButton);
  act(() => editButton.props.onClick());
  const textarea = renderer.root.findByType("textarea");
  act(() => textarea.props.onChange({ target: { value: "Updated chart-front note" } }));
  const saveButton = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Save");
  assert.ok(saveButton);
  await act(async () => saveButton.props.onClick());
  assert.deepEqual(saved, [{ patientId: "patient-1", text: "Updated chart-front note" }]);
  assert.match(renderer.toJSON() ? JSON.stringify(renderer.toJSON()) : "", /Updated chart-front note/);

  const historyButton = renderer.root.findAllByType("button").find((button) => button.children.join("") === "History");
  assert.ok(historyButton);
  let historyRequest!: Promise<void>;
  await act(async () => {
    historyRequest = historyButton.props.onClick();
    await Promise.resolve();
  });
  assert.match(JSON.stringify(renderer.toJSON()), /Loading version history/);
  await act(async () => {
    resolveHistory([{ versionId: "2", text: "Updated chart-front note", editedBy: "Practitioner\/one" }]);
    await historyRequest;
  });
  assert.ok(renderer.root.findAllByType("small").some((row) => row.children.join("").startsWith("Version 2")));
});

test("non-JSON overview errors preserve their HTTP status", async () => {
  const fetchImpl = async () => new Response("upstream unavailable", { status: 503 });
  await assert.rejects(
    fetchPatientOverview("patient-1", {}, fetchImpl as typeof fetch),
    /Patient overview request failed with HTTP 503/,
  );
});

test("successful overview responses must contain the expected payload shape", async () => {
  const fetchImpl = async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  await assert.rejects(
    fetchPatientOverview("patient-1", {}, fetchImpl as typeof fetch),
    /Patient overview request returned an invalid response/,
  );

  const malformed = fixture() as unknown as { visits: unknown[] };
  malformed.visits = [{}];
  const malformedFetch = async () => new Response(JSON.stringify(malformed), { status: 200, headers: { "Content-Type": "application/json" } });
  await assert.rejects(
    fetchPatientOverview("patient-1", {}, malformedFetch as typeof fetch),
    /Patient overview request returned an invalid response/,
  );
});

test("initial overview loading skips patients without a FHIR id", () => {
  let fetchCalls = 0;
  const api = {
    fetchOverview: async () => { fetchCalls += 1; return fixture(); },
    saveNote: async () => fixture().stickyNote!,
    fetchHistory: async () => [],
  };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<PatientOverview patient={{ ...patient, id: undefined }} api={api} />);
  });
  assert.equal(fetchCalls, 0);
  const rendered = JSON.stringify(renderer.toJSON());
  assert.match(rendered, /Patient id is unavailable/);
  assert.doesNotMatch(rendered, /Loading patient overview/);
});

test("skipping active-Rx lookup clears a prior lookup error", async () => {
  const api = {
    fetchOverview: async () => fixture(),
    saveNote: async () => fixture().stickyNote!,
    fetchHistory: async () => [],
    findActiveRx: async () => { throw new Error("synthetic Rx lookup failure"); },
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<PatientOverview patient={patient} initialOverview={fixture()} api={api} />);
    await Promise.resolve();
  });
  let orderButton = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Start optical order");
  assert.equal(orderButton?.props.title, "synthetic Rx lookup failure");

  await act(async () => {
    renderer.update(<PatientOverview patient={{ ...patient, id: undefined }} initialOverview={fixture()} api={api} />);
    await Promise.resolve();
  });
  orderButton = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Start optical order");
  assert.equal(orderButton?.props.title, "An active vision prescription is required");
  act(() => renderer.unmount());
});

test("rapid visit-filter requests cannot overwrite the latest result out of order", async () => {
  const pending: Array<(value: PatientOverviewPayload) => void> = [];
  const api = {
    fetchOverview: async () => new Promise<PatientOverviewPayload>((resolve) => pending.push(resolve)),
    saveNote: async () => fixture().stickyNote!,
    fetchHistory: async () => [],
  };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<PatientOverview patient={patient} initialOverview={fixture()} api={api} />);
  });
  const eyeButton = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Eye exams");
  const officeButton = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Office visits");
  assert.ok(eyeButton);
  assert.ok(officeButton);
  await act(async () => {
    eyeButton.props.onClick();
    await Promise.resolve();
  });
  await act(async () => {
    officeButton.props.onClick();
    await Promise.resolve();
  });
  assert.equal(pending.length, 2);

  const office = fixture();
  office.visits[0]!.visitType = "Latest office result";
  await act(async () => pending[1]!(office));
  const eye = fixture();
  eye.visits[0]!.visitType = "Stale eye result";
  await act(async () => pending[0]!(eye));

  const rendered = JSON.stringify(renderer.toJSON());
  assert.match(rendered, /Latest office result/);
  assert.doesNotMatch(rendered, /Stale eye result/);
});

test("filter and history responses started before a sticky save cannot restore stale note state", async () => {
  let resolveOverview!: (value: PatientOverviewPayload) => void;
  let resolveHistory!: (value: Array<{ versionId: string; text: string }>) => void;
  const overviewPromise = new Promise<PatientOverviewPayload>((resolve) => { resolveOverview = resolve; });
  const historyPromise = new Promise<Array<{ versionId: string; text: string }>>((resolve) => { resolveHistory = resolve; });
  const api = {
    fetchOverview: async () => overviewPromise,
    saveNote: async (_patientId: string, text: string) => ({ id: "sticky-1", text }),
    fetchHistory: async () => historyPromise,
  };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<PatientOverview patient={patient} initialOverview={fixture()} api={api} />);
  });

  const eyeButton = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Eye exams");
  const historyButton = renderer.root.findAllByType("button").find((button) => button.children.join("") === "History");
  const editButton = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Edit");
  assert.ok(eyeButton);
  assert.ok(historyButton);
  assert.ok(editButton);
  await act(async () => {
    eyeButton.props.onClick();
    await Promise.resolve();
  });
  let historyRequest!: Promise<void>;
  await act(async () => {
    historyRequest = historyButton.props.onClick();
    await Promise.resolve();
  });
  act(() => editButton.props.onClick());
  act(() => renderer.root.findByType("textarea").props.onChange({ target: { value: "Saved after requests began" } }));
  const saveButton = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Save");
  assert.ok(saveButton);
  await act(async () => saveButton.props.onClick());

  const staleOverview = fixture();
  staleOverview.stickyNote = { id: "sticky-1", text: "Stale server note" };
  await act(async () => resolveOverview(staleOverview));
  await act(async () => {
    resolveHistory([{ versionId: "1", text: "Stale history note" }]);
    await historyRequest;
  });

  const rendered = JSON.stringify(renderer.toJSON());
  assert.match(rendered, /Saved after requests began/);
  assert.doesNotMatch(rendered, /Stale server note|Stale history note|Sticky note history/);
});

test("a history failure invalidated by sticky save does not surface a stale error", async () => {
  let rejectHistory!: (reason: Error) => void;
  const historyPromise = new Promise<Array<{ versionId: string; text: string }>>((_resolve, reject) => { rejectHistory = reject; });
  const api = {
    fetchOverview: async () => fixture(),
    saveNote: async (_patientId: string, text: string) => ({ id: "sticky-1", text }),
    fetchHistory: async () => historyPromise,
  };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<PatientOverview patient={patient} initialOverview={fixture()} api={api} />);
  });
  const historyButton = renderer.root.findAllByType("button").find((button) => button.children.join("") === "History");
  const editButton = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Edit");
  assert.ok(historyButton);
  assert.ok(editButton);
  let historyRequest!: Promise<void>;
  await act(async () => {
    historyRequest = historyButton.props.onClick();
    await Promise.resolve();
  });
  act(() => editButton.props.onClick());
  act(() => renderer.root.findByType("textarea").props.onChange({ target: { value: "Saved note" } }));
  const saveButton = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Save");
  assert.ok(saveButton);
  await act(async () => saveButton.props.onClick());
  await act(async () => {
    rejectHistory(new Error("stale history failure"));
    await historyRequest;
  });
  assert.equal(renderer.root.findAllByProps({ role: "alert" }).length, 0);
});

test("an active history failure replaces the loading placeholder", async () => {
  const api = {
    fetchOverview: async () => fixture(),
    saveNote: async () => fixture().stickyNote!,
    fetchHistory: async () => { throw new Error("History unavailable"); },
  };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<PatientOverview patient={patient} initialOverview={fixture()} api={api} />);
  });
  const historyButton = renderer.root.findAllByType("button").find((button) => button.children.join("") === "History");
  assert.ok(historyButton);
  assert.equal(historyButton.props["aria-controls"], "patient-sticky-history");
  await act(async () => historyButton.props.onClick());
  const rendered = JSON.stringify(renderer.toJSON());
  assert.match(rendered, /History unavailable/);
  assert.doesNotMatch(rendered, /Loading version history/);
});

const patient: Patient = {
  resourceType: "Patient",
  id: "patient-1",
  name: [{ given: ["Howard"], family: "Enwright" }],
  birthDate: "1950-04-09",
  gender: "male",
  identifier: [{ value: "1176" }],
};

const clinicSummary: ClinicSummary = {
  flow: [{
    appointmentId: "appointment-1",
    patientId: "flow-patient",
    time: "9:00 AM",
    patient: "Flow Patient",
    visitType: "Eye exam",
    state: "waiting",
    stateDetail: "checked in",
    flags: { unsigned: false },
  }],
  signatures: {
    count: 1,
    olderThan24Hours: 0,
    rows: [{
      encounterId: "encounter-1",
      patientId: "signature-patient",
      patient: "Signature Patient",
      visitType: "Office visit",
      checkoutAt: "2026-07-11T14:00:00Z",
      ageMinutes: 30,
      olderThan24Hours: false,
    }],
  },
  orders: { count: 0, agingCount: 0, agingThresholdDays: 5, rows: [] },
  erx: { available: false, message: "Not wired" },
  review: { available: false, message: "Not wired" },
};

function fixture(): PatientOverviewPayload {
  return {
    patient,
    insurance: ["Primary plan", "Secondary plan"],
    stickyNote: { id: "sticky-1", text: "Prefers early appointments", editedAt: "2026-03-14T12:00:00Z", editedBy: "Practitioner/one" },
    snapshot: {
      ocularHistory: [{ name: "Ocular condition", laterality: "Both eyes" }],
      ocularSurgicalHistory: [{ name: "Ocular surgery", date: "2020-01-01" }],
      medicalConditions: [{ name: "Medical condition" }],
      socialHistory: ["Former smoker"],
      ophthalmicMedications: [{ name: "Ophthalmic medication", sig: "One drop nightly" }],
      systemicMedications: [{ name: "Systemic medication", sig: "Daily" }],
    },
    visits: [
      {
        encounterId: "newer",
        date: "2026-06-30T12:00:00Z",
        provider: "Dr. Clinician",
        facility: "Practice location",
        visitType: "Eye exam",
        status: "Final",
        diagnoses: [{ conditionId: "dx-new", encounterId: "newer", name: "Newer diagnosis", code: "DX-NEW" }],
      },
      {
        encounterId: "older",
        date: "2026-02-02T12:00:00Z",
        visitType: "Office visit",
        status: "Preliminary",
        diagnoses: [],
      },
    ],
    diagnosisChoices: [{ name: "Newer diagnosis", system: "https://example.test/diagnosis", code: "DX-NEW" }],
  };
}

function detailFixture(encounterId: string): PatientOverviewVisitDetail {
  return {
    encounterId,
    reason: "Recorded visit reason",
    iop: {
      summary: "OD 16 mmHg · OS 17 mmHg",
      cards: [
        { id: `${encounterId}-iop-od`, kicker: "OD", title: "16 mmHg" },
        { id: `${encounterId}-iop-os`, kicker: "OS", title: "17 mmHg" },
      ],
    },
    medications: {
      summary: "Recorded ophthalmic medication",
      cards: [{ id: `${encounterId}-med`, kicker: "Medication", title: "Recorded ophthalmic medication", detail: "One drop nightly" }],
    },
    findings: {
      summary: "OCT RNFL · Tear break-up time",
      cards: [
        {
          id: `${encounterId}-oct`,
          kicker: "OCT RNFL",
          title: "Recorded OCT finding",
          values: [{ label: "OD average", value: "84 um" }],
        },
        {
          id: `${encounterId}-tbut`,
          kicker: "Tear break-up time",
          title: "4 s",
        },
      ],
    },
    plan: {
      summary: "Repeat testing",
      cards: [{ id: `${encounterId}-plan`, kicker: "Plan", title: "Repeat testing" }],
    },
    financial: {
      summary: "1 claim",
      cards: [{ id: `${encounterId}-claim`, kicker: "Claim", title: "Recorded payer", detail: "active" }],
    },
  };
}

function emptyDetailFixture(encounterId: string): PatientOverviewVisitDetail {
  return {
    encounterId,
    iop: { cards: [] },
    findings: { cards: [] },
    medications: { cards: [] },
    plan: { cards: [] },
    financial: { cards: [] },
  };
}
