import type { Basic, Bundle } from "@medplum/fhirtypes";

export const PROTOCOL_WRITE_HEADERS = { "X-ODOS-Source": "protocol-module" } as const;
const BASE = "https://odos2020.com/fhir";

export const PROTOCOL_BASIC_CODES = {
  protocolDefinition: "odos-protocol-definition",
  planActionInstance: "odos-plan-action-instance",
  protocolApplication: "odos-protocol-application",
  procedureChargeRule: "odos-procedure-charge-rule",
  chargeProposal: "odos-charge-proposal",
  findingInstance: "odos-finding-instance",
} as const;

export type ProtocolBasicCode = typeof PROTOCOL_BASIC_CODES[keyof typeof PROTOCOL_BASIC_CODES];

export interface ProtocolFhirClient {
  search<T extends Basic>(resourceType: T["resourceType"], params?: Record<string, string>): Promise<Bundle<T>>;
  create<T extends Basic>(resource: T, extraHeaders?: Record<string, string>): Promise<T>;
  update<T extends Basic>(
    resourceType: T["resourceType"],
    id: string,
    resource: T,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
  delete?(resourceType: "Basic", id: string): Promise<unknown>;
}

export class ProtocolBasicStore<T extends { id: string }> {
  constructor(private readonly fhir: ProtocolFhirClient, readonly code: ProtocolBasicCode) {}

  async list(): Promise<T[]> {
    const bundle = await this.fhir.search<Basic>("Basic", {
      code: `${BASE}/CodeSystem/odos-protocol-module|${this.code}`,
      _count: "500",
    });
    return (bundle.entry ?? []).flatMap((entry) => entry.resource ? [parseProtocolBasic<T>(entry.resource, this.code)] : []);
  }

  async get(id: string): Promise<T | undefined> {
    return (await this.list()).find((row) => row.id === id);
  }

  async save(value: T): Promise<T> {
    const existing = (await this.raw()).find((row) => identifier(row) === value.id);
    const resource = buildProtocolBasic(value, this.code, existing);
    const persisted = existing?.id
      ? await this.fhir.update("Basic", existing.id, resource, PROTOCOL_WRITE_HEADERS)
      : await this.fhir.create(resource, PROTOCOL_WRITE_HEADERS);
    return parseProtocolBasic<T>(persisted, this.code);
  }

  async remove(id: string): Promise<void> {
    const existing = (await this.raw()).find((row) => identifier(row) === id);
    if (!existing?.id) return;
    if (!this.fhir.delete) throw new Error("FHIR client does not support deleting an uncommitted protocol row.");
    await this.fhir.delete("Basic", existing.id);
  }

  private async raw(): Promise<Basic[]> {
    const bundle = await this.fhir.search<Basic>("Basic", {
      code: `${BASE}/CodeSystem/odos-protocol-module|${this.code}`,
      _count: "500",
    });
    return (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []);
  }
}

export function buildProtocolBasic<T extends { id: string }>(
  value: T,
  code: ProtocolBasicCode,
  existing?: Basic,
): Basic {
  if (!value.id.trim()) throw new Error(`${code} id is required.`);
  return {
    resourceType: "Basic",
    ...(existing?.id ? { id: existing.id } : {}),
    ...(existing?.meta ? { meta: existing.meta } : {}),
    identifier: [{ system: `${BASE}/NamingSystem/${code}`, value: value.id }],
    code: { coding: [{ system: `${BASE}/CodeSystem/odos-protocol-module`, code }] },
    extension: [{
      url: `${BASE}/StructureDefinition/${code}-json`,
      valueString: JSON.stringify(value),
    }],
  };
}

export function parseProtocolBasic<T extends { id: string }>(resource: Basic, code: ProtocolBasicCode): T {
  if (!resource.code?.coding?.some((coding) =>
    coding.system === `${BASE}/CodeSystem/odos-protocol-module` && coding.code === code
  )) throw new Error(`Basic resource is not ${code}.`);
  const raw = resource.extension?.find((extension) =>
    extension.url === `${BASE}/StructureDefinition/${code}-json`
  )?.valueString;
  if (!raw) throw new Error(`${code} Basic is missing its JSON extension.`);
  const parsed = JSON.parse(raw) as T;
  if (!parsed || typeof parsed !== "object" || typeof parsed.id !== "string") {
    throw new Error(`${code} JSON is invalid.`);
  }
  if (identifier(resource) !== parsed.id) throw new Error(`${code} identifier does not match id.`);
  return parsed;
}

function identifier(resource: Basic): string | undefined {
  return resource.identifier?.[0]?.value;
}
