import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Patient } from "@medplum/fhirtypes";
import type { ClinicSummary } from "../src/lib/clinic-summary";
import { fetchPatientOverview, type PatientOverviewPayload } from "../src/lib/patient-overview";
import { patientOverviewView, useViewState } from "../src/lib/view-state";
import { ClinicHome } from "../src/scenes/ClinicHome";
import { PatientOverview } from "../src/scenes/PatientOverview";

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
    assert.match(source, /patientOverviewView\(/, `${relativePath} must enter the overview`);
  }
});

test("seeded overview renders real snapshot data, newest-first visits, and linked dx chips", () => {
  const html = renderToStaticMarkup(<PatientOverview patient={patient} initialOverview={fixture()} />);
  assert.match(html, /Howard Enwright/);
  assert.match(html, /Ocular condition/);
  assert.match(html, /One drop nightly/);
  assert.match(html, /Former smoker/);
  assert.ok(html.indexOf("Jun 30") < html.indexOf("Feb 02"));
  assert.match(html, /DX-NEW/);
  assert.match(html, /Start today&#x27;s visit →/);
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
