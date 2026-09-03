import assert from "node:assert/strict";
import type { ClientApplication, ProjectMembership, Resource } from "@medplum/fhirtypes";
import { buildProjectMembershipAccess, type PracticeRoleId } from "../src/authz/roles.js";

/**
 * Disposable practice-role principals for real-Medplum authorization proofs.
 *
 * Every live authorization lane needs the same mechanic: a throwaway ClientApplication bound to
 * one synced canonical practice-role AccessPolicy, its ProjectMembership parameters set the way
 * the setup wizard sets them (the patient compartment, plus the provider profile for Provider),
 * and a client_credentials token minted from it. The AccessPolicy Medplum enforces for that token
 * is the real one — which is the whole point: the in-memory FHIR fakes used everywhere else in
 * this suite do not evaluate AccessPolicy criteria at all, and that blindness is how a missing
 * `Basic` grant survived four evaluation rounds (decision 2026-09-02, undo ledger never granted).
 *
 * Extracted from clinicalWriteAuthzLive.test.ts when encounterUndoLedgerAuthzLive.test.ts became
 * its second caller. One mechanic, two lanes, one copy.
 */

export async function createRoleClient(input: {
  baseUrl: string;
  roleId: PracticeRoleId;
  policyReference: string;
  patientReference: string;
  practitionerReference: string;
  projectId: string;
  runId: string;
  adminToken: string;
  track: <T extends Resource>(resource: T) => T;
}): Promise<{ token: string }> {
  const baseUrl = input.baseUrl.replace(/\/$/, "");
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
  const initialToken = await clientCredentialsToken(baseUrl, client.id, client.secret, input.roleId);
  const meResponse = await fetch(`${baseUrl}/auth/me`, {
    headers: { Authorization: `Bearer ${initialToken}` },
  });
  assert.equal(meResponse.status, 200, `${input.roleId} client /auth/me.`);
  const me = await meResponse.json() as { membership?: { id?: string } };
  assert.ok(me.membership?.id, `${input.roleId} client membership id.`);
  const membershipResponse = await fetch(
    `${baseUrl}/admin/projects/${input.projectId}/members/${me.membership.id}`,
    { headers: { Authorization: `Bearer ${input.adminToken}` } },
  );
  assert.equal(membershipResponse.status, 200, `Read ${input.roleId} client membership.`);
  const membership = await membershipResponse.json() as ProjectMembership;
  input.track(membership);
  const access = buildProjectMembershipAccess({
    policyReference: input.policyReference,
    parameters: input.roleId === "admin" ? undefined : {
      patientCompartmentReference: input.patientReference,
      ...(input.roleId === "provider" ? { providerProfileReference: input.practitionerReference } : {}),
    },
  });
  const { accessPolicy: _legacyAccessPolicy, ...membershipWithoutLegacyPolicy } = membership;
  const updateResponse = await fetch(
    `${baseUrl}/admin/projects/${input.projectId}/members/${membership.id}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${input.adminToken}`, "Content-Type": "application/fhir+json" },
      body: JSON.stringify({ ...membershipWithoutLegacyPolicy, access }),
    },
  );
  assert.equal(updateResponse.status, 200, `Bind ${input.roleId} client membership parameters.`);
  return { token: await clientCredentialsToken(baseUrl, client.id, client.secret, input.roleId) };
}

export async function clientCredentialsToken(
  baseUrl: string,
  clientId: string,
  clientSecret: string,
  roleId: PracticeRoleId,
): Promise<string> {
  const tokenResponse = await fetch(`${baseUrl.replace(/\/$/, "")}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  assert.equal(tokenResponse.status, 200, `${roleId} client_credentials grant.`);
  const tokenBody = await tokenResponse.json() as { access_token?: string };
  assert.ok(tokenBody.access_token);
  return tokenBody.access_token;
}

export async function fhirRequest<T extends Resource>(
  baseUrl: string,
  token: string,
  method: "GET" | "POST" | "PUT",
  path: string,
  resource?: Resource,
): Promise<{ status: number; body?: T; summary: string }> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/fhir/R4/${path}`, {
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

export async function cleanupReferences(baseUrl: string, token: string, references: readonly string[]): Promise<void> {
  const base = baseUrl.replace(/\/$/, "");
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
