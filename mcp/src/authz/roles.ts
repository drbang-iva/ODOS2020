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
  "payment.charge",
  "claims.manage",
  "finding-definitions.write",
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
  | { kind: "audit-only" }
  /** Practice-wide but fenced to a fixed search criteria (e.g. one coded singleton). */
  | { kind: "practice-search"; criteria: string };

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
const CREATE_READ_INTERACTIONS: FhirInteraction[] = ["create", "read", "search", "history", "vread"];
const FULL_INTERACTIONS: FhirInteraction[] = [...FHIR_INTERACTIONS];

/**
 * Dispensary catalog, inventory, order + financial resources granted to front-desk at practice
 * scope (v0.6c payments authorization model, decision 2026-07-05 §2). Practice-scope not
 * patient-compartment: the dispensary is a walk-up counter, and PaymentReconciliation is not a
 * Patient-compartment resource. Frame inventory is code-fenced from every other Basic resource.
 * PaymentReconciliation stays create/read-only for staff; Phase 6a mutations cross the guarded
 * osod-core lifecycle handlers. Task/Invoice also need update (status advance / manual cash).
 */
const DISPENSARY_RESOURCE_RULES: OsodResourceRule[] = [
  { resourceType: "DeviceDefinition", interactions: READ_INTERACTIONS, scope: { kind: "practice" } },
  {
    resourceType: "Basic",
    interactions: UPDATE_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria:
        "Basic?code=https://osod.dev/fhir/CodeSystem/basic-kind|practice-frame-inventory",
    },
  },
  { resourceType: "DeviceRequest", interactions: CREATE_READ_INTERACTIONS, scope: { kind: "practice" } },
  { resourceType: "ChargeItem", interactions: CREATE_READ_INTERACTIONS, scope: { kind: "practice" } },
  { resourceType: "PaymentReconciliation", interactions: CREATE_READ_INTERACTIONS, scope: { kind: "practice" } },
  { resourceType: "Task", interactions: UPDATE_INTERACTIONS, scope: { kind: "practice" } },
  { resourceType: "Invoice", interactions: UPDATE_INTERACTIONS, scope: { kind: "practice" } },
];

const CLAIMS_RESOURCE_RULES: OsodResourceRule[] = [
  { resourceType: "Claim", interactions: UPDATE_INTERACTIONS, scope: { kind: "practice" } },
  { resourceType: "ClaimResponse", interactions: UPDATE_INTERACTIONS, scope: { kind: "practice" } },
  { resourceType: "CoverageEligibilityRequest", interactions: CREATE_READ_INTERACTIONS, scope: { kind: "practice" } },
  { resourceType: "CoverageEligibilityResponse", interactions: CREATE_READ_INTERACTIONS, scope: { kind: "practice" } },
  {
    resourceType: "Basic",
    interactions: UPDATE_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria: "Basic?code=https://osod.dev/fhir/CodeSystem/osod-era-import|osod-era-import",
    },
  },
  {
    resourceType: "Basic",
    interactions: UPDATE_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria: "Basic?code=https://osod.dev/fhir/CodeSystem/osod-manual-eob|osod-manual-eob",
    },
  },
];

const OFFICE_CHANNEL_RESOURCE_RULES: OsodResourceRule[] = [
  { resourceType: "Practitioner", interactions: READ_INTERACTIONS, scope: { kind: "practice" } },
  { resourceType: "PractitionerRole", interactions: READ_INTERACTIONS, scope: { kind: "practice" } },
  { resourceType: "Communication", interactions: CREATE_READ_INTERACTIONS, scope: { kind: "practice" } },
  { resourceType: "Provenance", interactions: CREATE_READ_INTERACTIONS, scope: { kind: "practice" } },
];

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
  "Encounter",
] as const;

/**
 * Scheduler resources granted to front-desk at practice scope (scheduler Phase 3a, parallel to
 * PRs #24-#26). Practice-scope not patient-compartment: the day grid reads ALL resources'
 * Schedules, the whole visit-type catalog, and every patient's appointments for the day, and
 * booking writes Appointments for arbitrary patients — Schedule/Slot/HealthcareService are not
 * Patient-compartment resources at all, so a compartment criteria matches nothing. Mirrors the
 * v0.6c dispensary practice-scope precedent (decision 2026-07-05 §2). Schedule/Slot/
 * HealthcareService stay read-only (practice-admin manages them); Appointment gets no delete —
 * cancellation is a status change, never a delete.
 */
const SCHEDULING_RESOURCE_RULES: OsodResourceRule[] = [
  { resourceType: "Appointment", interactions: UPDATE_INTERACTIONS, scope: { kind: "practice" } },
  { resourceType: "Schedule", interactions: READ_INTERACTIONS, scope: { kind: "practice" } },
  { resourceType: "Slot", interactions: READ_INTERACTIONS, scope: { kind: "practice" } },
  { resourceType: "HealthcareService", interactions: READ_INTERACTIONS, scope: { kind: "practice" } },
  // Phase 4a: the practice scheduling-config singleton (hours/templates/blocked time/offices).
  // Criteria-fenced so the desk touches exactly one coded Basic — never Basic at large.
  {
    resourceType: "Basic",
    interactions: UPDATE_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria:
        "Basic?code=https://osod.dev/fhir/CodeSystem/scheduling-config|osod-scheduling-config",
    },
  },
  {
    resourceType: "Basic",
    interactions: UPDATE_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria:
        "Basic?code=https://osod.dev/fhir/CodeSystem/floor-config|osod-floor-config",
    },
  },
  {
    resourceType: "Basic",
    interactions: UPDATE_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria:
        "Basic?code=https://osod.dev/fhir/CodeSystem/insurance-config|osod-insurance-config",
    },
  },
  // Visit-type categories singleton: READ-only for the desk. The settings read-only
  // contract requires the categories section to render for front-desk while write
  // stays practice-admin-only (settings-catalog RBAC review, 2026-07-10).
  {
    resourceType: "Basic",
    interactions: READ_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria:
        "Basic?code=https://osod.dev/fhir/CodeSystem/visit-type-config|osod-visit-type-config",
    },
  },
];

export const ROLE_REGISTRY: Record<PracticeRoleId, OsodRoleDeclaration> = {
  "practice-admin": {
    id: "practice-admin",
    display: "Practice Admin",
    description:
      "Practice-internal administrator for membership, role review, AccessPolicy binding, and audit-log access.",
    businessActions: ["identity.manage", "role.review", "audit.read", "break-glass.invoke", "payment.charge", "claims.manage", "finding-definitions.write"],
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
      ...OFFICE_CHANNEL_RESOURCE_RULES,
    ],
  },
  "front-desk": {
    id: "front-desk",
    display: "Front Desk",
    description:
      "Scheduling, demographic, and financial-context access inside a patient compartment; no clinical writes.",
    businessActions: ["chart.read", "scheduling.manage", "demographics.update", "billing-context.read", "payment.charge", "claims.manage"],
    membershipParameters: [
      {
        name: "patient_compartment",
        kind: "string",
        description: "Patient/<id> compartment reference assigned for front-desk workflow.",
      },
    ],
    resourceRules: [
      ...FRONT_DESK_RESOURCES.map((resourceType): OsodResourceRule => ({
        resourceType,
        interactions: UPDATE_INTERACTIONS,
        scope: { kind: "patient-compartment", parameterName: "patient_compartment" },
      })),
      ...SCHEDULING_RESOURCE_RULES,
      ...DISPENSARY_RESOURCE_RULES,
      ...CLAIMS_RESOURCE_RULES,
      ...OFFICE_CHANNEL_RESOURCE_RULES,
    ],
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

export const OSOD_PRACTICE_ROLE_SYSTEM = "https://osod.dev/fhir/NamingSystem/practice-role";

export function buildMedplumAccessPolicy(role: OsodRoleDeclaration): AccessPolicy {
  return {
    resourceType: "AccessPolicy",
    name: `OSOD ${role.display}`,
    // Machine-readable role↔policy link so the payment endpoint can derive a caller's role from
    // their bound AccessPolicy (decision 2026-07-05 §3) rather than a spoofable client header.
    // Carried on meta.tag — Medplum's AccessPolicy resource has no identifier element.
    meta: { tag: [{ system: OSOD_PRACTICE_ROLE_SYSTEM, code: role.id }] },
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
    case "practice-search":
      return rule.scope.criteria;
  }
}

function normalizeState(state: string): string {
  const normalized = state.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) {
    throw new Error(`Expected two-letter US state code; received "${state}".`);
  }
  return normalized;
}
