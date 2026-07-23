import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  claimWorklistItem,
  dispositionsForLane,
  fetchClaimsWorklist,
  groupWorklistItems,
  type ClaimsWorklistItem,
  type WorklistCode,
} from "../src/lib/claims-worklist";
import { ClaimsWorklistBoard, ClaimsWorklistPanel } from "../src/scenes/claims/ClaimsWorklist";

test("worklist board renders integrity separately from underpayments across all six lanes", () => {
  const items = [
    fixture("era-denial"),
    fixture("era-integrity"),
    fixture("era-line-linkage"),
    fixture("era-underpayment"),
    fixture("era-unmatched"),
    fixture("claim-rejected"),
  ];
  const html = renderToStaticMarkup(
    <ClaimsWorklistBoard
      items={items}
      onSelect={() => undefined}
    />,
  );

  for (const label of ["ERA denials", "ERA integrity", "Line linkage", "Underpayments", "Unmatched ERAs", "Rejected claims"]) {
    assert.match(html, new RegExp(label));
  }
  assert.equal((html.match(/No items in this lane/g) ?? []).length, 0);
  assert.deepEqual(groupWorklistItems(items)["era-underpayment"].map((item) => item.code), ["era-underpayment"]);
  assert.deepEqual(groupWorklistItems(items)["era-integrity"].map((item) => item.code), ["era-integrity"]);
});

test("claim action posts to the shared worklist claim endpoint", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  await claimWorklistItem("task-17", {
    authorization: "Bearer test",
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ task: { id: "task-17", status: "in-progress" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/claims/worklist/task-17/claim");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, "Bearer test");
});

test("claim action refresh projects the resulting in-review status", async () => {
  let claimed = false;
  const fetchImpl: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/claim") && init?.method === "POST") {
      claimed = true;
      return jsonResponse({ task: { id: "task-17", status: "in-progress" } });
    }
    return jsonResponse({ items: [{ ...fixture("claim-rejected"), status: claimed ? "in-review" : "new", action: claimed ? "resolve" : "claim" }] });
  };

  await claimWorklistItem("task-17", { fetchImpl });
  const refreshed = await fetchClaimsWorklist(undefined, { fetchImpl });
  const html = renderToStaticMarkup(<ClaimsWorklistBoard items={refreshed} onSelect={() => undefined} />);

  assert.equal(refreshed[0].status, "in-review");
  assert.match(html, /in-review/);
});

test("matched disposition is offered only for era-unmatched", () => {
  assert.equal(dispositionsForLane("era-unmatched").includes("matched"), true);
  assert.equal(dispositionsForLane("era-denial").includes("matched"), false);
  assert.equal(dispositionsForLane("era-integrity").includes("matched"), false);
  assert.equal(dispositionsForLane("era-line-linkage").includes("matched"), false);
  assert.equal(dispositionsForLane("era-underpayment").includes("matched"), false);
  assert.equal(dispositionsForLane("claim-rejected").includes("matched"), false);
});

test("rebilled resolution offers real corrected and voided Stedi claim actions", () => {
  const html = renderToStaticMarkup(
    <ClaimsWorklistPanel
      item={{ ...fixture("claim-rejected"), status: "in-review", action: "resolve", focusReference: "Claim/claim-1" }}
      onClose={() => undefined}
      onClaim={async () => undefined}
      onResolve={async () => undefined}
      onVoid={async () => undefined}
    />,
  );

  assert.doesNotMatch(html, /Submit the corrected claim first/);
  assert.match(html, /Correct claim/);
  assert.match(html, /Void claim/);
  assert.match(html, /Original Medicare/);
  assert.match(html, /Claim\/claim-1/);
});

function fixture(code: WorklistCode): ClaimsWorklistItem {
  return {
    id: `task-${code}`,
    taskReference: `Task/task-${code}`,
    title: `Fixture ${code}`,
    code,
    patientReference: code === "era-unmatched" ? undefined : "Patient/pat-1",
    severity: code === "era-underpayment" ? "medium" : "high",
    ageTimer: { startedAt: "2026-07-09T12:00:00.000Z", elapsedMinutes: 30 },
    action: "claim",
    status: "new",
    evidence: code === "claim-rejected"
      ? { kind: "claim-rejected", claimMdMessage: "Rejected" }
      : {
          kind: "era",
          pcn: "PCN-1",
          eraId: "ERA-1",
          chargedCents: 10_000,
          allowedCents: 8_000,
          paidCents: 0,
          patientResponsibilityCents: 0,
          shortfallCents: 8_000,
          adjustments: [],
        },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
