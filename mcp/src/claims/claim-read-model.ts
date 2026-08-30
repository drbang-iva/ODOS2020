import type { Claim, ClaimResponse, Resource, Task } from "@medplum/fhirtypes";
import { claimReasonState, claimTouchState, projectClaimWorkFacts, type ClaimWorkFacts } from "./claim-touch-ledger.js";
import { projectClaimSearchResults, type ClaimSearchStatus } from "./claim-search.js";

export interface ClaimReadModelRow {
  claimReference: string;
  claimNumber: string;
  patientReference: string;
  patient: string;
  providerReference: string;
  provider: string;
  cptCodes: string[];
  totalChargedCents: number;
  collectedCents: number;
  patientResponsibilityCents: number;
  status: ClaimSearchStatus;
  payerReference: string;
  payer: string;
  officeReference?: string;
  office?: string;
  billedAt: string;
  open: boolean;
  touchCount: number;
  lastTouchedAt: string | null;
  lastTouchedBy: string | null;
  reasonCode: string | null;
  reasonDisplay: string | null;
  resolutionPath: string | null;
}

export interface ClaimWorklistRow extends ClaimReadModelRow, ClaimWorkFacts {
  outstandingCents: number;
}

export interface ClaimWorklistGroup {
  reason: {
    code: string | null;
    display: string;
    resolutionPath: string | null;
  };
  count: number;
  totalOutstandingCents: number;
  rows: ClaimWorklistRow[];
}

export interface NeverPaidUntouchedMetricRow {
  payerReference: string;
  payer: string;
  billedMonth: string;
  billedClaimCount: number;
  neverPaidUntouchedCount: number;
  neverPaidUntouchedRate: number;
}

export interface ClaimReadModelReconciliation {
  inSync: boolean;
  truthCount: number;
  readModelCount: number;
  divergences: Array<{
    claimReference: string;
    kind: "missing" | "unexpected" | "mismatch";
    fields: string[];
  }>;
}

export function projectClaimReadModel(input: {
  claims: readonly Claim[];
  responses: readonly ClaimResponse[];
  tasks: readonly Task[];
  relatedResources: readonly Resource[];
  at: string;
}): ClaimReadModelRow[] {
  const claimsByReference = new Map<string, Claim>(input.claims.flatMap((claim) => claim.id
    ? [[`Claim/${claim.id}`, claim] as const]
    : []));
  return projectClaimSearchResults(input).map((row) => {
    const claim = claimsByReference.get(row.claimReference);
    if (!claim) throw new Error(`FHIR projection lost ${row.claimReference}.`);
    const touch = claimTouchState(claim);
    const reason = claimReasonState(claim);
    return {
      claimReference: row.claimReference,
      claimNumber: row.claimNumber,
      patientReference: row.patientReference,
      patient: row.patient,
      providerReference: row.providerReference,
      provider: row.provider,
      cptCodes: row.cptCodes,
      totalChargedCents: row.totalChargedCents,
      collectedCents: row.insurancePaidCents,
      patientResponsibilityCents: row.patientResponsibilityCents,
      status: row.status,
      payerReference: row.payerReference,
      payer: row.payer,
      ...(row.officeReference ? { officeReference: row.officeReference } : {}),
      ...(row.office ? { office: row.office } : {}),
      billedAt: claim.created,
      open: row.status !== "paid",
      touchCount: touch.touchCount,
      lastTouchedAt: touch.lastTouchedAt ?? null,
      lastTouchedBy: touch.lastTouchedBy ?? null,
      reasonCode: reason.code,
      reasonDisplay: reason.display,
      resolutionPath: reason.resolutionPath,
    };
  });
}

export function groupClaimWorklist(
  rows: readonly ClaimReadModelRow[],
  at: string,
  thresholds: readonly [number, number, number],
): ClaimWorklistGroup[] {
  const ranked = rows
    .filter((row) => row.open)
    .map((row): ClaimWorklistRow => ({
      ...row,
      ...projectClaimWorkFacts({
        billedAt: row.billedAt,
        status: row.status,
        touchCount: row.touchCount,
        ...(row.lastTouchedAt ? { lastTouchedAt: row.lastTouchedAt } : {}),
        ...(row.lastTouchedBy ? { lastTouchedBy: row.lastTouchedBy } : {}),
        at,
        thresholds,
      }),
      outstandingCents: Math.max(0, row.totalChargedCents - row.collectedCents),
    }))
    .sort((left, right) =>
      Number(right.touchCount === 0 && right.daysSinceBilled >= thresholds[0])
        - Number(left.touchCount === 0 && left.daysSinceBilled >= thresholds[0])
      || right.untouchedRankingDays - left.untouchedRankingDays
      || right.daysSinceBilled - left.daysSinceBilled
      || left.claimReference.localeCompare(right.claimReference)
    );
  const groups = new Map<string, ClaimWorklistGroup>();
  for (const row of ranked) {
    const key = row.reasonCode ?? "";
    const current = groups.get(key) ?? {
      reason: {
        code: row.reasonCode,
        display: row.reasonDisplay ?? "No typed reason",
        resolutionPath: row.resolutionPath,
      },
      count: 0,
      totalOutstandingCents: 0,
      rows: [],
    };
    current.count += 1;
    current.totalOutstandingCents += row.outstandingCents;
    current.rows.push(row);
    groups.set(key, current);
  }
  return [...groups.values()];
}

export function neverPaidUntouchedMetric(
  rows: readonly ClaimReadModelRow[],
): NeverPaidUntouchedMetricRow[] {
  const groups = new Map<string, NeverPaidUntouchedMetricRow>();
  for (const row of rows) {
    const billedMonth = row.billedAt.slice(0, 7);
    const key = `${row.payerReference}\u0000${billedMonth}`;
    const current = groups.get(key) ?? {
      payerReference: row.payerReference,
      payer: row.payer,
      billedMonth,
      billedClaimCount: 0,
      neverPaidUntouchedCount: 0,
      neverPaidUntouchedRate: 0,
    };
    current.billedClaimCount += 1;
    if (row.collectedCents === 0 && row.touchCount === 0) {
      current.neverPaidUntouchedCount += 1;
    }
    current.neverPaidUntouchedRate = current.neverPaidUntouchedCount / current.billedClaimCount;
    groups.set(key, current);
  }
  return [...groups.values()].sort((left, right) =>
    left.billedMonth.localeCompare(right.billedMonth)
    || left.payer.localeCompare(right.payer)
  );
}

export function reconcileClaimReadModel(
  truth: readonly ClaimReadModelRow[],
  readModel: readonly ClaimReadModelRow[],
): ClaimReadModelReconciliation {
  const truthByClaim = new Map(truth.map((row) => [row.claimReference, row]));
  const readModelByClaim = new Map(readModel.map((row) => [row.claimReference, row]));
  const divergences: ClaimReadModelReconciliation["divergences"] = [];
  for (const claimReference of [...new Set([...truthByClaim.keys(), ...readModelByClaim.keys()])].sort()) {
    const expected = truthByClaim.get(claimReference);
    const actual = readModelByClaim.get(claimReference);
    if (!actual) {
      divergences.push({ claimReference, kind: "missing", fields: [] });
      continue;
    }
    if (!expected) {
      divergences.push({ claimReference, kind: "unexpected", fields: [] });
      continue;
    }
    const fields = READ_MODEL_FIELDS.filter((field) =>
      JSON.stringify(expected[field]) !== JSON.stringify(actual[field])
    );
    if (fields.length) divergences.push({ claimReference, kind: "mismatch", fields });
  }
  return {
    inSync: divergences.length === 0,
    truthCount: truth.length,
    readModelCount: readModel.length,
    divergences,
  };
}

const READ_MODEL_FIELDS = [
  "claimNumber",
  "patientReference",
  "patient",
  "providerReference",
  "provider",
  "cptCodes",
  "totalChargedCents",
  "collectedCents",
  "patientResponsibilityCents",
  "status",
  "payerReference",
  "payer",
  "officeReference",
  "office",
  "billedAt",
  "open",
  "touchCount",
  "lastTouchedAt",
  "lastTouchedBy",
  "reasonCode",
  "reasonDisplay",
  "resolutionPath",
] as const satisfies readonly (keyof ClaimReadModelRow)[];
