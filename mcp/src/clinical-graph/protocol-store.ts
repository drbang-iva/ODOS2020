import type { Basic, Bundle } from "@medplum/fhirtypes";
import type { ProtocolDefinition } from "./protocol-types.js";

export const PROTOCOL_WRITE_HEADERS = { "X-ODOS-Source": "protocol-module" } as const;
const BASE = "https://odos2020.com/fhir";

export const PROTOCOL_BASIC_CODES = {
  protocolDefinition: "odos-protocol-definition",
  protocolDefinitionSnapshot: "odos-protocol-definition-snapshot",
  planActionInstance: "odos-plan-action-instance",
  protocolApplication: "odos-protocol-application",
  procedureChargeRule: "odos-procedure-charge-rule",
  chargeProposal: "odos-charge-proposal",
  findingInstance: "odos-finding-instance",
} as const;

export type ProtocolBasicCode = typeof PROTOCOL_BASIC_CODES[keyof typeof PROTOCOL_BASIC_CODES];

export interface ProtocolFhirClient {
  search<T extends Basic>(resourceType: T["resourceType"], params?: Record<string, string>): Promise<Bundle<T>>;
  searchUrl?<T extends Basic>(url: string, resourceType: T["resourceType"]): Promise<Bundle<T>>;
  create<T extends Basic>(resource: T, extraHeaders?: Record<string, string>): Promise<T>;
  update<T extends Basic>(
    resourceType: T["resourceType"],
    id: string,
    resource: T,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
  delete?(resourceType: "Basic", id: string): Promise<unknown>;
}

interface ProtocolDefinitionSnapshotRecord {
  id: string;
  definition: ProtocolDefinition;
}

export function protocolSnapshotIdentifier(id: string, version: number): string {
  return `${id}@v${version}`;
}

export class ProtocolDefinitionStore {
  private readonly heads: ProtocolBasicStore<ProtocolDefinition>;
  private readonly snapshots: ProtocolBasicStore<ProtocolDefinitionSnapshotRecord>;

  constructor(fhir: ProtocolFhirClient) {
    this.heads = new ProtocolBasicStore(fhir, PROTOCOL_BASIC_CODES.protocolDefinition);
    this.snapshots = new ProtocolBasicStore(fhir, PROTOCOL_BASIC_CODES.protocolDefinitionSnapshot);
  }

  async list(): Promise<ProtocolDefinition[]> {
    return (await this.heads.list()).map((definition) => normalizeStoredDefinition(definition));
  }

  async get(id: string): Promise<ProtocolDefinition | undefined> {
    const definition = await this.heads.get(id);
    return definition ? normalizeStoredDefinition(definition) : undefined;
  }

  saveHead(definition: ProtocolDefinition): Promise<ProtocolDefinition> {
    return this.heads.save(definition);
  }

  async getSnapshot(id: string, version: number): Promise<ProtocolDefinition | undefined> {
    const row = await this.snapshots.get(protocolSnapshotIdentifier(id, version));
    if (row) return normalizeStoredDefinition(row.definition);
    const legacy = await this.heads.get(id);
    return legacy?.version === version && !legacy.draft ? normalizeStoredDefinition(legacy) : undefined;
  }

  async saveSnapshot(definition: ProtocolDefinition): Promise<ProtocolDefinition> {
    const id = protocolSnapshotIdentifier(definition.id, definition.version);
    const existing = await this.snapshots.get(id);
    if (existing) {
      if (JSON.stringify(existing.definition) !== JSON.stringify(definition)) {
        throw new Error(`Protocol snapshot ${id} is immutable.`);
      }
      return structuredClone(existing.definition);
    }
    const saved = await this.snapshots.createImmutable({ id, definition: structuredClone(definition) });
    if (JSON.stringify(saved.definition) !== JSON.stringify(definition)) {
      throw new Error(`Protocol snapshot ${id} already exists with different content.`);
    }
    return structuredClone(saved.definition);
  }

  async save(definition: ProtocolDefinition): Promise<ProtocolDefinition> {
    const snapshot = withoutDraft(definition);
    await this.saveSnapshot(snapshot);
    return this.saveHead(snapshot);
  }

  async ensureSeed(definition: ProtocolDefinition): Promise<ProtocolDefinition> {
    const existing = await this.heads.get(definition.id);
    const normalized = normalizeStoredDefinition(existing ?? definition, definition.authoring);
    await this.saveSnapshot(withoutDraft(normalized));
    if (!existing || JSON.stringify(existing) !== JSON.stringify(normalized)) {
      return this.saveHead(normalized);
    }
    return normalized;
  }
}

export class ProtocolBasicStore<T extends { id: string }> {
  constructor(private readonly fhir: ProtocolFhirClient, readonly code: ProtocolBasicCode) {}

  async list(): Promise<T[]> {
    return (await this.raw()).map((resource) => parseProtocolBasic<T>(resource, this.code));
  }

  async get(id: string): Promise<T | undefined> {
    const existing = await this.rawById(id);
    return existing ? parseProtocolBasic<T>(existing, this.code) : undefined;
  }

  async save(value: T): Promise<T> {
    const existing = await this.rawById(value.id);
    const resource = buildProtocolBasic(value, this.code, existing);
    const persisted = existing?.id
      ? await this.fhir.update("Basic", existing.id, resource, PROTOCOL_WRITE_HEADERS)
      : await this.fhir.create(resource, {
          ...PROTOCOL_WRITE_HEADERS,
          "If-None-Exist": `identifier=${identifierSystem(this.code)}|${value.id}`,
        });
    return parseProtocolBasic<T>(persisted, this.code);
  }

  async createImmutable(value: T): Promise<T> {
    const persisted = await this.fhir.create(buildProtocolBasic(value, this.code), {
      ...PROTOCOL_WRITE_HEADERS,
      "If-None-Exist": `identifier=${identifierSystem(this.code)}|${value.id}`,
    });
    return parseProtocolBasic<T>(persisted, this.code);
  }

  async remove(id: string): Promise<void> {
    const existing = await this.rawById(id);
    if (!existing?.id) return;
    if (!this.fhir.delete) throw new Error("FHIR client does not support deleting an uncommitted protocol row.");
    await this.fhir.delete("Basic", existing.id);
  }

  private async raw(): Promise<Basic[]> {
    return this.searchAll({
      code: `${BASE}/CodeSystem/odos-protocol-module|${this.code}`,
      _count: "500",
    });
  }

  private async rawById(id: string): Promise<Basic | undefined> {
    return (await this.searchAll({
      code: `${BASE}/CodeSystem/odos-protocol-module|${this.code}`,
      identifier: `${identifierSystem(this.code)}|${id}`,
      _count: "2",
    })).find((row) => identifier(row) === id);
  }

  private async searchAll(params: Record<string, string>): Promise<Basic[]> {
    const resources: Basic[] = [];
    const visited = new Set<string>();
    let bundle = await this.fhir.search<Basic>("Basic", params);
    while (true) {
      resources.push(...(bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []));
      const next = bundle.link?.find((link) => link.relation === "next")?.url;
      if (!next) return resources;
      if (!this.fhir.searchUrl) throw new Error("Protocol Basic search requires pagination support.");
      if (visited.has(next)) throw new Error("Protocol Basic search returned a repeated next link.");
      visited.add(next);
      bundle = await this.fhir.searchUrl<Basic>(next, "Basic");
    }
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
    identifier: [{ system: identifierSystem(code), value: value.id }],
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

function identifierSystem(code: ProtocolBasicCode): string {
  return `${BASE}/NamingSystem/${code}`;
}

function withoutDraft(definition: ProtocolDefinition): ProtocolDefinition {
  const { draft: _draft, ...snapshot } = definition;
  return structuredClone(snapshot);
}

function normalizeStoredDefinition(
  definition: ProtocolDefinition,
  fallbackAuthoring?: ProtocolDefinition["authoring"],
): ProtocolDefinition {
  const audit = definition.audit ?? {
    createdBy: "legacy-import",
    createdAt: "unknown",
  };
  return {
    ...definition,
    authoring: definition.authoring ?? fallbackAuthoring ?? {
      origin: "clinician",
      at: audit.createdAt,
      actor: audit.createdBy,
    },
    audit: {
      ...audit,
      ...(typeof audit.forkedFrom === "string"
        ? { forkedFrom: { id: audit.forkedFrom, version: 1 } }
        : {}),
    },
  };
}
