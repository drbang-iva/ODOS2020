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
  "provider",
  "staff",
  "admin",
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
  "payment.void",
  // Declared ahead of a dedicated enforcement point; no write-off route or policy rule exists yet.
  "payment.write-off",
  "payment.seal-day",
  "margin.read",
  "inventory.adjust",
  "inventory.price",
  "claims.manage",
  "finding-definitions.write",
  "protocols.author",
  "document.fax-send",
  "communications.read",
  "communications.content.read",
  "communications.send",
  "communications.call",
] as const;

export type BusinessAction = (typeof BUSINESS_ACTIONS)[number];

export interface OdosRoleDeclaration {
  id: PracticeRoleId;
  display: string;
  description: string;
  businessActions: BusinessAction[];
  resourceRules: OdosResourceRule[];
  membershipParameters?: MembershipParameterDeclaration[];
}

export interface OdosResourceRule {
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
const UPDATE_INTERACTIONS: FhirInteraction[] = ["create", "update"];
const CREATE_READ_INTERACTIONS: FhirInteraction[] = ["create"];
const READ_UPDATE_INTERACTIONS: FhirInteraction[] = ["update"];

const PRACTICE_READ_RESOURCE_TYPES = [
  "Patient",
  "RelatedPerson",
  "Coverage",
  "Account",
  "AllergyIntolerance",
  "Encounter",
  "Observation",
  "Condition",
  "Procedure",
  "DiagnosticReport",
  "DocumentReference",
  "Media",
  "Device",
  "DeviceRequest",
  "MedicationAdministration",
  "MedicationRequest",
  "MedicationStatement",
  "EpisodeOfCare",
  "CarePlan",
  "Goal",
  "PlanDefinition",
  "ChargeItem",
  "ChargeItemDefinition",
  "QuestionnaireResponse",
  "Provenance",
  "Binary",
  "ServiceRequest",
  "Appointment",
  "Schedule",
  "Slot",
  "HealthcareService",
  "DeviceDefinition",
  "PaymentReconciliation",
  "Task",
  "Invoice",
  "Claim",
  "ClaimResponse",
  "CoverageEligibilityRequest",
  "CoverageEligibilityResponse",
  "Organization",
  "Practitioner",
  "PractitionerRole",
  "Communication",
  "BodyStructure",
  "CareTeam",
  "DeviceUseStatement",
  "VisionPrescription",
] as const;

const PRACTICE_READ_RESOURCE_RULES: OdosResourceRule[] = PRACTICE_READ_RESOURCE_TYPES.map(
  (resourceType) => ({ resourceType, interactions: READ_INTERACTIONS, scope: { kind: "practice" } }),
);

const STAFF_OBSERVATION_WRITE_CONSTRAINTS: WriteConstraintDeclaration[] = [
  {
    description: "Staff and scribe findings remain preliminary until a Provider attests them.",
    expression:
      "(%before.exists().not() implies status = 'preliminary') and (%before.exists() implies (%before.status = 'preliminary' and status = 'preliminary'))",
  },
];

const STAFF_ENCOUNTER_WRITE_CONSTRAINTS: WriteConstraintDeclaration[] = [
  {
    description: "Staff can create or edit an Encounter only while it remains unfinished.",
    expression: "status != 'finished' and (%before.exists() implies %before.status != 'finished')",
  },
];

const FRAME_INVENTORY_STATUS_URL =
  "https://odos2020.com/fhir/StructureDefinition/unit-status";
const FRAME_INVENTORY_STAFF_WRITE_CONSTRAINTS: WriteConstraintDeclaration[] = [
  {
    description:
      "Staff receipts create on-hand units; later writes preserve inventory identity and received-at provenance.",
    expression: [
      "(%before.exists().not() implies extension.where(url = 'https://odos2020.com/fhir/StructureDefinition/unit-status').value = 'on_hand')",
      "and (%before.exists() implies code ~ %before.code)",
      "and (%before.exists() implies identifier ~ %before.identifier)",
      "and (%before.exists() implies extension.where(url = 'https://odos2020.com/fhir/StructureDefinition/catalog-canonical-url').value = %before.extension.where(url = 'https://odos2020.com/fhir/StructureDefinition/catalog-canonical-url').value)",
      "and (%before.exists() implies extension.where(url = 'https://odos2020.com/fhir/StructureDefinition/received-at').value = %before.extension.where(url = 'https://odos2020.com/fhir/StructureDefinition/received-at').value)",
      "and (%before.exists() implies extension.where(url = 'https://odos2020.com/fhir/StructureDefinition/dispensary-location').value = %before.extension.where(url = 'https://odos2020.com/fhir/StructureDefinition/dispensary-location').value)",
    ].join(" "),
  },
  {
    description: "Staff can advance inventory workflow status but cannot reverse or arbitrarily adjust it.",
    expression: [
      "(%before.exists().not())",
      `or (%before.extension.where(url = '${FRAME_INVENTORY_STATUS_URL}').value = extension.where(url = '${FRAME_INVENTORY_STATUS_URL}').value)`,
      `or (%before.extension.where(url = '${FRAME_INVENTORY_STATUS_URL}').value = 'on_hand' and extension.where(url = '${FRAME_INVENTORY_STATUS_URL}').value in ('reserved' | 'hold' | 'dispensed'))`,
      `or (%before.extension.where(url = '${FRAME_INVENTORY_STATUS_URL}').value = 'reserved' and extension.where(url = '${FRAME_INVENTORY_STATUS_URL}').value in ('outbound' | 'at_lab' | 'dispensed'))`,
      `or (%before.extension.where(url = '${FRAME_INVENTORY_STATUS_URL}').value = 'outbound' and extension.where(url = '${FRAME_INVENTORY_STATUS_URL}').value in ('at_lab' | 'inbound' | 'dispensed'))`,
      `or (%before.extension.where(url = '${FRAME_INVENTORY_STATUS_URL}').value = 'at_lab' and extension.where(url = '${FRAME_INVENTORY_STATUS_URL}').value in ('inbound' | 'dispensed'))`,
      `or (%before.extension.where(url = '${FRAME_INVENTORY_STATUS_URL}').value = 'inbound' and extension.where(url = '${FRAME_INVENTORY_STATUS_URL}').value = 'dispensed')`,
    ].join(" "),
  },
];

/**
 * Dispensary catalog, inventory, order + financial resources granted to front-desk at practice
 * scope (v0.6c payments authorization model, decision 2026-07-05 §2). Practice-scope not
 * patient-compartment: the dispensary is a walk-up counter, and PaymentReconciliation is not a
 * Patient-compartment resource. Frame inventory is code-fenced from every other Basic resource.
 * PaymentReconciliation stays create/read-only for staff; Phase 6a mutations cross the guarded
 * odos-core lifecycle handlers. Task/Invoice also need update (status advance / manual cash).
 */
const DISPENSARY_READ_RESOURCE_RULES: OdosResourceRule[] = [
  {
    resourceType: "Basic",
    interactions: READ_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria:
        "Basic?code=https://odos2020.com/fhir/CodeSystem/basic-kind|practice-frame-inventory",
    },
  },
  {
    resourceType: "Basic",
    interactions: READ_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria:
        "Basic?code=https://odos2020.com/fhir/CodeSystem/basic-kind|practice-frame-inventory-unit",
    },
  },
  {
    resourceType: "Basic",
    interactions: READ_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria:
        "Basic?code=https://odos2020.com/fhir/CodeSystem/basic-kind|practice-frame-variant-settings",
    },
  },
  {
    resourceType: "Basic",
    interactions: READ_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria: "Basic?code=https://odos2020.com/fhir/CodeSystem/day-seal|day-seal",
    },
  },
];

const STAFF_DISPENSARY_WRITE_RESOURCE_RULES: OdosResourceRule[] = [
  {
    resourceType: "Basic",
    interactions: UPDATE_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria:
        "Basic?code=https://odos2020.com/fhir/CodeSystem/basic-kind|practice-frame-inventory-unit",
    },
    writeConstraint: FRAME_INVENTORY_STAFF_WRITE_CONSTRAINTS,
  },
  { resourceType: "DeviceRequest", interactions: CREATE_READ_INTERACTIONS, scope: { kind: "practice" } },
  { resourceType: "ChargeItem", interactions: CREATE_READ_INTERACTIONS, scope: { kind: "practice" } },
  { resourceType: "PaymentReconciliation", interactions: CREATE_READ_INTERACTIONS, scope: { kind: "practice" } },
  { resourceType: "Task", interactions: UPDATE_INTERACTIONS, scope: { kind: "practice" } },
  { resourceType: "Invoice", interactions: UPDATE_INTERACTIONS, scope: { kind: "practice" } },
];

const PAYMENT_CUSTODY_RESOURCE_RULES: OdosResourceRule[] = [
  { resourceType: "PaymentReconciliation", interactions: CREATE_READ_INTERACTIONS, scope: { kind: "practice" } },
  { resourceType: "Invoice", interactions: READ_UPDATE_INTERACTIONS, scope: { kind: "practice" } },
];

const ADMIN_CORRECTION_RESOURCE_RULES: OdosResourceRule[] = [
  {
    resourceType: "HealthcareService",
    interactions: UPDATE_INTERACTIONS,
    scope: { kind: "practice" },
  },
  {
    resourceType: "ChargeItemDefinition",
    interactions: UPDATE_INTERACTIONS,
    scope: { kind: "practice" },
  },
  {
    resourceType: "Basic",
    interactions: UPDATE_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria:
        "Basic?code=https://odos2020.com/fhir/CodeSystem/visit-type-config|odos-visit-type-config",
    },
  },
  {
    resourceType: "Basic",
    interactions: READ_UPDATE_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria:
        "Basic?code=https://odos2020.com/fhir/CodeSystem/basic-kind|practice-frame-inventory-unit",
    },
  },
  {
    resourceType: "Basic",
    interactions: UPDATE_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria:
        "Basic?code=https://odos2020.com/fhir/CodeSystem/basic-kind|practice-frame-variant-settings",
    },
  },
  {
    resourceType: "Basic",
    interactions: CREATE_READ_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria: "Basic?code=https://odos2020.com/fhir/CodeSystem/day-seal|day-seal",
    },
  },
  { resourceType: "Invoice", interactions: READ_UPDATE_INTERACTIONS, scope: { kind: "practice" } },
];

const CLAIMS_RESOURCE_RULES: OdosResourceRule[] = [
  { resourceType: "Claim", interactions: UPDATE_INTERACTIONS, scope: { kind: "practice" } },
  { resourceType: "ClaimResponse", interactions: UPDATE_INTERACTIONS, scope: { kind: "practice" } },
  { resourceType: "CoverageEligibilityRequest", interactions: CREATE_READ_INTERACTIONS, scope: { kind: "practice" } },
  { resourceType: "CoverageEligibilityResponse", interactions: CREATE_READ_INTERACTIONS, scope: { kind: "practice" } },
  {
    resourceType: "Basic",
    interactions: READ_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria: "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-era-import|odos-era-import",
    },
  },
  {
    resourceType: "Basic",
    interactions: UPDATE_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria: "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-era-import|odos-era-import",
    },
  },
  {
    resourceType: "Basic",
    interactions: READ_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria: "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-manual-eob|odos-manual-eob",
    },
  },
  {
    resourceType: "Basic",
    interactions: UPDATE_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria: "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-manual-eob|odos-manual-eob",
    },
  },
];

const PAYER_DIRECTORY_RESOURCE_RULES: OdosResourceRule[] = [
  { resourceType: "Organization", interactions: CREATE_READ_INTERACTIONS, scope: { kind: "practice" } },
];

const BILLING_IDENTITY_CONFIG_READ_RULE: OdosResourceRule = {
  resourceType: "Basic",
  interactions: READ_INTERACTIONS,
  scope: {
    kind: "practice-search",
    criteria:
      "Basic?code=https://odos2020.com/fhir/CodeSystem/billing-identity-config|odos-billing-identity-config",
  },
};

const BILLING_IDENTITY_CONFIG_WRITE_RULE: OdosResourceRule = {
  resourceType: "Basic",
  interactions: UPDATE_INTERACTIONS,
  scope: {
    kind: "practice-search",
    criteria:
      "Basic?code=https://odos2020.com/fhir/CodeSystem/billing-identity-config|odos-billing-identity-config",
  },
};

const OFFICE_CHANNEL_RESOURCE_RULES: OdosResourceRule[] = [
  { resourceType: "Practitioner", interactions: READ_INTERACTIONS, scope: { kind: "practice" } },
  { resourceType: "PractitionerRole", interactions: READ_INTERACTIONS, scope: { kind: "practice" } },
  {
    resourceType: "Communication",
    interactions: CREATE_READ_INTERACTIONS,
    scope: { kind: "practice-search", criteria: "Communication?category=https://odos2020.com/fhir/CodeSystem/communication-category|internal-office" },
  },
  {
    resourceType: "Provenance",
    interactions: CREATE_READ_INTERACTIONS,
    scope: { kind: "practice-search", criteria: "Provenance?_tag=https://odos2020.com/fhir/CodeSystem/office-message-kind|acknowledgement" },
  },
];

const PATIENT_COMMUNICATION_COMPARTMENT_RULE: OdosResourceRule = {
  resourceType: "Communication",
  interactions: UPDATE_INTERACTIONS,
  scope: { kind: "patient-compartment", parameterName: "patient_compartment" },
};

const FRONT_DESK_PATIENT_COMMUNICATION_RULE: OdosResourceRule = {
  resourceType: "Communication",
  interactions: UPDATE_INTERACTIONS,
  scope: { kind: "patient-compartment", parameterName: "patient_compartment" },
};

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
  "MedicationAdministration",
  "MedicationStatement",
  "EpisodeOfCare",
  "CarePlan",
  "ChargeItem",
  "QuestionnaireResponse",
] as const;

const STAFF_DEMOGRAPHIC_RESOURCES = [
  "Patient",
  "RelatedPerson",
  "Coverage",
  "Account",
] as const;

const STAFF_FINDING_RESOURCES = [
  "Observation",
  "DiagnosticReport",
  "DocumentReference",
  "Media",
  "QuestionnaireResponse",
  "MedicationAdministration",
  "MedicationStatement",
] as const;

const STAFF_DEMOGRAPHIC_WRITE_RESOURCE_RULES: OdosResourceRule[] =
  STAFF_DEMOGRAPHIC_RESOURCES.map((resourceType): OdosResourceRule => ({
    resourceType,
    interactions: UPDATE_INTERACTIONS,
    scope: { kind: "patient-compartment", parameterName: "patient_compartment" },
  }));

const STAFF_ENCOUNTER_WRITE_RESOURCE_RULE: OdosResourceRule = {
  resourceType: "Encounter",
  interactions: UPDATE_INTERACTIONS,
  scope: { kind: "patient-compartment", parameterName: "patient_compartment" },
  writeConstraint: STAFF_ENCOUNTER_WRITE_CONSTRAINTS,
};

const STAFF_FINDING_WRITE_RESOURCE_RULES: OdosResourceRule[] =
  STAFF_FINDING_RESOURCES.map((resourceType): OdosResourceRule => ({
    resourceType,
    interactions: UPDATE_INTERACTIONS,
    scope: { kind: "patient-compartment", parameterName: "patient_compartment" },
    writeConstraint:
      resourceType === "Observation" || resourceType === "DiagnosticReport"
        ? STAFF_OBSERVATION_WRITE_CONSTRAINTS
        : undefined,
  }));

const STAFF_PATIENT_WRITE_RESOURCE_RULES: OdosResourceRule[] = [
  ...STAFF_DEMOGRAPHIC_WRITE_RESOURCE_RULES,
  STAFF_ENCOUNTER_WRITE_RESOURCE_RULE,
  ...STAFF_FINDING_WRITE_RESOURCE_RULES,
  {
    resourceType: "Provenance",
    interactions: ["create"],
    scope: { kind: "practice" },
  },
];

const PROVIDER_CLINICAL_WRITE_RESOURCE_RULES: OdosResourceRule[] = [
  ...PATIENT_COMPARTMENT_CLINICAL_RESOURCES.map((resourceType): OdosResourceRule => ({
    resourceType,
    interactions: UPDATE_INTERACTIONS,
    scope: { kind: "patient-compartment", parameterName: "patient_compartment" },
    writeConstraint:
      resourceType === "Observation" || resourceType === "DiagnosticReport"
        ? CLINICAL_WRITE_CONSTRAINTS
        : undefined,
  })),
  {
    resourceType: "Provenance",
    interactions: ["create"],
    scope: { kind: "practice" },
  },
];

const STAFF_CORRESPONDENCE_RESOURCE_RULES: OdosResourceRule[] = [
  {
    resourceType: "ServiceRequest",
    interactions: UPDATE_INTERACTIONS,
    scope: { kind: "patient-compartment", parameterName: "patient_compartment" },
  },
  {
    resourceType: "DocumentReference",
    interactions: CREATE_READ_INTERACTIONS,
    scope: { kind: "patient-compartment", parameterName: "patient_compartment" },
  },
];

/**
 * Scheduler resources granted to front-desk at practice scope (scheduler Phase 3a, parallel to
 * PRs #24-#26). Practice-scope not patient-compartment: the day grid reads ALL resources'
 * Schedules, the whole visit-type catalog, and every patient's appointments for the day, and
 * booking writes Appointments for arbitrary patients — Schedule/Slot/HealthcareService are not
 * Patient-compartment resources at all, so a compartment criteria matches nothing. Mirrors the
 * v0.6c dispensary practice-scope precedent (decision 2026-07-05 §2). Schedule and Slot stay
 * direct-policy read-only: Schedule writes use the Admin-gated service route, while Slots are
 * generated in memory. HealthcareService writes use Admin's explicit practice-scoped correction
 * rule. No scheduling resource gets delete; cancellation and deactivation are state changes.
 */
const SCHEDULING_RESOURCE_RULES: OdosResourceRule[] = [
  { resourceType: "Appointment", interactions: UPDATE_INTERACTIONS, scope: { kind: "practice" } },
  // Phase 4a: the practice scheduling-config singleton (hours/templates/blocked time/offices).
  // Criteria-fenced so the desk touches exactly one coded Basic — never Basic at large.
  {
    resourceType: "Basic",
    interactions: READ_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria:
        "Basic?code=https://odos2020.com/fhir/CodeSystem/scheduling-config|odos-scheduling-config",
    },
  },
  {
    resourceType: "Basic",
    interactions: UPDATE_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria:
        "Basic?code=https://odos2020.com/fhir/CodeSystem/scheduling-config|odos-scheduling-config",
    },
  },
  {
    resourceType: "Basic",
    interactions: READ_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria:
        "Basic?code=https://odos2020.com/fhir/CodeSystem/floor-config|odos-floor-config",
    },
  },
  {
    resourceType: "Basic",
    interactions: UPDATE_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria:
        "Basic?code=https://odos2020.com/fhir/CodeSystem/floor-config|odos-floor-config",
    },
  },
  {
    resourceType: "Basic",
    interactions: READ_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria:
        "Basic?code=https://odos2020.com/fhir/CodeSystem/insurance-config|odos-insurance-config",
    },
  },
  {
    resourceType: "Basic",
    interactions: UPDATE_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria:
        "Basic?code=https://odos2020.com/fhir/CodeSystem/insurance-config|odos-insurance-config",
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
        "Basic?code=https://odos2020.com/fhir/CodeSystem/visit-type-config|odos-visit-type-config",
    },
  },
  {
    resourceType: "Basic",
    interactions: READ_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria:
        "Basic?code=https://odos2020.com/fhir/CodeSystem/statement-message-config|odos-statement-message-config",
    },
  },
];

const APPEARANCE_CONFIG_READ_RULE: OdosResourceRule = {
  resourceType: "Basic",
  interactions: READ_INTERACTIONS,
  scope: {
    kind: "practice-search",
    criteria:
      "Basic?code=https://odos2020.com/fhir/CodeSystem/appearance-config|odos-appearance-config",
  },
};

const PROTOCOL_MODULE_RESOURCE_RULES: OdosResourceRule[] = [
  {
    resourceType: "Basic",
    interactions: READ_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria:
        "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-protocol-module|odos-protocol-definition",
    },
  },
  {
    resourceType: "Basic",
    interactions: UPDATE_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria:
        "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-protocol-module|odos-protocol-definition",
    },
  },
  {
    resourceType: "Basic",
    interactions: READ_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria:
        "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-protocol-module|odos-protocol-definition-snapshot",
    },
  },
  {
    resourceType: "Basic",
    interactions: CREATE_READ_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria:
        "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-protocol-module|odos-protocol-definition-snapshot",
    },
  },
  ...[
    "odos-plan-action-instance",
    "odos-protocol-application",
    "odos-charge-proposal",
    "odos-finding-instance",
  ].flatMap((code): OdosResourceRule[] => [
    {
      resourceType: "Basic",
      interactions: READ_INTERACTIONS,
      scope: {
        kind: "practice-search",
        criteria: `Basic?code=https://odos2020.com/fhir/CodeSystem/odos-protocol-module|${code}`,
      },
    },
    {
      resourceType: "Basic",
      interactions: UPDATE_INTERACTIONS,
      scope: {
        kind: "practice-search",
        criteria: `Basic?code=https://odos2020.com/fhir/CodeSystem/odos-protocol-module|${code}`,
      },
    },
  ]),
];

export const ROLE_REGISTRY: Record<PracticeRoleId, OdosRoleDeclaration> = {
  provider: {
    id: "provider",
    display: "Provider",
    description:
      "Clinical author and signer with practice-wide reads and patient-compartment-constrained writes.",
    businessActions: [
      "chart.read",
      "chart.write",
      "clinical.sign",
      "billing-context.read",
      "aesthetics.procedure.write",
      "break-glass.invoke",
      "payment.charge",
      "protocols.author",
      "document.fax-send",
      "communications.read",
      "communications.content.read",
      "communications.send",
      "communications.call",
    ],
    membershipParameters: [
      {
        name: "provider_profile",
        kind: "reference",
        description: "Practitioner profile retained for write/action gates and attribution.",
      },
      {
        name: "patient_compartment",
        kind: "string",
        description: "Patient/<id> compartment reference granted for clinical writes.",
      },
      {
        name: "license_state",
        kind: "string",
        description: "US state where the provider credential is active for an aesthetics procedure.",
      },
      {
        name: "procedure_scope",
        kind: "string",
        description: "Practice-local aesthetics procedure category allowed under the state credential.",
      },
    ],
    resourceRules: [
      ...PRACTICE_READ_RESOURCE_RULES,
      ...PROVIDER_CLINICAL_WRITE_RESOURCE_RULES,
      ...STAFF_CORRESPONDENCE_RESOURCE_RULES,
      ...PAYMENT_CUSTODY_RESOURCE_RULES,
      BILLING_IDENTITY_CONFIG_READ_RULE,
      ...OFFICE_CHANNEL_RESOURCE_RULES,
      PATIENT_COMMUNICATION_COMPARTMENT_RULE,
      ...PROTOCOL_MODULE_RESOURCE_RULES,
      APPEARANCE_CONFIG_READ_RULE,
    ],
  },
  staff: {
    id: "staff",
    display: "Staff",
    description:
      "Routine desk, technician, optician, and billing work with preliminary finding entry but no authorship or signature.",
    businessActions: [
      "chart.read",
      "chart.write",
      "scheduling.manage",
      "demographics.update",
      "billing-context.read",
      "payment.charge",
      "claims.manage",
      "document.fax-send",
      "communications.read",
      "communications.content.read",
      "communications.send",
      "communications.call",
    ],
    membershipParameters: [
      {
        name: "patient_compartment",
        kind: "string",
        description: "Patient/<id> compartment reference granted for routine writes.",
      },
    ],
    resourceRules: [
      ...PRACTICE_READ_RESOURCE_RULES,
      ...DISPENSARY_READ_RESOURCE_RULES,
      ...STAFF_PATIENT_WRITE_RESOURCE_RULES,
      ...STAFF_CORRESPONDENCE_RESOURCE_RULES,
      ...SCHEDULING_RESOURCE_RULES,
      APPEARANCE_CONFIG_READ_RULE,
      ...STAFF_DISPENSARY_WRITE_RESOURCE_RULES,
      ...CLAIMS_RESOURCE_RULES,
      ...PAYER_DIRECTORY_RESOURCE_RULES,
      BILLING_IDENTITY_CONFIG_READ_RULE,
      ...OFFICE_CHANNEL_RESOURCE_RULES,
      FRONT_DESK_PATIENT_COMMUNICATION_RULE,
    ],
  },
  admin: {
    id: "admin",
    display: "Admin / Manager",
    description:
      "Non-clinical administrative and correction authority for identities, settings, audit, money, and inventory.",
    businessActions: [
      "identity.manage",
      "role.review",
      "chart.read",
      "scheduling.manage",
      "billing-context.read",
      "audit.read",
      "payment.void",
      "payment.write-off",
      "payment.seal-day",
      "margin.read",
      "inventory.adjust",
      "inventory.price",
      "claims.manage",
      "finding-definitions.write",
      "protocols.author",
      "document.fax-send",
      "communications.read",
      "communications.content.read",
      "communications.send",
      "communications.call",
    ],
    resourceRules: [
      ...PRACTICE_READ_RESOURCE_RULES,
      ...DISPENSARY_READ_RESOURCE_RULES,
      { resourceType: "AccessPolicy", interactions: READ_INTERACTIONS, scope: { kind: "practice" } },
      { resourceType: "AuditEvent", interactions: READ_INTERACTIONS, scope: { kind: "audit-only" } },
      ...SCHEDULING_RESOURCE_RULES,
      ...ADMIN_CORRECTION_RESOURCE_RULES,
      ...CLAIMS_RESOURCE_RULES,
      ...PAYER_DIRECTORY_RESOURCE_RULES,
      BILLING_IDENTITY_CONFIG_READ_RULE,
      BILLING_IDENTITY_CONFIG_WRITE_RULE,
      ...OFFICE_CHANNEL_RESOURCE_RULES,
      ...PROTOCOL_MODULE_RESOURCE_RULES,
      PATIENT_COMMUNICATION_COMPARTMENT_RULE,
      APPEARANCE_CONFIG_READ_RULE,
    ],
  },
};

export function getRoleDeclaration(roleId: PracticeRoleId): OdosRoleDeclaration {
  return ROLE_REGISTRY[roleId];
}

export const ODOS_PRACTICE_ROLE_SYSTEM = "https://odos2020.com/fhir/NamingSystem/practice-role";

const COMPOSITE_ROLE_PRECEDENCE = ["admin", "provider", "staff"] as const satisfies readonly PracticeRoleId[];
const COMPOSITE_PARAMETER_NAMES = new Set([
  "provider_profile",
  "patient_compartment",
  "license_state",
  "procedure_scope",
]);

export function compositeRoleParameterName(roleId: PracticeRoleId, parameterName: string): string {
  return `${roleId}_${parameterName}`;
}

export function buildMedplumAccessPolicy(role: OdosRoleDeclaration): AccessPolicy {
  return {
    resourceType: "AccessPolicy",
    name: `ODOS ${role.display}`,
    // Machine-readable role↔policy link so the payment endpoint can derive a caller's role from
    // their bound AccessPolicy (decision 2026-07-05 §3) rather than a spoofable client header.
    // Carried on meta.tag — Medplum's AccessPolicy resource has no identifier element.
    meta: { tag: [{ system: ODOS_PRACTICE_ROLE_SYSTEM, code: role.id }] },
    resource: role.resourceRules.map(toMedplumResourceRule),
  };
}

export function buildMedplumCompositeAccessPolicy(
  roleIds: readonly PracticeRoleId[],
): AccessPolicy {
  const roles = PRACTICE_ROLE_IDS.filter((roleId) => roleIds.includes(roleId));
  if (roles.length === 0) {
    throw new Error("A composite AccessPolicy requires at least one practice role.");
  }
  if (new Set(roleIds).size !== roles.length) {
    throw new Error("A composite AccessPolicy requires unique recognized practice roles.");
  }

  const rules = new Map<string, {
    resourceType: string;
    interaction: NonNullable<AccessPolicyResource["interaction"]>[number];
    criteria?: string;
    constraintAlternatives: NonNullable<AccessPolicyResource["writeConstraint"]>[];
  }>();
  for (const roleId of COMPOSITE_ROLE_PRECEDENCE) {
    if (!roles.includes(roleId)) continue;
    for (const sourceRule of getRoleDeclaration(roleId).resourceRules.map(toMedplumResourceRule)) {
      const rule = namespaceCompositeRule(sourceRule, roleId);
      for (const interaction of rule.interaction ?? []) {
        const key = JSON.stringify([rule.resourceType, interaction, rule.criteria ?? null]);
        const existing = rules.get(key);
        const constraints = structuredClone(rule.writeConstraint ?? []);
        if (!existing) {
          rules.set(key, {
            resourceType: rule.resourceType,
            interaction,
            ...(rule.criteria ? { criteria: rule.criteria } : {}),
            constraintAlternatives: [constraints],
          });
        } else if (!existing.constraintAlternatives.some(
          (candidate) => JSON.stringify(candidate) === JSON.stringify(constraints),
        )) {
          existing.constraintAlternatives.push(constraints);
        }
      }
    }
  }

  const resource: AccessPolicyResource[] = [...rules.values()].map((rule) => {
    const writeConstraint = compositeWriteConstraint(rule.constraintAlternatives);
    return {
      resourceType: rule.resourceType,
      interaction: [rule.interaction],
      ...(rule.criteria ? { criteria: rule.criteria } : {}),
      ...(writeConstraint ? { writeConstraint } : {}),
    };
  });

  return {
    resourceType: "AccessPolicy",
    name: `ODOS Composite ${roles.map((roleId) => getRoleDeclaration(roleId).display).join(" + ")}`,
    meta: {
      tag: roles.map((code) => ({ system: ODOS_PRACTICE_ROLE_SYSTEM, code })),
    },
    resource,
  };
}

function namespaceCompositeRule(
  rule: AccessPolicyResource,
  roleId: PracticeRoleId,
): AccessPolicyResource {
  const namespace = (expression: string): string => expression.replace(
    /%([A-Za-z][A-Za-z0-9_]*)/g,
    (match, parameterName: string) => COMPOSITE_PARAMETER_NAMES.has(parameterName)
      ? `%${compositeRoleParameterName(roleId, parameterName)}`
      : match,
  );
  return {
    ...structuredClone(rule),
    ...(rule.criteria ? { criteria: namespace(rule.criteria) } : {}),
    ...(rule.writeConstraint ? {
      writeConstraint: rule.writeConstraint.map((constraint) => ({
        ...constraint,
        ...(constraint.expression ? { expression: namespace(constraint.expression) } : {}),
      })),
    } : {}),
  };
}

function compositeWriteConstraint(
  alternatives: readonly NonNullable<AccessPolicyResource["writeConstraint"]>[],
): AccessPolicyResource["writeConstraint"] | undefined {
  if (alternatives.some((constraints) => constraints.length === 0)) return undefined;
  if (alternatives.length === 1) return structuredClone(alternatives[0]);
  const expression = alternatives.map((constraints) =>
    `(${constraints.map((constraint) => `(${constraint.expression})`).join(" and ")})`
  ).join(" or ");
  return [{
    language: "text/fhirpath",
    description: "Allow the write constraints of any compiled practice role.",
    expression,
  }];
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
      `ODOS RBAC preflight denied: role ${roleId} lacks business action ${businessAction}.`,
    );
  }
}

export function resolveBusinessActionRole(
  roles: readonly PracticeRoleId[],
  businessAction: BusinessAction,
): PracticeRoleId | undefined {
  return PRACTICE_ROLE_IDS.find(
    (roleId) =>
      roles.includes(roleId) &&
      getRoleDeclaration(roleId).businessActions.includes(businessAction),
  );
}

export function assertAestheticsProviderScope(input: AestheticsProviderScopeInput): void {
  if (input.roleId !== "provider") {
    return;
  }

  const requestedState = normalizeState(input.requestedState);
  const licensedStates = input.licensedStates.map(normalizeState);
  if (!licensedStates.includes(requestedState)) {
    throw new Error(
      `ODOS RBAC preflight denied: provider is not credentialed for ${requestedState}.`,
    );
  }

  if (!input.procedureType || !input.allowedProcedureTypesByState) {
    return;
  }

  const allowed = input.allowedProcedureTypesByState[requestedState] ?? [];
  if (!allowed.includes(input.procedureType)) {
    throw new Error(
      `ODOS RBAC preflight denied: provider credential for ${requestedState} does not include ${input.procedureType}.`,
    );
  }
}

export function accessPolicyHasNoBusinessActionVocabulary(policy: AccessPolicy): boolean {
  const serialized = JSON.stringify(policy);
  return BUSINESS_ACTIONS.every((action) => !serialized.includes(action));
}

function toMedplumResourceRule(rule: OdosResourceRule): AccessPolicyResource {
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

function criteriaForRule(rule: OdosResourceRule): string | undefined {
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
