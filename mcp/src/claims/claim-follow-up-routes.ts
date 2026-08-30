import type { Application, Request, Response } from "express";
import type { Claim, CodeSystem } from "@medplum/fhirtypes";
import type { MedplumClient } from "../fhir-client.js";
import type { OdosActorRole } from "../authz/odosAudit.js";
import { assertBusinessActionAllowed, PRACTICE_ROLE_IDS, type PracticeRoleId } from "../authz/roles.js";
import { searchAll } from "../fhir-search.js";
import { loadClaimReadModelTruth } from "./claim-read-model-projector.js";
import type { ClaimReadModelStore } from "./claim-read-model-store.js";
import {
  claimProjectionUnavailableBody,
  type ClaimProjectionStatus,
  type ClaimReadModelProjectionHealthTracker,
} from "./claim-read-model-health.js";
import {
  buildClaimTouchTransaction,
  CLAIM_TOUCH_ACTIONS,
  ClaimTouchPrincipalError,
  claimTouchIdempotencyFingerprint,
  claimTouchRequestFingerprint,
  claimTouchState,
  type ClaimReason,
  type ClaimTouchAction,
} from "./claim-touch-ledger.js";

export const CLAIM_REASON_SYSTEM = "https://odos2020.com/fhir/CodeSystem/claim-follow-up-reason";
export const DEFAULT_CLAIM_AGING_THRESHOLDS = [30, 60, 90] as const;

export function claimAgingThresholdsFromEnv(
  value = process.env.ODOS_CLAIM_AGING_THRESHOLDS,
): readonly [number, number, number] {
  if (!value?.trim()) return DEFAULT_CLAIM_AGING_THRESHOLDS;
  const parsed = value.split(",").map((part) => Number(part.trim()));
  if (
    parsed.length !== 3
    || parsed.some((threshold) => !Number.isInteger(threshold) || threshold <= 0)
    || !(parsed[0] < parsed[1] && parsed[1] < parsed[2])
  ) throw new Error("ODOS_CLAIM_AGING_THRESHOLDS must contain three ascending positive whole days.");
  return parsed as [number, number, number];
}

type FollowUpFhir = Pick<MedplumClient, "baseUrl" | "read" | "search" | "searchUrl" | "create" | "update" | "executeTransaction">;

export interface ClaimFollowUpStaff {
  staffReference: string;
  actorRole: OdosActorRole;
  fhir: FollowUpFhir;
}

export interface ClaimFollowUpRouteDeps {
  authenticateService(): Promise<void>;
  authenticate(authHeader: string | undefined): Promise<ClaimFollowUpStaff | null>;
  serviceFhir: FollowUpFhir;
  store: ClaimReadModelStore;
  projectionHealth: ClaimReadModelProjectionHealthTracker;
  now?: () => string;
  thresholds?: readonly [number, number, number];
}

export function registerClaimFollowUpRoutes(
  app: Pick<Application, "get" | "post">,
  deps: ClaimFollowUpRouteDeps,
): void {
  app.post("/claims/:claimId/touches", (req, res) => withStaff(req, res, deps, async (staff) => {
    const body = record(req.body);
    const action = typeof body.action === "string" && CLAIM_TOUCH_ACTIONS.includes(body.action as ClaimTouchAction)
      ? body.action as ClaimTouchAction
      : undefined;
    if (!action) throw new ClaimFollowUpValidationError("action must be note, resubmission, contact, status-reason, or resolution.");
    const claimId = stringParam(req.params.claimId);
    const idempotencyKey = requiredIdempotencyKey(body.idempotencyKey);
    const detail = typeof body.detail === "string" ? body.detail : undefined;
    const reasonCode = typeof body.reasonCode === "string" ? body.reasonCode.trim() : undefined;
    const fingerprint = claimTouchRequestFingerprint({
      claimReference: `Claim/${claimId}`,
      actorReference: staff.staffReference,
      actorRole: staff.actorRole,
      action,
      ...(detail !== undefined ? { detail } : {}),
      ...(reasonCode ? { reasonCode } : {}),
    });
    let committedClaim = await staff.fhir.read<Claim>("Claim", claimId);
    const existingFingerprint = claimTouchIdempotencyFingerprint(committedClaim, idempotencyKey);
    assertMatchingIdempotencyKey(existingFingerprint, fingerprint);
    let idempotentReplay = existingFingerprint !== undefined;
    if (!idempotentReplay) {
      const reason = reasonCode ? await findReason(deps.serviceFhir, reasonCode) : undefined;
      const transaction = buildClaimTouchTransaction({
        claim: committedClaim,
        principal: { kind: "human", actorReference: staff.staffReference, actorRole: staff.actorRole },
        action,
        at: now(deps),
        ...(detail !== undefined ? { detail } : {}),
        ...(reason ? { reason } : {}),
        idempotency: { key: idempotencyKey, fingerprint },
      });
      const updatedClaim = transaction.entry?.find((entry) => entry.resource?.resourceType === "Claim")?.resource;
      if (updatedClaim?.resourceType !== "Claim") throw new Error("Claim touch transaction did not contain its Claim update.");
      try {
        await staff.fhir.executeTransaction(transaction);
        committedClaim = updatedClaim;
      } catch (error) {
        const concurrentClaim = await readAfterFailedTouch(staff, claimId, error);
        const concurrentFingerprint = claimTouchIdempotencyFingerprint(concurrentClaim, idempotencyKey);
        if (concurrentFingerprint !== fingerprint) throw error;
        committedClaim = concurrentClaim;
        idempotentReplay = true;
      }
    }
    const readModelSynced = await syncReadModelClaim(staff, deps, claimId);
    const touch = claimTouchState(committedClaim);
    res.status(201).json({
      claimReference: `Claim/${claimId}`,
      touchCount: touch.touchCount,
      lastTouchedAt: touch.lastTouchedAt,
      lastTouchedBy: touch.lastTouchedBy,
      readModelSynced,
      idempotentReplay,
    });
  }));

  app.get("/claims/follow-up-worklist", (req, res) => withStaff(req, res, deps, async () => {
    const at = now(deps);
    const projection = requireHealthyProjection(res, deps, at);
    if (!projection) return;
    res.json({ groups: await deps.store.worklist({ at, thresholds: thresholds(deps) }), projection });
  }));
  app.get("/claims/metrics/never-paid-untouched", (req, res) => withStaff(req, res, deps, async () => {
    const projection = requireHealthyProjection(res, deps, now(deps));
    if (!projection) return;
    res.json({ items: await deps.store.neverPaidUntouchedMetric(), projection });
  }));
  app.post("/claims/read-model/rebuild", (req, res) => withStaff(req, res, deps, async (staff) => {
    const at = now(deps);
    deps.projectionHealth.begin(at);
    try {
      const truth = await loadClaimReadModelTruth(staff.fhir, at);
      await deps.store.rebuild(truth, at);
      deps.projectionHealth.succeed(at);
      res.json({ rebuilt: truth.length, projectedAt: at, projection: deps.projectionHealth.status(at) });
    } catch (error) {
      deps.projectionHealth.fail(at);
      throw error;
    }
  }));
  app.get("/claims/read-model/reconcile", (req, res) => withStaff(req, res, deps, async (staff) => {
    const truth = await loadClaimReadModelTruth(staff.fhir, now(deps));
    const result = await deps.store.reconcile(truth);
    res.status(result.inSync ? 200 : 409).json(result);
  }));
  app.get("/claims/reasons", (req, res) => withStaff(req, res, deps, async () => {
    res.json({ items: reasons(await reasonCodeSystem(deps.serviceFhir)) });
  }));
  app.post("/claims/reasons", (req, res) => withStaff(req, res, deps, async () => {
    const body = record(req.body);
    const code = requiredString(body.code, "code");
    const display = requiredString(body.display, "display");
    const resolutionPath = requiredString(body.resolutionPath, "resolutionPath");
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(code)) throw new ClaimFollowUpValidationError("code must be lowercase kebab-case.");
    const catalog = await reasonCodeSystem(deps.serviceFhir);
    if (catalog.concept?.some((concept) => concept.code === code)) throw new ClaimFollowUpValidationError(`Reason ${code} already exists.`);
    const updated = await deps.serviceFhir.update("CodeSystem", requiredId(catalog), {
      ...catalog,
      concept: [...(catalog.concept ?? []), { code, display, property: [{ code: "resolution-path", valueString: resolutionPath }] }],
    });
    res.status(201).json(reasons(updated).find((reason) => reason.code === code));
  }));
}

function requireHealthyProjection(
  res: Response,
  deps: ClaimFollowUpRouteDeps,
  at: string,
): ClaimProjectionStatus | undefined {
  const projection = deps.projectionHealth.status(at);
  const unavailable = claimProjectionUnavailableBody(projection);
  if (!unavailable) return projection;
  res.status(503).json(unavailable);
  return undefined;
}

async function withStaff(
  req: Request,
  res: Response,
  deps: ClaimFollowUpRouteDeps,
  action: (staff: ClaimFollowUpStaff) => Promise<void>,
): Promise<void> {
  try {
    await deps.authenticateService();
    const staff = await deps.authenticate(req.header("authorization"));
    if (!staff) {
      res.status(401).json({ error: "Authentication required to manage claims." });
      return;
    }
    if (!staffMayManageClaims(staff.actorRole)) {
      res.status(403).json({ error: "claims.manage role required" });
      return;
    }
    await action(staff);
  } catch (error) {
    if (res.headersSent) return;
    if (error instanceof ClaimFollowUpValidationError || error instanceof ClaimTouchPrincipalError) {
      res.status(400).json({ error: error.message });
    } else if (error instanceof ClaimFollowUpConflictError) {
      res.status(409).json({ error: error.message });
    } else {
      console.error("odos-mcp: claim follow-up route failed:", error);
      res.status(500).json({ error: "Claim follow-up route failed." });
    }
  }
}

function staffMayManageClaims(actorRole: OdosActorRole): boolean {
  if (!PRACTICE_ROLE_IDS.includes(actorRole as PracticeRoleId)) return false;
  try {
    assertBusinessActionAllowed(actorRole as PracticeRoleId, "claims.manage");
    return true;
  } catch {
    return false;
  }
}

async function reasonCodeSystem(fhir: FollowUpFhir): Promise<CodeSystem> {
  const matches = await searchAll<CodeSystem>(fhir, "CodeSystem", { url: CLAIM_REASON_SYSTEM, _count: "2" }, { maxRows: 2 });
  if (matches.length !== 1) throw new Error(`Expected one Claim follow-up reason CodeSystem; found ${matches.length}.`);
  return matches[0];
}

async function findReason(fhir: FollowUpFhir, code: string): Promise<ClaimReason> {
  const match = reasons(await reasonCodeSystem(fhir)).find((reason) => reason.code === code);
  if (!match) throw new ClaimFollowUpValidationError(`Unknown typed claim reason: ${code}.`);
  return match;
}

function reasons(catalog: CodeSystem): ClaimReason[] {
  return (catalog.concept ?? []).map((concept) => ({
    system: catalog.url ?? CLAIM_REASON_SYSTEM,
    code: concept.code,
    display: concept.display ?? concept.code,
    resolutionPath: concept.property?.find((property) => property.code === "resolution-path")?.valueString ?? "",
  }));
}

function thresholds(deps: ClaimFollowUpRouteDeps): readonly [number, number, number] {
  return deps.thresholds ?? DEFAULT_CLAIM_AGING_THRESHOLDS;
}

function now(deps: ClaimFollowUpRouteDeps): string {
  return deps.now?.() ?? new Date().toISOString();
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ClaimFollowUpValidationError(`${name} is required.`);
  return value.trim();
}

function requiredIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{8,128}$/.test(value)) {
    throw new ClaimFollowUpValidationError("idempotencyKey must be 8-128 letters, numbers, dots, underscores, or hyphens.");
  }
  return value;
}

function assertMatchingIdempotencyKey(existing: string | undefined, requested: string): void {
  if (existing !== undefined && existing !== requested) {
    throw new ClaimFollowUpConflictError("idempotencyKey was already used for different claim touch content.");
  }
}

async function readAfterFailedTouch(
  staff: ClaimFollowUpStaff,
  claimId: string,
  originalError: unknown,
): Promise<Claim> {
  try {
    return await staff.fhir.read<Claim>("Claim", claimId);
  } catch {
    throw originalError;
  }
}

async function syncReadModelClaim(
  staff: ClaimFollowUpStaff,
  deps: ClaimFollowUpRouteDeps,
  claimId: string,
): Promise<boolean> {
  const projectedAt = now(deps);
  try {
    const truth = await loadClaimReadModelTruth(staff.fhir, projectedAt);
    const row = truth.find((candidate) => candidate.claimReference === `Claim/${claimId}`);
    if (!row) throw new Error(`FHIR rebuild did not project Claim/${claimId}.`);
    await deps.store.upsert(row, projectedAt);
    return true;
  } catch {
    deps.projectionHealth.fail(projectedAt);
    return false;
  }
}

function stringParam(value: string | string[] | undefined): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9.-]{1,64}$/.test(value)) throw new ClaimFollowUpValidationError("Claim id is invalid.");
  return value;
}

function requiredId(resource: CodeSystem): string {
  if (!resource.id) throw new Error("Claim reason CodeSystem must be persisted before update.");
  return resource.id;
}

class ClaimFollowUpValidationError extends Error {}
class ClaimFollowUpConflictError extends Error {}
