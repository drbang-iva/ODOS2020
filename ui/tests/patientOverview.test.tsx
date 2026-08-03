import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Bundle, Encounter, Patient, VisionPrescription } from "@medplum/fhirtypes";
import type { ClinicSummary } from "../src/lib/clinic-summary";
import {
  fetchPatientOverview,
  fetchPatientOverviewVisitDetail,
  type PatientOverviewPayload,
  type PatientOverviewVisitDetail,
} from "../src/lib/patient-overview";
import { openPatientOverview, patientOverviewView, useViewState } from "../src/lib/view-state";
import { normalizeFhirReference, opticalOrderPath } from "../src/lib/optical-order";
import { OVERVIEW_PANEL_REGISTRY } from "../src/lib/card-registry";
import { RoleProvider } from "../src/lib/role-context";
import { BalanceChips } from "../src/components/commercial/BalanceChips";
import { CreditBankDepositSheet } from "../src/components/commercial/CreditBankDepositSheet";
import { SaleSheet } from "../src/components/commercial/SaleSheet";
import { ClinicHome } from "../src/scenes/ClinicHome";
import { BillingWeatherReport, ConsultReportDraftPanel, PatientOverview } from "../src/scenes/PatientOverview";
import { StartExam, type StartExamApi } from "../src/components/StartExam";
import { SeriesTrackerPanel } from "../src/components/series-tracker/SeriesTrackerPanel";

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

test("visit explode CSS preserves visible focus fallback and reduced-motion behavior", () => {
  const css = readFileSync(new URL("../src/styles/patient-overview.css", import.meta.url), "utf8");
  assert.match(css, /@supports not selector\(\.odos-visit-row:has\(\.odos-visit-expand-sr:focus-visible\)\)/);
  assert.match(css, /\.odos-visit-expand-sr:focus-visible \{[^}]*clip-path: none;[^}]*outline:/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.odos-visit-summary-line, \.odos-visit-detail-card \{ animation: none; \}/);
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
  assert.doesNotMatch(html, /Deposit Credit Bank|Sell package/);
  assert.match(html, /Start correspondence/);
  assert.match(html, /Start today&#x27;s visit →/);
});

test("overview registry assigns the doctor panel tiers and hides commercial panels", () => {
  const panels = new Map(OVERVIEW_PANEL_REGISTRY.map((panel) => [panel.id, panel]));
  assert.equal(panels.get("billing-weather")?.tier, 1);
  assert.equal(panels.get("billing-weather")?.densityByRole.doctor, "full");
  assert.equal(panels.get("billing-weather")?.densityByRole["front-desk"], "hidden");
  for (const id of ["patient-snapshot", "problem-list", "active-programs", "visit-ledger"] as const) {
    assert.equal(panels.get(id)?.tier, 1);
    assert.equal(panels.get(id)?.densityByRole.doctor, "full");
  }
  for (const id of ["medications", "consult-drafts", "longitudinal-imaging", "optical-order"] as const) {
    assert.equal(panels.get(id)?.tier, 2);
    assert.equal(panels.get(id)?.densityByRole.doctor, "full");
  }
  for (const id of ["product-timeline", "demographic-detail", "document-history"] as const) {
    assert.equal(panels.get(id)?.tier, 3);
    assert.equal(panels.get(id)?.densityByRole.doctor, "compact");
  }
  for (const id of ["sale-sheet", "credit-bank-deposit-sheet", "balance-chips"] as const) {
    assert.equal(panels.get(id)?.densityByRole.doctor, "hidden");
    assert.equal(panels.get(id)?.densityByRole["front-desk"], "full");
  }
});

test("billing weather is doctor-only and defaults uncertain or malformed coverage to gray", () => {
  const uncertain = fixture();
  delete uncertain.billingWeather;
  let doctor!: ReactTestRenderer;
  act(() => {
    doctor = create(<RoleProvider initialRole="doctor"><PatientOverview patient={patient} initialOverview={uncertain} /></RoleProvider>);
  });
  assert.equal(doctor.root.findByProps({ "data-testid": "billing-weather" }).props.className, "odos-billing-weather is-unknown");
  assert.equal(doctor.root.findAllByProps({ "aria-label": "Billing weather: Coverage unknown" }).length, 1);
  act(() => doctor.unmount());

  const malformed = renderToStaticMarkup(<BillingWeatherReport weather={{ state: "covered" }} />);
  assert.match(malformed, /Billing weather: Coverage unknown/);
  assert.doesNotMatch(malformed, /Billing weather: Covered/);

  const high = renderToStaticMarkup(<BillingWeatherReport weather={{ state: "high-deductible", planName: "Synthetic Plan", deductibleRemainingCents: 25_000 }} />);
  assert.match(high, /Billing weather: High deductible/);
  assert.match(high, /Synthetic Plan · \$250 deductible remaining/);

  const fractional = renderToStaticMarkup(<BillingWeatherReport weather={{ state: "high-deductible", deductibleRemainingCents: 25_050 }} />);
  assert.match(fractional, /\$250\.50 deductible remaining/);

  const vip = renderToStaticMarkup(<BillingWeatherReport weather={{ state: "vip-cash", planName: "Synthetic cash relationship" }} />);
  assert.match(vip, /Billing weather: VIP cash/);

  let frontDesk!: ReactTestRenderer;
  act(() => {
    frontDesk = create(<RoleProvider initialRole="front-desk"><PatientOverview patient={patient} initialOverview={{ ...fixture(), billingWeather: { state: "covered", deductibleRemainingCents: 0 } }} /></RoleProvider>);
  });
  assert.equal(frontDesk.root.findAllByProps({ "data-testid": "billing-weather" }).length, 0);
  act(() => frontDesk.unmount());
});

test("the header band contains one StartExam and keeps DOB and age in its identity row", () => {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<RoleProvider initialRole="doctor"><PatientOverview patient={patient} initialOverview={fixture()} /></RoleProvider>);
  });
  const band = renderer.root.findByProps({ className: "odos-overview-band" });
  assert.equal(band.findAllByType(StartExam).length, 1);
  const html = renderToStaticMarkup(<RoleProvider initialRole="doctor"><PatientOverview patient={patient} initialOverview={fixture()} /></RoleProvider>);
  assert.match(html, /odos-overview-band[\s\S]*Howard Enwright[\s\S]*DOB[\s\S]*4\/9\/1950[\s\S]*Age[\s\S]*\d+/);
  assert.equal(renderer.root.findAllByType(StartExam).length, 1);
  act(() => renderer.unmount());
});

test("doctor overview omits all commercial panels while front desk retains them", () => {
  let doctor!: ReactTestRenderer;
  act(() => {
    doctor = create(<RoleProvider initialRole="doctor"><PatientOverview patient={patient} initialOverview={fixture()} /></RoleProvider>);
  });
  assert.equal(doctor.root.findAllByType(BalanceChips).length, 0);
  assert.equal(doctor.root.findAllByType(SaleSheet).length, 0);
  assert.equal(doctor.root.findAllByType(CreditBankDepositSheet).length, 0);
  assert.equal(doctor.root.findAllByType("button").some((button) => button.children.join("") === "Sell package"), false);
  assert.equal(doctor.root.findAllByType("button").some((button) => button.children.join("") === "Deposit Credit Bank"), false);
  act(() => doctor.unmount());

  let frontDesk!: ReactTestRenderer;
  act(() => {
    frontDesk = create(<RoleProvider initialRole="front-desk"><PatientOverview patient={patient} initialOverview={fixture()} /></RoleProvider>);
  });
  assert.equal(frontDesk.root.findAllByType(BalanceChips).length, 1);
  const sell = frontDesk.root.findAllByType("button").find((button) => button.children.join("") === "Sell package");
  const deposit = frontDesk.root.findAllByType("button").find((button) => button.children.join("") === "Deposit Credit Bank");
  assert.ok(sell);
  assert.ok(deposit);
  act(() => sell.props.onClick());
  act(() => deposit.props.onClick());
  assert.equal(frontDesk.root.findAllByType(SaleSheet).length, 1);
  assert.equal(frontDesk.root.findAllByType(CreditBankDepositSheet).length, 1);
  act(() => frontDesk.unmount());
});

test("active-program empty language stays accurate when package status is visible", () => {
  let doctor!: ReactTestRenderer;
  act(() => {
    doctor = create(<RoleProvider initialRole="doctor"><PatientOverview patient={patient} initialOverview={fixture()} /></RoleProvider>);
  });
  assert.equal(doctor.root.findByType(SeriesTrackerPanel).props.emptyMessage, "No active programs");
  act(() => doctor.unmount());

  let frontDesk!: ReactTestRenderer;
  act(() => {
    frontDesk = create(<RoleProvider initialRole="front-desk"><PatientOverview patient={patient} initialOverview={fixture()} /></RoleProvider>);
  });
  assert.equal(frontDesk.root.findByType(SeriesTrackerPanel).props.emptyMessage, "No active treatment series");
  act(() => frontDesk.unmount());
});

test("tier 1 overview panels stay present while empty tier 2 panels stay absent", () => {
  const empty = fixture();
  empty.snapshot = {
    ocularHistory: [], ocularSurgicalHistory: [], medicalConditions: [], socialHistory: [], ophthalmicMedications: [], systemicMedications: [],
  };
  empty.visits = [];
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<RoleProvider initialRole="doctor"><PatientOverview patient={patient} initialOverview={empty} /></RoleProvider>);
  });
  for (const testId of ["overview-patient-snapshot", "overview-problem-list", "overview-active-programs", "overview-visit-ledger"]) {
    assert.equal(renderer.root.findAllByProps({ "data-testid": testId }).length, 1);
  }
  assert.equal(renderer.root.findAllByProps({ "data-testid": "overview-medications" }).length, 0);
  assert.equal(renderer.root.findAllByProps({ "data-testid": "longitudinal-imaging-card" }).length, 0);
  assert.equal(renderer.root.findAllByType("a").some((link) => link.children.join("") === "Start optical order"), false);
  act(() => renderer.unmount());
});

test("a medication retrieval failure stays distinct from empty without rendering an empty Tier 2 panel", () => {
  const unavailable = fixture();
  unavailable.snapshot.ophthalmicMedications = [];
  unavailable.snapshot.systemicMedications = [];
  unavailable.unavailable = { medicationOrders: "Medication orders are temporarily unavailable." };
  const html = renderToStaticMarkup(<PatientOverview patient={patient} initialOverview={unavailable} />);
  assert.doesNotMatch(html, /data-testid="overview-medications"/);
  assert.match(html, /Medication orders are temporarily unavailable/);
  assert.doesNotMatch(html, /No active problems|No visits yet/);
});

test("tier 2 medication and optical-order panels render when content exists", async () => {
  const activeRx: VisionPrescription = {
    resourceType: "VisionPrescription",
    id: "rx-1",
    status: "active",
    created: "2026-07-01",
    patient: { reference: "Patient/patient-1" },
  };
  const api = {
    fetchOverview: async () => fixture(),
    saveNote: async () => fixture().stickyNote!,
    fetchHistory: async () => [],
    findActiveRx: async () => activeRx,
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<RoleProvider initialRole="doctor"><PatientOverview patient={patient} initialOverview={fixture()} api={api} /></RoleProvider>);
    await Promise.resolve();
  });
  assert.equal(renderer.root.findAllByProps({ "data-testid": "overview-medications" }).length, 1);
  const opticalOrder = renderer.root.findAllByType("a").find((link) => link.children.join("") === "Start optical order");
  assert.equal(opticalOrder?.props.href, "/dispensary/orders?patient=Patient%2Fpatient-1&rx=VisionPrescription%2Frx-1");
  act(() => renderer.unmount());
});

test("Start today's visit assigns the provider, starts the encounter, and opens it directly", async () => {
  const calls: string[] = [];
  let transactionCount = 0;
  const api: StartExamApi = {
    loadPrograms: async () => [],
    assignProvider: async () => { calls.push("assign-provider"); },
    createProgram: async () => { throw new Error("Stand-alone visits do not create programs."); },
    executeTransaction: async (): Promise<Bundle> => {
      transactionCount += 1;
      calls.push(transactionCount === 1 ? "create-encounter" : "start-encounter");
      return transactionCount === 1
        ? {
            resourceType: "Bundle",
            type: "transaction-response",
            entry: [
              { response: { status: "201 Created", location: "Encounter/encounter-new/_history/1" } },
              { response: { status: "201 Created" } },
            ],
          }
        : {
            resourceType: "Bundle",
            type: "transaction-response",
            entry: [
              { response: { status: "200 OK" } },
              { response: { status: "201 Created" } },
            ],
          };
    },
    now: () => new Date("2026-08-02T12:00:00.000Z"),
  };
  useViewState.setState({ view: { kind: "overview", patientId: "patient-1" } });

  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<StartExam patient={patient} api={api} />);
  });
  const startButton = renderer.root.findAllByType("button").find((button) =>
    button.children.join("") === "Start today's visit →"
  );
  assert.ok(startButton);

  await act(async () => {
    startButton.props.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  assert.deepEqual(calls, ["assign-provider", "create-encounter", "start-encounter"]);
  assert.deepEqual(useViewState.getState().view, {
    kind: "encounter",
    patientId: "patient-1",
    encounterId: "encounter-new",
  });
  renderer.unmount();
});

test("retrying a failed status transition reuses the created encounter", async () => {
  let providerAssignments = 0;
  let encounterCreates = 0;
  let statusAttempts = 0;
  const api: StartExamApi = {
    loadPrograms: async () => [],
    assignProvider: async () => { providerAssignments += 1; },
    createProgram: async () => { throw new Error("not reached"); },
    executeTransaction: async (bundle): Promise<Bundle> => {
      if (bundle.entry?.[0]?.request?.method === "POST") {
        encounterCreates += 1;
        return {
          resourceType: "Bundle",
          type: "transaction-response",
          entry: [
            { response: { status: "201 Created", location: "Encounter/encounter-retry/_history/1" } },
            { response: { status: "201 Created" } },
          ],
        };
      }
      statusAttempts += 1;
      return {
        resourceType: "Bundle",
        type: "transaction-response",
        entry: [
          { response: { status: statusAttempts === 1 ? "500 Failed" : "200 OK" } },
          { response: { status: "201 Created" } },
        ],
      };
    },
    now: () => new Date("2026-08-02T12:00:00.000Z"),
  };
  useViewState.setState({ view: { kind: "overview", patientId: "patient-1" } });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<StartExam patient={patient} api={api} />);
  });

  await act(async () => {
    renderer.root.findAllByType("button").find((button) => button.children.join("") === "Start today's visit →")!.props.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.match(renderer.root.findByProps({ role: "alert" }).children.join(""), /500 Failed/);
  assert.equal(renderer.root.findAllByType("button").filter((button) => button.props["aria-pressed"] !== undefined).every((button) => button.props.disabled), true);

  await act(async () => {
    renderer.root.findAllByType("button").find((button) => button.children.join("") === "Retry starting today's visit →")!.props.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  assert.equal(providerAssignments, 1);
  assert.equal(encounterCreates, 1);
  assert.equal(statusAttempts, 2);
  assert.deepEqual(useViewState.getState().view, {
    kind: "encounter",
    patientId: "patient-1",
    encounterId: "encounter-retry",
  });
  renderer.unmount();
});

test("retrying encounter creation reuses a newly created Program", async () => {
  let providerAssignments = 0;
  let programCreates = 0;
  let transactionAttempts = 0;
  const encounterProgramReferences: Array<string | undefined> = [];
  const api: StartExamApi = {
    loadPrograms: async () => [],
    assignProvider: async () => { providerAssignments += 1; },
    createProgram: async () => {
      programCreates += 1;
      return {
        resourceType: "EpisodeOfCare",
        id: "program-new",
        status: "active",
        patient: { reference: "Patient/patient-1" },
      };
    },
    executeTransaction: async (bundle): Promise<Bundle> => {
      transactionAttempts += 1;
      if (bundle.entry?.[0]?.request?.method === "POST") {
        encounterProgramReferences.push((bundle.entry[0].resource as Encounter).episodeOfCare?.[0]?.reference);
        if (transactionAttempts === 1) throw new Error("Encounter create unavailable");
        return {
          resourceType: "Bundle",
          type: "transaction-response",
          entry: [
            { response: { status: "201 Created", location: "Encounter/encounter-program/_history/1" } },
            { response: { status: "201 Created" } },
          ],
        };
      }
      return {
        resourceType: "Bundle",
        type: "transaction-response",
        entry: [
          { response: { status: "200 OK" } },
          { response: { status: "201 Created" } },
        ],
      };
    },
    now: () => new Date("2026-08-02T12:00:00.000Z"),
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<StartExam patient={patient} api={api} />);
  });
  act(() => renderer.root.findAllByType("button").find((button) => button.children.join("") === "Start a new program")!.props.onClick());

  await act(async () => {
    renderer.root.findAllByType("button").find((button) => button.children.join("") === "Start today's visit →")!.props.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(renderer.root.findByProps({ role: "alert" }).children.join(""), "Encounter create unavailable");
  assert.equal(renderer.root.findAllByType("button").filter((button) => button.props["aria-pressed"] !== undefined).every((button) => button.props.disabled), true);
  assert.equal(renderer.root.findByProps({ "aria-label": "New program type" }).props.disabled, true);

  await act(async () => {
    renderer.root.findAllByType("button").find((button) => button.children.join("") === "Start today's visit →")!.props.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  assert.equal(providerAssignments, 2);
  assert.equal(programCreates, 1);
  assert.equal(transactionAttempts, 3);
  assert.deepEqual(encounterProgramReferences, ["EpisodeOfCare/program-new", "EpisodeOfCare/program-new"]);
  renderer.unmount();
});

test("start options lock while provider assignment is pending", async () => {
  let releaseProvider!: () => void;
  const providerPending = new Promise<void>((resolve) => { releaseProvider = resolve; });
  const api: StartExamApi = {
    loadPrograms: async () => [],
    assignProvider: async () => providerPending,
    createProgram: async () => { throw new Error("not reached"); },
    executeTransaction: async (bundle): Promise<Bundle> => bundle.entry?.[0]?.request?.method === "POST"
      ? {
          resourceType: "Bundle",
          type: "transaction-response",
          entry: [
            { response: { status: "201 Created", location: "Encounter/encounter-pending/_history/1" } },
            { response: { status: "201 Created" } },
          ],
        }
      : {
          resourceType: "Bundle",
          type: "transaction-response",
          entry: [
            { response: { status: "200 OK" } },
            { response: { status: "201 Created" } },
          ],
        },
    now: () => new Date("2026-08-02T12:00:00.000Z"),
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<StartExam patient={patient} api={api} />);
  });
  act(() => renderer.root.findAllByType("button").find((button) => button.children.join("") === "Start today's visit →")!.props.onClick());
  assert.equal(renderer.root.findAllByType("button").filter((button) => button.props["aria-pressed"] !== undefined).every((button) => button.props.disabled), true);

  await act(async () => {
    releaseProvider();
    await providerPending;
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  renderer.unmount();
});

test("a patient without an id never renders as an encounter retry", async () => {
  const api: StartExamApi = {
    loadPrograms: async () => [],
    assignProvider: async () => undefined,
    createProgram: async () => { throw new Error("not reached"); },
    executeTransaction: async () => { throw new Error("not reached"); },
    now: () => new Date("2026-08-02T12:00:00.000Z"),
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<StartExam patient={{ resourceType: "Patient" }} api={api} />);
  });
  assert.ok(renderer.root.findAllByType("button").find((button) => button.children.join("") === "Start today's visit →"));
  assert.equal(renderer.root.findAllByType("button").filter((button) => button.props["aria-pressed"] !== undefined).every((button) => !button.props.disabled), true);
  renderer.unmount();
});

test("start-exam failures remain visible on the patient overview", async () => {
  const api: StartExamApi = {
    loadPrograms: async () => [],
    assignProvider: async () => { throw new Error("Provider assignment unavailable"); },
    createProgram: async () => { throw new Error("not reached"); },
    executeTransaction: async () => { throw new Error("not reached"); },
    now: () => new Date("2026-08-02T12:00:00.000Z"),
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<StartExam patient={patient} api={api} />);
  });

  await act(async () => {
    renderer.root.findAllByType("button").find((button) =>
      button.children.join("") === "Start today's visit →"
    )!.props.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  assert.equal(renderer.root.findByProps({ role: "alert" }).children.join(""), "Provider assignment unavailable");
  renderer.unmount();
});

test("start-exam mode choices expose existing and new Program selectors", async () => {
  let programLoads = 0;
  const api: StartExamApi = {
    loadPrograms: async () => {
      programLoads += 1;
      return [{
        resourceType: "EpisodeOfCare",
        id: "program-1",
        status: "active",
        patient: { reference: "Patient/patient-1" },
        type: [{ text: "Glaucoma" }],
      }];
    },
    assignProvider: async () => undefined,
    createProgram: async () => { throw new Error("not reached"); },
    executeTransaction: async () => { throw new Error("not reached"); },
    now: () => new Date("2026-08-02T12:00:00.000Z"),
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<StartExam patient={patient} api={api} />);
  });
  assert.equal(programLoads, 0);

  await act(async () => {
    renderer.root.findAllByType("button").find((button) =>
      button.children.join("") === "Part of an existing program"
    )!.props.onClick();
    await Promise.resolve();
  });
  assert.equal(programLoads, 1);
  assert.equal(renderer.root.findByProps({ "aria-label": "Existing program" }).children.join(""), "Glaucoma · active");

  act(() => renderer.root.findAllByType("button").find((button) =>
    button.children.join("") === "Start a new program"
  )!.props.onClick());
  assert.ok(renderer.root.findByProps({ "aria-label": "New program type" }));
  renderer.unmount();
});

test("existing-program mode cannot submit without an active Program", async () => {
  const api: StartExamApi = {
    loadPrograms: async () => [],
    assignProvider: async () => undefined,
    createProgram: async () => { throw new Error("not reached"); },
    executeTransaction: async () => { throw new Error("not reached"); },
    now: () => new Date("2026-08-02T12:00:00.000Z"),
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<StartExam patient={patient} api={api} />);
  });
  await act(async () => {
    renderer.root.findAllByType("button").find((button) => button.children.join("") === "Part of an existing program")!.props.onClick();
    await Promise.resolve();
  });
  assert.equal(renderer.root.findAllByType("button").find((button) => button.children.join("") === "Start today's visit →")!.props.disabled, true);
  renderer.unmount();
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

test("an overview consult panel stays absent when there is no referral content", async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <ConsultReportDraftPanel
        patientId="patient-1"
        onClose={() => undefined}
        hideWhenEmpty
        api={{
          listInboundReferrals: async () => [],
          previewConsultReport: async () => { throw new Error("No referral should be previewed."); },
        }}
      />,
    );
    await Promise.resolve();
  });
  assert.equal(renderer.toJSON(), null);
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
  assert.equal(row.props.role, undefined);
  assert.equal(row.props.tabIndex, undefined);
  assert.equal(row.props["aria-expanded"], undefined);
  const disclosure = row.findByProps({ className: "odos-visit-expand-sr" });
  assert.equal(row.children[0], disclosure);
  assert.equal(disclosure.type, "button");
  assert.equal(disclosure.props["aria-expanded"], false);
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

test("the hidden disclosure button stops row propagation and toggles Level 1", async () => {
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
  assert.equal(row.props.role, undefined);
  assert.equal(row.props.tabIndex, undefined);
  assert.equal(row.props["aria-expanded"], undefined);
  let disclosure = row.findByProps({ className: "odos-visit-expand-sr" });
  assert.equal(row.children[0], disclosure);
  assert.equal(disclosure.type, "button");
  assert.equal(disclosure.props.type, "button");
  // Native button keyboard activation is delegated to the platform.
  assert.equal(disclosure.props.onKeyDown, undefined);
  assert.equal(disclosure.props["aria-expanded"], false);
  assert.equal(disclosure.props["aria-controls"], "visit-explode-newer");

  let stopped = false;
  await act(async () => disclosure.props.onClick({ stopPropagation: () => { stopped = true; } }));
  assert.equal(stopped, true);
  const explode = renderer.root.findByProps({ className: "odos-visit-explode" });
  assert.equal(explode.props.id, "visit-explode-newer");
  let currentRow = renderer.root.findAll((node) => node.type === "article" && String(node.props.className).includes("odos-visit-row"))[0]!;
  assert.equal(currentRow.props.role, undefined);
  assert.equal(currentRow.props.tabIndex, undefined);
  disclosure = currentRow.findByProps({ className: "odos-visit-expand-sr" });
  assert.equal(disclosure.props["aria-expanded"], true);

  stopped = false;
  await act(async () => disclosure.props.onClick({ stopPropagation: () => { stopped = true; } }));
  assert.equal(stopped, true);
  assert.equal(renderer.root.findAllByProps({ className: "odos-visit-explode" }).length, 0);
  currentRow = renderer.root.findAll((node) => node.type === "article" && String(node.props.className).includes("odos-visit-row"))[0]!;
  assert.equal(currentRow.props.role, undefined);
  assert.equal(currentRow.props.tabIndex, undefined);
  disclosure = currentRow.findByProps({ className: "odos-visit-expand-sr" });
  assert.equal(disclosure.props["aria-expanded"], false);
  assert.deepEqual(calls, ["newer"]);
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
  const summaryValues = renderer.root.findAllByProps({ className: "odos-visit-summary-value" });
  assert.equal(summaryValues.length, 6);
  assert.deepEqual(summaryValues.map((value) => value.children.join("")), Array(6).fill("not recorded"));
  assert.doesNotMatch(rendered, /placeholder|sample|synthetic/i);
});

test("zero-data doctor overview renders quiet Tier 1 states and no empty Tier 2 panels", async () => {
  const empty = fixture();
  empty.insurance = [];
  empty.stickyNote = undefined;
  empty.snapshot = {
    ocularHistory: [], ocularSurgicalHistory: [], medicalConditions: [], socialHistory: [], ophthalmicMedications: [], systemicMedications: [],
  };
  empty.visits = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ definitions: [], images: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <RoleProvider initialRole="doctor">
          <PatientOverview
            patient={patient}
            initialOverview={empty}
            api={{
              fetchOverview: async () => empty,
              fetchHistory: async () => [],
              saveNote: async () => { throw new Error("The empty-state test does not save notes."); },
              seriesTracker: {
                fetchSeries: async () => [],
                fetchProtocols: async () => [],
                prescribe: async () => { throw new Error("The empty-state test does not prescribe programs."); },
              },
            }}
          />
        </RoleProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    const html = JSON.stringify(renderer.toJSON());
    assert.doesNotMatch(html, /None recorded/);
    assert.match(html, /No active problems/);
    assert.match(html, /No active programs/);
    assert.match(html, /No visits yet/);
    assert.doesNotMatch(html, /overview-medications|longitudinal-imaging-card|Start optical order/);
    assert.match(html, /No sticky note recorded/);
    assert.match(html, /Insurance not recorded/);
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("a sparse visit collapses absent metadata to one marker", () => {
  const sparse = fixture();
  sparse.visits = [{
    encounterId: "sparse",
    date: "2026-08-01T12:00:00Z",
    visitType: "Visit type not recorded",
    status: "Preliminary",
    diagnoses: [],
  }];
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<PatientOverview patient={patient} initialOverview={sparse} />);
  });
  const head = renderer.root.findByProps({ className: "odos-visit-head" });
  assert.deepEqual(head.children[0].children, ["—"]);
  assert.equal(head.findAllByProps({ className: "odos-visit-type" }).length, 0);
  const rendered = JSON.stringify(renderer.toJSON());
  assert.doesNotMatch(rendered, /Visit type not recorded|Provider not recorded|Facility not recorded/);
  renderer.unmount();
});

test("a sparse visit preserves the metadata that is present", () => {
  const sparse = fixture();
  sparse.visits = [{
    encounterId: "partial",
    date: "2026-08-01T12:00:00Z",
    provider: "Dr. Present",
    visitType: "Visit type not recorded",
    status: "Final",
    diagnoses: [],
  }];
  const html = renderToStaticMarkup(<PatientOverview patient={patient} initialOverview={sparse} />);
  assert.match(html, /Dr\. Present/);
  assert.doesNotMatch(html, /Visit type not recorded|Provider not recorded|Facility not recorded/);
});

test("an empty filtered ledger does not claim the patient has no visits yet", async () => {
  const filtered = fixture();
  filtered.visits = [];
  const api = {
    fetchOverview: async () => filtered,
    fetchHistory: async () => [],
    saveNote: async () => filtered.stickyNote!,
  };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<PatientOverview patient={patient} initialOverview={fixture()} api={api} />);
  });
  const eyeExams = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Eye exams");
  assert.ok(eyeExams);
  await act(async () => eyeExams.props.onClick());
  const rendered = JSON.stringify(renderer.toJSON());
  assert.match(rendered, /No matching visits recorded/);
  assert.doesNotMatch(rendered, /No visits yet/);
  renderer.unmount();
});

test("the Conditions list caps pathological data at eight rows and expands to the real count", () => {
  const crowded = fixture();
  crowded.snapshot.medicalConditions = Array.from({ length: 31 }, (_, index) => ({
    id: `condition-${index + 1}`,
    name: `Condition ${index + 1}`,
  }));
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<PatientOverview patient={patient} initialOverview={crowded} />);
  });
  const panel = renderer.root.findByProps({ "data-testid": "overview-problem-list" });
  assert.equal(panel.findAllByType("li").length, 8);
  const showAll = panel.findByProps({ className: "odos-overview-list-toggle" });
  assert.equal(showAll.children.join(""), "Show all 31");
  act(() => showAll.props.onClick());
  assert.equal(panel.findAllByType("li").length, 31);
  assert.equal(panel.findByProps({ className: "odos-overview-list-toggle" }).children.join(""), "Show first 8");
  renderer.unmount();
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

test("visit detail responses reject malformed optional display fields", async () => {
  const detail = detailFixture("newer");
  const malformedDetails = [
    { ...detail, reason: {} },
    { ...detail, iop: { ...detail.iop, summary: {} } },
    { ...detail, iop: { ...detail.iop, unavailable: {} } },
    { ...detail, iop: { ...detail.iop, cards: [{ ...detail.iop.cards[0]!, detail: {} }] } },
  ];
  for (const malformed of malformedDetails) {
    const fetchImpl = async () => new Response(JSON.stringify(malformed), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    await assert.rejects(
      fetchPatientOverviewVisitDetail("patient-1", "newer", fetchImpl as typeof fetch),
      /Patient overview request returned an invalid response/,
    );
  }
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
  assert.equal(renderer.root.findAllByType("a").some((link) => link.children.join("") === "Start optical order"), false);

  await act(async () => {
    renderer.update(<PatientOverview patient={{ ...patient, id: undefined }} initialOverview={fixture()} api={api} />);
    await Promise.resolve();
  });
  assert.equal(renderer.root.findAllByType("a").some((link) => link.children.join("") === "Start optical order"), false);
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
  assert.equal(
    renderer.root.findAllByProps({ role: "alert" })
      .some((alert) => alert.children.join("").includes("stale history failure")),
    false,
  );
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
