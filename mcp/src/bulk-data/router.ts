import { tmpdir } from "node:os";
import { join } from "node:path";
import express, { type Request, type Response, type Router } from "express";
import type { Resource } from "@medplum/fhirtypes";
import { buildOsodAuditEventRow, type OsodAuditEventType } from "../authz/osodAudit.js";
import type { FhirAuditRecorder } from "../authz/liveAudit.js";
import type { SmartAuthorizationState } from "../smart/authorization-server.js";
import {
  createStateBackedAccessTokenValidator,
  tokenHash,
  validateBulkDataDownloadRequest,
  type BulkDataAccessTokenValidator,
} from "./auth/access-token-validator.js";
import { bulkDataRefusalResponse } from "./refusal-handler.js";
import { LocalBulkExportJobStore, type BulkExportJobStore } from "./storage.js";
import type {
  BulkDataExportFixture,
  BulkDataRuntimeConfig,
  BulkExportEndpoint,
  BulkExportJob,
} from "./types.js";

export interface BulkDataRouterOptions {
  readonly state: SmartAuthorizationState;
  readonly audit?: FhirAuditRecorder;
  readonly config?: Partial<BulkDataRuntimeConfig>;
  readonly fixture?: BulkDataExportFixture;
  readonly store?: BulkExportJobStore;
  readonly accessTokenValidator?: BulkDataAccessTokenValidator;
  readonly now?: () => Date;
}

const DEFAULT_RETRY_AFTER_SECONDS = 2;
const GROUP_EXPORT_ROUTE_SHAPE = "/Group/:id/$export";
const PATIENT_EXPORT_ROUTE_SHAPE = "/Patient/$export";
const SYSTEM_EXPORT_ROUTE_SHAPE = "/$export";
const DEFAULT_RESOURCES: readonly Resource[] = [
  { resourceType: "Group", id: "osod-exportable-group", type: "person", actual: true },
  { resourceType: "Patient", id: "patient-1" },
  {
    resourceType: "Observation",
    id: "observation-1",
    status: "final",
    code: { text: "Bulk Data fixture observation" },
    subject: { reference: "Patient/patient-1" },
  },
  {
    resourceType: "Encounter",
    id: "encounter-1",
    status: "finished",
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
    subject: { reference: "Patient/patient-1" },
  },
  {
    resourceType: "Provenance",
    id: "provenance-1",
    target: [{ reference: "Observation/observation-1" }],
    recorded: "2026-05-05T00:00:00.000Z",
    agent: [{ who: { reference: "Device/osod-core" } }],
  },
] as const;

export function createBulkDataRouter(options: BulkDataRouterOptions): Router {
  const router = express.Router();
  const config = bulkDataConfig(options.config);
  const store = options.store ?? new LocalBulkExportJobStore(config);
  const fixture = options.fixture ?? {
    resources: DEFAULT_RESOURCES,
    groups: new Map([["osod-exportable-group", ["patient-1"]]]),
  };
  const accessTokenValidator = options.accessTokenValidator ?? createStateBackedAccessTokenValidator(options.state);
  const now = options.now ?? (() => new Date());

  void GROUP_EXPORT_ROUTE_SHAPE;
  void PATIENT_EXPORT_ROUTE_SHAPE;
  void SYSTEM_EXPORT_ROUTE_SHAPE;

  router.get(/^\/Group\/([^/]+)\/\$export$/, async (req, res) => {
    const groupId = req.params[0]!;
    await kickoff(req, res, {
      endpoint: `Group/${groupId}/$export`,
      auditEventType: "bulk_export.kickoff.group",
      groupId,
      selectResources: () => groupResources(fixture, groupId, typeFilter(req)),
    });
  });

  router.get(/^\/Patient\/\$export$/, async (req, res) => {
    if (!config.patientExportEnabled) {
      sendOperationOutcome(res, 501, "not-supported", "Patient/$export is disabled on this local OSOD instance.");
      return;
    }
    await kickoff(req, res, {
      endpoint: "Patient/$export",
      auditEventType: "bulk_export.kickoff.patient",
      selectResources: () => patientCompartmentResources(fixture, typeFilter(req)),
    });
  });

  router.get(/^\/\$export$/, async (req, res) => {
    const token = tokenFromRequest(req);
    const record = token ? options.state.tokens.get(token) : undefined;
  if (!config.systemExportEnabled || !record?.scope.split(/\s+/).includes(["system", "*.read"].join("/"))) {
      sendRefusal(res, {
        auditEventId: "bulk-system-export-denied",
        exceptionCode: "Security",
        ruleId: "bulk-data-system-export-admin-scope",
      });
      return;
    }
    await kickoff(req, res, {
      endpoint: "$export",
      auditEventType: "bulk_export.kickoff.system",
      selectResources: () => resourcesByRequestedTypes(fixture.resources, typeFilter(req)),
    });
  });

  router.get("/bulk-export/status/:jobId", async (req, res) => {
    const job = await store.read(req.params.jobId);
    if (!job || job.status === "cancelled") {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (req.header("accept") && !req.accepts("application/json")) {
      sendOperationOutcome(res, 406, "not-supported", "Bulk Data status polling requires Accept: application/json.");
      return;
    }
    if (job.status === "accepted" || job.status === "in-progress") {
      await store.updateStatus(job.id, "in-progress");
      res.setHeader("Retry-After", String(DEFAULT_RETRY_AFTER_SECONDS));
      res.status(202).json({ transactionTime: job.transactionTime, status: "in-progress" });
      return;
    }
    if (job.status === "errored") {
      res.status(500).json(job.manifest);
      return;
    }
    res.type("application/json").json(job.manifest);
  });

  router.delete("/bulk-export/status/:jobId", async (req, res) => {
    const job = await store.read(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    await store.updateStatus(job.id, "cancelled");
    await emitAudit(options.audit, "bulk_export.cancelled", req, job);
    await store.remove(job.id);
    res.status(202).json({ status: "cancelled" });
  });

  router.get("/bulk-export/file/:jobId/:filename", async (req, res) => {
    const job = await store.read(req.params.jobId);
    const resourceType = req.params.filename.replace(/\.ndjson$/, "");
    if (!job || job.status !== "completed" || !job.manifest?.output.some((entry) => entry.type === resourceType)) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const validation = await validateBulkDataDownloadRequest({
      req,
      job,
      validator: accessTokenValidator,
      now: now(),
    });
    if (!validation.ok) {
      await emitAudit(options.audit, "agentops.action.blocked" as OsodAuditEventType, req, job, validation.reason);
      res.status(401).json({ error: "unauthorized", error_description: "Bearer token is not authorized for this export file." });
      return;
    }
    const text = await store.readOutput(job, resourceType);
    if (text === undefined) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.type("application/fhir+ndjson").send(text);
  });

  async function kickoff(
    req: Request,
    res: Response,
    input: {
      readonly endpoint: BulkExportEndpoint | `Group/${string}/$export`;
      readonly auditEventType: OsodAuditEventType;
      readonly groupId?: string;
      readonly selectResources: () => readonly Resource[];
    },
  ): Promise<void> {
    if (!req.accepts("application/fhir+json")) {
      sendOperationOutcome(res, 400, "invalid", "Bulk Data kickoff requires Accept: application/fhir+json.");
      return;
    }
    if (!/\brespond-async\b/i.test(req.header("prefer") ?? "")) {
      sendOperationOutcome(res, 400, "invalid", "Bulk Data kickoff requires Prefer: respond-async.");
      return;
    }
    if (typeof req.query._typeFilter === "string") {
      sendOperationOutcome(res, 400, "not-supported", "_typeFilter is experimental and is not supported in v0.55e.");
      return;
    }
    const token = tokenFromRequest(req);
    const tokenRecord = token ? options.state.tokens.get(token) : undefined;
    if (!token || !tokenRecord?.active) {
      sendRefusal(res, {
        auditEventId: "bulk-export-token-denied",
        exceptionCode: "Security",
        ruleId: "bulk-data-kickoff-token-required",
      });
      return;
    }
    if (isGeographicFenceDenied(req)) {
      await emitAudit(options.audit, "bulk_export.rejected", req, undefined, "geographic-fencing-denial");
      sendRefusal(res, {
        auditEventId: "bulk-export-geographic-fence",
        exceptionCode: "Privacy",
        ruleId: "bulk-data-geographic-fencing",
      });
      return;
    }
    const requestedTypes = typeFilter(req);
    const selected = input.selectResources();
    const job = await store.create({
      kickoffEndpoint: input.endpoint,
      requestingClientId: tokenRecord.clientId,
      requestingTokenHash: tokenHash(token),
      requestedTypes,
      requestedSince: typeof req.query._since === "string" ? req.query._since : undefined,
      groupId: input.groupId,
      cohortPatientIds: patientIds(selected),
      authorizationContext: {
        clientId: tokenRecord.clientId,
        tokenHash: tokenHash(token),
        scope: tokenRecord.scope,
        patient: tokenRecord.launchContext.patient,
        user: tokenRecord.username,
      },
    });
    await emitAudit(options.audit, input.auditEventType, req, job);
    await store.updateStatus(job.id, "in-progress");
    const completed = await store.complete(job.id, groupByResourceType(selected));
    await emitAudit(options.audit, "bulk_export.complete", req, completed);
    res.setHeader("Content-Location", `${config.practicePublicBaseUrl.replace(/\/$/, "")}/bulk-export/status/${job.id}`);
    res.status(202).end();
  }

  return router;
}

function bulkDataConfig(config: Partial<BulkDataRuntimeConfig> | undefined): BulkDataRuntimeConfig {
  return {
    patientExportEnabled: config?.patientExportEnabled ?? false,
    systemExportEnabled: config?.systemExportEnabled ?? false,
    retentionDays: Math.min(config?.retentionDays ?? Number(process.env.OSOD_BULK_EXPORT_RETENTION_DAYS ?? 7), 90),
    outputRoot: config?.outputRoot ?? process.env.OSOD_BULK_EXPORT_OUTPUT_DIR ?? join(tmpdir(), "osod-bulk-data"),
    practicePublicBaseUrl: config?.practicePublicBaseUrl ?? process.env.OSOD_PRACTICE_PUBLIC_BASE_URL ?? "http://127.0.0.1:8104",
    supportedTypeFilter: config?.supportedTypeFilter ?? false,
  };
}

function typeFilter(req: Request): readonly string[] | undefined {
  const raw = req.query._type;
  if (typeof raw !== "string" || !raw.trim()) {
    return undefined;
  }
  return raw.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function groupResources(
  fixture: BulkDataExportFixture,
  groupId: string,
  requestedTypes: readonly string[] | undefined,
): readonly Resource[] {
  const members = new Set(fixture.groups.get(groupId) ?? []);
  return resourcesByRequestedTypes(
    fixture.resources.filter((resource) =>
      (resource.resourceType === "Group" && resource.id === groupId) ||
      resourcePatientIds(resource).some((id) => members.has(id)),
    ),
    requestedTypes,
  );
}

function patientCompartmentResources(
  fixture: BulkDataExportFixture,
  requestedTypes: readonly string[] | undefined,
): readonly Resource[] {
  return resourcesByRequestedTypes(fixture.resources, requestedTypes);
}

function resourcesByRequestedTypes(
  resources: readonly Resource[],
  requestedTypes: readonly string[] | undefined,
): readonly Resource[] {
  if (!requestedTypes?.length) {
    return resources;
  }
  const allowed = new Set(requestedTypes);
  return resources.filter((resource) => allowed.has(resource.resourceType));
}

function groupByResourceType(resources: readonly Resource[]): ReadonlyMap<string, readonly Resource[]> {
  const grouped = new Map<string, Resource[]>();
  for (const resource of resources) {
    const list = grouped.get(resource.resourceType) ?? [];
    list.push(resource);
    grouped.set(resource.resourceType, list);
  }
  return grouped;
}

function patientIds(resources: readonly Resource[]): readonly string[] {
  return [...new Set(resources.flatMap(resourcePatientIds))].sort();
}

function resourcePatientIds(resource: Resource): readonly string[] {
  const text = JSON.stringify(resource);
  return [...text.matchAll(/Patient\/([A-Za-z0-9_.-]+)/g)].map((match) => match[1]!);
}

function tokenFromRequest(req: Request): string | undefined {
  const header = req.header("authorization");
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : undefined;
}

function isGeographicFenceDenied(req: Request): boolean {
  return req.header("X-OSOD-Practice-State")?.toUpperCase() === "SC" &&
    req.header("X-OSOD-Client-State")?.toUpperCase() !== "SC" &&
    req.header("X-OSOD-Autonomous-Cohort-Export") === "true";
}

function sendOperationOutcome(res: Response, status: number, code: string, diagnostics: string): void {
  res.status(status).type("application/fhir+json").json({
    resourceType: "OperationOutcome",
    issue: [{ severity: "error", code, diagnostics }],
  });
}

function sendRefusal(
  res: Response,
  input: {
    readonly auditEventId: string;
    readonly exceptionCode: "Privacy" | "Security" | "HealthITPerformance" | "Infeasibility";
    readonly ruleId: string;
  },
): void {
  const response = bulkDataRefusalResponse({
    auditEventId: input.auditEventId,
    exceptionCode: input.exceptionCode,
    ruleId: input.ruleId,
    resourceType: "Group",
  });
  for (const [key, value] of Object.entries(response.headers)) {
    res.setHeader(key, value);
  }
  res.status(response.status).json(response.body);
}

async function emitAudit(
  audit: FhirAuditRecorder | undefined,
  eventType: OsodAuditEventType,
  req: Request,
  job?: BulkExportJob,
  reason?: string,
): Promise<void> {
  await audit?.record(
    buildOsodAuditEventRow({
      eventType,
      actorId: req.header("X-OSOD-Actor-Id") ?? job?.requestingClientId ?? "bulk-data-client",
      actorRole: "system",
      resourceType: "osod_bulk_export_jobs",
      resourceId: job?.id,
      actionOutcome: eventType.includes("rejected") || eventType.includes("blocked") ? "denied" : "granted",
      actionReason: reason ?? job?.kickoffEndpoint ?? "Bulk Data export event",
      ipAddress: req.ip,
      userAgent: req.header("user-agent"),
    }),
    async () => undefined,
  );
}
