import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";
import {
  buildWorkLanes,
  type BatchTouchInput,
  type BatchTouchResult,
  type ClaimWorklistGroup,
  type ClaimWorklistRow,
  type WorkProjection,
} from "../src/lib/claim-work";
import type { ClaimsWorklistItem } from "../src/lib/claims-worklist";
import { BillingWork, groupKeyAction, nextGroupIndex } from "../src/scenes/claims/BillingWork";
import type { BeforeVisitWorkProjection, WatcherAlert } from "../src/lib/watchers";

test("Work renders one collapsed row for a 15-claim reason batch", () => {
  const projection = healthyWorkFixture();
  const html = renderToStaticMarkup(<BillingWork initialProjection={projection} initialActiveLane="holds" />);

  assert.equal((html.match(/Missing procedure code for item OTH/g) ?? []).length, 1);
  assert.match(html, /15 claims/);
  assert.match(html, /\$1,875\.00/);
  assert.match(html, /oldest 62d/);
  assert.match(html, /Fix codes and resubmit/);
});

test("expanded Work rows show independent billed and touched days plus sourced money state", () => {
  const projection = healthyWorkFixture();
  const html = renderToStaticMarkup(
    <BillingWork
      initialProjection={projection}
      initialActiveLane="holds"
      initialExpandedGroupKey="holds:claim:missing-procedure-code"
    />,
  );

  for (const heading of ["Days billed", "Days touched", "Last worked by", "Money state"]) {
    assert.match(html, new RegExp(heading));
  }
  assert.match(html, />62d</);
  assert.match(html, />2d</);
  assert.match(html, />Never</);
  assert.match(html, /Practitioner\/staff-1/);
  assert.match(html, /charged/);
});

test("accepted claims remain charged until payer adjudication evidence exists", () => {
  const group = missingProcedureGroup();
  const projection: WorkProjection = {
    status: "healthy",
    lastSuccessfulAt: "2026-08-30T12:00:00.000Z",
    lanes: buildWorkLanes([{
      ...group,
      rows: group.rows.map((row) => ({ ...row, status: "accepted" })),
    }], []),
  };
  const html = renderToStaticMarkup(
    <BillingWork
      initialProjection={projection}
      initialActiveLane="holds"
      initialExpandedGroupKey="holds:claim:missing-procedure-code"
    />,
  );

  assert.match(html, /charged/);
  assert.doesNotMatch(html, /adjudicated/);
});

test("all eight lane labels remain visible while healthy counts and a truthful zero state render", () => {
  const html = renderToStaticMarkup(
    <BillingWork initialProjection={healthyWorkFixture()} initialActiveLane="hygiene" />,
  );

  for (const label of ["Before the visit", "Aging", "Holds", "Denials", "Underpaid", "Unmatched", "Untouched", "Hygiene"]) {
    assert.match(html, new RegExp(`>${label}<`));
  }
  assert.match(html, /data-lane-count="hygiene"[^>]*>0</);
  assert.match(html, /No hygiene work/);
  assert.match(html, /Projection current as of/);
});

test("Before the visit renders reason-grouped preventive Tasks and their patient actions", () => {
  const before: BeforeVisitWorkProjection = {
    status: "healthy",
    lastSuccessfulAt: "2026-08-30T23:10:00.000Z",
    count: 2,
    groups: [
      {
        key: "W21:eligibility-inactive",
        watcherId: "W21",
        reasonCode: "eligibility-inactive",
        title: "INACTIVE coverage result",
        count: 2,
        items: [beforeVisitAlert("task-21", "Patient One"), beforeVisitAlert("task-22", "Patient Two")],
      },
    ],
  };
  const html = renderToStaticMarkup(
    <BillingWork initialProjection={healthyWorkFixture()} initialBeforeVisitProjection={before} initialActiveLane="before-visit" />,
  );
  assert.match(html, /Before the visit/);
  assert.match(html, /INACTIVE coverage result/);
  assert.match(html, /2 patients/);
  assert.match(html, /Patient One/);
  assert.match(html, /Open patient/);
  assert.match(html, /Already sorted/);
  assert.match(html, /data-lane-count="before-visit"[^>]*>2</);
});

test("failed or unrun eligibility sweep renders degraded Before the visit with no clean zero", () => {
  const before: BeforeVisitWorkProjection = { status: "degraded", reason: "never-run" };
  const html = renderToStaticMarkup(
    <BillingWork initialProjection={healthyWorkFixture()} initialBeforeVisitProjection={before} initialActiveLane="before-visit" />,
  );
  assert.match(html, /Eligibility sweep not current/);
  assert.doesNotMatch(html, /No before the visit work/i);
  assert.doesNotMatch(html, /data-lane-count="before-visit"/);
});

test("degraded Work keeps navigation but hides every count, group, and reassuring zero state", () => {
  const projection: WorkProjection = {
    status: "degraded",
    reason: "stale",
    lastSuccessfulAt: "2026-08-30T11:30:00.000Z",
  };
  const html = renderToStaticMarkup(<BillingWork initialProjection={projection} />);

  assert.match(html, /Work data hidden/);
  assert.match(html, />Aging</);
  assert.doesNotMatch(html, /data-lane-count=/);
  assert.doesNotMatch(html, /Missing procedure code/);
  assert.doesNotMatch(html, /No aging work/);
});

test("legacy remits are visibly separated from live Unmatched work and name watcher silence", () => {
  const projection: WorkProjection = {
    status: "healthy",
    lastSuccessfulAt: "2026-08-30T12:00:00.000Z",
    lanes: buildWorkLanes([], [legacyRemit()]),
  };
  const html = renderToStaticMarkup(
    <BillingWork initialProjection={projection} initialActiveLane="unmatched" />,
  );

  assert.match(html, /Legacy — belongs to the prior system/);
  assert.match(html, /outside ODOS claim work and claim-watch alerts/);
  assert.match(html, /ERA-LEGACY-1/);
  assert.doesNotMatch(html, /Reconstruct claim/);
});

test("one action drawer submits all 15 claims and collapses only after a complete report", async () => {
  const projection = healthyWorkFixture();
  const calls: BatchTouchInput[] = [];
  let reloads = 0;
  const applyBatch = async (input: BatchTouchInput): Promise<BatchTouchResult> => {
    calls.push(input);
    return completeBatch(input.claimReferences);
  };
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <BillingWork
        initialProjection={projection}
        initialActiveLane="holds"
        loadProjection={async () => { reloads += 1; return projection; }}
        applyBatch={applyBatch}
        newIdempotencyKey={() => "work-drawer-stable-001"}
      />,
    );
  });

  await act(async () => primaryAction(renderer).props.onClick());
  const dialog = renderer.root.findByProps({ "aria-label": "Complete claim batch" });
  assert.equal(dialog.findByType("textarea").props.value, "Fix codes and resubmit");
  await act(async () => dialog.findByType("form").props.onSubmit({ preventDefault() {} }));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].claimReferences.length, 15);
  assert.equal(calls[0].action, "resolution");
  assert.equal(calls[0].reasonCode, "missing-procedure-code");
  assert.equal(calls[0].idempotencyKey, "work-drawer-stable-001");
  assert.equal(reloads, 1);
  assert.equal(renderer.root.findAllByProps({ "aria-label": "Complete claim batch" }).length, 0);
  assert.equal(renderer.root.findAllByType("table").length, 0);
  await act(async () => renderer.unmount());
});

test("an incomplete batch report stays open, names the missing count, and retries one key", async () => {
  const projection = healthyWorkFixture();
  const calls: BatchTouchInput[] = [];
  const applyBatch = async (input: BatchTouchInput): Promise<BatchTouchResult> => {
    calls.push(input);
    if (calls.length === 1) throw new Error("Batch touch incomplete: 14 of 15 claims were stamped.");
    return completeBatch(input.claimReferences);
  };
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <BillingWork
        initialProjection={projection}
        initialActiveLane="holds"
        loadProjection={async () => projection}
        applyBatch={applyBatch}
        newIdempotencyKey={() => "work-drawer-retry-001"}
      />,
    );
  });
  await act(async () => primaryAction(renderer).props.onClick());
  let dialog = renderer.root.findByProps({ "aria-label": "Complete claim batch" });
  await act(async () => dialog.findByType("form").props.onSubmit({ preventDefault() {} }));

  dialog = renderer.root.findByProps({ "aria-label": "Complete claim batch" });
  assert.match(dialog.findByProps({ role: "alert" }).children.join(""), /14 of 15/);
  await act(async () => dialog.findByType("form").props.onSubmit({ preventDefault() {} }));
  assert.deepEqual(calls.map((call) => call.idempotencyKey), ["work-drawer-retry-001", "work-drawer-retry-001"]);
  await act(async () => renderer.unmount());
});

test("Work keyboard mapping keeps arrows primary with j and k aliases", () => {
  for (const key of ["ArrowDown", "j"]) assert.equal(nextGroupIndex(0, key, 3), 1);
  for (const key of ["ArrowUp", "k"]) assert.equal(nextGroupIndex(1, key, 3), 0);
  assert.equal(nextGroupIndex(0, "ArrowUp", 3), 2);
  assert.equal(nextGroupIndex(2, "ArrowDown", 3), 0);
  assert.equal(groupKeyAction(" "), "toggle");
  assert.equal(groupKeyAction("Enter"), "open-action");
  assert.equal(groupKeyAction("x"), "none");
});

test("Space expands a focused reason group and Enter opens its batch action", async () => {
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <BillingWork initialProjection={healthyWorkFixture()} initialActiveLane="holds" />,
    );
  });
  const groupButton = renderer.root.findAllByType("button").find((button) => button.props["aria-expanded"] === false)!;
  let prevented = 0;
  await act(async () => groupButton.props.onKeyDown({ key: " ", preventDefault: () => { prevented += 1; } }));
  assert.equal(renderer.root.findAllByType("table").length, 1);
  await act(async () => groupButton.props.onKeyDown({ key: "Enter", preventDefault: () => { prevented += 1; } }));
  assert.equal(renderer.root.findAllByProps({ "aria-label": "Complete claim batch" }).length, 1);
  assert.equal(prevented, 2);
  await act(async () => renderer.unmount());
});

test("Enter cannot bypass a disabled batch action for an untyped reason", async () => {
  const untyped = missingProcedureGroup();
  const projection: WorkProjection = {
    status: "healthy",
    lastSuccessfulAt: "2026-08-30T12:00:00.000Z",
    lanes: buildWorkLanes([{
      ...untyped,
      reason: { code: null, display: "No typed reason", resolutionPath: null },
      rows: untyped.rows.map((row) => ({
        ...row,
        reasonCode: null,
        reasonDisplay: null,
        resolutionPath: null,
      })),
    }], []),
  };
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<BillingWork initialProjection={projection} initialActiveLane="aging" />);
  });

  const groupButton = renderer.root.findAllByType("button").find((button) => button.props["aria-expanded"] === false)!;
  await act(async () => groupButton.props.onKeyDown({ key: "Enter", preventDefault() {} }));

  assert.equal(renderer.root.findAllByProps({ "aria-label": "Complete claim batch" }).length, 0);
  await act(async () => renderer.unmount());
});

export function healthyWorkFixture(): Extract<WorkProjection, { status: "healthy" }> {
  return {
    status: "healthy",
    lastSuccessfulAt: "2026-08-30T12:00:00.000Z",
    lanes: buildWorkLanes([missingProcedureGroup()], []),
  };
}

function missingProcedureGroup(): ClaimWorklistGroup {
  const rows = Array.from({ length: 15 }, (_, index) => claimRow(index + 1));
  return {
    reason: {
      code: "missing-procedure-code",
      display: "Missing procedure code for item OTH",
      resolutionPath: "Fix codes and resubmit",
    },
    count: rows.length,
    totalOutstandingCents: rows.reduce((sum, row) => sum + row.outstandingCents, 0),
    rows,
  };
}

function claimRow(number: number): ClaimWorklistRow {
  const touched = number === 1;
  return {
    claimReference: `Claim/claim-${number}`,
    claimNumber: `ODOS-${number}`,
    patientReference: `Patient/patient-${number}`,
    patient: `Synthetic Patient ${number}`,
    providerReference: "Practitioner/provider-1",
    provider: "Synthetic Provider",
    cptCodes: ["PROC-A"],
    totalChargedCents: 12_500,
    collectedCents: 0,
    patientResponsibilityCents: 0,
    status: "submitted",
    payerReference: "Organization/payer-1",
    payer: "Synthetic Payer",
    billedAt: "2026-06-29T12:00:00.000Z",
    open: true,
    touchCount: touched ? 1 : 0,
    lastTouchedAt: touched ? "2026-08-28T12:00:00.000Z" : null,
    lastTouchedBy: touched ? "Practitioner/staff-1" : null,
    reasonCode: "missing-procedure-code",
    reasonDisplay: "Missing procedure code for item OTH",
    resolutionPath: "Fix codes and resubmit",
    daysSinceBilled: 62,
    agingBucket: "60-89",
    daysSinceTouched: touched ? 2 : null,
    untouchedRankingDays: touched ? 0 : 62,
    outstandingCents: 12_500,
  };
}

function legacyRemit(): ClaimsWorklistItem {
  return {
    id: "legacy-remit-1",
    taskReference: "Task/legacy-remit-1",
    title: "Unmatched ERA claim requires mapping",
    code: "era-unmatched",
    severity: "high",
    ageTimer: { startedAt: "2026-08-29T12:00:00.000Z", elapsedMinutes: 1_440 },
    action: "none",
    status: "resolved",
    resolutionDisposition: "legacy",
    evidence: {
      kind: "era",
      pcn: "LEGACY-PCN-1",
      eraId: "ERA-LEGACY-1",
      chargedCents: 12_500,
      allowedCents: 8_000,
      paidCents: 8_000,
      patientResponsibilityCents: 0,
      shortfallCents: 0,
      adjustments: [],
    },
  };
}

function beforeVisitAlert(taskId: string, patientDisplay: string): WatcherAlert {
  return {
    taskId,
    watcherId: "W21",
    severity: "today",
    patientReference: `Patient/${taskId}`,
    patientDisplay,
    appointmentReference: `Appointment/${taskId}`,
    appointmentId: taskId,
    appointmentAt: "2026-08-31T14:15:00.000Z",
    message: `${patientDisplay} has inactive coverage.`,
    frontDeskMessage: `${patientDisplay} comes in tomorrow and coverage is inactive.`,
    consequence: "Resolve coverage before the visit.",
    primaryAction: { label: "Open patient", href: `/insurance?patientId=${taskId}` },
    dismissalReasons: [{ code: "already-sorted", display: "Already sorted" }],
    balanceCents: 0,
    ageDays: 0,
    reasonCode: "eligibility-inactive",
  };
}

function primaryAction(renderer: ReturnType<typeof create>) {
  return renderer.root.findAllByType("button").find((button) => button.children.join("") === "Fix codes and resubmit")!;
}

function completeBatch(claimReferences: string[]): BatchTouchResult {
  return {
    requested: claimReferences.length,
    touched: claimReferences.length,
    readModelSynced: true,
    items: claimReferences.map((claimReference) => ({
      claimReference,
      touchCount: 1,
      lastTouchedAt: "2026-08-30T12:00:00.000Z",
      lastTouchedBy: "Practitioner/staff-1",
      idempotentReplay: false,
    })),
  };
}
