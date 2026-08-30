import type { Bundle, Resource } from "@medplum/fhirtypes";
import type { FhirSearchParams } from "../fhir-client.js";

export interface PaginatedFhir {
  search<T extends Resource>(
    resourceType: T["resourceType"],
    params: FhirSearchParams,
  ): Promise<Bundle<T>>;
  searchUrl?<T extends Resource>(
    url: string,
    resourceType: T["resourceType"],
  ): Promise<Bundle<T>>;
}

const MAX_WATCHER_RESOURCES = 10 ** 4;

export async function collectAllPages<T extends Resource>(
  fhir: PaginatedFhir,
  resourceType: T["resourceType"],
  params: FhirSearchParams,
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
    if (resources.length > MAX_WATCHER_RESOURCES) throw guardError(label);

    const next = page.link?.find((link) => link.relation === "next")?.url;
    if (!next) return resources;
    if (!fhir.searchUrl) {
      throw new Error(`${label} are incomplete: FHIR next-link support is unavailable.`);
    }
    if (pageCount >= 100 || resources.length >= MAX_WATCHER_RESOURCES) throw guardError(label);
    page = await fhir.searchUrl<T>(next, resourceType);
  }
}

function guardError(label: string): Error {
  return new Error(`${label} are incomplete: search exceeded 100 pages or ${MAX_WATCHER_RESOURCES} resources.`);
}
