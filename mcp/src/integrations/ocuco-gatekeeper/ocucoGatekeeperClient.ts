import {
  isOcucoGatekeeperConfigured,
  type OcucoGatekeeperConfig,
} from "./config.js";

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export interface OcucoAuthSession {
  authToken: string;
  expiresAt: string;
}

export interface OcucoGatekeeperContract {
  hashRoutingKey: string;
  labNumReceiver: string;
  custNumReceiver: string;
}

export interface OcucoPushOrderRequest {
  hashRoutingKey: string;
  hashrefBody: string;
  traceBody?: string;
}

export interface OcucoPushOrderResponse {
  id: number;
  guid: string;
  createdAt: string;
  updatedAt: string;
}

export interface InnovationsJobStatus {
  RxNumber: string;
  PoNumber?: string;
  StatusDate: string;
  Status: string;
  OrderID: string;
  OMA?: string[];
  [key: string]: unknown;
}

export interface LabzillaJobStatus {
  RxNumber?: "";
  PoNumber: string;
  OrderDate: string;
  StatusDate: string;
  Status: string;
  [key: string]: unknown;
}

export type OcucoJobStatus = InnovationsJobStatus | LabzillaJobStatus;
export type OcucoJobStatusPullResponse = {
  message?: string;
  job_status?: OcucoJobStatus[] | OcucoJobStatus[][] | Array<OcucoJobStatus | OcucoJobStatus[]>;
};

export interface OcucoGatekeeperClient {
  authenticate(config: OcucoGatekeeperConfig): Promise<OcucoAuthSession>;
  getContract(authToken: string, config: OcucoGatekeeperConfig): Promise<OcucoGatekeeperContract>;
  pushOrderToLab(
    authToken: string,
    request: OcucoPushOrderRequest,
    config: OcucoGatekeeperConfig,
  ): Promise<OcucoPushOrderResponse>;
  /**
   * This endpoint is a destructive read: callers must persist the raw response before
   * parsing or discarding it, and must not poll more often than once every five minutes.
   */
  pullJobStatus(
    authToken: string,
    hashRoutingKey: string,
    config: OcucoGatekeeperConfig,
  ): Promise<OcucoJobStatusPullResponse>;
}

export interface OcucoGatekeeperClientOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export function createOcucoGatekeeperClient(
  options: OcucoGatekeeperClientOptions = {},
): OcucoGatekeeperClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const tokenCache = new Map<string, OcucoAuthSession>();

  return {
    async authenticate(config): Promise<OcucoAuthSession> {
      const configured = assertConfigured(config);
      const cacheKey = [configured.baseUrl, configured.jwtKey, configured.jwtSecret].join("\u0000");
      const cached = tokenCache.get(cacheKey);
      if (cached && new Date(cached.expiresAt).getTime() > now().getTime()) return cached;

      const url = endpoint(configured.baseUrl, "/api/v2/auth_user");
      url.searchParams.set("jwt_key", configured.jwtKey);
      url.searchParams.set("jwt_secret", configured.jwtSecret);
      const response = await fetchJson(fetchImpl, url, { method: "POST" }, "authentication");
      const authToken = readRequiredString(response, "auth_token", "authentication response");
      const responseTime = now();
      const session = {
        authToken,
        expiresAt: new Date(responseTime.getTime() + TOKEN_TTL_MS).toISOString(),
      };
      // Ocuco blacklists callers that renew more than twice daily. This in-memory cache
      // means each process restart consumes a renewal; durable caching is a later ops concern.
      tokenCache.set(cacheKey, session);
      return session;
    },

    async getContract(authToken, config): Promise<OcucoGatekeeperContract> {
      const configured = assertConfigured(config);
      const response = await fetchJson(fetchImpl, endpoint(
        configured.baseUrl,
        "/api/v2/operations/contract_available",
      ), { headers: bearer(authToken) }, "contract discovery");
      const contract = sendingContracts(response).find(hasRequiredContractFields);
      if (!contract) {
        throw new Error("Ocuco Gatekeeper sending contract is missing hash_routing, webrx_lab_id_receiver, or webrx_retailer_name_receiver.");
      }
      return {
        hashRoutingKey: readContractString(contract, ["hash_routing", "hash_routing_key"])!,
        labNumReceiver: readContractString(contract, ["webrx_lab_id_receiver"])!,
        custNumReceiver: readContractString(contract, ["webrx_retailer_name_receiver"])!,
      };
    },

    async pushOrderToLab(authToken, request, config): Promise<OcucoPushOrderResponse> {
      const configured = assertConfigured(config);
      const response = await fetchJson(fetchImpl, endpoint(
        configured.baseUrl,
        "/api/v2/orders/push_order_to_lab",
      ), {
        method: "POST",
        headers: { ...bearer(authToken), "Content-Type": "application/json" },
        body: JSON.stringify({
          order: {
            hash_routing: request.hashRoutingKey,
            rx_content: request.hashrefBody,
            tr_content: request.traceBody ?? "",
          },
        }),
      }, "order submission");
      const message = readRecord(response, "message", "order submission response");
      const id = message.id;
      if (typeof id !== "number") throw new Error("Ocuco Gatekeeper order submission response is missing message.id.");
      return {
        id,
        guid: readRequiredString(message, "guid", "order submission response"),
        createdAt: readRequiredString(message, "created_at", "order submission response"),
        updatedAt: readRequiredString(message, "updated_at", "order submission response"),
      };
    },

    async pullJobStatus(authToken, hashRoutingKey, config): Promise<OcucoJobStatusPullResponse> {
      const configured = assertConfigured(config);
      const url = endpoint(configured.baseUrl, "/api/v2/status/pulling_job_status");
      url.searchParams.set("status[hash_routing]", hashRoutingKey);
      const response = await fetchJson(fetchImpl, url, { headers: bearer(authToken) }, "job-status pull");
      if (!isRecord(response)) throw new Error("Ocuco Gatekeeper job-status response must be a JSON object.");
      return response as OcucoJobStatusPullResponse;
    },
  };
}

export function isInnovationsJobStatus(value: unknown): value is InnovationsJobStatus {
  return isRecord(value)
    && typeof value.RxNumber === "string"
    && value.RxNumber.trim().length > 0
    && typeof value.StatusDate === "string"
    && typeof value.Status === "string"
    && typeof value.OrderID === "string";
}

export function isLabzillaJobStatus(value: unknown): value is LabzillaJobStatus {
  return isRecord(value)
    && typeof value.PoNumber === "string"
    && value.PoNumber.trim().length > 0
    && (value.RxNumber === undefined || value.RxNumber === "")
    && typeof value.OrderDate === "string"
    && typeof value.StatusDate === "string"
    && typeof value.Status === "string";
}

function assertConfigured(config: OcucoGatekeeperConfig): Required<OcucoGatekeeperConfig> {
  if (!isOcucoGatekeeperConfigured(config)) {
    throw new Error("Ocuco Gatekeeper is not configured — see OCUCO_GATEKEEPER_* env vars");
  }
  return config as Required<OcucoGatekeeperConfig>;
}

function endpoint(baseUrl: string, path: string): URL {
  return new URL(path, `${baseUrl.replace(/\/$/, "")}/`);
}

function bearer(authToken: string): Record<string, string> {
  return { Authorization: `Bearer ${authToken}` };
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: URL,
  init: RequestInit,
  operation: string,
): Promise<unknown> {
  const response = await fetchImpl(url, init);
  if (!response.ok) {
    throw new Error(`Ocuco Gatekeeper ${operation} failed with HTTP ${response.status}.`);
  }
  return response.json();
}

function sendingContracts(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value)) return [];
  if (hasRequiredContractFields(value)) return [value];
  const message = isRecord(value.message) ? value.message : undefined;
  const lab = message && isRecord(message.lab) ? message.lab : undefined;
  for (const candidate of [lab?.contractSending, message?.contractSending, value.contractSending]) {
    if (Array.isArray(candidate)) return candidate.filter(isRecord);
  }
  return [];
}

function hasRequiredContractFields(value: Record<string, unknown>): boolean {
  return readContractString(value, ["hash_routing", "hash_routing_key"]) !== undefined
    && readContractString(value, ["webrx_lab_id_receiver"]) !== undefined
    && readContractString(value, ["webrx_retailer_name_receiver"]) !== undefined;
}

function readContractString(
  value: Record<string, unknown>,
  names: string[],
): string | undefined {
  for (const name of names) {
    const candidate = value[name];
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return undefined;
}

function readRequiredString(value: unknown, field: string, context: string): string {
  if (!isRecord(value) || typeof value[field] !== "string" || !value[field].trim()) {
    throw new Error(`Ocuco Gatekeeper ${context} is missing ${field}.`);
  }
  return value[field];
}

function readRecord(value: unknown, field: string, context: string): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value[field])) {
    throw new Error(`Ocuco Gatekeeper ${context} is missing ${field}.`);
  }
  return value[field];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
