import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import type {
  AccessPolicy,
  AdverseEvent,
  AllergyIntolerance,
  BodyStructure,
  CareTeam,
  ClientApplication,
  Goal,
  MedicationRequest,
  Observation,
  Patient,
  Practitioner,
  ProjectMembership,
  Provenance,
  Resource,
} from "@medplum/fhirtypes";
import { buildProjectMembershipAccess, ODOS_PRACTICE_ROLE_SYSTEM, type PracticeRoleId } from "../src/authz/roles.js";
import { buildAllergyIntolerance } from "../src/fhir/allergyIntolerance.js";
import { buildCareTeam } from "../src/fhir/careTeam.js";
import { buildDryEyeAdverseEvent } from "../src/fhir/dryEyeAdverseEvent.js";
import {
  buildMedicationRequest,
  ODOS_TRANSMISSION_METHOD_EXTENSION_URL,
  WENO_MESSAGE_ID_IDENTIFIER_SYSTEM,
} from "../src/fhir/medicationOrder.js";
import { buildEyeBodyStructure } from "../src/fhir/ophthalmology/bodyStructure.js";
import { buildProvenance } from "../src/fhir/ophthalmology/provenance.js";
import { searchAll } from "../src/fhir-search.js";
import { createAuthenticatedFhirClient, requireMedplumAdmin } from "./integration-helpers.js";

const baseUrl = process.env.MEDPLUM_BASE_URL?.replace(/\/$/, "") ?? "http://localhost:8103";
test("synced practice policies enforce all repaired clinical writes on running Medplum", async (t) => {
  const credentials = requireMedplumAdmin(t, "clinicalWriteAuthzLive");
  if (!credentials) {
    return;
  }
  const { email, password } = credentials;
  const { fhir: adminFhir, accessToken: adminToken } = await createAuthenticatedFhirClient({
    baseUrl,
    email,
    password,
  });
  const meResponse = await fetch(`${baseUrl}/auth/me`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  if (!meResponse.ok) {
    throw new Error(`GET /auth/me failed: ${meResponse.status}`);
  }
  const me = await meResponse.json() as { project?: { id?: string } };
  const projectId = me.project?.id;
  if (!projectId) {
    throw new Error("Authenticated Medplum session has no active project id.");
  }
  const runId = randomUUID();
  const cleanup: string[] = [];
  const track = <T extends Resource>(resource: T): T => {
    assert.ok(resource.id, `${resource.resourceType} create response requires an id.`);
    cleanup.push(`${resource.resourceType}/${resource.id}`);
    return resource;
  };

  try {
    const policies = await searchAll<AccessPolicy>(adminFhir, "AccessPolicy", {
      _project: projectId,
      _count: "1000",
    });
    const rolePolicies = new Map<PracticeRoleId, AccessPolicy>();
    for (const roleId of ["provider", "staff", "admin"] as const) {
      const matches = policies.filter((policy) => {
        const roleTags = policy.meta?.tag?.filter((tag) => tag.system === ODOS_PRACTICE_ROLE_SYSTEM) ?? [];
        return roleTags.length === 1 && roleTags[0]?.code === roleId;
      });
      assert.equal(matches.length, 1, `Expected one synced canonical ${roleId} AccessPolicy.`);
      rolePolicies.set(roleId, matches[0]!);
    }

    const practitioner = track(await adminFhir.create<Practitioner>({
      resourceType: "Practitioner",
      identifier: [{ system: "urn:odos:test:clinical-write-authz", value: `practitioner-${runId}` }],
      name: [{ family: `AuthzProof${runId}`, given: ["Synthetic"] }],
    }));
    const patient = track(await adminFhir.create<Patient>({
      resourceType: "Patient",
      identifier: [{ system: "urn:odos:test:clinical-write-authz", value: `patient-${runId}` }],
      name: [{ family: `AuthzProof${runId}`, given: ["Synthetic"] }],
      generalPractitioner: [{ reference: `Practitioner/${practitioner.id}` }],
    }));
    const patientReference = `Patient/${patient.id}`;
    const practitionerReference = `Practitioner/${practitioner.id}`;
    const tokens = new Map<PracticeRoleId, string>();
    for (const roleId of ["provider", "staff", "admin"] as const) {
      const policy = rolePolicies.get(roleId)!;
      assert.ok(policy.id);
      const roleClient = await createRoleClient({
        roleId,
        policyReference: `AccessPolicy/${policy.id}`,
        patientReference,
        practitionerReference,
        projectId,
        runId,
        adminFhir,
        adminToken,
        track,
      });
      tokens.set(roleId, roleClient.token);
    }

    const request = <T extends Resource>(
      roleId: PracticeRoleId,
      method: "GET" | "POST" | "PUT",
      path: string,
      resource?: Resource,
    ) => fhirRequest<T>(tokens.get(roleId)!, method, path, resource);
    const denied = async (
      roleId: PracticeRoleId,
      method: "POST" | "PUT",
      path: string,
      resource: Resource,
    ) => {
      const response = await request(roleId, method, path, resource);
      assert.equal(response.status, 403, `${roleId} ${method} ${path} must be denied.`);
    };
    const created = async <T extends Resource>(roleId: PracticeRoleId, resource: T): Promise<T> => {
      const response = await request<T>(roleId, "POST", resource.resourceType, resource);
      assert.equal(response.status, 201, `${roleId} create ${resource.resourceType}: ${response.summary}`);
      return track(response.body as T);
    };
    const updated = async <T extends Resource>(roleId: PracticeRoleId, resource: T): Promise<T> => {
      assert.ok(resource.id);
      const response = await request<T>(roleId, "PUT", `${resource.resourceType}/${resource.id}`, resource);
      assert.equal(response.status, 200, `${roleId} update ${resource.resourceType}: ${response.summary}`);
      return response.body as T;
    };

    const providerVoidDraft = await created<Observation>(
      "staff",
      observationFixture(patientReference, `provider-void-${runId}`),
    );
    await t.test("Provider voids a preliminary Observation seeded by Staff", async () => {
      await updated<Observation>("provider", { ...providerVoidDraft, status: "entered-in-error" });
    });

    const staffVoidDraft = await created<Observation>(
      "provider",
      observationFixture(patientReference, `staff-void-${runId}`),
    );
    await t.test("Staff voids a preliminary Observation seeded by Provider", async () => {
      await updated<Observation>("staff", { ...staffVoidDraft, status: "entered-in-error" });
    });

    const staffFinalDraft = await created<Observation>(
      "provider",
      observationFixture(patientReference, `staff-final-${runId}`),
    );
    await t.test("Staff cannot finalize a preliminary Observation seeded by Provider", async () => {
      await denied("staff", "PUT", `Observation/${staffFinalDraft.id}`, { ...staffFinalDraft, status: "final" });
    });

    await t.test("Chart sidebar > Allergies — Mark no known allergies", async () => {
      const body = buildAllergyIntolerance({ patientReference, noKnownAllergy: true });
      await denied("admin", "POST", "AllergyIntolerance", body);
      await created<AllergyIntolerance>("staff", body);
    });

    await t.test("Chart sidebar > Allergies — Add allergy", async () => {
      const body = buildAllergyIntolerance({
        patientReference,
        code: { system: "urn:odos:test:allergy", code: "synthetic", display: "Synthetic allergen" },
        verificationStatus: "confirmed",
      });
      await denied("admin", "POST", "AllergyIntolerance", body);
      await created<AllergyIntolerance>("provider", body);
    });

    await t.test("Chart sidebar > Care Team — Add team member", async () => {
      const body = buildCareTeam({
        patientReference,
        participant: [{ role: { text: "Synthetic PCP" }, practitionerReference }],
      });
      await denied("admin", "POST", "CareTeam", body);
      await created<CareTeam>("staff", body);
    });

    await t.test("Diagnosis workspace/assessment — diagnosis laterality BodyStructure", async () => {
      const { id: _containedId, ...body } = buildEyeBodyStructure("OD", patientReference);
      await denied("staff", "POST", "BodyStructure", body);
      await created<BodyStructure>("provider", body);
    });

    let goal: Goal;
    await t.test("IOP Timeline target editor — Save a new target", async () => {
      const body: Goal = {
        resourceType: "Goal",
        lifecycleStatus: "active",
        description: { text: "Synthetic IOP target" },
        subject: { reference: patientReference },
      };
      await denied("admin", "POST", "Goal", body);
      goal = await created<Goal>("provider", body);
    });

    await t.test("IOP Timeline target editor — Save an existing target", async () => {
      const body: Goal = { ...goal, description: { text: "Updated synthetic IOP target" } };
      await denied("admin", "PUT", `Goal/${goal.id}`, body);
      goal = await updated<Goal>("provider", body);
    });

    let prescription: MedicationRequest;
    await t.test("Prescriptions — Add prescription", async () => {
      const body = prescriptionFixture(patientReference, practitionerReference, `create-${runId}`);
      await denied("admin", "POST", "MedicationRequest", body);
      prescription = await created<MedicationRequest>("staff", body);
    });

    await t.test("Prescriptions — Staff edits repeats before transmission", async () => {
      const body: MedicationRequest = {
        ...prescription,
        dispenseRequest: {
          ...prescription.dispenseRequest,
          numberOfRepeatsAllowed: (prescription.dispenseRequest?.numberOfRepeatsAllowed ?? 0) + 1,
        },
      };
      await denied("admin", "PUT", `MedicationRequest/${prescription.id}`, body);
      prescription = await updated<MedicationRequest>("staff", body);
    });

    await t.test("Prescriptions — Send to pharmacy (reserve WENO message id)", async () => {
      const body = withMessageId(prescription, `reserve-${runId}`);
      await denied("admin", "PUT", `MedicationRequest/${prescription.id}`, body);
      prescription = await updated<MedicationRequest>("staff", body);
    });

    await t.test("Prescriptions — Send to pharmacy (record indeterminate outcome)", async () => {
      const body: MedicationRequest = {
        ...prescription,
        note: [...(prescription.note ?? []), { time: new Date().toISOString(), text: `WENO Switch outcome unknown reserve-${runId}: synthetic timeout` }],
      };
      await denied("admin", "PUT", `MedicationRequest/${prescription.id}`, body);
      prescription = await updated<MedicationRequest>("staff", body);
    });

    await t.test("Prescriptions — Pharmacy verified not received — clear reservation", async () => {
      const body: MedicationRequest = {
        ...prescription,
        identifier: prescription.identifier?.filter((item) => item.system !== WENO_MESSAGE_ID_IDENTIFIER_SYSTEM),
        note: [...(prescription.note ?? []), {
          time: new Date().toISOString(),
          text: `WENO Switch outcome-unknown reservation cleared reserve-${runId} by ${practitionerReference}.`,
        }],
      };
      await denied("admin", "PUT", `MedicationRequest/${prescription.id}`, body);
      prescription = await updated<MedicationRequest>("staff", body);
    });

    let successfulTransmission = await created<MedicationRequest>(
      "provider",
      prescriptionFixture(patientReference, practitionerReference, `success-${runId}`),
    );
    successfulTransmission = await updated("staff", withMessageId(successfulTransmission, `success-${runId}`));
    await t.test("Prescriptions — Send to pharmacy (record successful transmission)", async () => {
      const body: MedicationRequest = {
        ...successfulTransmission,
        extension: [
          ...(successfulTransmission.extension ?? []).filter((item) => item.url !== ODOS_TRANSMISSION_METHOD_EXTENSION_URL),
          { url: ODOS_TRANSMISSION_METHOD_EXTENSION_URL, valueCode: "electronically-sent" },
        ],
      };
      await denied("admin", "PUT", `MedicationRequest/${successfulTransmission.id}`, body);
      successfulTransmission = await updated<MedicationRequest>("staff", body);
    });

    let failedTransmission = await created<MedicationRequest>(
      "provider",
      prescriptionFixture(patientReference, practitionerReference, `error-${runId}`),
    );
    failedTransmission = await updated("staff", withMessageId(failedTransmission, `error-${runId}`));
    await t.test("Prescriptions — Send to pharmacy (record WENO error)", async () => {
      const body: MedicationRequest = {
        ...failedTransmission,
        identifier: failedTransmission.identifier?.filter((item) => item.system !== WENO_MESSAGE_ID_IDENTIFIER_SYSTEM),
        note: [...(failedTransmission.note ?? []), {
          time: new Date().toISOString(),
          text: "WENO Switch error synthetic/synthetic: synthetic rejection",
        }],
      };
      await denied("admin", "PUT", `MedicationRequest/${failedTransmission.id}`, body);
      failedTransmission = await updated<MedicationRequest>("staff", body);
    });

    await t.test("Staff transmitted prescription mutation is denied while Provider control succeeds", async () => {
      const body: MedicationRequest = {
        ...successfulTransmission,
        medicationCodeableConcept: { text: "Changed synthetic medication" },
      };
      await denied("staff", "PUT", `MedicationRequest/${successfulTransmission.id}`, body);
      successfulTransmission = await updated<MedicationRequest>("provider", body);
    });

    await t.test("Staff prescription requester mutation is denied before transmission", async () => {
      const body: MedicationRequest = {
        ...failedTransmission,
        requester: { reference: `Practitioner/${randomUUID()}` },
      };
      await denied("staff", "PUT", `MedicationRequest/${failedTransmission.id}`, body);
    });

    await t.test("Dry Eye > Adverse Event — Capture and persist Provenance", async () => {
      const body = buildDryEyeAdverseEvent({
        patientReference,
        event: { text: "Synthetic dry-eye adverse event" },
        recordedDate: new Date().toISOString(),
      });
      await denied("staff", "POST", "AdverseEvent", body);
      const adverseEvent = await created<AdverseEvent>("provider", body);
      await assertCreateOnlyAdverseEventAndProvenance({
        adverseEvent,
        patientReference,
        practitionerReference,
        providerToken: tokens.get("provider")!,
        adminFhir,
        track,
      });
    });

    await t.test("Ortho-K > Adverse Event — Capture and persist Provenance", async () => {
      const body: AdverseEvent = {
        resourceType: "AdverseEvent",
        actuality: "actual",
        category: [{ text: "Ortho-K adverse event" }],
        event: { text: "Synthetic Ortho-K adverse event" },
        subject: { reference: patientReference },
        recordedDate: new Date().toISOString(),
      };
      await denied("admin", "POST", "AdverseEvent", body);
      const adverseEvent = await created<AdverseEvent>("provider", body);
      await assertCreateOnlyAdverseEventAndProvenance({
        adverseEvent,
        patientReference,
        practitionerReference,
        providerToken: tokens.get("provider")!,
        adminFhir,
        track,
      });
    });

    await t.test("practice-role clients cannot forge AuditEvent", async () => {
      const body = {
        resourceType: "AuditEvent",
        type: { system: "http://terminology.hl7.org/CodeSystem/audit-event-type", code: "rest" },
        recorded: new Date().toISOString(),
        agent: [{ requestor: true, who: { reference: practitionerReference } }],
        source: { observer: { display: "Synthetic forbidden audit source" } },
      } as const;
      for (const roleId of ["provider", "staff", "admin"] as const) {
        await denied(roleId, "POST", "AuditEvent", body);
      }
    });
  } finally {
    await cleanupReferences(baseUrl, adminToken, cleanup);
  }
});

async function createRoleClient(input: {
  roleId: PracticeRoleId;
  policyReference: string;
  patientReference: string;
  practitionerReference: string;
  projectId: string;
  runId: string;
  adminFhir: Awaited<ReturnType<typeof createAuthenticatedFhirClient>>["fhir"];
  adminToken: string;
  track: <T extends Resource>(resource: T) => T;
}): Promise<{ token: string }> {
  const response = await fetch(`${baseUrl}/admin/projects/${input.projectId}/client`, {
    method: "POST",
    headers: { Authorization: `Bearer ${input.adminToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: `clinical-write-${input.roleId}-${input.runId}`,
      description: "Disposable synthetic clinical-write authorization proof",
      accessPolicy: { reference: input.policyReference },
    }),
  });
  assert.equal(response.status, 201, `Create ${input.roleId} disposable client.`);
  const client = await response.json() as ClientApplication & { id: string; secret: string };
  assert.ok(client.id && client.secret);
  input.track(client);
  const memberships = (await searchAll<ProjectMembership>(input.adminFhir, "ProjectMembership", {
    profile: `ClientApplication/${client.id}`,
    _count: "100",
  })).filter((membership) => membership.project.reference === `Project/${input.projectId}`);
  assert.equal(memberships.length, 1, `${input.roleId} client membership.`);
  const membership = memberships[0]!;
  assert.ok(membership.id && membership.meta?.versionId);
  input.track(membership);
  const access = buildProjectMembershipAccess({
    policyReference: input.policyReference,
    parameters: input.roleId === "admin" ? undefined : {
      patientCompartmentReference: input.patientReference,
      ...(input.roleId === "provider" ? { providerProfileReference: input.practitionerReference } : {}),
    },
  });
  await input.adminFhir.patch<ProjectMembership>("ProjectMembership", membership.id, [
    { op: membership.access?.length ? "replace" : "add", path: "/access", value: access },
    ...(membership.accessPolicy ? [{ op: "remove" as const, path: "/accessPolicy" }] : []),
  ], { "If-Match": `W/\"${membership.meta.versionId}\"` });
  const tokenResponse = await fetch(`${baseUrl}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: client.id,
      client_secret: client.secret,
    }),
  });
  assert.equal(tokenResponse.status, 200, `${input.roleId} client_credentials grant.`);
  const tokenBody = await tokenResponse.json() as { access_token?: string };
  assert.ok(tokenBody.access_token);
  return { token: tokenBody.access_token };
}

async function fhirRequest<T extends Resource>(
  token: string,
  method: "GET" | "POST" | "PUT",
  path: string,
  resource?: Resource,
): Promise<{ status: number; body?: T; summary: string }> {
  const response = await fetch(`${baseUrl}/fhir/R4/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(resource ? { "Content-Type": "application/fhir+json" } : {}),
    },
    ...(resource ? { body: JSON.stringify(resource) } : {}),
  });
  const text = await response.text();
  let body: T | undefined;
  if (text) {
    try {
      body = JSON.parse(text) as T;
    } catch {
      // A non-JSON response is summarized by status only and remains a failed assertion upstream.
    }
  }
  const summary = body?.resourceType === "OperationOutcome"
    ? (body as unknown as { issue?: Array<{ diagnostics?: string; details?: { text?: string } }> }).issue
      ?.map((issue) => issue.diagnostics ?? issue.details?.text)
      .filter(Boolean)
      .join("; ") ?? "OperationOutcome"
    : `HTTP ${response.status}`;
  return { status: response.status, body, summary };
}

function prescriptionFixture(
  patientReference: string,
  practitionerReference: string,
  identifier: string,
): MedicationRequest {
  return buildMedicationRequest({
    patientReference,
    practitionerReference,
    recorderReference: practitionerReference,
    medicationText: `Synthetic medication ${identifier}`,
    dosageText: "One synthetic unit daily",
    transmissionMethod: "not-transmitted",
    authoredOn: new Date().toISOString(),
  });
}

function observationFixture(patientReference: string, identifier: string): Observation {
  return {
    resourceType: "Observation",
    status: "preliminary",
    code: { text: `Synthetic authorization draft ${identifier}` },
    subject: { reference: patientReference },
  };
}

function withMessageId(resource: MedicationRequest, value: string): MedicationRequest {
  return {
    ...resource,
    identifier: [...(resource.identifier ?? []), { system: WENO_MESSAGE_ID_IDENTIFIER_SYSTEM, value }],
  };
}

async function assertCreateOnlyAdverseEventAndProvenance(input: {
  adverseEvent: AdverseEvent;
  patientReference: string;
  practitionerReference: string;
  providerToken: string;
  adminFhir: Awaited<ReturnType<typeof createAuthenticatedFhirClient>>["fhir"];
  track: <T extends Resource>(resource: T) => T;
}): Promise<void> {
  assert.ok(input.adverseEvent.id, "Create-only AdverseEvent response body must include its id.");
  const providerRead = await fhirRequest<AdverseEvent>(
    input.providerToken,
    "GET",
    `AdverseEvent/${input.adverseEvent.id}`,
  );
  assert.equal(providerRead.status, 403, "AdverseEvent remains write-only for Provider.");
  const persisted = await input.adminFhir.read<AdverseEvent>("AdverseEvent", input.adverseEvent.id);
  assert.equal(persisted.id, input.adverseEvent.id);
  const provenance = buildProvenance({
    targetReferences: [`AdverseEvent/${input.adverseEvent.id}`],
    patientReference: input.patientReference,
    activityCode: "CREATE",
    activityDisplay: "Create",
    agents: [{ typeCode: "author", whoReference: input.practitionerReference }],
  });
  const response = await fhirRequest<Provenance>(input.providerToken, "POST", "Provenance", provenance);
  assert.equal(response.status, 201, `Provider create Provenance: ${response.summary}`);
  const created = input.track(response.body as Provenance);
  const persistedProvenance = await input.adminFhir.read<Provenance>("Provenance", created.id!);
  assert.equal(
    persistedProvenance.target.some((target) => target.reference === `AdverseEvent/${input.adverseEvent.id}`),
    true,
  );
  assert.equal(
    persistedProvenance.target.some((target) => target.reference === input.patientReference),
    true,
  );
}

async function cleanupReferences(base: string, token: string, references: readonly string[]): Promise<void> {
  const failures: string[] = [];
  for (const reference of [...references].reverse()) {
    const response = await fetch(`${base}/fhir/R4/${reference}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => undefined);
    if (response && ![200, 204, 404, 410].includes(response.status)) {
      failures.push(`${reference}: HTTP ${response.status}`);
    }
  }
  assert.deepEqual(failures, [], `Synthetic live-proof cleanup failures: ${failures.join(", ")}`);
}
