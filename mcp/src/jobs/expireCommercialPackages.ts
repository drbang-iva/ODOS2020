import type {
  CommercialEngineStore,
  PackageExpirySweepResult,
} from "../commercial-engine/ledger-store.js";

export const PACKAGE_EXPIRY_SWEEP_ACTOR = "odos-package-expiry-sweep";
export const DEFAULT_PACKAGE_EXPIRY_SWEEP_MS = 86_400_000;

export interface PackageExpirySweepInput {
  store: CommercialEngineStore;
  now?: () => string;
}

export async function runPackageExpirySweep(
  input: PackageExpirySweepInput,
): Promise<PackageExpirySweepResult> {
  const expiredAt = input.now?.() ?? new Date().toISOString();
  return input.store.expirePackages({
    asOfDate: expiredAt.slice(0, 10),
    actorUserId: PACKAGE_EXPIRY_SWEEP_ACTOR,
    expiredAt,
  });
}

export function startPackageExpiryWorker(
  input: PackageExpirySweepInput & { intervalMs?: number },
): NodeJS.Timeout {
  const run = (): void => {
    void runPackageExpirySweep(input).catch((error) => {
      console.error("odos-mcp: package expiry sweep failed:", error);
    });
  };
  run();
  const timer = setInterval(run, input.intervalMs ?? 24 * 60 * 60 * 1000);
  timer.unref();
  return timer;
}

export function packageExpirySweepIntervalMs(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_PACKAGE_EXPIRY_SWEEP_MS;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PACKAGE_EXPIRY_SWEEP_MS;
}
