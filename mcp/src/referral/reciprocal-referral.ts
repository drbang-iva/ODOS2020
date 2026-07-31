import type {
  Bundle,
  DocumentReference,
  Encounter,
  Resource,
  ServiceRequest,
} from "@medplum/fhirtypes";
import type { FhirSearchParams } from "../fhir-client.js";
import { CONSULT_NOTE_LOINC_CODE } from "../correspondence/correspondence-document.js";
import {
  buildReferralIncludeListExtension,
  REFERRAL_DIRECTION_CODE_SYSTEM,
  referralDirectionOf,
  type ReferralIncludeList,
} from "./referral-service.js";

export const REFERRAL_CAPTURE_SOURCE_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/referral-capture-source";
export const INBOUND_REFERRAL_WRITE_HEADERS = {
  "X-ODOS-Source": "mcp/inbound-referral",
} as const;

export type InboundReferralCaptureSource = "front-desk" | "fax" | "chart";

export interface CreateInboundReferralInput {
  subjectReference: string;
  subjectDisplay: string;
  referrerReference?: string;
  referrerDisplay: string;
  performerReference: string;
  performerDisplay: string;
  captureSource: InboundReferralCaptureSource;
  authoredOn?: string;
  reasonText: string;
}

export interface ReferralReplyWorklistRow {
  serviceRequestReference: string;
  patientReference: string;
  patientDisplay?: string;
  referrerDisplay: string;
  authoredOn?: string;
  encounterReference: string;
  status: "open";
}

interface ReciprocalFhirClient {
  search<T extends Resource>(
    resourceType: T["resourceType"],
    params?: FhirSearchParams,
  ): Promise<Bundle<T>>;
  create<T extends Resource>(resource: T, headers?: Record<string, string>): Promise<T>;
}

const DEFAULT_INBOUND_INCLUDE_LIST: ReferralIncludeList = {
  letter: true,
  demographics: true,
  history: true,
  clinical_summary: true,
  images: false,
  hipaa_cover_sheet: false,
  history_count: 3,
};

export function buildInboundReferralServiceRequest(
  input: Omit<CreateInboundReferralInput, "authoredOn"> & { authoredOn: string },
): ServiceRequest {
  assertReference(input.subjectReference, "Patient");
  assertOptionalReferrerReference(input.referrerReference);
  assertProviderReference(input.performerReference);
  if (!input.referrerDisplay.trim()) throw new Error("Inbound referral requires a referrer.");
  if (!input.performerDisplay.trim()) throw new Error("Inbound referral requires a receiving provider.");
  if (!input.reasonText.trim()) throw new Error("Inbound referral requires an explicit consult question.");
  return {
    resourceType: "ServiceRequest",
    status: "active",
    intent: "order",
    code: { text: "Inbound consultation referral" },
    category: [{
      coding: [{
        system: REFERRAL_DIRECTION_CODE_SYSTEM,
        code: "inbound",
        display: "Inbound referral",
      }],
      text: "Inbound referral",
    }],
    subject: {
      reference: input.subjectReference,
      display: input.subjectDisplay.trim() || input.subjectReference,
    },
    authoredOn: input.authoredOn,
    requester: {
      ...(input.referrerReference ? { reference: input.referrerReference } : {}),
      display: input.referrerDisplay.trim(),
    },
    performer: [{
      reference: input.performerReference,
      display: input.performerDisplay.trim(),
    }],
    reasonCode: [{ text: input.reasonText.trim() }],
    extension: [
      buildReferralIncludeListExtension(DEFAULT_INBOUND_INCLUDE_LIST),
      { url: REFERRAL_CAPTURE_SOURCE_EXTENSION_URL, valueCode: input.captureSource },
    ],
  };
}

export class InboundReferralService {
  constructor(
    private readonly fhir: Pick<ReciprocalFhirClient, "create">,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async create(input: CreateInboundReferralInput): Promise<ServiceRequest> {
    return this.fhir.create(
      buildInboundReferralServiceRequest({
        ...input,
        authoredOn: input.authoredOn ?? this.now(),
      }),
      INBOUND_REFERRAL_WRITE_HEADERS,
    );
  }
}

export class ReferralReplyWorklist {
  constructor(private readonly fhir: Pick<ReciprocalFhirClient, "search">) {}

  async list(): Promise<ReferralReplyWorklistRow[]> {
    const inboundBundle = await this.fhir.search<ServiceRequest>("ServiceRequest", {
      category: `${REFERRAL_DIRECTION_CODE_SYSTEM}|inbound`,
      status: "active",
      _sort: "authored",
      _count: "200",
    });
    const inbound = resources(inboundBundle)
      .filter((request) => referralDirectionOf(request) === "inbound")
      .filter((request) => request.status === "active" && Boolean(request.id));
    const rows = await Promise.all(inbound.map((request) => this.replyRow(request)));
    return rows
      .filter((row): row is ReferralReplyWorklistRow => Boolean(row))
      .sort((left, right) => (left.authoredOn ?? "").localeCompare(right.authoredOn ?? ""));
  }

  private async replyRow(
    request: ServiceRequest,
  ): Promise<ReferralReplyWorklistRow | undefined> {
    const reference = `ServiceRequest/${request.id}`;
    const encounterBundle = await this.fhir.search<Encounter>("Encounter", {
      patient: request.subject.reference!.slice("Patient/".length),
      status: "finished",
      _sort: "-date",
      _count: "20",
    });
    const encounter = resources(encounterBundle)
      .filter((candidate) =>
        candidate.status === "finished"
        && candidate.subject?.reference === request.subject.reference
        && encounterDate(candidate) >= (request.authoredOn ?? ""))
      .sort((left, right) => encounterDate(right).localeCompare(encounterDate(left)))[0];
    if (!encounter?.id) return undefined;

    const reportBundle = await this.fhir.search<DocumentReference>("DocumentReference", {
      related: reference,
      type: `http://loinc.org|${CONSULT_NOTE_LOINC_CODE}`,
      status: "current",
      _sort: "-date",
      _count: "2",
    });
    const alreadyReplied = resources(reportBundle).some((document) =>
      document.status === "current"
      && document.docStatus === "final"
      && document.type?.coding?.some(
        (coding) =>
          coding.system === "http://loinc.org"
          && coding.code === CONSULT_NOTE_LOINC_CODE,
      )
      && document.context?.related?.some((related) => related.reference === reference));
    if (alreadyReplied) return undefined;

    return {
      serviceRequestReference: reference,
      patientReference: request.subject.reference!,
      ...(request.subject.display ? { patientDisplay: request.subject.display } : {}),
      referrerDisplay:
        request.requester?.display
        ?? request.requester?.reference
        ?? "Referrer",
      ...(request.authoredOn ? { authoredOn: request.authoredOn } : {}),
      encounterReference: `Encounter/${encounter.id}`,
      status: "open",
    };
  }
}

function resources<T extends Resource>(bundle: Bundle<T>): T[] {
  return (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []);
}

function encounterDate(encounter: Encounter): string {
  return encounter.period?.end
    ?? encounter.period?.start
    ?? encounter.meta?.lastUpdated
    ?? "";
}

function assertReference(reference: string, resourceType: string): void {
  if (!new RegExp(`^${resourceType}/[A-Za-z0-9.-]{1,64}$`).test(reference)) {
    throw new Error(`A valid ${resourceType} reference is required.`);
  }
}

function assertProviderReference(reference: string): void {
  if (!/^(Practitioner|PractitionerRole)\/[A-Za-z0-9.-]{1,64}$/.test(reference)) {
    throw new Error("Inbound referral performer must be a provider reference.");
  }
}

function assertOptionalReferrerReference(reference: string | undefined): void {
  if (
    reference
    && !/^(Practitioner|PractitionerRole|Organization)\/[A-Za-z0-9.-]{1,64}$/.test(reference)
  ) {
    throw new Error("Inbound referral requester must be a directory reference.");
  }
}
