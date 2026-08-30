import type { Claim, ClaimResponse, Resource, Task } from "@medplum/fhirtypes";
import type { MedplumClient } from "../fhir-client.js";
import { searchAll } from "../fhir-search.js";
import { projectClaimReadModel, type ClaimReadModelRow } from "./claim-read-model.js";
import { isRelatedClaimResource } from "./claim-search.js";

export type ClaimProjectionFhir = Pick<MedplumClient, "baseUrl" | "search" | "searchUrl">;

export async function loadClaimReadModelTruth(
  fhir: ClaimProjectionFhir,
  at: string,
): Promise<ClaimReadModelRow[]> {
  const [claims, responses, tasks] = await Promise.all([
    searchAll<Claim>(fhir, "Claim", { _count: "100", _sort: "-created" }),
    searchAll<ClaimResponse>(fhir, "ClaimResponse", { _count: "200", _sort: "-created" }),
    searchAll<Task>(fhir, "Task", { _count: "200", _sort: "-authored-on" }),
  ]);
  const relatedResources = (await Promise.all(
    (["Patient", "Practitioner", "PractitionerRole", "Organization", "Location"] as const).map(async (resourceType) => {
      const ids = claimReferenceIds(claims, resourceType);
      if (!ids.length) return [];
      return (await searchAll<Resource>(fhir, resourceType, { _id: ids.join(","), _count: String(ids.length) }))
        .filter(isRelatedClaimResource);
    }),
  )).flat();
  return projectClaimReadModel({ claims, responses, tasks, relatedResources, at });
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
