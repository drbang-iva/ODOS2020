import type { Basic } from "@medplum/fhirtypes";
import type { MedplumClient } from "../fhir-client.js";
import { assertDate, practiceDate, searchAvailablePage } from "./day-ledger.js";

export const DAY_SEAL_CODE_SYSTEM = "https://odos2020.com/fhir/CodeSystem/day-seal";
export const DAY_SEAL_CODE = "day-seal";
export const DAY_SEAL_IDENTIFIER_SYSTEM = "https://odos2020.com/fhir/NamingSystem/day-seal-date";
export const DAY_SEAL_TIMESTAMP_URL = "https://odos2020.com/fhir/StructureDefinition/day-seal-timestamp";

export interface DaySeal {
  id: string;
  date: string;
  sealedBy: string;
  sealedAt: string;
}

export class DayAlreadySealedError extends Error {}

type DaySealFhir = Pick<MedplumClient, "search" | "create">;

export async function assertDayNotSealed(
  fhir: Pick<MedplumClient, "search">,
  effectiveAt: string,
  timeZone?: string,
): Promise<void> {
  const date = practiceDate(effectiveAt, timeZone);
  const existing = await loadDaySeal(fhir, date);
  if (existing) {
    throw new DayAlreadySealedError(
      `This day is already sealed — payments can't be backdated to a sealed day (${date}, sealed at ${existing.sealedAt}).`,
    );
  }
}

export async function loadDaySeal(
  fhir: Pick<MedplumClient, "search">,
  date: string,
): Promise<DaySeal | undefined> {
  assertDate(date);
  const read = await searchAvailablePage<Basic>(fhir, "Basic", [
    ["code", `${DAY_SEAL_CODE_SYSTEM}|${DAY_SEAL_CODE}`],
    ["identifier", `${DAY_SEAL_IDENTIFIER_SYSTEM}|${date}`],
    ["_count", "2"],
  ]);
  if (!read.complete || read.resources.length > 1) {
    throw new Error(`Day-seal lookup for ${date} is not uniquely readable.`);
  }
  return read.resources[0] ? projectDaySeal(read.resources[0]) : undefined;
}

export async function createDaySeal(
  fhir: DaySealFhir,
  input: { date: string; staffReference: string; sealedAt: string },
): Promise<DaySeal> {
  assertDate(input.date);
  if (!isFhirInstant(input.sealedAt)) throw new Error("Seal timestamp is invalid.");
  if (!/^(Practitioner|PractitionerRole)\/[^/]+$/.test(input.staffReference)) {
    throw new Error("Seal staff reference must identify a Practitioner or PractitionerRole.");
  }
  const existing = await loadDaySeal(fhir, input.date);
  if (existing) throw new DayAlreadySealedError(`${input.date} is already sealed.`);
  const created = await fhir.create<Basic>({
    resourceType: "Basic",
    identifier: [{ system: DAY_SEAL_IDENTIFIER_SYSTEM, value: input.date }],
    code: {
      coding: [{ system: DAY_SEAL_CODE_SYSTEM, code: DAY_SEAL_CODE, display: "ODOS day seal" }],
      text: "Day seal",
    },
    created: input.date,
    author: { reference: input.staffReference },
    extension: [{ url: DAY_SEAL_TIMESTAMP_URL, valueInstant: input.sealedAt }],
  }, {
    "If-None-Exist": `identifier=${DAY_SEAL_IDENTIFIER_SYSTEM}|${input.date}`,
  });
  return projectDaySeal(created);
}

export async function listDaySeals(fhir: Pick<MedplumClient, "search">): Promise<DaySeal[]> {
  const read = await searchAvailablePage<Basic>(fhir, "Basic", [
    ["code", `${DAY_SEAL_CODE_SYSTEM}|${DAY_SEAL_CODE}`],
    ["_count", "1000"],
    ["_sort", "-created"],
  ]);
  if (!read.complete) throw new Error("Day-seal archive exceeds the guarded read limit.");
  return read.resources.map(projectDaySeal).sort((a, b) => b.date.localeCompare(a.date));
}

function projectDaySeal(resource: Basic): DaySeal {
  const date = resource.identifier?.find((identifier) =>
    identifier.system === DAY_SEAL_IDENTIFIER_SYSTEM,
  )?.value;
  const sealedAt = resource.extension?.find((extension) =>
    extension.url === DAY_SEAL_TIMESTAMP_URL,
  )?.valueInstant;
  const sealedBy = resource.author?.reference;
  const coded = resource.code.coding?.some((coding) =>
    coding.system === DAY_SEAL_CODE_SYSTEM && coding.code === DAY_SEAL_CODE,
  );
  if (!resource.id || !coded || !date || !sealedAt || !sealedBy) {
    throw new Error(`Basic/${resource.id ?? "(unknown)"} is not a complete DaySeal.`);
  }
  assertDate(date);
  if (resource.created !== date) {
    throw new Error(`Basic/${resource.id} does not match its DaySeal date identity.`);
  }
  if (!/^(Practitioner|PractitionerRole)\/[^/]+$/.test(sealedBy)) {
    throw new Error(`Basic/${resource.id} has an invalid seal staff reference.`);
  }
  if (!isFhirInstant(sealedAt)) {
    throw new Error(`Basic/${resource.id} has an invalid seal timestamp.`);
  }
  return { id: resource.id, date, sealedBy, sealedAt };
}

function isFhirInstant(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(new Date(value).getTime());
}
