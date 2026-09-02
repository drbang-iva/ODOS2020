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
      `ODOS Observation.status transition rejected (${formatStatus(input.from)} -> ${input.to}): ${input.reason}`,
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
    to: "entered-in-error",
    actorRole: "scribe",
    description: "Scribe pre-final void.",
  },
  {
    from: "preliminary",
    to: "entered-in-error",
    actorRole: "clinician",
    description: "Clinician pre-final void.",
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
  "(%before.exists().not() implies status = 'preliminary')",
  "and (%before.exists() implies (",
  "(%before.status = 'preliminary' and (status = 'preliminary' or status = 'final' or status = 'entered-in-error'))",
  "or (%before.status = 'final' and (status = 'amended' or status = 'corrected' or status = 'entered-in-error'))",
  "or (%before.status = 'amended' and (status = 'amended' or status = 'corrected' or status = 'entered-in-error'))",
  "or (%before.status = 'corrected' and (status = 'corrected' or status = 'entered-in-error'))",
  "))",
].join(" ");

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

  const transitions = ALLOWED_OBSERVATION_STATUS_TRANSITIONS.filter(
    (candidate) =>
      normalizeBefore(candidate.from) === normalizeBefore(input.from) &&
      candidate.to === input.to,
  );

  if (transitions.length === 0) {
    const reason =
      input.from === "entered-in-error"
        ? "entered-in-error is terminal; prior versions remain available through FHIR vread."
        : "ledger rows 19/20 allow only the v0.5c scribe-attestation-amendment graph.";
    throw new ObservationStatusTransitionError({ from: input.from, to: input.to, reason });
  }

  if (!transitions.some((transition) => transition.actorRole === input.actorRole)) {
    const requiredRoles = [...new Set(transitions.map((transition) => transition.actorRole))].join(" or ");
    throw new ObservationStatusTransitionError({
      from: input.from,
      to: input.to,
      reason: `Mandate 8 + ledger row 20 require ${requiredRoles} authority, not ${input.actorRole}.`,
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

export function observationStatusTransitionTableRejectsPatch(input: {
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
