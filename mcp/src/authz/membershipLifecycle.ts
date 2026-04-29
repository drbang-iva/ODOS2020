import type { Extension, ProjectMembership } from "@medplum/fhirtypes";
import type { JsonPatchOperation } from "../fhir-client.js";
import {
  buildOsodAuditEventRow,
  buildPlaceholderAuditEvent,
  type OsodAuditEventRow,
} from "./osodAudit.js";
import type { PracticeRoleId } from "./roles.js";

export const PROJECT_MEMBERSHIP_LIFECYCLE_STATE_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/project-membership-lifecycle-state";
export const PROJECT_MEMBERSHIP_ROLE_REVIEW_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/project-membership-role-review";

export const PROJECT_MEMBERSHIP_LIFECYCLE_STATES = [
  "invited",
  "active",
  "deactivated",
  "terminated",
] as const;

export type ProjectMembershipLifecycleState =
  (typeof PROJECT_MEMBERSHIP_LIFECYCLE_STATES)[number];

export const PROJECT_MEMBERSHIP_LIFECYCLE_ACTIONS = [
  "invite",
  "activate",
  "deactivate",
  "terminate",
  "role-review",
] as const;

export type ProjectMembershipLifecycleAction =
  (typeof PROJECT_MEMBERSHIP_LIFECYCLE_ACTIONS)[number];

export interface ProjectMembershipLifecycleInput {
  membership: ProjectMembership;
  action: ProjectMembershipLifecycleAction;
  actorReference?: string;
  actorDisplay?: string;
  actorRole?: PracticeRoleId;
  occurredAt?: string;
  reviewNote?: string;
}

export interface ProjectMembershipLifecycleResult {
  membership: ProjectMembership;
  patch: JsonPatchOperation[];
  auditRow: OsodAuditEventRow;
  auditEvent: ReturnType<typeof buildPlaceholderAuditEvent>;
}

export function transitionProjectMembershipLifecycle(
  input: ProjectMembershipLifecycleInput,
): ProjectMembershipLifecycleResult {
  const currentState = getProjectMembershipLifecycleState(input.membership);
  const nextState = nextLifecycleState(currentState, input.action);
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const membership = applyLifecycleState(input.membership, nextState, occurredAt, input.reviewNote);
  const patch = buildLifecyclePatch(input.membership, membership);
  const targetReference = input.membership.id
    ? `ProjectMembership/${input.membership.id}`
    : "ProjectMembership/(pending)";
  const auditRow = buildOsodAuditEventRow({
    eventType: lifecycleEventType(input.action),
    occurredAt,
    actorReference: input.actorReference,
    actorDisplay: input.actorDisplay,
    actorRole: input.actorRole,
    targetReference,
    outcome: "success",
    outcomeDescription: `ProjectMembership lifecycle ${input.action}: ${currentState ?? "none"} -> ${nextState}`,
    details: {
      previousState: currentState,
      nextState,
      reviewNote: input.reviewNote,
    },
  });

  return {
    membership,
    patch,
    auditRow,
    auditEvent: buildPlaceholderAuditEvent(auditRow),
  };
}

export function getProjectMembershipLifecycleState(
  membership: ProjectMembership,
): ProjectMembershipLifecycleState | undefined {
  const value = membership.extension?.find(
    (extension) => extension.url === PROJECT_MEMBERSHIP_LIFECYCLE_STATE_EXTENSION_URL,
  )?.valueCode;
  return PROJECT_MEMBERSHIP_LIFECYCLE_STATES.includes(
    value as ProjectMembershipLifecycleState,
  )
    ? (value as ProjectMembershipLifecycleState)
    : undefined;
}

function nextLifecycleState(
  currentState: ProjectMembershipLifecycleState | undefined,
  action: ProjectMembershipLifecycleAction,
): ProjectMembershipLifecycleState {
  switch (action) {
    case "invite":
      if (currentState && currentState !== "invited") {
        throw new Error(`Cannot invite ProjectMembership from ${currentState} state.`);
      }
      return "invited";
    case "activate":
      if (currentState === "terminated") {
        throw new Error("Cannot activate a terminated ProjectMembership.");
      }
      return "active";
    case "deactivate":
      if (currentState === "terminated") {
        throw new Error("Cannot deactivate a terminated ProjectMembership.");
      }
      return "deactivated";
    case "terminate":
      return "terminated";
    case "role-review":
      if (!currentState) {
        throw new Error("Cannot role-review a ProjectMembership before invite.");
      }
      return currentState;
  }
}

function applyLifecycleState(
  membership: ProjectMembership,
  state: ProjectMembershipLifecycleState,
  occurredAt: string,
  reviewNote: string | undefined,
): ProjectMembership {
  const lifecycleExtension: Extension = {
    url: PROJECT_MEMBERSHIP_LIFECYCLE_STATE_EXTENSION_URL,
    valueCode: state,
  };
  const reviewExtension: Extension | undefined = reviewNote
    ? {
        url: PROJECT_MEMBERSHIP_ROLE_REVIEW_EXTENSION_URL,
        valueAnnotation: { time: occurredAt, text: reviewNote },
      }
    : undefined;
  const extension = [
    ...(membership.extension ?? []).filter(
      (item) =>
        item.url !== PROJECT_MEMBERSHIP_LIFECYCLE_STATE_EXTENSION_URL &&
        item.url !== PROJECT_MEMBERSHIP_ROLE_REVIEW_EXTENSION_URL,
    ),
    lifecycleExtension,
    ...(reviewExtension ? [reviewExtension] : []),
  ];

  return {
    ...membership,
    active: state === "active",
    extension,
  };
}

function buildLifecyclePatch(
  before: ProjectMembership,
  after: ProjectMembership,
): JsonPatchOperation[] {
  const operations: JsonPatchOperation[] = [
    {
      op: before.active === undefined ? "add" : "replace",
      path: "/active",
      value: after.active,
    },
    {
      op: before.extension ? "replace" : "add",
      path: "/extension",
      value: after.extension,
    },
  ];
  return operations;
}

function lifecycleEventType(
  action: ProjectMembershipLifecycleAction,
): OsodAuditEventRow["eventType"] {
  switch (action) {
    case "invite":
      return "membership.invited";
    case "activate":
      return "membership.activated";
    case "deactivate":
      return "membership.deactivated";
    case "terminate":
      return "membership.terminated";
    case "role-review":
      return "membership.role-review";
  }
}
