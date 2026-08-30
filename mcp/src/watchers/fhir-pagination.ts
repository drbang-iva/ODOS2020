import type { Bundle, Resource } from "@medplum/fhirtypes";

export interface PaginatedFhir {
  search<T extends Resource>(
    resourceType: T["resourceType"],
    params: Record<string, string>,
  ): Promise<Bundle<T>>;
  searchUrl?<T extends Resource>(
    url: string,
    resourceType: T["resourceType"],
  ): Promise<Bundle<T>>;
}

export async function collectAllPages<T extends Resource>(
  fhir: PaginatedFhir,
  resourceType: T["resourceType"],
  params: Record<string, string>,
  label: string,
): Promise<T[]> {
  // search-contract: watcher-pagination.search-resource
  let page = await fhir.search<T>(resourceType, params);
  const resources: T[] = [];
  let pageCount = 0;

  while (true) {
    pageCount += 1;
    for (const entry of page.entry ?? []) {
      if (entry.resource?.resourceType === resourceType) resources.push(entry.resource);
    }
    if (resources.length > 10_000) throw guardError(label);

    const next = page.link?.find((link) => link.relation === "next")?.url;
    if (!next) return resources;
    if (!fhir.searchUrl) {
      throw new Error(`${label} are incomplete: FHIR next-link support is unavailable.`);
    }
    if (pageCount >= 100 || resources.length >= 10_000) throw guardError(label);
    page = await fhir.searchUrl<T>(next, resourceType);
  }
}

function guardError(label: string): Error {
  return new Error(`${label} are incomplete: search exceeded 100 pages or 10000 resources.`);
}
