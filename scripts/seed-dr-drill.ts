#!/usr/bin/env tsx
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AccessPolicy,
  Binary,
  Observation,
  Patient,
  Provenance,
} from "@medplum/fhirtypes";
import { createLiveOsodAuditRuntime } from "../mcp/src/authz/liveAudit.js";
import {
  buildOsodAuditEventRow,
  type OsodAuditEventType,
} from "../mcp/src/authz/osodAudit.js";
import { buildMedplumAccessPolicy, getRoleDeclaration, PRACTICE_ROLE_IDS } from "../mcp/src/authz/roles.js";
import { createMedplumClient } from "../mcp/src/fhir-client.js";
import { parserBinaryHeaders, prepareBinaryForParserCreate } from "../mcp/src/parsers/binarySecurityContext.js";

const baseUrl = process.env.MEDPLUM_BASE_URL ?? "http://localhost:18103";
const email = process.env.MEDPLUM_ADMIN_EMAIL ?? "drill-admin@osod.local";
const password = process.env.MEDPLUM_ADMIN_PASSWORD ?? "Osod-dr-drill-Password-1!";
const postgresUrl =
  process.env.OSOD_POSTGRES_URL ?? "postgresql://medplum:medplum@127.0.0.1:15432/medplum";

await waitForMedplum(baseUrl);
const accessToken = await ensureAdminAccessToken({ baseUrl, email, password });
const fhir = createMedplumClient({ baseUrl, accessToken });
const audit = createLiveOsodAuditRuntime({
  postgresUrl,
  medplumBaseUrl: baseUrl,
  medplumEmail: email,
  medplumPassword: password,
});

const patient = await fhir.create<Patient>({
  resourceType: "Patient",
  active: true,
  gender: "unknown",
  name: [{ use: "official", family: `DRDrill${Date.now()}`, given: ["Synthetic"] }],
});
if (!patient.id) {
  throw new Error("DR drill seed Patient create returned no id.");
}

const observations: Observation[] = [];
for (let index = 0; index < 10; index += 1) {
  observations.push(
    await fhir.create<Observation>({
      resourceType: "Observation",
      status: "final",
      code: { text: `DR drill signed sample ${index + 1}` },
      subject: { reference: `Patient/${patient.id}` },
      effectiveDateTime: new Date(Date.now() - index * 60_000).toISOString(),
      valueString: `sample-${index + 1}`,
    }),
  );
}

const provenanceSamples: Provenance[] = [];
for (const [index, observation] of observations.entries()) {
  provenanceSamples.push(
    await fhir.create<Provenance>({
      resourceType: "Provenance",
      target: [{ reference: `Observation/${observation.id}` }],
      recorded: new Date(Date.now() - index * 60_000).toISOString(),
      agent: [{ who: { display: "OSOD DR drill seed" } }],
      signature: [
        {
          type: [
            {
              system: "urn:iso-astm:E1762-95:2013",
              code: "1.2.840.10065.1.12.1.5",
              display: "Verification Signature",
            },
          ],
          when: new Date().toISOString(),
          who: { reference: `Patient/${patient.id}` },
          data: Buffer.from(`signed-drill-sample-${index + 1}`).toString("base64"),
        },
      ],
    }),
  );
}

const binaries: Binary[] = [];
for (let index = 0; index < 4; index += 1) {
  const securityContext = `Patient/${patient.id}`;
  const binary = prepareBinaryForParserCreate(
    {
      resourceType: "Binary",
      contentType: "text/plain",
      data: Buffer.from(`dr-drill-binary-${index + 1}`).toString("base64"),
    },
    {
      source: "raw-upload-header",
      headers: parserBinaryHeaders(securityContext),
      allowedPatientCompartments: [securityContext],
    },
  );
  binaries.push(await fhir.create<Binary>(binary, parserBinaryHeaders(securityContext)));
}
seedBinaryVolumeFiles(patient.id);

const projectId = await resolveProjectId({ baseUrl, accessToken });
let memberships = 0;
for (const roleId of PRACTICE_ROLE_IDS) {
  const policy = await fhir.create<AccessPolicy>({
    ...buildMedplumAccessPolicy(getRoleDeclaration(roleId)),
    name: `OSOD DR drill ${roleId} ${Date.now()}`,
  });
  if (!policy.id) {
    throw new Error(`AccessPolicy create for ${roleId} returned no id.`);
  }
  await createClientMembership({
    baseUrl,
    accessToken,
    projectId,
    name: `dr-drill-${roleId}-${Date.now()}`,
    policyReference: `AccessPolicy/${policy.id}`,
  });
  memberships += 1;
}

const eventCounts = new Map<string, number>();
const seedTypes: OsodAuditEventType[] = [
  "read",
  "search",
  "create",
  "update",
  "patch",
  "transaction",
  "role-change",
  "policy-change",
  "projectmembership-lifecycle",
  "break-glass-invoked",
  "external-api-call",
  "denied",
];
for (let index = 0; index < 60; index += 1) {
  const eventType = seedTypes[index % seedTypes.length] ?? "read";
  const denied = eventType === "denied";
  const row = buildOsodAuditEventRow({
    eventType,
    actorId: `drill-actor-${index % 5}`,
    actorRole: PRACTICE_ROLE_IDS[index % PRACTICE_ROLE_IDS.length],
    patientId: patient.id,
    resourceType: index % 3 === 0 ? "Patient" : "Observation",
    resourceId: index % 3 === 0 ? patient.id : observations[index % observations.length]?.id,
    actionOutcome: denied ? "denied" : "granted",
    actionReason: denied
      ? "access-policy-compartment-isolation"
      : eventType === "break-glass-invoked"
        ? "Emergency on-call care."
        : `dr-drill-${eventType}`,
    policyUrl: `AccessPolicy/osod-${PRACTICE_ROLE_IDS[index % PRACTICE_ROLE_IDS.length]}`,
    breakGlass: eventType === "break-glass-invoked",
    breakGlassReason: eventType === "break-glass-invoked" ? "Emergency on-call care." : undefined,
  });
  if (denied) {
    await audit.recordDenied(row);
  } else {
    await audit.record(row, () => undefined);
  }
  eventCounts.set(eventType, (eventCounts.get(eventType) ?? 0) + 1);
}
await audit.drainProjectionQueue();
await audit.close();

console.log(
  JSON.stringify(
    {
      patientId: patient.id,
      provenance: provenanceSamples.length,
      binary: binaries.length,
      projectMembership: memberships,
      auditEventsSeeded: Object.fromEntries(eventCounts),
    },
    null,
    2,
  ),
);

async function ensureAdminAccessToken(input: {
  baseUrl: string;
  email: string;
  password: string;
}): Promise<string> {
  try {
    return await loginForAccessToken(input);
  } catch {
    await registerAdmin(input);
    return loginForAccessToken(input);
  }
}

async function waitForMedplum(url: string): Promise<void> {
  const base = url.replace(/\/$/, "");
  const deadline = Date.now() + 180_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/healthcheck`);
      if (response.status < 500) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Timed out waiting for Medplum at ${base}`, { cause: lastError });
}

async function registerAdmin(input: { baseUrl: string; email: string; password: string }): Promise<void> {
  const base = input.baseUrl.replace(/\/$/, "");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const userResponse = await fetch(`${base}/auth/newuser`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId: "new",
      firstName: "OSOD",
      lastName: "DR Drill",
      email: input.email,
      password: input.password,
      remember: false,
      codeChallengeMethod: "S256",
      codeChallenge: challenge,
      recaptchaToken: "",
    }),
  });
  if (!userResponse.ok) {
    throw new Error(`Medplum newuser failed: ${userResponse.status} ${await userResponse.text()}`);
  }
  const newUser = (await userResponse.json()) as { login?: string; code?: string };
  if (newUser.code) {
    await exchangeRegistrationCode({ baseUrl: input.baseUrl, code: newUser.code, verifier });
    return;
  }
  if (!newUser.login) {
    throw new Error("Medplum newuser response did not include login or code.");
  }

  const projectResponse = await fetch(`${base}/auth/newproject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: newUser.login, projectName: "OSOD DR Drill" }),
  });
  if (!projectResponse.ok) {
    throw new Error(
      `Medplum newproject failed: ${projectResponse.status} ${await projectResponse.text()}`,
    );
  }
  const newProject = (await projectResponse.json()) as { code?: string };
  if (newProject.code) {
    await exchangeRegistrationCode({ baseUrl: input.baseUrl, code: newProject.code, verifier });
  }
}

async function exchangeRegistrationCode(input: {
  baseUrl: string;
  code: string;
  verifier: string;
}): Promise<void> {
  const response = await fetch(`${input.baseUrl.replace(/\/$/, "")}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: input.verifier,
    }),
  });
  if (!response.ok) {
    throw new Error(`Medplum registration token exchange failed: ${response.status} ${await response.text()}`);
  }
}

async function loginForAccessToken(input: {
  baseUrl: string;
  email: string;
  password: string;
}): Promise<string> {
  const base = input.baseUrl.replace(/\/$/, "");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  const loginRes = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: input.email,
      password: input.password,
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    }),
  });
  if (!loginRes.ok) {
    throw new Error(`Medplum login failed: ${loginRes.status} ${await loginRes.text()}`);
  }
  const { code } = (await loginRes.json()) as { code: string };

  const tokenRes = await fetch(`${base}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`Medplum token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }
  const { access_token: token } = (await tokenRes.json()) as { access_token: string };
  return token;
}

async function resolveProjectId(input: { baseUrl: string; accessToken: string }): Promise<string> {
  const response = await fetch(`${input.baseUrl.replace(/\/$/, "")}/auth/me`, {
    headers: { Authorization: `Bearer ${input.accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`GET /auth/me failed: ${response.status} ${await response.text()}`);
  }
  const me = (await response.json()) as { project?: { id?: string } };
  if (!me.project?.id) {
    throw new Error("Could not resolve Medplum project id from /auth/me.");
  }
  return me.project.id;
}

async function createClientMembership(input: {
  baseUrl: string;
  accessToken: string;
  projectId: string;
  name: string;
  policyReference: string;
}): Promise<void> {
  const response = await fetch(
    `${input.baseUrl.replace(/\/$/, "")}/admin/projects/${input.projectId}/client`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: input.name,
        description: "OSOD v0.5b isolated DR drill membership seed",
        accessPolicy: { reference: input.policyReference },
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Client membership seed failed: ${response.status} ${await response.text()}`);
  }
}

function seedBinaryVolumeFiles(patientId: string): void {
  const dir = mkdtempSync(join(tmpdir(), "osod-dr-drill-binary-"));
  for (let index = 0; index < 4; index += 1) {
    writeFileSync(
      join(dir, `parser-accepted-${patientId}-${index + 1}.txt`),
      `parser-accepted restored binary payload ${index + 1}\n`,
    );
  }
  compose("cp", `${dir}/.`, "medplum-server:/data/binary");
}

function compose(...args: string[]): void {
  const composeArgs = [
    ...(process.env.OSOD_COMPOSE_PROJECT ? ["-p", process.env.OSOD_COMPOSE_PROJECT] : ["-p", "osod-dr-drill"]),
    ...(process.env.OSOD_COMPOSE_FILE ? ["-f", process.env.OSOD_COMPOSE_FILE] : ["-f", "docker-compose.dr-drill.yml"]),
    ...args,
  ];
  const command = hasCommand("docker-compose") ? "docker-compose" : "docker";
  const finalArgs = command === "docker" ? ["compose", ...composeArgs] : composeArgs;
  execFileSync(command, finalArgs, { stdio: "ignore" });
}

function hasCommand(command: string): boolean {
  try {
    execFileSync("which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
