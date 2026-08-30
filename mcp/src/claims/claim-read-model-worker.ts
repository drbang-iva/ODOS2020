import type { ClaimProjectionFhir } from "./claim-read-model-projector.js";
import { loadClaimReadModelTruth } from "./claim-read-model-projector.js";
import type { ClaimReadModelStore } from "./claim-read-model-store.js";
import type { ClaimReadModelProjectionHealthTracker } from "./claim-read-model-health.js";

export interface ClaimReadModelWorkerDeps {
  authenticateService(): Promise<void>;
  fhir: ClaimProjectionFhir;
  store: ClaimReadModelStore;
  projectionHealth: ClaimReadModelProjectionHealthTracker;
  intervalMs?: number;
  now?: () => string;
  onError?: (error: unknown) => void;
}

export function startClaimReadModelWorker(deps: ClaimReadModelWorkerDeps): () => void {
  let running = false;
  const sync = async (): Promise<void> => {
    if (running) return;
    running = true;
    const at = deps.now?.() ?? new Date().toISOString();
    const attempt = deps.projectionHealth.begin(at);
    try {
      await deps.authenticateService();
      await deps.store.rebuild(await loadClaimReadModelTruth(deps.fhir, at), at);
      deps.projectionHealth.succeed(at, attempt);
    } catch (error) {
      deps.projectionHealth.fail(at, attempt);
      deps.onError?.(error);
    } finally {
      running = false;
    }
  };
  void sync();
  const interval = setInterval(() => void sync(), deps.intervalMs ?? 60_000);
  interval.unref();
  return () => clearInterval(interval);
}
