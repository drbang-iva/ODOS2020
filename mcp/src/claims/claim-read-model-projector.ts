import type { Claim, ClaimResponse, Resource, Task } from "@medplum/fhirtypes";
import type { MedplumClient } from "../fhir-client.js";
import { collectAllFhirSearchPages } from "../fhir-search.js";
import { projectClaimReadModel, type ClaimReadModelRow } from "./claim-read-model.js";
import { isRelatedClaimResource } from "./claim-search.js";

export type ClaimProjectionFhir = Pick<MedplumClient, "baseUrl" | "search" | "searchUrl">;

export async function loadClaimReadModelTruth(
  fhir: ClaimProjectionFhir,
  at: string,
): Promise<ClaimReadModelRow[]> {
  const [claims, responses, tasks] = await Promise.all([
    searchAllProjectionPages<Claim>(fhir, "Claim", { _count: "200", _sort: "-created" }),
    searchAllProjectionPages<ClaimResponse>(fhir, "ClaimResponse", { _count: "200", _sort: "-created" }),
    searchAllProjectionPages<Task>(fhir, "Task", { _count: "200", _sort: "-authored-on" }),
  ]);
  const relatedResources = (await Promise.all(
    (["Patient", "Practitioner", "PractitionerRole", "Organization", "Location"] as const).map(async (resourceType) => {
      const ids = claimReferenceIds(claims, resourceType);
      if (!ids.length) return [];
      const batches = chunk(ids, 100);
      return (await Promise.all(batches.map((batch) => searchAllProjectionPages<Resource>(
        fhir,
        resourceType,
        { _id: batch.join(","), _count: "100" },
      )))).flat().filter(isRelatedClaimResource);
    }),
  )).flat();
  return projectClaimReadModel({ claims, responses, tasks, relatedResources, at });
}

async function searchAllProjectionPages<T extends Resource>(
  fhir: ClaimProjectionFhir,
  resourceType: T["resourceType"],
  params: Record<string, string>,
): Promise<T[]> {
  // search-contract: claim-read-model-projector.search-resource
  const first = await fhir.search<T>(resourceType, params);
  return collectAllFhirSearchPages(fhir, resourceType, first, fhir.baseUrl);
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < values.length; index += size) batches.push(values.slice(index, index + size));
  return batches;
}

function claimReferenceIds(claims: readonly Claim[], resourceType: string): string[] {
  const prefix = `${resourceType}/`;
  const references = claims.flatMap((claim) => [
    claim.patient.reference,
    claim.provider?.reference,
    claim.insurer?.reference,
    claim.facility?.reference,
  ]).filter((reference): reference is string => Boolean(reference?.startsWith(prefix)));
  return [...new Set(references.map((reference) => reference.slice(prefix.length)))];
}
