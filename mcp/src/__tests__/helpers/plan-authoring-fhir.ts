import type { Basic, Bundle, Reference, Resource } from "@medplum/fhirtypes";
import type { ProtocolEndpointDeps } from "../../clinical-graph/protocol-endpoint.js";

export class PlanAuthoringFhir {
  readonly baseUrl = "http://localhost:8103/";
  rows: Resource[] = [];
  writes: Array<{ resource: Resource; headers?: Record<string, string> }> = [];
  beforeUpdate?: (resource: Resource, headers?: Record<string, string>) => Promise<void>;
  afterSearch?: (params?: Record<string, string>) => Promise<void>;
  private next = 1;
  async search<T extends Resource>(type: T["resourceType"], params?: Record<string, string>): Promise<Bundle<T>> {
    const [system, value] = params?.identifier?.split("|") ?? [];
    const code = params?.code?.split("|").at(-1);
    const rows = this.rows.filter(row => row.resourceType === type &&
      (!params?.patient || ("subject" in row && (row.subject as Reference | undefined)?.reference === (params.patient.startsWith("Patient/") ? params.patient : `Patient/${params.patient}`))) &&
      (!params?.encounter || ("encounter" in row && row.encounter?.reference === params.encounter)) &&
      (!code || (row as Basic).code?.coding?.some(c => c.code === code)) &&
      (!value || (row as Basic).identifier?.some(i => i.system === system && i.value === value)));
    const result: Bundle<T> = { resourceType: "Bundle", type: "searchset", entry: rows.map(resource => ({ resource: structuredClone(resource) as T })) };
    await this.afterSearch?.(params);
    return result;
  }
  async read<T extends Resource>(type: T["resourceType"], id: string): Promise<T> {
    const resource = this.rows.find(row => row.resourceType === type && row.id === id);
    if (!resource) throw Object.assign(new Error("Not found"), { status: 404 });
    return structuredClone(resource) as T;
  }
  async create<T extends Resource>(resource: T, headers?: Record<string, string>): Promise<T> {
    const [system, value] = headers?.["If-None-Exist"]?.replace(/^identifier=/, "").split("|") ?? [];
    const existing = value && this.rows.find(row => row.resourceType === resource.resourceType &&
      (row as Basic).identifier?.some(i => i.system === system && i.value === value));
    if (existing) return structuredClone(existing) as T;
    const saved = { ...structuredClone(resource), id: resource.id ?? `test-${this.next++}`, meta: { ...resource.meta, versionId: "1" } };
    this.rows.push(saved);
    this.writes.push({ resource: structuredClone(saved), headers });
    return structuredClone(saved);
  }
  update = async <T extends Resource>(type: T["resourceType"], id: string, resource: T, headers?: Record<string, string>): Promise<T> => {
    await this.beforeUpdate?.(resource, headers);
    const index = this.rows.findIndex(row => row.resourceType === type && row.id === id);
    const current = this.rows[index];
    if (headers?.["If-Match"] && headers["If-Match"] !== `W/"${current?.meta?.versionId}"`) {
      throw Object.assign(new Error("FHIR 412 Precondition Failed"), { status: 412 });
    }
    const saved = { ...structuredClone(resource), id, meta: { ...resource.meta, versionId: String(Number(current?.meta?.versionId ?? 0) + 1) } };
    this.rows[index] = saved;
    this.writes.push({ resource: structuredClone(saved), headers });
    return structuredClone(saved);
  }
  async delete(type: string, id: string): Promise<void> {
    this.rows = this.rows.filter(row => row.resourceType !== type || row.id !== id);
  }
}
export function endpointDeps(fhir: PlanAuthoringFhir): ProtocolEndpointDeps {
  return { authenticate: async () => ({ staffReference: "Practitioner/test", actorRole: "provider", fhir }), now: () => "2026-09-15T14:00:00.000Z" };
}
