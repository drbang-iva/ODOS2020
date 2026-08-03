import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { PatientProgramPanels } from "../src/components/series-tracker/PatientProgramPanels";
import { SeriesTimeline, SeriesTrackerPanel } from "../src/components/series-tracker/SeriesTrackerPanel";
import { SeriesSignOffNotice } from "../src/components/charting/EncounterHeader";
import {
  formatSeriesDueWindow,
  signOffSeriesProcedures,
  type SeriesSignOffPrompt,
  type SeriesTrackerView,
} from "../src/lib/series-tracker";

const dueWindow = { start: "2026-07-28", end: "2026-08-04", minWeeks: 3, maxWeeks: 4 };

const series: SeriesTrackerView = {
  carePlanReference: "CarePlan/cp-1",
  title: "Dry-Eye IPL",
  status: "active",
  maintenanceAfter: false,
  eligibleProcedureTypeCodes: ["IPL"],
  sessions: [
    { number: 1, status: "completed", actualDate: "2026-07-07T16:00:00.000Z", procedureReference: "Procedure/p-1" },
    { number: 2, status: "next", dueWindow },
    { number: 3, status: "future" },
    { number: 4, status: "future" },
  ],
};

test("series timeline renders the due window as a range rather than a manufactured date", () => {
  const html = renderToStaticMarkup(<SeriesTimeline series={series} />);
  assert.match(html, /Due Jul 28–Aug 4 \(wk 3–4\)/);
  assert.match(html, /Completed Jul 7, 2026/);
  assert.equal(formatSeriesDueWindow(dueWindow), "Due Jul 28–Aug 4 (wk 3–4)");
});

test("package status and series status are independent sibling modules", () => {
  const carePlanOnly = renderToStaticMarkup(
    <PatientProgramPanels seriesStatus={<SeriesTimeline series={series} />} />,
  );
  const packageOnly = renderToStaticMarkup(
    <PatientProgramPanels packageStatus={<div>IPL package · 3 sessions remaining</div>} />,
  );
  assert.match(carePlanOnly, /Dry-Eye IPL/);
  assert.doesNotMatch(carePlanOnly, /sessions remaining/);
  assert.match(packageOnly, /3 sessions remaining/);
  assert.doesNotMatch(packageOnly, /Series tracker|Dry-Eye IPL/);
});

test("an unavailable series tracker does not also claim there are no active programs", async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <SeriesTrackerPanel
        patientReference="Patient/patient-1"
        initialProtocols={[]}
        emptyMessage="No active programs"
        api={{
          fetchSeries: async () => { throw new Error("Program fetch failed"); },
          fetchProtocols: async () => [],
          prescribe: async () => { throw new Error("The unavailable-state test does not prescribe programs."); },
        }}
      />,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  const rendered = JSON.stringify(renderer.toJSON());
  const error = renderer.root.findAllByType("p").find((paragraph) => paragraph.children.join("").startsWith("Series tracker unavailable:"));
  assert.equal(error?.children.join(""), "Series tracker unavailable: Program fetch failed");
  assert.doesNotMatch(rendered, /No active programs/);
  renderer.unmount();
});

test("encounter sign-off uses the single series tracker hook and shows an unprefilled scheduler handoff", async () => {
  let requested = "";
  const prompt: SeriesSignOffPrompt = {
    carePlanReference: "CarePlan/cp-1",
    patientReference: "Patient/patient-1",
    protocolTitle: "Dry-Eye IPL",
    nextSessionNumber: 2,
    totalSessions: 4,
    dueWindow,
    procedureTypeCode: "IPL",
  };
  const result = await signOffSeriesProcedures("encounter-1", {
    fetchImpl: async (input) => {
      requested = String(input);
      return new Response(JSON.stringify({ updatedProcedureCount: 1, prompt }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  assert.match(requested, /\/series-tracker\/encounters\/encounter-1\/sign-off$/);
  assert.equal(result.updatedProcedureCount, 1);

  const html = renderToStaticMarkup(<SeriesSignOffNotice prompt={prompt} onClose={() => undefined} />);
  assert.match(html, /Session 2 of 4 is due in ~3–4 weeks/);
  assert.match(html, /href="\/scheduler\/day"/);
  assert.doesNotMatch(html, /patientId=|dueStart=|dueEnd=/);
});
