import type { ClaimProjectionFhir } from "./claim-read-model-projector.js";
import { loadClaimReadModelTruth } from "./claim-read-model-projector.js";
import type { ClaimReadModelStore } from "./claim-read-model-store.js";

export interface ClaimReadModelWorkerDeps {
  authenticateService(): Promise<void>;
  fhir: ClaimProjectionFhir;
  store: ClaimReadModelStore;
  intervalMs?: number;
  now?: () => string;
  onError?: (error: unknown) => void;
}

export function startClaimReadModelWorker(deps: ClaimReadModelWorkerDeps): () => void {
  let running = false;
  const sync = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await deps.authenticateService();
      const at = deps.now?.() ?? new Date().toISOString();
      await deps.store.rebuild(await loadClaimReadModelTruth(deps.fhir, at), at);
    } catch (error) {
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
