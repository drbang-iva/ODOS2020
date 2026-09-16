import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { AccessPolicy, Resource, Basic, Patient, Bundle } from "@medplum/fhirtypes";
import { requireMedplumAdmin, createLiveAuthorizationClients } from "./integration-helpers.js";
import { createRoleClient, fhirRequest, cleanupReferences } from "./liveRoleClient.js";
import { searchAll } from "../src/fhir-search.js";
import { ODOS_PRACTICE_ROLE_SYSTEM } from "../src/authz/roles.js";
import { buildAgeOfMajorityConfigResource, resolveAgeOfMajorityYears, ODOS_AGE_OF_MAJORITY_CONFIG_SYSTEM, ODOS_AGE_OF_MAJORITY_CONFIG_CODE } from "../src/clinic/age-of-majority-config.js";

test("age-of-majority singleton grants enforce provider reads and staff/admin edits on live Medplum", async (t) => {
  const credentials = requireMedplumAdmin(t, "ageOfMajorityAuthzLive");
  if (!credentials) return;
  const baseUrl = process.env.MEDPLUM_BASE_URL?.replace(/\/$/, "") ?? "http://localhost:8103";
  const { seederFhir, seederAccessToken, callerFhir, callerAccessToken } = await createLiveAuthorizationClients({ baseUrl, ...credentials });
  const meResponse = await fetch(`${baseUrl}/auth/me`, { headers: { Authorization: `Bearer ${callerAccessToken}` } });
  assert.equal(meResponse.status, 200);
  const me = await meResponse.json() as { project?: { id?: string }; profile?: Resource };
  const projectId = me.project?.id;
  assert.ok(projectId && me.profile?.id);
  const cleanup: string[] = [];
  const track = <T extends Resource>(resource: T): T => { assert.ok(resource.id); cleanup.push(`${resource.resourceType}/${resource.id}`); return resource; };
  let bodyFailure: { error: unknown } | undefined;
  try {
    const policies = await searchAll<AccessPolicy>(callerFhir, "AccessPolicy", { _project: projectId });
    const patients = await searchAll<Patient>(callerFhir, "Patient", { _count: "1000" });
    const patient = patients.find((candidate) => candidate.name?.some((name) => name.family?.startsWith("ContractSearch")));
    assert.ok(patient?.id);
    
    for (const roleId of ["provider", "staff", "admin"] as const) {
      await t.test(roleId, async () => {
        const matches = policies.filter((policy) => {
          const tags = policy.meta?.tag?.filter((tag) => tag.system === ODOS_PRACTICE_ROLE_SYSTEM) ?? [];
          return tags.length === 1 && tags[0]?.code === roleId;
        });
        assert.equal(matches.length, 1);
        const { token } = await createRoleClient({ baseUrl, roleId, policyReference: `AccessPolicy/${matches[0]!.id}`, patientReference: `Patient/${patient.id}`, practitionerReference: `${me.profile!.resourceType}/${me.profile!.id}`, projectId, runId: randomUUID(), adminToken: callerAccessToken, track });
        const create = await fhirRequest<Basic>(baseUrl, token, "POST", "Basic", buildAgeOfMajorityConfigResource({ ageOfMajorityYears: 18 }));
        assert.equal(create.status, roleId === "provider" ? 403 : 201, create.summary);
        const config = track(roleId === "provider"
          ? await seederFhir.create(buildAgeOfMajorityConfigResource({ ageOfMajorityYears: 18 }))
          : create.body!);
        const code = `${ODOS_AGE_OF_MAJORITY_CONFIG_SYSTEM}|${ODOS_AGE_OF_MAJORITY_CONFIG_CODE}`;
        const search = await fhirRequest<Bundle<Basic>>(baseUrl, token, "GET", `Basic?${new URLSearchParams({ code })}`);
        assert.equal(search.status, 200, search.summary);
        assert.ok(search.body?.entry?.some((entry) => entry.resource?.id === config.id), `${roleId} search finds the singleton`);
        const read = await fhirRequest<Basic>(baseUrl, token, "GET", `Basic/${config.id}`);
        assert.equal(read.status, 200, read.summary);
        assert.ok([18, 21].includes(resolveAgeOfMajorityYears(read.body)));
        const write = await fhirRequest<Basic>(baseUrl, token, "PUT", `Basic/${config.id}`, buildAgeOfMajorityConfigResource({ ageOfMajorityYears: 21 }, read.body));
        assert.equal(write.status, roleId === "provider" ? 403 : 200, write.summary);
        await cleanupReferences(baseUrl, seederAccessToken, [`Basic/${config.id}`]);
        cleanup.splice(cleanup.indexOf(`Basic/${config.id}`), 1);
      });
    }
  } catch (error) {
    bodyFailure = { error };
  }
  const membershipResults = await Promise.allSettled(cleanup
    .filter((reference) => reference.startsWith("ProjectMembership/"))
    .map(async (reference) => {
      const id = reference.slice("ProjectMembership/".length);
      const response = await fetch(`${baseUrl}/admin/projects/${projectId}/members/${id}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${callerAccessToken}` },
      });
      assert.ok([200, 204, 404, 410].includes(response.status), `${reference}: HTTP ${response.status}`);
    }));
  const resourceResults = await Promise.allSettled([
    cleanupReferences(baseUrl, seederAccessToken, cleanup.filter((reference) => !reference.startsWith("ProjectMembership/"))),
  ]);
  const results = [...membershipResults, ...resourceResults];
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length) {
    const errors = [
      ...(bodyFailure ? [bodyFailure.error] : []),
      ...failures.map((result) => result.reason),
    ];
    throw new AggregateError(errors, `Live authorization fixture failed: ${errors.map((error) => error instanceof Error ? error.message : String(error)).join("; ")}`);
  }
  if (bodyFailure) throw bodyFailure.error;
});
