export const DEFAULT_CLAIM_PROJECTION_STALE_AFTER_MS = 180_000;

export type ClaimProjectionState = "uninitialized" | "healthy" | "failed" | "stale";

export interface ClaimProjectionStatus {
  state: ClaimProjectionState;
  lastAttemptAt: string | null;
  lastSuccessfulAt: string | null;
  lastFailureAt: string | null;
  invalidatedAt: string | null;
  staleAfterMs: number;
}

export interface ClaimReadModelProjectionHealthTracker {
  begin(at: string): number;
  succeed(at: string, attempt: number): void;
  fail(at: string, attempt: number): void;
  invalidate(at: string): void;
  status(at: string): ClaimProjectionStatus;
}

export class ClaimReadModelProjectionHealth implements ClaimReadModelProjectionHealthTracker {
  private lastAttemptAt: string | null = null;
  private lastSuccessfulAt: string | null = null;
  private lastFailureAt: string | null = null;
  private invalidatedAt: string | null = null;
  private revision = 0;

  constructor(private readonly staleAfterMs = DEFAULT_CLAIM_PROJECTION_STALE_AFTER_MS) {
    if (!Number.isInteger(staleAfterMs) || staleAfterMs <= 0) {
      throw new Error("Claim projection stale threshold must be a positive whole number of milliseconds.");
    }
  }

  begin(at: string): number {
    assertDateTime(at);
    this.lastAttemptAt = at;
    this.revision += 1;
    return this.revision;
  }

  succeed(at: string, attempt: number): void {
    assertDateTime(at);
    if (attempt !== this.revision) return;
    this.lastAttemptAt = at;
    this.lastSuccessfulAt = at;
    this.lastFailureAt = null;
    this.invalidatedAt = null;
  }

  fail(at: string, attempt: number): void {
    assertDateTime(at);
    if (attempt !== this.revision) return;
    this.lastAttemptAt = at;
    this.lastFailureAt = at;
  }

  invalidate(at: string): void {
    assertDateTime(at);
    this.revision += 1;
    this.invalidatedAt = at;
  }

  status(at: string): ClaimProjectionStatus {
    assertDateTime(at);
    const state = this.projectionState(at);
    return {
      state,
      lastAttemptAt: this.lastAttemptAt,
      lastSuccessfulAt: this.lastSuccessfulAt,
      lastFailureAt: this.lastFailureAt,
      invalidatedAt: this.invalidatedAt,
      staleAfterMs: this.staleAfterMs,
    };
  }

  private projectionState(at: string): ClaimProjectionState {
    if (this.lastFailureAt) return "failed";
    if (this.invalidatedAt) return "stale";
    if (!this.lastSuccessfulAt) return "uninitialized";
    return Date.parse(at) - Date.parse(this.lastSuccessfulAt) > this.staleAfterMs ? "stale" : "healthy";
  }
}

export function claimProjectionStaleAfterMsFromEnv(value: string | undefined): number {
  if (!value?.trim()) return DEFAULT_CLAIM_PROJECTION_STALE_AFTER_MS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("ODOS_CLAIM_PROJECTION_STALE_AFTER_MS must be a positive whole number.");
  }
  return parsed;
}

export function claimProjectionUnavailableBody(status: ClaimProjectionStatus): {
  error: string;
  projection: ClaimProjectionStatus;
} | undefined {
  if (status.state === "healthy") return undefined;
  return {
    error: `Claim read model projection is ${status.state}; FHIR remains authoritative.`,
    projection: status,
  };
}

function assertDateTime(value: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error("Claim projection time must be a valid date-time.");
}
