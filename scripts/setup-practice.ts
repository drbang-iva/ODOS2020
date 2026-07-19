#!/usr/bin/env tsx
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import type { AccessPolicy, Practitioner, Project, ProjectMembership, User } from "@medplum/fhirtypes";
import { createLiveOdosAuditRuntime } from "../mcp/src/authz/liveAudit.js";
import { buildOdosAuditEventRow, type OdosAuditEventRecord } from "../mcp/src/authz/odosAudit.js";
import {
  grantPracticeRoles,
  type ResolvedRoleGrantTarget,
} from "../mcp/src/authz/role-grants.js";
import {
  buildMedplumAccessPolicy,
  getRoleDeclaration,
  PRACTICE_ROLE_IDS,
  type PracticeRoleId,
} from "../mcp/src/authz/roles.js";
import { createMedplumClient, type MedplumClient } from "../mcp/src/fhir-client.js";
import { searchAll } from "../mcp/src/fhir-search.js";

export const SETUP_WIZARD_HEADER =
  "Run ODOS on your own hardware. Your patients, your machines, your data.";
export const SETUP_WIZARD_ACTION_REASON = "v0.5d setup wizard first-run provisioning";
export const SETUP_WIZARD_NOOP_REASON = "v0.5d setup wizard re-run, already provisioned";

const DEFAULT_BASE_URL = "http://localhost:8103";
const DEFAULT_POSTGRES_URL = "postgresql://medplum:medplum@127.0.0.1:5432/medplum";
const DEFAULT_STATE_PATH = resolve(process.cwd(), ".odos-setup-state.json");
const FIRST_ADMIN_GRANT_ROLES = ["front-desk", "practice-admin", "clinician"] as const satisfies readonly PracticeRoleId[];
type FirstAdminGrantRole = (typeof FIRST_ADMIN_GRANT_ROLES)[number];
const FIRST_ADMIN_PRIMARY_ROLE: FirstAdminGrantRole = "front-desk";

export interface SetupPracticeConfig {
  readonly baseUrl: string;
  readonly practiceName: string;
  readonly adminEmail: string;
  readonly adminName: string;
  readonly adminPassword: string;
  readonly serviceIdentityEmail?: string;
  readonly serviceIdentityPassword?: string;
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
  readonly practitionerId?: string;
  readonly loginUrl: string;
}

export interface SetupPracticeAdapter {
  isPracticeProvisioned(config: SetupPracticeConfig, state: SetupPracticeState): Promise<boolean>;
  createOrLoginAdmin(config: SetupPracticeConfig): Promise<AdminSession>;
  createPractitioner(config: SetupPracticeConfig, session: AdminSession): Promise<Practitioner>;
  createFirstAdminAccessPolicies(config: SetupPracticeConfig, session: AdminSession): Promise<readonly {
    role: PracticeRoleId;
    policy: AccessPolicy;
    created: boolean;
  }[]>;
  grantFirstAdminRoles(input: {
    config: SetupPracticeConfig;
    session: AdminSession;
    practitioner: Practitioner;
    policies: ReadonlyMap<FirstAdminGrantRole, AccessPolicy>;
  }): Promise<{ id: string }>;
  emitAudit(row: OdosAuditEventRecord): Promise<void>;
}

export interface SetupPracticeResult {
  readonly noOp: boolean;
  readonly practitionerId?: string;
  readonly accessPolicyId?: string;
  readonly loginUrl?: string;
  readonly auditRows: readonly OdosAuditEventRecord[];
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

  if (env.ODOS_UNATTENDED_AGENT === "true") {
    throw new Error(
      "soul.md security policy: setup-practice is an interactive setup wizard, not an unattended autonomous agent.",
    );
  }
  if (/\b(?:launchd|systemd|cron|crond)\b/i.test(parentCommand)) {
    throw new Error(
      "soul.md security policy: setup-practice must be run by a human at the keyboard, not a scheduler.",
    );
  }
  if (!hasTty && env.ODOS_SETUP_INTERACTIVE_ACK !== "human-supervised") {
    throw new Error(
      "soul.md security policy: setup-practice needs a TTY or ODOS_SETUP_INTERACTIVE_ACK=human-supervised.",
    );
  }
}

export async function runSetupPractice(options: SetupPracticeOptions = {}): Promise<SetupPracticeResult> {
  if (!options.skipInteractiveBoundaryCheck) {
    assertInteractiveSetupWizardAllowed({ env: options.env });
  }

  const config = buildSetupConfig(options);
  const adapter = options.adapter ?? new LiveSetupPracticeAdapter();
  const auditRows: OdosAuditEventRecord[] = [];
  let state = readSetupState(config.statePath);

  const emit = async (row: OdosAuditEventRecord): Promise<void> => {
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

  const resolvedPolicies = await adapter.createFirstAdminAccessPolicies(config, session);
  const allPolicies = new Map<PracticeRoleId, AccessPolicy>();
  for (const resolvedPolicy of resolvedPolicies) {
    if (!resolvedPolicy.policy.id) {
      throw new Error(`Setup wizard ${resolvedPolicy.role} AccessPolicy create returned no id.`);
    }
    allPolicies.set(resolvedPolicy.role, resolvedPolicy.policy);
    if (resolvedPolicy.created) {
      await emit(
        buildSetupAuditRow({
          eventType: "create",
          resourceType: "AccessPolicy",
          resourceId: resolvedPolicy.policy.id,
          actionReason: SETUP_WIZARD_ACTION_REASON,
        }),
      );
    }
  }
  const policies = new Map<FirstAdminGrantRole, AccessPolicy>();
  for (const role of FIRST_ADMIN_GRANT_ROLES) {
    const policy = allPolicies.get(role);
    if (policy) policies.set(role, policy);
  }
  const clinicianPolicy = policies.get("clinician");
  if (!clinicianPolicy?.id || policies.size !== FIRST_ADMIN_GRANT_ROLES.length) {
    throw new Error("Setup wizard did not resolve all first-admin AccessPolicies.");
  }
  state = persistSetupState(config.statePath, {
    ...state,
    accessPolicyCreated: true,
    accessPolicyId: clinicianPolicy.id,
  });

  if (!state.accessPolicyAssigned) {
    const assignment = await adapter.grantFirstAdminRoles({
      config,
      session,
      practitioner,
      policies,
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
  readonly membership: ProjectMembership = {
    resourceType: "ProjectMembership",
    id: "project-membership-1",
    meta: { versionId: "1" },
    active: true,
    project: { reference: "Project/project-1" },
    user: { reference: "User/admin-1" },
    profile: { reference: "Practitioner/practitioner-1" },
    access: [],
  };
  readonly auditRows: OdosAuditEventRecord[] = [];
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
          system: "https://odos2020.com/fhir/NamingSystem/setup-wizard",
          value: "first-practitioner",
        },
      ],
    };
    this.practitioners.push(practitioner);
    return practitioner;
  }

  async createFirstAdminAccessPolicies(
    _config: SetupPracticeConfig,
    session: AdminSession,
  ): Promise<readonly {
    role: PracticeRoleId;
    policy: AccessPolicy;
    created: boolean;
  }[]> {
    return this.resolveCanonicalPolicies(async (role) => {
      const policy: AccessPolicy = {
        ...buildMedplumAccessPolicy(getRoleDeclaration(role)),
        id: `access-policy-${this.policies.length + 1}`,
      };
      this.policies.push(policy);
      return policy;
    });
  }

  async grantFirstAdminRoles(input: {
    config: SetupPracticeConfig;
    practitioner: Practitioner;
    policies: ReadonlyMap<FirstAdminGrantRole, AccessPolicy>;
  }): Promise<{ id: string }> {
    await grantPracticeRoles(
      firstAdminGrant(input.config.adminEmail),
      {
        serviceIdentityEmail: input.config.serviceIdentityEmail,
        resolveTarget: async () => ({ email: input.config.adminEmail, membership: this.membership }),
        resolvePolicy: async (role) => {
          const policy = input.policies.get(role as FirstAdminGrantRole);
          if (!policy) throw new Error(`${role} AccessPolicy was not resolved.`);
          return policy;
        },
        patchMembership: async (_id, operations) => {
          for (const operation of operations) {
            if (operation.path === "/access" && "value" in operation) {
              this.membership.access = operation.value as ProjectMembership["access"];
            } else if (operation.path === "/accessPolicy") {
              delete this.membership.accessPolicy;
            }
          }
          return this.membership;
        },
        recordMembershipChange: async (target, operation) => {
          const result = await operation();
          await this.emitAudit(buildSetupRoleChangeAuditRow(target));
          return result;
        },
      },
    );
    const assignment = {
      id: this.membership.id!,
      practitionerId: input.practitioner.id,
      policyId: input.policies.get("clinician")?.id,
    };
    this.assignments.push(assignment);
    return assignment;
  }

  private async resolveCanonicalPolicies(
    createPolicy: (role: PracticeRoleId) => Promise<AccessPolicy>,
  ): Promise<readonly { role: PracticeRoleId; policy: AccessPolicy; created: boolean }[]> {
    const resolved = [];
    for (const roleId of PRACTICE_ROLE_IDS) {
      const role = getRoleDeclaration(roleId);
      const policyName = `ODOS ${role.display}`;
      const existing = this.policies.filter((policy) => policy.name === policyName);
      if (existing.length > 1) {
        throw new Error(`Expected at most one ${policyName} AccessPolicy; found ${existing.length}.`);
      }
      if (existing[0]) {
        resolved.push({ role: roleId, policy: existing[0], created: false });
      } else {
        resolved.push({ role: roleId, policy: await createPolicy(roleId), created: true });
      }
    }
    return resolved;
  }

  async emitAudit(row: OdosAuditEventRecord): Promise<void> {
    this.auditRows.push(row);
  }
}

class LiveSetupPracticeAdapter implements SetupPracticeAdapter {
  private fhir?: MedplumClient;
  private serviceFhir?: MedplumClient;
  private audit?: ReturnType<typeof createLiveOdosAuditRuntime>;

  async isPracticeProvisioned(_config: SetupPracticeConfig, state: SetupPracticeState): Promise<boolean> {
    return Boolean(state.completed);
  }

  async createOrLoginAdmin(config: SetupPracticeConfig): Promise<AdminSession> {
    await waitForMedplum(config.baseUrl);
    const serviceIdentityEmail = requireConfigValue(config.serviceIdentityEmail, "MEDPLUM_ADMIN_EMAIL");
    const serviceIdentityPassword = requireConfigValue(config.serviceIdentityPassword, "MEDPLUM_ADMIN_PASSWORD");
    const serviceAccessToken = await loginForIdentity(
      config.baseUrl,
      serviceIdentityEmail,
      serviceIdentityPassword,
    );
    this.serviceFhir = createMedplumClient({ baseUrl: config.baseUrl, accessToken: serviceAccessToken });

    try {
      const accessToken = await loginForAccessToken(config);
      const projectId = await resolveProjectId({ baseUrl: config.baseUrl, accessToken });
      this.fhir = createMedplumClient({ baseUrl: config.baseUrl, accessToken });
      const membership = await this.resolveHumanMembership(config.adminEmail, projectId);
      return {
        accessToken,
        projectId,
        practitionerId: practitionerIdFromMembership(membership),
        loginUrl: `${config.baseUrl.replace(/\/$/, "")}/signin`,
      };
    } catch (loginError) {
      await ensureAdminUserAndProject(config, serviceAccessToken, this.serviceClient());
      const accessToken = await loginForAccessToken(config);
      const projectId = await resolveProjectId({ baseUrl: config.baseUrl, accessToken });
      this.fhir = createMedplumClient({ baseUrl: config.baseUrl, accessToken });
      const membership = await this.resolveHumanMembership(config.adminEmail, projectId);
      if (!membership.id) {
        throw new Error("Medplum practice provisioning returned a ProjectMembership without an id.", { cause: loginError });
      }
      return {
        accessToken,
        projectId,
        practitionerId: practitionerIdFromMembership(membership),
        loginUrl: `${config.baseUrl.replace(/\/$/, "")}/signin`,
      };
    }
  }

  async createPractitioner(config: SetupPracticeConfig, session: AdminSession): Promise<Practitioner> {
    if (session.practitionerId) {
      return this.serviceClient().read<Practitioner>("Practitioner", session.practitionerId);
    }
    return this.client().create<Practitioner>({
      resourceType: "Practitioner",
      active: true,
      name: [{ text: config.adminName }],
      telecom: [{ system: "email", value: config.adminEmail }],
      identifier: [
        {
          system: "https://odos2020.com/fhir/NamingSystem/setup-wizard",
          value: "first-practitioner",
        },
      ],
    });
  }

  async createFirstAdminAccessPolicies(
    _config: SetupPracticeConfig,
    session: AdminSession,
  ): Promise<readonly {
    role: PracticeRoleId;
    policy: AccessPolicy;
    created: boolean;
  }[]> {
    const resolved = [];
    for (const roleId of PRACTICE_ROLE_IDS) {
      const role = getRoleDeclaration(roleId);
      const policyName = `ODOS ${role.display}`;
      const existing = (await searchAll<AccessPolicy>(this.serviceClient(), "AccessPolicy", {
        "name:exact": policyName,
      })).filter((policy) => policy.name === policyName && policy.meta?.project === session.projectId);
      if (existing.length > 1) {
        throw new Error(`Expected at most one ${policyName} AccessPolicy; found ${existing.length}.`);
      }
      if (existing[0]) {
        resolved.push({ role: roleId, policy: existing[0], created: false });
      } else {
        const policy = buildMedplumAccessPolicy(role);
        resolved.push({
          role: roleId,
          policy: await this.serviceClient().create<AccessPolicy>({
            ...policy,
            meta: {
              ...policy.meta,
              project: session.projectId,
            },
          }),
          created: true,
        });
      }
    }
    return resolved;
  }

  async grantFirstAdminRoles(input: {
    config: SetupPracticeConfig;
    session: AdminSession;
    practitioner: Practitioner;
    policies: ReadonlyMap<FirstAdminGrantRole, AccessPolicy>;
  }): Promise<{ id: string }> {
    const result = await grantPracticeRoles(
      firstAdminGrant(input.config.adminEmail),
      {
        serviceIdentityEmail: input.config.serviceIdentityEmail,
        resolveTarget: async (target) => {
          const users = (await searchAll<User>(this.serviceClient(), "User", { email: target })).filter(
            (user) => user.email?.toLowerCase() === target.toLowerCase(),
          );
          if (users.length !== 1 || !users[0]?.id) {
            throw new Error(`Expected one setup User for ${target}; found ${users.length}.`);
          }
          const memberships = (await searchAll<ProjectMembership>(this.serviceClient(), "ProjectMembership", {
            user: `User/${users[0].id}`,
          })).filter((membership) => membership.project?.reference === `Project/${input.session.projectId}`);
          if (memberships.length !== 1) {
            throw new Error(`Expected one setup ProjectMembership for ${target}; found ${memberships.length}.`);
          }
          return { email: users[0].email!, membership: memberships[0]! };
        },
        resolvePolicy: async (role) => {
          const policy = input.policies.get(role as FirstAdminGrantRole);
          if (!policy) throw new Error(`${role} AccessPolicy was not resolved.`);
          return policy;
        },
        patchMembership: (id, operations, versionId) =>
          this.serviceClient().patch("ProjectMembership", id, operations, {
            "If-Match": `W/\"${versionId}\"`,
          }),
        recordMembershipChange: (target, operation) =>
          this.auditRuntime().record(buildSetupRoleChangeAuditRow(target), operation),
      },
    );
    return { id: result.membershipReference.slice("ProjectMembership/".length) };
  }

  async emitAudit(row: OdosAuditEventRecord): Promise<void> {
    await this.auditRuntime().record(row, () => undefined);
  }

  private client(): MedplumClient {
    if (!this.fhir) {
      throw new Error("Setup wizard FHIR client is not initialized.");
    }
    return this.fhir;
  }

  private serviceClient(): MedplumClient {
    if (!this.serviceFhir) {
      throw new Error("Setup wizard service-identity FHIR client is not initialized.");
    }
    return this.serviceFhir;
  }

  private async resolveHumanMembership(email: string, projectId: string): Promise<ProjectMembership> {
    const users = (await searchAll<User>(this.serviceClient(), "User", { email })).filter(
      (user) => user.email?.toLowerCase() === email.toLowerCase(),
    );
    if (users.length !== 1 || !users[0]?.id) {
      throw new Error(`Expected one setup User for ${email}; found ${users.length}.`);
    }
    const memberships = (await searchAll<ProjectMembership>(this.serviceClient(), "ProjectMembership", {
      user: `User/${users[0].id}`,
    })).filter((membership) => membership.project?.reference === `Project/${projectId}`);
    if (memberships.length !== 1) {
      throw new Error(`Expected one setup ProjectMembership for ${email}; found ${memberships.length}.`);
    }
    return memberships[0]!;
  }

  private auditRuntime(): ReturnType<typeof createLiveOdosAuditRuntime> {
    this.audit ??= createLiveOdosAuditRuntime({
      postgresUrl: process.env.ODOS_POSTGRES_URL ?? DEFAULT_POSTGRES_URL,
      disabled: process.env.ODOS_SETUP_AUDIT_DISABLED === "true",
    });
    return this.audit;
  }
}

function firstAdminGrant(target: string) {
  return {
    target,
    roles: FIRST_ADMIN_GRANT_ROLES,
    primaryRole: FIRST_ADMIN_PRIMARY_ROLE,
  };
}

function buildSetupRoleChangeAuditRow(target: ResolvedRoleGrantTarget): OdosAuditEventRecord {
  return buildOdosAuditEventRow({
    eventType: "role-change",
    actorId: "setup-wizard",
    actorRole: "system",
    resourceType: "ProjectMembership",
    resourceId: target.membership.id,
    actionOutcome: "granted",
    actionReason: `bootstrap first-admin roles for ${target.email}`,
  });
}

function buildSetupConfig(options: SetupPracticeOptions): SetupPracticeConfig {
  const env = options.env ?? process.env;
  const config = options.config ?? {};
  const resolved = {
    baseUrl: config.baseUrl ?? env.MEDPLUM_BASE_URL ?? DEFAULT_BASE_URL,
    practiceName: requireConfigValue(config.practiceName ?? env.ODOS_PRACTICE_NAME, "ODOS_PRACTICE_NAME"),
    adminEmail: requireConfigValue(config.adminEmail ?? env.ODOS_ADMIN_EMAIL, "ODOS_ADMIN_EMAIL"),
    adminName: requireConfigValue(config.adminName ?? env.ODOS_ADMIN_NAME, "ODOS_ADMIN_NAME"),
    adminPassword: requireConfigValue(
      config.adminPassword ?? env.ODOS_ADMIN_PASSWORD ?? env.MEDPLUM_ADMIN_PASSWORD,
      "ODOS_ADMIN_PASSWORD",
    ),
    serviceIdentityEmail: (config.serviceIdentityEmail ?? env.MEDPLUM_ADMIN_EMAIL)?.trim() || undefined,
    serviceIdentityPassword: config.serviceIdentityPassword ?? env.MEDPLUM_ADMIN_PASSWORD,
    postgresUrl: config.postgresUrl ?? env.ODOS_POSTGRES_URL ?? DEFAULT_POSTGRES_URL,
    statePath: options.statePath ?? config.statePath ?? env.ODOS_SETUP_STATE_PATH ?? DEFAULT_STATE_PATH,
  };
  if (
    resolved.serviceIdentityEmail &&
    resolved.adminEmail.toLowerCase() === resolved.serviceIdentityEmail.toLowerCase()
  ) {
    throw new Error(
      "ODOS_ADMIN_EMAIL must be distinct from MEDPLUM_ADMIN_EMAIL; refusing to grant first-admin practice roles to the configured Medplum service identity.",
    );
  }
  return resolved;
}

function buildSetupAuditRow(input: {
  eventType: "create" | "projectmembership-lifecycle" | "noop";
  resourceType: string;
  resourceId: string;
  actionReason: string;
}): OdosAuditEventRecord {
  return buildOdosAuditEventRow({
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
    const practiceName = process.env.ODOS_PRACTICE_NAME || (await rl.question("Practice name: "));
    const adminName = process.env.ODOS_ADMIN_NAME || (await rl.question("Admin/practitioner name: "));
    const adminEmail =
      process.env.ODOS_ADMIN_EMAIL ||
      (await rl.question("Admin email: "));
    const adminPassword =
      process.env.ODOS_ADMIN_PASSWORD ||
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

async function ensureAdminUserAndProject(
  config: SetupPracticeConfig,
  serviceAccessToken: string,
  serviceFhir: MedplumClient,
): Promise<void> {
  const users = (await searchAll<User>(serviceFhir, "User", { email: config.adminEmail })).filter(
    (user) => user.email?.toLowerCase() === config.adminEmail.toLowerCase(),
  );
  if (users.length > 1) {
    throw new Error(`Expected at most one setup User for ${config.adminEmail}; found ${users.length}.`);
  }

  if (users[0]?.id) {
    const memberships = await searchAll<ProjectMembership>(serviceFhir, "ProjectMembership", {
      user: `User/${users[0].id}`,
    });
    if (memberships.length === 0) {
      await initializePracticeProject(config, serviceAccessToken, { reference: `User/${users[0].id}` });
    } else if (memberships.length > 1) {
      throw new Error(`Expected at most one setup ProjectMembership for ${config.adminEmail}; found ${memberships.length}.`);
    }
  } else {
    await initializePracticeProject(config, serviceAccessToken, undefined);
  }

  const passwordResponse = await fetch(`${config.baseUrl.replace(/\/$/, "")}/admin/super/setpassword`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email: config.adminEmail, password: config.adminPassword }),
  });
  if (!passwordResponse.ok) {
    throw new Error(`Medplum admin set-password failed: ${passwordResponse.status} ${await passwordResponse.text()}`);
  }
}

async function initializePracticeProject(
  config: SetupPracticeConfig,
  serviceAccessToken: string,
  owner: { reference: string } | undefined,
): Promise<void> {
  const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/fhir/R4/Project/$init`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceAccessToken}`,
      "Content-Type": "application/fhir+json",
      Accept: "application/fhir+json",
    },
    body: JSON.stringify({
      resourceType: "Parameters",
      parameter: [
        { name: "name", valueString: config.practiceName },
        owner
          ? { name: "owner", valueReference: owner }
          : { name: "ownerEmail", valueString: config.adminEmail },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`Medplum Project/$init failed: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as Project | {
    resourceType?: string;
    parameter?: Array<{ name?: string; resource?: { resourceType?: string; id?: string } }>;
  };
  if (!projectFromInitResponse(body)) {
    throw new Error("Medplum Project/$init response did not include the created Project.");
  }
}

export function projectFromInitResponse(body: unknown): Project | undefined {
  if (!body || typeof body !== "object") return undefined;
  const resource = body as Project & {
    parameter?: Array<{ name?: string; resource?: Project }>;
  };
  if (resource.resourceType === "Project" && resource.id) return resource;
  const project = resource.parameter?.find((parameter) => parameter.name === "return")?.resource;
  return project?.resourceType === "Project" && project.id ? project : undefined;
}

function practitionerIdFromMembership(membership: ProjectMembership): string {
  const reference = membership.profile?.reference;
  if (!reference?.startsWith("Practitioner/") || reference.length === "Practitioner/".length) {
    throw new Error("Setup ProjectMembership does not reference a Practitioner profile.");
  }
  return reference.slice("Practitioner/".length);
}

async function loginForAccessToken(config: SetupPracticeConfig): Promise<string> {
  return loginForIdentity(config.baseUrl, config.adminEmail, config.adminPassword);
}

async function loginForIdentity(baseUrl: string, email: string, password: string): Promise<string> {
  const base = baseUrl.replace(/\/$/, "");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const loginResponse = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password,
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
