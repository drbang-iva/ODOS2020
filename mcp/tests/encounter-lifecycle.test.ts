import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, Encounter, Patient, Provenance } from "@medplum/fhirtypes";
import {
  createAuthenticatedFhirClient,
  loadRepoEnv,
} from "./integration-helpers.js";
import type { JsonPatchOperation } from "../src/fhir-client.js";

test("comprehensive Encounter lifecycle records history and Provenance per state change", { timeout: 90_000 }, async (t) => {
  loadRepoEnv();

  const baseUrl = process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103";
  const email = process.env.MEDPLUM_ADMIN_EMAIL;
  const password = process.env.MEDPLUM_ADMIN_PASSWORD;
  if (!email || !password) {
    t.skip("MEDPLUM_ADMIN_EMAIL and MEDPLUM_ADMIN_PASSWORD are required for Medplum integration tests.");
    return;
  }

  const { fhir, accessToken } = await createAuthenticatedFhirClient({ baseUrl, email, password });
  const patient = await fhir.create<Patient>({
    resourceType: "Patient",
    name: [{ family: `EncounterLifecycle${Date.now()}`, given: ["Test"] }],
  });

  const startedAt = new Date().toISOString();
  const createResponse = await fhir.executeTransaction({
    resourceType: "Bundle",
    type: "transaction",
    entry: [
      {
        resource: {
          resourceType: "Encounter",
          status: "arrived",
          class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
          subject: { reference: `Patient/${patient.id}` },
          period: { start: startedAt },
          meta: { profile: ["https://osod.dev/fhir/StructureDefinition/Encounter-ComprehensiveExam"] },
        },
        request: { method: "POST", url: "Encounter" },
      },
    ],
  });
  const encounterId = idFromLocation(createResponse.entry?.[0]?.response?.location, "Encounter");
  await createProvenance(fhir, `Encounter/${encounterId}`, "CREATE", "OSOD lifecycle create");

  const inProgressResponse = await fhir.executeTransaction(
    patchEncounterBundle(encounterId, [{ op: "replace", path: "/status", value: "in-progress" }], "OSOD lifecycle in-progress"),
  );
  assert.ok(inProgressResponse.entry?.every((entry) => entry.response?.status?.match(/^2\d\d/)));

  const finishedAt = new Date().toISOString();
  const finishedResponse = await fhir.executeTransaction(
    patchEncounterBundle(
      encounterId,
      [
        { op: "replace", path: "/status", value: "finished" },
        { op: "add", path: "/period/end", value: finishedAt },
      ],
      "OSOD lifecycle finish",
    ),
  );
  assert.ok(finishedResponse.entry?.every((entry) => entry.response?.status?.match(/^2\d\d/)));

  const finished = await fhir.read<Encounter>("Encounter", encounterId);
  assert.equal(finished.status, "finished");
  assert.equal(finished.period?.end, finishedAt);

  const history = await fetch(`${baseUrl.replace(/\/$/, "")}/fhir/R4/Encounter/${encounterId}/_history`, {
    headers: {
      Accept: "application/fhir+json",
      Authorization: `Bearer ${accessToken}`,
    },
  });
  assert.ok(history.ok, `Encounter history request failed: ${history.status}`);
  const historyBundle = (await history.json()) as Bundle<Encounter>;
  assert.ok((historyBundle.entry?.length ?? 0) >= 3);

  const provenanceBundle = await fhir.search<Provenance>("Provenance", {
    target: `Encounter/${encounterId}`,
    _count: "10",
  });
  assert.ok((provenanceBundle.entry?.length ?? 0) >= 3);
});

function patchEncounterBundle(
  encounterId: string,
  ops: JsonPatchOperation[],
  operatorDisplay: string,
): Bundle {
  return {
    resourceType: "Bundle",
    type: "transaction",
    entry: [
      {
        resource: {
          resourceType: "Binary",
          contentType: "application/json-patch+json",
          data: Buffer.from(JSON.stringify(ops)).toString("base64"),
        } as never,
        request: { method: "PATCH", url: `Encounter/${encounterId}` },
      },
      {
        resource: provenance(`Encounter/${encounterId}`, "UPDATE", operatorDisplay),
        request: { method: "POST", url: "Provenance" },
      },
    ],
  };
}

async function createProvenance(
  fhir: Awaited<ReturnType<typeof createAuthenticatedFhirClient>>["fhir"],
  targetReference: string,
  activityCode: "CREATE" | "UPDATE",
  operatorDisplay: string,
): Promise<void> {
  const response = await fhir.executeTransaction({
    resourceType: "Bundle",
    type: "transaction",
    entry: [
      {
        resource: provenance(targetReference, activityCode, operatorDisplay),
        request: { method: "POST", url: "Provenance" },
      },
    ],
  });
  assert.ok(response.entry?.every((entry) => entry.response?.status?.match(/^2\d\d/)));
}

function provenance(
  targetReference: string,
  activityCode: "CREATE" | "UPDATE",
  operatorDisplay: string,
): Provenance {
  return {
    resourceType: "Provenance",
    target: [{ reference: targetReference }],
    recorded: new Date().toISOString(),
    activity: {
      coding: [
        {
          system: "http://terminology.hl7.org/CodeSystem/v3-DataOperation",
          code: activityCode,
          display: activityCode === "CREATE" ? "Create" : "Update",
        },
      ],
    },
    agent: [
      {
        type: {
          coding: [
            {
              system: "http://terminology.hl7.org/CodeSystem/provenance-participant-type",
              code: "author",
              display: "Author",
            },
          ],
        },
        who: { display: operatorDisplay },
      },
    ],
  };
}

function idFromLocation(location: string | undefined, resourceType: string): string {
  const match = location?.match(new RegExp(`^${resourceType}/([^/]+)`));
  assert.ok(match, `Expected ${resourceType}/<id> location.`);
  return match[1];
}
