import { isDeepStrictEqual } from "node:util";
import { BUILTIN_CHARGE_RULES, BUILTIN_PROTOCOLS } from "./protocol-fixtures.js";
import type { ProtocolService } from "./protocol-service.js";
import type { ProcedureChargeRule, ProtocolDefinition } from "./protocol-types.js";

const logged = new WeakMap<object, Set<string>>();
export async function ensureBuiltInProtocols(
  stores: Pick<ProtocolService, "definitions" | "chargeRules">,
  options: { protocols?: readonly ProtocolDefinition[]; rules?: readonly ProcedureChargeRule[]; log?: (message: string) => void } = {},
): Promise<void> {
  const log = options.log ?? console.warn;
  const messages = logged.get(log) ?? new Set<string>();
  logged.set(log, messages);
  const report = (message: string) => {
    if (!messages.has(message)) { messages.add(message); log(message); }
  };
  for (const builtIn of options.protocols ?? BUILTIN_PROTOCOLS) {
    const stored = await stores.definitions.get(builtIn.id);
    if (stored && isDeepStrictEqual(stored, builtIn)) continue;
    if (stored && (stored.version >= builtIn.version || stored.draft || stored.status === "retired" ||
      stored.audit.publishedBy !== "Practitioner/odos-system")) {
      report(`Built-in ${builtIn.id}: ${stored.version === builtIn.version ? "same-version content conflict" : "stored head preserved"}.`);
      continue;
    }
    try {
      // saveSnapshot checks the physical snapshot, rather than the legacy getSnapshot head fallback.
      if (stored) await stores.definitions.saveSnapshot(stored);
      await stores.definitions.saveSnapshot(builtIn);
      const saved = stored
        ? await stores.definitions.advanceHead(stored, builtIn)
        : await stores.definitions.createHead(builtIn);
      if (!saved || !isDeepStrictEqual(saved, builtIn)) report(`Built-in ${builtIn.id}: conditional head conflict; race refused.`);
    } catch (error) {
      report(`Built-in ${builtIn.id}: seed refused: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const rule of options.rules ?? BUILTIN_CHARGE_RULES) {
    const stored = await stores.chargeRules.get(rule.id);
    if (!stored) {
      const saved = await stores.chargeRules.createImmutable(rule);
      if (!isDeepStrictEqual(saved, rule)) report(`Built-in rule ${rule.id}: create conflict; stored rule preserved.`);
    } else if (stored.version < rule.version) {
      const saved = await stores.chargeRules.saveWithIdentifiersIfCurrent(rule, [], current => isDeepStrictEqual(current, stored));
      if (!saved) report(`Built-in rule ${rule.id}: conditional write conflict; race refused.`);
    }
  }
}
