import type { Bundle, Resource } from "@medplum/fhirtypes";

export const DEFAULT_FHIR_SEARCH_MAX_ROWS = 1_000;

export interface FhirSearchClient {
  search<T extends Resource>(
    resourceType: T["resourceType"],
    params?: Record<string, string>,
  ): Promise<Bundle<T>>;
  searchUrl?<T extends Resource>(url: string, resourceType: T["resourceType"]): Promise<Bundle<T>>;
}

export class FhirSearchLimitError extends Error {
  readonly status = 409;

  constructor(
    readonly resourceType: Resource["resourceType"],
    readonly maxRows: number,
  ) {
    super(`FHIR ${resourceType} query exceeded ${maxRows} rows; no partial result was returned.`);
    this.name = "FhirSearchLimitError";
  }
}

export class FhirSearchPageLimitError extends Error {
  readonly status = 409;

  constructor(
    readonly resourceType: Resource["resourceType"],
    readonly maxPages: number,
  ) {
    super(`FHIR ${resourceType} query exceeded ${maxPages} pages; no partial result was returned.`);
    this.name = "FhirSearchPageLimitError";
  }
}

export async function searchBounded<T extends Resource>(
  client: FhirSearchClient,
  resourceType: T["resourceType"],
  params: Record<string, string>,
  options: { maxPages: number; maxRows: number },
): Promise<T[]> {
  const bundle = await client.search<T>(resourceType, params);
  return collectBoundedSearch(client, resourceType, bundle, options);
}

export async function collectBoundedSearch<T extends Resource>(
  client: FhirSearchClient,
  resourceType: T["resourceType"],
  firstBundle: Bundle<T>,
  options: { maxPages: number; maxRows: number },
): Promise<T[]> {
  let bundle = firstBundle;
  const resources: T[] = [];
  let pages = 0;
  for (;;) {
    pages += 1;
    const page = (bundle.entry ?? [])
      .map((entry) => entry.resource)
      .filter((resource): resource is T => Boolean(resource));
    if (resources.length + page.length > options.maxRows) {
      throw new FhirSearchLimitError(resourceType, options.maxRows);
    }
    resources.push(...page);
    const nextLink = bundle.link?.find((link) => link.relation === "next");
    if (!nextLink) return resources;
    if (pages >= options.maxPages) {
      throw new FhirSearchPageLimitError(resourceType, options.maxPages);
    }
    if (!nextLink.url) {
      throw new Error(`FHIR search returned a next link for ${resourceType} without a URL.`);
    }
    if (!client.searchUrl) {
      throw new Error(`FHIR search returned a next link for ${resourceType}, but the client cannot fetch it.`);
    }
    bundle = await client.searchUrl<T>(nextLink.url, resourceType);
  }
}

export async function searchAll<T extends Resource>(
  client: FhirSearchClient,
  resourceType: T["resourceType"],
  params: Record<string, string> = {},
  options: { maxRows?: number } = {},
): Promise<T[]> {
  const maxRows = options.maxRows ?? DEFAULT_FHIR_SEARCH_MAX_ROWS;
  let bundle = await client.search<T>(resourceType, paramsWithCount(params));
  const resources: T[] = [];
  for (;;) {
    const page = (bundle.entry ?? [])
      .map((entry) => entry.resource)
      .filter((resource): resource is T => Boolean(resource));
    if (resources.length + page.length > maxRows) {
      throw new FhirSearchLimitError(resourceType, maxRows);
    }
    resources.push(...page);
    const nextLink = bundle.link?.find((link) => link.relation === "next");
    if (!nextLink) {
      return resources;
    }
    if (!nextLink.url) {
      throw new Error(`FHIR search returned a next link for ${resourceType} without a URL.`);
    }
    if (!client.searchUrl) {
      throw new Error(`FHIR search returned a next link for ${resourceType}, but the client cannot fetch it.`);
    }
    bundle = await client.searchUrl<T>(nextLink.url, resourceType);
  }
}

function paramsWithCount(params: Record<string, string>): Record<string, string> {
  return { _count: "100", ...params };
}
