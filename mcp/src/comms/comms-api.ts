import type { Communication } from "@medplum/fhirtypes";
import { randomUUID } from "node:crypto";
import type { Application, Request, Response } from "express";
import { buildOdosAuditEventRow } from "../authz/odosAudit.js";
import {
  PRACTICE_ROLE_IDS,
  assertBusinessActionAllowed,
  resolveBusinessActionRole,
  type BusinessAction,
  type PracticeRoleId,
} from "../authz/roles.js";
import type { FhirAuditRecorder } from "../fhir-client.js";
import { searchBounded } from "../fhir-search.js";
import type { AuthenticatedStaff } from "../payments/payment-charge-handler.js";
import type { CommsDispatch, CommsDispatchFhir } from "./comms-config.js";
import type { CommsProvider, ConversationSummary } from "./comms-provider.js";
import {
  ODOS_COMMS_CATEGORY_SYSTEM,
  ODOS_PATIENT_CALL_CATEGORY,
  ODOS_TWILIO_CALL_IDENTIFIER_SYSTEM,
  ODOS_TWILIO_RECORDING_IDENTIFIER_SYSTEM,
  persistStaffSentSms,
  reserveStaffSmsSend,
} from "./comms-persistence.js";

type CommsStaff = Omit<AuthenticatedStaff, "actorRole" | "roles"> & {
  actorRole: PracticeRoleId;
  roles: readonly PracticeRoleId[];
};

export interface CommsApiRouteDeps {
  authenticateService(): Promise<void>;
  authenticate(authHeader: string | undefined): Promise<CommsStaff | null>;
  dispatch: CommsDispatch;
  audit: FhirAuditRecorder;
  now?: () => string;
}

class CommsApiValidationError extends Error {}
class CommsApiCapabilityError extends Error {}
class CommsApiNotFoundError extends Error {}

type CommsApiResult =
  | { status: number; body: unknown }
  | { status: number; media: { contentType: string; bytes: Uint8Array } };

const MAX_CALL_HISTORY_WINDOW = 1_000;

export function registerCommsApiRoutes(
  app: Pick<Application, "get" | "post">,
  deps: CommsApiRouteDeps,
): void {
  app.get("/communications/conversations", async (req, res) => withStaff(
    req,
    res,
    deps,
    "communications.read",
    "Communication",
    "communications-conversation-list",
    patientReferenceForAudit(req),
    async (staff) => {
      const patientReference = patientReferenceFromQuery(req);
      const limit = numberFromQuery(req, "limit", 1, 100);
      const provider = adapter(deps, providerFromQuery(req), staff.fhir);
      if (!provider.listConversations) throw new CommsApiCapabilityError("Conversation history is not enabled for this communications provider.");
      const includeContent = hasBusinessAction(staff.actorRole, "communications.content.read");
      const conversations = await provider.listConversations({
        ...(patientReference ? { patientReference } : {}),
        ...(limit ? { limit } : {}),
        includeContent,
      });
      return { status: 200, body: { conversations: includeContent ? conversations : redactConversationBodies(conversations) } };
    },
  ));

  app.post("/communications/messages", async (req, res) => withStaff(
    req,
    res,
    deps,
    "communications.send",
    "Communication",
    "communications-sms-send",
    patientReferenceFromBody(req.body),
    async (staff) => {
      const body = record(req.body);
      const patientReference = requiredPatientReference(body.patientReference);
      const text = requiredText(body.body, "SMS body", 1_600);
      const idempotencyKey = requiredIdempotencyKey(req, body);
      const provider = adapter(deps, providerFromBody(body), staff.fhir);
      if (!provider.sendSms) throw new CommsApiCapabilityError("SMS is not enabled for this communications provider.");
      const reservation = await reserveStaffSmsSend(staff.fhir, {
        idempotencyKey,
        claimId: randomUUID(),
        patientReference,
        senderReference: staff.staffReference,
        body: text,
      });
      if (reservation.state === "conflict") {
        throw new CommsApiCapabilityError("SMS idempotency key was already used for a different request.");
      }
      if (reservation.state === "pending") {
        throw new CommsApiCapabilityError("SMS outcome is pending reconciliation; do not resend with a new key.");
      }
      if (reservation.state === "sent") {
        return {
          status: 200,
          body: { outcome: "sent", providerMessageId: reservation.providerMessageId },
        };
      }
      const result = await provider.sendSms({
        patientReference,
        body: text,
        campaignType: "staff-initiated",
        messageId: idempotencyKey,
        suppression: {},
      });
      if (result.outcome === "sent") {
        await persistStaffSentSms(staff.fhir, {
          communication: reservation.communication,
          idempotencyKey,
          messageSid: result.providerMessageId,
        }, { now: () => deps.now?.() ?? new Date().toISOString() });
      }
      return { status: 200, body: result };
    },
  ));

  app.get("/communications/calls", async (req, res) => withStaff(
    req,
    res,
    deps,
    "communications.read",
    "Communication",
    "communications-call-list",
    undefined,
    async (staff) => {
      const provider = adapter(deps, providerFromQuery(req), staff.fhir);
      if (!provider.listCalls) throw new CommsApiCapabilityError("Call history is not enabled for this communications provider.");
      const limit = numberFromQuery(req, "limit", 1, MAX_CALL_HISTORY_WINDOW) ?? 50;
      const visibleIds = await visibleCallIds(staff.fhir);
      if (visibleIds.size === 0) return { status: 200, body: { calls: [] } };
      const calls = await provider.listCalls({ limit: MAX_CALL_HISTORY_WINDOW });
      return { status: 200, body: { calls: calls.filter((call) => visibleIds.has(call.id)).slice(0, limit) } };
    },
  ));

  app.get("/communications/calls/:callId", async (req, res) => withStaff(
    req,
    res,
    deps,
    "communications.read",
    "Communication",
    "communications-call-read",
    undefined,
    async (staff) => {
      const provider = adapter(deps, providerFromQuery(req), staff.fhir);
      if (!provider.getCall) throw new CommsApiCapabilityError("Call detail is not enabled for this communications provider.");
      const callId = resourceKey(req.params.callId, "call id");
      await requireVisibleTwilioIdentifier(staff.fhir, ODOS_TWILIO_CALL_IDENTIFIER_SYSTEM, callId, "Call");
      return { status: 200, body: { call: await provider.getCall(callId) } };
    },
  ));

  app.post("/communications/calls", async (req, res) => withStaff(
    req,
    res,
    deps,
    "communications.call",
    "Communication",
    "communications-call-initiate",
    patientReferenceFromBody(req.body),
    async (staff) => {
      const body = record(req.body);
      const patientReference = requiredPatientReference(body.patientReference);
      const provider = adapter(deps, providerFromBody(body), staff.fhir);
      if (!provider.initiateCall) throw new CommsApiCapabilityError("Calling is not enabled for this communications provider.");
      return { status: 201, body: await provider.initiateCall({ patientReference }) };
    },
  ));

  app.get("/communications/recordings/:recordingId", async (req, res) => withStaff(
    req,
    res,
    deps,
    "communications.content.read",
    "Binary",
    "communications-recording-read",
    undefined,
    async (staff) => {
      const provider = adapter(deps, providerFromQuery(req), staff.fhir);
      if (!provider.fetchRecording) {
        throw new CommsApiCapabilityError("Recording retrieval is not enabled for this communications provider.");
      }
      const recordingId = resourceKey(req.params.recordingId, "recording id");
      await requireVisibleTwilioIdentifier(
        staff.fhir,
        ODOS_TWILIO_RECORDING_IDENTIFIER_SYSTEM,
        recordingId,
        "Recording",
      );
      const recording = await provider.fetchRecording(recordingId);
      return {
        status: 200,
        media: { contentType: recording.contentType, bytes: recording.audio },
      };
    },
  ));
}

async function withStaff(
  req: Request,
  res: Response,
  deps: CommsApiRouteDeps,
  action: BusinessAction,
  resourceType: string,
  actionReason: string,
  patientReference: string | undefined,
  operation: (staff: CommsStaff) => Promise<CommsApiResult>,
): Promise<void> {
  try {
    await deps.authenticateService();
    const staff = await deps.authenticate(req.header("authorization"));
    if (!staff) {
      res.status(401).json({ error: "Authentication required for patient communications." });
      return;
    }
    const actorId = staff.staffReference.replace(/^Practitioner\//, "");
    const actorRole = actingRole(req, staff, action);
    const claimedActorId = req.header("X-ODOS-Actor-Id")?.trim();
    if (!actorRole || (claimedActorId && claimedActorId !== actorId && claimedActorId !== staff.staffReference)) {
      await deps.audit.recordDenied(buildOdosAuditEventRow({
        eventType: "denied",
        eventTime: deps.now?.(),
        actorId,
        actorRole: staff.actorRole,
        patientReference,
        resourceType,
        actionOutcome: "denied",
        actionReason: `${action} role required`,
        policyUrl: `AccessPolicy/odos-${staff.actorRole}`,
        ipAddress: req.ip?.replace(/^::ffff:/, ""),
        userAgent: req.header("user-agent"),
      }));
      res.status(403).json({ error: `${action} role required` });
      return;
    }
    const result = await deps.audit.record(buildOdosAuditEventRow({
      eventType: req.method === "GET" ? "read" : "external-api-call",
      eventTime: deps.now?.(),
      actorId,
      actorRole,
      patientReference,
      resourceType,
      actionOutcome: "granted",
      actionReason,
      policyUrl: `AccessPolicy/odos-${actorRole}`,
      ipAddress: req.ip?.replace(/^::ffff:/, ""),
      userAgent: req.header("user-agent"),
    }), () => operation({ ...staff, actorRole }));
    if ("media" in result) {
      res.status(result.status).type(result.media.contentType).send(Buffer.from(result.media.bytes));
    } else {
      res.status(result.status).json(result.body);
    }
  } catch (error) {
    if (res.headersSent) return;
    if (error instanceof CommsApiValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    if (error instanceof CommsApiCapabilityError) {
      res.status(409).json({ error: error.message });
      return;
    }
    if (error instanceof CommsApiNotFoundError) {
      res.status(404).json({ error: error.message });
      return;
    }
    console.error("odos-mcp: patient communications route failed.");
    res.status(502).json({ error: "Patient communications service failed." });
  }
}

async function visibleCallIds(fhir: CommsDispatchFhir): Promise<Set<string>> {
  const communications = await searchBounded<Communication>(fhir, "Communication", {
    category: `${ODOS_COMMS_CATEGORY_SYSTEM}|${ODOS_PATIENT_CALL_CATEGORY}`,
    _sort: "-_lastUpdated",
    _count: "100",
  }, { maxPages: 10, maxRows: 1_000 });
  return new Set(communications.flatMap((communication) => communication.identifier ?? []).flatMap((identifier) =>
    identifier.system === ODOS_TWILIO_CALL_IDENTIFIER_SYSTEM && identifier.value ? [identifier.value] : []));
}

async function requireVisibleTwilioIdentifier(
  fhir: CommsDispatchFhir,
  system: string,
  value: string,
  label: string,
): Promise<void> {
  const bundle = await fhir.search<Communication>("Communication", {
    identifier: `${system}|${value}`,
    _count: "2",
  });
  const matches = (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []).filter((communication) =>
    communication.identifier?.some((identifier) =>
      identifier.system === system && identifier.value === value));
  if (matches.length === 0) throw new CommsApiNotFoundError(`${label} not found.`);
  if (matches.length > 1) throw new Error(`Twilio ${label.toLowerCase()} identifier ${value} is not unique.`);
}

function actingRole(req: Request, staff: CommsStaff, action: BusinessAction): PracticeRoleId | undefined {
  const claimed = req.header("X-ODOS-Actor-Role")?.trim();
  if (claimed) {
    if (!PRACTICE_ROLE_IDS.includes(claimed as PracticeRoleId)) return undefined;
    const role = claimed as PracticeRoleId;
    return staff.roles.includes(role) && hasBusinessAction(role, action) ? role : undefined;
  }
  return resolveBusinessActionRole(staff.roles, action);
}

function hasBusinessAction(role: PracticeRoleId, action: BusinessAction): boolean {
  try {
    assertBusinessActionAllowed(role, action);
    return true;
  } catch {
    return false;
  }
}

function adapter(
  deps: CommsApiRouteDeps,
  provider: string,
  fhir: CommsDispatchFhir,
): CommsProvider {
  return deps.dispatch.getAdapter(provider, fhir);
}

function redactConversationBodies(conversations: ConversationSummary[]): ConversationSummary[] {
  return conversations.map((conversation) => ({
    ...conversation,
    messages: conversation.messages.map(({ body: _body, ...message }) => message),
  }));
}

function providerFromQuery(req: Request): string {
  const value = queryString(req, "provider") ?? "twilio";
  return providerName(value);
}

function providerFromBody(body: Record<string, unknown>): string {
  return providerName(typeof body.provider === "string" ? body.provider : "twilio");
}

function requiredIdempotencyKey(req: Request, body: Record<string, unknown>): string {
  const value = req.header("Idempotency-Key") ?? body.idempotencyKey;
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(value)) {
    throw new CommsApiValidationError("Idempotency-Key header or idempotencyKey body field is required.");
  }
  return value;
}

function providerName(value: string): string {
  const provider = value.trim();
  if (!/^[a-z0-9-]{1,64}$/.test(provider)) throw new CommsApiValidationError("Communications provider is invalid.");
  return provider;
}

function patientReferenceFromQuery(req: Request): string | undefined {
  const value = queryString(req, "patientReference", "patient_id", "patientId");
  if (!value) return undefined;
  return requiredPatientReference(value.startsWith("Patient/") ? value : `Patient/${value}`);
}

function patientReferenceForAudit(req: Request): string | undefined {
  const value = queryString(req, "patientReference", "patient_id", "patientId");
  if (!value) return undefined;
  const reference = value.startsWith("Patient/") ? value : `Patient/${value}`;
  return /^Patient\/[A-Za-z0-9.-]{1,64}$/.test(reference) ? reference : undefined;
}

function patientReferenceFromBody(value: unknown): string | undefined {
  const body = record(value);
  return typeof body.patientReference === "string" && /^Patient\/[A-Za-z0-9.-]{1,64}$/.test(body.patientReference)
    ? body.patientReference
    : undefined;
}

function requiredPatientReference(value: unknown): string {
  if (typeof value !== "string" || !/^Patient\/[A-Za-z0-9.-]{1,64}$/.test(value)) {
    throw new CommsApiValidationError("patientReference must be Patient/<id>.");
  }
  return value;
}

function requiredText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new CommsApiValidationError(`${label} must contain 1-${max} characters.`);
  }
  return value.trim();
}

function numberFromQuery(req: Request, name: string, min: number, max: number): number | undefined {
  const value = queryString(req, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new CommsApiValidationError(`${name} must be an integer from ${min} to ${max}.`);
  }
  return parsed;
}

function queryString(req: Request, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = req.query[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function resourceKey(value: string | string[] | undefined, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9.-]{1,128}$/.test(value)) {
    throw new CommsApiValidationError(`${label} is invalid.`);
  }
  return value;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
