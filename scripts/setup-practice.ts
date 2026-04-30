#!/usr/bin/env tsx
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import type { AccessPolicy, Practitioner } from "@medplum/fhirtypes";
import { createLiveOsodAuditRuntime } from "../mcp/src/authz/liveAudit.js";
import { buildOsodAuditEventRow, type OsodAuditEventRecord } from "../mcp/src/authz/osodAudit.js";
import {
  buildMedplumAccessPolicy,
  getRoleDeclaration,
} from "../mcp/src/authz/roles.js";
import { createMedplumClient, type MedplumClient } from "../mcp/src/fhir-client.js";

export const SETUP_WIZARD_HEADER =
  "Run OSOD on your own hardware. Your patients, your machines, your data.";
export const SETUP_WIZARD_ACTION_REASON = "v0.5d setup wizard first-run provisioning";
export const SETUP_WIZARD_NOOP_REASON = "v0.5d setup wizard re-run, already provisioned";

const DEFAULT_BASE_URL = "http://localhost:8103";
const DEFAULT_POSTGRES_URL = "postgresql://medplum:medplum@127.0.0.1:5432/medplum";
const DEFAULT_STATE_PATH = resolve(process.cwd(), ".osod-setup-state.json");

export interface SetupPracticeConfig {
  readonly baseUrl: string;
  readonly practiceName: string;
  readonly adminEmail: string;
  readonly adminName: string;
  readonly adminPassword: string;
  readonly postgresUrl?: string;
  readonly statePath: string;
}

export interface SetupPracticeState {
  readonly version: "v0.5d";
  adminProjectCreated?: boolean;
  projectId?: string;
  practitionerCreated?: boolean;
  practitionerId?: string;
  accessPolicyCreated?: boolean;
  accessPolicyId?: string;
  accessPolicyAssigned?: boolean;
  completed?: boolean;
}

export interface AdminSession {
  readonly accessToken: string;
  readonly projectId: string;
  readonly loginUrl: string;
}

export interface SetupPracticeAdapter {
  isPracticeProvisioned(config: SetupPracticeConfig, state: SetupPracticeState): Promise<boolean>;
  createOrLoginAdmin(config: SetupPracticeConfig): Promise<AdminSession>;
  createPractitioner(config: SetupPracticeConfig, session: AdminSession): Promise<Practitioner>;
  createClinicianAccessPolicy(config: SetupPracticeConfig, session: AdminSession): Promise<AccessPolicy>;
  assignClinicianPolicy(input: {
    config: SetupPracticeConfig;
    session: AdminSession;
    practitioner: Practitioner;
    policy: AccessPolicy;
  }): Promise<{ id: string }>;
  emitAudit(row: OsodAuditEventRecord): Promise<void>;
}

export interface SetupPracticeResult {
  readonly noOp: boolean;
  readonly practitionerId?: string;
  readonly accessPolicyId?: string;
  readonly loginUrl?: string;
  readonly auditRows: readonly OsodAuditEventRecord[];
  readonly state: SetupPracticeState;
}

export interface SetupPracticeOptions {
  readonly config?: Partial<SetupPracticeConfig>;
  readonly env?: NodeJS.ProcessEnv;
  readonly adapter?: SetupPracticeAdapter;
  readonly statePath?: string;
  readonly skipInteractiveBoundaryCheck?: boolean;
}

export function assertInteractiveSetupWizardAllowed(input: {
  readonly env?: NodeJS.ProcessEnv;
  readonly hasTty?: boolean;
  readonly parentCommand?: string;
} = {}): void {
  const env = input.env ?? process.env;
  const hasTty = input.hasTty ?? Boolean(process.stdin.isTTY);
  const parentCommand = input.parentCommand ?? "";

  if (env.OSOD_UNATTENDED_AGENT === "true") {
    throw new Error(
      "soul.md security policy: setup-practice is an interactive setup wizard, not an unattended autonomous agent.",
    );
  }
  if (/\b(?:launchd|systemd|cron|crond)\b/i.test(parentCommand)) {
    throw new Error(
      "soul.md security policy: setup-practice must be run by a human at the keyboard, not a scheduler.",
    );
  }
  if (!hasTty && env.OSOD_SETUP_INTERACTIVE_ACK !== "human-supervised") {
    throw new Error(
      "soul.md security policy: setup-practice needs a TTY or OSOD_SETUP_INTERACTIVE_ACK=human-supervised.",
    );
  }
}

export async function runSetupPractice(options: SetupPracticeOptions = {}): Promise<SetupPracticeResult> {
  if (!options.skipInteractiveBoundaryCheck) {
    assertInteractiveSetupWizardAllowed({ env: options.env });
  }

  const config = buildSetupConfig(options);
  const adapter = options.adapter ?? new LiveSetupPracticeAdapter();
  const auditRows: OsodAuditEventRecord[] = [];
  let state = readSetupState(config.statePath);

  const emit = async (row: OsodAuditEventRecord): Promise<void> => {
    auditRows.push(row);
    await adapter.emitAudit(row);
  };

  if (await adapter.isPracticeProvisioned(config, state)) {
    const row = buildSetupAuditRow({
      eventType: "noop",
      resourceType: "SetupPractice",
      resourceId: "already-provisioned",
      actionReason: SETUP_WIZARD_NOOP_REASON,
    });
    await emit(row);
    return { noOp: true, auditRows, state };
  }

  const session = await adapter.createOrLoginAdmin(config);
  state = persistSetupState(config.statePath, {
    ...state,
    adminProjectCreated: true,
    projectId: session.projectId,
  });
  await emit(
    buildSetupAuditRow({
      eventType: "create",
      resourceType: "Project",
      resourceId: session.projectId,
      actionReason: SETUP_WIZARD_ACTION_REASON,
    }),
  );

  let practitioner: Practitioner | undefined;
  if (state.practitionerCreated && state.practitionerId) {
    practitioner = { resourceType: "Practitioner", id: state.practitionerId };
  } else {
    practitioner = await adapter.createPractitioner(config, session);
    if (!practitioner.id) {
      throw new Error("Setup wizard Practitioner create returned no id.");
    }
    state = persistSetupState(config.statePath, {
      ...state,
      practitionerCreated: true,
      practitionerId: practitioner.id,
    });
    await emit(
      buildSetupAuditRow({
        eventType: "create",
        resourceType: "Practitioner",
        resourceId: practitioner.id,
        actionReason: SETUP_WIZARD_ACTION_REASON,
      }),
    );
  }

  let policy: AccessPolicy | undefined;
  if (state.accessPolicyCreated && state.accessPolicyId) {
    policy = { resourceType: "AccessPolicy", id: state.accessPolicyId };
  } else {
    policy = await adapter.createClinicianAccessPolicy(config, session);
    if (!policy.id) {
      throw new Error("Setup wizard AccessPolicy create returned no id.");
    }
    state = persistSetupState(config.statePath, {
      ...state,
      accessPolicyCreated: true,
      accessPolicyId: policy.id,
    });
    await emit(
      buildSetupAuditRow({
        eventType: "create",
        resourceType: "AccessPolicy",
        resourceId: policy.id,
        actionReason: SETUP_WIZARD_ACTION_REASON,
      }),
    );
  }

  if (!state.accessPolicyAssigned) {
    const assignment = await adapter.assignClinicianPolicy({
      config,
      session,
      practitioner,
      policy,
    });
    state = persistSetupState(config.statePath, {
      ...state,
      accessPolicyAssigned: true,
      completed: true,
    });
    await emit(
      buildSetupAuditRow({
        eventType: "projectmembership-lifecycle",
        resourceType: "ProjectMembership",
        resourceId: assignment.id,
        actionReason: SETUP_WIZARD_ACTION_REASON,
      }),
    );
  } else {
    state = persistSetupState(config.statePath, { ...state, completed: true });
  }

  return {
    noOp: false,
    practitionerId: state.practitionerId,
    accessPolicyId: state.accessPolicyId,
    loginUrl: session.loginUrl,
    auditRows,
    state,
  };
}

export class InMemorySetupPracticeAdapter implements SetupPracticeAdapter {
  readonly admins: AdminSession[] = [];
  readonly practitioners: Practitioner[] = [];
  readonly policies: AccessPolicy[] = [];
  readonly assignments: { id: string; practitionerId?: string; policyId?: string }[] = [];
  readonly auditRows: OsodAuditEventRecord[] = [];
  practiceProvisioned = false;

  async isPracticeProvisioned(_config: SetupPracticeConfig, state: SetupPracticeState): Promise<boolean> {
    return this.practiceProvisioned || Boolean(state.completed);
  }

  async createOrLoginAdmin(config: SetupPracticeConfig): Promise<AdminSession> {
    const session = {
      accessToken: "in-memory-token",
      projectId: `project-${this.admins.length + 1}`,
      loginUrl: `${config.baseUrl.replace(/\/$/, "")}/signin`,
    };
    this.admins.push(session);
    return session;
  }

  async createPractitioner(config: SetupPracticeConfig): Promise<Practitioner> {
    const practitioner: Practitioner = {
      resourceType: "Practitioner",
      id: `practitioner-${this.practitioners.length + 1}`,
      active: true,
      name: [{ text: config.adminName }],
      telecom: [{ system: "email", value: config.adminEmail }],
      identifier: [
        {
          system: "https://osod.dev/fhir/NamingSystem/setup-wizard",
          value: "first-practitioner",
        },
      ],
    };
    this.practitioners.push(practitioner);
    return practitioner;
  }

  async createClinicianAccessPolicy(): Promise<AccessPolicy> {
    const policy: AccessPolicy = {
      ...buildMedplumAccessPolicy(getRoleDeclaration("clinician")),
      id: `access-policy-${this.policies.length + 1}`,
      name: "OSOD Clinician",
    };
    this.policies.push(policy);
    return policy;
  }

  async assignClinicianPolicy(input: {
    practitioner: Practitioner;
    policy: AccessPolicy;
  }): Promise<{ id: string }> {
    const assignment = {
      id: `project-membership-${this.assignments.length + 1}`,
      practitionerId: input.practitioner.id,
      policyId: input.policy.id,
    };
    this.assignments.push(assignment);
    return assignment;
  }

  async emitAudit(row: OsodAuditEventRecord): Promise<void> {
    this.auditRows.push(row);
  }
}

class LiveSetupPracticeAdapter implements SetupPracticeAdapter {
  private fhir?: MedplumClient;
  private audit?: ReturnType<typeof createLiveOsodAuditRuntime>;

  async isPracticeProvisioned(_config: SetupPracticeConfig, state: SetupPracticeState): Promise<boolean> {
    return Boolean(state.completed);
  }

  async createOrLoginAdmin(config: SetupPracticeConfig): Promise<AdminSession> {
    await waitForMedplum(config.baseUrl);
    try {
      const accessToken = await loginForAccessToken(config);
      const projectId = await resolveProjectId({ baseUrl: config.baseUrl, accessToken });
      this.fhir = createMedplumClient({ baseUrl: config.baseUrl, accessToken });
      return { accessToken, projectId, loginUrl: `${config.baseUrl.replace(/\/$/, "")}/signin` };
    } catch {
      await createAdminUserAndProject(config);
      const accessToken = await loginForAccessToken(config);
      const projectId = await resolveProjectId({ baseUrl: config.baseUrl, accessToken });
      this.fhir = createMedplumClient({ baseUrl: config.baseUrl, accessToken });
      return { accessToken, projectId, loginUrl: `${config.baseUrl.replace(/\/$/, "")}/signin` };
    }
  }

  async createPractitioner(config: SetupPracticeConfig): Promise<Practitioner> {
    return this.client().create<Practitioner>({
      resourceType: "Practitioner",
      active: true,
      name: [{ text: config.adminName }],
      telecom: [{ system: "email", value: config.adminEmail }],
      identifier: [
        {
          system: "https://osod.dev/fhir/NamingSystem/setup-wizard",
          value: "first-practitioner",
        },
      ],
    });
  }

  async createClinicianAccessPolicy(): Promise<AccessPolicy> {
    return this.client().create<AccessPolicy>({
      ...buildMedplumAccessPolicy(getRoleDeclaration("clinician")),
      name: `OSOD Clinician ${Date.now()}`,
    });
  }

  async assignClinicianPolicy(input: {
    config: SetupPracticeConfig;
    session: AdminSession;
    practitioner: Practitioner;
    policy: AccessPolicy;
  }): Promise<{ id: string }> {
    const response = await fetch(
      `${input.config.baseUrl.replace(/\/$/, "")}/admin/projects/${input.session.projectId}/client`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.session.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: `osod-first-clinician-${Date.now()}`,
          description: `OSOD v0.5d setup wizard clinician access for Practitioner/${input.practitioner.id}`,
          accessPolicy: { reference: `AccessPolicy/${input.policy.id}` },
        }),
      },
    );
    const body = await response.text();
    if (!response.ok) {
      throw new Error(
        `Medplum admin project client create failed: ${response.status} ${body}`,
      );
    }
    return JSON.parse(body) as { id: string };
  }

  async emitAudit(row: OsodAuditEventRecord): Promise<void> {
    this.audit ??= createLiveOsodAuditRuntime({
      postgresUrl: process.env.OSOD_POSTGRES_URL ?? DEFAULT_POSTGRES_URL,
      disabled: process.env.OSOD_SETUP_AUDIT_DISABLED === "true",
    });
    await this.audit.record(row, () => undefined);
  }

  private client(): MedplumClient {
    if (!this.fhir) {
      throw new Error("Setup wizard FHIR client is not initialized.");
    }
    return this.fhir;
  }
}

function buildSetupConfig(options: SetupPracticeOptions): SetupPracticeConfig {
  const env = options.env ?? process.env;
  const config = options.config ?? {};
  return {
    baseUrl: config.baseUrl ?? env.MEDPLUM_BASE_URL ?? DEFAULT_BASE_URL,
    practiceName: requireConfigValue(config.practiceName ?? env.OSOD_PRACTICE_NAME, "OSOD_PRACTICE_NAME"),
    adminEmail: requireConfigValue(config.adminEmail ?? env.OSOD_ADMIN_EMAIL ?? env.MEDPLUM_ADMIN_EMAIL, "OSOD_ADMIN_EMAIL"),
    adminName: requireConfigValue(config.adminName ?? env.OSOD_ADMIN_NAME, "OSOD_ADMIN_NAME"),
    adminPassword: requireConfigValue(
      config.adminPassword ?? env.OSOD_ADMIN_PASSWORD ?? env.MEDPLUM_ADMIN_PASSWORD,
      "OSOD_ADMIN_PASSWORD",
    ),
    postgresUrl: config.postgresUrl ?? env.OSOD_POSTGRES_URL ?? DEFAULT_POSTGRES_URL,
    statePath: options.statePath ?? config.statePath ?? env.OSOD_SETUP_STATE_PATH ?? DEFAULT_STATE_PATH,
  };
}

function buildSetupAuditRow(input: {
  eventType: "create" | "projectmembership-lifecycle" | "noop";
  resourceType: string;
  resourceId: string;
  actionReason: string;
}): OsodAuditEventRecord {
  return buildOsodAuditEventRow({
    eventType: input.eventType,
    actorId: "setup-wizard",
    actorRole: "system",
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    actionOutcome: "granted",
    actionReason: input.actionReason,
  });
}

function readSetupState(path: string): SetupPracticeState {
  if (!existsSync(path)) {
    return { version: "v0.5d" };
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as SetupPracticeState;
  return { version: "v0.5d", ...parsed };
}

function persistSetupState(path: string, state: SetupPracticeState): SetupPracticeState {
  writeFileSync(path, JSON.stringify({ version: "v0.5d", ...state }, null, 2) + "\n");
  return { version: "v0.5d", ...state };
}

function requireConfigValue(value: string | undefined, name: string): string {
  if (!value || !value.trim()) {
    throw new Error(`${name} is required. Provide it as an environment variable or run the CLI interactively.`);
  }
  return value.trim();
}

async function collectInteractiveConfig(): Promise<Partial<SetupPracticeConfig>> {
  const rl = createInterface({ input, output });
  try {
    console.log(SETUP_WIZARD_HEADER);
    const practiceName = process.env.OSOD_PRACTICE_NAME || (await rl.question("Practice name: "));
    const adminName = process.env.OSOD_ADMIN_NAME || (await rl.question("Admin/practitioner name: "));
    const adminEmail =
      process.env.OSOD_ADMIN_EMAIL ||
      process.env.MEDPLUM_ADMIN_EMAIL ||
      (await rl.question("Admin email: "));
    const adminPassword =
      process.env.OSOD_ADMIN_PASSWORD ||
      process.env.MEDPLUM_ADMIN_PASSWORD ||
      (await rl.question("Admin password (input will be visible in this preview build): "));
    return { practiceName, adminName, adminEmail, adminPassword };
  } finally {
    rl.close();
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
  throw new Error(`Timed out waiting for local Medplum at ${base}`, { cause: lastError });
}

async function createAdminUserAndProject(config: SetupPracticeConfig): Promise<void> {
  const base = config.baseUrl.replace(/\/$/, "");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const [firstName, ...lastParts] = config.adminName.split(/\s+/);
  const response = await fetch(`${base}/auth/newuser`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId: "new",
      firstName: firstName || "OSOD",
      lastName: lastParts.join(" ") || "Admin",
      email: config.adminEmail,
      password: config.adminPassword,
      remember: false,
      codeChallengeMethod: "S256",
      codeChallenge: challenge,
      recaptchaToken: "",
    }),
  });
  if (!response.ok) {
    throw new Error(`Medplum auth/newuser failed: ${response.status} ${await response.text()}`);
  }
  const newUser = (await response.json()) as { login?: string; code?: string };
  if (newUser.code) {
    await exchangeRegistrationCode({ baseUrl: config.baseUrl, code: newUser.code, verifier });
    return;
  }
  if (!newUser.login) {
    throw new Error("Medplum auth/newuser response did not include login or code.");
  }
  const projectResponse = await fetch(`${base}/auth/newproject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: newUser.login, projectName: config.practiceName }),
  });
  if (!projectResponse.ok) {
    throw new Error(`Medplum auth/newproject failed: ${projectResponse.status} ${await projectResponse.text()}`);
  }
  const newProject = (await projectResponse.json()) as { code?: string };
  if (newProject.code) {
    await exchangeRegistrationCode({ baseUrl: config.baseUrl, code: newProject.code, verifier });
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

async function loginForAccessToken(config: SetupPracticeConfig): Promise<string> {
  const base = config.baseUrl.replace(/\/$/, "");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const loginResponse = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: config.adminEmail,
      password: config.adminPassword,
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    }),
  });
  if (!loginResponse.ok) {
    throw new Error(`Medplum login failed: ${loginResponse.status} ${await loginResponse.text()}`);
  }
  const { code } = (await loginResponse.json()) as { code: string };
  const tokenResponse = await fetch(`${base}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
    }),
  });
  if (!tokenResponse.ok) {
    throw new Error(`Medplum token exchange failed: ${tokenResponse.status} ${await tokenResponse.text()}`);
  }
  const { access_token: accessToken } = (await tokenResponse.json()) as { access_token: string };
  return accessToken;
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

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    assertInteractiveSetupWizardAllowed();
    const interactiveConfig = process.stdin.isTTY ? await collectInteractiveConfig() : {};
    const result = await runSetupPractice({
      config: interactiveConfig,
      skipInteractiveBoundaryCheck: true,
    });
    if (result.noOp) {
      console.log("Practice already provisioned. To re-provision, see docs/install.md §Re-provisioning.");
    } else {
      console.log(`Setup complete. Practitioner: ${result.practitionerId}`);
      console.log(`Login URL: ${result.loginUrl ?? DEFAULT_BASE_URL}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
