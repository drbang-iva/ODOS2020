import type { ClinicalProcedureDefinition } from "./procedure-definition-store.js";
import type { ProtocolItem } from "./protocol-types.js";

export function isPlanItemOffered(
  item: ProtocolItem,
  definitionsByStableKey: ReadonlyMap<string, ClinicalProcedureDefinition>,
): boolean {
  return !item.procedureDefinitionKey || definitionsByStableKey.get(item.procedureDefinitionKey)?.active === true;
}

export function unofferedSelectedItems(
  items: ProtocolItem[],
  selections: Array<{ itemKey: string; selected: boolean }>,
  definitions: ReadonlyMap<string, ClinicalProcedureDefinition>,
): Set<string> {
  const choices = new Map(selections.map(choice => [choice.itemKey, choice.selected]));
  const selected = items.filter(item => choices.get(item.itemKey) ?? item.defaultSelected);
  const blocked = new Set(selected.filter(item => !isPlanItemOffered(item, definitions)).map(item => item.itemKey));
  const neededCharges = new Set(selected.filter(item => !blocked.has(item.itemKey)).map(item => item.payload.chargeSeedRef));
  for (const item of selected) {
    if (blocked.has(item.itemKey) && typeof item.payload.chargeSeedRef === "string" && !neededCharges.has(item.payload.chargeSeedRef)) {
      blocked.add(item.payload.chargeSeedRef);
    }
  }
  return blocked;
}
