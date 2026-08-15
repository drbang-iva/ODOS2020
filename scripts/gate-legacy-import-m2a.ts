import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  AccessPolicy,
  Coverage,
  Encounter,
  Media,
  Observation,
  Patient,
  Practitioner,
  ProjectMembership,
} from "@medplum/fhirtypes";
import { exchangeClientCredentials } from "../data/medplum-adapters/migration-importer-adapter.js";
import {
  grantPracticeRoles,
  type ResolvedRoleGrantTarget,
} from "../mcp/src/authz/role-grants.js";
import {
  getRoleDeclaration,
  ODOS_PRACTICE_ROLE_SYSTEM,
  type PracticeRoleId,
} from "../mcp/src/authz/roles.js";
import { createOperatorScriptFhirClient, type MedplumClient } from "../mcp/src/fhir-client.js";
import { searchAll } from "../mcp/src/fhir-search.js";
import { assertCanonicalPolicyRules } from "./access-policy-rules.js";
import { runGrantCli } from "./grant-migrated-patient-access.js";
import { runPatientImportCli } from "./import-legacy-patient-m2a.js";
import {
  assertCanonicalClinicianPolicy,
  assertLocalBaseUrl,
  setupLegacyImporter,
} from "./setup-legacy-importer.js";
import { runSetupPractice } from "./setup-practice.js";
import {
  verifyImporterProjectMembershipDenied,
  verifyLegacyImportM2aReachability,
} from "./verify-legacy-import-m2a.js";

const headSha = requiredEnv("GATE_HEAD_SHA");
const baseUrl = requiredEnv("MEDPLUM_BASE_URL");
assertLocalBaseUrl(baseUrl);
const postgresUrl = requiredEnv("ODOS_POSTGRES_URL");
const stateDirectory = requiredEnv("ODOS_M2A_STATE_DIR");
const credentialsPath = join(process.cwd(), ".odos", "migration-importer.env");
const manifestPath = join(stateDirectory, "m2a-synthetic-source.json");
const setupStatePath = join(stateDirectory, "setup-state.json");

if (!/^[0-9a-f]{40}$/.test(headSha)) throw new Error("GATE_HEAD_SHA must be a full SHA.");
const actualHeadSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: process.cwd(),
  encoding: "utf8",
}).trim();
if (actualHeadSha !== headSha) {
  throw new Error(`GATE_HEAD_SHA ${headSha} does not match checked-out HEAD ${actualHeadSha}.`);
}
mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
chmodSync(stateDirectory, 0o700);

const serviceEmail = requiredEnv("MEDPLUM_ADMIN_EMAIL");
const servicePassword = requiredEnv("MEDPLUM_ADMIN_PASSWORD");
const suffix = headSha.slice(0, 7);
const invocationId = randomBytes(6).toString("hex");
const practiceAdminEmail = `m2a-admin-${suffix}@example.test`;
const clinicianEmail = `m2a-clinician-${suffix}@example.test`;
const frontDeskEmail = `m2a-front-desk-${suffix}@example.test`;
const practiceAdminPassword = randomBytes(24).toString("base64url");
const clinicianPassword = randomBytes(24).toString("base64url");
const frontDeskPassword = randomBytes(24).toString("base64url");

const serviceToken = await login(baseUrl, serviceEmail, servicePassword);
process.env.ODOS_SETUP_AUDIT_DISABLED = "true";
const setup = await runSetupPractice({
  config: {
    baseUrl,
    practiceName: `ODOS M2a Gate ${suffix}`,
    adminEmail: practiceAdminEmail,
    adminName: "M2a Gate Admin",
    adminPassword: practiceAdminPassword,
    serviceIdentityEmail: serviceEmail,
    serviceIdentityPassword: servicePassword,
    postgresUrl,
    statePath: setupStatePath,
  },
  statePath: setupStatePath,
  skipInteractiveBoundaryCheck: true,
});
const projectId = setup.state.projectId;
if (!projectId) throw new Error("Setup did not return the practice project id.");

await setPassword(
  baseUrl,
  serviceToken,
  practiceAdminEmail,
  practiceAdminPassword,
  "Practice admin",
);
const operatorToken = await login(baseUrl, practiceAdminEmail, practiceAdminPassword);
const serviceFhir = createOperatorScriptFhirClient({
  baseUrl,
  accessToken: serviceToken,
  reason: "Operator legacy import gate service check runs outside request handling.",
});
const adminFhir = createOperatorScriptFhirClient({
  baseUrl,
  accessToken: operatorToken,
  reason: "Operator legacy import gate admin check runs outside request handling.",
});
const clinicianMembership = await inviteOrdinaryUser({
  baseUrl,
  serviceToken,
  projectId,
  email: clinicianEmail,
  firstName: "M2a",
  lastName: "Clinician",
  password: clinicianPassword,
});
const frontDeskMembership = await inviteOrdinaryUser({
  baseUrl,
  serviceToken,
  projectId,
  email: frontDeskEmail,
  firstName: "M2a",
  lastName: "Front Desk",
  password: frontDeskPassword,
});
await grantRole(adminFhir, clinicianMembership, clinicianEmail, "provider");
await grantRole(adminFhir, frontDeskMembership, frontDeskEmail, "staff");

const clinicianProfileReference = requiredProfile(clinicianMembership);
const frontDeskProfileReference = requiredProfile(frontDeskMembership);
const clinicianToken = await login(baseUrl, clinicianEmail, clinicianPassword);
const frontDeskToken = await login(baseUrl, frontDeskEmail, frontDeskPassword);

try {
await setupLegacyImporter({
  baseUrl,
  accessToken: operatorToken,
  statePath: join(process.cwd(), ".odos", "migration-importer-state.json"),
  credentialsPath,
  postgresUrl,
  practiceProjectId: projectId,
});
appendFileSync(
  credentialsPath,
  [
    `ODOS_OPERATOR_ACCESS_TOKEN=${operatorToken}`,
    `ODOS_ACCEPTANCE_CLINICIAN_ACCESS_TOKEN=${clinicianToken}`,
    `ODOS_ACCEPTANCE_FRONT_DESK_ACCESS_TOKEN=${frontDeskToken}`,
    "",
  ].join("\n"),
  { mode: 0o600 },
);
chmodSync(credentialsPath, 0o600);
process.loadEnvFile(credentialsPath);

writeFileSync(
  manifestPath,
  JSON.stringify({
    epm: {
      sourceKey: `synthetic-epm-${suffix}`,
      firstName: "Synthetic",
      lastName: "Gate",
      birthDate: "1980-01-01",
      gender: "unknown",
    },
    ehr: {
      sourceKey: `synthetic-ehr-${suffix}`,
      firstName: "Synthetic",
      lastName: "Gate",
      birthDate: "1980-01-01",
    },
    junkRows: [{
      sourceSystem: "ehr",
      sourceKey: `synthetic-junk-${suffix}`,
      firstName: "Junk",
      lastName: "Gate",
      birthDate: "9999-12-31",
    }],
  }),
  { mode: 0o600 },
);

const firstImport = await runPatientImportCli({
  baseUrl,
  manifestPath,
  stateDirectory,
  runId: `m2a-gate-${suffix}-${invocationId}-first`,
  clientId: requiredEnv("ODOS_MIGRATION_IMPORTER_CLIENT_ID"),
  clientSecret: requiredEnv("ODOS_MIGRATION_IMPORTER_CLIENT_SECRET"),
});
if (!firstImport.patientReference) throw new Error("First import returned no Patient reference.");
const firstGrant = await runGrantCli({
  baseUrl,
  accessToken: requiredEnv("ODOS_OPERATOR_ACCESS_TOKEN"),
  stateDirectory,
  runId: firstImport.runId,
  patientReference: firstImport.patientReference,
  clinicianProfileReference,
  frontDeskProfileReference,
});

const secondImport = await runPatientImportCli({
  baseUrl,
  manifestPath,
  stateDirectory,
  runId: `m2a-gate-${suffix}-${invocationId}-second`,
  clientId: requiredEnv("ODOS_MIGRATION_IMPORTER_CLIENT_ID"),
  clientSecret: requiredEnv("ODOS_MIGRATION_IMPORTER_CLIENT_SECRET"),
});
const secondGrant = await runGrantCli({
  baseUrl,
  accessToken: requiredEnv("ODOS_OPERATOR_ACCESS_TOKEN"),
  stateDirectory,
  runId: secondImport.runId,
  patientReference: firstImport.patientReference,
  clinicianProfileReference,
  frontDeskProfileReference,
});

const patientId = firstImport.patientReference.slice("Patient/".length);
const patient = await adminFhir.read<Patient>("Patient", patientId);
const encounter = await adminFhir.create<Encounter>({
  resourceType: "Encounter",
  status: "finished",
  class: {
    system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
    code: "AMB",
  },
  subject: { reference: firstImport.patientReference },
});
const media = await adminFhir.create<Media>({
  resourceType: "Media",
  status: "completed",
  subject: { reference: firstImport.patientReference },
  content: {
    contentType: "text/plain",
    data: Buffer.from("synthetic M2a gate media").toString("base64"),
  },
});
const coverage = await adminFhir.create<Coverage>({
  resourceType: "Coverage",
  status: "active",
  beneficiary: { reference: firstImport.patientReference },
  payor: [{ display: "Synthetic M2a Gate Payer" }],
});
const observation = await adminFhir.create<Observation>({
  resourceType: "Observation",
  status: "final",
  code: { text: "Synthetic M2a gate observation" },
  subject: { reference: firstImport.patientReference },
});
for (const resource of [encounter, media, coverage, observation]) {
  if (!resource.id) throw new Error(`${resource.resourceType} create returned no id.`);
}

const reachability = await verifyLegacyImportM2aReachability({
  baseUrl,
  clinicianToken: requiredEnv("ODOS_ACCEPTANCE_CLINICIAN_ACCESS_TOKEN"),
  frontDeskToken: requiredEnv("ODOS_ACCEPTANCE_FRONT_DESK_ACCESS_TOKEN"),
  clinicianProfileReference,
  frontDeskProfileReference,
  patientReference: firstImport.patientReference,
  encounterReference: `Encounter/${encounter.id}`,
  mediaReference: `Media/${media.id}`,
  coverageReference: `Coverage/${coverage.id}`,
  observationReference: `Observation/${observation.id}`,
});

const importerToken = await exchangeClientCredentials({
  baseUrl,
  clientId: requiredEnv("ODOS_MIGRATION_IMPORTER_CLIENT_ID"),
  clientSecret: requiredEnv("ODOS_MIGRATION_IMPORTER_CLIENT_SECRET"),
});
const importerMembershipStatus = await verifyImporterProjectMembershipDenied({
  baseUrl,
  importerToken,
});
const clinicianGrant = await serviceFhir.read<ProjectMembership>(
  "ProjectMembership",
  clinicianMembership.id!,
);
const frontDeskGrant = await serviceFhir.read<ProjectMembership>(
  "ProjectMembership",
  frontDeskMembership.id!,
);

console.log(`head_sha=${headSha}`);
console.log(`token_source=.odos/migration-importer.env mode=${(statSync(credentialsPath).mode & 0o777).toString(8)}`);
console.log(`first Patient action=${firstImport.action}; second Patient action=${secondImport.action}`);
console.log(
  `first grants: generalPractitioner=${firstGrant.generalPractitioner},`
  + `clinician=${firstGrant.clinicianMembership},front-desk=${firstGrant.frontDeskMembership}`,
);
console.log(
  `second grants: generalPractitioner=${secondGrant.generalPractitioner},`
  + `clinician=${secondGrant.clinicianMembership},front-desk=${secondGrant.frontDeskMembership}`,
);
console.log(`junk rejections per run: first=${firstImport.junkRejections}, second=${secondImport.junkRejections}`);
console.log(`Patient identifiers=${patient.identifier?.length ?? 0}; generalPractitioner=${patient.generalPractitioner?.length ?? 0}`);
console.log(`clinician grant parameters=${patientParameterNames(clinicianGrant).join(",")}`);
console.log(`front-desk grant parameters=${patientParameterNames(frontDeskGrant).join(",")}`);
console.log(`importer ProjectMembership search=${importerMembershipStatus}`);
console.log(reachability.transcript.join("\n"));
console.log("LEGACY_IMPORT_M2A_REACHABILITY PASS");
} finally {
  rmSync(credentialsPath, { force: true });
  rmSync(manifestPath, { force: true });
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function login(url: string, email: string, password: string): Promise<string> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const loginResponse = await fetch(`${url}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
      }),
    });
    if (loginResponse.status === 429) {
      await waitForRateLimit(loginResponse);
      continue;
    }
    if (!loginResponse.ok) throw new Error(`Login failed: ${loginResponse.status}.`);
    const { code } = (await loginResponse.json()) as { code: string };
    const tokenResponse = await fetch(`${url}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
      }),
    });
    if (tokenResponse.status === 429) {
      await waitForRateLimit(tokenResponse);
      continue;
    }
    if (!tokenResponse.ok) throw new Error(`Token exchange failed: ${tokenResponse.status}.`);
    const { access_token: accessToken } = (await tokenResponse.json()) as {
      access_token?: string;
    };
    if (!accessToken) throw new Error("Token exchange returned no access token.");
    return accessToken;
  }
  throw new Error("Login failed: 429 after 10 attempts.");
}

async function waitForRateLimit(response: Response): Promise<void> {
  const retryAfterSeconds = Number(response.headers.get("retry-after") ?? "10");
  const delaySeconds = Number.isFinite(retryAfterSeconds)
    ? Math.max(retryAfterSeconds, 10)
    : 10;
  await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1_000));
}

async function inviteOrdinaryUser(input: {
  baseUrl: string;
  serviceToken: string;
  projectId: string;
  email: string;
  firstName: string;
  lastName: string;
  password: string;
}): Promise<ProjectMembership> {
  const inviteResponse = await fetch(
    `${input.baseUrl}/admin/projects/${input.projectId}/invite`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.serviceToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        resourceType: "Practitioner",
        email: input.email,
        firstName: input.firstName,
        lastName: input.lastName,
        sendEmail: false,
      }),
    },
  );
  let resolvedMembership: ProjectMembership;
  if (inviteResponse.ok) {
    resolvedMembership = (await inviteResponse.json()) as ProjectMembership;
    if (
      !resolvedMembership.id
      || !resolvedMembership.meta?.versionId
      || !resolvedMembership.profile?.reference
    ) {
      resolvedMembership = await resolveOrdinaryMembership(input);
    }
  } else if (inviteResponse.status === 409) {
    resolvedMembership = await resolveOrdinaryMembership(input);
  } else {
    throw new Error(`Practitioner invite failed: ${inviteResponse.status}.`);
  }
  if (
    !resolvedMembership.id
    || !resolvedMembership.meta?.versionId
    || !resolvedMembership.profile?.reference
  ) {
    throw new Error("Persisted Practitioner membership is incomplete.");
  }
  await setPassword(
    input.baseUrl,
    input.serviceToken,
    input.email,
    input.password,
    "Invited practitioner",
  );
  return resolvedMembership;
}

async function resolveOrdinaryMembership(input: {
  baseUrl: string;
  serviceToken: string;
  projectId: string;
  email: string;
}): Promise<ProjectMembership> {
  const serviceFhir = createOperatorScriptFhirClient({
    baseUrl: input.baseUrl,
    accessToken: input.serviceToken,
    reason: "Operator legacy import gate invitation runs outside request handling.",
  });
  const practitioners = (await searchAll<Practitioner>(
    serviceFhir,
    "Practitioner",
    { email: input.email },
  )).filter((practitioner) =>
    practitioner.telecom?.some((telecom) =>
      telecom.system === "email" && telecom.value?.toLowerCase() === input.email.toLowerCase()
    )
  );
  const persistedMemberships = (
    await Promise.all(
      practitioners
        .filter((practitioner) => practitioner.id)
        .map((practitioner) =>
          searchAll<ProjectMembership>(
            serviceFhir,
            "ProjectMembership",
            { profile: `Practitioner/${practitioner.id}` },
          )
        ),
    )
  ).flat().filter((candidate) =>
    candidate.project.reference === `Project/${input.projectId}`
  );
  if (persistedMemberships.length !== 1) {
    throw new Error(
      `Practitioner invite resolved ${persistedMemberships.length} complete memberships.`,
    );
  }
  return persistedMemberships[0]!;
}

async function setPassword(
  baseUrl: string,
  serviceToken: string,
  email: string,
  password: string,
  label: string,
): Promise<void> {
  const passwordResponse = await fetch(`${baseUrl}/admin/super/setpassword`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  });
  if (!passwordResponse.ok) {
    throw new Error(`${label} set password failed: ${passwordResponse.status}.`);
  }
}

async function grantRole(
  fhir: MedplumClient,
  membership: ProjectMembership,
  email: string,
  role: Extract<PracticeRoleId, "provider" | "staff">,
): Promise<void> {
  await grantPracticeRoles(
    {
      target: `ProjectMembership/${membership.id}`,
      roles: [role],
      primaryRole: role,
    },
    {
      resolveTarget: async (): Promise<ResolvedRoleGrantTarget> => ({ email, membership }),
      resolvePolicy: async (requestedRole): Promise<AccessPolicy> => {
        const expectedName = `ODOS ${getRoleDeclaration(requestedRole).display}`;
        const policies = (await searchAll<AccessPolicy>(
          fhir,
          "AccessPolicy",
          { "name:exact": expectedName },
        )).filter((policy) =>
          policy.name === expectedName
          && policy.meta?.tag?.some((tag) =>
            tag.system === ODOS_PRACTICE_ROLE_SYSTEM && tag.code === requestedRole
          )
        );
        if (policies.length !== 1) {
          throw new Error(`Expected one ${requestedRole} AccessPolicy; found ${policies.length}.`);
        }
        const policy = policies[0]!;
        if (requestedRole === "provider") {
          assertCanonicalClinicianPolicy({
            projectId: membership.project.reference?.replace(/^Project\//, "") ?? "unknown",
            projectName: "M2a gate practice",
            policyId: policy.id ?? "unpersisted",
            policy,
          });
        } else if (requestedRole === "staff") {
          assertCanonicalPolicyRules(policy, "staff");
        } else {
          throw new Error(`M2a gate cannot grant the ${requestedRole} role.`);
        }
        return policy;
      },
      resolveBoundPolicy: async (reference): Promise<AccessPolicy | undefined> => {
        const id = reference.match(/^AccessPolicy\/([^/]+)$/)?.[1];
        return id ? fhir.read<AccessPolicy>("AccessPolicy", id) : undefined;
      },
      patchMembership: (id, operations, versionId) =>
        fhir.patch("ProjectMembership", id, operations, {
          "If-Match": `W/"${versionId}"`,
        }),
      recordMembershipChange: async (_target, operation) => operation(),
    },
  );
}

function requiredProfile(membership: ProjectMembership): string {
  const reference = membership.profile?.reference;
  if (!reference?.startsWith("Practitioner/")) {
    throw new Error("Ordinary membership has no Practitioner profile.");
  }
  return reference;
}

function patientParameterNames(membership: ProjectMembership): string[] {
  return (membership.access ?? [])
    .flatMap((access) => access.parameter ?? [])
    .filter((parameter) =>
      parameter.name === "provider_profile"
      || parameter.name === "patient_compartment"
    )
    .map((parameter) => parameter.name!);
}
