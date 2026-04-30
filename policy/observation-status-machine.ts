export const FHIR_OBSERVATION_STATUSES = [
  "registered",
  "preliminary",
  "final",
  "amended",
  "corrected",
  "cancelled",
  "entered-in-error",
  "unknown",
] as const;

export type ObservationStatus = (typeof FHIR_OBSERVATION_STATUSES)[number];
export type ObservationStatusBefore = ObservationStatus | undefined | null;
export type ObservationStatusActorRole = "scribe" | "clinician" | "system";

export interface ObservationStatusTransition {
  from: ObservationStatusBefore;
  to: ObservationStatus;
  actorRole: ObservationStatusActorRole;
  description: string;
}

export class ObservationStatusTransitionError extends Error {
  readonly from: ObservationStatusBefore;
  readonly to: string;

  constructor(input: {
    from: ObservationStatusBefore;
    to: string;
    reason: string;
  }) {
    super(
      `OSOD Observation.status transition rejected (${formatStatus(input.from)} -> ${input.to}): ${input.reason}`,
    );
    this.name = "ObservationStatusTransitionError";
    this.from = input.from;
    this.to = input.to;
  }
}

export const ALLOWED_OBSERVATION_STATUS_TRANSITIONS: readonly ObservationStatusTransition[] = [
  {
    from: undefined,
    to: "preliminary",
    actorRole: "scribe",
    description: "Scribe draft creation.",
  },
  {
    from: "preliminary",
    to: "preliminary",
    actorRole: "scribe",
    description: "Scribe pre-final edit.",
  },
  {
    from: "preliminary",
    to: "final",
    actorRole: "clinician",
    description: "Clinician attestation.",
  },
  {
    from: "final",
    to: "amended",
    actorRole: "clinician",
    description: "Post-final amendment.",
  },
  {
    from: "final",
    to: "corrected",
    actorRole: "clinician",
    description: "Post-final correction.",
  },
  {
    from: "final",
    to: "entered-in-error",
    actorRole: "clinician",
    description: "Clinician nullification.",
  },
  {
    from: "amended",
    to: "amended",
    actorRole: "clinician",
    description: "Successive amendment.",
  },
  {
    from: "amended",
    to: "corrected",
    actorRole: "clinician",
    description: "Correction following amendment.",
  },
  {
    from: "amended",
    to: "entered-in-error",
    actorRole: "clinician",
    description: "Nullification following amendment.",
  },
  {
    from: "corrected",
    to: "corrected",
    actorRole: "clinician",
    description: "Successive correction.",
  },
  {
    from: "corrected",
    to: "entered-in-error",
    actorRole: "clinician",
    description: "Nullification following correction.",
  },
] as const;

export const OBSERVATION_STATUS_WRITE_CONSTRAINT_EXPRESSION = [
  "(not(%before.exists()) and status = 'preliminary')",
  "(%before.status = 'preliminary' and (status = 'preliminary' or status = 'final'))",
  "(%before.status = 'final' and (status = 'amended' or status = 'corrected' or status = 'entered-in-error'))",
  "(%before.status = 'amended' and (status = 'amended' or status = 'corrected' or status = 'entered-in-error'))",
  "(%before.status = 'corrected' and (status = 'corrected' or status = 'entered-in-error'))",
].join(" or ");

export function isObservationStatus(value: string | undefined): value is ObservationStatus {
  return FHIR_OBSERVATION_STATUSES.includes(value as ObservationStatus);
}

export function assertObservationStatusTransition(input: {
  from: ObservationStatusBefore;
  to: string;
  actorRole: ObservationStatusActorRole;
}): void {
  if (!isObservationStatus(input.to)) {
    throw new ObservationStatusTransitionError({
      from: input.from,
      to: input.to,
      reason: "target status is not in the FHIR R4 ObservationStatus ValueSet.",
    });
  }

  const transition = ALLOWED_OBSERVATION_STATUS_TRANSITIONS.find(
    (candidate) =>
      normalizeBefore(candidate.from) === normalizeBefore(input.from) &&
      candidate.to === input.to,
  );

  if (!transition) {
    const reason =
      input.from === "entered-in-error"
        ? "entered-in-error is terminal; prior versions remain available through FHIR vread."
        : "ledger rows 19/20 allow only the v0.5c scribe-attestation-amendment graph.";
    throw new ObservationStatusTransitionError({ from: input.from, to: input.to, reason });
  }

  if (transition.actorRole !== input.actorRole) {
    throw new ObservationStatusTransitionError({
      from: input.from,
      to: input.to,
      reason: `Mandate 8 + ledger row 20 require ${transition.actorRole} authority, not ${input.actorRole}.`,
    });
  }
}

export function observationStatusTransitionAllowed(input: {
  from: ObservationStatusBefore;
  to: string;
  actorRole: ObservationStatusActorRole;
}): boolean {
  try {
    assertObservationStatusTransition(input);
    return true;
  } catch {
    return false;
  }
}

export function accessPolicyConstraintRejectsObservationStatusPatch(input: {
  from: ObservationStatusBefore;
  to: string;
  actorRole: ObservationStatusActorRole;
}): boolean {
  return !observationStatusTransitionAllowed(input);
}

export function formatStatus(status: ObservationStatusBefore): string {
  return status ?? "(none)";
}

function normalizeBefore(status: ObservationStatusBefore): ObservationStatus | undefined {
  return status ?? undefined;
}
