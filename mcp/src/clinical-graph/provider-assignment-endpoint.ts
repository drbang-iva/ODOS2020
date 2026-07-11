import type {
  Bundle,
  Patient,
  PractitionerRole,
  ProjectMembership,
  ProjectMembershipAccess,
} from "@medplum/fhirtypes";
import { z } from "zod";
import type { MedplumClient } from "../fhir-client.js";
import {
  assertBusinessActionAllowed,
  type BusinessAction,
  type PracticeRoleId,
} from "../authz/roles.js";

export interface ProviderAssignmentEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<{
    staffReference: string;
    actorRole: PracticeRoleId;
  } | null>;
  serviceFhir: Pick<MedplumClient, "read" | "search" | "patch">;
}

export interface ProviderAssignmentEndpointResult {
  status: number;
  body: unknown;
}

const patientIdSchema = z.string().regex(/^[A-Za-z0-9.-]{1,64}$/);
const WRITE_HEADERS = { "X-OSOD-Source": "mcp/assign_provider" } as const;

export async function handleProviderAssignmentRequest(
  deps: ProviderAssignmentEndpointDeps,
  input: { authHeader: string | undefined; patientId: unknown },
): Promise<ProviderAssignmentEndpointResult> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) {
    return { status: 401, body: { error: "Authentication required to assign a provider." } };
  }
  if (!staffMay(staff.actorRole, "chart.write")) {
    return { status: 403, body: { error: "chart.write role required" } };
  }

  const parsedPatientId = patientIdSchema.safeParse(input.patientId);
  if (!parsedPatientId.success) {
    return { status: 400, body: { error: "A valid Patient id is required." } };
  }

  const practitionerReference = await resolvePractitionerReference(
    deps.serviceFhir,
    staff.staffReference,
  );
  if (!practitionerReference) {
    return {
      status: 409,
      body: { error: "The authenticated staff profile is not backed by a Practitioner." },
    };
  }

  const patientReference = `Patient/${parsedPatientId.data}`;
  const memberships = await deps.serviceFhir.search<ProjectMembership>("ProjectMembership", {
    profile: staff.staffReference,
  });
  const membership = memberships.entry?.[0]?.resource;
  const policyReference = membershipPolicyReference(membership);
  if (!membership?.id || !policyReference) {
    return { status: 403, body: { error: "No assignable clinician membership was found." } };
  }

  const patient = await deps.serviceFhir.read<Patient>("Patient", parsedPatientId.data);
  const patientAlreadyAssigned = patient.generalPractitioner?.some(
    (reference) => reference.reference === practitionerReference,
  ) ?? false;
  const membershipAlreadyGranted = hasPatientCompartmentGrant(membership, patientReference);

  if (!patientAlreadyAssigned) {
    await deps.serviceFhir.patch<Patient>(
      "Patient",
      parsedPatientId.data,
      patient.generalPractitioner?.length
        ? [{ op: "add", path: "/generalPractitioner/-", value: { reference: practitionerReference } }]
        : [{ op: "add", path: "/generalPractitioner", value: [{ reference: practitionerReference }] }],
      versionHeaders(patient.meta?.versionId),
    );
  }

  if (!membershipAlreadyGranted) {
    const access = patientAccessEntry(
      policyReference,
      practitionerReference,
      patientReference,
    );
    await deps.serviceFhir.patch<ProjectMembership>(
      "ProjectMembership",
      membership.id,
      membership.access?.length
        ? [{ op: "add", path: "/access/-", value: access }]
        : [{ op: "add", path: "/access", value: [access] }],
      versionHeaders(membership.meta?.versionId),
    );
  }

  return {
    status: 200,
    body: {
      assigned: !patientAlreadyAssigned || !membershipAlreadyGranted,
      patientReference,
      practitionerReference,
      patientUpdated: !patientAlreadyAssigned,
      membershipUpdated: !membershipAlreadyGranted,
    },
  };
}

export function hasPatientCompartmentGrant(
  membership: ProjectMembership,
  patientReference: string,
): boolean {
  return membership.access?.some((access) =>
    access.parameter?.some(
      (parameter) =>
        parameter.name === "patient_compartment" &&
        parameter.valueString === patientReference,
    ),
  ) ?? false;
}

export function patientAccessEntry(
  policyReference: string,
  practitionerReference: string,
  patientReference: string,
): ProjectMembershipAccess {
  // Medplum 5.1.8 substitutes one value per parameter name, so each patient needs a
  // complete access[] policy instance instead of repeated patient_compartment parameters.
  return {
    policy: { reference: policyReference },
    parameter: [
      {
        name: "provider_profile",
        valueReference: { reference: practitionerReference },
      },
      {
        name: "patient_compartment",
        valueString: patientReference,
      },
    ],
  };
}

async function resolvePractitionerReference(
  fhir: Pick<MedplumClient, "read">,
  staffReference: string,
): Promise<string | undefined> {
  if (/^Practitioner\/[A-Za-z0-9.-]{1,64}$/.test(staffReference)) {
    return staffReference;
  }
  const roleId = staffReference.match(/^PractitionerRole\/([A-Za-z0-9.-]{1,64})$/)?.[1];
  if (!roleId) {
    return undefined;
  }
  const role = await fhir.read<PractitionerRole>("PractitionerRole", roleId);
  return /^Practitioner\/[A-Za-z0-9.-]{1,64}$/.test(role.practitioner?.reference ?? "")
    ? role.practitioner?.reference
    : undefined;
}

function membershipPolicyReference(membership: ProjectMembership | undefined): string | undefined {
  return membership?.access?.find((access) => access.policy?.reference)?.policy?.reference
    ?? membership?.accessPolicy?.reference;
}

function versionHeaders(versionId: string | undefined): Record<string, string> {
  return {
    ...WRITE_HEADERS,
    ...(versionId ? { "If-Match": `W/"${versionId}"` } : {}),
  };
}

function staffMay(role: PracticeRoleId, action: BusinessAction): boolean {
  try {
    assertBusinessActionAllowed(role, action);
    return true;
  } catch {
    return false;
  }
}
