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
  contentPinnedGroupKeys?: string[];
  error?: string;
}

// Inactive groups reserve their prefixes, except when saved encounter content pins the group open.
export function filterDefinitionsForSectionGroups<
  T extends { sectionKey?: string; active: boolean },
>(
  definitions: readonly T[],
  groups: readonly FindingSectionGroup[],
  effectiveGroupKeys: readonly string[],
  contentPinnedGroupKeys: readonly string[] = [],
): T[] {
  const effective = new Set(effectiveGroupKeys);
  const pinned = new Set(contentPinnedGroupKeys);
  return definitions.filter((definition) => {
    if (!definition.active) return false;
    const matchingGroups = groups.filter((group) =>
      definition.sectionKey !== undefined &&
      group.sectionKeyPrefixes.some((prefix) => definition.sectionKey?.startsWith(prefix))
    );
    if (matchingGroups.length === 0) return true;
    return matchingGroups.some((group) => pinned.has(group.groupKey) || (group.active && effective.has(group.groupKey)));
  });
}
