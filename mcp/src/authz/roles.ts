import type {
  AccessPolicy,
  AccessPolicyResource,
  ProjectMembershipAccess,
} from "@medplum/fhirtypes";
import { OBSERVATION_STATUS_WRITE_CONSTRAINT_EXPRESSION } from "../../../policy/observation-status-machine.js";

export const FHIR_INTERACTIONS = [
  "create",
  "read",
  "update",
  "delete",
  "search",
  "history",
  "vread",
] as const;

export type FhirInteraction = (typeof FHIR_INTERACTIONS)[number];

export const PRACTICE_ROLE_IDS = [
  "practice-admin",
  "clinician",
  "front-desk",
  "auditor",
  "aesthetics-provider",
] as const;

export type PracticeRoleId = (typeof PRACTICE_ROLE_IDS)[number];

export const BUSINESS_ACTIONS = [
  "identity.manage",
  "role.review",
  "chart.read",
  "chart.write",
  "clinical.sign",
  "scheduling.manage",
  "demographics.update",
  "billing-context.read",
  "audit.read",
  "aesthetics.procedure.write",
  "break-glass.invoke",
] as const;

export type BusinessAction = (typeof BUSINESS_ACTIONS)[number];

export interface OsodRoleDeclaration {
  id: PracticeRoleId;
  display: string;
  description: string;
  businessActions: BusinessAction[];
  resourceRules: OsodResourceRule[];
  membershipParameters?: MembershipParameterDeclaration[];
}

export interface OsodResourceRule {
  resourceType: string;
  interactions: FhirInteraction[];
  scope: ResourceScope;
  readonlyFields?: string[];
  hiddenFields?: string[];
  writeConstraint?: WriteConstraintDeclaration[];
}

export type ResourceScope =
  | { kind: "practice" }
  | { kind: "patient-compartment"; parameterName: "patient_compartment" }
  | { kind: "provider-assigned-patient"; parameterName: "provider_profile" }
  | { kind: "self-profile"; parameterName: "provider_profile" }
  | { kind: "audit-only" };

export interface WriteConstraintDeclaration {
  description: string;
  expression: string;
}

export interface MembershipParameterDeclaration {
  name: "provider_profile" | "patient_compartment" | "license_state" | "procedure_scope";
  kind: "reference" | "string";
  description: string;
}

export interface RoleAccessParameterValues {
  providerProfileReference?: string;
  patientCompartmentReference?: string;
  licenseState?: string;
  procedureScope?: string;
}

export interface AestheticsProviderScopeInput {
  roleId: PracticeRoleId;
  licensedStates: string[];
  requestedState: string;
  procedureType?: string;
  allowedProcedureTypesByState?: Record<string, string[]>;
}

const READ_INTERACTIONS: FhirInteraction[] = ["read", "search", "history", "vread"];
const UPDATE_INTERACTIONS: FhirInteraction[] = [
  "create",
  "read",
  "update",
  "search",
  "history",
  "vread",
];
const FULL_INTERACTIONS: FhirInteraction[] = [...FHIR_INTERACTIONS];

const CLINICAL_WRITE_CONSTRAINTS: WriteConstraintDeclaration[] = [
  {
    description:
      "Signed clinical resources cannot be downgraded out of final/amended/corrected state by ordinary RBAC writes.",
    expression:
      "%before.exists() implies (%before.status != 'final' or status = 'final' or status = 'amended' or status = 'corrected' or status = 'entered-in-error')",
  },
  {
    description:
      "Observation.status must follow the v0.5c scribe-attestation-amendment state machine.",
    expression: OBSERVATION_STATUS_WRITE_CONSTRAINT_EXPRESSION,
  },
];

const PATIENT_COMPARTMENT_CLINICAL_RESOURCES = [
  "Encounter",
  "Observation",
  "Condition",
  "Procedure",
  "DiagnosticReport",
  "DocumentReference",
  "Media",
  "Device",
  "DeviceRequest",
  "MedicationStatement",
  "EpisodeOfCare",
  "CarePlan",
  "ChargeItem",
] as const;

const FRONT_DESK_RESOURCES = [
  "Patient",
  "RelatedPerson",
  "Coverage",
  "Account",
  "Appointment",
  "Slot",
  "Schedule",
  "Encounter",
] as const;

export const ROLE_REGISTRY: Record<PracticeRoleId, OsodRoleDeclaration> = {
  "practice-admin": {
    id: "practice-admin",
    display: "Practice Admin",
    description:
      "Practice-internal administrator for membership, role review, AccessPolicy binding, and audit-log access.",
    businessActions: ["identity.manage", "role.review", "audit.read", "break-glass.invoke"],
    resourceRules: [{ resourceType: "*", interactions: FULL_INTERACTIONS, scope: { kind: "practice" } }],
  },
  clinician: {
    id: "clinician",
    display: "Clinician",
    description:
      "Clinical user with patient-compartment-scoped chart access for assigned patients or explicit emergency access.",
    businessActions: ["chart.read", "chart.write", "clinical.sign", "break-glass.invoke"],
    membershipParameters: [
      {
        name: "provider_profile",
        kind: "reference",
        description: "Practitioner profile for provider-assigned Patient criteria.",
      },
      {
        name: "patient_compartment",
        kind: "string",
        description: "Patient/<id> compartment reference granted through assignment or break-glass.",
      },
    ],
    resourceRules: [
      {
        resourceType: "Patient",
        interactions: READ_INTERACTIONS,
        scope: { kind: "provider-assigned-patient", parameterName: "provider_profile" },
      },
      ...PATIENT_COMPARTMENT_CLINICAL_RESOURCES.map(
        (resourceType): OsodResourceRule => ({
          resourceType,
          interactions: UPDATE_INTERACTIONS,
          scope: { kind: "patient-compartment", parameterName: "patient_compartment" },
          writeConstraint:
            resourceType === "Observation" || resourceType === "DiagnosticReport"
              ? CLINICAL_WRITE_CONSTRAINTS
              : undefined,
        }),
      ),
      {
        resourceType: "Provenance",
        interactions: ["create", ...READ_INTERACTIONS],
        scope: { kind: "patient-compartment", parameterName: "patient_compartment" },
      },
      {
        resourceType: "Binary",
        interactions: ["read", "vread"],
        scope: { kind: "patient-compartment", parameterName: "patient_compartment" },
      },
    ],
  },
  "front-desk": {
    id: "front-desk",
    display: "Front Desk",
    description:
      "Scheduling, demographic, and financial-context access inside a patient compartment; no clinical writes.",
    businessActions: ["chart.read", "scheduling.manage", "demographics.update", "billing-context.read"],
    membershipParameters: [
      {
        name: "patient_compartment",
        kind: "string",
        description: "Patient/<id> compartment reference assigned for front-desk workflow.",
      },
    ],
    resourceRules: FRONT_DESK_RESOURCES.map((resourceType): OsodResourceRule => ({
      resourceType,
      interactions: resourceType === "Patient" ? UPDATE_INTERACTIONS : UPDATE_INTERACTIONS,
      scope: { kind: "patient-compartment", parameterName: "patient_compartment" },
    })),
  },
  auditor: {
    id: "auditor",
    display: "Auditor",
    description:
      "Read-only security-log and attribution review role; no PHI write capability.",
    businessActions: ["audit.read"],
    resourceRules: [
      { resourceType: "AuditEvent", interactions: READ_INTERACTIONS, scope: { kind: "audit-only" } },
      { resourceType: "Provenance", interactions: READ_INTERACTIONS, scope: { kind: "audit-only" } },
    ],
  },
  "aesthetics-provider": {
    id: "aesthetics-provider",
    display: "Aesthetics Provider",
    description:
      "Clinical write role constrained by patient compartment plus state-scoped procedure credentials.",
    businessActions: ["chart.read", "chart.write", "aesthetics.procedure.write", "break-glass.invoke"],
    membershipParameters: [
      {
        name: "patient_compartment",
        kind: "string",
        description: "Patient/<id> compartment reference for the aesthetics encounter.",
      },
      {
        name: "license_state",
        kind: "string",
        description: "US state where the provider credential is active for the procedure.",
      },
      {
        name: "procedure_scope",
        kind: "string",
        description: "Practice-local procedure category allowed under the state credential.",
      },
    ],
    resourceRules: [
      {
        resourceType: "Patient",
        interactions: READ_INTERACTIONS,
        scope: { kind: "patient-compartment", parameterName: "patient_compartment" },
      },
      {
        resourceType: "Procedure",
        interactions: UPDATE_INTERACTIONS,
        scope: { kind: "patient-compartment", parameterName: "patient_compartment" },
      },
      {
        resourceType: "DocumentReference",
        interactions: UPDATE_INTERACTIONS,
        scope: { kind: "patient-compartment", parameterName: "patient_compartment" },
      },
      {
        resourceType: "Media",
        interactions: UPDATE_INTERACTIONS,
        scope: { kind: "patient-compartment", parameterName: "patient_compartment" },
      },
      {
        resourceType: "Binary",
        interactions: ["read", "vread"],
        scope: { kind: "patient-compartment", parameterName: "patient_compartment" },
      },
      {
        resourceType: "Provenance",
        interactions: ["create", ...READ_INTERACTIONS],
        scope: { kind: "patient-compartment", parameterName: "patient_compartment" },
      },
    ],
  },
};

export function getRoleDeclaration(roleId: PracticeRoleId): OsodRoleDeclaration {
  return ROLE_REGISTRY[roleId];
}

export function buildMedplumAccessPolicy(role: OsodRoleDeclaration): AccessPolicy {
  return {
    resourceType: "AccessPolicy",
    name: `OSOD ${role.display}`,
    resource: role.resourceRules.map(toMedplumResourceRule),
  };
}

export function buildProjectMembershipAccess(input: {
  policyReference: string;
  parameters?: RoleAccessParameterValues;
}): ProjectMembershipAccess[] {
  const parameter = [
    input.parameters?.providerProfileReference
      ? {
          name: "provider_profile",
          valueReference: { reference: input.parameters.providerProfileReference },
        }
      : undefined,
    input.parameters?.patientCompartmentReference
      ? { name: "patient_compartment", valueString: input.parameters.patientCompartmentReference }
      : undefined,
    input.parameters?.licenseState
      ? { name: "license_state", valueString: input.parameters.licenseState.toUpperCase() }
      : undefined,
    input.parameters?.procedureScope
      ? { name: "procedure_scope", valueString: input.parameters.procedureScope }
      : undefined,
  ].filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

  return [
    {
      policy: { reference: input.policyReference },
      ...(parameter.length ? { parameter } : {}),
    },
  ];
}

export function assertBusinessActionAllowed(
  roleId: PracticeRoleId,
  businessAction: BusinessAction,
): void {
  const role = getRoleDeclaration(roleId);
  if (!role.businessActions.includes(businessAction)) {
    throw new Error(
      `OSOD RBAC preflight denied: role ${roleId} lacks business action ${businessAction}.`,
    );
  }
}

export function assertAestheticsProviderScope(input: AestheticsProviderScopeInput): void {
  if (input.roleId !== "aesthetics-provider") {
    return;
  }

  const requestedState = normalizeState(input.requestedState);
  const licensedStates = input.licensedStates.map(normalizeState);
  if (!licensedStates.includes(requestedState)) {
    throw new Error(
      `OSOD RBAC preflight denied: aesthetics-provider is not credentialed for ${requestedState}.`,
    );
  }

  if (!input.procedureType || !input.allowedProcedureTypesByState) {
    return;
  }

  const allowed = input.allowedProcedureTypesByState[requestedState] ?? [];
  if (!allowed.includes(input.procedureType)) {
    throw new Error(
      `OSOD RBAC preflight denied: aesthetics-provider credential for ${requestedState} does not include ${input.procedureType}.`,
    );
  }
}

export function accessPolicyHasNoBusinessActionVocabulary(policy: AccessPolicy): boolean {
  const serialized = JSON.stringify(policy);
  return BUSINESS_ACTIONS.every((action) => !serialized.includes(action));
}

function toMedplumResourceRule(rule: OsodResourceRule): AccessPolicyResource {
  return {
    resourceType: rule.resourceType,
    interaction: rule.interactions,
    ...(criteriaForRule(rule) ? { criteria: criteriaForRule(rule) } : {}),
    ...(rule.hiddenFields ? { hiddenFields: rule.hiddenFields } : {}),
    ...(rule.readonlyFields ? { readonlyFields: rule.readonlyFields } : {}),
    ...(rule.writeConstraint
      ? {
          writeConstraint: rule.writeConstraint.map((constraint) => ({
            language: "text/fhirpath" as const,
            description: constraint.description,
            expression: constraint.expression,
          })),
        }
      : {}),
  };
}

function criteriaForRule(rule: OsodResourceRule): string | undefined {
  switch (rule.scope.kind) {
    case "practice":
    case "audit-only":
      return undefined;
    case "patient-compartment":
      return `${rule.resourceType}?_compartment=%${rule.scope.parameterName}`;
    case "provider-assigned-patient":
      return `${rule.resourceType}?general-practitioner=%${rule.scope.parameterName}`;
    case "self-profile":
      return `${rule.resourceType}?_id=%${rule.scope.parameterName}.id`;
  }
}

function normalizeState(state: string): string {
  const normalized = state.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) {
    throw new Error(`Expected two-letter US state code; received "${state}".`);
  }
  return normalized;
}
