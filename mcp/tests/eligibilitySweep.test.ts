import assert from "node:assert/strict";
import { test } from "node:test";
import {
  runEligibilitySweepTick,
  type EligibilityCandidate,
  type EligibilityFinding,
  type EligibilitySweepState,
  type EligibilitySweepStore,
  type PreventiveStediClient,
} from "../src/jobs/eligibilitySweep.js";

const DATE = "2026-08-31";
const NOW = "2026-08-30T23:00:00.000Z";

function candidate(overrides: Partial<EligibilityCandidate> = {}): EligibilityCandidate {
  return {
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
}

function memoryStore(candidates = [candidate()], cloneCandidates = true): EligibilitySweepStore & {
  states: EligibilitySweepState[];
  findings: EligibilityFinding[];
} {
  const states: EligibilitySweepState[] = [];
  const findings: EligibilityFinding[] = [];
  return {
    states,
    findings,
    loadState: async () => states.at(-1),
    saveState: async (state) => { states.push(structuredClone(state)); },
    loadCandidates: async () => cloneCandidates ? structuredClone(candidates) : candidates,
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
