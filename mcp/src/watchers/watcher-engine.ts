import type { WatcherRegistry, WatcherPracticeConfig } from "./watcher-types.js";
import { loadWatcherHealth, saveWatcherHealth, type WatcherHealthFhir } from "./watcher-health.js";
import { reconcileWatcherTasks, type WatcherTaskFhir } from "./watcher-task.js";

export interface WatcherEngineFhir extends WatcherTaskFhir, WatcherHealthFhir {}

export interface WatcherSweepDependencies {
  fhir: WatcherEngineFhir;
  registry: WatcherRegistry;
  loadConfig(): Promise<WatcherPracticeConfig>;
  authenticate?: () => Promise<void>;
  now?: () => string;
  date?: () => string;
}

export async function runWatcherSweep(deps: WatcherSweepDependencies): Promise<void> {
  await deps.authenticate?.();
  const now = deps.now?.() ?? new Date().toISOString();
  const date = deps.date?.() ?? now.slice(0, 10);
  const priorHealth = (await loadWatcherHealth(deps.fhir)).state;
  await saveWatcherHealth(deps.fhir, {
    lastAttemptAt: now,
    ...(priorHealth?.lastSuccessfulAt ? { lastSuccessfulAt: priorHealth.lastSuccessfulAt } : {}),
    outcome: "running",
  });

  try {
    const config = await deps.loadConfig();
    for (const definition of deps.registry.list()) {
      const settings = config.watchers[definition.id];
      if (!settings?.enabled) continue;
      const matches = await definition.firingRule({ now, date, settings });
      const eligible = definition.activation === "fixed-threshold"
        ? matches.filter((match) => Date.parse(match.sourceOccurredAt) >= Date.parse(config.goLiveAt))
        : matches;
      await reconcileWatcherTasks(deps.fhir, definition, eligible, settings.severity, now);
    }
    await saveWatcherHealth(deps.fhir, {
      lastAttemptAt: now,
      lastSuccessfulAt: now,
      outcome: "healthy",
    });
  } catch (error) {
    await saveWatcherHealth(deps.fhir, {
      lastAttemptAt: now,
      ...(priorHealth?.lastSuccessfulAt ? { lastSuccessfulAt: priorHealth.lastSuccessfulAt } : {}),
      outcome: "failed",
      failureDetail: errorMessage(error),
    });
    throw error;
  }
}

export function watcherWorkerIntervalMs(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 5 * 60_000;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 10 ** 4) {
    throw new Error(`WATCHER_WORKER_INTERVAL_MS must be an integer of at least ${10 ** 4}.`);
  }
  return parsed;
}

export function startWatcherWorker(
  deps: WatcherSweepDependencies,
  intervalMs: number,
): { stop(): void } {
  const run = () => void runWatcherSweep(deps).catch((error) => {
    console.error("Watcher engine sweep failed:", errorMessage(error));
  });
  run();
  const timer = setInterval(run, intervalMs);
  return { stop: () => clearInterval(timer) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
