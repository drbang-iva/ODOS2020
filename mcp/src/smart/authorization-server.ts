import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
  type JsonWebKey,
} from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import express, { type Request, type Response, type Router } from "express";
import { Pool } from "pg";
import { buildOsodAuditEventRow, type OsodActorRole } from "../authz/osodAudit.js";
import type { FhirAuditRecorder } from "../authz/liveAudit.js";
import { type PracticeRoleId, PRACTICE_ROLE_IDS } from "../authz/roles.js";
import {
  assertPkceS256AuthorizationRequest,
  verifyPkceS256,
} from "./pkce.js";
import {
  approveStagedScopeDecision,
  evaluateSmartScopeIntersection,
  type SmartClientAuthClass,
  type SmartLaunchContext,
  type SmartScopeDecisionRecord,
} from "./scope-intersection.js";
import {
  parseSmartScopeList,
  splitScopeText,
  type SmartResourceScope,
} from "./scope.js";
import {
  sendSmartConfiguration,
  type SmartConfigurationSnapshot,
} from "./well-known-smart-configuration.js";
import {
  createDefaultSmartAppRegistryStore,
  createDynamicClientRegistrationHandler,
  type SmartAppMedplumAdapter,
  type SmartAppRegistryStore,
} from "./registration/dynamic-client-registration.js";
import { createMedplumSmartAppRegistryAdapter } from "../../../data/medplum-adapters/smart-app-registry-adapter.js";
import { V055B_SMART_CAPABILITIES } from "./registration/smart-client-app.js";
import { dispatchCdsHook } from "../cds/dispatcher.js";
import {
  buildCanonicalCdsService,
  buildCdsServiceProvenance,
  cdsServiceDiscoveryEntry,
  CdsServiceRegistryError,
  deactivateCdsServiceEndpoint,
  InMemoryCdsServiceRegistryStore,
  activeCdsServiceEndpoints,
  type CdsServiceRegistryStore,
} from "../cds/service-registry.js";
import {
  InMemoryCdsFeedbackRepository,
  parseCdsFeedbackRequest,
  persistCdsFeedback,
  type CdsFeedbackRepository,
} from "../cds/feedback.js";
import { OSOD_DEFAULT_CDS_SERVICES, OSOD_DEFAULT_CDS_SERVICE_IDS } from "../cds/services/index.js";
import type { CdsHookEvaluationInput, CdsHookId, CdsFhirAuthorization } from "../cds/types.js";

export const SMART_AUTH_CODE_TTL_SECONDS = 60;
export const SMART_ACCESS_TOKEN_TTL_SECONDS = 300;
export const SMART_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export type SmartClientType = "public" | "confidential";
export type SmartTokenEndpointAuthMethod =
  | "none"
  | "client_secret_basic"
  | "client_secret_post"
  | "private_key_jwt";

export interface SmartClientRegistration {
  readonly clientId: string;
  readonly name: string;
  readonly redirectUris: readonly string[];
  readonly clientType: SmartClientType;
  readonly tokenEndpointAuthMethod: SmartTokenEndpointAuthMethod;
  readonly jwksUri?: string;
  readonly clientSecretHash?: string;
  readonly scopesAllowed: readonly string[];
  readonly isSandbox: boolean;
}

export interface SmartAuthorizationCode {
  readonly code: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state?: string;
  readonly codeChallenge: string;
  readonly userId: string;
  readonly roleId: PracticeRoleId;
  readonly scope: string;
  readonly passthroughScopes: readonly string[];
  readonly launchContext: SmartLaunchContext;
  readonly expiresAt: number;
  redeemedAt?: number;
  issuedTokenJtis: string[];
}

export interface SmartPendingAuthorization {
  readonly decisionId: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state?: string;
  readonly codeChallenge: string;
  readonly userId: string;
  readonly roleId: PracticeRoleId;
  readonly passthroughScopes: readonly string[];
  readonly launchContext: SmartLaunchContext;
}

export interface SmartTokenRecord {
  readonly token: string;
  readonly tokenKind: "access_token" | "refresh_token";
  readonly clientId: string;
  readonly scope: string;
  readonly username: string;
  readonly sub: string;
  readonly aud: string;
  readonly iss: string;
  readonly jti: string;
  readonly iat: number;
  readonly exp: number;
  readonly launchContext: SmartLaunchContext;
  active: boolean;
  readonly authorizationCode?: string;
}

export interface SmartAuthorizationServerOptions {
  readonly issuer: string;
  readonly fhirBaseUrl: string;
  readonly signingKeyPath?: string;
  readonly signingKey?: SmartSigningKey;
  readonly audit?: FhirAuditRecorder;
  readonly state?: SmartAuthorizationState;
  readonly smartAppRegistryStore?: SmartAppRegistryStore;
  readonly smartAppMedplumAdapter?: SmartAppMedplumAdapter;
  readonly cdsServiceRegistryStore?: CdsServiceRegistryStore;
  readonly cdsFeedbackRepository?: CdsFeedbackRepository;
  readonly now?: () => Date;
}

export interface SmartSigningKey {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly publicJwk: JsonWebKey & { kid: string; alg: "RS256"; use: "sig" };
}

export class SmartAuthorizationState {
  readonly clients = new Map<string, SmartClientRegistration>();
  readonly authorizationCodes = new Map<string, SmartAuthorizationCode>();
  readonly pendingAuthorizations = new Map<string, SmartPendingAuthorization>();
  readonly tokens = new Map<string, SmartTokenRecord>();
  readonly decisions = new Map<string, SmartScopeDecisionRecord>();
  readonly replayJtis = new Map<string, number>();
  private readonly pool?: Pool;
  private schemaReady?: Promise<void>;
  updatedAt = new Date().toISOString();

  constructor(seedClients: readonly SmartClientRegistration[] = [], options: { readonly postgresUrl?: string } = {}) {
    if (options.postgresUrl) {
      this.pool = new Pool({ connectionString: options.postgresUrl, max: 2 });
    }
    for (const client of seedClients) {
      this.clients.set(client.clientId, client);
    }
  }

  touch(now = new Date()): void {
    this.updatedAt = now.toISOString();
  }

  async getClient(clientId: string): Promise<SmartClientRegistration | undefined> {
    const inMemory = this.clients.get(clientId);
    if (inMemory) {
      return inMemory;
    }
    if (!this.pool) {
      return undefined;
    }
    await this.ensureSchema();
    const result = await this.pool.query(
      `
        SELECT client_id, name, redirect_uris, client_type, token_endpoint_auth_method,
               jwks_uri, client_secret_hash, scopes_allowed, is_sandbox
        FROM osod_smart_clients
        WHERE client_id = $1
      `,
      [clientId],
    );
    const client = result.rows[0] ? pgClient(result.rows[0]) : undefined;
    if (client) {
      this.clients.set(client.clientId, client);
    }
    return client;
  }

  async clientsForDiscovery(): Promise<SmartClientRegistration[]> {
    const clients = new Map(this.clients);
    if (this.pool) {
      await this.ensureSchema();
      const result = await this.pool.query(
        `
          SELECT client_id, name, redirect_uris, client_type, token_endpoint_auth_method,
                 jwks_uri, client_secret_hash, scopes_allowed, is_sandbox
          FROM osod_smart_clients
          ORDER BY updated_at DESC
        `,
      );
      for (const row of result.rows) {
        const client = pgClient(row);
        clients.set(client.clientId, client);
      }
    }
    return [...clients.values()];
  }

  async saveClient(client: SmartClientRegistration): Promise<void> {
    this.clients.set(client.clientId, client);
    this.touch();
    if (!this.pool) {
      return;
    }
    await this.ensureSchema();
    await this.pool.query(
      `
        INSERT INTO osod_smart_clients (
          client_id, name, redirect_uris, client_type, token_endpoint_auth_method,
          jwks_uri, client_secret_hash, scopes_allowed, is_sandbox, updated_at
        )
        VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8::jsonb, $9, now())
        ON CONFLICT (client_id) DO UPDATE SET
          name = EXCLUDED.name,
          redirect_uris = EXCLUDED.redirect_uris,
          client_type = EXCLUDED.client_type,
          token_endpoint_auth_method = EXCLUDED.token_endpoint_auth_method,
          jwks_uri = EXCLUDED.jwks_uri,
          client_secret_hash = EXCLUDED.client_secret_hash,
          scopes_allowed = EXCLUDED.scopes_allowed,
          is_sandbox = EXCLUDED.is_sandbox,
          updated_at = now()
      `,
      [
        client.clientId,
        client.name,
        JSON.stringify(client.redirectUris),
        client.clientType,
        client.tokenEndpointAuthMethod,
        client.jwksUri,
        client.clientSecretHash,
        JSON.stringify(client.scopesAllowed),
        client.isSandbox,
      ],
    );
  }

  private async ensureSchema(): Promise<void> {
    this.schemaReady ??= this.pool?.query(`
      CREATE TABLE IF NOT EXISTS osod_smart_clients (
        client_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        redirect_uris JSONB NOT NULL,
        client_type TEXT NOT NULL,
        token_endpoint_auth_method TEXT NOT NULL,
        jwks_uri TEXT,
        client_secret_hash TEXT,
        scopes_allowed JSONB NOT NULL DEFAULT '[]'::jsonb,
        is_sandbox BOOLEAN NOT NULL DEFAULT false,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `).then(() => undefined) ?? Promise.resolve();
    await this.schemaReady;
  }
}

export function createSmartAuthorizationRouter(options: SmartAuthorizationServerOptions): Router {
  const now = options.now ?? (() => new Date());
  const state = options.state ?? new SmartAuthorizationState([defaultSandboxClient(options.issuer)], {
    postgresUrl: process.env.OSOD_POSTGRES_URL,
  });
  const signingKey = options.signingKey ?? loadSmartSigningKey(options.signingKeyPath);
  const smartAppRegistryStore = options.smartAppRegistryStore ?? createDefaultSmartAppRegistryStore(options.fhirBaseUrl);
  const smartAppMedplumAdapter = options.smartAppMedplumAdapter ?? createMedplumSmartAppRegistryAdapter();
  const cdsServiceRegistryStore = options.cdsServiceRegistryStore ?? new InMemoryCdsServiceRegistryStore();
  const cdsFeedbackRepository = options.cdsFeedbackRepository ?? new InMemoryCdsFeedbackRepository();
  const router = express.Router();

  router.use(express.urlencoded({ extended: false }));
  router.use(express.json({ limit: "256kb" }));

  router.get("/.well-known/smart-configuration", async (req, res) => {
    await audit(options.audit, "smart-discovery-fetch", req, {
      actorId: "smart-discovery",
      actorRole: "system",
      resourceType: "SmartConfiguration",
      actionReason: "SMART discovery document fetched",
    });
    sendSmartConfiguration(req, res, await smartConfigurationSnapshot(options, state));
  });

  router.get("/authorize", async (req, res) => {
    try {
      const client = await requireClient(state, stringQuery(req, "client_id"));
      const redirectUri = stringQuery(req, "redirect_uri");
      assertRedirectUri(client, redirectUri);
      if (stringQuery(req, "response_type") !== "code") {
        throw oauthError("invalid_request", "response_type must be code", 400);
      }
      assertPkceS256AuthorizationRequest({
        codeChallenge: stringQuery(req, "code_challenge"),
        codeChallengeMethod: stringQuery(req, "code_challenge_method"),
      });

      const parsedScopes = parseSmartScopeList(stringQuery(req, "scope"));
      const roleId = roleFromRequest(req);
      const launchContext = launchContextFromRequest(req);
      const decision = evaluateSmartScopeIntersection({
        appClientId: client.clientId,
        userId: userFromRequest(req),
        roleId,
        clientAuthClass: clientAuthClass(client),
        requestedScopes: parsedScopes.resourceScopes,
        launchContext,
      });
      state.decisions.set(decision.id, decision);
      state.touch(now());

      if (decision.outcomeClass === "staged-review") {
        state.pendingAuthorizations.set(decision.id, {
          decisionId: decision.id,
          clientId: client.clientId,
          redirectUri,
          state: stringQuery(req, "state"),
          codeChallenge: stringQuery(req, "code_challenge")!,
          userId: decision.userId,
          roleId,
          passthroughScopes: parsedScopes.passthroughScopes,
          launchContext,
        });
        await audit(options.audit, "smart-scope-staged-review", req, {
          actorId: decision.userId,
          actorRole: roleId,
          resourceType: "osod_smart_scope_decisions",
          resourceId: decision.id,
          actionOutcome: "granted",
          actionReason: decision.reason,
        });
        res.status(202).json({ status: "pending_review", decision_id: decision.id });
        return;
      }
      if (decision.outcomeClass === "rejected") {
        await audit(options.audit, "smart-scope-rejected", req, {
          actorId: decision.userId,
          actorRole: roleId,
          resourceType: "osod_smart_scope_decisions",
          resourceId: decision.id,
          actionOutcome: "denied",
          actionReason: decision.reason,
        });
        throw oauthError("access_denied", decision.reason ?? "scope rejected", 403);
      }

      await audit(options.audit, "smart-scope-approved", req, {
        actorId: decision.userId,
        actorRole: roleId,
        resourceType: "osod_smart_scope_decisions",
        resourceId: decision.id,
        actionReason: decision.reason,
      });
      const code = randomSecret();
      state.authorizationCodes.set(code, {
        code,
        clientId: client.clientId,
        redirectUri,
        state: stringQuery(req, "state"),
        codeChallenge: stringQuery(req, "code_challenge")!,
        userId: decision.userId,
        roleId,
        scope: scopeText([...decision.effectiveScopes, ...parsedScopes.passthroughScopes]),
        passthroughScopes: parsedScopes.passthroughScopes,
        launchContext,
        expiresAt: now().getTime() + SMART_AUTH_CODE_TTL_SECONDS * 1000,
        issuedTokenJtis: [],
      });
      state.touch(now());
      const location = new URL(redirectUri);
      location.searchParams.set("code", code);
      if (stringQuery(req, "state")) {
        location.searchParams.set("state", stringQuery(req, "state")!);
      }
      res.redirect(302, location.toString());
    } catch (error) {
      sendOauthError(res, error);
    }
  });

  router.post("/token", async (req, res) => {
    try {
      const client = await authenticateTokenClient(state, req, options.issuer);
      const grantType = bodyString(req, "grant_type");
      if (grantType === "authorization_code") {
        await handleAuthorizationCodeGrant({ req, res, client, state, options, signingKey, now });
        return;
      }
      if (grantType === "refresh_token") {
        await handleRefreshTokenGrant({ req, res, client, state, options, signingKey, now });
        return;
      }
      if (grantType === "client_credentials") {
        await handleClientCredentialsGrant({ req, res, client, state, options, signingKey, now });
        return;
      }
      throw oauthError("unsupported_grant_type", "unsupported grant_type", 400);
    } catch (error) {
      sendOauthError(res, error);
    }
  });

  router.post("/introspect", async (req, res) => {
    try {
      const client = await authenticateTokenClient(state, req, options.issuer);
      if (client.clientType !== "confidential") {
        throw oauthError("invalid_client", "introspection requires a confidential client", 401);
      }
      const token = bodyString(req, "token");
      const record = token ? state.tokens.get(token) : undefined;
      await audit(options.audit, "smart-introspection", req, {
        actorId: client.clientId,
        actorRole: "system",
        resourceType: "OAuth2Token",
        resourceId: record?.jti,
        actionReason: record?.active ? "active token introspected" : "inactive token introspected",
      });
      if (!record || !record.active || record.exp <= epochSeconds(now())) {
        res.type("application/json").json({ active: false });
        return;
      }
      res.type("application/json").json({
        active: true,
        scope: record.scope,
        client_id: record.clientId,
        username: record.username,
        exp: record.exp,
        iat: record.iat,
        sub: record.sub,
        aud: record.aud,
        iss: record.iss,
        jti: record.jti,
        ...record.launchContext,
      });
    } catch (error) {
      sendOauthError(res, error);
    }
  });

  router.post("/revoke", async (req, res) => {
    try {
      const client = await authenticateTokenClient(state, req, options.issuer);
      const token = bodyString(req, "token");
      if (token) {
        revokeTokenTree(state, token);
      }
      await audit(options.audit, "smart-token-revoke", req, {
        actorId: client.clientId,
        actorRole: "system",
        resourceType: "OAuth2Token",
        actionReason: "client token revocation request",
      });
      res.status(200).end();
    } catch (error) {
      sendOauthError(res, error);
    }
  });

  router.get("/.well-known/jwks.json", (_req, res) => {
    res.type("application/json").json({ keys: [signingKey.publicJwk] });
  });

  router.get("/cds-services", async (req, res) => {
    await audit(options.audit, "cds.discovery.served", req, {
      actorId: "cds-discovery",
      actorRole: "system",
      resourceType: "CDSHooksDiscovery",
      actionReason: "CDS Hooks discovery document fetched",
    });
    const externalServices = activeCdsServiceEndpoints(await cdsServiceRegistryStore.list());
    res.type("application/json").json({
      services: [
        ...OSOD_DEFAULT_CDS_SERVICES.map((service) => service.discovery),
        ...externalServices.map(cdsServiceDiscoveryEntry),
      ],
    });
  });

  router.post("/cds-services/register", async (req, res) => {
    try {
      const canonical = buildCanonicalCdsService(req.body);
      const stored = await cdsServiceRegistryStore.create(canonical.endpoint);
      await cdsServiceRegistryStore.createProvenance?.(
        buildCdsServiceProvenance({
          target: `Endpoint/${stored.id}`,
          activityCode: "register",
          recorded: now().toISOString(),
          actorId: req.header("X-OSOD-Actor-Id") ?? "cds-service-registry",
          actorRole: (req.header("X-OSOD-Role") as OsodActorRole | undefined) ?? "system",
        }),
      );
      await audit(options.audit, "cds.service.registered", req, {
        actorId: req.header("X-OSOD-Actor-Id") ?? "cds-service-registry",
        actorRole: (req.header("X-OSOD-Role") as OsodActorRole | undefined) ?? "system",
        resourceType: "Endpoint",
        resourceId: stored.id,
        actionReason: "External CDS service registered through local practice-admin review.",
      });
      res.status(201).json({ status: "registered", service: stored });
    } catch (error) {
      sendCdsRegistryError(res, error);
    }
  });

  router.post("/cds-services/:id/deactivate", async (req, res) => {
    try {
      const existing = await cdsServiceRegistryStore.read(req.params.id);
      if (!existing) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const deactivated = deactivateCdsServiceEndpoint(existing);
      const stored = cdsServiceRegistryStore.update
        ? await cdsServiceRegistryStore.update(deactivated)
        : deactivated;
      await cdsServiceRegistryStore.createProvenance?.(
        buildCdsServiceProvenance({
          target: `Endpoint/${stored.id}`,
          activityCode: req.body?.activity === "amend" ? "amend" : "nullify",
          recorded: now().toISOString(),
          actorId: req.header("X-OSOD-Actor-Id") ?? "cds-service-registry",
          actorRole: (req.header("X-OSOD-Role") as OsodActorRole | undefined) ?? "system",
        }),
      );
      await audit(options.audit, "cds.service.deactivated", req, {
        actorId: req.header("X-OSOD-Actor-Id") ?? "cds-service-registry",
        actorRole: (req.header("X-OSOD-Role") as OsodActorRole | undefined) ?? "system",
        resourceType: "Endpoint",
        resourceId: stored.id,
        actionReason: "External CDS service deactivated through local practice-admin workflow.",
      });
      res.json({ status: "deactivated", service: stored });
    } catch (error) {
      sendCdsRegistryError(res, error);
    }
  });

  router.post("/cds-services/:id/feedback", async (req, res) => {
    try {
      const result = await persistCdsFeedback({
        request: parseCdsFeedbackRequest(req.body),
        repository: cdsFeedbackRepository,
        serviceId: req.params.id,
        userId: req.header("X-OSOD-Actor-Id") ?? bodyString(req, "user_id") ?? "local-practitioner",
        patientId: bodyString(req, "patient_id"),
        encounterId: bodyString(req, "encounter_id"),
        now: now(),
      });
      for (const row of result.auditEvents) {
        await options.audit?.recordDenied(row);
      }
      res.status(201).json({ feedback: result.rows });
    } catch (error) {
      sendInvalidRequestError(res, error);
    }
  });

  router.post("/cds-services/:id", async (req, res) => {
    try {
      const services = [
        ...OSOD_DEFAULT_CDS_SERVICE_IDS,
        ...activeCdsServiceEndpoints(await cdsServiceRegistryStore.list()).map((service) => service.metadata.serviceId),
      ];
      if (!services.includes(req.params.id)) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const result = await dispatchCdsHook({
        input: cdsHookInputFromRequest(req, options, now()),
        externalServices: activeCdsServiceEndpoints(await cdsServiceRegistryStore.list()),
        fhirAuthorizationFor: async (service) => cdsFhirAuthorizationForService(state, signingKey, options, service.metadata.serviceId, service.metadata.scopeRequestCanonical, now()),
        now: now(),
      });
      for (const row of result.auditEvents) {
        await options.audit?.recordDenied(row);
      }
      res.type("application/json").json({ cards: result.cards });
    } catch (error) {
      sendInvalidRequestError(res, error);
    }
  });

  router.post(
    "/oauth2/register",
    createDynamicClientRegistrationHandler({
      state,
      store: smartAppRegistryStore,
      adapter: smartAppMedplumAdapter,
      audit: options.audit,
      now,
    }),
  );

  router.post("/sandbox/register", (_req, res) => {
    res.status(410).json({
      error: "deprecated_endpoint",
      error_description: "/sandbox/register was retired in v0.55b; use /oauth2/register.",
      registration_endpoint: `${options.issuer}/oauth2/register`,
    });
  });

  router.post("/admin/smart/scope-decisions/:id/approve", async (req, res) => {
    try {
      const decision = state.decisions.get(req.params.id);
      if (!decision) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const adminRole = roleFromRequest(req);
      const approved = approveStagedScopeDecision({
        decision,
        adminUserId: userFromRequest(req),
        adminRole,
        actorRole: req.header("X-OSOD-Actor-Role"),
        approvedScopes: Array.isArray(req.body?.approved_scopes) ? req.body.approved_scopes : undefined,
        now: now(),
      });
      state.decisions.set(approved.id, approved);
      state.touch(now());
      await audit(options.audit, approved.outcomeClass === "rejected" ? "smart-scope-rejected" : "smart-scope-approved", req, {
        actorId: approved.decidedBy,
        actorRole: adminRole,
        resourceType: "osod_smart_scope_decisions",
        resourceId: approved.id,
        actionOutcome: approved.outcomeClass === "rejected" ? "denied" : "granted",
        actionReason: "staged SMART scope review resolved by practice-admin",
      });
      if (approved.outcomeClass === "granted") {
        const pending = state.pendingAuthorizations.get(approved.id);
        if (pending) {
          const code = randomSecret();
          state.authorizationCodes.set(code, {
            code,
            clientId: pending.clientId,
            redirectUri: pending.redirectUri,
            state: pending.state,
            codeChallenge: pending.codeChallenge,
            userId: pending.userId,
            roleId: pending.roleId,
            scope: scopeText([...approved.effectiveScopes, ...pending.passthroughScopes]),
            passthroughScopes: pending.passthroughScopes,
            launchContext: pending.launchContext,
            expiresAt: now().getTime() + SMART_AUTH_CODE_TTL_SECONDS * 1000,
            issuedTokenJtis: [],
          });
          state.pendingAuthorizations.delete(approved.id);
          res.json({ ...approved, code, redirect_uri: pending.redirectUri });
          return;
        }
      }
      res.json(approved);
    } catch (error) {
      sendOauthError(res, error);
    }
  });

  return router;
}

export function loadSmartSigningKey(path = process.env.OSOD_SMART_SIGNING_KEY_PATH): SmartSigningKey {
  if (!path) {
    throw new Error("OSOD_SMART_SIGNING_KEY_PATH is required for the local SMART authorization server.");
  }
  const stat = statSync(path);
  if ((stat.mode & 0o777) !== 0o600) {
    throw new Error("OSOD_SMART_SIGNING_KEY_PATH must point to a private key with mode 0600.");
  }
  const privateKey = createPrivateKey(readFileSync(path));
  return smartSigningKeyFromPrivateKey(privateKey);
}

export function createEphemeralSmartSigningKey(): SmartSigningKey {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return smartSigningKeyFromPrivateKey(privateKey);
}

export function assertSmartAuthorizationNetworkSurface(urls: readonly string[]): void {
  for (const value of urls) {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || /^[a-z0-9_-]+$/.test(host)) {
      continue;
    }
    throw new Error(`Mandate 1 boundary: SMART authorization server network surface must stay local: ${value}`);
  }
}

export function smartSigningKeyFromPrivateKey(privateKey: KeyObject): SmartSigningKey {
  if (privateKey.asymmetricKeyType !== "rsa") {
    throw new Error("v0.55a SMART token signing supports RS256 private keys.");
  }
  const kid = createPublicKey(privateKey).export({ format: "jwk" }).n
    ? createHash("sha256").update(JSON.stringify(createPublicKey(privateKey).export({ format: "jwk" }))).digest("base64url")
    : randomUUID();
  const publicJwk = createPublicKey(privateKey).export({ format: "jwk" }) as JsonWebKey & {
    kid: string;
    alg: "RS256";
    use: "sig";
  };
  publicJwk.kid = kid;
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  return { kid, privateKey, publicJwk };
}

export async function approveSmartScopeDecisionForTest(input: {
  readonly state: SmartAuthorizationState;
  readonly decisionId: string;
  readonly adminUserId: string;
  readonly approvedScopes?: readonly string[];
}): Promise<SmartScopeDecisionRecord> {
  const decision = input.state.decisions.get(input.decisionId);
  if (!decision) {
    throw new Error(`SMART scope decision not found: ${input.decisionId}`);
  }
  const approved = approveStagedScopeDecision({
    decision,
    adminRole: "practice-admin",
    adminUserId: input.adminUserId,
    approvedScopes: input.approvedScopes,
  });
  input.state.decisions.set(approved.id, approved);
  return approved;
}

async function handleAuthorizationCodeGrant(input: {
  readonly req: Request;
  readonly res: Response;
  readonly client: SmartClientRegistration;
  readonly state: SmartAuthorizationState;
  readonly options: SmartAuthorizationServerOptions;
  readonly signingKey: SmartSigningKey;
  readonly now: () => Date;
}): Promise<void> {
  const code = bodyString(input.req, "code");
  const authCode = code ? input.state.authorizationCodes.get(code) : undefined;
  if (!authCode) {
    throw oauthError("invalid_grant", "authorization code not found", 400);
  }
  if (authCode.redeemedAt) {
    for (const jti of authCode.issuedTokenJtis) {
      revokeTokenJti(input.state, jti);
    }
    await audit(input.options.audit, "smart-token-revoke", input.req, {
      actorId: input.client.clientId,
      actorRole: "system",
      actionOutcome: "denied",
      actionReason: "authorization code reuse detected; issued tokens revoked",
    });
    throw oauthError("invalid_grant", "authorization code already redeemed", 400);
  }
  if (authCode.expiresAt <= input.now().getTime()) {
    throw oauthError("invalid_grant", "authorization code expired", 400);
  }
  if (authCode.clientId !== input.client.clientId) {
    throw oauthError("invalid_grant", "authorization code client mismatch", 400);
  }
  if (bodyString(input.req, "redirect_uri") !== authCode.redirectUri) {
    throw oauthError("invalid_grant", "redirect_uri mismatch", 400);
  }
  if (bodyString(input.req, "state") && bodyString(input.req, "state") !== authCode.state) {
    throw oauthError("invalid_request", "state mismatch", 400);
  }

  const pkce = verifyPkceS256({
    codeChallenge: authCode.codeChallenge,
    codeVerifier: bodyString(input.req, "code_verifier"),
  });
  if (pkce === "missing-verifier") {
    throw oauthError("invalid_request", "code_verifier is required", 400);
  }
  if (pkce === "mismatch") {
    throw oauthError("invalid_grant", "PKCE verifier mismatch", 400);
  }

  authCode.redeemedAt = input.now().getTime();
  const accessToken = issueToken({
    state: input.state,
    signingKey: input.signingKey,
    options: input.options,
    clientId: input.client.clientId,
    scope: authCode.scope,
    username: authCode.userId,
    sub: authCode.userId,
    launchContext: authCode.launchContext,
    tokenKind: "access_token",
    authorizationCode: authCode.code,
    now: input.now(),
  });
  const refreshToken = issueToken({
    state: input.state,
    signingKey: input.signingKey,
    options: input.options,
    clientId: input.client.clientId,
    scope: authCode.scope,
    username: authCode.userId,
    sub: authCode.userId,
    launchContext: authCode.launchContext,
    tokenKind: "refresh_token",
    authorizationCode: authCode.code,
    now: input.now(),
  });
  authCode.issuedTokenJtis.push(accessToken.jti, refreshToken.jti);
  input.state.touch(input.now());
  await audit(input.options.audit, "smart-token-issue", input.req, {
    actorId: authCode.userId,
    actorRole: authCode.roleId,
    resourceType: "OAuth2Token",
    resourceId: accessToken.jti,
    actionReason: `SMART token issued with scopes: ${authCode.scope}`,
  });
  input.res.json(tokenResponse(accessToken, refreshToken.token));
}

async function handleRefreshTokenGrant(input: {
  readonly req: Request;
  readonly res: Response;
  readonly client: SmartClientRegistration;
  readonly state: SmartAuthorizationState;
  readonly options: SmartAuthorizationServerOptions;
  readonly signingKey: SmartSigningKey;
  readonly now: () => Date;
}): Promise<void> {
  const refreshToken = bodyString(input.req, "refresh_token");
  const existing = refreshToken ? input.state.tokens.get(refreshToken) : undefined;
  if (!existing || existing.tokenKind !== "refresh_token" || !existing.active || existing.clientId !== input.client.clientId) {
    throw oauthError("invalid_grant", "refresh token invalid", 400);
  }
  const accessToken = issueToken({
    state: input.state,
    signingKey: input.signingKey,
    options: input.options,
    clientId: input.client.clientId,
    scope: existing.scope,
    username: existing.username,
    sub: existing.sub,
    launchContext: existing.launchContext,
    tokenKind: "access_token",
    now: input.now(),
  });
  await audit(input.options.audit, "smart-token-refresh", input.req, {
    actorId: existing.username,
    actorRole: "system",
    resourceType: "OAuth2Token",
    resourceId: accessToken.jti,
    actionReason: "refresh token redeemed for new access token",
  });
  input.res.json(tokenResponse(accessToken));
}

async function handleClientCredentialsGrant(input: {
  readonly req: Request;
  readonly res: Response;
  readonly client: SmartClientRegistration;
  readonly state: SmartAuthorizationState;
  readonly options: SmartAuthorizationServerOptions;
  readonly signingKey: SmartSigningKey;
  readonly now: () => Date;
}): Promise<void> {
  if (input.client.clientType !== "confidential") {
    throw oauthError("invalid_client", "client_credentials requires confidential client", 401);
  }
  const parsedScopes = parseSmartScopeList(bodyString(input.req, "scope"));
  if (parsedScopes.resourceScopes.some((scope) => scope.prefix !== "system")) {
    throw oauthError("invalid_scope", "client_credentials is system-scope only", 400);
  }
  const scope = scopeText(parsedScopes.resourceScopes.map((scope) => scope.raw));
  const accessToken = issueToken({
    state: input.state,
    signingKey: input.signingKey,
    options: input.options,
    clientId: input.client.clientId,
    scope,
    username: input.client.clientId,
    sub: input.client.clientId,
    launchContext: {},
    tokenKind: "access_token",
    now: input.now(),
  });
  await audit(input.options.audit, "smart-token-issue", input.req, {
    actorId: input.client.clientId,
    actorRole: "system",
    resourceType: "OAuth2Token",
    resourceId: accessToken.jti,
    actionReason: "SMART backend client credentials token issued",
  });
  input.res.json(tokenResponse(accessToken));
}

function issueToken(input: {
  readonly state: SmartAuthorizationState;
  readonly signingKey: SmartSigningKey;
  readonly options: SmartAuthorizationServerOptions;
  readonly clientId: string;
  readonly scope: string;
  readonly username: string;
  readonly sub: string;
  readonly launchContext: SmartLaunchContext;
  readonly tokenKind: "access_token" | "refresh_token";
  readonly authorizationCode?: string;
  readonly now: Date;
}): SmartTokenRecord {
  const iat = epochSeconds(input.now);
  const ttl =
    input.tokenKind === "access_token" ? SMART_ACCESS_TOKEN_TTL_SECONDS : SMART_REFRESH_TOKEN_TTL_SECONDS;
  const jti = randomUUID();
  const recordWithoutToken = {
    tokenKind: input.tokenKind,
    clientId: input.clientId,
    scope: input.scope,
    username: input.username,
    sub: input.sub,
    aud: input.options.fhirBaseUrl,
    iss: input.options.issuer,
    jti,
    iat,
    exp: iat + ttl,
    launchContext: input.launchContext,
    active: true,
    authorizationCode: input.authorizationCode,
  };
  const token =
    input.tokenKind === "access_token"
      ? signJwt(
          {
            client_id: input.clientId,
            scope: input.scope,
            username: input.username,
            sub: input.sub,
            aud: input.options.fhirBaseUrl,
            iss: input.options.issuer,
            jti,
            iat,
            exp: iat + ttl,
            ...input.launchContext,
          },
          input.signingKey,
        )
      : randomSecret();
  const record: SmartTokenRecord = { ...recordWithoutToken, token };
  input.state.tokens.set(token, record);
  input.state.touch(input.now);
  return record;
}

async function authenticateTokenClient(
  state: SmartAuthorizationState,
  req: Request,
  audience: string,
): Promise<SmartClientRegistration> {
  const basic = parseBasicAuth(req.header("authorization"));
  const assertion = bodyString(req, "client_assertion");
  const bodyClientId = bodyString(req, "client_id");
  const clientId = basic?.clientId ?? bodyClientId ?? clientIdFromAssertion(assertion);
  const client = await requireClient(state, clientId);

  if (client.tokenEndpointAuthMethod === "none") {
    if (!bodyClientId || bodyClientId !== client.clientId || basic || assertion) {
      throw oauthError("invalid_client", "public client identification failed", 401);
    }
    return client;
  }

  if (client.tokenEndpointAuthMethod === "client_secret_basic") {
    const secret = basic?.clientSecret ?? bodyString(req, "client_secret");
    if (!secret || !client.clientSecretHash || !secretMatches(secret, client.clientSecretHash)) {
      throw oauthError("invalid_client", "client secret authentication failed", 401);
    }
    return client;
  }

  if (client.tokenEndpointAuthMethod === "client_secret_post") {
    const secret = bodyString(req, "client_secret");
    if (!secret || !client.clientSecretHash || !secretMatches(secret, client.clientSecretHash)) {
      throw oauthError("invalid_client", "client secret authentication failed", 401);
    }
    return client;
  }

  if (!assertion || bodyString(req, "client_assertion_type") !== "urn:ietf:params:oauth:client-assertion-type:jwt-bearer") {
    throw oauthError("invalid_client", "private_key_jwt client_assertion is required", 401);
  }
  await verifyClientAssertion(state, client, assertion, audience);
  return client;
}

async function verifyClientAssertion(
  state: SmartAuthorizationState,
  client: SmartClientRegistration,
  assertion: string,
  audience: string,
): Promise<void> {
  if (!client.jwksUri) {
    throw oauthError("invalid_client", "client jwks_uri is missing", 401);
  }
  assertLocalNetworkUrl(client.jwksUri);
  const decoded = decodeJwt(assertion);
  if (decoded.payload.iss !== client.clientId || decoded.payload.sub !== client.clientId) {
    throw oauthError("invalid_client", "client assertion iss/sub mismatch", 401);
  }
  if (decoded.payload.aud !== audience) {
    throw oauthError("invalid_client", "client assertion audience mismatch", 401);
  }
  const nowSeconds = epochSeconds(new Date());
  if (typeof decoded.payload.exp !== "number" || decoded.payload.exp <= nowSeconds) {
    throw oauthError("invalid_client", "client assertion expired", 401);
  }
  if (typeof decoded.payload.iat !== "number" || decoded.payload.iat > nowSeconds + 60) {
    throw oauthError("invalid_client", "client assertion iat invalid", 401);
  }
  if (typeof decoded.payload.jti !== "string" || !decoded.payload.jti) {
    throw oauthError("invalid_client", "client assertion jti missing", 401);
  }
  const replayExpiry = state.replayJtis.get(decoded.payload.jti);
  if (replayExpiry && replayExpiry > Date.now()) {
    throw oauthError("invalid_client", "client assertion replay detected", 401);
  }
  const jwks = (await (await fetch(client.jwksUri)).json()) as { keys?: JsonWebKey[] };
  const jwk = jwks.keys?.find((candidate) => candidate.kid === decoded.header.kid) ?? jwks.keys?.[0];
  if (!jwk) {
    throw oauthError("invalid_client", "client JWKS is empty", 401);
  }
  const publicKey = createPublicKey({ key: jwk, format: "jwk" });
  if (!verify("RSA-SHA256", Buffer.from(decoded.signingInput), publicKey, decoded.signature)) {
    throw oauthError("invalid_client", "client assertion signature invalid", 401);
  }
  state.replayJtis.set(decoded.payload.jti, Date.now() + 5 * 60_000);
}

function signJwt(payload: Record<string, unknown>, signingKey: SmartSigningKey): string {
  const header = { alg: "RS256", typ: "JWT", kid: signingKey.kid };
  const signingInput = `${base64urlJson(header)}.${base64urlJson(payload)}`;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput), signingKey.privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

function decodeJwt(jwt: string): {
  readonly header: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
  readonly signingInput: string;
  readonly signature: Buffer;
} {
  const [header, payload, signature] = jwt.split(".");
  if (!header || !payload || !signature) {
    throw oauthError("invalid_client", "malformed client assertion", 401);
  }
  return {
    header: JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as Record<string, unknown>,
    payload: JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>,
    signingInput: `${header}.${payload}`,
    signature: Buffer.from(signature, "base64url"),
  };
}

function tokenResponse(accessToken: SmartTokenRecord, refreshToken?: string): Record<string, unknown> {
  return {
    access_token: accessToken.token,
    token_type: "Bearer",
    expires_in: Math.max(accessToken.exp - accessToken.iat, 0),
    scope: accessToken.scope,
    refresh_token: refreshToken,
    patient: accessToken.launchContext.patient,
    encounter: accessToken.launchContext.encounter,
    intent: accessToken.launchContext.intent,
    style: accessToken.launchContext.style,
    need_patient_banner: accessToken.launchContext.need_patient_banner,
    smart_style_url: accessToken.launchContext.smart_style_url,
  };
}

async function smartConfigurationSnapshot(
  options: SmartAuthorizationServerOptions,
  state: SmartAuthorizationState,
): Promise<SmartConfigurationSnapshot> {
  const base = options.issuer.replace(/\/$/, "");
  const clients = await state.clientsForDiscovery();
  const supportedScopes = [
    "launch",
    "launch/patient",
    "openid",
    "profile",
    "fhirUser",
    "online_access",
    "offline_access",
    ...new Set(clients.flatMap((client) => client.scopesAllowed)),
  ].sort();
  return {
    issuer: base,
    authorizationEndpoint: `${base}/authorize`,
    tokenEndpoint: `${base}/token`,
    introspectionEndpoint: `${base}/introspect`,
    revocationEndpoint: `${base}/revoke`,
    jwksUri: `${base}/.well-known/jwks.json`,
    scopesSupported: supportedScopes,
    responseTypesSupported: ["code"],
    codeChallengeMethodsSupported: ["S256"],
    registrationEndpoint: `${base}/oauth2/register`,
    cdsHooksEndpoint: `${base}/cds-services`,
    cdsCapabilities: OSOD_DEFAULT_CDS_SERVICE_IDS,
    capabilities: V055B_SMART_CAPABILITIES,
    tokenEndpointAuthMethodsSupported: [
      "none",
      "client_secret_basic",
      "client_secret_post",
      "private_key_jwt",
    ],
    grantTypesSupported: ["authorization_code", "client_credentials", "refresh_token"],
    updatedAt: state.updatedAt,
  };
}

function cdsHookInputFromRequest(
  req: Request,
  options: SmartAuthorizationServerOptions,
  now: Date,
): CdsHookEvaluationInput {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const hook = body.hook;
  if (hook !== "order-sign" && hook !== "order-select" && hook !== "encounter-discharge") {
    throw new Error("invalid_request: hook must be order-sign, order-select, or encounter-discharge");
  }
  const context = isRecord(body.context) ? body.context : {};
  const prefetch = isRecord(body.prefetch) ? body.prefetch : {};
  return {
    hook: hook as CdsHookId,
    hookInstance: typeof body.hookInstance === "string" ? body.hookInstance : randomUUID(),
    fhirServer: typeof body.fhirServer === "string" ? body.fhirServer : options.fhirBaseUrl,
    userId: req.header("X-OSOD-Actor-Id") ?? contextString(context, "userId") ?? "local-practitioner",
    patientId: contextString(context, "patientId"),
    encounterId: contextString(context, "encounterId"),
    context,
    prefetch,
    now,
  };
}

async function cdsFhirAuthorizationForService(
  state: SmartAuthorizationState,
  signingKey: SmartSigningKey,
  options: SmartAuthorizationServerOptions,
  serviceId: string,
  scope: string,
  now: Date,
): Promise<CdsFhirAuthorization | undefined> {
  const client = await state.getClient(serviceId);
  if (!client || client.clientType !== "confidential") {
    return undefined;
  }
  const token = issueToken({
    state,
    signingKey,
    options,
    clientId: client.clientId,
    scope,
    username: client.clientId,
    sub: client.clientId,
    launchContext: {},
    tokenKind: "access_token",
    now,
  });
  return {
    access_token: token.token,
    token_type: "Bearer",
    expires_in: Math.max(token.exp - token.iat, 0),
    scope: token.scope,
    subject: token.sub,
  };
}

function defaultSandboxClient(issuer: string): SmartClientRegistration {
  return {
    clientId: "osod-sandbox-public",
    name: "OSOD Sandbox Public Client",
    redirectUris: [`${issuer.replace(/\/$/, "")}/sandbox/callback`],
    clientType: "public",
    tokenEndpointAuthMethod: "none",
    scopesAllowed: [],
    isSandbox: true,
  };
}

async function requireClient(
  state: SmartAuthorizationState,
  clientId: string | undefined,
): Promise<SmartClientRegistration> {
  if (!clientId) {
    throw oauthError("invalid_client", "client_id is required", 401);
  }
  const client = await state.getClient(clientId);
  if (!client) {
    throw oauthError("invalid_client", "client not registered", 401);
  }
  return client;
}

function pgClient(row: Record<string, unknown>): SmartClientRegistration {
  return {
    clientId: String(row.client_id),
    name: String(row.name),
    redirectUris: stringArray(row.redirect_uris),
    clientType: String(row.client_type) as SmartClientType,
    tokenEndpointAuthMethod: String(row.token_endpoint_auth_method) as SmartTokenEndpointAuthMethod,
    jwksUri: optionalString(row.jwks_uri),
    clientSecretHash: optionalString(row.client_secret_hash),
    scopesAllowed: stringArray(row.scopes_allowed),
    isSandbox: Boolean(row.is_sandbox),
  };
}

function assertRedirectUri(client: SmartClientRegistration, redirectUri: string | undefined): asserts redirectUri is string {
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
    throw oauthError("invalid_request", "redirect_uri must exactly match registered URI", 400);
  }
}

function assertLocalNetworkUrl(value: string): void {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1" && !/^[a-z0-9_-]+$/.test(host)) {
    throw oauthError("invalid_client", "SMART client JWKS URI must be local to the practice stack", 401);
  }
}

function clientAuthClass(client: SmartClientRegistration): SmartClientAuthClass {
  if (client.clientType === "public") {
    return "public";
  }
  return client.tokenEndpointAuthMethod === "private_key_jwt" ? "confidential-asymmetric" : "confidential-symmetric";
}

function roleFromRequest(req: Request): PracticeRoleId {
  const raw = req.header("X-OSOD-Role") ?? stringQuery(req, "osod_role") ?? bodyString(req, "osod_role") ?? "clinician";
  if (PRACTICE_ROLE_IDS.includes(raw as PracticeRoleId)) {
    return raw as PracticeRoleId;
  }
  throw oauthError("access_denied", "unknown OSOD role", 403);
}

function userFromRequest(req: Request): string {
  return req.header("X-OSOD-Actor-Id") ?? stringQuery(req, "user_id") ?? bodyString(req, "user_id") ?? "local-practitioner";
}

function launchContextFromRequest(req: Request): SmartLaunchContext {
  return {
    patient: normalizeReference(stringQuery(req, "patient"), "Patient"),
    encounter: normalizeReference(stringQuery(req, "encounter"), "Encounter"),
    intent: stringQuery(req, "intent"),
    style: stringQuery(req, "style"),
    need_patient_banner: parseBoolean(stringQuery(req, "need_patient_banner")),
    smart_style_url: stringQuery(req, "smart_style_url"),
  };
}

function normalizeReference(value: string | undefined, resourceType: string): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.startsWith(`${resourceType}/`) ? value : `${resourceType}/${value}`;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value === "true";
}

function revokeTokenTree(state: SmartAuthorizationState, token: string): void {
  const record = state.tokens.get(token);
  if (!record) {
    return;
  }
  record.active = false;
  if (record.authorizationCode) {
    for (const candidate of state.tokens.values()) {
      if (candidate.authorizationCode === record.authorizationCode) {
        candidate.active = false;
      }
    }
  }
}

function revokeTokenJti(state: SmartAuthorizationState, jti: string): void {
  for (const record of state.tokens.values()) {
    if (record.jti === jti) {
      record.active = false;
    }
  }
}

function parseBasicAuth(header: string | undefined): { clientId: string; clientSecret: string } | undefined {
  if (!header?.startsWith("Basic ")) {
    return undefined;
  }
  const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) {
    return undefined;
  }
  return {
    clientId: decoded.slice(0, separator),
    clientSecret: decoded.slice(separator + 1),
  };
}

function clientIdFromAssertion(assertion: string | undefined): string | undefined {
  if (!assertion) {
    return undefined;
  }
  try {
    const decoded = decodeJwt(assertion);
    return typeof decoded.payload.iss === "string" ? decoded.payload.iss : undefined;
  } catch {
    return undefined;
  }
}

function secretHash(secret: string): string {
  return createHash("sha256").update(secret).digest("base64url");
}

function secretMatches(secret: string, expectedHash: string): boolean {
  const actual = Buffer.from(secretHash(secret));
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function randomSecret(): string {
  return randomBytes(32).toString("base64url");
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function epochSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

function stringQuery(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === "string" ? value : undefined;
}

function bodyString(req: Request, key: string): string | undefined {
  const body = req.body as Record<string, unknown> | undefined;
  const value = body?.[key];
  return typeof value === "string" ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return stringArray(parsed);
    } catch {
      return [];
    }
  }
  return [];
}

function scopeText(scopes: readonly string[]): string {
  return [...new Set(scopes.filter(Boolean))].sort().join(" ");
}

function oauthError(error: string, description: string, status: number): Error & {
  oauthError: string;
  status: number;
  description: string;
} {
  return Object.assign(new Error(description), { oauthError: error, status, description });
}

function sendOauthError(res: Response, error: unknown): void {
  if (error instanceof Error && "oauthError" in error) {
    const oauth = error as Error & { oauthError: string; status: number; description: string };
    res.status(oauth.status).json({ error: oauth.oauthError, error_description: oauth.description });
    return;
  }
  if (error instanceof Error && error.message.startsWith("invalid_request:")) {
    res.status(400).json({ error: "invalid_request", error_description: error.message.replace(/^invalid_request:\s*/, "") });
    return;
  }
  res.status(500).json({ error: "server_error" });
}

function sendCdsRegistryError(res: Response, error: unknown): void {
  if (error instanceof CdsServiceRegistryError) {
    res.status(error.status).json({ error: error.code, error_description: error.message });
    return;
  }
  sendInvalidRequestError(res, error);
}

function sendInvalidRequestError(res: Response, error: unknown): void {
  if (error instanceof Error && error.message.startsWith("invalid_request:")) {
    res.status(400).json({ error: "invalid_request", error_description: error.message.replace(/^invalid_request:\s*/, "") });
    return;
  }
  res.status(500).json({
    error: "server_error",
    error_description: error instanceof Error ? error.message : String(error),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contextString(context: Record<string, unknown>, key: string): string | undefined {
  const value = context[key];
  return typeof value === "string" && value ? value : undefined;
}

async function audit(
  recorder: FhirAuditRecorder | undefined,
  eventType: Parameters<typeof buildOsodAuditEventRow>[0]["eventType"],
  req: Request,
  input: {
    readonly actorId?: string;
    readonly actorRole?: OsodActorRole;
    readonly resourceType?: string;
    readonly resourceId?: string;
    readonly actionOutcome?: "granted" | "denied";
    readonly actionReason?: string;
  },
): Promise<void> {
  if (!recorder) {
    return;
  }
  await recorder.recordDenied(
    buildOsodAuditEventRow({
      eventType,
      actorId: input.actorId,
      actorRole: input.actorRole,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      actionOutcome: input.actionOutcome ?? "granted",
      actionReason: input.actionReason,
      ipAddress: req.ip,
      userAgent: req.header("user-agent"),
    }),
  );
}
