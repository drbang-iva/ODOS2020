import type {
  WatcherDefinition,
  WatcherRegistry,
  WatcherSeverity,
} from "./watcher-types.js";

const SEVERITIES = new Set<WatcherSeverity>(["today", "this-week", "watch"]);
const REGISTERS = new Set(["front-desk", "owner", "biller"]);
const ACTIVATIONS = new Set(["immediate", "fixed-threshold", "learned-baseline"]);

export class WatcherRegistrationError extends Error {}

export function createWatcherRegistry(input: readonly WatcherDefinition[]): WatcherRegistry {
  const definitions = new Map<string, WatcherDefinition>();
  for (const candidate of input as readonly unknown[]) {
    const definition = validateWatcherDefinition(candidate);
    if (definitions.has(definition.id)) {
      throw new WatcherRegistrationError(
        `${definition.id} registration failed: watcher id is already registered.`,
      );
    }
    definitions.set(definition.id, definition);
  }
  return {
    get(id) {
      const definition = definitions.get(id);
      if (!definition) throw new Error(`Watcher ${id} is not registered.`);
      return definition;
    },
    list: () => [...definitions.values()],
  };
}

function validateWatcherDefinition(value: unknown): WatcherDefinition {
  const candidate = record(value);
  const id = text(candidate.id) || "unknown watcher";
  requiredText(candidate.id, id, "watcher id");
  requiredText(candidate.question, id, "question");
  if (typeof candidate.firingRule !== "function") fail(id, "firing rule is required");
  requiredText(candidate.owner, id, "owner");

  const nextAction = record(candidate.nextAction);
  if (!candidate.nextAction || !text(nextAction.label) || typeof nextAction.href !== "function") {
    fail(id, "next action is required");
  }
  requiredText(candidate.consequence, id, "plain-language consequence");
  if (!REGISTERS.has(String(candidate.register))) fail(id, "copy register is invalid");
  if (!ACTIVATIONS.has(String(candidate.activation))) fail(id, "activation kind is invalid");
  if (!Array.isArray(candidate.dismissalReasons) || candidate.dismissalReasons.length === 0) {
    fail(id, "dismissal reasons are required");
  }
  for (const reason of candidate.dismissalReasons as unknown[]) {
    const parsed = record(reason);
    if (!text(parsed.code) || !text(parsed.display)) fail(id, "dismissal reason code and display are required");
  }
  const seed = record(candidate.seedSettings);
  if (typeof seed.enabled !== "boolean") fail(id, "seeded enabled state is required");
  if (!SEVERITIES.has(seed.severity as WatcherSeverity)) fail(id, "seeded severity is invalid");
  for (const [key, setting] of Object.entries(seed)) {
    if (!["boolean", "number", "string"].includes(typeof setting)) {
      fail(id, `seeded setting ${key} must be scalar`);
    }
    if (typeof setting === "number" && !Number.isFinite(setting)) {
      fail(id, `seeded setting ${key} must be finite`);
    }
  }
  return value as WatcherDefinition;
}

function requiredText(value: unknown, id: string, rule: string): string {
  const parsed = text(value);
  if (!parsed) fail(id, `${rule} is required`);
  return parsed;
}

function fail(id: string, message: string): never {
  throw new WatcherRegistrationError(`${id} registration failed: ${message}.`);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
