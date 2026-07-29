#!/usr/bin/env tsx
import type {
  AccessPolicy,
  Patient,
  ProjectMembership,
  ProjectMembershipAccess,
} from "@medplum/fhirtypes";
import {
  hasPatientCompartmentGrant,
} from "../mcp/src/clinical-graph/provider-assignment-endpoint.js";
import {
  buildMedplumAccessPolicy,
  buildProjectMembershipAccess,
  getRoleDeclaration,
  ODOS_PRACTICE_ROLE_SYSTEM,
  type PracticeRoleId,
} from "../mcp/src/authz/roles.js";
import {
  createMedplumClient,
  type JsonPatchOperation,
  type MedplumClient,
} from "../mcp/src/fhir-client.js";
import { searchAll } from "../mcp/src/fhir-search.js";
import {
  DEFAULT_M2A_STATE_DIR,
  ImportLedger,
} from "../mcp/src/legacy-import/import-ledger.js";
import {
  cliArgument,
  ordinarySessionContext,
  referenceId,
  requireEnv,
} from "./legacy-import-m2a-cli.js";
import { assertLocalMedplumBaseUrl } from "./reseed-practice-role-tags.js";

const DEFAULT_BASE_URL = "http://localhost:8103";
const WRITE_HEADERS = { "X-ODOS-Source": "scripts/grant-migrated-patient-access" } as const;

export interface MigratedPatientAccessGrantAdapter {
  readPatient(id: string): Promise<Patient>;
  resolveMembership(profileReference: string): Promise<ProjectMembership>;
  resolvePolicy(role: Extract<PracticeRoleId, "clinician" | "front-desk">): Promise<AccessPolicy>;
  patchPatient(
    id: string,
    operations: JsonPatchOperation[],
    versionId: string,
  ): Promise<Patient>;
  patchMembership(
    id: string,
    operations: JsonPatchOperation[],
    versionId: string,
  ): Promise<ProjectMembership>;
}

export interface MigratedPatientAccessGrantResult {
  readonly patientReference: string;
  readonly generalPractitioner: "added" | "skipped";
  readonly clinicianMembership: "added" | "skipped";
  readonly frontDeskMembership: "added" | "skipped";
}

export class MembershipResolutionError extends Error {
  constructor(
    readonly profileReference: string,
    readonly matchCount: number,
  ) {
    super(`Expected one project membership for ${profileReference}; found ${matchCount}.`);
    this.name = "MembershipResolutionError";
  }
}

export class PolicyDriftError extends Error {
  constructor(
    readonly role: Extract<PracticeRoleId, "clinician" | "front-desk">,
    readonly policyReference: string,
  ) {
    super(`${policyReference} rules diverge from the canonical ${role} AccessPolicy.`);
    this.name = "PolicyDriftError";
  }
}

export async function grantMigratedPatientAccess(input: {
  readonly adapter: MigratedPatientAccessGrantAdapter;
  readonly ledger: ImportLedger;
  readonly runId: string;
  readonly patientReference: string;
  readonly clinicianProfileReference: string;
  readonly frontDeskProfileReference: string;
}): Promise<MigratedPatientAccessGrantResult> {
  const patientId = referenceId(input.patientReference, "Patient");
  referenceId(input.clinicianProfileReference, "Practitioner");
  referenceId(input.frontDeskProfileReference, "Practitioner");
  if (input.clinicianProfileReference === input.frontDeskProfileReference) {
    throw new Error("Clinician and front-desk profiles must be two distinct Practitioners.");
  }

  let resolved: [
    Patient,
    ProjectMembership,
    ProjectMembership,
    AccessPolicy,
    AccessPolicy,
  ];
  try {
    resolved = await Promise.all([
      input.adapter.readPatient(patientId),
      input.adapter.resolveMembership(input.clinicianProfileReference),
      input.adapter.resolveMembership(input.frontDeskProfileReference),
      input.adapter.resolvePolicy("clinician"),
      input.adapter.resolvePolicy("front-desk"),
    ]);
    assertCanonicalPolicyRules(resolved[3], "clinician");
    assertCanonicalPolicyRules(resolved[4], "front-desk");
  } catch (error) {
    if (error instanceof PolicyDriftError) {
      input.ledger.recordResourceAction({
        runId: input.runId,
        sourceKey: error.role,
        resourceType: "AccessPolicy",
        resourceReference: error.policyReference,
        action: "conflict",
        reason: "canonical-policy-rules-diverged",
      });
    }
    throw error;
  }
  const [patient, clinicianMembership, frontDeskMembership, clinicianPolicy, frontDeskPolicy] =
    resolved;
  assertMembership(clinicianMembership, input.clinicianProfileReference, clinicianPolicy);
  assertMembership(frontDeskMembership, input.frontDeskProfileReference, frontDeskPolicy);
  if (clinicianMembership.id === frontDeskMembership.id) {
    throw new Error("The bounded grant set must resolve to exactly two memberships.");
  }

  const generalPractitioner = await grantGeneralPractitioner({
    adapter: input.adapter,
    ledger: input.ledger,
    runId: input.runId,
    patient,
    patientReference: input.patientReference,
    clinicianProfileReference: input.clinicianProfileReference,
    membership: clinicianMembership,
  });
  const clinicianGrant = await grantMembershipCompartment({
    adapter: input.adapter,
    ledger: input.ledger,
    runId: input.runId,
    patientReference: input.patientReference,
    membership: clinicianMembership,
    expectedAccess: buildProjectMembershipAccess({
      policyReference: `AccessPolicy/${clinicianPolicy.id}`,
      parameters: {
        providerProfileReference: input.clinicianProfileReference,
        patientCompartmentReference: input.patientReference,
      },
    })[0]!,
  });
  const frontDeskGrant = await grantMembershipCompartment({
    adapter: input.adapter,
    ledger: input.ledger,
    runId: input.runId,
    patientReference: input.patientReference,
    membership: frontDeskMembership,
    expectedAccess: buildProjectMembershipAccess({
      policyReference: `AccessPolicy/${frontDeskPolicy.id}`,
      parameters: {
        patientCompartmentReference: input.patientReference,
      },
    })[0]!,
  });

  return {
    patientReference: input.patientReference,
    generalPractitioner,
    clinicianMembership: clinicianGrant,
    frontDeskMembership: frontDeskGrant,
  };
}

export class LiveMigratedPatientAccessGrantAdapter
implements MigratedPatientAccessGrantAdapter {
  constructor(
    private readonly fhir: MedplumClient,
    private readonly projectId: string,
  ) {}

  readPatient(id: string): Promise<Patient> {
    return this.fhir.read("Patient", id);
  }

  async resolveMembership(profileReference: string): Promise<ProjectMembership> {
    const matches = (await searchAll<ProjectMembership>(
      this.fhir,
      "ProjectMembership",
      { profile: profileReference },
    )).filter((membership) =>
      membership.profile.reference === profileReference
      && membership.project.reference === `Project/${this.projectId}`
    );
    if (matches.length !== 1) {
      throw new MembershipResolutionError(profileReference, matches.length);
    }
    return matches[0]!;
  }

  async resolvePolicy(
    role: Extract<PracticeRoleId, "clinician" | "front-desk">,
  ): Promise<AccessPolicy> {
    const display = role === "clinician" ? "Clinician" : "Front Desk";
    const matches = (await searchAll<AccessPolicy>(
      this.fhir,
      "AccessPolicy",
      { "name:exact": `ODOS ${display}` },
    )).filter((policy) =>
      policy.name === `ODOS ${display}`
      && policy.meta?.tag?.some((tag) =>
        tag.system === ODOS_PRACTICE_ROLE_SYSTEM && tag.code === role
      )
    );
    if (matches.length !== 1) {
      throw new Error(`Expected one tagged ODOS ${display} policy; found ${matches.length}.`);
    }
    const policy = matches[0]!;
    assertCanonicalPolicyRules(policy, role);
    return policy;
  }

  patchPatient(
    id: string,
    operations: JsonPatchOperation[],
    versionId: string,
  ): Promise<Patient> {
    return this.fhir.patch(
      "Patient",
      id,
      operations,
      { ...WRITE_HEADERS, "If-Match": `W/"${versionId}"` },
    );
  }

  patchMembership(
    id: string,
    operations: JsonPatchOperation[],
    versionId: string,
  ): Promise<ProjectMembership> {
    return this.fhir.patch(
      "ProjectMembership",
      id,
      operations,
      { ...WRITE_HEADERS, "If-Match": `W/"${versionId}"` },
    );
  }
}

export function assertCanonicalPolicyRules(
  policy: AccessPolicy,
  role: Extract<PracticeRoleId, "clinician" | "front-desk">,
): void {
  const expected = buildMedplumAccessPolicy(getRoleDeclaration(role));
  if (canonicalPolicyRules(policy) !== canonicalPolicyRules(expected)) {
    throw new PolicyDriftError(
      role,
      policy.id ? `AccessPolicy/${policy.id}` : `AccessPolicy/${role}`,
    );
  }
}

function canonicalPolicyRules(policy: AccessPolicy): string {
  return JSON.stringify(
    (policy.resource ?? [])
      .map((rule) => canonicalPolicyValue(rule))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  );
}

function canonicalPolicyValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map(canonicalPolicyValue)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalPolicyValue(nested)]),
    );
  }
  return value;
}

async function grantGeneralPractitioner(input: {
  readonly adapter: MigratedPatientAccessGrantAdapter;
  readonly ledger: ImportLedger;
  readonly runId: string;
  readonly patient: Patient;
  readonly patientReference: string;
  readonly clinicianProfileReference: string;
  readonly membership: ProjectMembership;
}): Promise<"added" | "skipped"> {
  if (!input.patient.id || !input.patient.meta?.versionId || !input.membership.id) {
    throw new Error("Patient and clinician membership require ids and Patient meta.versionId.");
  }
  const present = input.patient.generalPractitioner?.some(
    (reference) => reference.reference === input.clinicianProfileReference,
  ) ?? false;
  const action = present ? "skipped" : "added";
  if (!present) {
    await input.adapter.patchPatient(
      input.patient.id,
      input.patient.generalPractitioner?.length
        ? [{
            op: "add",
            path: "/generalPractitioner/-",
            value: { reference: input.clinicianProfileReference },
          }]
        : [{
            op: "add",
            path: "/generalPractitioner",
            value: [{ reference: input.clinicianProfileReference }],
          }],
      input.patient.meta.versionId,
    );
  }
  input.ledger.recordAccessGrant({
    runId: input.runId,
    subjectReference: input.patientReference,
    membershipReference: `ProjectMembership/${input.membership.id}`,
    parameters: [{
      name: "generalPractitioner",
      value: input.clinicianProfileReference,
    }],
    action,
  });
  return action;
}

async function grantMembershipCompartment(input: {
  readonly adapter: MigratedPatientAccessGrantAdapter;
  readonly ledger: ImportLedger;
  readonly runId: string;
  readonly patientReference: string;
  readonly membership: ProjectMembership;
  readonly expectedAccess: ProjectMembershipAccess;
}): Promise<"added" | "skipped"> {
  if (!input.membership.id || !input.membership.meta?.versionId) {
    throw new Error("ProjectMembership requires id/meta.versionId for a version-aware grant.");
  }
  const alreadyGranted = hasPatientCompartmentGrant(
    input.membership,
    input.patientReference,
  );
  if (alreadyGranted) {
    const matchingEntries = (input.membership.access ?? []).filter((access) =>
      access.parameter?.some((parameter) =>
        parameter.name === "patient_compartment"
        && parameter.valueString === input.patientReference
      )
    );
    if (
      matchingEntries.length !== 1
      || JSON.stringify(normalizedAccess(matchingEntries[0]!))
        !== JSON.stringify(normalizedAccess(input.expectedAccess))
    ) {
      input.ledger.recordAccessGrant({
        runId: input.runId,
        subjectReference: input.patientReference,
        membershipReference: `ProjectMembership/${input.membership.id}`,
        parameters: ledgerParameters(input.expectedAccess),
        action: "conflict",
      });
      throw new Error(
        `Existing patient-compartment grant on ProjectMembership/${input.membership.id} `
        + "does not match the required role shape.",
      );
    }
  } else {
    await input.adapter.patchMembership(
      input.membership.id,
      input.membership.access?.length
        ? [{ op: "add", path: "/access/-", value: input.expectedAccess }]
        : [{ op: "add", path: "/access", value: [input.expectedAccess] }],
      input.membership.meta.versionId,
    );
  }
  const action = alreadyGranted ? "skipped" : "added";
  input.ledger.recordAccessGrant({
    runId: input.runId,
    subjectReference: input.patientReference,
    membershipReference: `ProjectMembership/${input.membership.id}`,
    parameters: ledgerParameters(input.expectedAccess),
    action,
  });
  return action;
}

function assertMembership(
  membership: ProjectMembership,
  profileReference: string,
  policy: AccessPolicy,
): void {
  if (!membership.id || !membership.meta?.versionId || !policy.id) {
    throw new Error("Resolved membership and policy require ids and membership meta.versionId.");
  }
  if (membership.profile.reference !== profileReference) {
    throw new Error(`Resolved membership profile does not equal ${profileReference}.`);
  }
  const policyReference = `AccessPolicy/${policy.id}`;
  const existingPolicies = [
    membership.accessPolicy?.reference,
    ...(membership.access ?? []).map((access) => access.policy.reference),
  ];
  if (!existingPolicies.includes(policyReference)) {
    throw new Error(
      `ProjectMembership/${membership.id} does not already carry ${policyReference}; `
      + "the provisioning script will not expand role scope.",
    );
  }
}

function normalizedAccess(access: ProjectMembershipAccess): unknown {
  return {
    policy: access.policy.reference,
    parameter: (access.parameter ?? []).map((parameter) => ({
      name: parameter.name,
      valueReference: parameter.valueReference?.reference,
      valueString: parameter.valueString,
    })),
  };
}

function ledgerParameters(access: ProjectMembershipAccess): Array<{
  name: string;
  value: string;
}> {
  return (access.parameter ?? []).map((parameter) => ({
    name: parameter.name ?? "",
    value: parameter.valueReference?.reference ?? parameter.valueString ?? "",
  }));
}

async function operatorContext(
  baseUrl: string,
  accessToken: string,
): Promise<{ projectId: string }> {
  const context = await ordinarySessionContext(fetch, baseUrl, accessToken, "Operator", {
    responseStatus: (status) => `Operator /auth/me failed: ${status}.`,
    missingProject: "Operator token has no active project.",
    superAdmin:
      "ODOS_OPERATOR_ACCESS_TOKEN must be a short-lived practice operator token, not superadmin.",
  });
  return { projectId: context.projectId };
}

export async function runGrantCli(input: {
  readonly baseUrl: string;
  readonly accessToken: string;
  readonly stateDirectory: string;
  readonly runId: string;
  readonly patientReference: string;
  readonly clinicianProfileReference: string;
  readonly frontDeskProfileReference: string;
}): Promise<MigratedPatientAccessGrantResult & { readonly reportPath: string }> {
  assertLocalMedplumBaseUrl(input.baseUrl);
  const context = await operatorContext(input.baseUrl, input.accessToken);
  const fhir = createMedplumClient({
    baseUrl: input.baseUrl,
    accessToken: input.accessToken,
  });
  const ledger = new ImportLedger({ stateDirectory: input.stateDirectory });
  try {
    ledger.resumePatientImportedRun(input.runId);
    try {
      const result = await grantMigratedPatientAccess({
        adapter: new LiveMigratedPatientAccessGrantAdapter(fhir, context.projectId),
        ledger,
        runId: input.runId,
        patientReference: input.patientReference,
        clinicianProfileReference: input.clinicianProfileReference,
        frontDeskProfileReference: input.frontDeskProfileReference,
      });
      ledger.finishRun(input.runId, "completed");
      return { ...result, reportPath: ledger.writeReport(input.runId) };
    } catch (error) {
      if (error instanceof MembershipResolutionError) {
        ledger.recordResourceAction({
          runId: input.runId,
          sourceKey: error.profileReference,
          resourceType: "ProjectMembership",
          action: "conflict",
          reason: `membership-match-count:${error.matchCount}`,
        });
      }
      ledger.finishRun(input.runId, "failed");
      ledger.writeReport(input.runId);
      throw error;
    }
  } finally {
    ledger.close();
  }
}

function optionalCliArgument(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1]?.trim() : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = process.argv.slice(2);
    const result = await runGrantCli({
      baseUrl: (process.env.MEDPLUM_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, ""),
      accessToken: requireEnv("ODOS_OPERATOR_ACCESS_TOKEN"),
      stateDirectory: optionalCliArgument(args, "--state-dir") ?? DEFAULT_M2A_STATE_DIR,
      runId: cliArgument(args, "--run-id"),
      patientReference: cliArgument(args, "--patient"),
      clinicianProfileReference: cliArgument(args, "--clinician-profile"),
      frontDeskProfileReference: cliArgument(args, "--front-desk-profile"),
    });
    console.log(
      `M2A access patient=${result.patientReference} `
      + `general_practitioner=${result.generalPractitioner} `
      + `clinician_membership=${result.clinicianMembership} `
      + `front_desk_membership=${result.frontDeskMembership} `
      + `report=${result.reportPath}`,
    );
  } catch (error) {
    const status = (error as { status?: number }).status;
    const suffix = status === 412
      ? " A resource changed during provisioning; rerun to re-evaluate current state."
      : "";
    console.error(`${error instanceof Error ? error.message : String(error)}${suffix}`);
    process.exitCode = 1;
  }
}
