import { randomUUID } from "node:crypto";
import { buildOsodAuditEventRow, type OsodAuditEventRow } from "../authz/osodAudit.js";
import { validatedCdsCards, isCdsCardFresh } from "./card-schema.js";
import { OSOD_DEFAULT_CDS_SERVICES } from "./services/index.js";
import type { RegisteredCdsService } from "./service-registry.js";
import {
  CDS_SERVICE_REGISTRY_POLICY_URL,
  DEFAULT_EXTERNAL_CDS_TIMEOUT_SECONDS,
  type CdsCard,
  type CdsFhirAuthorization,
  type CdsHookEvaluationInput,
  type CdsServiceRequestBody,
  type CdsServiceResponse,
} from "./types.js";

export interface CdsDispatchOptions {
  readonly input: CdsHookEvaluationInput;
  readonly externalServices?: readonly RegisteredCdsService[];
  readonly fetchImpl?: typeof fetch;
  readonly fhirAuthorizationFor?: (service: RegisteredCdsService) => Promise<CdsFhirAuthorization | undefined>;
  readonly now?: Date;
}

export interface CdsDispatchResult {
  readonly cards: readonly CdsCard[];
  readonly auditEvents: readonly OsodAuditEventRow[];
  readonly invokedServices: readonly string[];
  readonly rejectedCards: ReadonlyArray<{
    readonly serviceId: string;
    readonly errors: readonly string[];
  }>;
}

export async function dispatchCdsHook(options: CdsDispatchOptions): Promise<CdsDispatchResult> {
  const now = options.now ?? options.input.now ?? new Date();
  const localMatches = OSOD_DEFAULT_CDS_SERVICES.filter((service) => service.matches(options.input));
  const externalMatches = (options.externalServices ?? []).filter((service) =>
    service.metadata.hookSubscriptions.includes(options.input.hook),
  );
  const invokedServices: string[] = [
    ...localMatches.map((service) => service.discovery.id),
    ...externalMatches.map((service) => service.metadata.serviceId),
  ];
  const auditEvents: OsodAuditEventRow[] = [
    buildOsodAuditEventRow({
      eventType: "cds.hook.fired",
      eventTime: now.toISOString(),
      actorId: options.input.userId,
      actorRole: "clinician",
      patientId: options.input.patientId,
      resourceType: "CDSHook",
      resourceId: options.input.hookInstance,
      policyUrl: CDS_SERVICE_REGISTRY_POLICY_URL,
      actionReason: `CDS hook ${options.input.hook} fired for ${invokedServices.length} service(s).`,
    }),
  ];

  const cards: CdsCard[] = [];
  const rejectedCards: Array<{ serviceId: string; errors: readonly string[] }> = [];
  for (const service of localMatches) {
    const response = await service.invoke({ ...options.input, now });
    acceptServiceCards({
      serviceId: service.discovery.id,
      response,
      now,
      cards,
      auditEvents,
      rejectedCards,
      input: options.input,
    });
  }
  for (const service of externalMatches) {
    const response = await invokeExternalService(service, options, now);
    acceptServiceCards({
      serviceId: service.metadata.serviceId,
      response,
      now,
      cards,
      auditEvents,
      rejectedCards,
      input: options.input,
    });
  }

  return { cards, auditEvents, invokedServices, rejectedCards };
}

async function invokeExternalService(
  service: RegisteredCdsService,
  options: CdsDispatchOptions,
  now: Date,
): Promise<CdsServiceResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const authorization = await options.fhirAuthorizationFor?.(service);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    service.metadata.requestTimeoutSeconds * 1000 || DEFAULT_EXTERNAL_CDS_TIMEOUT_SECONDS * 1000,
  );
  const body: CdsServiceRequestBody = {
    hook: options.input.hook,
    hookInstance: options.input.hookInstance || randomUUID(),
    fhirServer: options.input.fhirServer,
    fhirAuthorization: authorization,
    context: {
      patientId: options.input.patientId,
      encounterId: options.input.encounterId,
      userId: options.input.userId,
      ...options.input.context,
    },
    prefetch: options.input.prefetch,
  };
  try {
    const response = await fetchImpl(service.metadata.endpointUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { cards: [] };
    }
    const json = (await response.json()) as Partial<CdsServiceResponse>;
    return { cards: Array.isArray(json.cards) ? json.cards : [] };
  } finally {
    clearTimeout(timeout);
    void now;
  }
}

function acceptServiceCards(input: {
  readonly serviceId: string;
  readonly response: CdsServiceResponse;
  readonly now: Date;
  readonly cards: CdsCard[];
  readonly auditEvents: OsodAuditEventRow[];
  readonly rejectedCards: Array<{ serviceId: string; errors: readonly string[] }>;
  readonly input: CdsHookEvaluationInput;
}): void {
  const validated = validatedCdsCards(input.response.cards);
  for (const rejection of validated.rejected) {
    input.rejectedCards.push({ serviceId: input.serviceId, errors: rejection.errors });
    input.auditEvents.push(
      buildOsodAuditEventRow({
        eventType: "cds.card.rejected_validation",
        eventTime: input.now.toISOString(),
        actorId: input.input.userId,
        actorRole: "clinician",
        patientId: input.input.patientId,
        resourceType: "CDSCard",
        resourceId: input.serviceId,
        policyUrl: CDS_SERVICE_REGISTRY_POLICY_URL,
        actionOutcome: "denied",
        actionReason: rejection.errors.join("; "),
      }),
    );
  }
  for (const card of validated.accepted) {
    if (!isCdsCardFresh(card, input.now)) {
      input.auditEvents.push(
        buildOsodAuditEventRow({
          eventType: "cds.card.suppressed_stale",
          eventTime: input.now.toISOString(),
          actorId: input.input.userId,
          actorRole: "clinician",
          patientId: input.input.patientId,
          resourceType: "CDSCard",
          resourceId: card.uuid,
          policyUrl: CDS_SERVICE_REGISTRY_POLICY_URL,
          actionOutcome: "denied",
          actionReason: "CDS card TTL expired before rendering.",
        }),
      );
      continue;
    }
    input.cards.push(card);
    input.auditEvents.push(
      buildOsodAuditEventRow({
        eventType: "cds.card.rendered",
        eventTime: input.now.toISOString(),
        actorId: input.input.userId,
        actorRole: "clinician",
        patientId: input.input.patientId,
        resourceType: "CDSCard",
        resourceId: card.uuid,
        policyUrl: CDS_SERVICE_REGISTRY_POLICY_URL,
        actionReason: `CDS card rendered from ${input.serviceId}.`,
      }),
    );
  }
}
