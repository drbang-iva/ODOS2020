import type { Extension, ProjectMembership } from "@medplum/fhirtypes";
import {
  BUSINESS_ACTIONS,
  type BusinessAction,
} from "./roles.js";

export const ODOS_MEMBERSHIP_BUSINESS_ACTIONS_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/project-membership-business-actions";

export interface MembershipBusinessActionDeltas {
  granted: BusinessAction[];
  revoked: BusinessAction[];
  malformed: boolean;
}

export function readMembershipBusinessActionDeltas(
  membership: ProjectMembership,
): MembershipBusinessActionDeltas {
  const containers = (membership.extension ?? []).filter(
    (extension) => extension.url === ODOS_MEMBERSHIP_BUSINESS_ACTIONS_EXTENSION_URL,
  );
  if (containers.length === 0) return { granted: [], revoked: [], malformed: false };
  if (containers.length !== 1 || valueKeys(containers[0]!).length > 0) {
    return malformedDeltas();
  }

  const granted: BusinessAction[] = [];
  const revoked: BusinessAction[] = [];
  for (const extension of containers[0]!.extension ?? []) {
    if (
      (extension.url !== "granted" && extension.url !== "revoked") ||
      extension.extension?.length ||
      valueKeys(extension).length !== 1 ||
      typeof extension.valueCode !== "string" ||
      !BUSINESS_ACTIONS.includes(extension.valueCode as BusinessAction)
    ) {
      return malformedDeltas();
    }
    const target = extension.url === "granted" ? granted : revoked;
    const action = extension.valueCode as BusinessAction;
    if (!target.includes(action)) target.push(action);
  }
  if (granted.some((action) => revoked.includes(action))) return malformedDeltas();
  return { granted, revoked, malformed: false };
}

export function membershipBusinessActionExtensions(
  existing: readonly Extension[] | undefined,
  granted: readonly BusinessAction[],
  revoked: readonly BusinessAction[],
): Extension[] {
  const preserved = (existing ?? []).filter(
    (extension) => extension.url !== ODOS_MEMBERSHIP_BUSINESS_ACTIONS_EXTENSION_URL,
  ).map((extension) => structuredClone(extension));
  const normalizedGranted = BUSINESS_ACTIONS.filter((action) => granted.includes(action));
  const normalizedRevoked = BUSINESS_ACTIONS.filter((action) => revoked.includes(action));
  if (normalizedGranted.length === 0 && normalizedRevoked.length === 0) return preserved;
  return [
    ...preserved,
    {
      url: ODOS_MEMBERSHIP_BUSINESS_ACTIONS_EXTENSION_URL,
      extension: [
        ...normalizedGranted.map((valueCode): Extension => ({ url: "granted", valueCode })),
        ...normalizedRevoked.map((valueCode): Extension => ({ url: "revoked", valueCode })),
      ],
    },
  ];
}

function valueKeys(extension: Extension): string[] {
  return Object.keys(extension).filter((key) => key.startsWith("value"));
}

function malformedDeltas(): MembershipBusinessActionDeltas {
  return { granted: [], revoked: [], malformed: true };
}
