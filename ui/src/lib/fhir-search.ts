import type { Bundle, Resource } from "@medplum/fhirtypes";

export interface FhirSearchClient {
  search<T extends Resource>(
    resourceType: T["resourceType"],
    params?: Record<string, string> | URLSearchParams | Array<[string, string]>,
  ): Promise<Bundle<T>>;
  searchUrl?<T extends Resource>(url: string): Promise<Bundle<T>>;
}

export async function searchAll<T extends Resource>(
  client: FhirSearchClient,
  resourceType: T["resourceType"],
  params?: Record<string, string> | URLSearchParams | Array<[string, string]>,
): Promise<T[]> {
  // search-contract: ui.fhir-search.all
  let bundle = await client.search<T>(resourceType, paramsWithCount(params));
  const resources: T[] = [];
  for (;;) {
    resources.push(
      ...(bundle.entry ?? [])
        .map((entry) => entry.resource)
        .filter((resource): resource is T => Boolean(resource)),
    );
    const nextUrl = bundle.link?.find((link) => link.relation === "next")?.url;
    if (!nextUrl) {
      return resources;
    }
    if (!client.searchUrl) {
      throw new Error(`FHIR search returned a next link for ${resourceType}, but the client cannot fetch it.`);
    }
    bundle = await client.searchUrl<T>(nextUrl);
  }
}

function paramsWithCount(
  params?: Record<string, string> | URLSearchParams | Array<[string, string]>,
): URLSearchParams {
  const searchParams = new URLSearchParams(params);
  if (!searchParams.has("_count")) {
    searchParams.set("_count", "100");
  }
  return searchParams;
}
