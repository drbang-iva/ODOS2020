import type {
  AuditEvent,
  Bundle,
  DocumentReference,
  Organization,
  Practitioner,
  PractitionerRole,
  Resource,
  ServiceRequest,
} from "@medplum/fhirtypes";
import type { PracticeRoleId } from "../authz/roles.js";
import { CORRESPONDENCE_AUDIT_EVENT_TYPE_SYSTEM } from "../correspondence/correspondence-workflow.js";
import type { FhirSearchParams } from "../fhir-client.js";
import {
  buildInboundReferralServiceRequest,
  INBOUND_REFERRAL_WRITE_HEADERS,
} from "../referral/reciprocal-referral.js";
import { REFERRAL_DIRECTION_CODE_SYSTEM, referralDirectionOf } from "../referral/referral-service.js";
import type {
  WestFaxAdapter,
  WestFaxFaxDescription,
  WestFaxFaxDocument,
  WestFaxFaxIdentifier,
  WestFaxInboundProduct,
} from "./westfax-adapter.js";
import { WESTFAX_INBOUND_BATCH_SIZE } from "./westfax-adapter.js";

export const INBOUND_FAX_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/westfax-inbound-fax";
export const INBOUND_FAX_REFERRAL_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/westfax-inbound-referral";
export const INBOUND_FAX_TRIAGE_STATUS_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/inbound-fax-triage-status";
export const INBOUND_FAX_SENDER_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/inbound-fax-sender-number";
export const INBOUND_FAX_PAGE_COUNT_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/inbound-fax-page-count";
export const INBOUND_FAX_PRODUCT_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/inbound-fax-product-id";
export const INBOUND_FAX_SUGGESTED_PATIENT_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/inbound-fax-suggested-patient";
export const INBOUND_FAX_CALLER_REFERENCE_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/inbound-fax-caller-reference";

export type InboundFaxTriageStatus = "received" | "inbox" | "attached" | "promoted";
export const INBOUND_FAX_TRIAGE_ROLES = ["admin", "provider", "staff"] as const satisfies readonly PracticeRoleId[];

export interface SuggestedFaxPatient {
  reference: string;
  display?: string;
}

export type InboundFaxFhir = {
  read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T>;
  search<T extends Resource>(
    resourceType: T["resourceType"],
    params?: FhirSearchParams,
  ): Promise<Bundle<T>>;
  create<T extends Resource>(resource: T, headers?: Record<string, string>): Promise<T>;
  update<T extends Resource>(
    resourceType: T["resourceType"],
    id: string,
    resource: T,
    headers?: Record<string, string>,
  ): Promise<T>;
};

export interface InboundFaxRunResult {
  faxId: string;
  outcome: "recorded" | "failed";
  documentReference?: string;
  detail?: string;
}

export interface InboundFaxPoller {
  run(): Promise<InboundFaxRunResult[]>;
}

export interface InboundFaxPollerDeps {
  fhir: InboundFaxFhir;
  adapter: WestFaxAdapter;
  now?: () => Date;
  suggestPatient?: (
    fax: WestFaxFaxDescription,
  ) => Promise<SuggestedFaxPatient | undefined>;
  failureThreshold?: number;
  onRepeatedFailure?: (faxId: string, error: Error) => void;
}

export interface InboundFaxWorkerDeps {
  authenticate(): Promise<void>;
  poller: InboundFaxPoller;
  intervalMs?: number;
}

export function createInboundFaxPoller(deps: InboundFaxPollerDeps): InboundFaxPoller {
  const now = deps.now ?? (() => new Date());
  const suggestPatient = deps.suggestPatient
    ?? ((fax: WestFaxFaxDescription) =>
      suggestInboundFaxPatient(deps.fhir, fax.senderNumber, fax.senderIdentifier));
  const failureThreshold = deps.failureThreshold ?? 3;
  const consecutiveFailures = new Map<string, number>();
  if (!Number.isInteger(failureThreshold) || failureThreshold < 1) {
    throw new Error("Inbound fax failureThreshold must be a positive integer.");
  }

  return {
    async run() {
      const results: InboundFaxRunResult[] = [];
      const products = await deps.adapter.getProductsWithInboundFaxes("None");
      for (const product of products) {
        const faxIds = await deps.adapter.getFaxIdentifiers(product.id, "Inbound");
        if (!faxIds.length) continue;
        for (const batch of batches(faxIds, WESTFAX_INBOUND_BATCH_SIZE)) {
          const descriptions = await deps.adapter.getFaxDescriptions(product.id, batch);
          const descriptionsById = new Map(descriptions.map((fax) => [fax.id, fax]));
          for (const faxId of batch) {
            const description = descriptionsById.get(faxId.id);
            try {
              if (!description) {
                throw new Error("WestFax did not return both description and PDF document.");
              }
              const documents = await deps.adapter.getFaxDocuments(product.id, [faxId], "pdf");
              const document = documents.find((fax) => fax.id === faxId.id);
              if (!document) {
                throw new Error("WestFax did not return both description and PDF document.");
              }
              const patientSuggestion = await suggestPatient(description);
              const created = await deps.fhir.create<DocumentReference>(
                buildInboundFaxDocumentReference({
                  product,
                  faxId,
                  description,
                  document,
                  patientSuggestion,
                  recordedAt: now().toISOString(),
                }),
                {
                  "X-ODOS-Source": "mcp/inbound-fax",
                  "If-None-Exist":
                    `identifier=${INBOUND_FAX_IDENTIFIER_SYSTEM}|${faxId.id}`,
                },
              );
              const reference = requiredReference(created, "DocumentReference");
              await deps.adapter.changeFaxFilterValue(product.id, [faxId], "Retrieved");
              consecutiveFailures.delete(faxId.id);
              results.push({
                faxId: faxId.id,
                outcome: "recorded",
                documentReference: reference,
              });
            } catch (error) {
              const failure = asError(error);
              const count = (consecutiveFailures.get(faxId.id) ?? 0) + 1;
              consecutiveFailures.set(faxId.id, count);
              if (count >= failureThreshold) {
                deps.onRepeatedFailure?.(faxId.id, failure);
              }
              results.push({
                faxId: faxId.id,
                outcome: "failed",
                detail: failure.message,
              });
            }
          }
        }
      }
      return results;
    },
  };
}

export async function runInboundFaxSweep(
  deps: Pick<InboundFaxWorkerDeps, "authenticate" | "poller">,
): Promise<InboundFaxRunResult[]> {
  await deps.authenticate();
  return deps.poller.run();
}

export function startInboundFaxWorker(deps: InboundFaxWorkerDeps): NodeJS.Timeout {
  let inFlight = false;
  const run = (): void => {
    if (inFlight) return;
    inFlight = true;
    void runInboundFaxSweep(deps).then((results) => {
      for (const result of results) {
        if (result.outcome === "failed") {
          console.error(
            `odos-mcp: inbound fax ${result.faxId} ingestion failed: ${result.detail ?? "unknown error"}`,
          );
        }
      }
    }).catch((error) => {
      console.error("odos-mcp: inbound fax sweep failed:", error);
    }).finally(() => {
      inFlight = false;
    });
  };
  run();
  const timer = setInterval(run, deps.intervalMs ?? 180_000);
  timer.unref();
  return timer;
}

export function inboundFaxWorkerIntervalMs(value: string | undefined): number {
  if (!value?.trim()) return 180_000;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 15_000) {
    throw new Error("ODOS_INBOUND_FAX_WORKER_MS must be an integer of at least 15,000.");
  }
  return parsed;
}

export function inboundFaxWorkerEnabled(value: string | undefined): boolean {
  return value === "true";
}

export function buildInboundFaxDocumentReference(input: {
  product: WestFaxInboundProduct;
  faxId: WestFaxFaxIdentifier;
  description: WestFaxFaxDescription;
  document: WestFaxFaxDocument;
  patientSuggestion?: SuggestedFaxPatient;
  recordedAt: string;
}): DocumentReference {
  if (input.document.contentType !== "application/pdf") {
    throw new Error("Inbound WestFax documents must be PDF.");
  }
  if (!strictBase64(input.document.fileContents)) {
    throw new Error("Inbound WestFax PDF must contain valid base64 data.");
  }
  const triageStatus: InboundFaxTriageStatus = input.patientSuggestion
    ? "received"
    : "inbox";
  return {
    resourceType: "DocumentReference",
    identifier: [{ system: INBOUND_FAX_IDENTIFIER_SYSTEM, value: input.faxId.id }],
    status: "current",
    docStatus: "final",
    type: { text: "Inbound fax" },
    category: [{ text: "Professional correspondence" }],
    date: input.description.date ?? input.document.date ?? input.recordedAt,
    description: input.description.senderNumber
      ? `Inbound fax from ${input.description.senderNumber}`
      : "Inbound fax",
    content: [{
      attachment: {
        contentType: "application/pdf",
        data: input.document.fileContents,
        title: `inbound-fax-${input.faxId.id}.pdf`,
      },
    }],
    extension: [
      { url: INBOUND_FAX_TRIAGE_STATUS_EXTENSION_URL, valueCode: triageStatus },
      { url: INBOUND_FAX_PRODUCT_EXTENSION_URL, valueString: input.product.id },
      ...(input.description.senderNumber
        ? [{ url: INBOUND_FAX_SENDER_EXTENSION_URL, valueString: input.description.senderNumber }]
        : []),
      ...(input.document.pageCount !== undefined
        ? [{ url: INBOUND_FAX_PAGE_COUNT_EXTENSION_URL, valueInteger: input.document.pageCount }]
        : []),
      ...(input.description.senderIdentifier
        ? [{
            url: INBOUND_FAX_CALLER_REFERENCE_EXTENSION_URL,
            valueString: input.description.senderIdentifier,
          }]
        : []),
      ...(input.patientSuggestion
        ? [{
            url: INBOUND_FAX_SUGGESTED_PATIENT_EXTENSION_URL,
            valueReference: input.patientSuggestion,
          }]
        : []),
    ],
  };
}

export function inboundFaxTriageStatus(
  document: DocumentReference,
): InboundFaxTriageStatus | undefined {
  const value = document.extension?.find(
    (extension) => extension.url === INBOUND_FAX_TRIAGE_STATUS_EXTENSION_URL,
  )?.valueCode;
  return ["received", "inbox", "attached", "promoted"].includes(value ?? "")
    ? value as InboundFaxTriageStatus
    : undefined;
}

export function inboundFaxSenderNumber(document: DocumentReference): string | undefined {
  return document.extension?.find(
    (extension) => extension.url === INBOUND_FAX_SENDER_EXTENSION_URL,
  )?.valueString;
}

export function inboundFaxPageCount(document: DocumentReference): number | undefined {
  return document.extension?.find(
    (extension) => extension.url === INBOUND_FAX_PAGE_COUNT_EXTENSION_URL,
  )?.valueInteger;
}

export function inboundFaxSuggestedPatient(
  document: DocumentReference,
): SuggestedFaxPatient | undefined {
  const reference = document.extension?.find(
    (extension) => extension.url === INBOUND_FAX_SUGGESTED_PATIENT_EXTENSION_URL,
  )?.valueReference;
  return reference?.reference?.startsWith("Patient/")
    ? { reference: reference.reference, ...(reference.display ? { display: reference.display } : {}) }
    : undefined;
}

export class InboundFaxTriageService {
  constructor(
    private readonly fhir: InboundFaxFhir,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async attach(input: {
    faxDocumentReference: string;
    patientReference: string;
    actorReference: string;
    actorRole: PracticeRoleId;
  }): Promise<DocumentReference> {
    assertTriageRole(input.actorRole);
    assertReference(input.patientReference, "Patient");
    const current = await this.readInboundFax(input.faxDocumentReference);
    const updated = await this.updateFax(current, input.patientReference, "attached");
    await this.fhir.create<AuditEvent>(buildInboundFaxAuditEvent({
      action: "attach",
      actorReference: input.actorReference,
      actorRole: input.actorRole,
      patientReference: input.patientReference,
      documentReference: input.faxDocumentReference,
      recordedAt: this.now(),
    }), { "X-ODOS-Source": "mcp/inbound-fax-triage" });
    return updated;
  }

  async promote(input: {
    faxDocumentReference: string;
    patientReference: string;
    patientDisplay: string;
    referrerReference?: string;
    referrerDisplay: string;
    performerReference: string;
    performerDisplay: string;
    reasonText: string;
    actorReference: string;
    actorRole: PracticeRoleId;
  }): Promise<{ documentReference: DocumentReference; serviceRequest: ServiceRequest }> {
    assertTriageRole(input.actorRole);
    const current = await this.readInboundFax(input.faxDocumentReference);
    const priorTriageStatus = inboundFaxTriageStatus(current);
    const faxId = inboundFaxId(current);
    const existingReferral = await findExistingInboundReferral(this.fhir, faxId);
    if (existingReferral?.subject.reference !== undefined
      && existingReferral.subject.reference !== input.patientReference) {
      throw new InboundFaxTriageConflictError(
        `This fax is already promoted to ${existingReferral.subject.reference} and cannot be reassigned to ${input.patientReference}.`,
      );
    }
    const existingReferralReference = existingReferral
      ? requiredReference(existingReferral, "ServiceRequest")
      : undefined;
    const documentReference = await this.updateFax(
      existingReferralReference
        ? {
            ...current,
            context: {
              ...current.context,
              related: [
                ...(current.context?.related ?? []).filter(
                  (reference) => reference.reference !== existingReferralReference,
                ),
                { reference: existingReferralReference },
              ],
            },
          }
        : current,
      input.patientReference,
      "promoted",
    );
    let serviceRequest: ServiceRequest;
    try {
      serviceRequest = await this.fhir.create<ServiceRequest>({
        ...buildInboundReferralServiceRequest({
          subjectReference: input.patientReference,
          subjectDisplay: input.patientDisplay,
          ...(input.referrerReference ? { referrerReference: input.referrerReference } : {}),
          referrerDisplay: input.referrerDisplay,
          performerReference: input.performerReference,
          performerDisplay: input.performerDisplay,
          captureSource: "fax",
          authoredOn: this.now(),
          reasonText: input.reasonText,
        }),
        identifier: [{
          system: INBOUND_FAX_REFERRAL_IDENTIFIER_SYSTEM,
          value: faxId,
        }],
      }, {
        ...INBOUND_REFERRAL_WRITE_HEADERS,
        "If-None-Exist":
          `identifier=${INBOUND_FAX_REFERRAL_IDENTIFIER_SYSTEM}|${faxId}`,
      });
    } catch (createError) {
      try {
        await this.restoreFax(documentReference, current, priorTriageStatus);
      } catch (restoreError) {
        const original = asError(createError);
        const restore = asError(restoreError);
        throw new AggregateError(
          [original, restore],
          `${original.message}; fax triage restore also failed: ${restore.message}`,
          { cause: original },
        );
      }
      throw createError;
    }
    const serviceRequestReference = requiredReference(serviceRequest, "ServiceRequest");
    if (serviceRequest.subject.reference !== input.patientReference) {
      throw new InboundFaxTriageConflictError(
        `This fax is already promoted to ${serviceRequest.subject.reference} and cannot be reassigned to ${input.patientReference}.`,
      );
    }
    await this.fhir.create<AuditEvent>(buildInboundFaxAuditEvent({
      action: "promote",
      actorReference: input.actorReference,
      actorRole: input.actorRole,
      patientReference: input.patientReference,
      documentReference: input.faxDocumentReference,
      serviceRequestReference,
      recordedAt: this.now(),
    }), { "X-ODOS-Source": "mcp/inbound-fax-triage" });
    return { documentReference, serviceRequest };
  }

  async routeToInbox(
    faxDocumentReference: string,
    actorReference: string,
    actorRole: PracticeRoleId,
  ): Promise<DocumentReference> {
    assertTriageRole(actorRole);
    const current = await this.readInboundFax(faxDocumentReference);
    const updated = await this.updateFax(current, current.subject?.reference, "inbox");
    await this.fhir.create<AuditEvent>(buildInboundFaxAuditEvent({
      action: "inbox",
      actorReference,
      actorRole,
      patientReference: current.subject?.reference,
      documentReference: faxDocumentReference,
      recordedAt: this.now(),
    }), { "X-ODOS-Source": "mcp/inbound-fax-triage" });
    return updated;
  }

  async pdf(
    faxDocumentReference: string,
    access?: { actorReference: string; actorRole: PracticeRoleId },
  ): Promise<{
    contentType: "application/pdf";
    data: string;
    filename: string;
  }> {
    const current = await this.readInboundFax(faxDocumentReference);
    const attachment = current.content[0]?.attachment;
    if (attachment?.contentType !== "application/pdf" || !attachment.data) {
      throw new Error("Inbound fax PDF is unavailable.");
    }
    if (access) {
      assertTriageRole(access.actorRole);
      await this.fhir.create<AuditEvent>(buildInboundFaxAuditEvent({
        action: "read",
        actorReference: access.actorReference,
        actorRole: access.actorRole,
        patientReference: current.subject?.reference,
        documentReference: faxDocumentReference,
        recordedAt: this.now(),
      }), { "X-ODOS-Source": "mcp/inbound-fax-triage" });
    }
    return {
      contentType: "application/pdf",
      data: attachment.data,
      filename: attachment.title ?? "inbound-fax.pdf",
    };
  }

  private async readInboundFax(reference: string): Promise<DocumentReference> {
    assertReference(reference, "DocumentReference");
    const document = await this.fhir.read<DocumentReference>(
      "DocumentReference",
      reference.slice("DocumentReference/".length),
    );
    inboundFaxId(document);
    return document;
  }

  private async updateFax(
    current: DocumentReference,
    patientReference: string | undefined,
    status: InboundFaxTriageStatus,
  ): Promise<DocumentReference> {
    if (!current.id) throw new Error("Inbound fax DocumentReference has no id.");
    const versionId = current.meta?.versionId;
    if (!versionId) throw new Error("Inbound fax DocumentReference has no version for safe update.");
    try {
      return await this.fhir.update(
        "DocumentReference",
        current.id,
        {
          ...current,
          ...(patientReference ? { subject: { reference: patientReference } } : {}),
          extension: [
            ...(current.extension ?? []).filter(
              (extension) => extension.url !== INBOUND_FAX_TRIAGE_STATUS_EXTENSION_URL,
            ),
            { url: INBOUND_FAX_TRIAGE_STATUS_EXTENSION_URL, valueCode: status },
          ],
        },
        {
          "X-ODOS-Source": "mcp/inbound-fax-triage",
          "If-Match": `W/"${versionId}"`,
        },
      );
    } catch (error) {
      if (errorStatus(error) === 409 || errorStatus(error) === 412) {
        throw new InboundFaxTriageConflictError(
          "This inbound fax was changed by another staff member. Reload the Desk and try again.",
        );
      }
      throw error;
    }
  }

  private async restoreFax(
    current: DocumentReference,
    prior: DocumentReference,
    priorStatus: InboundFaxTriageStatus | undefined,
  ): Promise<DocumentReference> {
    if (!current.id) throw new Error("Inbound fax DocumentReference has no id.");
    const versionId = current.meta?.versionId;
    if (!versionId) throw new Error("Inbound fax DocumentReference has no version for safe update.");
    const { subject: _promotedSubject, ...withoutSubject } = current;
    return this.fhir.update(
      "DocumentReference",
      current.id,
      {
        ...withoutSubject,
        ...(prior.subject ? { subject: prior.subject } : {}),
        extension: [
          ...(current.extension ?? []).filter(
            (extension) => extension.url !== INBOUND_FAX_TRIAGE_STATUS_EXTENSION_URL,
          ),
          ...(priorStatus
            ? [{ url: INBOUND_FAX_TRIAGE_STATUS_EXTENSION_URL, valueCode: priorStatus }]
            : []),
        ],
      },
      {
        "X-ODOS-Source": "mcp/inbound-fax-triage",
        "If-Match": `W/"${versionId}"`,
      },
    );
  }
}

export class InboundFaxTriageConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboundFaxTriageConflictError";
  }
}

export function buildInboundFaxAuditEvent(input: {
  action: "read" | "inbox" | "attach" | "promote";
  actorReference: string;
  actorRole: PracticeRoleId;
  patientReference?: string;
  documentReference: string;
  serviceRequestReference?: string;
  recordedAt: string;
}): AuditEvent {
  assertReference(input.actorReference, ["Practitioner", "PractitionerRole"]);
  if (input.patientReference) assertReference(input.patientReference, "Patient");
  assertReference(input.documentReference, "DocumentReference");
  if (input.serviceRequestReference) {
    assertReference(input.serviceRequestReference, "ServiceRequest");
  }
  return {
    resourceType: "AuditEvent",
    type: {
      system: CORRESPONDENCE_AUDIT_EVENT_TYPE_SYSTEM,
      code: `correspondence.inbound-fax-${input.action}`,
      display: `Correspondence inbound fax ${input.action}`,
    },
    action: input.action === "read" ? "R" : "U",
    recorded: input.recordedAt,
    outcome: "0",
    agent: [{
      who: { reference: input.actorReference },
      role: [{ text: input.actorRole }],
      requestor: true,
    }],
    source: { observer: { reference: "Device/odos-instance" } },
    entity: [
      ...(input.patientReference
        ? [{ what: { reference: input.patientReference }, name: "patient" }]
        : []),
      { what: { reference: input.documentReference }, name: "inbound-fax" },
      ...(input.serviceRequestReference
        ? [{ what: { reference: input.serviceRequestReference }, name: "inbound-referral" }]
        : []),
    ],
  };
}

export async function suggestInboundFaxPatient(
  fhir: Pick<InboundFaxFhir, "search">,
  senderNumber: string | undefined,
  senderIdentifier?: string,
): Promise<SuggestedFaxPatient | undefined> {
  const normalizedSender = normalizePhone(senderNumber);
  const senderName = senderIdentifier?.trim().replace(/\s+/g, " ");
  if (!normalizedSender && !senderName) return undefined;
  // Organization has no telecom search parameter; CSID name matching below supplies that path.
  const [practitioners, practitionerRoles] = await Promise.all([
    normalizedSender ? searchCompleteResources<Practitioner>(fhir, "Practitioner", {
      telecom: `fax|${normalizedSender}`,
      _count: "200",
    }) : [],
    normalizedSender ? searchCompleteResources<PractitionerRole>(fhir, "PractitionerRole", {
      telecom: `fax|${normalizedSender}`,
      _count: "200",
    }) : [],
  ]);
  if (!practitioners || !practitionerRoles) return undefined;
  const referrerReferences = new Set(
    [...practitioners, ...practitionerRoles]
      .filter((resource) =>
        resource.telecom?.some(
          (contact) =>
            contact.system === "fax"
            && normalizePhone(contact.value) === normalizedSender,
        ))
      .flatMap((resource) =>
        resource.id ? [`${resource.resourceType}/${resource.id}`] : []),
  );
  if (senderName && !referrerReferences.size) {
    const params = { name: senderName.replace(/[\\,$|]/g, "\\$&"), _count: "200" };
    const [namedPractitioners, organizations] = await Promise.all([
      // HumanName search indexes name parts; whole-name equality is checked locally below.
      searchCompleteResources<Practitioner>(fhir, "Practitioner", {
        ...params, name: senderName.split(" ")[0]!.replace(/[\\,$|]/g, "\\$&"),
      }),
      searchCompleteResources<Organization>(fhir, "Organization", params),
    ]);
    if (!namedPractitioners || !organizations) return undefined;
    const normalizedName = senderName.toLowerCase();
    for (const resource of [...namedPractitioners, ...organizations]) {
      const names = resource.resourceType === "Organization"
        ? [resource.name, ...(resource.alias ?? [])]
        : (resource.name ?? []).flatMap((name) => [name.text, [...(name.given ?? []), name.family].filter(Boolean).join(" ")]);
      if (resource.id && names.some((name) => name?.trim().replace(/\s+/g, " ").toLowerCase() === normalizedName)) {
        referrerReferences.add(`${resource.resourceType}/${resource.id}`);
      }
    }
  }
  if (!referrerReferences.size) return undefined;
  const inbound = await searchCompleteResources<ServiceRequest>(fhir, "ServiceRequest", {
    category: `${REFERRAL_DIRECTION_CODE_SYSTEM}|inbound`,
    requester: [...referrerReferences].join(","),
    _sort: "-authored",
    _count: "200",
  });
  if (!inbound) return undefined;
  const candidates = new Map<string, SuggestedFaxPatient>();
  for (const request of inbound) {
    const patientReference = request.subject.reference;
    if (
      referralDirectionOf(request) === "inbound"
      && request.requester?.reference
      && referrerReferences.has(request.requester.reference)
      && patientReference?.startsWith("Patient/")
    ) {
      candidates.set(patientReference, {
        reference: patientReference,
        ...(request.subject.display ? { display: request.subject.display } : {}),
      });
    }
  }
  return candidates.size === 1 ? [...candidates.values()][0] : undefined;
}

async function searchCompleteResources<T extends Resource>(
  fhir: Pick<InboundFaxFhir, "search">,
  resourceType: T["resourceType"],
  params: FhirSearchParams,
): Promise<T[] | undefined> {
  // search-contract: inbound-fax.search-resource
  const bundle = await fhir.search<T>(resourceType, params);
  const resources = (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []);
  const hasNext = bundle.link?.some((link) => link.relation === "next") ?? false;
  if (hasNext || (bundle.total !== undefined && bundle.total > resources.length)) return undefined;
  return resources;
}

async function findExistingInboundReferral(
  fhir: Pick<InboundFaxFhir, "search">,
  faxId: string,
): Promise<ServiceRequest | undefined> {
  const resourceType: ServiceRequest["resourceType"] = "ServiceRequest";
  const params: FhirSearchParams = {
    identifier: `${INBOUND_FAX_REFERRAL_IDENTIFIER_SYSTEM}|${faxId}`,
    _count: "2",
  };
  let bundle: Bundle<ServiceRequest>;
  try {
    // search-contract: inbound-fax.find-referral
    bundle = await fhir.search<ServiceRequest>(resourceType, params);
  } catch {
    throw new InboundFaxTriageConflictError(
      "Could not verify whether this fax already has a referral. No changes were made.",
    );
  }
  const entries = bundle.entry ?? [];
  const referrals = entries.flatMap((entry) => entry.resource ? [entry.resource] : []);
  const hasNext = bundle.link?.some((link) => link.relation === "next") ?? false;
  if (referrals.length > 1 || (bundle.total !== undefined && bundle.total > 1) || hasNext) {
    throw new InboundFaxTriageConflictError(
      "More than one referral uses this fax identifier. No changes were made.",
    );
  }
  if (referrals.length !== entries.length
    || (bundle.total !== undefined && bundle.total > referrals.length)) {
    throw new InboundFaxTriageConflictError(
      "Could not verify whether this fax already has a referral. No changes were made.",
    );
  }
  return referrals[0];
}

function inboundFaxId(document: DocumentReference): string {
  const value = document.identifier?.find(
    (identifier) => identifier.system === INBOUND_FAX_IDENTIFIER_SYSTEM,
  )?.value;
  if (!value) throw new Error("DocumentReference is not an inbound WestFax record.");
  return value;
}

function requiredReference(
  resource: { resourceType: string; id?: string },
  expectedType: string,
): string {
  if (resource.resourceType !== expectedType || !resource.id) {
    throw new Error(`${expectedType} create response did not include an id.`);
  }
  return `${expectedType}/${resource.id}`;
}

function assertTriageRole(role: PracticeRoleId): void {
  if (!INBOUND_FAX_TRIAGE_ROLES.includes(role)) {
    throw new Error("Correspondence staff role required.");
  }
}

function assertReference(
  value: string,
  resourceType: string | readonly string[],
): void {
  const types = Array.isArray(resourceType) ? resourceType : [resourceType];
  if (!types.some((type) => new RegExp(`^${type}/[A-Za-z0-9.-]{1,64}$`).test(value))) {
    throw new Error(`A valid ${types.join(" or ")} reference is required.`);
  }
}

function strictBase64(value: string): boolean {
  const normalized = value.replace(/\s+/g, "");
  return normalized.length > 0
    && normalized.length % 4 === 0
    && /^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
    && Buffer.from(normalized, "base64").toString("base64") === normalized;
}

function normalizePhone(value: string | undefined): string | undefined {
  const digits = value?.replace(/\D/g, "");
  return digits && digits.length >= 7 ? digits.slice(-10) : undefined;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function errorStatus(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null || !("status" in value)) return undefined;
  return typeof value.status === "number" ? value.status : undefined;
}

function batches<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}
