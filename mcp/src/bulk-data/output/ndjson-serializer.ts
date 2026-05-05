import type { Coding, Resource } from "@medplum/fhirtypes";
import { AIAST_CODE_SYSTEM } from "../../agentops/types.js";

export const DICTAST_CODING: Coding = {
  system: "http://terminology.hl7.org/CodeSystem/v3-ObservationValue",
  code: "DICTAST",
  display: "Dictation Asserted",
};

export const CPLYCUI_CODING: Coding = {
  system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
  code: "CPLYCUI",
  display: "Comply with Controlled Unclassified Information",
};

export function serializeBulkDataNdjson(resources: readonly Resource[]): string {
  return resources.map((resource) => JSON.stringify(resource)).join("\n") + (resources.length ? "\n" : "");
}

export function assertMetaSecurityPreserved(
  original: Resource,
  serializedLine: string,
): void {
  const expected = original.meta?.security ?? [];
  if (!expected.length) {
    return;
  }
  const parsed = JSON.parse(serializedLine) as Resource;
  const actual = parsed.meta?.security ?? [];
  for (const coding of expected) {
    if (!actual.some((candidate) => sameCoding(candidate, coding))) {
      throw new Error(`Bulk Data NDJSON serialization dropped meta.security ${coding.system}|${coding.code}.`);
    }
  }
}

export function hasSecurityCode(resource: Resource, code: "AIAST" | "DICTAST" | "CPLYCUI"): boolean {
  return Boolean(resource.meta?.security?.some((coding) => coding.code === code && expectedSystem(code) === coding.system));
}

function sameCoding(a: Coding, b: Coding): boolean {
  return a.system === b.system && a.code === b.code;
}

function expectedSystem(code: "AIAST" | "DICTAST" | "CPLYCUI"): string {
  return code === "CPLYCUI" ? "http://terminology.hl7.org/CodeSystem/v3-ActCode" : AIAST_CODE_SYSTEM;
}
