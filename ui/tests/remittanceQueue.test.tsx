import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ClaimsWorklistItem, EraBatchItem, EraBatchLane } from "../src/lib/claims-worklist";
import { RemittanceQueueBoard, RemittanceQueuePanel } from "../src/scenes/claims/RemittanceQueue";

test("remittance queue exposes all three lanes and renders each lane's fixture batch", () => {
  const batches = [batch("new", "ERA-NEW"), batch("imported", "ERA-OPEN"), batch("fully-worked", "ERA-DONE")];
  for (const [lane, expected] of [
    ["new", "ERA-NEW"],
    ["imported", "ERA-OPEN"],
    ["fully-worked", "ERA-DONE"],
  ] as const) {
    const html = renderToStaticMarkup(
      <RemittanceQueueBoard
        batches={batches}
        activeLane={lane}
        onLaneChange={() => undefined}
        onSelect={() => undefined}
      />,
    );
    for (const label of ["New", "Imported", "Fully worked"]) assert.match(html, new RegExp(label));
    assert.match(html, new RegExp(expected));
  }
});

test("batch drill-in reuses the worklist board with only Tasks from the selected ERA", () => {
  const selected = batch("imported", "ERA-OPEN");
  const html = renderToStaticMarkup(
    <RemittanceQueuePanel
      batch={selected}
      worklistItems={[
        worklistItem("task-selected", "ERA-OPEN"),
        worklistItem("task-other", "ERA-OTHER"),
      ]}
      onClose={() => undefined}
    />,
  );

  assert.match(html, /Fixture task-selected/);
  assert.doesNotMatch(html, /Fixture task-other/);
  assert.match(html, /ERA denials/);
});

function batch(lane: EraBatchLane, eraId: string): EraBatchItem {
  return {
    eraId,
    lane,
    ...(lane === "new" ? {} : { importedAt: "2026-07-09T12:00:00.000Z" }),
    posted: lane === "new" ? 0 : 1,
    denied: 0,
    underpaid: 0,
    flagged: 0,
    payerName: "SYNTHETIC PAYER",
    paidDate: "2026-07-09",
    paidTotalCents: 8_000,
    ...(lane === "new" ? {} : { claimCount: 1 }),
    openTaskCount: lane === "imported" ? 1 : 0,
  };
}

function worklistItem(id: string, eraId: string): ClaimsWorklistItem {
  return {
    id,
    taskReference: `Task/${id}`,
    title: `Fixture ${id}`,
    code: "era-denial",
    patientReference: "Patient/pat-1",
    severity: "high",
    ageTimer: { startedAt: "2026-07-09T12:00:00.000Z", elapsedMinutes: 30 },
    action: "claim",
    status: "new",
    evidence: {
      kind: "era",
      pcn: "PCN-1",
      eraId,
      chargedCents: 10_000,
      allowedCents: 8_000,
      paidCents: 0,
      patientResponsibilityCents: 0,
      shortfallCents: 8_000,
      adjustments: [],
    },
  };
}
