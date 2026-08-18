#!/usr/bin/env tsx
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import type {
  AccessPolicy,
  Basic,
  HealthcareService,
  Location,
  Organization,
  Practitioner,
  Project,
  ProjectMembership,
  Schedule,
  User,
} from "@medplum/fhirtypes";
import { createLiveOdosAuditRuntime } from "../mcp/src/authz/liveAudit.js";
import { buildOdosAuditEventRow, type OdosAuditEventRecord } from "../mcp/src/authz/odosAudit.js";
import {
  grantPracticeRoles,
  type ResolvedRoleGrantTarget,
} from "../mcp/src/authz/role-grants.js";
import {
  buildMedplumAccessPolicy,
  buildMedplumCompositeAccessPolicy,
  getRoleDeclaration,
  PRACTICE_ROLE_IDS,
  type PracticeRoleId,
} from "../mcp/src/authz/roles.js";
import { createOperatorScriptFhirClient, type MedplumClient } from "../mcp/src/fhir-client.js";
import { searchAll, searchProjectAll } from "../mcp/src/fhir-search.js";
import { buildSchedulingResource } from "../mcp/src/fhir/schedulingResource.js";
import {
  defaultVisitTypeCatalog,
  visitTypeCode,
} from "../mcp/src/fhir/schedulingVisitType.js";
import {
  buildSchedulingPracticeConfigResource,
  ODOS_SCHEDULING_CONFIG_CODE,
  ODOS_SCHEDULING_CONFIG_SYSTEM,
} from "../mcp/src/scheduling/practice-config.js";
import {
  DEFAULT_VISIT_TYPE_CATEGORIES,
  ODOS_VISIT_TYPE_CONFIG_CODE,
  ODOS_VISIT_TYPE_CONFIG_SYSTEM,
  buildVisitTypeConfigResource,
} from "../mcp/src/scheduling/visit-type-config.js";
import { ensureLiveOperatorIdentity } from "./operator-identity.js";

export const SETUP_WIZARD_HEADER =
  "Run ODOS on your own hardware. Your patients, your machines, your data.";
export const SETUP_WIZARD_ACTION_REASON = "v0.5d setup wizard first-run provisioning";
export const SETUP_WIZARD_NOOP_REASON = "v0.5d setup wizard re-run, already provisioned";
export const SETUP_PRACTICE_ORGANIZATION_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/setup-practice-organization";
export const SETUP_PRACTICE_LOCATION_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/setup-practice-location";

const DEFAULT_BASE_URL = "http://localhost:8103";
const DEFAULT_POSTGRES_URL = "postgresql://medplum:medplum@127.0.0.1:5433/medplum";
const DEFAULT_STATE_PATH = resolve(process.cwd(), ".odos-setup-state.json");
const PRACTICE_ORGANIZATION_IDENTIFIER_VALUE = "primary";
const DEFAULT_SCHEDULING_OFFICE_ID = "main";
const DEFAULT_SCHEDULING_OFFICE_NAME = "Main Office";
const FIRST_ADMIN_GRANT_ROLES = ["staff", "admin", "provider"] as const satisfies readonly PracticeRoleId[];
type FirstAdminGrantRole = (typeof FIRST_ADMIN_GRANT_ROLES)[number];
const FIRST_ADMIN_PRIMARY_ROLE: FirstAdminGrantRole = "staff";

export interface SetupPracticeConfig {
  readonly baseUrl: string;
  readonly practiceName: string;
  readonly adminEmail: string;
  readonly adminName: string;
  readonly adminPassword: string;
  readonly serviceIdentityEmail?: string;
  readonly serviceIdentityPassword?: string;
  readonly postgresUrl?: string;
  readonly timezoneOffset?: string;
  readonly statePath: string;
}

export interface SetupPracticeState {
  readonly version: "v0.5d";
  adminProjectCreated?: boolean;
  projectId?: string;
  practitionerCreated?: boolean;
  practitionerId?: string;
  organizationCreated?: boolean;
  organizationId?: string;
  locationCreated?: boolean;
  locationId?: string;
  schedulingProvisioned?: boolean;
  scheduleId?: string;
  schedulingConfigId?: string;
  visitTypeIds?: string[];
  visitTypeConfigId?: string;
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
  createPracticeOrganization(config: SetupPracticeConfig): Promise<{
    organization: Organization;
    created: boolean;
  }>;
  createPracticeLocation(input: {
    organization: Organization;
  }): Promise<{
    location: Location;
    created: boolean;
  }>;
  createSchedulingFoundation(input: {
    config: SetupPracticeConfig;
    session: AdminSession;
    practitioner: Practitioner;
  }): Promise<{
    schedule: Schedule;
    scheduleCreated: boolean;
    practiceConfig: Basic;
    practiceConfigCreated: boolean;
    visitTypes: readonly {
      resource: HealthcareService;
      created: boolean;
    }[];
    visitTypeConfig: Basic;
    visitTypeConfigCreated: boolean;
  }>;
  createFirstAdminAccessPolicies(config: SetupPracticeConfig, session: AdminSession): Promise<readonly {
    role: PracticeRoleId;
    policy: AccessPolicy;
    created: boolean;
    updated: boolean;
  }[]>;
  resolveCompositeAccessPolicy(
    roles: readonly PracticeRoleId[],
    session: AdminSession,
  ): Promise<{ policy: AccessPolicy; created: boolean; updated: boolean }>;
  grantFirstAdminRoles(input: {
    config: SetupPracticeConfig;
    session: AdminSession;
    practitioner: Practitioner;
    policies: ReadonlyMap<FirstAdminGrantRole, AccessPolicy>;
    compositePolicy: AccessPolicy;
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

  let organization: Organization;
  if (state.organizationCreated && state.organizationId) {
    organization = { resourceType: "Organization", id: state.organizationId };
  } else {
    const resolved = await adapter.createPracticeOrganization(config);
    if (!resolved.organization.id) {
      throw new Error("Setup wizard Organization create returned no id.");
    }
    const auditRequired =
      resolved.created || state.organizationId === resolved.organization.id;
    state = persistSetupState(config.statePath, {
      ...state,
      organizationId: resolved.organization.id,
    });
    if (auditRequired) {
      await emit(buildSetupAuditRow({
        eventType: "create",
        resourceType: "Organization",
        resourceId: resolved.organization.id,
        actionReason: SETUP_WIZARD_ACTION_REASON,
      }));
    }
    state = persistSetupState(config.statePath, {
      ...state,
      organizationCreated: true,
    });
    organization = resolved.organization;
  }

  if (!state.locationCreated || !state.locationId) {
    const resolved = await adapter.createPracticeLocation({ organization });
    if (!resolved.location.id) {
      throw new Error("Setup wizard Location create returned no id.");
    }
    const auditRequired = resolved.created || state.locationId === resolved.location.id;
    state = persistSetupState(config.statePath, {
      ...state,
      locationId: resolved.location.id,
    });
    if (auditRequired) {
      await emit(buildSetupAuditRow({
        eventType: "create",
        resourceType: "Location",
        resourceId: resolved.location.id,
        actionReason: SETUP_WIZARD_ACTION_REASON,
      }));
    }
    state = persistSetupState(config.statePath, {
      ...state,
      locationCreated: true,
    });
  }

  if (!state.schedulingProvisioned) {
    const scheduling = await adapter.createSchedulingFoundation({ config, session, practitioner });
    if (!scheduling.schedule.id || !scheduling.practiceConfig.id) {
      throw new Error("Setup wizard scheduling foundation returned a resource without an id.");
    }
    if (!scheduling.visitTypeConfig.id || scheduling.visitTypes.some(({ resource }) => !resource.id)) {
      throw new Error("Setup wizard visit-type foundation returned a resource without an id.");
    }
    const scheduleAuditRequired = scheduling.scheduleCreated || state.scheduleId === scheduling.schedule.id;
    const practiceConfigAuditRequired = scheduling.practiceConfigCreated
      || state.schedulingConfigId === scheduling.practiceConfig.id;
    const visitTypeIds = scheduling.visitTypes.map(({ resource }) => resource.id!);
    const visitTypeAuditIds = new Set(state.visitTypeIds ?? []);
    const visitTypeConfigAuditRequired = scheduling.visitTypeConfigCreated
      || state.visitTypeConfigId === scheduling.visitTypeConfig.id;
    state = persistSetupState(config.statePath, {
      ...state,
      scheduleId: scheduling.schedule.id,
      schedulingConfigId: scheduling.practiceConfig.id,
      visitTypeIds,
      visitTypeConfigId: scheduling.visitTypeConfig.id,
    });
    if (scheduleAuditRequired) {
      await emit(buildSetupAuditRow({
        eventType: "create",
        resourceType: "Schedule",
        resourceId: scheduling.schedule.id,
        actionReason: SETUP_WIZARD_ACTION_REASON,
      }));
    }
    if (practiceConfigAuditRequired) {
      await emit(buildSetupAuditRow({
        eventType: "create",
        resourceType: "Basic",
        resourceId: scheduling.practiceConfig.id,
        actionReason: SETUP_WIZARD_ACTION_REASON,
      }));
    }
    for (const visitType of scheduling.visitTypes) {
      if (visitType.created || visitTypeAuditIds.has(visitType.resource.id!)) {
        await emit(buildSetupAuditRow({
          eventType: "create",
          resourceType: "HealthcareService",
          resourceId: visitType.resource.id!,
          actionReason: SETUP_WIZARD_ACTION_REASON,
        }));
      }
    }
    if (visitTypeConfigAuditRequired) {
      await emit(buildSetupAuditRow({
        eventType: "create",
        resourceType: "Basic",
        resourceId: scheduling.visitTypeConfig.id,
        actionReason: SETUP_WIZARD_ACTION_REASON,
      }));
    }
    state = persistSetupState(config.statePath, {
      ...state,
      schedulingProvisioned: true,
    });
  }

  const resolvedPolicies = await adapter.createFirstAdminAccessPolicies(config, session);
  const allPolicies = new Map<PracticeRoleId, AccessPolicy>();
  for (const resolvedPolicy of resolvedPolicies) {
    if (!resolvedPolicy.policy.id) {
      throw new Error(`Setup wizard ${resolvedPolicy.role} AccessPolicy create returned no id.`);
    }
    allPolicies.set(resolvedPolicy.role, resolvedPolicy.policy);
    if (resolvedPolicy.created || resolvedPolicy.updated) {
      await emit(
        buildSetupAuditRow({
          eventType: resolvedPolicy.created ? "create" : "update",
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
  const clinicianPolicy = policies.get("provider");
  if (!clinicianPolicy?.id || policies.size !== FIRST_ADMIN_GRANT_ROLES.length) {
    throw new Error("Setup wizard did not resolve all first-admin AccessPolicies.");
  }
  const compositePolicy = await adapter.resolveCompositeAccessPolicy(
    FIRST_ADMIN_GRANT_ROLES,
    session,
  );
  if (!compositePolicy.policy.id) {
    throw new Error("Setup wizard composite AccessPolicy create returned no id.");
  }
  if (compositePolicy.created || compositePolicy.updated) {
    await emit(buildSetupAuditRow({
      eventType: compositePolicy.created ? "create" : "update",
      resourceType: "AccessPolicy",
      resourceId: compositePolicy.policy.id,
      actionReason: SETUP_WIZARD_ACTION_REASON,
    }));
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
      compositePolicy: compositePolicy.policy,
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

export async function provisionSetupOperatorIdentity(input: {
  readonly setupResult: SetupPracticeResult;
  readonly config: Pick<
    SetupPracticeConfig,
    "baseUrl" | "serviceIdentityEmail" | "serviceIdentityPassword"
  >;
  readonly provision?: typeof ensureLiveOperatorIdentity;
}) {
  const projectId = requireConfigValue(input.setupResult.state.projectId, "setup project id");
  return (input.provision ?? ensureLiveOperatorIdentity)({
    baseUrl: input.config.baseUrl,
    projectId,
    serviceEmail: requireConfigValue(input.config.serviceIdentityEmail, "MEDPLUM_ADMIN_EMAIL"),
    servicePassword: requireConfigValue(input.config.serviceIdentityPassword, "MEDPLUM_ADMIN_PASSWORD"),
  });
}

export class InMemorySetupPracticeAdapter implements SetupPracticeAdapter {
  readonly admins: AdminSession[] = [];
  readonly practitioners: Practitioner[] = [];
  readonly organizations: Organization[] = [];
  readonly locations: Location[] = [];
  readonly schedules: Schedule[] = [];
  readonly schedulingConfigs: Basic[] = [];
  readonly visitTypes: HealthcareService[] = [];
  readonly visitTypeConfigs: Basic[] = [];
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
    return this.practiceProvisioned || setupStateIsComplete(state);
  }

  async createOrLoginAdmin(config: SetupPracticeConfig): Promise<AdminSession> {
    const session = {
      accessToken: "in-memory-token",
      projectId: "project-1",
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

  async createPracticeOrganization(config: SetupPracticeConfig): Promise<{
    organization: Organization;
    created: boolean;
  }> {
    const existing = this.organizations.filter((organization) =>
      hasIdentifier(
        organization.identifier,
        SETUP_PRACTICE_ORGANIZATION_IDENTIFIER_SYSTEM,
        PRACTICE_ORGANIZATION_IDENTIFIER_VALUE,
      )
    );
    if (existing.length > 1) {
      throw new Error(`Expected at most one practice Organization; found ${existing.length}.`);
    }
    if (existing[0]) {
      return { organization: existing[0], created: false };
    }
    const organization = {
      ...buildPracticeOrganization(config),
      id: `organization-${this.organizations.length + 1}`,
    };
    this.organizations.push(organization);
    return { organization, created: true };
  }

  async createPracticeLocation(input: {
    organization: Organization;
  }): Promise<{
    location: Location;
    created: boolean;
  }> {
    const existing = this.locations.filter((location) =>
      hasIdentifier(
        location.identifier,
        SETUP_PRACTICE_LOCATION_IDENTIFIER_SYSTEM,
        DEFAULT_SCHEDULING_OFFICE_ID,
      )
    );
    if (existing.length > 1) {
      throw new Error(`Expected at most one main-office Location; found ${existing.length}.`);
    }
    if (existing[0]) {
      return { location: existing[0], created: false };
    }
    const location = {
      ...buildPracticeLocation(input.organization),
      id: `location-${this.locations.length + 1}`,
    };
    this.locations.push(location);
    return { location, created: true };
  }

  async createSchedulingFoundation(input: {
    config: SetupPracticeConfig;
    practitioner: Practitioner;
  }): Promise<{
    schedule: Schedule;
    scheduleCreated: boolean;
    practiceConfig: Basic;
    practiceConfigCreated: boolean;
    visitTypes: readonly {
      resource: HealthcareService;
      created: boolean;
    }[];
    visitTypeConfig: Basic;
    visitTypeConfigCreated: boolean;
  }> {
    const schedule = {
      ...buildFirstAdminSchedule(input.config, input.practitioner),
      id: `schedule-${this.schedules.length + 1}`,
    };
    this.schedules.push(schedule);
    const practiceConfig = {
      ...buildFirstSchedulingConfig(schedule.id, input.config.timezoneOffset),
      id: `scheduling-config-${this.schedulingConfigs.length + 1}`,
    };
    this.schedulingConfigs.push(practiceConfig);
    const visitTypes = defaultVisitTypeCatalog("both").map((seed) => {
      const code = visitTypeCode(seed)!;
      const matches = this.visitTypes.filter((candidate) => visitTypeCode(candidate) === code);
      if (matches.length > 1) {
        throw new Error(`Expected at most one visit type with code ${code}; found ${matches.length}.`);
      }
      if (matches[0]) return { resource: matches[0], created: false };
      const resource = { ...seed, id: `visit-type-${this.visitTypes.length + 1}` };
      this.visitTypes.push(resource);
      return { resource, created: true };
    });
    if (this.visitTypeConfigs.length > 1) {
      throw new Error(`Expected at most one visit-type-config Basic; found ${this.visitTypeConfigs.length}.`);
    }
    const existingVisitTypeConfig = this.visitTypeConfigs[0];
    const visitTypeConfig = existingVisitTypeConfig ?? {
      ...buildVisitTypeConfigResource({ categories: DEFAULT_VISIT_TYPE_CATEGORIES }),
      id: `visit-type-config-${this.visitTypeConfigs.length + 1}`,
    };
    if (!existingVisitTypeConfig) this.visitTypeConfigs.push(visitTypeConfig);
    return {
      schedule,
      scheduleCreated: true,
      practiceConfig,
      practiceConfigCreated: true,
      visitTypes,
      visitTypeConfig,
      visitTypeConfigCreated: !existingVisitTypeConfig,
    };
  }

  async createFirstAdminAccessPolicies(
    _config: SetupPracticeConfig,
    session: AdminSession,
  ): Promise<readonly {
    role: PracticeRoleId;
    policy: AccessPolicy;
    created: boolean;
    updated: boolean;
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

  async resolveCompositeAccessPolicy(
    roles: readonly PracticeRoleId[],
    session: AdminSession,
  ): Promise<{ policy: AccessPolicy; created: boolean; updated: boolean }> {
    const built = buildMedplumCompositeAccessPolicy(roles);
    const desired = {
      ...built,
      meta: { ...built.meta, project: session.projectId },
    };
    const existing = this.policies.filter((policy) =>
      policy.name === desired.name && policy.meta?.project === session.projectId
    );
    if (existing.length > 1) {
      throw new Error(`Expected at most one ${desired.name} AccessPolicy; found ${existing.length}.`);
    }
    if (existing[0]) {
      const updated = accessPolicyNeedsReconciliation(existing[0], desired);
      if (updated) Object.assign(existing[0], reconciledAccessPolicy(existing[0], desired));
      return { policy: existing[0], created: false, updated };
    }
    const policy = { ...desired, id: `access-policy-${this.policies.length + 1}` };
    this.policies.push(policy);
    return { policy, created: true, updated: false };
  }

  async grantFirstAdminRoles(input: {
    config: SetupPracticeConfig;
    practitioner: Practitioner;
    policies: ReadonlyMap<FirstAdminGrantRole, AccessPolicy>;
    compositePolicy: AccessPolicy;
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
        resolveBoundPolicy: async (reference) => {
          const id = reference.match(/^AccessPolicy\/([^/]+)$/)?.[1];
          return this.policies.find((policy) => policy.id === id);
        },
        resolveCompositePolicy: async () => input.compositePolicy,
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
      policyId: input.policies.get("provider")?.id,
    };
    this.assignments.push(assignment);
    return assignment;
  }

  private async resolveCanonicalPolicies(
    createPolicy: (role: PracticeRoleId) => Promise<AccessPolicy>,
  ): Promise<readonly {
    role: PracticeRoleId;
    policy: AccessPolicy;
    created: boolean;
    updated: boolean;
  }[]> {
    const resolved = [];
    for (const roleId of PRACTICE_ROLE_IDS) {
      const role = getRoleDeclaration(roleId);
      const policyName = `ODOS ${role.display}`;
      const existing = this.policies.filter((policy) => policy.name === policyName);
      if (existing.length > 1) {
        throw new Error(`Expected at most one ${policyName} AccessPolicy; found ${existing.length}.`);
      }
      if (existing[0]) {
        const desired = buildMedplumAccessPolicy(role);
        const updated = accessPolicyNeedsReconciliation(existing[0], desired);
        if (updated) {
          Object.assign(existing[0], reconciledAccessPolicy(existing[0], desired));
        }
        resolved.push({ role: roleId, policy: existing[0], created: false, updated });
      } else {
        resolved.push({ role: roleId, policy: await createPolicy(roleId), created: true, updated: false });
      }
    }
    return resolved;
  }

  async emitAudit(row: OdosAuditEventRecord): Promise<void> {
    this.auditRows.push(row);
  }
}

export function createSetupServiceFhirClient(baseUrl: string, accessToken: string): MedplumClient {
  return createOperatorScriptFhirClient({
    baseUrl,
    accessToken,
    extendedMode: true,
    reason: "Operator practice setup service bootstrap runs before request handling.",
  });
}

class LiveSetupPracticeAdapter implements SetupPracticeAdapter {
  private fhir?: MedplumClient;
  private serviceFhir?: MedplumClient;
  private audit?: ReturnType<typeof createLiveOdosAuditRuntime>;

  async isPracticeProvisioned(_config: SetupPracticeConfig, state: SetupPracticeState): Promise<boolean> {
    return setupStateIsComplete(state);
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
    this.serviceFhir = createSetupServiceFhirClient(config.baseUrl, serviceAccessToken);

    try {
      const accessToken = await loginForAccessToken(config);
      const projectId = await resolveProjectId({ baseUrl: config.baseUrl, accessToken });
      this.fhir = createOperatorScriptFhirClient({
        baseUrl: config.baseUrl,
        accessToken,
        reason: "Operator practice setup admin bootstrap runs before request handling.",
      });
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
      this.fhir = createOperatorScriptFhirClient({
        baseUrl: config.baseUrl,
        accessToken,
        reason: "Operator practice setup admin bootstrap runs before request handling.",
      });
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

  async createPracticeOrganization(config: SetupPracticeConfig): Promise<{
    organization: Organization;
    created: boolean;
  }> {
    const matches = (await searchAll<Organization>(this.client(), "Organization", {
      identifier:
        `${SETUP_PRACTICE_ORGANIZATION_IDENTIFIER_SYSTEM}|${PRACTICE_ORGANIZATION_IDENTIFIER_VALUE}`,
      _count: "100",
    })).filter((organization) =>
      hasIdentifier(
        organization.identifier,
        SETUP_PRACTICE_ORGANIZATION_IDENTIFIER_SYSTEM,
        PRACTICE_ORGANIZATION_IDENTIFIER_VALUE,
      )
    );
    if (matches.length > 1) {
      throw new Error(`Expected at most one practice Organization; found ${matches.length}.`);
    }
    if (matches[0]) {
      return { organization: matches[0], created: false };
    }
    const result = await conditionalCreateSetupResource(
      this.client(),
      buildPracticeOrganization(config),
      `identifier=${SETUP_PRACTICE_ORGANIZATION_IDENTIFIER_SYSTEM}|${PRACTICE_ORGANIZATION_IDENTIFIER_VALUE}`,
    );
    return { organization: result.resource, created: result.created };
  }

  async createPracticeLocation(input: {
    organization: Organization;
  }): Promise<{
    location: Location;
    created: boolean;
  }> {
    const matches = (await searchAll<Location>(this.client(), "Location", {
      identifier:
        `${SETUP_PRACTICE_LOCATION_IDENTIFIER_SYSTEM}|${DEFAULT_SCHEDULING_OFFICE_ID}`,
      _count: "100",
    })).filter((location) =>
      hasIdentifier(
        location.identifier,
        SETUP_PRACTICE_LOCATION_IDENTIFIER_SYSTEM,
        DEFAULT_SCHEDULING_OFFICE_ID,
      )
    );
    if (matches.length > 1) {
      throw new Error(`Expected at most one main-office Location; found ${matches.length}.`);
    }
    if (matches[0]) {
      return { location: matches[0], created: false };
    }
    const result = await conditionalCreateSetupResource(
      this.client(),
      buildPracticeLocation(input.organization),
      `identifier=${SETUP_PRACTICE_LOCATION_IDENTIFIER_SYSTEM}|${DEFAULT_SCHEDULING_OFFICE_ID}`,
    );
    return { location: result.resource, created: result.created };
  }

  async createSchedulingFoundation(input: {
    config: SetupPracticeConfig;
    practitioner: Practitioner;
  }): Promise<{
    schedule: Schedule;
    scheduleCreated: boolean;
    practiceConfig: Basic;
    practiceConfigCreated: boolean;
    visitTypes: readonly {
      resource: HealthcareService;
      created: boolean;
    }[];
    visitTypeConfig: Basic;
    visitTypeConfigCreated: boolean;
  }> {
    if (!input.practitioner.id) {
      throw new Error("Setup wizard cannot create a Schedule for a Practitioner without an id.");
    }
    const practitionerReference = `Practitioner/${input.practitioner.id}`;
    await this.client().read<Practitioner>("Practitioner", input.practitioner.id);
    const schedules = (await searchAll<Schedule>(this.client(), "Schedule", {
      actor: practitionerReference,
      _count: "100",
    })).filter((schedule) => schedule.actor?.some((actor) => actor.reference === practitionerReference));
    if (schedules.length > 1) {
      throw new Error(`Expected at most one first-admin Schedule; found ${schedules.length}.`);
    }
    const schedule = schedules[0] ?? await this.client().create<Schedule>(
      buildFirstAdminSchedule(input.config, input.practitioner),
    );
    if (!schedule.id) {
      throw new Error("Setup wizard Schedule create returned no id.");
    }

    const configs = (await searchAll<Basic>(this.client(), "Basic", {
      code: `${ODOS_SCHEDULING_CONFIG_SYSTEM}|${ODOS_SCHEDULING_CONFIG_CODE}`,
      _count: "100",
    })).filter((basic) => basic.code?.coding?.some((coding) =>
      coding.system === ODOS_SCHEDULING_CONFIG_SYSTEM && coding.code === ODOS_SCHEDULING_CONFIG_CODE
    ));
    if (configs.length > 1) {
      throw new Error(`Expected at most one scheduling-config Basic; found ${configs.length}.`);
    }
    const practiceConfig = configs[0] ?? await this.client().create<Basic>(
      buildFirstSchedulingConfig(schedule.id, input.config.timezoneOffset),
    );
    const existingVisitTypes = await searchAll<HealthcareService>(
      this.client(),
      "HealthcareService",
      { _count: "100" },
    );
    const visitTypes = [];
    for (const seed of defaultVisitTypeCatalog("both")) {
      const code = visitTypeCode(seed)!;
      const matches = existingVisitTypes.filter((candidate) => visitTypeCode(candidate) === code);
      if (matches.length > 1) {
        throw new Error(`Expected at most one visit type with code ${code}; found ${matches.length}.`);
      }
      if (matches[0]) {
        visitTypes.push({ resource: matches[0], created: false });
      } else {
        visitTypes.push({
          resource: await this.client().create<HealthcareService>(seed),
          created: true,
        });
      }
    }
    const visitTypeConfigs = (await searchAll<Basic>(this.client(), "Basic", {
      code: `${ODOS_VISIT_TYPE_CONFIG_SYSTEM}|${ODOS_VISIT_TYPE_CONFIG_CODE}`,
      _count: "100",
    })).filter((basic) => basic.code?.coding?.some((coding) =>
      coding.system === ODOS_VISIT_TYPE_CONFIG_SYSTEM && coding.code === ODOS_VISIT_TYPE_CONFIG_CODE
    ));
    if (visitTypeConfigs.length > 1) {
      throw new Error(`Expected at most one visit-type-config Basic; found ${visitTypeConfigs.length}.`);
    }
    const visitTypeConfig = visitTypeConfigs[0] ?? await this.client().create<Basic>(
      buildVisitTypeConfigResource({ categories: DEFAULT_VISIT_TYPE_CATEGORIES }),
    );
    return {
      schedule,
      scheduleCreated: schedules.length === 0,
      practiceConfig,
      practiceConfigCreated: configs.length === 0,
      visitTypes,
      visitTypeConfig,
      visitTypeConfigCreated: visitTypeConfigs.length === 0,
    };
  }

  async createFirstAdminAccessPolicies(
    _config: SetupPracticeConfig,
    session: AdminSession,
  ): Promise<readonly {
    role: PracticeRoleId;
    policy: AccessPolicy;
    created: boolean;
    updated: boolean;
  }[]> {
    const resolved = [];
    for (const roleId of PRACTICE_ROLE_IDS) {
      const role = getRoleDeclaration(roleId);
      const policyName = `ODOS ${role.display}`;
      const existing = (await searchProjectAll<AccessPolicy>(
        this.serviceClient(),
        "AccessPolicy",
        session.projectId,
        {
          "name:exact": policyName,
        },
      )).filter((policy) => policy.name === policyName && policy.meta?.project === session.projectId);
      if (existing.length > 1) {
        throw new Error(`Expected at most one ${policyName} AccessPolicy; found ${existing.length}.`);
      }
      if (existing[0]) {
        const desired = buildMedplumAccessPolicy(role);
        const updated = accessPolicyNeedsReconciliation(existing[0], desired);
        const policy = updated
          ? await this.serviceClient().update<AccessPolicy>(
              "AccessPolicy",
              requireConfigValue(existing[0].id, `${policyName} AccessPolicy id`),
              reconciledAccessPolicy(existing[0], desired),
            )
          : existing[0];
        resolved.push({ role: roleId, policy, created: false, updated });
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
          updated: false,
        });
      }
    }
    return resolved;
  }

  async resolveCompositeAccessPolicy(
    roles: readonly PracticeRoleId[],
    session: AdminSession,
  ): Promise<{ policy: AccessPolicy; created: boolean; updated: boolean }> {
    const desired = buildMedplumCompositeAccessPolicy(roles);
    const existing = (await searchProjectAll<AccessPolicy>(
      this.serviceClient(),
      "AccessPolicy",
      session.projectId,
      { "name:exact": desired.name! },
    )).filter((policy) =>
      policy.name === desired.name && policy.meta?.project === session.projectId
    );
    if (existing.length > 1) {
      throw new Error(`Expected at most one ${desired.name} AccessPolicy; found ${existing.length}.`);
    }
    if (existing[0]) {
      const updated = accessPolicyNeedsReconciliation(existing[0], desired);
      const policy = updated
        ? await this.serviceClient().update<AccessPolicy>(
            "AccessPolicy",
            requireConfigValue(existing[0].id, `${desired.name} AccessPolicy id`),
            reconciledAccessPolicy(existing[0], desired),
          )
        : existing[0];
      return { policy, created: false, updated };
    }
    return {
      policy: await this.serviceClient().create<AccessPolicy>({
        ...desired,
        meta: { ...desired.meta, project: session.projectId },
      }),
      created: true,
      updated: false,
    };
  }

  async grantFirstAdminRoles(input: {
    config: SetupPracticeConfig;
    session: AdminSession;
    practitioner: Practitioner;
    policies: ReadonlyMap<FirstAdminGrantRole, AccessPolicy>;
    compositePolicy: AccessPolicy;
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
        resolveBoundPolicy: async (reference) => {
          const id = reference.match(/^AccessPolicy\/([^/]+)$/)?.[1];
          return id ? this.serviceClient().read<AccessPolicy>("AccessPolicy", id) : undefined;
        },
        resolveCompositePolicy: async () => input.compositePolicy,
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

function accessPolicyNeedsReconciliation(existing: AccessPolicy, desired: AccessPolicy): boolean {
  const desiredRoleTags = desired.meta?.tag ?? [];
  const existingRoleTags = (existing.meta?.tag ?? []).filter((tag) =>
    desiredRoleTags.some((desiredTag) => desiredTag.system === tag.system)
  );
  return JSON.stringify(existingRoleTags) !== JSON.stringify(desiredRoleTags)
    || existing.name !== desired.name
    || JSON.stringify(existing.resource ?? []) !== JSON.stringify(desired.resource ?? []);
}

function reconciledAccessPolicy(existing: AccessPolicy, desired: AccessPolicy): AccessPolicy {
  const desiredRoleTags = desired.meta?.tag ?? [];
  const desiredTagSystems = new Set(desiredRoleTags.map((tag) => tag.system));
  const preservedTags = (existing.meta?.tag ?? []).filter((tag) =>
    !desiredTagSystems.has(tag.system)
  );
  return {
    ...existing,
    name: desired.name,
    meta: {
      ...existing.meta,
      tag: [...preservedTags, ...desiredRoleTags],
    },
    resource: desired.resource,
  };
}

function buildFirstAdminSchedule(
  config: SetupPracticeConfig,
  practitioner: Practitioner,
): Schedule {
  if (!practitioner.id) {
    throw new Error("Setup wizard cannot create a Schedule for a Practitioner without an id.");
  }
  return buildSchedulingResource({
    kind: "provider",
    actorReference: `Practitioner/${practitioner.id}`,
    actorDisplay: practitioner.name?.[0]?.text ?? config.adminName,
    disciplines: ["eyecare"],
    comment: "First-admin provider schedule",
  });
}

function buildFirstSchedulingConfig(scheduleId: string, timezoneOffset?: string): Basic {
  const scheduleReference = `Schedule/${scheduleId}`;
  return buildSchedulingPracticeConfigResource({
    timezoneOffset: timezoneOffset ?? localTimezoneOffset(),
    defaultWeeklyHours: {
      mon: [{ start: "09:00", end: "17:00" }],
      tue: [{ start: "09:00", end: "17:00" }],
      wed: [{ start: "09:00", end: "17:00" }],
      thu: [{ start: "09:00", end: "17:00" }],
      fri: [{ start: "09:00", end: "17:00" }],
    },
    weeklyHoursBySchedule: {},
    blocks: [],
    offices: [{
      id: DEFAULT_SCHEDULING_OFFICE_ID,
      name: DEFAULT_SCHEDULING_OFFICE_NAME,
      slotMinutes: 30,
    }],
    officeBySchedule: { [scheduleReference]: DEFAULT_SCHEDULING_OFFICE_ID },
    defaultSlotMinutes: 30,
  });
}

export async function conditionalCreateSetupResource<
  T extends Organization | Location,
>(
  fhir: Pick<MedplumClient, "executeTransaction" | "read">,
  resource: T,
  ifNoneExist: string,
): Promise<{ resource: T; created: boolean }> {
  const response = await fhir.executeTransaction({
    resourceType: "Bundle",
    type: "transaction",
    entry: [{
      resource,
      request: {
        method: "POST",
        url: resource.resourceType,
        ifNoneExist,
      },
    }],
  });
  const entry = response.entry?.[0];
  const status = Number(entry?.response?.status?.split(" ", 1)[0]);
  if (status !== 200 && status !== 201) {
    throw new Error(
      `Setup wizard conditional ${resource.resourceType} create returned status ${
        entry?.response?.status ?? "missing"
      }.`,
    );
  }
  if (entry?.resource?.resourceType === resource.resourceType && entry.resource.id) {
    return { resource: entry.resource as T, created: status === 201 };
  }
  const id = conditionalCreateResponseId(entry?.response?.location, resource.resourceType);
  if (!id) {
    throw new Error(
      `Setup wizard conditional ${resource.resourceType} create returned no resource id.`,
    );
  }
  return {
    resource: await fhir.read<T>(resource.resourceType, id),
    created: status === 201,
  };
}

function buildPracticeOrganization(config: SetupPracticeConfig): Organization {
  return {
    resourceType: "Organization",
    active: true,
    name: config.practiceName,
    identifier: [{
      system: SETUP_PRACTICE_ORGANIZATION_IDENTIFIER_SYSTEM,
      value: PRACTICE_ORGANIZATION_IDENTIFIER_VALUE,
    }],
  };
}

function buildPracticeLocation(organization: Organization): Location {
  if (!organization.id) {
    throw new Error("Setup wizard cannot create a Location for an Organization without an id.");
  }
  return {
    resourceType: "Location",
    status: "active",
    name: DEFAULT_SCHEDULING_OFFICE_NAME,
    managingOrganization: { reference: `Organization/${organization.id}` },
    identifier: [{
      system: SETUP_PRACTICE_LOCATION_IDENTIFIER_SYSTEM,
      value: DEFAULT_SCHEDULING_OFFICE_ID,
    }],
  };
}

function conditionalCreateResponseId(
  location: string | undefined,
  resourceType: string,
): string | undefined {
  return location?.match(new RegExp(`(?:^|/)${resourceType}/([^/?]+)`))?.[1];
}

function hasIdentifier(
  identifiers: readonly { system?: string; value?: string }[] | undefined,
  system: string,
  value: string,
): boolean {
  return identifiers?.some((identifier) =>
    identifier.system === system && identifier.value === value
  ) ?? false;
}

function setupStateIsComplete(state: SetupPracticeState): boolean {
  return Boolean(
    state.completed
    && state.organizationCreated
    && state.organizationId
    && state.locationCreated
    && state.locationId
    && state.schedulingProvisioned,
  );
}

function localTimezoneOffset(now = new Date()): string {
  const minutes = -now.getTimezoneOffset();
  const sign = minutes >= 0 ? "+" : "-";
  const absolute = Math.abs(minutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
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
    timezoneOffset: config.timezoneOffset,
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
  eventType: "create" | "update" | "projectmembership-lifecycle" | "noop";
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

export function readSetupState(path: string): SetupPracticeState {
  if (!existsSync(path)) {
    return { version: "v0.5d" };
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as SetupPracticeState;
  return { ...parsed, version: "v0.5d" };
}

function persistSetupState(path: string, state: SetupPracticeState): SetupPracticeState {
  const normalized = { ...state, version: "v0.5d" as const };
  writeFileSync(path, JSON.stringify(normalized, null, 2) + "\n");
  return normalized;
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
    const cliConfig = buildSetupConfig({ config: interactiveConfig });
    const result = await runSetupPractice({
      config: cliConfig,
      skipInteractiveBoundaryCheck: true,
    });
    const operator = await provisionSetupOperatorIdentity({ setupResult: result, config: cliConfig });
    if (result.noOp) {
      console.log("Practice already provisioned. To re-provision, see docs/install.md §Re-provisioning.");
    } else {
      console.log(`Setup complete. Practitioner: ${result.practitionerId}`);
      console.log(`Login URL: ${result.loginUrl ?? DEFAULT_BASE_URL}`);
    }
    console.log(`Operator identity active. Project: ${operator.state.projectId}; client: ${operator.state.clientId}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
