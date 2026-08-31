import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Basic, Bundle, Resource } from "@medplum/fhirtypes";
import { StediRequestError } from "../src/claims/stedi-adapter.js";
import {
  createFhirEligibilitySweepStore,
  eligibilityEnrichmentAgeOutMs,
  eligibilityTransactionIdentifier,
  runEligibilitySweepTick,
  startEligibilitySweepWorker,
  type EligibilityCandidate,
  type EligibilityFinding,
  type EligibilitySweepState,
  type EligibilitySweepStore,
  type PreventiveStediClient,
} from "../src/jobs/eligibilitySweep.js";

const DATE = "2026-08-31";
const NOW = "2026-08-30T23:00:00.000Z";

function stediFixture(name: string): { items: Record<string, unknown>[] } {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as {
    items: Record<string, unknown>[];
  };
}

function statusFixture(name: "stedi-batch-items-unenriched.json" | "stedi-batch-items-enriched.json", transactionId: string): Record<string, unknown> {
  const item = structuredClone(stediFixture(name).items[0]!);
  const additionalInfo = item.additionalInfo as Record<string, unknown>;
  const eligibility = additionalInfo.eligibility as Record<string, unknown>;
  eligibility.submitterTransactionIdentifier = transactionId;
  return item;
}

function resultFixture(transactionId: string): Record<string, unknown> {
  const item = structuredClone(stediFixture("stedi-batch-poll-active.json").items[0]!);
  item.submitterTransactionIdentifier = transactionId;
  return item;
}

function candidate(overrides: Partial<EligibilityCandidate> = {}): EligibilityCandidate {
  const value: EligibilityCandidate = {
    key: "2026-08-31:appointment-1:coverage-1",
    appointmentReference: "Appointment/appointment-1",
    appointmentAt: "2026-08-31T14:15:00.000Z",
    patientReference: "Patient/patient-1",
    patientDisplay: "Marcus T.",
    coverageReference: "Coverage/coverage-1",
    payerReference: "Organization/payer-1",
    payerDisplay: "Example Health",
    intendedPayerId: "PAYER1",
    chartMemberId: "CHART-123",
    cobApplicability: "supported",
    eligibilityRequest: {
      submitterTransactionIdentifier: "2026-08-31:appointment-1:coverage-1",
      tradingPartnerServiceId: "PAYER1",
      encounter: { dateOfService: "20260831", serviceTypeCodes: ["30"] },
      provider: { npi: "1999999984", organizationName: "Synthetic Eye Care" },
      subscriber: { firstName: "Marcus", lastName: "Test", dateOfBirth: "19800102", memberId: "CHART-123" },
    },
    discoveryRequest: {
      encounter: { dateOfService: "20260831" },
      provider: { npi: "1999999984", organizationName: "Synthetic Eye Care" },
      subscriber: { firstName: "Marcus", lastName: "Test", dateOfBirth: "19800102" },
    },
    ...overrides,
  };
  return {
    ...value,
    eligibilityRequest: {
      ...value.eligibilityRequest,
      submitterTransactionIdentifier: eligibilityTransactionIdentifier(value),
    },
  };
}

function memoryStore(candidates = [candidate()], cloneCandidates = true): EligibilitySweepStore & {
  states: EligibilitySweepState[];
  findings: EligibilityFinding[];
} {
  const states: EligibilitySweepState[] = [];
  const findings: EligibilityFinding[] = [];
  let submittedCandidates: EligibilityCandidate[] | undefined;
  return {
    states,
    findings,
    loadState: async () => states.at(-1),
    saveState: async (state) => { states.push(structuredClone(state)); },
    loadCandidates: async () => cloneCandidates ? structuredClone(candidates) : candidates,
    loadSubmittedCandidates: async () => submittedCandidates ? structuredClone(submittedCandidates) : undefined,
    saveSubmittedCandidates: async (_date, values) => { submittedCandidates = structuredClone(values); },
    loadFindings: async () => structuredClone(findings),
    replaceFindings: async (_date, values) => {
      findings.splice(0, findings.length, ...structuredClone(values));
    },
  };
}

function stedi(overrides: Partial<PreventiveStediClient> = {}): PreventiveStediClient & { submitted: number } {
  const client = {
    submitted: 0,
    submitBatchEligibility: async () => {
      client.submitted += 1;
      return { batchId: "batch-1", submittedAt: NOW };
    },
    getBatchEligibilityItems: async () => ({
      items: [{
        state: "COMPLETED",
        eligibilityCheckResult: "ACTIVE",
        submitterTransactionIdentifier: candidate().eligibilityRequest.submitterTransactionIdentifier,
      }],
    }),
    pollBatchEligibility: async () => ({
      items: [{
        batchId: "batch-1",
        submitterTransactionIdentifier: candidate().eligibilityRequest.submitterTransactionIdentifier,
        subscriber: { firstName: "Marcus-From-Payer", lastName: "Test", dateOfBirth: "19800102", memberId: "PAYER-123" },
        benefitsInformation: [{ code: "1", name: "Active Coverage" }],
      }],
    }),
    checkCoordinationOfBenefits: async () => ({
      coordinationOfBenefits: { classification: "MemberFoundNoCob", instanceExists: false },
      benefitsInformation: [],
    }),
    submitInsuranceDiscovery: async () => ({ status: "COMPLETE", discoveryId: "discovery-1", items: [] }),
    getInsuranceDiscoveryResults: async () => ({ status: "COMPLETE", discoveryId: "discovery-1", items: [] }),
    ...overrides,
  };
  return client;
}

test("the batch state machine submits once, polls on later ticks, and ingests only after completion", async () => {
  const store = memoryStore();
  let statusCall = 0;
  const client = stedi({
    getBatchEligibilityItems: async () => {
      statusCall += 1;
      return statusCall === 1
        ? { items: [{ state: "STARTED", submitterTransactionIdentifier: candidate().eligibilityRequest.submitterTransactionIdentifier }] }
        : { items: [{ state: "COMPLETED", eligibilityCheckResult: "ACTIVE", submitterTransactionIdentifier: candidate().eligibilityRequest.submitterTransactionIdentifier }] };
    },
  });

  await runEligibilitySweepTick({ store, stedi: client, date: DATE, now: NOW });
  assert.equal(store.states.at(-1)?.status, "submitted");
  assert.deepEqual(store.states.at(-1)?.batchIds, ["batch-1"]);
  assert.equal(client.submitted, 1);

  await runEligibilitySweepTick({ store, stedi: client, date: DATE, now: "2026-08-30T23:05:00.000Z" });
  assert.equal(store.states.at(-1)?.status, "processing");
  assert.equal(client.submitted, 1);
  assert.equal(store.findings.length, 0);

  await runEligibilitySweepTick({ store, stedi: client, date: DATE, now: "2026-08-30T23:10:00.000Z" });
  assert.equal(store.states.at(-1)?.status, "healthy");
  assert.equal(client.submitted, 1);
  assert.equal(store.findings.length, 0, "ACTIVE with supported COB all-clear stays silent");
});

test("a real COMPLETED-but-unenriched item stays processing without ingesting findings", async () => {
  const source = candidate();
  const transactionId = source.eligibilityRequest.submitterTransactionIdentifier;
  const store = memoryStore([source]);
  let resultPolls = 0;
  const client = stedi({
    getBatchEligibilityItems: async () => ({
      items: [statusFixture("stedi-batch-items-unenriched.json", transactionId)],
    }),
    pollBatchEligibility: async () => {
      resultPolls += 1;
      return { items: [resultFixture(transactionId)] };
    },
  });

  await runEligibilitySweepTick({ store, stedi: client, date: DATE, now: NOW });
  await runEligibilitySweepTick({ store, stedi: client, date: DATE, now: "2026-08-31T13:50:00.000Z" });

  assert.equal(store.states.at(-1)?.status, "processing");
  assert.deepEqual(store.findings, []);
  assert.equal(resultPolls, 0, "the full result is not ingested before status enrichment");
});

test("the same real item becomes healthy only after ACTIVE enrichment and records first-seen lag", async () => {
  const source = candidate();
  const transactionId = source.eligibilityRequest.submitterTransactionIdentifier;
  const unenriched = statusFixture("stedi-batch-items-unenriched.json", transactionId);
  const enriched = statusFixture("stedi-batch-items-enriched.json", transactionId);
  const eligibility = ((enriched.additionalInfo as Record<string, unknown>).eligibility as Record<string, unknown>);
  const itemId = String(eligibility.id);
  let statusPolls = 0;
  const store = memoryStore([source]);
  const client = stedi({
    getBatchEligibilityItems: async () => ({ items: [statusPolls++ === 0 ? unenriched : enriched] }),
    pollBatchEligibility: async () => ({ items: [resultFixture(transactionId)] }),
  });

  await runEligibilitySweepTick({ store, stedi: client, date: DATE, now: NOW });
  await runEligibilitySweepTick({ store, stedi: client, date: DATE, now: "2026-08-31T13:50:00.000Z" });
  await runEligibilitySweepTick({ store, stedi: client, date: DATE, now: "2026-08-31T13:55:00.000Z" });

  const finalState = store.states.at(-1);
  assert.deepEqual(store.findings, [], "ACTIVE without COB or AAA findings is completely silent");
  assert.equal(finalState?.status, "healthy", "the positive engine signal proves ingestion completed");
  assert.equal(finalState?.lastSuccessfulAt, "2026-08-31T13:55:00.000Z");
  assert.equal(
    finalState?.eligibilityEnrichmentLagMsByItemId?.[itemId],
    Date.parse("2026-08-31T13:55:00.000Z") - Date.parse(String(enriched.createdAt)),
  );
  assert.equal(
    /eligibilityCheckResult\s*:\s*"FAILED"\s+as const/.test(
      readFileSync(new URL("../src/jobs/eligibilitySweep.ts", import.meta.url), "utf8"),
    ),
    false,
    "absence must not be stamped as FAILED during ingestion",
  );
});

test("the first observed enrichment lag survives a later ingestion failure and is never overwritten", async () => {
  const source = candidate();
  const transactionId = source.eligibilityRequest.submitterTransactionIdentifier;
  const enriched = statusFixture("stedi-batch-items-enriched.json", transactionId);
  const eligibility = ((enriched.additionalInfo as Record<string, unknown>).eligibility as Record<string, unknown>);
  const itemId = String(eligibility.id);
  const store = memoryStore([source]);
  let resultPolls = 0;
  const client = stedi({
    getBatchEligibilityItems: async () => ({ items: [enriched] }),
    pollBatchEligibility: async () => {
      resultPolls += 1;
      if (resultPolls === 1) throw new Error("synthetic result-ingestion outage");
      return { items: [resultFixture(transactionId)] };
    },
  });
  const firstSeenAt = "2026-08-31T13:55:00.000Z";
  const expectedLag = Date.parse(firstSeenAt) - Date.parse(String(enriched.createdAt));

  await runEligibilitySweepTick({ store, stedi: client, date: DATE, now: NOW });
  await assert.rejects(
    runEligibilitySweepTick({ store, stedi: client, date: DATE, now: firstSeenAt }),
    /synthetic result-ingestion outage/,
  );
  assert.equal(store.states.at(-1)?.eligibilityEnrichmentLagMsByItemId?.[itemId], expectedLag);

  await runEligibilitySweepTick({ store, stedi: client, date: DATE, now: "2026-08-31T14:55:00.000Z" });
  assert.equal(store.states.at(-1)?.status, "healthy");
  assert.equal(store.states.at(-1)?.eligibilityEnrichmentLagMsByItemId?.[itemId], expectedLag);
});

test("real enriched INACTIVE and FAILED results still produce W21 findings", async () => {
  const inactive = candidate({ key: "inactive" });
  const failed = candidate({ key: "failed" });
  const sources = [inactive, failed];
  const statuses = sources.map((source, index) => {
    const status = statusFixture("stedi-batch-items-enriched.json", source.eligibilityRequest.submitterTransactionIdentifier);
    const eligibility = ((status.additionalInfo as Record<string, unknown>).eligibility as Record<string, unknown>);
    eligibility.eligibilityCheckResult = index === 0 ? "INACTIVE" : "FAILED";
    eligibility.id = `eligibility-${index + 1}`;
    return status;
  });
  const store = memoryStore(sources);
  const client = stedi({
    getBatchEligibilityItems: async () => ({ items: statuses }),
    pollBatchEligibility: async () => ({
      items: sources.map((source) => resultFixture(source.eligibilityRequest.submitterTransactionIdentifier)),
    }),
  });

  await runEligibilitySweepTick({ store, stedi: client, date: DATE, now: NOW });
  await runEligibilitySweepTick({ store, stedi: client, date: DATE, now: "2026-08-31T14:00:00.000Z" });

  assert.deepEqual(
    store.findings.filter((finding) => finding.watcherId === "W21").map((finding) => finding.eligibilityCheckResult).sort(),
    ["FAILED", "INACTIVE"],
  );
});

test("real ACTIVE enrichment still emits independent COB and AAA findings", async () => {
  const source = candidate();
  const transactionId = source.eligibilityRequest.submitterTransactionIdentifier;
  const status = statusFixture("stedi-batch-items-enriched.json", transactionId);
  const result = resultFixture(transactionId);
  result.aaaErrors = [{ code: "72" }];
  const store = memoryStore([source]);
  const client = stedi({
    getBatchEligibilityItems: async () => ({ items: [status] }),
    pollBatchEligibility: async () => ({ items: [result] }),
    checkCoordinationOfBenefits: async () => ({
      coordinationOfBenefits: { classification: "CobInstanceExistsPrimacyDetermined" },
      benefitsInformation: [{
        code: "R",
        benefitsRelatedEntities: [{
          entityIdentifier: "Primary Payer",
          entityName: "Other Primary Health",
          entityIdentificationValue: "PRIMARY2",
        }],
      }],
    }),
  });

  await runEligibilitySweepTick({ store, stedi: client, date: DATE, now: NOW });
  await runEligibilitySweepTick({ store, stedi: client, date: DATE, now: "2026-08-31T14:00:00.000Z" });

  assert.deepEqual(store.findings.map((finding) => finding.watcherId).sort(), ["W22", "W23"]);
  assert.equal(store.findings.some((finding) => finding.watcherId === "W21"), false);
});

test("unenriched COMPLETED_WITH_ERRORS requires a valid four-hour age before becoming undeterminable", async () => {
  assert.equal(eligibilityEnrichmentAgeOutMs(undefined), 4 * 60 * 60_000);
  assert.equal(eligibilityEnrichmentAgeOutMs("6"), 6 * 60 * 60_000);
  assert.throws(() => eligibilityEnrichmentAgeOutMs("0"), /positive number/);

  const source = candidate({ cobApplicability: "unknown" });
  const transactionId = source.eligibilityRequest.submitterTransactionIdentifier;
  const base = statusFixture("stedi-batch-items-unenriched.json", transactionId);
  base.state = "COMPLETED_WITH_ERRORS";
  const createdAt = String(base.createdAt);
  let statusPolls = 0;
  const store = memoryStore([source]);
  const client = stedi({
    getBatchEligibilityItems: async () => {
      statusPolls += 1;
      const status = structuredClone(base);
      if (statusPolls === 1) delete status.createdAt;
      if (statusPolls === 2) status.createdAt = "not-a-timestamp";
      return { items: [status] };
    },
    pollBatchEligibility: async () => ({ items: [] }),
  });

  await runEligibilitySweepTick({ store, stedi: client, date: DATE, now: NOW });
  await runEligibilitySweepTick({ store, stedi: client, date: DATE, now: "2026-08-31T18:00:00.000Z" });
  assert.equal(store.states.at(-1)?.status, "processing", "missing createdAt cannot imply an outcome");
  await runEligibilitySweepTick({ store, stedi: client, date: DATE, now: "2026-08-31T18:05:00.000Z" });
  assert.equal(store.states.at(-1)?.status, "processing", "malformed createdAt cannot imply an outcome");
  await runEligibilitySweepTick({
    store,
    stedi: client,
    date: DATE,
    now: new Date(Date.parse(createdAt) + 4 * 60 * 60_000 - 1).toISOString(),
  });
  assert.equal(store.states.at(-1)?.status, "processing", "the configured boundary is not rounded down");
  await runEligibilitySweepTick({
    store,
    stedi: client,
    date: DATE,
    now: new Date(Date.parse(createdAt) + 4 * 60 * 60_000).toISOString(),
  });

  const w21 = store.findings.find((finding) => finding.watcherId === "W21");
  assert.ok(w21, "age-out produces manual-verification work rather than hanging forever");
  assert.equal(w21.eligibilityCheckResult, undefined, "undeterminable is not a payer result");
  assert.equal(store.states.at(-1)?.status, "healthy");
  assert.doesNotMatch(JSON.stringify({ state: store.states.at(-1), finding: w21 }), /FAILED/i);
});

test("documented batch status nesting supplies the eligibility result", async () => {
  const source = candidate({ cobApplicability: "unknown" });
  const store = memoryStore([source]);
  const client = stedi({
    getBatchEligibilityItems: async () => ({
      items: [{
        state: "COMPLETED",
        additionalInfo: {
          eligibility: {
            eligibilityCheckResult: "ACTIVE",
            submitterTransactionIdentifier: source.eligibilityRequest.submitterTransactionIdentifier,
          },
        },
      }],
    }),
    pollBatchEligibility: async () => ({
      items: [{
        submitterTransactionIdentifier: source.eligibilityRequest.submitterTransactionIdentifier,
        subscriber: { firstName: "Marcus", lastName: "Test", dateOfBirth: "19800102", memberId: "PAYER-123" },
      }],
    }),
  });

  await runEligibilitySweepTick({ store, stedi: client, date: DATE, now: NOW });
  await runEligibilitySweepTick({ store, stedi: client, date: DATE, now: "2026-08-30T23:05:00.000Z" });

  assert.equal(store.findings.some((finding) => finding.watcherId === "W21"), false);
  assert.equal(store.findings.find((finding) => finding.watcherId === "W22")?.cob?.status, "could-not-check");
});

test("inactive eligibility, coverage ending before the visit, and targeted AAA errors normalize to W21/W23 work", async () => {
  const store = memoryStore();
  const client = stedi({
    getBatchEligibilityItems: async () => ({
      items: [{
        state: "COMPLETED",
        eligibilityCheckResult: "INACTIVE",
        submitterTransactionIdentifier: candidate().eligibilityRequest.submitterTransactionIdentifier,
        additionalInfo: { eligibility: { aaaErrors: [{ code: "72" }] } },
      }],
    }),
    pollBatchEligibility: async () => ({
      items: [{
        batchId: "batch-1",
        submitterTransactionIdentifier: candidate().eligibilityRequest.submitterTransactionIdentifier,
        subscriber: { firstName: "Marcus", lastName: "Test", dateOfBirth: "19800102", memberId: "PAYER-999" },
        planDateInformation: { planEnd: "20260830" },
        aaaErrors: [{ code: "72" }],
      }],
    }),
    submitInsuranceDiscovery: async () => ({
      status: "COMPLETE",
      discoveryId: "discovery-1",
      items: [{ subscriber: { memberId: "PAYER-999" }, payer: { name: "Example Health" } }],
    }),
  });

  await runEligibilitySweepTick({ store, stedi: client, date: DATE, now: NOW });
  await runEligibilitySweepTick({ store, stedi: client, date: DATE, now: "2026-08-30T23:05:00.000Z" });

  assert.deepEqual(store.findings.map((finding) => finding.watcherId).sort(), ["W21", "W23"]);
  assert.equal(store.findings.find((finding) => finding.watcherId === "W21")?.eligibilityCheckResult, "INACTIVE");
  assert.equal(store.findings.find((finding) => finding.watcherId === "W21")?.coverageEnd, "2026-08-30");
  assert.deepEqual(store.findings.find((finding) => finding.watcherId === "W23")?.aaaCodes, ["72"]);
});

test("COB uses payer-returned eligibility identity and unknown or inapplicable payers become could-not-check work", async () => {
  const inputs: unknown[] = [];
  const supported = candidate();
  const inapplicable = (["unknown", "unsupported", "traditional-medicare", "capitated"] as const).map((cobApplicability, index) => candidate({
    key: `2026-08-31:appointment-${index + 2}:coverage-${index + 2}`,
    appointmentReference: `Appointment/appointment-${index + 2}`,
    coverageReference: `Coverage/coverage-${index + 2}`,
    cobApplicability,
    eligibilityRequest: { ...candidate().eligibilityRequest, submitterTransactionIdentifier: `2026-08-31:appointment-${index + 2}:coverage-${index + 2}` },
  }));
  const store = memoryStore([supported, ...inapplicable]);
  const client = stedi({
    getBatchEligibilityItems: async () => ({ items: [supported, ...inapplicable].map((value) => ({ state: "COMPLETED", eligibilityCheckResult: "ACTIVE", submitterTransactionIdentifier: value.eligibilityRequest.submitterTransactionIdentifier })) }),
    pollBatchEligibility: async () => ({ items: [supported, ...inapplicable].map((value) => ({ submitterTransactionIdentifier: value.eligibilityRequest.submitterTransactionIdentifier, subscriber: { firstName: "Jonathan", lastName: "Payer", dateOfBirth: "19791231", memberId: "PAYER-EXACT" } })) }),
    checkCoordinationOfBenefits: async (input) => {
      inputs.push(input);
      return { coordinationOfBenefits: { classification: "MemberFoundNoCob", instanceExists: false }, benefitsInformation: [] };
    },
  });

  await runEligibilitySweepTick({ store, stedi: client, date: DATE, now: NOW });
  await runEligibilitySweepTick({ store, stedi: client, date: DATE, now: "2026-08-30T23:05:00.000Z" });

  assert.equal(inputs.length, 1, "only explicit supported invokes COB");
  assert.deepEqual((inputs[0] as any).subscriber, { firstName: "Jonathan", lastName: "Payer", dateOfBirth: "19791231", memberId: "PAYER-EXACT" });
  assert.notEqual((inputs[0] as any).subscriber.firstName, "Marcus", "chart identity is not reused");
  const couldNotCheck = store.findings.filter((finding) => finding.watcherId === "W22");
  assert.deepEqual(couldNotCheck.map((finding) => finding.cob?.status), ["could-not-check", "could-not-check", "could-not-check", "could-not-check"]);
  assert.deepEqual(couldNotCheck.map((finding) => finding.cob?.reason), ["unknown", "unsupported", "traditional-medicare", "capitated"]);
});

test("COB reports a payer mismatch from Stedi's standardized primary-payer entity", async () => {
  const store = memoryStore();
  const client = stedi({
    checkCoordinationOfBenefits: async () => ({
      coordinationOfBenefits: {
        classification: "CobInstanceExistsPrimacyDetermined",
        instanceExists: true,
        primacyDetermined: true,
      },
      benefitsInformation: [{
        code: "R",
        name: "Other or Additional Payor",
        benefitsRelatedEntities: [{
          entityIdentifier: "Primary Payer",
          entityName: "Other Primary Health",
          entityIdentification: "PI",
          entityIdentificationValue: "PRIMARY2",
        }],
      }],
    }),
  });

  await runEligibilitySweepTick({ store, stedi: client, date: DATE, now: NOW });
  await runEligibilitySweepTick({ store, stedi: client, date: DATE, now: "2026-08-30T23:05:00.000Z" });

  assert.deepEqual(store.findings.find((finding) => finding.watcherId === "W22")?.cob, {
    status: "mismatch",
    returnedPrimaryPayerId: "PRIMARY2",
    returnedPrimaryPayerDisplay: "Other Primary Health",
  });
});

test("Insurance Discovery returns a member-ID proposal without mutating Coverage input", async () => {
  const source = candidate();
  const store = memoryStore([source], false);
  const client = stedi({
    getBatchEligibilityItems: async () => ({ items: [{ state: "COMPLETED", eligibilityCheckResult: "FAILED", submitterTransactionIdentifier: source.eligibilityRequest.submitterTransactionIdentifier, additionalInfo: { eligibility: { aaaErrors: [{ code: "72" }] } } }] }),
    pollBatchEligibility: async () => ({ items: [{ submitterTransactionIdentifier: source.eligibilityRequest.submitterTransactionIdentifier, aaaErrors: [{ code: "72" }] }] }),
    submitInsuranceDiscovery: async () => ({ status: "COMPLETE", discoveryId: "discovery-1", items: [{ subscriber: { memberId: "DISCOVERED-456" } }] }),
  });

  await runEligibilitySweepTick({ store, stedi: client, date: DATE, now: NOW });
  await runEligibilitySweepTick({ store, stedi: client, date: DATE, now: "2026-08-30T23:05:00.000Z" });

  assert.equal(source.chartMemberId, "CHART-123");
  assert.deepEqual(store.findings.find((finding) => finding.watcherId === "W23")?.memberIdProposal, {
    current: "CHART-123",
    proposed: "DISCOVERED-456",
    source: "insurance-discovery",
  });
});

test("a completed sweep rerun remains one finding per appointment and does not resubmit", async () => {
  const store = memoryStore();
  const client = stedi({
    getBatchEligibilityItems: async () => ({ items: [{ state: "COMPLETED", eligibilityCheckResult: "INACTIVE", submitterTransactionIdentifier: candidate().eligibilityRequest.submitterTransactionIdentifier }] }),
  });
  await runEligibilitySweepTick({ store, stedi: client, date: DATE, now: NOW });
  await runEligibilitySweepTick({ store, stedi: client, date: DATE, now: "2026-08-30T23:05:00.000Z" });
  await runEligibilitySweepTick({ store, stedi: client, date: DATE, now: "2026-08-30T23:10:00.000Z" });
  assert.equal(client.submitted, 1);
  assert.equal(store.findings.filter((finding) => finding.watcherId === "W21").length, 1);
});

test("a later batch submission failure preserves accepted batch IDs and does not resubmit them", async () => {
  const candidates = Array.from({ length: 10_001 }, (_, index) => candidate({
    key: `2026-08-31:appointment-${index}:coverage-${index}`,
    appointmentReference: `Appointment/appointment-${index}`,
    coverageReference: `Coverage/coverage-${index}`,
    eligibilityRequest: {
      ...candidate().eligibilityRequest,
      submitterTransactionIdentifier: `2026-08-31:appointment-${index}:coverage-${index}`,
    },
  }));
  const store = memoryStore(candidates, false);
  let submitCalls = 0;
  const submittedItemCounts: number[] = [];
  const client = stedi({
    submitBatchEligibility: async (input) => {
      submitCalls += 1;
      submittedItemCounts.push(input.items.length);
      if (submitCalls === 1) return { batchId: "accepted-batch", submittedAt: NOW };
      if (submitCalls === 2) throw new StediRequestError(400, { errors: [{ description: "later chunk failed" }] });
      return { batchId: "resumed-batch", submittedAt: NOW };
    },
  });

  await assert.rejects(runEligibilitySweepTick({ store, stedi: client, date: DATE, now: NOW }), /later chunk failed/);
  assert.equal(store.states.at(-1)?.status, "failed");
  assert.deepEqual(store.states.at(-1)?.batchIds, ["accepted-batch"]);
  assert.equal(store.states.at(-1)?.expectedChecks, 10_001);
  assert.equal(store.states.at(-1)?.submittedTransactionIdentifiers?.length, 10_000);
  assert.equal(store.states.at(-1)?.submissionComplete, false);

  candidates[0].chartMemberId = "CHANGED-AFTER-ACCEPTANCE";
  candidates[0].eligibilityRequest = {
    ...candidates[0].eligibilityRequest,
    subscriber: { firstName: "Marcus", lastName: "Test", dateOfBirth: "19800102", memberId: "CHANGED-AFTER-ACCEPTANCE" },
  };
  store.states.push({ ...structuredClone(store.states.at(-1)!), status: "submitted" });
  await runEligibilitySweepTick({ store, stedi: client, date: DATE, now: "2026-08-30T23:05:00.000Z" });
  assert.equal(submitCalls, 3);
  assert.deepEqual(submittedItemCounts, [10_000, 1, 1]);
  assert.equal(store.states.at(-1)?.status, "submitted");
  assert.deepEqual(store.states.at(-1)?.batchIds, ["accepted-batch", "resumed-batch"]);
  assert.equal(store.states.at(-1)?.submittedTransactionIdentifiers?.length, 10_001);
  assert.equal(store.states.at(-1)?.submissionComplete, true);
});

test("a candidate added after submission is not recorded as an unchecked failure", async () => {
  const initial = candidate({ cobApplicability: "unknown" });
  const candidates = [initial];
  const store = memoryStore(candidates, false);
  const client = stedi({
    getBatchEligibilityItems: async () => ({
      items: [{
        state: "COMPLETED",
        eligibilityCheckResult: "ACTIVE",
        submitterTransactionIdentifier: initial.eligibilityRequest.submitterTransactionIdentifier,
      }],
    }),
  });

  await runEligibilitySweepTick({ store, stedi: client, date: DATE, now: NOW });
  candidates.push(candidate({
    key: "2026-08-31:appointment-late:coverage-late",
    appointmentReference: "Appointment/appointment-late",
    coverageReference: "Coverage/coverage-late",
    cobApplicability: "unknown",
    eligibilityRequest: {
      ...candidate().eligibilityRequest,
      submitterTransactionIdentifier: "2026-08-31:appointment-late:coverage-late",
    },
  }));
  await runEligibilitySweepTick({ store, stedi: client, date: DATE, now: "2026-08-30T23:05:00.000Z" });

  assert.equal(store.findings.some((finding) => finding.appointmentReference === "Appointment/appointment-late"), false);
});

test("candidate edits after submission cannot reinterpret an earlier payer response", async () => {
  const source = candidate();
  const store = memoryStore([source], false);
  const originalTransactionId = source.eligibilityRequest.submitterTransactionIdentifier;
  const client = stedi({
    getBatchEligibilityItems: async () => ({
      items: [{
        state: "COMPLETED",
        eligibilityCheckResult: "INACTIVE",
        submitterTransactionIdentifier: originalTransactionId,
        additionalInfo: { eligibility: { aaaErrors: [{ code: "72" }] } },
      }],
    }),
    pollBatchEligibility: async () => ({
      items: [{ submitterTransactionIdentifier: originalTransactionId, aaaErrors: [{ code: "72" }] }],
    }),
    submitInsuranceDiscovery: async () => ({
      status: "COMPLETE",
      items: [{ subscriber: { memberId: "DISCOVERED-456" } }],
    }),
  });

  await runEligibilitySweepTick({ store, stedi: client, date: DATE, now: NOW });
  source.chartMemberId = "CHANGED-AFTER-SUBMIT";
  source.eligibilityRequest = {
    ...source.eligibilityRequest,
    subscriber: { firstName: "Marcus", lastName: "Test", dateOfBirth: "19800102", memberId: "CHANGED-AFTER-SUBMIT" },
  };
  await runEligibilitySweepTick({ store, stedi: client, date: DATE, now: "2026-08-30T23:05:00.000Z" });

  assert.equal(store.findings.some((finding) => finding.watcherId === "W21"), true);
  assert.deepEqual(store.findings.find((finding) => finding.watcherId === "W23")?.memberIdProposal, {
    current: "CHART-123",
    proposed: "DISCOVERED-456",
    source: "insurance-discovery",
  });
});

test("FHIR sweep storage round-trips paged immutable candidate snapshots", async () => {
  const resources: Basic[] = [];
  const fhir = {
    search: async <T extends Resource>(_resourceType: T["resourceType"], params: Record<string, string>): Promise<Bundle<T>> => {
      const requested = params.identifier?.split("|").at(-1);
      const matches = resources.filter((resource) => resource.identifier?.some((identifier) => identifier.value === requested));
      return {
        resourceType: "Bundle" as const,
        type: "searchset" as const,
        entry: matches.map((resource) => ({ resource: resource as T })),
      };
    },
    read: async () => { throw new Error("not used"); },
    create: async (resource: Basic) => {
      const created = { ...structuredClone(resource), id: `snapshot-${resources.length + 1}` };
      resources.push(created);
      return created;
    },
    update: async (_resourceType: string, id: string, resource: Basic) => {
      const index = resources.findIndex((value) => value.id === id);
      resources[index] = structuredClone(resource);
      return resources[index];
    },
  };
  const store = createFhirEligibilitySweepStore(fhir as never, "America/New_York");
  const candidates = Array.from({ length: 101 }, (_, index) => candidate({
    key: `2026-08-31:appointment-snapshot-${index}:coverage-snapshot-${index}`,
    appointmentReference: `Appointment/snapshot-${index}`,
    coverageReference: `Coverage/snapshot-${index}`,
  }));

  await store.saveSubmittedCandidates(DATE, candidates);
  assert.equal(resources.length, 2);
  assert.deepEqual((await store.loadSubmittedCandidates(DATE))?.map((value) => value.key), candidates.map((value) => value.key));

  await store.saveSubmittedCandidates(DATE, candidates.slice(0, 1));
  assert.equal(resources.length, 2, "the unused page is cleared rather than duplicated");
  assert.deepEqual((await store.loadSubmittedCandidates(DATE))?.map((value) => value.key), [candidates[0].key]);
});

test("pending Insurance Discovery completes against the submitted candidate snapshot", async () => {
  const source = candidate();
  const store = memoryStore([source], false);
  const transactionId = source.eligibilityRequest.submitterTransactionIdentifier;
  const client = stedi({
    getBatchEligibilityItems: async () => ({
      items: [{
        state: "COMPLETED",
        eligibilityCheckResult: "FAILED",
        submitterTransactionIdentifier: transactionId,
        additionalInfo: { eligibility: { aaaErrors: [{ code: "72" }] } },
      }],
    }),
    pollBatchEligibility: async () => ({
      items: [{ submitterTransactionIdentifier: transactionId, aaaErrors: [{ code: "72" }] }],
    }),
    submitInsuranceDiscovery: async () => ({ status: "PENDING", discoveryId: "discovery-pending" }),
    getInsuranceDiscoveryResults: async () => ({
      status: "COMPLETE",
      discoveryId: "discovery-pending",
      items: [{ subscriber: { memberId: "DISCOVERED-789" } }],
    }),
  });

  await runEligibilitySweepTick({ store, stedi: client, date: DATE, now: NOW });
  await runEligibilitySweepTick({ store, stedi: client, date: DATE, now: "2026-08-30T23:05:00.000Z" });
  source.chartMemberId = "CHANGED-WHILE-DISCOVERY-PENDING";
  await runEligibilitySweepTick({ store, stedi: client, date: DATE, now: "2026-08-30T23:10:00.000Z" });

  assert.deepEqual(store.findings.find((finding) => finding.watcherId === "W23")?.memberIdProposal, {
    current: "CHART-123",
    proposed: "DISCOVERED-789",
    source: "insurance-discovery",
  });
  assert.equal(store.states.at(-1)?.status, "healthy");
});

test("an accepted batch with a failed local checkpoint is never submitted again", async () => {
  const store = memoryStore();
  const saveState = store.saveState;
  let failAcceptedCheckpoint = true;
  store.saveState = async (state) => {
    if (failAcceptedCheckpoint && state.batchIds.includes("batch-1")) {
      failAcceptedCheckpoint = false;
      throw new Error("FHIR checkpoint unavailable");
    }
    await saveState(state);
  };
  const client = stedi();

  await assert.rejects(runEligibilitySweepTick({ store, stedi: client, date: DATE, now: NOW }), /FHIR checkpoint unavailable/);
  assert.equal(client.submitted, 1);
  assert.equal(store.states.at(-1)?.status, "failed");
  assert.equal(store.states.at(-1)?.batchIds.length, 0);
  assert.equal(store.states.at(-1)?.inFlightTransactionIdentifiers?.length, 1);

  await runEligibilitySweepTick({ store, stedi: client, date: DATE, now: "2026-08-30T23:05:00.000Z" });
  assert.equal(client.submitted, 1);
  assert.equal(store.states.at(-1)?.status, "submitted");
  assert.deepEqual(store.states.at(-1)?.batchIds, ["batch-1"]);
  assert.equal(store.states.at(-1)?.inFlightTransactionIdentifiers, undefined);
});

test("an ambiguous batch remains pending without replay until Stedi exposes its result", async () => {
  const store = memoryStore();
  const saveState = store.saveState;
  let failAcceptedCheckpoint = true;
  store.saveState = async (state) => {
    if (failAcceptedCheckpoint && state.batchIds.includes("batch-1")) {
      failAcceptedCheckpoint = false;
      throw new Error("FHIR checkpoint unavailable");
    }
    await saveState(state);
  };
  let resultAvailable = false;
  const client = stedi({
    pollBatchEligibility: async () => resultAvailable
      ? {
        items: [{
          batchId: "batch-1",
          submitterTransactionIdentifier: candidate().eligibilityRequest.submitterTransactionIdentifier,
        }],
      }
      : { items: [] },
  });

  await assert.rejects(runEligibilitySweepTick({ store, stedi: client, date: DATE, now: NOW }), /FHIR checkpoint unavailable/);
  await runEligibilitySweepTick({ store, stedi: client, date: DATE, now: "2026-08-30T23:05:00.000Z" });
  assert.equal(client.submitted, 1);
  assert.equal(store.states.at(-1)?.status, "processing");
  assert.equal(store.states.at(-1)?.inFlightStartedAt, NOW);

  resultAvailable = true;
  await runEligibilitySweepTick({ store, stedi: client, date: DATE, now: "2026-08-30T23:10:00.000Z" });
  assert.equal(client.submitted, 1);
  assert.equal(store.states.at(-1)?.status, "submitted");
  assert.deepEqual(store.states.at(-1)?.batchIds, ["batch-1"]);
});

test("pending Insurance Discovery fails closed when its submitted snapshot is missing", async () => {
  const source = candidate();
  const store = memoryStore([source], false);
  const transactionId = source.eligibilityRequest.submitterTransactionIdentifier;
  const client = stedi({
    getBatchEligibilityItems: async () => ({
      items: [{
        state: "COMPLETED",
        eligibilityCheckResult: "FAILED",
        submitterTransactionIdentifier: transactionId,
        additionalInfo: { eligibility: { aaaErrors: [{ code: "72" }] } },
      }],
    }),
    pollBatchEligibility: async () => ({
      items: [{ submitterTransactionIdentifier: transactionId, aaaErrors: [{ code: "72" }] }],
    }),
    submitInsuranceDiscovery: async () => ({ status: "PENDING", discoveryId: "discovery-pending" }),
    getInsuranceDiscoveryResults: async () => ({
      status: "COMPLETE",
      discoveryId: "discovery-pending",
      items: [{ subscriber: { memberId: "DISCOVERED-789" } }],
    }),
  });

  await runEligibilitySweepTick({ store, stedi: client, date: DATE, now: NOW });
  await runEligibilitySweepTick({ store, stedi: client, date: DATE, now: "2026-08-30T23:05:00.000Z" });
  store.loadSubmittedCandidates = async () => undefined;
  await assert.rejects(
    runEligibilitySweepTick({ store, stedi: client, date: DATE, now: "2026-08-30T23:10:00.000Z" }),
    /submitted candidate snapshot is missing/,
  );
  assert.equal(store.findings.find((finding) => finding.watcherId === "W23")?.memberIdProposal, undefined);
  assert.equal(store.states.at(-1)?.status, "failed");
});

test("the worker does not overlap a slow eligibility sweep tick", async () => {
  let authenticateCalls = 0;
  let releaseAuthentication!: () => void;
  const authentication = new Promise<void>((resolve) => { releaseAuthentication = resolve; });
  const worker = startEligibilitySweepWorker({
    authenticate: async () => {
      authenticateCalls += 1;
      await authentication;
    },
    store: memoryStore([]),
    stedi: stedi(),
    timeZone: "America/New_York",
    intervalMs: 10,
    now: () => NOW,
  });

  await new Promise((resolve) => setTimeout(resolve, 35));
  worker.stop();
  releaseAuthentication();
  await authentication;

  assert.equal(authenticateCalls, 1);
});
