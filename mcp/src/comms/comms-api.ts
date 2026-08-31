import type { Communication, Condition, Encounter, Patient, Provenance, RelatedPerson } from "@medplum/fhirtypes";
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
import type { FhirAuditRecorder, MedplumClient } from "../fhir-client.js";
import { buildProvenance } from "../fhir/ophthalmology/provenance.js";
import { searchBounded } from "../fhir-search.js";
import type { AuthenticatedStaff } from "../payments/payment-charge-handler.js";
import {
  COMMS_CHANNEL_ROLES,
  type CommsDispatch,
  type CommsDispatchFhir,
  type CommsChannelRole,
} from "./comms-config.js";
import type { CommsProvider, ConversationSummary } from "./comms-provider.js";
import type { EducationCatalogReader, EducationContentItem } from "./education-catalog.js";
import { generateTrackedLink, type TrackedLinkStore } from "./tracked-links.js";
import {
  ODOS_COMMS_CATEGORY_SYSTEM,
  ODOS_PATIENT_CALL_CATEGORY,
  ODOS_TWILIO_MESSAGE_IDENTIFIER_SYSTEM,
  ODOS_TWILIO_CALL_IDENTIFIER_SYSTEM,
  ODOS_TWILIO_RECORDING_IDENTIFIER_SYSTEM,
  findStaffSmsSend,
  persistStaffSentSms,
  persistStaffSmsTerminalOutcome,
  reserveStaffSmsSend,
} from "./comms-persistence.js";
import {
  clearPatientSmsOptOut,
  readPatientSmsOptOut,
  SMS_OPT_OUT_IDENTITY_VERIFICATION_METHODS,
  type SmsOptOutIdentityVerification,
  type SmsOptOutManagementFhir,
} from "./suppression-gate.js";

type CommsStaff = Omit<AuthenticatedStaff, "actorRole" | "roles" | "fhir"> & {
  actorRole: PracticeRoleId;
  roles: readonly PracticeRoleId[];
  fhir: MedplumClient;
};

export interface CommsApiRouteDeps {
  authenticateService(): Promise<void>;
  authenticate(authHeader: string | undefined): Promise<CommsStaff | null>;
  fhir: SmsOptOutManagementFhir;
  dispatch: CommsDispatch;
  educationCatalog: EducationCatalogReader;
  trackedLinkStore: TrackedLinkStore;
  publicBaseUrl: string;
  practiceName: string;
  chartDispatchLane?: "locked_clinical" | "staff_switchable";
  audit: FhirAuditRecorder;
  now?: () => string;
}

class CommsApiValidationError extends Error {}
class CommsApiCapabilityError extends Error {}
class CommsApiNotFoundError extends Error {}
class CommsApiRefusalError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}
class CommsProviderTimeoutError extends Error {}

type CommsApiResult =
  | { status: number; body: unknown }
  | { status: number; media: { contentType: string; bytes: Uint8Array } };

const MAX_CALL_HISTORY_WINDOW = 1_000;
const MAX_CONVERSATIONS_PER_PROVIDER = 100;
const CONVERSATION_PROVIDER_TIMEOUT_MS = 10_000;
export const ODOS_COMMS_MARKETING_CONSENT_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-comms-marketing-consent";
const ODOS_COMMS_EDUCATION_SEND_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/comms-education-send";

interface ConversationProviderError {
  provider: string;
  code: "conversation-list-timeout" | "conversation-list-unavailable";
}

interface ListedProviderConversations {
  provider: string;
  adapter: CommsProvider;
  conversations: ConversationSummary[];
}

export function registerCommsApiRoutes(
  app: Pick<Application, "get" | "post">,
  deps: CommsApiRouteDeps,
): void {
  app.get("/communications/education", async (req, res) => withStaff(
    req,
    res,
    deps,
    "communications.read",
    "Basic",
    "communications-education-list",
    undefined,
    async () => {
      const dxCode = educationDxCodeFromQuery(req);
      const channel = educationChannelFromQuery(req);
      const items = deps.educationCatalog.list().filter((item) =>
        item.audience === "patient"
        && (!dxCode || item.dxCodes.includes(dxCode))
        && (!channel || item.channels.includes(channel)));
      return {
        status: 200,
        body: { items, chartDispatchLane: deps.chartDispatchLane ?? "staff_switchable" },
      };
    },
  ));

  app.get("/communications/education/:educationId", async (req, res) => withStaff(
    req,
    res,
    deps,
    "communications.read",
    "Basic",
    "communications-education-read",
    undefined,
    async () => {
      const id = resourceKey(req.params.educationId, "education id");
      const version = numberFromQuery(req, "version", 1, Number.MAX_SAFE_INTEGER);
      const item = deps.educationCatalog.get(id, version);
      if (!item || item.audience !== "patient") {
        throw new CommsApiNotFoundError("Education content not found.");
      }
      return { status: 200, body: { item } };
    },
  ));

  app.post("/communications/education/dispatch", async (req, res) => withStaff(
    req,
    res,
    deps,
    "communications.send",
    "Communication",
    "communications-education-dispatch",
    patientReferenceFromBody(req.body),
    async (staff) => {
      const body = educationDispatchBody(req.body);
      const item = deps.educationCatalog.get(body.educationId, body.version);
      if (!item || item.audience !== "patient") {
        throw new CommsApiNotFoundError("Education content not found.");
      }
      if (!item.channels.includes(body.channel)) {
        throw new CommsApiCapabilityError(`Education content is not published for ${body.channel}.`);
      }
      if (
        deps.chartDispatchLane === "locked_clinical"
        && body.lane !== "clinical"
      ) {
        throw new CommsApiCapabilityError("Education dispatch is locked to the clinical lane for this practice.");
      }
      const patientId = body.patientReference.slice("Patient/".length);
      const patient = await staff.fhir.read<Patient>("Patient", patientId);
      await assertEducationClinicalReferences(staff.fhir, body);
      if (item.consentClass === "marketing" && !hasRecordedMarketingConsent(patient)) {
        throw new CommsApiRefusalError("marketing-consent-absent");
      }
      const recipient = await resolveEducationRecipient(staff.fhir, patient, body);
      const defaultLane = item.laneHint === "retail" ? "frontdesk" : "clinical";
      const laneSelection = body.lane === defaultLane ? "default" : "overridden";
      const campaignId = `${item.id}@${item.version}`;

      if (body.channel === "print") {
        const url = item.urls.print;
        if (!url) throw new CommsApiCapabilityError("Education print artifact is not published.");
        if (body.alsoUpdateChart) {
          await updateEducationRecipient(staff.fhir, recipient, body, staff);
        }
        await persistEducationSendProvenance(staff.fhir, {
          body,
          item,
          staff,
          recipientValue: recipient.value,
          laneSelection,
          now: deps.now?.() ?? new Date().toISOString(),
        });
        return { status: 200, body: { outcome: "print", url } };
      }

      if (body.channel === "email") {
        const url = item.urls.email;
        if (!url) throw new CommsApiCapabilityError("Education email artifact is not published.");
        requireConfiguredRole(deps.dispatch, "email", false);
        const provider = adapterForRole(deps, "email", staff.fhir);
        if (!provider.sendEmail) {
          throw new CommsApiCapabilityError("Email is not enabled for the configured education provider.");
        }
        const result = await provider.sendEmail({
          patientReference: body.patientReference,
          toAddress: recipient.value,
          subject: item.title,
          body: url,
          campaignType: "clinical-education",
          campaignId,
          messageId: body.idempotencyKey,
          suppression: {},
        });
        if (result.outcome === "sent") {
          if (body.alsoUpdateChart) {
            await updateEducationRecipient(staff.fhir, recipient, body, staff);
          }
          await persistEducationSendProvenance(staff.fhir, {
            body,
            item,
            staff,
            recipientValue: recipient.value,
            laneSelection,
            now: deps.now?.() ?? new Date().toISOString(),
          });
        }
        return { status: 200, body: result };
      }

      const role = educationSmsRole(body.lane);
      requireConfiguredRole(deps.dispatch, role, true);
      const provider = adapterForRole(deps, role, staff.fhir);
      if (!provider.sendSms) {
        throw new CommsApiCapabilityError("SMS is not enabled for the configured education lane.");
      }
      const targetUrl = item.urls.web;
      if (!targetUrl) throw new CommsApiCapabilityError("Education web artifact is not published.");
      assertEducationPublicBaseUrl(deps.publicBaseUrl);
      const existingSend = await findStaffSmsSend(staff.fhir, body.idempotencyKey);
      const smsBody = existingSend?.payload?.[0]?.contentString ?? await educationSmsBody(deps, {
        targetUrl,
        campaignId,
        messageId: body.idempotencyKey,
      });
      const providerMessageIdentifierSystem =
        provider.messageIdentifierSystem ?? ODOS_TWILIO_MESSAGE_IDENTIFIER_SYSTEM;
      const reservation = await reserveStaffSmsSend(staff.fhir, {
        idempotencyKey: body.idempotencyKey,
        claimId: randomUUID(),
        patientReference: body.patientReference,
        senderReference: staff.staffReference,
        body: smsBody,
        requestFingerprint: JSON.stringify({
          patientReference: body.patientReference,
          recipient: recipient.value,
          education: campaignId,
          targetUrl,
          lane: body.lane,
          provider: provider.name,
          recipientReference: recipient.reference,
          alsoUpdateChart: body.alsoUpdateChart,
          encounterReference: body.encounterReference,
          conditionReference: body.conditionReference,
        }),
        provider: provider.name,
        providerMessageIdentifierSystem,
      });
      if (reservation.state === "conflict") {
        throw new CommsApiCapabilityError("Education idempotency key was already used for a different request.");
      }
      if (reservation.state === "pending") {
        throw new CommsApiCapabilityError("Education send outcome is pending reconciliation; do not resend with a new key.");
      }
      if (reservation.state === "sent") {
        if (body.alsoUpdateChart) {
          await updateEducationRecipient(staff.fhir, recipient, body, staff);
        }
        await persistEducationSendProvenance(staff.fhir, {
          body,
          item,
          staff,
          recipientValue: recipient.value,
          laneSelection,
          now: deps.now?.() ?? new Date().toISOString(),
        });
        return {
          status: 200,
          body: { outcome: "sent", providerMessageId: reservation.providerMessageId },
        };
      }
      if (reservation.state === "terminal") {
        return { status: 200, body: reservation.result };
      }
      const result = await provider.sendSms({
        patientReference: body.patientReference,
        toNumber: recipient.value,
        body: smsBody,
        campaignType: "clinical-education",
        campaignId,
        messageId: body.idempotencyKey,
        suppression: {},
      });
      if (result.outcome === "sent") {
        await persistStaffSentSms(staff.fhir, {
          communication: reservation.communication,
          idempotencyKey: body.idempotencyKey,
          providerMessageId: result.providerMessageId,
          providerMessageIdentifierSystem,
        }, { now: () => deps.now?.() ?? new Date().toISOString() });
        if (body.alsoUpdateChart) {
          await updateEducationRecipient(staff.fhir, recipient, body, staff);
        }
        await persistEducationSendProvenance(staff.fhir, {
          body,
          item,
          staff,
          recipientValue: recipient.value,
          laneSelection,
          now: deps.now?.() ?? new Date().toISOString(),
        });
      } else {
        await persistStaffSmsTerminalOutcome(staff.fhir, {
          communication: reservation.communication,
          idempotencyKey: body.idempotencyKey,
          result,
        });
      }
      return { status: 200, body: result };
    },
  ));

  app.get("/communications/opt-out", async (req, res) => withStaff(
    req,
    res,
    deps,
    "communications.optout.manage",
    "Patient",
    "communications-opt-out-read",
    optOutPatientReferenceForAudit(req),
    async (staff) => {
      const patientReference = requiredPatientReference(queryString(req, "patient"));
      return { status: 200, body: await patientSmsOptOutState(staff.fhir, deps.dispatch, patientReference) };
    },
  ));

  app.post("/communications/opt-out/clear", async (req, res) => withStaff(
    req,
    res,
    deps,
    "communications.optout.manage",
    "Patient",
    "communications-opt-out-clear",
    patientReferenceFromBody(req.body),
    async (staff) => {
      const body = optOutClearBody(req.body);
      return {
        status: 200,
        body: await clearNamedPatientSmsOptOut(staff.fhir, deps, body, staff),
      };
    },
  ));

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
      const conversationId = conversationIdFromQuery(req);
      const limit = numberFromQuery(req, "limit", 1, 100) ?? 50;
      const explicitProvider = explicitProviderFromQuery(req);
      const providerNames = explicitProvider
        ? [explicitProvider]
        : routedProviderNames(deps.dispatch);
      if (providerNames.length === 0) {
        throw new CommsApiCapabilityError("Conversation history is not configured for this practice.");
      }
      const includeContent = hasBusinessAction(staff.actorRole, "communications.content.read");
      const listRequest = {
        ...(patientReference ? { patientReference } : {}),
        limit: MAX_CONVERSATIONS_PER_PROVIDER,
        includeContent,
      };
      let listedProviders: ListedProviderConversations[];
      let providerErrors: ConversationProviderError[] = [];
      if (explicitProvider) {
        const provider = adapter(deps, explicitProvider, staff.fhir);
        if (!provider.listConversations) {
          throw new CommsApiCapabilityError("Conversation history is not enabled for this communications provider.");
        }
        listedProviders = [{
          provider: explicitProvider,
          adapter: provider,
          conversations: await withConversationProviderTimeout(() => provider.listConversations!(listRequest)),
        }];
      } else {
        const results = await Promise.all(providerNames.map(async (providerName) => {
          try {
            const provider = adapter(deps, providerName, staff.fhir);
            if (!provider.listConversations) return { kind: "skipped" as const };
            return {
              kind: "listed" as const,
              value: {
                provider: providerName,
                adapter: provider,
                conversations: await withConversationProviderTimeout(() => provider.listConversations!(listRequest)),
              },
            };
          } catch (error) {
            return {
              kind: "error" as const,
              error: {
                provider: providerName,
                code: error instanceof CommsProviderTimeoutError
                  ? "conversation-list-timeout" as const
                  : "conversation-list-unavailable" as const,
              },
            };
          }
        }));
        listedProviders = results.flatMap((result) => result.kind === "listed" ? [result.value] : []);
        providerErrors = results.flatMap((result) => result.kind === "error" ? [result.error] : []);
      }
      let conversations: ConversationSummary[] = listedProviders
        .flatMap(({ provider, conversations: rows }) => rows.map((conversation) => ({
          ...conversation,
          provider,
        })))
        .sort(compareConversationActivity);
      let selectedConversation: ConversationSummary | undefined;
      if (conversationId) {
        const matches = conversations.filter((conversation) => conversation.id === conversationId);
        if (matches.length === 0) {
          if (providerErrors.length === 0) throw new CommsApiNotFoundError("Conversation not found.");
        }
        if (matches.length > 1) {
          throw new CommsApiValidationError("Conversation id is ambiguous; specify its provider.");
        }
        if (matches.length === 1) {
          selectedConversation = matches[0];
          const selectedProvider = listedProviders.find(({ provider }) =>
            provider === selectedConversation!.provider)!.adapter;
          if (includeContent && selectedProvider.getConversationMessages) {
            selectedConversation = {
              ...selectedConversation,
              messages: await selectedProvider.getConversationMessages(conversationId, { includeContent: true }),
            };
            conversations = conversations.map((conversation) =>
              sameConversation(conversation, selectedConversation!) ? selectedConversation! : conversation);
          } else if (includeContent && selectedConversation.messages.length === 0) {
            throw new CommsApiCapabilityError("Conversation thread history is not enabled for this communications provider.");
          }
        }
      }
      conversations = limitConversations(conversations, limit, selectedConversation);
      return {
        status: 200,
        body: {
          conversations: includeContent ? conversations : redactConversationBodies(conversations),
          providerErrors,
        },
      };
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
      const provider = typeof body.provider === "string"
        ? adapterForExplicitSmsProvider(deps, providerName(body.provider), staff.fhir)
        : adapterForRole(deps, "transactional-sms", staff.fhir);
      if (!provider.sendSms) throw new CommsApiCapabilityError("SMS is not enabled for this communications provider.");
      const providerMessageIdentifierSystem =
        provider.messageIdentifierSystem ?? ODOS_TWILIO_MESSAGE_IDENTIFIER_SYSTEM;
      const reservation = await reserveStaffSmsSend(staff.fhir, {
        idempotencyKey,
        claimId: randomUUID(),
        patientReference,
        senderReference: staff.staffReference,
        body: text,
        provider: provider.name,
        providerMessageIdentifierSystem,
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
          providerMessageId: result.providerMessageId,
          providerMessageIdentifierSystem,
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
      const provider = adapter(deps, providerFromQuery(req, deps.dispatch, "voice"), staff.fhir);
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
      const provider = adapter(deps, providerFromQuery(req, deps.dispatch, "voice"), staff.fhir);
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
      const provider = adapter(deps, providerFromBody(body, deps.dispatch, "voice"), staff.fhir);
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
      const provider = adapter(deps, providerFromQuery(req, deps.dispatch, "voice"), staff.fhir);
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
    const eventType = req.method === "GET" ? "read" : "external-api-call";
    const auditContext = {
      eventType,
      eventTime: deps.now?.(),
      actorId,
      actorRole,
      patientReference,
      resourceType,
      policyUrl: `AccessPolicy/odos-${actorRole}`,
      ipAddress: req.ip?.replace(/^::ffff:/, ""),
      userAgent: req.header("user-agent"),
    } as const;
    let result: CommsApiResult;
    try {
      result = await deps.audit.record(buildOdosAuditEventRow({
        ...auditContext,
        actionOutcome: "granted",
        actionReason,
      }), () => operation({ ...staff, actorRole }));
    } catch (error) {
      if (!isAuditSubstrateUnavailable(error)) {
        await deps.audit.recordDenied(buildOdosAuditEventRow({
          ...auditContext,
          actionOutcome: "denied",
          actionReason: `${actionReason}-failed`,
        }));
      }
      throw error;
    }
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
    if (error instanceof CommsApiRefusalError) {
      res.status(409).json({ outcome: "refused", reason: error.reason });
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

async function patientSmsOptOutState(
  fhir: SmsOptOutManagementFhir,
  dispatch: CommsDispatch,
  patientReference: string,
) {
  try {
    return {
      ...await readPatientSmsOptOut(fhir, patientReference),
      smsLanes: configuredSmsLanes(dispatch),
    };
  } catch (error) {
    if (isFhirNotFound(error)) throw new CommsApiNotFoundError("Patient not found.");
    throw error;
  }
}

function configuredSmsLanes(dispatch: CommsDispatch): Array<{
  label: string;
  number: string;
  roles: CommsChannelRole[];
}> {
  const roles = ["transactional-sms", "marketing-sms", "clinical-sms"] as const;
  const byNumber = new Map<string, CommsChannelRole[]>();
  for (const role of roles) {
    if (!dispatch.providerFor(role)) continue;
    const number = dispatch.senderNumberFor(role);
    if (!number) continue;
    byNumber.set(number, [...(byNumber.get(number) ?? []), role]);
  }
  return [...byNumber].map(([number, laneRoles]) => ({
    label: smsLaneLabel(laneRoles),
    number,
    roles: laneRoles,
  }));
}

function smsLaneLabel(roles: readonly CommsChannelRole[]): string {
  const frontDesk = roles.some((role) => role === "transactional-sms" || role === "marketing-sms");
  const clinical = roles.includes("clinical-sms");
  if (frontDesk && clinical) return "Front-desk and clinical texts";
  return clinical ? "Clinical texts" : "Front-desk texts";
}

async function clearNamedPatientSmsOptOut(
  fhir: SmsOptOutManagementFhir,
  deps: CommsApiRouteDeps,
  body: {
    patientReference: string;
    reason: string;
    identityVerification: SmsOptOutIdentityVerification;
    number?: string;
  },
  staff: CommsStaff,
) {
  try {
    return await clearPatientSmsOptOut(fhir, body.patientReference, {
      actorReference: staff.staffReference,
      actorRole: staff.actorRole,
      recordedAt: deps.now?.() ?? new Date().toISOString(),
      reason: body.reason,
      identityVerification: body.identityVerification,
      number: body.number,
    });
  } catch (error) {
    if (isFhirNotFound(error)) throw new CommsApiNotFoundError("Patient not found.");
    throw error;
  }
}

function isFhirNotFound(error: unknown): boolean {
  return [404, 410].includes((error as { status?: number })?.status ?? 0);
}

function isAuditSubstrateUnavailable(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    if (current.message.includes("audit substrate unavailable")) return true;
    seen.add(current);
    current = current.cause;
  }
  return false;
}

function adapter(
  deps: CommsApiRouteDeps,
  provider: string,
  callerFhir: CommsDispatchFhir,
): CommsProvider {
  return deps.dispatch.getAdapter(provider, callerFhir);
}

function adapterForRole(
  deps: CommsApiRouteDeps,
  role: CommsChannelRole,
  callerFhir: CommsDispatchFhir,
): CommsProvider {
  return deps.dispatch.getAdapterForRole?.(role, callerFhir)
    ?? deps.dispatch.getAdapter(providerForRole(deps.dispatch, role), callerFhir);
}

function adapterForExplicitSmsProvider(
  deps: CommsApiRouteDeps,
  provider: string,
  callerFhir: CommsDispatchFhir,
): CommsProvider {
  const smsRoles = [
    "transactional-sms",
    "marketing-sms",
    "clinical-sms",
  ] as const;
  const senderNumbers = new Set(smsRoles.flatMap((role) =>
    deps.dispatch.providerFor(role) === provider
      ? [deps.dispatch.senderNumberFor(role)].filter(
          (number): number is string => number !== undefined,
        )
      : []));
  if (senderNumbers.size > 1) {
    throw new CommsApiValidationError(
      `Communications provider "${provider}" has multiple SMS sender lanes; the request must identify one lane.`,
    );
  }
  return adapter(deps, provider, callerFhir);
}

function redactConversationBodies(conversations: ConversationSummary[]): ConversationSummary[] {
  return conversations.map(({ preview: _preview, ...conversation }) => ({
    ...conversation,
    messages: conversation.messages.map(({ body: _body, ...message }) => message),
  }));
}

async function withConversationProviderTimeout<T>(operation: () => Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new CommsProviderTimeoutError("Conversation provider timed out.")),
          CONVERSATION_PROVIDER_TIMEOUT_MS,
        );
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function routedProviderNames(dispatch: CommsDispatch): string[] {
  return [...new Set(COMMS_CHANNEL_ROLES.flatMap((role) => {
    const provider = dispatch.providerFor(role);
    return provider ? [provider] : [];
  }))];
}

function explicitProviderFromQuery(req: Request): string | undefined {
  const explicit = queryString(req, "provider");
  return explicit ? providerName(explicit) : undefined;
}

function compareConversationActivity(left: ConversationSummary, right: ConversationSummary): number {
  const leftTime = conversationActivityTime(left.updatedAt);
  const rightTime = conversationActivityTime(right.updatedAt);
  if (leftTime === rightTime) return 0;
  return rightTime > leftTime ? 1 : -1;
}

function conversationActivityTime(updatedAt: string | undefined): number {
  if (!updatedAt) return Number.NEGATIVE_INFINITY;
  const value = Date.parse(updatedAt);
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function sameConversation(left: ConversationSummary, right: ConversationSummary): boolean {
  return left.id === right.id && left.provider === right.provider;
}

function limitConversations(
  conversations: ConversationSummary[],
  limit: number,
  selected: ConversationSummary | undefined,
): ConversationSummary[] {
  const limited = conversations.slice(0, limit);
  if (!selected || limited.some((conversation) => sameConversation(conversation, selected))) {
    return limited;
  }
  return [...limited.slice(0, limit - 1), selected].sort(compareConversationActivity);
}

function providerFromQuery(
  req: Request,
  dispatch: CommsDispatch,
  role: "voice" | "transactional-sms",
): string {
  const explicit = queryString(req, "provider");
  return explicit ? providerName(explicit) : providerForRole(dispatch, role);
}

function providerFromBody(
  body: Record<string, unknown>,
  dispatch: CommsDispatch,
  role: "voice" | "transactional-sms",
): string {
  return typeof body.provider === "string"
    ? providerName(body.provider)
    : providerForRole(dispatch, role);
}

function providerForRole(dispatch: CommsDispatch, role: CommsChannelRole): string {
  const provider = dispatch.providerFor(role);
  if (!provider) {
    throw new CommsApiCapabilityError(`Communications role "${role}" is not configured for this practice.`);
  }
  return provider;
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

function conversationIdFromQuery(req: Request): string | undefined {
  const value = queryString(req, "conversationId", "conversation_id");
  return value ? resourceKey(value, "conversation id") : undefined;
}

function patientReferenceForAudit(req: Request): string | undefined {
  const value = queryString(req, "patientReference", "patient_id", "patientId");
  if (!value) return undefined;
  const reference = value.startsWith("Patient/") ? value : `Patient/${value}`;
  return /^Patient\/[A-Za-z0-9.-]{1,64}$/.test(reference) ? reference : undefined;
}

function optOutPatientReferenceForAudit(req: Request): string | undefined {
  const value = queryString(req, "patient");
  return value && /^Patient\/[A-Za-z0-9.-]{1,64}$/.test(value) ? value : undefined;
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

function optOutClearBody(value: unknown): {
  patientReference: string;
  reason: string;
  identityVerification: SmsOptOutIdentityVerification;
  number?: string;
} {
  const body = record(value);
  const unexpected = Object.keys(body).filter((key) =>
    key !== "patientReference"
    && key !== "reason"
    && key !== "identityVerification"
    && key !== "number");
  if (unexpected.length > 0) {
    throw new CommsApiValidationError(
      "Opt-out clear accepts only patientReference, reason, identityVerification, and number.",
    );
  }
  const patientReference = requiredPatientReference(body.patientReference);
  const reason = requiredText(body.reason, "reason", 2_000);
  if (
    typeof body.identityVerification !== "string"
    || !SMS_OPT_OUT_IDENTITY_VERIFICATION_METHODS.includes(
      body.identityVerification as SmsOptOutIdentityVerification,
    )
  ) {
    throw new CommsApiValidationError(
      `identityVerification must be one of: ${SMS_OPT_OUT_IDENTITY_VERIFICATION_METHODS.join(", ")}.`,
    );
  }
  return {
    patientReference,
    reason,
    identityVerification: body.identityVerification as SmsOptOutIdentityVerification,
    ...(body.number === undefined ? {} : { number: requiredE164(body.number, "number") }),
  };
}

function requiredE164(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\+[1-9]\d{7,14}$/.test(value.trim())) {
    throw new CommsApiValidationError(`${label} must use E.164 format.`);
  }
  return value.trim();
}

function requiredText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new CommsApiValidationError(`${label} must contain 1-${max} characters.`);
  }
  return value.trim();
}

function requiredInteger(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new CommsApiValidationError(`${label} must be an integer from ${min} to ${max}.`);
  }
  return value as number;
}

type EducationDispatchBody = {
  patientReference: string;
  educationId: string;
  version: number;
  channel: "sms" | "email" | "print";
  lane: "clinical" | "frontdesk";
  recipientOverride?: {
    reference?: string;
    phone?: string;
    email?: string;
  };
  alsoUpdateChart: boolean;
  encounterReference?: string;
  conditionReference?: string;
  idempotencyKey: string;
};

function educationDispatchBody(value: unknown): EducationDispatchBody {
  const body = record(value);
  const channel = body.channel;
  if (channel !== "sms" && channel !== "email" && channel !== "print") {
    throw new CommsApiValidationError("channel must be sms, email, or print.");
  }
  const lane = body.lane;
  if (lane !== "clinical" && lane !== "frontdesk") {
    throw new CommsApiValidationError("lane must be clinical or frontdesk.");
  }
  if (body.alsoUpdateChart !== undefined && typeof body.alsoUpdateChart !== "boolean") {
    throw new CommsApiValidationError("alsoUpdateChart must be boolean.");
  }
  return {
    patientReference: requiredPatientReference(body.patientReference),
    educationId: resourceKey(typeof body.educationId === "string" ? body.educationId : undefined, "education id"),
    version: requiredInteger(body.version, "version", 1, Number.MAX_SAFE_INTEGER),
    channel,
    lane,
    recipientOverride: recipientOverride(body.recipientOverride),
    alsoUpdateChart: body.alsoUpdateChart === true,
    encounterReference: optionalReference(body.encounterReference, "Encounter"),
    conditionReference: optionalReference(body.conditionReference, "Condition"),
    idempotencyKey: idempotencyKeyFromBody(body.idempotencyKey),
  };
}

function recipientOverride(value: unknown): EducationDispatchBody["recipientOverride"] {
  if (value === undefined) return undefined;
  const input = record(value);
  const reference = input.reference === undefined
    ? undefined
    : optionalRecipientReference(input.reference);
  const phone = input.phone === undefined ? undefined : requiredE164(input.phone, "recipientOverride.phone");
  const email = input.email === undefined ? undefined : requiredEmail(input.email, "recipientOverride.email");
  if (!phone && !email) {
    throw new CommsApiValidationError("recipientOverride must include phone or email.");
  }
  return { reference, phone, email };
}

function optionalRecipientReference(value: unknown): string {
  if (typeof value !== "string" || !/^(?:Patient|RelatedPerson)\/[A-Za-z0-9.-]{1,64}$/.test(value)) {
    throw new CommsApiValidationError("recipientOverride.reference must be Patient/<id> or RelatedPerson/<id>.");
  }
  return value;
}

function optionalReference(value: unknown, resourceType: "Encounter" | "Condition"): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !new RegExp(`^${resourceType}/[A-Za-z0-9.-]{1,64}$`).test(value)) {
    throw new CommsApiValidationError(`${resourceType.toLowerCase()}Reference must be ${resourceType}/<id>.`);
  }
  return value;
}

function idempotencyKeyFromBody(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(value)) {
    throw new CommsApiValidationError("idempotencyKey is required.");
  }
  return value;
}

function educationSmsRole(lane: EducationDispatchBody["lane"]): CommsChannelRole {
  return lane === "clinical" ? "clinical-sms" : "transactional-sms";
}

function requireConfiguredRole(
  dispatch: CommsDispatch,
  role: CommsChannelRole,
  senderNumberRequired: boolean,
): void {
  if (!dispatch.providerFor(role) || (senderNumberRequired && !dispatch.senderNumberFor(role))) {
    throw new CommsApiCapabilityError(
      `Education ${role} lane is not configured; open communications setup to choose a provider${senderNumberRequired ? " and sender number" : ""}.`,
    );
  }
}

async function resolveEducationRecipient(
  fhir: MedplumClient,
  patient: Patient,
  body: EducationDispatchBody,
): Promise<{ reference: string; value: string; resource: Patient | RelatedPerson }> {
  const reference = body.recipientOverride?.reference ?? body.patientReference;
  if (reference.startsWith("Patient/") && reference !== body.patientReference) {
    throw new CommsApiValidationError("recipientOverride Patient must match patientReference.");
  }
  const resource = reference === body.patientReference
    ? patient
    : await fhir.read<RelatedPerson>("RelatedPerson", reference.slice("RelatedPerson/".length));
  if (resource.resourceType === "RelatedPerson" && resource.patient.reference !== body.patientReference) {
    throw new CommsApiValidationError("recipientOverride RelatedPerson does not belong to this patient.");
  }
  const overridden = body.channel === "sms"
    ? body.recipientOverride?.phone
    : body.channel === "email"
      ? body.recipientOverride?.email
      : undefined;
  const recorded = body.channel === "sms"
    ? telecomValue(resource, "phone")
    : body.channel === "email"
      ? telecomValue(resource, "email")
      : reference;
  const value = overridden ?? recorded;
  if (!value) {
    throw new CommsApiCapabilityError(
      body.channel === "sms" ? "The selected recipient has no SMS number on file." : "The selected recipient has no email address on file.",
    );
  }
  return { reference, value, resource };
}

async function assertEducationClinicalReferences(
  fhir: MedplumClient,
  body: EducationDispatchBody,
): Promise<void> {
  if (body.encounterReference) {
    const encounter = await fhir.read<Encounter>("Encounter", body.encounterReference.slice("Encounter/".length));
    if (encounter.subject?.reference !== body.patientReference) {
      throw new CommsApiValidationError(`encounterReference must belong to ${body.patientReference}.`);
    }
  }
  if (body.conditionReference) {
    const condition = await fhir.read<Condition>("Condition", body.conditionReference.slice("Condition/".length));
    if (condition.subject.reference !== body.patientReference) {
      throw new CommsApiValidationError(`conditionReference must belong to ${body.patientReference}.`);
    }
  }
}

function assertEducationPublicBaseUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new CommsApiCapabilityError(
      "Set ODOS_PRACTICE_PUBLIC_BASE_URL to the practice's reachable HTTPS base URL before sending tracked education links.",
    );
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new CommsApiCapabilityError(
      "Set ODOS_PRACTICE_PUBLIC_BASE_URL to the practice's reachable HTTPS base URL before sending tracked education links.",
    );
  }
}

async function educationSmsBody(
  deps: Pick<CommsApiRouteDeps, "trackedLinkStore" | "publicBaseUrl" | "practiceName">,
  input: { targetUrl: string; campaignId: string; messageId: string },
): Promise<string> {
  const tracked = await generateTrackedLink({
    store: deps.trackedLinkStore,
    publicBaseUrl: deps.publicBaseUrl,
    ...input,
  });
  return `${deps.practiceName}\n${tracked.url}\nReply STOP to opt out.`;
}

function telecomValue(resource: Patient | RelatedPerson, system: "phone" | "email"): string | undefined {
  const candidates = (resource.telecom ?? []).filter((telecom) =>
    telecom.system === system && telecom.value && telecom.use !== "old");
  const preferred = system === "phone"
    ? candidates.find((telecom) => telecom.use === "mobile") ?? candidates[0]
    : candidates[0];
  return preferred?.value;
}

async function updateEducationRecipient(
  fhir: MedplumClient,
  recipient: { reference: string; resource: Patient | RelatedPerson },
  body: EducationDispatchBody,
  staff: CommsStaff,
): Promise<void> {
  const system = body.channel === "sms" ? "phone" : body.channel === "email" ? "email" : undefined;
  const value = system === "phone" ? body.recipientOverride?.phone : body.recipientOverride?.email;
  if (!system || !value) {
    throw new CommsApiValidationError("alsoUpdateChart requires a phone or email recipient override.");
  }
  const resource = recipient.resource;
  if (!resource.id || !resource.meta?.versionId) {
    throw new CommsApiCapabilityError("The selected recipient cannot be updated without a current resource version.");
  }
  const telecom = (resource.telecom ?? []).map((entry) =>
    entry.system === system && entry.use !== "old" ? { ...entry, use: "old" as const } : entry);
  telecom.push({ system, value, ...(system === "phone" ? { use: "mobile" as const } : {}) });
  await fhir.update(resource.resourceType, resource.id, { ...resource, telecom }, {
    "If-Match": `W/\"${resource.meta.versionId}\"`,
    "X-ODOS-Source": "mcp/comms-education-recipient-update",
    "X-ODOS-Actor-Id": staff.staffReference,
  });
}

async function persistEducationSendProvenance(
  fhir: MedplumClient,
  input: {
    body: EducationDispatchBody;
    item: EducationContentItem;
    staff: CommsStaff;
    recipientValue: string;
    laneSelection: "default" | "overridden";
    now: string;
  },
): Promise<void> {
  const targets = [
    input.body.patientReference,
    input.body.encounterReference,
    input.body.conditionReference,
  ].filter((reference): reference is string => Boolean(reference));
  const provenance: Provenance = {
    ...buildProvenance({
      targetReferences: targets,
      recorded: input.now,
      activityCode: "CREATE",
      activityDisplay: "Dispatch patient education",
      agents: [{ whoReference: input.staff.staffReference, typeCode: "author" }],
      entityValues: [
        { role: "source", display: `Education content: ${input.item.id}@${input.item.version}` },
        { role: "source", display: `Channel: ${input.body.channel}` },
        { role: "source", display: `Lane: ${input.body.lane} (${input.laneSelection})` },
        { role: "source", display: `Recipient: ${input.recipientValue}` },
        ...(input.body.alsoUpdateChart ? [{ role: "source" as const, display: "Recipient override also updated chart" }] : []),
      ],
    }),
    meta: {
      tag: [{
        system: ODOS_COMMS_EDUCATION_SEND_IDENTIFIER_SYSTEM,
        code: input.body.idempotencyKey,
      }],
    },
  };
  await fhir.create(provenance, {
    "If-None-Exist": `_tag=${ODOS_COMMS_EDUCATION_SEND_IDENTIFIER_SYSTEM}|${input.body.idempotencyKey}`,
  });
}

function requiredEmail(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) {
    throw new CommsApiValidationError(`${label} must be a valid email address.`);
  }
  return value.trim();
}

function hasRecordedMarketingConsent(patient: Patient): boolean {
  const consent = patient.extension?.find((extension) =>
    extension.url === ODOS_COMMS_MARKETING_CONSENT_EXTENSION_URL);
  if (!consent) return false;
  const allowed = consent.extension?.find((part) => part.url === "consent")?.valueBoolean;
  const recorded = consent.extension?.find((part) => part.url === "recorded")?.valueDateTime;
  return allowed === true && typeof recorded === "string" && !Number.isNaN(Date.parse(recorded));
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

function educationDxCodeFromQuery(req: Request): string | undefined {
  const value = queryString(req, "dxCode");
  if (value === undefined) return undefined;
  if (!/^[A-Z][0-9A-Z]{1,2}(?:\.[0-9A-Z]{1,4})?$/.test(value)) {
    throw new CommsApiValidationError("dxCode is invalid.");
  }
  return value;
}

function educationChannelFromQuery(req: Request): EducationContentItem["channels"][number] | undefined {
  const value = queryString(req, "channel");
  if (value === undefined) return undefined;
  if (value !== "sms" && value !== "email" && value !== "print") {
    throw new CommsApiValidationError("channel must be sms, email, or print.");
  }
  return value;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
