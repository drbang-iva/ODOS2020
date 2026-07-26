export interface FindingSectionGroup {
  id: string;
  groupKey: string;
  label: string;
  sectionKeyPrefixes: string[];
  defaultForVisitTypeCategories: string[];
  active: boolean;
}

export interface VisitTypeCategory {
  id: string;
  label: string;
  active?: boolean;
}

export interface FindingSectionGroupCatalog {
  canWrite: boolean;
  canPullIn?: boolean;
  groups: FindingSectionGroup[];
  visitTypeCategories: VisitTypeCategory[];
  visitTypeCategory?: string;
  defaultGroupKeys?: string[];
  overrideGroupKeys?: string[];
  pulledInGroupKeys?: string[];
  effectiveGroupKeys?: string[];
  error?: string;
}

// Inactive registry rows intentionally continue to reserve and hide their matching
// prefixes. To make those sections universal instead, delete the group or clear its prefixes.
export function filterDefinitionsForSectionGroups<
  T extends { sectionKey?: string; active: boolean },
>(
  definitions: readonly T[],
  groups: readonly FindingSectionGroup[],
  effectiveGroupKeys: readonly string[],
): T[] {
  const effective = new Set(effectiveGroupKeys);
  return definitions.filter((definition) => {
    if (!definition.active) return false;
    const matchingGroups = groups.filter((group) =>
      definition.sectionKey !== undefined &&
      group.sectionKeyPrefixes.some((prefix) => definition.sectionKey?.startsWith(prefix))
    );
    if (matchingGroups.length === 0) return true;
    return matchingGroups.some((group) => group.active && effective.has(group.groupKey));
  });
}
