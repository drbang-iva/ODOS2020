import type { Basic } from "@medplum/fhirtypes";
import { fhir } from "./fhir";
import { searchAll } from "./fhir-search";
import { ODOS_AGE_OF_MAJORITY_CONFIG_SYSTEM, ODOS_AGE_OF_MAJORITY_CONFIG_CODE } from "../../../mcp/src/clinic/age-of-majority-config";

export async function loadAgeOfMajorityConfig(client: Pick<typeof fhir, "search" | "searchUrl"> = fhir): Promise<Basic | undefined> {
  const resources = await searchAll<Basic>(client, "Basic", {
    code: `${ODOS_AGE_OF_MAJORITY_CONFIG_SYSTEM}|${ODOS_AGE_OF_MAJORITY_CONFIG_CODE}`,
    _count: "10",
  });
  if (resources.length > 1) throw new Error("Age of majority is not configured: multiple settings were found.");
  return resources[0];
}
