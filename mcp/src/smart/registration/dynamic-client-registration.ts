import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import type { Device, Endpoint, Provenance, Resource } from "@medplum/fhirtypes";
import { buildOsodAuditEventRow, type OsodActorRole } from "../../authz/osodAudit.js";
import type { FhirAuditRecorder } from "../../authz/liveAudit.js";
import type {
  SmartAuthorizationState,
  SmartClientRegistration,
} from "../authorization-server.js";
import {
  buildCanonicalSmartClientApp,
  readSmartClientApp,
  smartClientRegistrationResponse,
  SMART_APP_REGISTRY_POLICY_URL,
  SmartAppRegistryError,
  type DynamicClientRegistrationInput,
  type OSODSmartClientApp,
} from "./smart-client-app.js";

export interface SmartAppRegistryStore {
  create(record: Endpoint | Device): Promise<Endpoint | Device>;
  createProvenance?(provenance: Provenance): Promise<Provenance>;
  read(resourceType: "Endpoint" | "Device", id: string): Promise<Endpoint | Device | undefined>;
  list(): Promise<Array<Endpoint | Device>>;
}

export interface SmartAppMedplumAdapter {
  registerSmartApp(canonicalRecord: OSODSmartClientApp): Promise<{ client_id: string; client_secret?: string }>;
  revokeSmartApp(canonicalRecord: OSODSmartClientApp): Promise<void>;
  updateSmartAppMetadata(canonicalRecord: OSODSmartClientApp): Promise<void>;
}

export interface DynamicClientRegistrationOptions {
  readonly state: SmartAuthorizationState;
  readonly store: SmartAppRegistryStore;
  readonly adapter: SmartAppMedplumAdapter;
  readonly audit?: FhirAuditRecorder;
  readonly now?: () => Date;
}

export class InMemorySmartAppRegistryStore implements SmartAppRegistryStore {
  readonly records = new Map<string, Endpoint | Device>();
  readonly provenance = new Map<string, Provenance>();

  async create(record: Endpoint | Device): Promise<Endpoint | Device> {
    const id = record.id ?? `smart-app-${this.records.size + 1}`;
    const stored = { ...record, id } as Endpoint | Device;
    this.records.set(`${stored.resourceType}/${id}`, stored);
    return stored;
  }

  async createProvenance(provenance: Provenance): Promise<Provenance> {
    const id = provenance.id ?? `smart-app-provenance-${this.provenance.size + 1}`;
    const stored = { ...provenance, id };
    this.provenance.set(id, stored);
    return stored;
  }

  async read(resourceType: "Endpoint" | "Device", id: string): Promise<Endpoint | Device | undefined> {
    return this.records.get(`${resourceType}/${id}`);
  }

  async list(): Promise<Array<Endpoint | Device>> {
    return [...this.records.values()];
  }
}

export class HttpFhirSmartAppRegistryStore implements SmartAppRegistryStore {
  constructor(
    private readonly baseUrl: string,
    private readonly accessToken?: string,
  ) {}

  async create(record: Endpoint | Device): Promise<Endpoint | Device> {
    const response = await fetch(`${this.fhirBase()}/${record.resourceType}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(record),
    });
    if (!response.ok) {
      throw new Error(`FHIR ${record.resourceType} create failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as Endpoint | Device;
  }

  async createProvenance(provenance: Provenance): Promise<Provenance> {
    const response = await fetch(`${this.fhirBase()}/Provenance`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(provenance),
    });
    if (!response.ok) {
      throw new Error(`FHIR Provenance create failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as Provenance;
  }

  async read(resourceType: "Endpoint" | "Device", id: string): Promise<Endpoint | Device | undefined> {
    const response = await fetch(`${this.fhirBase()}/${resourceType}/${id}`, { headers: this.headers() });
    if (response.status === 404) {
      return undefined;
    }
    if (!response.ok) {
      throw new Error(`FHIR ${resourceType} read failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as Endpoint | Device;
  }

  async list(): Promise<Array<Endpoint | Device>> {
    const records: Array<Endpoint | Device> = [];
    for (const resourceType of ["Endpoint", "Device"] as const) {
      const response = await fetch(`${this.fhirBase()}/${resourceType}`, { headers: this.headers() });
      if (!response.ok) {
        continue;
      }
      const bundle = (await response.json()) as { entry?: Array<{ resource?: Resource }> };
      for (const entry of bundle.entry ?? []) {
        if (entry.resource?.resourceType === "Endpoint" || entry.resource?.resourceType === "Device") {
          const app = safeReadSmartApp(entry.resource);
          if (app) {
            records.push(app.canonicalRecord);
          }
        }
      }
    }
    return records;
  }

  private fhirBase(): string {
    const base = this.baseUrl.replace(/\/$/, "");
    return /\/fhir\/R4$/i.test(base) ? base : `${base}/fhir/R4`;
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/fhir+json",
      Accept: "application/fhir+json",
      ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
    };
  }
}

export function createDefaultSmartAppRegistryStore(baseUrl: string): SmartAppRegistryStore {
  return new HttpFhirSmartAppRegistryStore(baseUrl, process.env.OSOD_FHIR_ACCESS_TOKEN);
}

export function createDynamicClientRegistrationHandler(options: DynamicClientRegistrationOptions) {
  const now = options.now ?? (() => new Date());
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const canonical = buildCanonicalSmartClientApp(req.body as DynamicClientRegistrationInput);
      const stored = await options.store.create(canonical.canonicalRecord);
      const storedCanonical: OSODSmartClientApp = {
        ...canonical,
        canonicalRecord: stored,
        clientId: stored.id,
      };
      const adapterResult = await options.adapter.registerSmartApp(storedCanonical);
      const client: SmartClientRegistration = {
        clientId: adapterResult.client_id,
        name: storedCanonical.metadata.clientName,
        redirectUris: storedCanonical.metadata.redirectUris,
        clientType: storedCanonical.metadata.clientType,
        tokenEndpointAuthMethod: storedCanonical.metadata.tokenEndpointAuthMethod,
        jwksUri: storedCanonical.metadata.jwksUri,
        clientSecretHash: adapterResult.client_secret ? secretHash(adapterResult.client_secret) : undefined,
        scopesAllowed: [storedCanonical.metadata.defaultScope],
        isSandbox: false,
      };
      await options.state.saveClient(client);
      await options.store.createProvenance?.(
        buildSmartAppProvenance({
          target: `${stored.resourceType}/${stored.id}`,
          activityCode: "smart-app-register",
          recorded: now().toISOString(),
          actorId: req.header("X-OSOD-Actor-Id") ?? "smart-app-registry",
          actorRole: (req.header("X-OSOD-Role") as OsodActorRole | undefined) ?? "system",
        }),
      );
      await options.audit?.record(
        buildOsodAuditEventRow({
          eventType: "smart-app-registered",
          actorId: client.clientId,
          actorRole: "system",
          resourceType: stored.resourceType,
          resourceId: stored.id,
          policyUrl: SMART_APP_REGISTRY_POLICY_URL,
          actionReason: "SMART app registered through local dynamic registration endpoint",
        }),
        async () => undefined,
      );
      res.status(201).json(smartClientRegistrationResponse({
        app: storedCanonical,
        clientId: client.clientId,
        clientSecret: adapterResult.client_secret,
      }));
    } catch (error) {
      sendRegistrationError(res, error);
    }
  };
}

export function buildSmartAppProvenance(input: {
  readonly target: string;
  readonly activityCode: string;
  readonly recorded: string;
  readonly actorId: string;
  readonly actorRole: OsodActorRole;
}): Provenance {
  return {
    resourceType: "Provenance",
    target: [{ reference: input.target }],
    recorded: input.recorded,
    policy: [SMART_APP_REGISTRY_POLICY_URL],
    activity: {
      coding: [
        {
          system: "https://osod.dev/fhir/CodeSystem/smart-app-activity",
          code: input.activityCode,
          display: input.activityCode,
        },
      ],
      text: input.activityCode,
    },
    agent: [
      {
        role: [{ text: input.actorRole }],
        who: { reference: input.actorRole === "system" ? "Device/osod-instance" : `Practitioner/${input.actorId}` },
      },
    ],
  };
}

function sendRegistrationError(res: Response, error: unknown): void {
  if (error instanceof SmartAppRegistryError) {
    res.status(error.status).json({ error: error.code, error_description: error.message });
    return;
  }
  res.status(500).json({
    error: "server_error",
    error_description: error instanceof Error ? error.message : String(error),
  });
}

function secretHash(secret: string): string {
  return createHash("sha256").update(secret).digest("base64url");
}

function safeReadSmartApp(resource: Resource): OSODSmartClientApp | undefined {
  if (resource.resourceType !== "Endpoint" && resource.resourceType !== "Device") {
    return undefined;
  }
  try {
    return readSmartClientApp(resource);
  } catch {
    return undefined;
  }
}
