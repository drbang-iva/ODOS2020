import assert from "node:assert/strict";
import { test } from "node:test";
import type { Appointment } from "@medplum/fhirtypes";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { AppointmentChartButton } from "../src/components/AppointmentChartButton";
import { AppointmentContextBanner } from "../src/components/charting/EncounterHeader";
import { fhir } from "../src/lib/fhir";
import { canStartAppointmentChart } from "../src/lib/practice-roles";
import {
  ODOS_FOLLOW_UP_EXTENSION_URL,
  ODOS_VISIT_TYPE_SYSTEM,
} from "../src/lib/scheduling";
import { openEncounter, useViewState } from "../src/lib/view-state";
import { FloorCard } from "../src/scenes/frontdesk/FloorCard";

test("checked-in appointment action renders Start chart while other statuses render no action", () => {
  const checkedIn = renderToStaticMarkup(<AppointmentChartButton appointment={appointment()} />);
  const booked = renderToStaticMarkup(
    <AppointmentChartButton appointment={{ ...appointment(), status: "booked" }} />,
  );

  assert.match(checkedIn, />Start chart</);
  assert.equal(booked, "");
});

test("checked-in appointment action relabels to Open chart after finding the linked encounter", async () => {
  const originalSearch = fhir.search;
  fhir.search = (async () => ({
    resourceType: "Bundle",
    type: "searchset",
    entry: [{
      resource: {
        resourceType: "Encounter",
        id: "encounter-1",
        status: "in-progress",
        class: { code: "AMB" },
      },
    }],
  })) as typeof fhir.search;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<AppointmentChartButton appointment={appointment()} />);
      await Promise.resolve();
    });
    assert.equal(renderer.root.findByType("button").children.join(""), "Open chart");
  } finally {
    if (renderer) act(() => renderer.unmount());
    fhir.search = originalSearch;
  }
});

test("appointment action can load the canonical Appointment by id for Clinic worklists", async () => {
  const originalRead = fhir.read;
  const originalSearch = fhir.search;
  let readId = "";
  fhir.read = (async (_resourceType, id) => {
    readId = id;
    return appointment();
  }) as typeof fhir.read;
  fhir.search = (async () => ({
    resourceType: "Bundle",
    type: "searchset",
    entry: [],
  })) as typeof fhir.search;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<AppointmentChartButton appointmentId="appointment-1" />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const button = renderer.root.findByType("button");
    assert.equal(readId, "appointment-1");
    assert.equal(button.props.disabled, false);
    assert.equal(button.children.join(""), "Start chart");
  } finally {
    if (renderer) act(() => renderer.unmount());
    fhir.read = originalRead;
    fhir.search = originalSearch;
  }
});

test("Start chart assigns from the caller-readable Appointment before creating the encounter", async () => {
  const originalFetch = globalThis.fetch;
  const originalSearch = fhir.search;
  const originalExecuteTransaction = fhir.executeTransaction;
  const calls: string[] = [];
  const errors: Array<string | null> = [];
  let transaction = 0;
  globalThis.fetch = (async (input) => {
    calls.push("assign-appointment");
    assert.match(String(input), /\/clinical-graph\/appointments\/appointment-1\/assign-provider$/);
    return new Response(JSON.stringify({ assigned: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  fhir.search = (async () => ({
    resourceType: "Bundle",
    type: "searchset",
    entry: [],
  })) as typeof fhir.search;
  fhir.executeTransaction = (async () => {
    transaction += 1;
    calls.push("transaction");
    return transaction === 1
      ? {
          resourceType: "Bundle",
          type: "transaction-response",
          entry: [
            { response: { status: "201 Created", location: "Encounter/encounter-1/_history/1" } },
            { response: { status: "201 Created", location: "Provenance/provenance-1/_history/1" } },
          ],
        }
      : {
          resourceType: "Bundle",
          type: "transaction-response",
          entry: [
            { response: { status: "200 OK", location: "Encounter/encounter-1/_history/2" } },
            { response: { status: "201 Created", location: "Provenance/provenance-2/_history/1" } },
          ],
        };
  }) as typeof fhir.executeTransaction;

  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <AppointmentChartButton appointment={appointment()} onError={(message) => errors.push(message)} />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      renderer.root.findByType("button").props.onClick();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.deepEqual(calls, ["assign-appointment", "transaction", "transaction"]);
    assert.deepEqual(errors, [null]);
  } finally {
    if (renderer) act(() => renderer.unmount());
    globalThis.fetch = originalFetch;
    fhir.search = originalSearch;
    fhir.executeTransaction = originalExecuteTransaction;
  }
});

test("Start chart does not create an encounter when Appointment assignment fails", async () => {
  const originalFetch = globalThis.fetch;
  const originalSearch = fhir.search;
  const originalExecuteTransaction = fhir.executeTransaction;
  const errors: Array<string | null> = [];
  let transactions = 0;
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ error: "Appointment not found." }),
    { status: 404, headers: { "Content-Type": "application/json" } },
  )) as typeof fetch;
  fhir.search = (async () => ({
    resourceType: "Bundle",
    type: "searchset",
    entry: [],
  })) as typeof fhir.search;
  fhir.executeTransaction = (async () => {
    transactions += 1;
    throw new Error("Encounter transaction must not run after assignment failure.");
  }) as typeof fhir.executeTransaction;

  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <AppointmentChartButton appointment={appointment()} onError={(message) => errors.push(message)} />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      renderer.root.findByType("button").props.onClick();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.equal(transactions, 0);
    assert.deepEqual(errors, [null, "Appointment not found."]);
  } finally {
    if (renderer) act(() => renderer.unmount());
    globalThis.fetch = originalFetch;
    fhir.search = originalSearch;
    fhir.executeTransaction = originalExecuteTransaction;
  }
});

test("floor card has its own checked-in chart action without nesting buttons", () => {
  const html = renderToStaticMarkup(
    <FloorCard
      card={{
        appointment: appointment(),
        content: {
          patientDisplay: "Patient, Test",
          visitTypeDisplay: "Routine exam",
          visitTypeCode: "routine",
          color: "#4a7dff",
          status: "checked-in",
          statusDisplay: "Checked in",
          confirmationDisplay: "Not confirmed",
          insuranceLine: "Vision: none · Medical: none",
          badges: [],
          isNonPatient: false,
        },
        station: "waiting",
        since: "2026-07-24T14:00:00.000Z",
        checkedInAt: "2026-07-24T14:00:00.000Z",
        timer: { minutes: 5, level: "ok" },
        payerCue: undefined,
      }}
      canStartChart
      onClick={() => undefined}
    />,
  );

  assert.match(html, />Start chart</);
  assert.equal((html.match(/<button/g) ?? []).length, 2);
  assert.match(html, /<\/button><div class="mt-1 flex justify-end"><button/);
});

test("chart action reachability excludes front-desk-only sessions after the live Provenance gate", () => {
  assert.equal(canStartAppointmentChart(["staff"]), false);
  assert.equal(canStartAppointmentChart(["provider"]), true);
  assert.equal(canStartAppointmentChart(["admin"]), false);
  assert.equal(canStartAppointmentChart(["staff", "provider"]), true);
  assert.equal(canStartAppointmentChart(["admin", "provider"]), true);
});

test("appointment banner trims the note and shows visit type, urgent, and follow-up", () => {
  const html = renderToStaticMarkup(
    <AppointmentContextBanner
      appointment={{
        ...appointment(),
        comment: "  Dilate before OCT retina recheck.  ",
        priority: 1,
        extension: [{
          url: ODOS_FOLLOW_UP_EXTENSION_URL,
          valueBoolean: true,
        }],
      }}
    />,
  );

  assert.match(html, /Booked visit · Routine exam/);
  assert.match(html, /Dilate before OCT retina recheck\./);
  assert.doesNotMatch(html, />  Dilate/);
  assert.match(html, /Urgent/);
  assert.match(html, /Follow-up/);
});

test("appointment banner omits a whitespace-only note", () => {
  const html = renderToStaticMarkup(
    <AppointmentContextBanner appointment={{ ...appointment(), comment: " \n\t " }} />,
  );

  assert.match(html, /Booked visit · Routine exam/);
  assert.doesNotMatch(html, /whitespace-pre-wrap/);
});

test("openEncounter navigates from desk-side routes into the concrete chart URL and view", () => {
  const originalWindow = globalThis.window;
  const originalView = useViewState.getState().view;
  let pushed = "";
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      history: {
        pushState: (_state: unknown, _unused: string, url?: string | URL | null) => {
          pushed = String(url);
        },
      },
      dispatchEvent: () => true,
    },
  });
  try {
    openEncounter("patient/with spaces", "encounter/with spaces");
    assert.equal(
      pushed,
      "/clinic?patientId=patient%2Fwith%20spaces&encounterId=encounter%2Fwith%20spaces",
    );
    assert.deepEqual(useViewState.getState().view, {
      kind: "encounter",
      patientId: "patient/with spaces",
      encounterId: "encounter/with spaces",
    });
  } finally {
    useViewState.setState({ view: originalView });
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

function appointment(): Appointment {
  return {
    resourceType: "Appointment",
    id: "appointment-1",
    status: "arrived",
    serviceType: [{
      coding: [{
        system: ODOS_VISIT_TYPE_SYSTEM,
        code: "routine",
        display: "Routine exam",
      }],
    }],
    participant: [{ actor: { reference: "Patient/patient-1" } }],
  };
}
