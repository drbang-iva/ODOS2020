/**
 * OSOD FHIR client — thin plain-fetch wrapper over Medplum's FHIR REST API.
 *
 * No Medplum SDK imports. Only @medplum/fhirtypes for type safety.
 * Server is swappable — any FHIR R4 server works at this interface.
 */

import type { Bundle, OperationOutcome, Resource } from "@medplum/fhirtypes";

export interface FhirClientOptions {
  baseUrl: string;
  accessToken?: string;
}

export class FhirClient {
  private baseUrl: string;
  private token?: string;

  constructor(opts: FhirClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.token = opts.accessToken;
  }

  setToken(token: string): void {
    this.token = token;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/fhir+json",
      Accept: "application/fhir+json",
      ...extra,
    };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  async create<T extends Resource>(resource: T): Promise<T> {
    const url = `${this.baseUrl}/fhir/R4/${resource.resourceType}`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(resource),
    });
    if (!res.ok) throw await this.toError(res);
    return (await res.json()) as T;
  }

  async read<T extends Resource>(
    resourceType: T["resourceType"],
    id: string,
  ): Promise<T> {
    const url = `${this.baseUrl}/fhir/R4/${resourceType}/${id}`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw await this.toError(res);
    return (await res.json()) as T;
  }

  async search<T extends Resource>(
    resourceType: T["resourceType"],
    params: Record<string, string> = {},
  ): Promise<Bundle<T>> {
    const query = new URLSearchParams(params).toString();
    const url = `${this.baseUrl}/fhir/R4/${resourceType}${query ? "?" + query : ""}`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw await this.toError(res);
    return (await res.json()) as Bundle<T>;
  }

  async login(email: string, password: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw await this.toError(res);
    const { accessToken } = (await res.json()) as { accessToken: string };
    this.token = accessToken;
  }

  private async toError(res: Response): Promise<Error> {
    const body = await res.text();
    let detail = body;
    try {
      const parsed = JSON.parse(body) as OperationOutcome;
      detail = parsed.issue?.map((i) => i.diagnostics ?? i.code).join("; ") ?? body;
    } catch {
      /* non-JSON body */
    }
    return new Error(`FHIR ${res.status} ${res.statusText}: ${detail}`);
  }
}
