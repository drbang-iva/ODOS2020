import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type {
  Basic,
  Bundle,
  CarePlan,
  Encounter,
  Observation,
  Organization,
  Patient,
  Practitioner,
  PractitionerRole,
  ProjectMembership,
  Provenance,
  Resource,
  ServiceRequest,
} from "@medplum/fhirtypes";
import express from "express";
import type { FhirSearchParams } from "../src/fhir-client.js";
import {
  handleCreateReferralRequest,
  handleReferralArtifactRequest,
  handleRecentReferralConsultantsRequest,
  handleRegenerateReferralLetterRequest,
  handleReadReferralDefaultsRequest,
  handleSearchReferralConsultantsRequest,
  handleSaveReferralDefaultsRequest,
  handleUpdateReferralDraftRequest,
  type ReferralEndpointDeps,
} from "../src/referral/referral-endpoint.js";
import { registerReferralRoutes } from "../src/referral/referral-routes.js";
import {
  buildReferralDefaultsResource,
  ReferralDefaultsStore,
  SYSTEM_REFERRAL_INCLUDE_DEFAULTS,
} from "../src/referral/referral-defaults-store.js";
import {
  buildReferralServiceRequest,
  readReferralIncludeList,
  REFERRAL_LETTER_BODY_EXTENSION_URL,
  type ReferralFhirClient,
  type ReferralIncludeList,
} from "../src/referral/referral-service.js";

const AUTH = "Bearer clinician";
const NOW = "2026-07-18T16:00:00.000Z";
const INCLUDE_LIST: ReferralIncludeList = {
  letter: true,
  demographics: false,
  history: true,
  clinical_summary: false,
  images: false,
  hipaa_cover_sheet: false,
  history_count: 2,
};
const CREATE_BODY = {
  targetReference: "Organization/retina-1",
  encounterReference: "Encounter/current",
  includeList: INCLUDE_LIST,
  priority: "urgent",
  reasonText: "New central distortion",
};

test("referral endpoint fails closed for unauthenticated, non-chart-write, and out-of-compartment callers", async () => {
  const fhir = seededFhir();
  const forbiddenAuth = "Bearer front-desk-denied";
  const outsideCompartmentAuth = "Bearer compartment-denied";
  const unauthenticated = await handleCreateReferralRequest(deps(fhir, { authenticated: false }), {
    authHeader: undefined,
    patientId: "p1",
    body: CREATE_BODY,
  });
  const forbidden = await handleCreateReferralRequest(deps(fhir, {
    role: "front-desk",
    authToken: forbiddenAuth,
    staffReference: "Practitioner/front-desk-denied",
  }), {
    authHeader: forbiddenAuth,
    patientId: "p1",
    body: CREATE_BODY,
  });
  const outsideCompartment = await handleReferralArtifactRequest(deps(fhir, {
    authToken: outsideCompartmentAuth,
    staffReference: "Practitioner/compartment-denied",
    patientGrant: "Patient/other",
  }), {
    authHeader: outsideCompartmentAuth,
    patientId: "p1",
    referralId: "referral-1",
    action: "preview",
    body: {},
  });

  assert.equal(unauthenticated.status, 401);
  assert.equal(forbidden.status, 403);
  assert.equal(outsideCompartment.status, 403);
  assert.equal(fhir.created.length, 0);
  assert.equal(fhir.readKeys.length, 0);
});

test("referral creation derives requester from the authenticated clinician", async () => {
  const fhir = seededFhir();
  const result = await handleCreateReferralRequest(deps(fhir), {
    authHeader: AUTH,
    patientId: "p1",
    body: CREATE_BODY,
  });

  assert.equal(result.status, 201);
  const serviceRequest = (result.body as { serviceRequest: ServiceRequest }).serviceRequest;
  assert.equal(serviceRequest.requester?.reference, "Practitioner/clinician-1");
  assert.equal(serviceRequest.subject.reference, "Patient/p1");
  assert.equal(serviceRequest.status, "draft");
  assert.equal(serviceRequest.priority, "urgent");
  assert.deepEqual(serviceRequest.reasonCode, [{ text: "New central distortion" }]);
  assert.equal((result.body as { serviceRequestReference: string }).serviceRequestReference, `ServiceRequest/${serviceRequest.id}`);
});

test("referral creation rejects unsupported priority and blank reason text", async () => {
  const fhir = seededFhir();
  const invalidPriority = await handleCreateReferralRequest(deps(fhir), {
    authHeader: AUTH,
    patientId: "p1",
    body: { ...CREATE_BODY, priority: "asap" },
  });
  const blankReason = await handleCreateReferralRequest(deps(fhir), {
    authHeader: AUTH,
    patientId: "p1",
    body: { ...CREATE_BODY, reasonText: "   " },
  });

  assert.equal(invalidPriority.status, 400);
  assert.equal(blankReason.status, 400);
});

test("consultant search spans Practitioner, PractitionerRole, and Organization while short queries stay write-free", async () => {
  const fhir = seededFhir();
  fhir.put({
    resourceType: "Practitioner",
    id: "vision-specialist",
    name: [{ text: "Dr. Vera Vision" }],
  } satisfies Practitioner);
  fhir.put({
    resourceType: "PractitionerRole",
    id: "vision-role",
    practitioner: { reference: "Practitioner/vision-specialist", display: "Dr. Vera Vision" },
    specialty: [{ text: "Vision rehabilitation" }],
  } satisfies PractitionerRole);
  fhir.put({
    resourceType: "Organization",
    id: "vision-group",
    name: "Vision Retina Group",
  } satisfies Organization);

  const beforeShortQuery = fhir.searchCalls.length;
  const short = await handleSearchReferralConsultantsRequest(deps(fhir), {
    authHeader: AUTH,
    query: "v",
  });
  const afterShortQuery = fhir.searchCalls.length;
  const found = await handleSearchReferralConsultantsRequest(deps(fhir), {
    authHeader: AUTH,
    query: "vision",
  });

  assert.deepEqual((short.body as { consultants: unknown[] }).consultants, []);
  assert.equal(afterShortQuery, beforeShortQuery);
  assert.equal(fhir.searchCalls.length, beforeShortQuery + 3);
  assert.deepEqual(
    (found.body as { consultants: Array<{ reference: string }> }).consultants.map((row) => row.reference),
    [
      "Practitioner/vision-specialist",
      "PractitionerRole/vision-role",
      "Organization/vision-group",
    ],
  );
  assert.deepEqual(fhir.searchCalls.slice(-3).map((call) => call.params), [
    { "name:contains": "vision", _count: "20" },
    { "practitioner.name:contains": "vision", _count: "20" },
    { "name:contains": "vision", _count: "20" },
  ]);
});

test("recent consultants are requester-scoped, distinct, and newest first", async () => {
  const fhir = seededFhir();
  fhir.put(referralForRequester(
    "own-newest",
    "Practitioner/clinician-1",
    "Organization/newest",
    "Newest Retina",
    "2026-07-18T18:00:00.000Z",
  ));
  fhir.put(referralForRequester(
    "own-older",
    "Practitioner/clinician-1",
    "Practitioner/older",
    "Older Consultant",
    "2026-07-17T18:00:00.000Z",
  ));
  fhir.put(referralForRequester(
    "own-duplicate",
    "Practitioner/clinician-1",
    "Organization/newest",
    "Newest Retina",
    "2026-07-16T18:00:00.000Z",
  ));
  fhir.put(referralForRequester(
    "other-provider",
    "Practitioner/clinician-2",
    "Organization/private",
    "Other Provider Consultant",
    "2026-07-19T18:00:00.000Z",
  ));
  fhir.put({
    resourceType: "ServiceRequest",
    id: "own-non-referral-plan",
    status: "active",
    intent: "plan",
    code: { text: "Glaucoma workup" },
    subject: { reference: "Patient/p1" },
    requester: { reference: "Practitioner/clinician-1" },
    performer: [{ reference: "Organization/protocol-performer", display: "Protocol Performer" }],
    authoredOn: "2026-07-20T18:00:00.000Z",
  } satisfies ServiceRequest);

  const result = await handleRecentReferralConsultantsRequest(deps(fhir), { authHeader: AUTH });

  assert.equal(result.status, 200);
  assert.deepEqual((result.body as { consultants: unknown[] }).consultants, [
    { reference: "Organization/newest", display: "Newest Retina" },
    { reference: "Organization/retina-1", display: "Retina Associates" },
    { reference: "Practitioner/older", display: "Older Consultant" },
  ]);
  assert.deepEqual(fhir.searchCalls.at(-1)?.params, {
    requester: "Practitioner/clinician-1",
    _sort: "-authored",
    _count: "20",
  });
});

test("draft update persists each supported field and rejects active or stale mutations", async () => {
  const fhir = seededFhir();
  fhir.put({ resourceType: "Organization", id: "retina-2", name: "Macula Center" } satisfies Organization);
  const nextIncludeList = { ...INCLUDE_LIST, images: true, history_count: 4 };
  const common = { authHeader: AUTH, patientId: "p1", referralId: "referral-1" };

  for (const body of [
    { targetReference: "Organization/retina-2" },
    { includeList: nextIncludeList },
    { priority: "stat" },
    { reasonText: "Acute metamorphopsia" },
    { letterBody: "Please evaluate the acute metamorphopsia." },
  ]) {
    const result = await handleUpdateReferralDraftRequest(deps(fhir), { ...common, body });
    assert.equal(result.status, 200);
  }
  const updated = await fhir.read<ServiceRequest>("ServiceRequest", "referral-1");
  assert.deepEqual(updated.performer, [{ reference: "Organization/retina-2", display: "Macula Center" }]);
  assert.deepEqual(readReferralIncludeList(updated), nextIncludeList);
  assert.equal(updated.priority, "stat");
  assert.deepEqual(updated.reasonCode, [{ text: "Acute metamorphopsia" }]);
  assert.equal(referralLetterBody(updated), "Please evaluate the acute metamorphopsia.");

  const cleared = await handleUpdateReferralDraftRequest(deps(fhir), {
    ...common,
    body: { reasonText: null },
  });
  assert.equal(cleared.status, 200);
  assert.equal((cleared.body as { serviceRequest: ServiceRequest }).serviceRequest.reasonCode, undefined);

  const reset = await handleUpdateReferralDraftRequest(deps(fhir), {
    ...common,
    body: { reasonText: "  Persistent diplopia  " },
  });
  assert.equal(reset.status, 200);
  const omitted = await handleUpdateReferralDraftRequest(deps(fhir), {
    ...common,
    body: { priority: "routine" },
  });
  assert.deepEqual(
    (omitted.body as { serviceRequest: ServiceRequest }).serviceRequest.reasonCode,
    [{ text: "Persistent diplopia" }],
  );

  const latest = (omitted.body as { serviceRequest: ServiceRequest }).serviceRequest;
  fhir.put({ ...latest, status: "active" });
  const beforeActiveAttempt = await fhir.read<ServiceRequest>("ServiceRequest", "referral-1");
  const active = await handleUpdateReferralDraftRequest(deps(fhir), {
    ...common,
    body: { priority: "routine" },
  });
  assert.equal(active.status, 409);
  assert.deepEqual(await fhir.read<ServiceRequest>("ServiceRequest", "referral-1"), beforeActiveAttempt);

  fhir.put({ ...latest, status: "draft" });
  fhir.failNextUpdate(412);
  const stale = await handleUpdateReferralDraftRequest(deps(fhir), {
    ...common,
    body: { priority: "urgent" },
  });
  assert.equal(stale.status, 409);
  assert.equal((await fhir.read<ServiceRequest>("ServiceRequest", "referral-1")).priority, "routine");
});

test("regeneration uses the current consultant and fresh encounter findings without changing active or stale referrals", async () => {
  const fhir = seededFhir();
  fhir.put({ resourceType: "Organization", id: "retina-2", name: "Macula Center" } satisfies Organization);
  fhir.put({
    resourceType: "Observation",
    id: "finding-1",
    status: "final",
    code: { text: "Macular finding" },
    subject: { reference: "Patient/p1" },
    encounter: { reference: "Encounter/current" },
    valueString: "Fresh distortion",
  } satisfies Observation);
  fhir.put({
    resourceType: "CarePlan",
    id: "plan-1",
    status: "active",
    intent: "plan",
    subject: { reference: "Patient/p1" },
    encounter: { reference: "Encounter/current" },
    activity: [{ detail: { status: "not-started", description: "Urgent retina review" } }],
  } satisfies CarePlan);
  const common = { authHeader: AUTH, patientId: "p1", referralId: "referral-1" };
  await handleUpdateReferralDraftRequest(deps(fhir), {
    ...common,
    body: { targetReference: "Organization/retina-2" },
  });

  const regenerated = await handleRegenerateReferralLetterRequest(deps(fhir), common);
  assert.equal(regenerated.status, 200);
  const fresh = (regenerated.body as { serviceRequest: ServiceRequest }).serviceRequest;
  assert.match(referralLetterBody(fresh) ?? "", /^Dear Macula Center,/);
  assert.match(referralLetterBody(fresh) ?? "", /Macular finding: Fresh distortion/);
  assert.match(referralLetterBody(fresh) ?? "", /Urgent retina review/);

  fhir.put({ ...fresh, status: "active" });
  const active = await handleRegenerateReferralLetterRequest(deps(fhir), common);
  assert.equal(active.status, 409);
  assert.equal(referralLetterBody(await fhir.read<ServiceRequest>("ServiceRequest", "referral-1")), referralLetterBody(fresh));

  fhir.put({ ...fresh, status: "draft" });
  fhir.failNextUpdate(412);
  const stale = await handleRegenerateReferralLetterRequest(deps(fhir), common);
  assert.equal(stale.status, 409);
  assert.equal(referralLetterBody(await fhir.read<ServiceRequest>("ServiceRequest", "referral-1")), referralLetterBody(fresh));
});

test("each rendered preview is archived while send records one clinician-attributed disclosure Provenance", async () => {
  const fhir = seededFhir();
  const endpointDeps = deps(fhir);
  const previewLetter = "Preview-only edited body";
  const sentLetter = "Clinician edited words actually sent";
  const previewInput = {
    authHeader: AUTH,
    patientId: "p1",
    referralId: "referral-1",
    action: "preview" as const,
    body: { editedLetterBody: previewLetter },
  };

  const firstPreview = await handleReferralArtifactRequest(endpointDeps, previewInput);
  const secondPreview = await handleReferralArtifactRequest(endpointDeps, previewInput);
  assert.equal(firstPreview.status, 200);
  assert.equal(secondPreview.status, 200);
  assert.equal(fhir.provenances.length, 0);
  assert.equal(fhir.readKeys.filter((key) => key === "ServiceRequest/referral-1").length, 2);
  assert.equal(fhir.resources("DocumentReference").length, 2);
  const afterPreviews = await fhir.read<ServiceRequest>("ServiceRequest", "referral-1");
  assert.equal(afterPreviews.status, "draft");
  assert.equal(referralLetterBody(afterPreviews), "Please evaluate this patient.");

  const sent = await handleReferralArtifactRequest(endpointDeps, {
    ...previewInput,
    action: "send",
    body: { editedLetterBody: sentLetter },
  });
  assert.equal(sent.status, 200);
  assert.equal(fhir.provenances.length, 1);
  const afterSend = await fhir.read<ServiceRequest>("ServiceRequest", "referral-1");
  assert.equal(afterSend.status, "active");
  assert.equal(referralLetterBody(afterSend), sentLetter);
  const sentPdf = Buffer.from(
    (sent.body as { pdfBase64: string }).pdfBase64,
    "base64",
  ).toString();
  assert.match(sentPdf, /Clinician edited words actually sent/);
  assert.doesNotMatch(sentPdf, /Preview-only edited body/);
  const provenance = fhir.provenances[0];
  assert.equal(provenance.target[0]?.reference, "ServiceRequest/referral-1");
  assert.match(provenance.target[1]?.reference ?? "", /^DocumentReference\//);
  assert.equal(provenance.agent[0]?.who.reference, "Practitioner/clinician-1");
  assert.equal(provenance.agent[0]?.type?.coding?.[0]?.code, "transmitter");
  assert.equal(provenance.activity?.coding?.[0]?.system, "http://terminology.hl7.org/CodeSystem/v3-DataOperation");
  assert.equal(provenance.activity?.coding?.[0]?.code, "READ");
  assert.equal(provenance.activity?.coding?.[0]?.display, "Disclose referral");
  assert.deepEqual(provenance.entity?.map((entity) => entity.what.display), [
    "Referral include-list flag: letter",
    "Referral include-list flag: history",
    "Referral history_count: 2",
  ]);
  assert.equal((sent.body as { provenanceReference: string }).provenanceReference, `Provenance/${provenance.id}`);

  const duplicateSend = await handleReferralArtifactRequest(endpointDeps, {
    ...previewInput,
    action: "send",
    body: { editedLetterBody: "Overwriting retry" },
  });
  assert.equal(duplicateSend.status, 409);
  assert.equal(fhir.provenances.length, 1);
  assert.equal(referralLetterBody(await fhir.read<ServiceRequest>("ServiceRequest", "referral-1")), sentLetter);
});

test("failed artifact assembly leaves the edited referral draft and creates no Provenance", async () => {
  const fhir = seededFhir();
  fhir.failNextSearch("Encounter");

  await assert.rejects(handleReferralArtifactRequest(deps(fhir), {
    authHeader: AUTH,
    patientId: "p1",
    referralId: "referral-1",
    action: "send",
    body: { editedLetterBody: "Edited draft before failed assembly" },
  }), /Simulated Encounter search failure/);

  const persisted = await fhir.read<ServiceRequest>("ServiceRequest", "referral-1");
  assert.equal(persisted.status, "draft");
  assert.equal(referralLetterBody(persisted), "Edited draft before failed assembly");
  assert.equal(fhir.provenances.length, 0);
});

test("stale final send transaction returns conflict without activation or Provenance", async () => {
  const fhir = seededFhir();
  fhir.failNextTransaction(412);

  const result = await handleReferralArtifactRequest(deps(fhir), {
    authHeader: AUTH,
    patientId: "p1",
    referralId: "referral-1",
    action: "send",
    body: { editedLetterBody: "Edited draft before stale commit" },
  });

  assert.equal(result.status, 409);
  const persisted = await fhir.read<ServiceRequest>("ServiceRequest", "referral-1");
  assert.equal(persisted.status, "draft");
  assert.equal(referralLetterBody(persisted), "Edited draft before stale commit");
  assert.equal(fhir.provenances.length, 0);
});

test("preview rejects a referral whose subject does not match the compartment-scoped route patient", async () => {
  const fhir = seededFhir();
  fhir.put(referral("wrong-patient", "Patient/other"));

  const result = await handleReferralArtifactRequest(deps(fhir), {
    authHeader: AUTH,
    patientId: "p1",
    referralId: "wrong-patient",
    action: "preview",
    body: {},
  });

  assert.equal(result.status, 409);
  assert.equal(fhir.provenances.length, 0);
});

test("referral defaults return system values for an unsaved provider and round-trip per provider", async () => {
  const fhir = seededFhir();
  const clinicianOneDeps = deps(fhir);
  const unsaved = await handleReadReferralDefaultsRequest(clinicianOneDeps, { authHeader: AUTH });
  assert.equal(unsaved.status, 200);
  assert.deepEqual(
    (unsaved.body as { includeList: ReferralIncludeList }).includeList,
    SYSTEM_REFERRAL_INCLUDE_DEFAULTS,
  );

  const savedDefaults: ReferralIncludeList = {
    letter: true,
    demographics: false,
    history: false,
    clinical_summary: true,
    images: true,
    hipaa_cover_sheet: true,
    history_count: 7,
  };
  const saved = await handleSaveReferralDefaultsRequest(clinicianOneDeps, {
    authHeader: AUTH,
    body: { includeList: savedDefaults },
  });
  const resaved = await handleSaveReferralDefaultsRequest(clinicianOneDeps, {
    authHeader: AUTH,
    body: { includeList: savedDefaults },
  });
  const reread = await handleReadReferralDefaultsRequest(clinicianOneDeps, { authHeader: AUTH });
  const clinicianTwo = await handleReadReferralDefaultsRequest(deps(fhir, {
    staffReference: "Practitioner/clinician-2",
  }), { authHeader: AUTH });

  assert.equal(saved.status, 200);
  assert.equal(resaved.status, 200);
  assert.deepEqual((saved.body as { includeList: ReferralIncludeList }).includeList, savedDefaults);
  assert.deepEqual((reread.body as { includeList: ReferralIncludeList }).includeList, savedDefaults);
  assert.deepEqual(
    (clinicianTwo.body as { includeList: ReferralIncludeList }).includeList,
    SYSTEM_REFERRAL_INCLUDE_DEFAULTS,
  );
  const basics = fhir.resources("Basic") as Basic[];
  assert.equal(basics.length, 1);
  assert.equal(basics[0]?.code?.text, "referral-include-defaults");
  assert.equal(basics[0]?.identifier?.[0]?.value, "Practitioner/clinician-1");
});

test("referral defaults require authentication and chart.write", async () => {
  const fhir = seededFhir();
  const unauthenticated = await handleReadReferralDefaultsRequest(
    deps(fhir, { authenticated: false }),
    { authHeader: undefined },
  );
  const forbiddenAuth = "Bearer front-desk-denied";
  const forbidden = await handleSaveReferralDefaultsRequest(deps(fhir, {
    role: "front-desk",
    authToken: forbiddenAuth,
    staffReference: "Practitioner/front-desk-denied",
  }), {
    authHeader: forbiddenAuth,
    body: { includeList: INCLUDE_LIST },
  });

  assert.equal(unauthenticated.status, 401);
  assert.equal(forbidden.status, 403);
  assert.equal(fhir.resources("Basic").length, 0);
});

test("referral defaults complete a save when conditional create finds a concurrent resource", async () => {
  const fhir = seededFhir();
  const providerReference = "Practitioner/clinician-1";
  fhir.put({
    ...buildReferralDefaultsResource(providerReference, SYSTEM_REFERRAL_INCLUDE_DEFAULTS),
    id: "concurrent-defaults",
  });
  fhir.hideNextBasicSearch();
  const requested: ReferralIncludeList = {
    ...SYSTEM_REFERRAL_INCLUDE_DEFAULTS,
    images: true,
    history_count: 5,
  };

  const saved = await new ReferralDefaultsStore(fhir).save(providerReference, requested);

  assert.deepEqual(saved, requested);
  assert.equal(fhir.resources("Basic").length, 1);
  assert.equal(fhir.resources("Basic")[0]?.id, "concurrent-defaults");
});

test("registered HTTP routes expose templates, draft mutation, apply, preview, and send actions", async () => {
  const fhir = seededFhir();
  let serviceAuthCalls = 0;
  const app = express();
  app.use(express.json());
  registerReferralRoutes(app, {
    ...deps(fhir),
    authenticateService: async () => { serviceAuthCalls += 1; },
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    listener.once("listening", resolve);
    listener.once("error", reject);
  });
  const { port } = listener.address() as AddressInfo;
  const headers = { Authorization: AUTH, "Content-Type": "application/json" };

  try {
    const templates = await fetch(
      `http://127.0.0.1:${port}/correspondence/templates?letterType=referral`,
      { headers },
    );
    const readDefaults = await fetch(`http://127.0.0.1:${port}/referrals/defaults`, { headers });
    const saveDefaults = await fetch(`http://127.0.0.1:${port}/referrals/defaults`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ includeList: INCLUDE_LIST }),
    });
    const created = await fetch(`http://127.0.0.1:${port}/referrals/patients/p1`, {
      method: "POST",
      headers,
      body: JSON.stringify(CREATE_BODY),
    });
    const consultants = await fetch(`http://127.0.0.1:${port}/referrals/consultants?q=retina`, { headers });
    const recent = await fetch(`http://127.0.0.1:${port}/referrals/consultants/recent`, { headers });
    const updated = await fetch(`http://127.0.0.1:${port}/referrals/patients/p1/referral-1`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ priority: "urgent" }),
    });
    const regenerated = await fetch(`http://127.0.0.1:${port}/referrals/patients/p1/referral-1/regenerate`, {
      method: "POST",
      headers,
      body: "{}",
    });
    const applied = await fetch(
      `http://127.0.0.1:${port}/referrals/patients/p1/referral-1/apply-template`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ templateId: "starter-referral-1" }),
      },
    );
    const previewed = await fetch(`http://127.0.0.1:${port}/referrals/patients/p1/referral-1/preview`, {
      method: "POST",
      headers,
      body: "{}",
    });
    const sent = await fetch(`http://127.0.0.1:${port}/referrals/patients/p1/referral-1/send`, {
      method: "POST",
      headers,
      body: "{}",
    });

    assert.equal(templates.status, 200);
    assert.equal(readDefaults.status, 200);
    assert.equal(saveDefaults.status, 200);
    assert.equal(created.status, 201);
    assert.equal(consultants.status, 200);
    assert.equal(recent.status, 200);
    assert.equal(updated.status, 200);
    assert.equal(regenerated.status, 200);
    assert.equal(applied.status, 200);
    assert.equal(previewed.status, 200);
    assert.equal(sent.status, 200);
    assert.equal(serviceAuthCalls, 11);
    assert.equal(fhir.provenances.length, 1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => error ? reject(error) : resolve()));
  }
});

function deps(
  fhir: MemoryReferralFhir,
  options: {
    authenticated?: boolean;
    role?: "clinician" | "front-desk";
    authToken?: string;
    staffReference?: string;
    patientGrant?: string;
  } = {},
): ReferralEndpointDeps {
  const authenticated = options.authenticated ?? true;
  const role = options.role ?? "clinician";
  const authToken = options.authToken ?? AUTH;
  const staffReference = options.staffReference ?? "Practitioner/clinician-1";
  const patientGrant = options.patientGrant ?? "Patient/p1";
  return {
    authenticate: async (header) => authenticated && header === authToken
      ? { staffReference, actorRole: role, fhir }
      : null,
    serviceFhir: {
      read: <T extends Resource>(resourceType: T["resourceType"], id: string) =>
        fhir.read<T>(resourceType, id),
      search: async <T extends Resource>(
        resourceType: T["resourceType"],
        params: FhirSearchParams = {},
      ): Promise<Bundle<T>> => {
        if (resourceType !== "ProjectMembership") return fhir.search<T>(resourceType, params);
        const membership: ProjectMembership = {
          resourceType: "ProjectMembership",
          id: "membership-1",
          project: { reference: "Project/project-1" },
          profile: { reference: staffReference },
          access: [{
            parameter: [{ name: "patient_compartment", valueString: patientGrant }],
          }],
        };
        return { resourceType: "Bundle", type: "searchset", entry: [{ resource: membership as T }] };
      },
      searchUrl: async <T extends Resource>(): Promise<Bundle<T>> => ({
        resourceType: "Bundle",
        type: "searchset",
        entry: [],
      }),
      create: <T extends Resource>(resource: T, headers?: Record<string, string>) =>
        fhir.create(resource, headers),
      update: <T extends Resource>(
        resourceType: T["resourceType"],
        id: string,
        resource: T,
        headers?: Record<string, string>,
      ) => fhir.update(resourceType, id, resource, headers),
    },
    correspondenceRenderer: {
      name: "Synthetic WeasyPrint 69.0",
      pdfVariant: "pdf/a-3u",
      render: async (html: string) => Buffer.from(`%PDF-1.7\n${html}`),
    },
    now: () => NOW,
  };
}

class MemoryReferralFhir implements ReferralFhirClient {
  private readonly rows = new Map<string, Resource>();
  private sequence = 0;
  private hiddenBasicSearches = 0;
  private failedSearchResourceType: Resource["resourceType"] | undefined;
  private failedTransactionStatus: 409 | 412 | undefined;
  private failedUpdateStatus: 409 | 412 | undefined;
  readonly created: Resource[] = [];
  readonly provenances: Provenance[] = [];
  readonly readKeys: string[] = [];
  readonly searchCalls: Array<{ resourceType: string; params: Record<string, string> }> = [];

  put(resource: Resource): void {
    if (!resource.id) throw new Error("Seeded resources require an id.");
    this.rows.set(`${resource.resourceType}/${resource.id}`, structuredClone({
      ...resource,
      meta: { ...resource.meta, versionId: resource.meta?.versionId ?? "1" },
    }));
  }

  hideNextBasicSearch(): void {
    this.hiddenBasicSearches += 1;
  }

  failNextSearch(resourceType: Resource["resourceType"]): void {
    this.failedSearchResourceType = resourceType;
  }

  failNextTransaction(status: 409 | 412): void {
    this.failedTransactionStatus = status;
  }

  failNextUpdate(status: 409 | 412): void {
    this.failedUpdateStatus = status;
  }

  resources(resourceType: Resource["resourceType"]): Resource[] {
    return [...this.rows.values()]
      .filter((resource) => resource.resourceType === resourceType)
      .map((resource) => structuredClone(resource));
  }

  async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
    this.readKeys.push(`${resourceType}/${id}`);
    const resource = this.rows.get(`${resourceType}/${id}`);
    if (!resource) throw new Error(`Missing ${resourceType}/${id}`);
    return structuredClone(resource) as T;
  }

  async search<T extends Resource>(
    resourceType: T["resourceType"],
    params: FhirSearchParams = {},
  ): Promise<Bundle<T>> {
    if (resourceType === this.failedSearchResourceType) {
      this.failedSearchResourceType = undefined;
      throw new Error(`Simulated ${resourceType} search failure`);
    }
    if (resourceType === "Basic" && this.hiddenBasicSearches > 0) {
      this.hiddenBasicSearches -= 1;
      return { resourceType: "Bundle", type: "searchset", entry: [] };
    }
    const query = searchRecord(params);
    this.searchCalls.push({ resourceType, params: { ...query } });
    let rows = [...this.rows.values()]
      .filter((resource) => resource.resourceType === resourceType)
      .filter((resource) => !query.code || resourceHasCode(resource, query.code))
      .filter((resource) => !query.identifier || resourceHasIdentifier(resource, query.identifier));
    if (query.requester) {
      rows = rows.filter((resource) => resource.resourceType === "ServiceRequest"
        && resource.requester?.reference === query.requester);
    }
    const nameQuery = query["name:contains"];
    if (nameQuery) rows = rows.filter((resource) => resourceMatchesName(resource, nameQuery, this.rows));
    const practitionerNameQuery = query["practitioner.name:contains"];
    if (practitionerNameQuery) {
      rows = rows.filter((resource) => resource.resourceType === "PractitionerRole"
        && resourceMatchesPractitionerName(resource, practitionerNameQuery, this.rows));
    }
    if (resourceType === "ServiceRequest" && query._sort === "-authored") {
      rows.sort((left, right) => {
        const leftDate = left.resourceType === "ServiceRequest" ? left.authoredOn ?? "" : "";
        const rightDate = right.resourceType === "ServiceRequest" ? right.authoredOn ?? "" : "";
        return rightDate.localeCompare(leftDate);
      });
    }
    if (query._count) rows = rows.slice(0, Number(query._count));
    const resources = rows.map((resource) => ({ resource: structuredClone(resource) as T }));
    return { resourceType: "Bundle", type: "searchset", entry: resources };
  }

  async create<T extends Resource>(
    resource: T,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    const conditionalIdentifier = extraHeaders["If-None-Exist"]?.match(/^identifier=(.+)$/)?.[1];
    if (resource.resourceType === "Basic" && conditionalIdentifier) {
      const existing = [...this.rows.values()].find((candidate) =>
        resourceHasIdentifier(candidate, conditionalIdentifier));
      if (existing) return structuredClone(existing) as T;
    }
    const id = resource.id ?? `${resource.resourceType.toLowerCase()}-${++this.sequence}`;
    const stored = structuredClone({
      ...resource,
      id,
      meta: { ...resource.meta, versionId: "1" },
    }) as T;
    this.rows.set(`${resource.resourceType}/${id}`, stored);
    this.created.push(stored);
    if (stored.resourceType === "Provenance") this.provenances.push(stored as Provenance);
    return structuredClone(stored);
  }

  async update<T extends Resource>(
    resourceType: T["resourceType"],
    id: string,
    resource: T,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    if (this.failedUpdateStatus) {
      const status = this.failedUpdateStatus;
      this.failedUpdateStatus = undefined;
      throw fhirConflict(status);
    }
    assert.equal(resource.resourceType, resourceType);
    assert.equal(resource.id, id);
    const current = this.rows.get(`${resourceType}/${id}`);
    if (!current) throw new Error(`Missing ${resourceType}/${id}`);
    const ifMatch = extraHeaders["If-Match"]?.match(/"(.+)"/)?.[1];
    if (ifMatch && ifMatch !== current.meta?.versionId) throw fhirConflict(412);
    const stored = structuredClone({
      ...resource,
      meta: {
        ...resource.meta,
        versionId: String(Number(current.meta?.versionId ?? "0") + 1),
      },
    }) as T;
    this.rows.set(`${resourceType}/${id}`, stored);
    return structuredClone(stored);
  }

  async executeTransaction(bundle: Bundle): Promise<Bundle> {
    if (this.failedTransactionStatus) {
      const status = this.failedTransactionStatus;
      this.failedTransactionStatus = undefined;
      throw fhirConflict(status);
    }
    const serviceRequest = bundle.entry?.[0]?.resource;
    const provenance = bundle.entry?.[1]?.resource;
    if (serviceRequest?.resourceType !== "ServiceRequest" || !serviceRequest.id) {
      throw new Error("Expected a ServiceRequest transaction update.");
    }
    if (provenance?.resourceType !== "Provenance") {
      throw new Error("Expected a Provenance transaction create.");
    }
    const current = this.rows.get(`ServiceRequest/${serviceRequest.id}`);
    if (!current) throw new Error(`Missing ServiceRequest/${serviceRequest.id}`);
    const ifMatch = bundle.entry?.[0]?.request?.ifMatch?.match(/"(.+)"/)?.[1];
    if (ifMatch !== current.meta?.versionId) throw fhirConflict(412);

    const serviceRequestVersion = String(Number(current.meta?.versionId ?? "0") + 1);
    const storedServiceRequest = structuredClone({
      ...serviceRequest,
      meta: { ...serviceRequest.meta, versionId: serviceRequestVersion },
    });
    const provenanceId = provenance.id ?? `provenance-${++this.sequence}`;
    const storedProvenance = structuredClone({
      ...provenance,
      id: provenanceId,
      meta: { ...provenance.meta, versionId: "1" },
    });
    this.rows.set(`ServiceRequest/${serviceRequest.id}`, storedServiceRequest);
    this.rows.set(`Provenance/${provenanceId}`, storedProvenance);
    this.created.push(storedProvenance);
    this.provenances.push(storedProvenance);
    return {
      resourceType: "Bundle",
      type: "transaction-response",
      entry: [
        { response: { status: "200", location: `ServiceRequest/${serviceRequest.id}/_history/${serviceRequestVersion}` } },
        { response: { status: "201", location: `Provenance/${provenanceId}/_history/1` } },
      ],
    };
  }
}

function seededFhir(): MemoryReferralFhir {
  const fhir = new MemoryReferralFhir();
  fhir.put({
    resourceType: "Patient",
    id: "p1",
    name: [{ text: "Alex Patient" }],
  } satisfies Patient);
  fhir.put({
    resourceType: "Practitioner",
    id: "clinician-1",
    name: [{ text: "Dr. Casey Clinician", suffix: ["OD"] }],
  } satisfies Practitioner);
  fhir.put({
    resourceType: "Encounter",
    id: "current",
    status: "in-progress",
    class: { code: "AMB" },
    subject: { reference: "Patient/p1" },
  } satisfies Encounter);
  fhir.put({
    resourceType: "Organization",
    id: "retina-1",
    name: "Retina Associates",
  } satisfies Organization);
  fhir.put(referral("referral-1", "Patient/p1"));
  return fhir;
}

function referral(id: string, subjectReference: string): ServiceRequest {
  return {
    ...buildReferralServiceRequest({
      subjectReference,
      subjectDisplay: "Alex Patient",
      requesterReference: "Practitioner/clinician-1",
      targetReference: "Organization/retina-1",
      targetDisplay: "Retina Associates",
      encounterReference: "Encounter/current",
      includeList: INCLUDE_LIST,
      letterBody: "Please evaluate this patient.",
      authoredOn: NOW,
    }),
    id,
  };
}

function referralForRequester(
  id: string,
  requesterReference: string,
  targetReference: string,
  targetDisplay: string,
  authoredOn: string,
): ServiceRequest {
  return {
    ...referral(id, "Patient/p1"),
    authoredOn,
    requester: { reference: requesterReference },
    performer: [{ reference: targetReference, display: targetDisplay }],
  };
}

function referralLetterBody(serviceRequest: ServiceRequest): string | undefined {
  return serviceRequest.extension?.find(
    (extension) => extension.url === REFERRAL_LETTER_BODY_EXTENSION_URL,
  )?.valueString;
}

function searchRecord(params: FhirSearchParams): Record<string, string> {
  if (params instanceof URLSearchParams) return Object.fromEntries(params);
  if (Array.isArray(params)) return Object.fromEntries(params);
  return params;
}

function resourceHasCode(resource: Resource, token: string): boolean {
  if (resource.resourceType !== "Basic") return false;
  const [system, code] = token.split("|");
  return resource.code?.coding?.some((coding) =>
    coding.system === system && coding.code === code) ?? false;
}

function resourceHasIdentifier(resource: Resource, token: string): boolean {
  if (resource.resourceType !== "Basic") return false;
  const [system, value] = token.split("|");
  return resource.identifier?.some((identifier) =>
    identifier.system === system && identifier.value === value) ?? false;
}

function resourceMatchesName(
  resource: Resource,
  query: string,
  rows: ReadonlyMap<string, Resource>,
): boolean {
  const normalized = query.toLowerCase();
  if (resource.resourceType === "Organization") {
    return resource.name?.toLowerCase().includes(normalized) ?? false;
  }
  if (resource.resourceType === "Practitioner") {
    return JSON.stringify(resource.name ?? []).toLowerCase().includes(normalized);
  }
  if (resource.resourceType === "PractitionerRole") {
    return resourceMatchesPractitionerName(resource, query, rows);
  }
  return false;
}

function resourceMatchesPractitionerName(
  role: PractitionerRole,
  query: string,
  rows: ReadonlyMap<string, Resource>,
): boolean {
  const normalized = query.toLowerCase();
  if (role.practitioner?.display?.toLowerCase().includes(normalized)) return true;
  const practitioner = role.practitioner?.reference
    ? rows.get(role.practitioner.reference)
    : undefined;
  return practitioner?.resourceType === "Practitioner"
    && JSON.stringify(practitioner.name ?? []).toLowerCase().includes(normalized);
}

function fhirConflict(status: 409 | 412): Error & { status: number } {
  return Object.assign(new Error(`FHIR ${status}`), { status });
}
