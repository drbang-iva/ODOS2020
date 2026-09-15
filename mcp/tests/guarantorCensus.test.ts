import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  collectGuarantorCensus,
  createReadOnlyGuarantorCensusFhir,
  executeGuarantorCensusCommand,
} from "../../scripts/guarantor-census.js";
import {
  CENSUS_PROJECT_A,
  CENSUS_SERVICE,
  CENSUS_TODAY,
  CensusFixtureFhir,
  aboveCeilingFixture,
  buildWriterDerivedCensusFixture,
  expectedRoleUrls,
} from "./helpers/guarantor-census-writer-fixture.js";

async function fixture() {
  const built = await buildWriterDerivedCensusFixture();
  assert.deepEqual(built.writerShapes.registrationRoleUrls, expectedRoleUrls());
  assert.equal(built.writerShapes.registrationPersonLinked, true);
  assert.equal(built.writerShapes.subscriberHasNoRole, true);
  assert.match(built.writerShapes.operationCodeSystem ?? "", /guarantor-link-operation$/);
  const transport = new CensusFixtureFhir(built);
  const fhir = createReadOnlyGuarantorCensusFhir(transport as never);
  return { built, transport, fhir };
}

test("G1 read-only facade refuses every write before transport and a full census emits zero writes", async () => {
  const { transport, fhir } = await fixture();
  for (const method of ["create", "createWithOutcome", "update", "patch", "executeTransaction", "executeTransactionAsActor", "delete", "deleteAttempt", "nullifyAttempt"] as const) {
    await assert.rejects(async () => (fhir[method] as (...args: never[]) => unknown)(), /guarantor-census is read-only/);
  }
  assert.equal(transport.requests.some(request => request.method !== "GET"), false);
  await collectGuarantorCensus(fhir, { today: CENSUS_TODAY, serviceReference: CENSUS_SERVICE });
  assert.equal(transport.requests.some(request => request.method !== "GET"), false);
});

test("G2 role classification excludes subscriber-only and includes a primary-only responsible party", async () => {
  const { fhir } = await fixture();
  const result = await collectGuarantorCensus(fhir, { today: CENSUS_TODAY, serviceReference: CENSUS_SERVICE });
  const project = result.summary.projects.find(row => row.project === "project-1")!;
  assert.equal(project.responsibleParties.total, 13);
  assert.equal(result.detail.some(row => row.resourceId === "subscriber-only" && row.bucket === "responsibleParty"), false);
  assert.equal(result.detail.some(row => row.resourceId === "rp-primary-only" && row.bucket === "responsibleParty"), true);
});

test("G3 ownership and claim states are exclusive and terminal claims are inert", async () => {
  const { fhir } = await fixture();
  const result = await collectGuarantorCensus(fhir, { today: CENSUS_TODAY, serviceReference: CENSUS_SERVICE });
  const counts = result.summary.projects.find(row => row.project === "project-1")!.responsibleParties;
  assert.deepEqual(counts, { total: 13, ownedByOnePerson: 1, unowned: 11, ownedByMultiplePersons: 1, withActiveClaim: 1, withInertClaim: 1 });
  assert.equal(counts.ownedByOnePerson + counts.unowned + counts.ownedByMultiplePersons, counts.total);
  assert.equal(result.detail.find(row => row.resourceId === "rp-active-claim")?.claimState, "active");
  assert.equal(result.detail.find(row => row.resourceId === "rp-inert-claim")?.claimState, "inert");
});

test("G4 failed attach, undone attach, and pre-G-1 unowned records remain distinct", async () => {
  const { fhir } = await fixture();
  const result = await collectGuarantorCensus(fhir, { today: CENSUS_TODAY, serviceReference: CENSUS_SERVICE });
  const latest = result.summary.projects.find(row => row.project === "project-1")!.unowned.latestGuarantorOperation;
  assert.deepEqual(latest, { failedAttach: 1, undoneAttach: 1, none: 9 });
  assert.equal(result.detail.find(row => row.resourceId === "rp-failed")?.latestOperation, "failedAttach");
  assert.equal(result.detail.find(row => row.resourceId === "rp-pre-g1")?.latestOperation, "none");
});

test("G5 insurance census counts only responsible-party subscribers and flags a non-service address change as suspected", async () => {
  const { fhir } = await fixture();
  const result = await collectGuarantorCensus(fhir, { today: CENSUS_TODAY, serviceReference: CENSUS_SERVICE });
  const insurance = result.summary.projects.find(row => row.project === "project-1")!.insuranceDamage;
  assert.deepEqual(insurance, {
    coverageCount: 3,
    subscriberRelatedPersonReferences: 3,
    subscriberRefsToResponsibleParties: 1,
    ofThoseActiveFalse: 1,
    unreadableSubscriberReferences: 1,
    historyVersionsExamined: 2,
    suspectedOverwrites: 1,
  });
  const damaged = result.detail.find(row => row.resourceId === "rp-damaged")!;
  assert.deepEqual(damaged.coverageIds, ["coverage-guardian"]);
  assert.deepEqual(damaged.changedHistoryVersionIds, ["2"]);
  assert.equal(result.detail.find(row => row.resourceId === "subscriber-only")?.suspectedInsuranceOverwrite, undefined);
});

test("G6 exact normalized name and US phone create candidate groups without linking anything", async () => {
  const { fhir, transport } = await fixture();
  const result = await collectGuarantorCensus(fhir, { today: CENSUS_TODAY, serviceReference: CENSUS_SERVICE });
  const duplicates = result.summary.projects.find(row => row.project === "project-1")!.duplicateCandidates;
  assert.deepEqual(duplicates, { groups: 1, recordsInGroups: 2, sizeHistogram: { "2": 1, "3": 0, "4+": 0 } });
  assert.equal(result.detail.find(row => row.resourceId === "rp-duplicate-a")?.duplicateGroupId, result.detail.find(row => row.resourceId === "rp-duplicate-b")?.duplicateGroupId);
  assert.notEqual(result.detail.find(row => row.resourceId === "rp-duplicate-a")?.duplicateGroupId, result.detail.find(row => row.resourceId === "rp-different-phone")?.duplicateGroupId);
  assert.equal(transport.requests.some(request => request.method !== "GET"), false);
});

test("G7 exceeding the 50000-row ceiling exits 2 without printing a partial summary", async () => {
  const transport = aboveCeilingFixture();
  const output: string[] = [];
  const errors: string[] = [];
  const exitCode = await executeGuarantorCensusCommand({
    args: [], fhir: createReadOnlyGuarantorCensusFhir(transport as never), today: CENSUS_TODAY,
    serviceReference: CENSUS_SERVICE, checkoutRoots: [resolve(".")], stdout: value => output.push(value), stderr: value => errors.push(value),
  });
  assert.equal(exitCode, 2);
  assert.deepEqual(output, []);
  assert.match(errors.join("\n"), /exceeded 50000 rows/);
});

test("G8 summary is de-identified and detail output is absolute, outside checkouts, exclusive, and mode 0600", async () => {
  const { built, fhir } = await fixture();
  const checkout = resolve(".");
  const output: string[] = [];
  assert.equal(await executeGuarantorCensusCommand({ args: [], fhir, today: CENSUS_TODAY, serviceReference: CENSUS_SERVICE, checkoutRoots: [checkout], stdout: value => output.push(value), stderr: () => undefined }), 0);
  const summary = output.join("\n");
  for (const secret of ["Taylor", "+1 (864) 555-0133", "9 Changed Way", "rp-damaged", CENSUS_PROJECT_A]) assert.doesNotMatch(summary, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const inside = join(checkout, ".odos", "forbidden-detail.ndjson");
  assert.equal(await executeGuarantorCensusCommand({ args: ["--detail", inside], fhir, today: CENSUS_TODAY, serviceReference: CENSUS_SERVICE, checkoutRoots: [checkout], stdout: () => undefined, stderr: () => undefined }), 1);

  const directory = await mkdtemp(join(tmpdir(), "guarantor-census-test-"));
  const existing = join(directory, "existing.ndjson");
  await writeFile(existing, "keep", { mode: 0o600 });
  assert.equal(await executeGuarantorCensusCommand({ args: ["--detail", existing], fhir, today: CENSUS_TODAY, serviceReference: CENSUS_SERVICE, checkoutRoots: [checkout], stdout: () => undefined, stderr: () => undefined }), 1);
  assert.equal(await readFile(existing, "utf8"), "keep");

  const detailPath = join(directory, "detail.ndjson");
  assert.equal(await executeGuarantorCensusCommand({ args: ["--detail", detailPath], fhir, today: CENSUS_TODAY, serviceReference: CENSUS_SERVICE, checkoutRoots: [checkout], stdout: () => undefined, stderr: () => undefined }), 0);
  assert.equal((await stat(detailPath)).mode & 0o777, 0o600);
  const detail = await readFile(detailPath, "utf8");
  assert.match(detail, /rp-damaged/);
  assert.equal(detail.trim().split("\n").length, built.resources.filter(resource => resource.resourceType === "RelatedPerson" || resource.resourceType === "Person").length + 1);
});

test("G9 a foreign-project Person is counted as cross-project and never owns the local responsible party", async () => {
  const { fhir } = await fixture();
  const result = await collectGuarantorCensus(fhir, { today: CENSUS_TODAY, serviceReference: CENSUS_SERVICE });
  const local = result.summary.projects.find(row => row.project === "project-1")!;
  assert.equal(local.crossProject, 1);
  const cross = result.detail.find(row => row.resourceId === "rp-cross")!;
  assert.equal(cross.ownership, "unowned");
  assert.equal(cross.crossProject, true);
});

test("C2 Person counters distinguish valid, missing, and non-RelatedPerson links", async () => {
  const { fhir } = await fixture();
  const result = await collectGuarantorCensus(fhir, { today: CENSUS_TODAY, serviceReference: CENSUS_SERVICE });
  assert.deepEqual(result.summary.projects.find(row => row.project === "project-1")!.persons, {
    total: 6,
    linked: 3,
    zeroLinkActive: 1,
    inactive: 1,
    linksToMissingRelatedPerson: 1,
    linksToNonRelatedPerson: 1,
  });
});

test("insurance history follows an exact instance-level history next link", async () => {
  const built = await buildWriterDerivedCensusFixture();
  const current = built.rows.damaged;
  const history = Array.from({ length: 101 }, (_, index) => ({
    ...current,
    meta: { ...current.meta, versionId: String(101 - index), author: { reference: CENSUS_SERVICE } },
  }));
  built.histories = [[`RelatedPerson/${current.id}`, history]];
  const transport = new CensusFixtureFhir(built);
  const result = await collectGuarantorCensus(createReadOnlyGuarantorCensusFhir(transport), {
    today: CENSUS_TODAY,
    serviceReference: CENSUS_SERVICE,
  });
  assert.equal(result.summary.projects.find(row => row.project === "project-1")!.insuranceDamage.historyVersionsExamined, 101);
  assert.equal(transport.requests.some(request => request.target === `/fhir/R4/RelatedPerson/${current.id}/_history?_count=100&_offset=100`), true);
});

test("history ceiling counts entries without resources", async () => {
  const built = await buildWriterDerivedCensusFixture();
  const transport = new CensusFixtureFhir(built);
  transport.history = (async () => ({
    resourceType: "Bundle",
    type: "history",
    entry: Array.from({ length: 50_001 }, () => ({})),
  } as never)) as CensusFixtureFhir["history"];
  await assert.rejects(
    collectGuarantorCensus(createReadOnlyGuarantorCensusFhir(transport), {
      today: CENSUS_TODAY,
      serviceReference: CENSUS_SERVICE,
    }),
    /exceeded 50000 rows/,
  );
});

test("duplicate links from one Person count as one owner", async () => {
  const built = await buildWriterDerivedCensusFixture();
  const owner = built.resources.find(resource => resource.resourceType === "Person" && resource.id === "person-owner");
  assert(owner?.link?.[0]);
  owner.link.push(JSON.parse(JSON.stringify(owner.link[0])));
  const result = await collectGuarantorCensus(
    createReadOnlyGuarantorCensusFhir(new CensusFixtureFhir(built)),
    { today: CENSUS_TODAY, serviceReference: CENSUS_SERVICE },
  );
  assert.equal(result.detail.find(row => row.resourceId === "rp-owned")?.ownership, "ownedByOnePerson");
});
