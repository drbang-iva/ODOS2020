import type {
  AllergyIntolerance,
  Bundle,
  CarePlan,
  Condition,
  Encounter,
  Extension,
  HumanName,
  Media,
  MedicationRequest,
  MedicationStatement,
  Observation,
  Organization,
  Patient,
  Practitioner,
  PractitionerRole,
  Provenance,
  Resource,
  ServiceRequest,
} from "@medplum/fhirtypes";
import type { FhirSearchParams } from "../fhir-client.js";
import type { CorrespondenceTokenContext } from "../correspondence/tokens/types.js";

export const REFERRAL_INCLUDE_LIST_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/referral-include-list";
export const REFERRAL_LETTER_BODY_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/referral-letter-body";
export const REFERRAL_DIRECTION_CODE_SYSTEM =
  "https://odos2020.com/fhir/CodeSystem/referral-direction";
export const REFERRAL_MEDIA_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const REFERRAL_MEDIA_MAX_TOTAL_BYTES = 25 * 1024 * 1024;

const INCLUDE_FLAG_NAMES = [
  "letter",
  "demographics",
  "history",
  "clinical_summary",
  "images",
  "hipaa_cover_sheet",
] as const;

export interface ReferralIncludeList {
  letter: boolean;
  demographics: boolean;
  history: boolean;
  clinical_summary: boolean;
  images: boolean;
  hipaa_cover_sheet: boolean;
  history_count: number;
}

export interface ReferralFhirClient {
  read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T>;
  readBinaryData?(id: string): Promise<{ contentType: string; bytes: Uint8Array }>;
  search<T extends Resource>(
    resourceType: T["resourceType"],
    params?: FhirSearchParams,
  ): Promise<Bundle<T>>;
  create<T extends Resource>(resource: T, extraHeaders?: Record<string, string>): Promise<T>;
  update<T extends Resource>(
    resourceType: T["resourceType"],
    id: string,
    resource: T,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
  executeTransaction(bundle: Bundle, extraHeaders?: Record<string, string>): Promise<Bundle>;
}

export type ReferralPriority = "routine" | "urgent" | "stat";

export class ReferralSendConflictError extends Error {}

interface ReferralImage {
  media: Media;
  missing?: string;
}

export interface ReferralServiceOptions {
  storageBaseUrls?: readonly string[];
}

export interface CreateReferralInput {
  subjectReference: string;
  requesterReference: string;
  requesterDisplay?: string;
  targetReference: string;
  encounterReference: string;
  includeList: ReferralIncludeList;
  priority?: ReferralPriority;
  reasonText?: string;
  authoredOn?: string;
}

export interface UpdateReferralDraftInput {
  targetReference?: string;
  includeList?: ReferralIncludeList;
  priority?: ReferralPriority;
  reasonText?: string | null;
  letterBody?: string;
}

export interface GenerateReferralLetterInput {
  patientDisplay: string;
  targetDisplay: string;
  requesterDisplay?: string;
  findings: readonly Observation[];
  plans: readonly CarePlan[];
}

export function buildReferralServiceRequest(input: {
  subjectReference: string;
  subjectDisplay: string;
  requesterReference: string;
  requesterDisplay?: string;
  targetReference: string;
  targetDisplay: string;
  encounterReference: string;
  includeList: ReferralIncludeList;
  letterBody: string;
  authoredOn: string;
  priority?: ReferralPriority;
  reasonText?: string;
}): ServiceRequest {
  assertReference(input.subjectReference, "Patient");
  assertReference(input.encounterReference, "Encounter");
  assertRequesterReference(input.requesterReference);
  assertTargetReference(input.targetReference);
  validateIncludeList(input.includeList);

  return {
    resourceType: "ServiceRequest",
    status: "draft",
    intent: "order",
    code: { text: "Specialist referral" },
    category: [{
      coding: [{
        system: REFERRAL_DIRECTION_CODE_SYSTEM,
        code: "outbound",
        display: "Outbound referral",
      }],
      text: "Outbound referral",
    }],
    ...(input.priority ? { priority: input.priority } : {}),
    ...(input.reasonText ? { reasonCode: [{ text: input.reasonText }] } : {}),
    subject: { reference: input.subjectReference, display: input.subjectDisplay },
    encounter: { reference: input.encounterReference },
    authoredOn: input.authoredOn,
    requester: {
      reference: input.requesterReference,
      ...(input.requesterDisplay ? { display: input.requesterDisplay } : {}),
    },
    performer: [{ reference: input.targetReference, display: input.targetDisplay }],
    extension: [
      buildReferralIncludeListExtension(input.includeList),
      { url: REFERRAL_LETTER_BODY_EXTENSION_URL, valueString: input.letterBody },
    ],
  };
}

export function referralDirectionOf(
  serviceRequest: ServiceRequest,
): "inbound" | "outbound" | undefined {
  const code = serviceRequest.category?.flatMap((category) => category.coding ?? [])
    .find((coding) => coding.system === REFERRAL_DIRECTION_CODE_SYSTEM)?.code;
  return code === "inbound" || code === "outbound" ? code : undefined;
}

export function readReferralIncludeList(serviceRequest: ServiceRequest): ReferralIncludeList {
  const includeList = serviceRequest.extension?.find(
    (extension) => extension.url === REFERRAL_INCLUDE_LIST_EXTENSION_URL,
  );
  if (!includeList) throw new Error("Referral ServiceRequest is missing its structured include-list extension.");

  return readReferralIncludeListExtension(includeList);
}

export function readReferralIncludeListExtension(includeList: Extension): ReferralIncludeList {
  const flags = Object.fromEntries(INCLUDE_FLAG_NAMES.map((name) => {
    const value = includeList.extension?.find((extension) => extension.url === name)?.valueBoolean;
    if (value === undefined) throw new Error(`Referral include-list is missing ${name}.`);
    return [name, value];
  })) as Pick<ReferralIncludeList, (typeof INCLUDE_FLAG_NAMES)[number]>;
  const historyCount = includeList.extension?.find(
    (extension) => extension.url === "history_count",
  )?.valuePositiveInt;
  if (historyCount === undefined) throw new Error("Referral include-list is missing history_count.");

  const value = { ...flags, history_count: historyCount };
  validateIncludeList(value);
  return value;
}

export function generateReferralLetterBody(input: GenerateReferralLetterInput): string {
  const findings = referralFindingLines(input.findings);
  const plans = referralPlanLines(input.plans);

  return [
    `Dear ${input.targetDisplay},`,
    "",
    `I am referring ${input.patientDisplay} for evaluation and management.`,
    "",
    "Findings:",
    ...(findings.length ? findings.map((line) => `- ${line}`) : ["- No visit findings were recorded."]),
    "",
    "Plan:",
    ...(plans.length ? plans.map((line) => `- ${line}`) : ["- No visit plan was recorded."]),
    "",
    "Sincerely,",
    input.requesterDisplay ?? "Referring provider",
  ].join("\n");
}

export class ReferralService {
  private readonly storageBaseUrls: readonly string[];

  constructor(
    private readonly fhir: ReferralFhirClient,
    private readonly now: () => string = () => new Date().toISOString(),
    options: ReferralServiceOptions = {},
  ) {
    this.storageBaseUrls = options.storageBaseUrls ?? defaultReferralStorageBaseUrls();
  }

  async createReferral(input: CreateReferralInput): Promise<ServiceRequest> {
    const patientId = assertReference(input.subjectReference, "Patient");
    const encounterId = assertReference(input.encounterReference, "Encounter");
    const [patient, encounter, target, findings, plans] = await Promise.all([
      this.fhir.read<Patient>("Patient", patientId),
      this.fhir.read<Encounter>("Encounter", encounterId),
      readReferralTarget(this.fhir, input.targetReference),
      this.searchEncounterResources<Observation>("Observation", patientId, encounterId),
      this.searchEncounterResources<CarePlan>("CarePlan", patientId, encounterId),
    ]);
    if (encounter.subject?.reference !== input.subjectReference) {
      throw new Error("Referral encounter does not belong to the subject patient.");
    }
    const patientDisplay = patientName(patient);
    const targetDisplay = referralTargetDisplay(target);
    const letterBody = generateReferralLetterBody({
      patientDisplay,
      targetDisplay,
      requesterDisplay: input.requesterDisplay,
      findings,
      plans,
    });

    return this.fhir.create<ServiceRequest>(buildReferralServiceRequest({
      ...input,
      subjectDisplay: patientDisplay,
      targetDisplay,
      letterBody,
      authoredOn: input.authoredOn ?? this.now(),
    }), { "X-ODOS-Source": "mcp/referral-send" });
  }

  async prepareReferralSend(
    serviceRequest: ServiceRequest,
    editedLetterBody?: string,
  ): Promise<ServiceRequest> {
    assertDraftReferral(serviceRequest);
    if (editedLetterBody === undefined) return serviceRequest;
    const id = referralId(serviceRequest);
    const versionId = referralVersionId(serviceRequest);
    try {
      return await this.fhir.update<ServiceRequest>(
        "ServiceRequest",
        id,
        {
          ...serviceRequest,
          extension: replaceExtension(serviceRequest.extension, {
            url: REFERRAL_LETTER_BODY_EXTENSION_URL,
            valueString: editedLetterBody,
          }),
        },
        {
          "X-ODOS-Source": "mcp/referral-send",
          "If-Match": `W/"${versionId}"`,
        },
      );
    } catch (error) {
      throwReferralConflict(error);
    }
  }

  async updateReferralDraft(
    serviceRequest: ServiceRequest,
    input: UpdateReferralDraftInput,
  ): Promise<ServiceRequest> {
    assertDraftReferral(serviceRequest);
    const id = referralId(serviceRequest);
    const versionId = referralVersionId(serviceRequest);
    const target = input.targetReference
      ? await readReferralTarget(this.fhir, input.targetReference)
      : undefined;
    const updated: ServiceRequest = {
      ...serviceRequest,
      ...(input.targetReference && target ? {
        performer: [{
          reference: input.targetReference,
          display: referralTargetDisplay(target),
        }],
      } : {}),
      ...(input.includeList ? {
        extension: replaceExtension(
          serviceRequest.extension,
          buildReferralIncludeListExtension(input.includeList),
        ),
      } : {}),
      ...(input.priority ? { priority: input.priority } : {}),
      ...(input.letterBody !== undefined ? {
        extension: replaceExtension(
          input.includeList
            ? replaceExtension(
                serviceRequest.extension,
                buildReferralIncludeListExtension(input.includeList),
              )
            : serviceRequest.extension,
          {
            url: REFERRAL_LETTER_BODY_EXTENSION_URL,
            valueString: input.letterBody,
          },
        ),
      } : {}),
    };
    if (input.reasonText !== undefined) {
      const reasonText = input.reasonText?.trim();
      if (reasonText) updated.reasonCode = [{ text: reasonText }];
      else delete updated.reasonCode;
    }
    try {
      return await this.fhir.update<ServiceRequest>(
        "ServiceRequest",
        id,
        updated,
        {
          "X-ODOS-Source": "mcp/referral-send",
          "If-Match": `W/"${versionId}"`,
        },
      );
    } catch (error) {
      throwReferralConflict(error);
    }
  }

  async regenerateReferralLetter(serviceRequest: ServiceRequest): Promise<ServiceRequest> {
    assertDraftReferral(serviceRequest);
    const id = referralId(serviceRequest);
    const versionId = referralVersionId(serviceRequest);
    const patientId = assertReference(serviceRequest.subject.reference, "Patient");
    const encounterId = serviceRequest.encounter?.reference
      ? assertReference(serviceRequest.encounter.reference, "Encounter")
      : undefined;
    if (!encounterId) throw new Error("Referral ServiceRequest is missing its encounter reference.");
    const targetReference = serviceRequest.performer?.[0]?.reference;
    if (!targetReference) throw new Error("Referral ServiceRequest is missing its target reference.");
    const [patient, encounter, target, findings, plans] = await Promise.all([
      this.fhir.read<Patient>("Patient", patientId),
      this.fhir.read<Encounter>("Encounter", encounterId),
      readReferralTarget(this.fhir, targetReference),
      this.searchEncounterResources<Observation>("Observation", patientId, encounterId),
      this.searchEncounterResources<CarePlan>("CarePlan", patientId, encounterId),
    ]);
    if (encounter.subject?.reference !== serviceRequest.subject.reference) {
      throw new Error("Referral encounter does not belong to the subject patient.");
    }
    const letterBody = generateReferralLetterBody({
      patientDisplay: patientName(patient),
      targetDisplay: referralTargetDisplay(target),
      requesterDisplay: serviceRequest.requester?.display,
      findings,
      plans,
    });
    try {
      return await this.fhir.update<ServiceRequest>(
        "ServiceRequest",
        id,
        {
          ...serviceRequest,
          performer: [{
            reference: targetReference,
            display: referralTargetDisplay(target),
          }],
          extension: replaceExtension(serviceRequest.extension, {
            url: REFERRAL_LETTER_BODY_EXTENSION_URL,
            valueString: letterBody,
          }),
        },
        {
          "X-ODOS-Source": "mcp/referral-send",
          "If-Match": `W/"${versionId}"`,
        },
      );
    } catch (error) {
      throwReferralConflict(error);
    }
  }

  async commitReferralSend(
    serviceRequest: ServiceRequest,
    provenance: Provenance,
  ): Promise<{ serviceRequest: ServiceRequest; provenanceReference?: string }> {
    assertDraftReferral(serviceRequest);
    const id = referralId(serviceRequest);
    const versionId = referralVersionId(serviceRequest);
    const activeServiceRequest: ServiceRequest = { ...serviceRequest, status: "active" };
    let response: Bundle;
    try {
      response = await this.fhir.executeTransaction({
        resourceType: "Bundle",
        type: "transaction",
        entry: [
          {
            resource: activeServiceRequest,
            request: {
              method: "PUT",
              url: `ServiceRequest/${id}`,
              ifMatch: `W/"${versionId}"`,
            },
          },
          {
            resource: provenance,
            request: { method: "POST", url: "Provenance" },
          },
        ],
      }, { "X-ODOS-Source": "mcp/referral-send" });
    } catch (error) {
      throwReferralConflict(error);
    }
    const provenanceId = transactionResponseId(response, 1, "Provenance");
    return {
      serviceRequest: activeServiceRequest,
      ...(provenanceId ? { provenanceReference: `Provenance/${provenanceId}` } : {}),
    };
  }

  async assembleReferralArtifact(
    serviceRequestId: string,
    options: { editedLetterBody?: string } = {},
  ): Promise<string> {
    const serviceRequest = await this.fhir.read<ServiceRequest>("ServiceRequest", serviceRequestId);
    return this.assembleReferralArtifactFrom(serviceRequest, options);
  }

  async assembleReferralArtifactFrom(
    serviceRequest: ServiceRequest,
    options: { editedLetterBody?: string } = {},
  ): Promise<string> {
    const serviceRequestId = referralId(serviceRequest);
    const includeList = readReferralIncludeList(serviceRequest);
    const patientId = assertReference(serviceRequest.subject.reference, "Patient");
    const encounterId = serviceRequest.encounter?.reference
      ? assertReference(serviceRequest.encounter.reference, "Encounter")
      : undefined;
    const targetDisplay = referralTargetSnapshot(serviceRequest);
    const patientDisplay = serviceRequest.subject.display?.trim() || `Patient/${patientId}`;

    const [patient, history, clinicalSummary, images] = await Promise.all([
      includeList.demographics ? this.fhir.read<Patient>("Patient", patientId) : undefined,
      includeList.history
        ? this.loadFinalizedHistory(patientId, encounterId, includeList.history_count)
        : [],
      includeList.clinical_summary ? this.loadClinicalSummary(patientId) : undefined,
      includeList.images ? this.loadImages(patientId, encounterId) : [],
    ]);

    const letterBody = options.editedLetterBody ?? referralLetterBody(serviceRequest);
    const sections = [
      includeList.hipaa_cover_sheet
        ? renderCoverSheet(targetDisplay, patientDisplay)
        : "",
      includeList.letter ? renderLetter(letterBody) : "",
      includeList.demographics && patient ? renderDemographics(patient) : "",
      includeList.history ? renderHistory(history) : "",
      includeList.clinical_summary && clinicalSummary ? renderClinicalSummary(clinicalSummary) : "",
      includeList.images ? renderImages(images) : "",
    ].filter(Boolean).join("\n");

    return renderDocument({
      serviceRequestId,
      authoredOn: serviceRequest.authoredOn,
      patientDisplay,
      targetDisplay,
      sections,
    });
  }

  async loadCorrespondenceTokenContext(
    serviceRequest: ServiceRequest,
    practicePhone: string,
  ): Promise<CorrespondenceTokenContext> {
    const includeList = readReferralIncludeList(serviceRequest);
    const patientId = assertReference(serviceRequest.subject.reference, "Patient");
    const encounterId = serviceRequest.encounter?.reference
      ? assertReference(serviceRequest.encounter.reference, "Encounter")
      : undefined;
    if (!encounterId) throw new Error("Referral ServiceRequest is missing its encounter reference.");
    const senderReference = serviceRequest.requester?.reference;
    if (!senderReference) throw new Error("Referral ServiceRequest is missing its requester reference.");
    const [
      patient,
      encounter,
      findings,
      plans,
      history,
      clinicalSummary,
      sender,
    ] = await Promise.all([
      this.fhir.read<Patient>("Patient", patientId),
      this.fhir.read<Encounter>("Encounter", encounterId),
      this.searchEncounterResources<Observation>("Observation", patientId, encounterId),
      this.searchEncounterResources<CarePlan>("CarePlan", patientId, encounterId),
      this.loadFinalizedHistory(patientId, encounterId, includeList.history_count),
      this.loadClinicalSummary(patientId),
      readCorrespondenceSender(this.fhir, senderReference),
    ]);
    if (encounter.subject?.reference !== serviceRequest.subject.reference) {
      throw new Error("Referral encounter does not belong to the subject patient.");
    }
    return {
      patient,
      encounter,
      recipientName: referralTargetSnapshot(serviceRequest),
      senderName: serviceRequest.requester?.display?.trim() || sender.name,
      senderCredentials: sender.credentials,
      practicePhone,
      findings,
      plans,
      history,
      clinicalSummary,
    };
  }

  private async searchEncounterResources<T extends Observation | CarePlan>(
    resourceType: T["resourceType"],
    patientId: string,
    encounterId: string,
  ): Promise<T[]> {
    const bundle = await this.fhir.search<T>(resourceType, {
      patient: patientId,
      encounter: encounterId,
      _count: "200",
    });
    return resources(bundle);
  }

  private async loadFinalizedHistory(
    patientId: string,
    currentEncounterId: string | undefined,
    count: number,
  ): Promise<Encounter[]> {
    const bundle = await this.fhir.search<Encounter>("Encounter", {
      patient: patientId,
      status: "finished",
      _sort: "-date",
      _count: String(count + (currentEncounterId ? 1 : 0)),
    });
    return resources(bundle)
      .filter((encounter) => encounter.status === "finished" && encounter.id !== currentEncounterId)
      .sort((left, right) => encounterDate(right).localeCompare(encounterDate(left)))
      .slice(0, count);
  }

  private async loadClinicalSummary(patientId: string): Promise<ClinicalSummary> {
    const [conditions, medicationRequests, medicationStatements, allergies] = await Promise.all([
      this.fhir.search<Condition>("Condition", { patient: patientId, _count: "200" }),
      this.fhir.search<MedicationRequest>("MedicationRequest", { patient: patientId, _count: "200" }),
      this.fhir.search<MedicationStatement>("MedicationStatement", { patient: patientId, _count: "200" }),
      this.fhir.search<AllergyIntolerance>("AllergyIntolerance", { patient: patientId, _count: "200" }),
    ]);
    return {
      conditions: resources(conditions),
      medicationRequests: resources(medicationRequests),
      medicationStatements: resources(medicationStatements),
      allergies: resources(allergies),
    };
  }

  private async loadImages(patientId: string, encounterId: string | undefined): Promise<ReferralImage[]> {
    const metadataBundle = await this.fhir.search<Media>("Media", {
      subject: `Patient/${patientId}`,
      ...(encounterId ? { encounter: `Encounter/${encounterId}` } : {}),
      status: "completed",
      _summary: "true",
      _count: "50",
    });
    const accepted: ReferralImage[] = [];
    let remainingBytes = REFERRAL_MEDIA_MAX_TOTAL_BYTES;
    for (const metadata of resources(metadataBundle)) {
      if (!metadata.id || metadata.status !== "completed") continue;
      const declaredBytes = metadata.content?.size;
      if (declaredBytes !== undefined && (
        declaredBytes > REFERRAL_MEDIA_MAX_ATTACHMENT_BYTES
        || declaredBytes > remainingBytes
      )) continue;

      const media = await this.fhir.read<Media>("Media", metadata.id);
      if (
        media.status !== "completed"
        || media.subject?.reference !== `Patient/${patientId}`
        || (encounterId && media.encounter?.reference !== `Encounter/${encounterId}`)
      ) continue;
      const inlineBytes = media.content.data
        ? Buffer.byteLength(media.content.data, "base64")
        : 0;
      let resolvedMedia = media;
      let missing: string | undefined;
      let resolvedBytes = inlineBytes;
      if (!media.content.data && media.content.url) {
        const binaryId = referralBinaryId(media.content.url, this.storageBaseUrls);
        if (!binaryId) {
          missing = "Attachment URL was not a trusted Medplum Binary reference.";
        } else if (!this.fhir.readBinaryData) {
          missing = "Binary reader is unavailable.";
        } else {
          try {
            const binary = await this.fhir.readBinaryData(binaryId);
            resolvedBytes = binary.bytes.byteLength;
            resolvedMedia = {
              ...media,
              content: {
                ...media.content,
                contentType: media.content.contentType ?? binary.contentType,
                data: Buffer.from(binary.bytes).toString("base64"),
              },
            };
          } catch {
            missing = "Binary content could not be resolved.";
          }
        }
      } else if (!media.content.data) {
        missing = "Attachment content is missing.";
      }
      const attachmentBytes = Math.max(media.content.size ?? 0, resolvedBytes);
      if (
        attachmentBytes > REFERRAL_MEDIA_MAX_ATTACHMENT_BYTES
        || attachmentBytes > remainingBytes
      ) continue;
      remainingBytes -= attachmentBytes;
      accepted.push({ media: resolvedMedia, ...(missing ? { missing } : {}) });
    }
    return accepted;
  }
}

export interface ClinicalSummary {
  conditions: Condition[];
  medicationRequests: MedicationRequest[];
  medicationStatements: MedicationStatement[];
  allergies: AllergyIntolerance[];
}

export function buildReferralIncludeListExtension(includeList: ReferralIncludeList): Extension {
  validateIncludeList(includeList);
  return {
    url: REFERRAL_INCLUDE_LIST_EXTENSION_URL,
    extension: [
      ...INCLUDE_FLAG_NAMES.map((name) => ({ url: name, valueBoolean: includeList[name] })),
      { url: "history_count", valuePositiveInt: includeList.history_count },
    ],
  };
}

function replaceExtension(
  extensions: readonly Extension[] | undefined,
  replacement: Extension,
): Extension[] {
  const retained = (extensions ?? []).filter((extension) => extension.url !== replacement.url);
  return [...retained, replacement];
}

function assertDraftReferral(serviceRequest: ServiceRequest): void {
  if (serviceRequest.status !== "draft") {
    throw new ReferralSendConflictError("Only a draft referral can be changed or sent.");
  }
}

function referralId(serviceRequest: ServiceRequest): string {
  if (!serviceRequest.id) throw new Error("Referral ServiceRequest must have an id before send.");
  return serviceRequest.id;
}

function referralVersionId(serviceRequest: ServiceRequest): string {
  const versionId = serviceRequest.meta?.versionId;
  if (!versionId) throw new Error("Referral ServiceRequest must have a version before send.");
  return versionId;
}

function throwReferralConflict(error: unknown): never {
  const status = (error as { status?: unknown })?.status;
  const message = error instanceof Error ? error.message : String(error);
  if (status === 409 || status === 412 || /FHIR (409|412)\b/.test(message)) {
    throw new ReferralSendConflictError("The referral changed; reopen it and try again.");
  }
  throw error;
}

function transactionResponseId(
  response: Bundle,
  entryIndex: number,
  resourceType: string,
): string | undefined {
  const entry = response.entry?.[entryIndex];
  if (entry?.resource?.resourceType === resourceType && entry.resource.id) return entry.resource.id;
  return entry?.response?.location?.match(new RegExp(`^${resourceType}/([^/]+)`))?.[1];
}

function validateIncludeList(includeList: ReferralIncludeList): void {
  if (!Number.isInteger(includeList.history_count) || includeList.history_count < 1 || includeList.history_count > 50) {
    throw new Error("Referral history_count must be an integer from 1 through 50.");
  }
}

async function readReferralTarget(
  fhir: ReferralFhirClient,
  reference: string,
): Promise<Practitioner | PractitionerRole | Organization> {
  const [resourceType, id, extra] = reference.split("/");
  if (!id || extra) throw new Error("Referral target must be a Practitioner, PractitionerRole, or Organization reference by id.");
  switch (resourceType) {
    case "Practitioner":
      return fhir.read<Practitioner>("Practitioner", id);
    case "PractitionerRole":
      return fhir.read<PractitionerRole>("PractitionerRole", id);
    case "Organization":
      return fhir.read<Organization>("Organization", id);
    default:
      throw new Error("Referral target must be a Practitioner, PractitionerRole, or Organization reference by id.");
  }
}

export async function readCorrespondenceSender(
  fhir: ReferralFhirClient,
  reference: string,
): Promise<{ name: string; credentials: string }> {
  const [resourceType, id, extra] = reference.split("/");
  if (!id || extra || (resourceType !== "Practitioner" && resourceType !== "PractitionerRole")) {
    throw new Error("Correspondence sender must be a Practitioner or PractitionerRole reference by id.");
  }
  if (resourceType === "Practitioner") {
    const practitioner = await fhir.read<Practitioner>("Practitioner", id);
    return {
      name: referralTargetDisplay(practitioner),
      credentials: practitionerCredentials(practitioner),
    };
  }
  const role = await fhir.read<PractitionerRole>("PractitionerRole", id);
  const practitionerId = role.practitioner?.reference?.match(
    /^Practitioner\/([A-Za-z0-9.-]{1,64})$/,
  )?.[1];
  if (!practitionerId) {
    return {
      name: role.practitioner?.display?.trim() || referralTargetDisplay(role),
      credentials: "",
    };
  }
  const practitioner = await fhir.read<Practitioner>("Practitioner", practitionerId);
  return {
    name: role.practitioner?.display?.trim() || referralTargetDisplay(practitioner),
    credentials: practitionerCredentials(practitioner),
  };
}

function practitionerCredentials(practitioner: Practitioner): string {
  const name = practitioner.name?.find((candidate) => candidate.use === "official")
    ?? practitioner.name?.[0];
  return unique([
    ...(name?.suffix ?? []),
    ...(practitioner.qualification ?? []).flatMap((qualification) => {
      const display = conceptText(qualification.code);
      return display ? [display] : [];
    }),
  ].map((value) => value.trim()).filter(Boolean)).join(", ");
}

function referralTargetDisplay(target: Practitioner | PractitionerRole | Organization): string {
  if (target.resourceType === "Organization") {
    if (target.name?.trim()) return target.name.trim();
  } else if (target.resourceType === "Practitioner") {
    const display = humanName(target.name?.[0]);
    if (display) return display;
  } else {
    const display = target.practitioner?.display
      ?? target.organization?.display
      ?? conceptText(target.code?.[0])
      ?? conceptText(target.specialty?.[0]);
    if (display?.trim()) return display.trim();
  }
  if (target.id) return `${target.resourceType}/${target.id}`;
  throw new Error("Referral target does not have a display name or id to snapshot.");
}

function referralTargetSnapshot(serviceRequest: ServiceRequest): string {
  const performer = serviceRequest.performer?.[0];
  if (!performer) throw new Error("Referral ServiceRequest is missing its target.");
  if (performer.reference) assertTargetReference(performer.reference);
  if (!performer.display?.trim()) {
    throw new Error("Referral ServiceRequest is missing its snapshotted target display.");
  }
  return performer.display.trim();
}

function referralLetterBody(serviceRequest: ServiceRequest): string {
  const body = serviceRequest.extension?.find(
    (extension) => extension.url === REFERRAL_LETTER_BODY_EXTENSION_URL,
  )?.valueString;
  if (body === undefined) throw new Error("Referral ServiceRequest is missing its generated letter body.");
  return body;
}

function assertReference(reference: string | undefined, expectedResourceType: string): string {
  const [resourceType, id, extra] = reference?.split("/") ?? [];
  if (resourceType !== expectedResourceType || !id || extra) {
    throw new Error(`Expected ${expectedResourceType} reference by id.`);
  }
  return id;
}

function assertRequesterReference(reference: string): void {
  const [resourceType, id, extra] = reference.split("/");
  if (!id || extra || !["Practitioner", "PractitionerRole", "Organization"].includes(resourceType ?? "")) {
    throw new Error("Referral requester must be a Practitioner, PractitionerRole, or Organization reference by id.");
  }
}

function assertTargetReference(reference: string): void {
  const [resourceType, id, extra] = reference.split("/");
  if (!id || extra || !["Practitioner", "PractitionerRole", "Organization"].includes(resourceType ?? "")) {
    throw new Error("Referral target must be a Practitioner, PractitionerRole, or Organization reference by id.");
  }
}

function resources<T extends Resource>(bundle: Bundle<T>): T[] {
  return (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []);
}

function patientName(patient: Patient): string {
  return humanName(patient.name?.find((name) => name.use === "official") ?? patient.name?.[0])
    || (patient.id ? `Patient/${patient.id}` : "Patient");
}

function humanName(name: HumanName | undefined): string {
  if (!name) return "";
  if (name.text?.trim()) return name.text.trim();
  return [...(name.given ?? []), name.family].filter(Boolean).join(" ").trim();
}

function formatObservation(observation: Observation): string | undefined {
  const label = conceptText(observation.code) ?? "Finding";
  const value = observationValue(observation);
  return value ? `${label}: ${value}` : label;
}

function observationValue(observation: Observation): string | undefined {
  if (observation.valueString !== undefined) return observation.valueString;
  if (observation.valueQuantity?.value !== undefined) {
    return `${observation.valueQuantity.value}${observation.valueQuantity.unit ? ` ${observation.valueQuantity.unit}` : ""}`;
  }
  if (observation.valueCodeableConcept) return conceptText(observation.valueCodeableConcept);
  if (observation.valueBoolean !== undefined) return observation.valueBoolean ? "Yes" : "No";
  if (observation.valueInteger !== undefined) return String(observation.valueInteger);
  const components = (observation.component ?? []).flatMap((component) => {
    const label = conceptText(component.code);
    const value = component.valueString
      ?? (component.valueQuantity?.value !== undefined
        ? `${component.valueQuantity.value}${component.valueQuantity.unit ? ` ${component.valueQuantity.unit}` : ""}`
        : undefined)
      ?? (component.valueCodeableConcept ? conceptText(component.valueCodeableConcept) : undefined)
      ?? (component.valueBoolean !== undefined ? (component.valueBoolean ? "Yes" : "No") : undefined)
      ?? (component.valueInteger !== undefined ? String(component.valueInteger) : undefined);
    return label && value ? [`${label}: ${value}`] : [];
  });
  return components.length ? components.join("; ") : undefined;
}

function formatCarePlan(plan: CarePlan): string[] {
  const lines = (plan.activity ?? []).flatMap((activity) => {
    const detail = activity.detail;
    const text = detail?.description ?? (detail?.code ? conceptText(detail.code) : undefined);
    return text?.trim() ? [text.trim()] : [];
  });
  const notes = (plan.note ?? []).flatMap((note) => note.text?.trim() ? [note.text.trim()] : []);
  if (lines.length || notes.length) return [...lines, ...notes];
  return plan.title?.trim() ? [plan.title.trim()] : [];
}

export function referralFindingLines(findings: readonly Observation[]): string[] {
  return findings
    .filter((observation) => ["final", "amended", "corrected"].includes(observation.status))
    .map(formatObservation)
    .filter((line): line is string => Boolean(line));
}

export function referralPlanLines(plans: readonly CarePlan[]): string[] {
  return plans
    .filter((plan) => !["revoked", "entered-in-error", "unknown"].includes(plan.status))
    .flatMap(formatCarePlan);
}

export function renderCorrespondenceFindingsBlock(findings: readonly Observation[]): string {
  const lines = referralFindingLines(findings);
  return `<section data-token-block="findings"><h2>Findings</h2>${renderListItems(lines, "No visit findings were recorded.")}</section>`;
}

export function renderCorrespondencePlanBlock(plans: readonly CarePlan[]): string {
  const lines = referralPlanLines(plans);
  return `<section data-token-block="plan"><h2>Plan</h2>${renderListItems(lines, "No visit plan was recorded.")}</section>`;
}

function conceptText(concept: { text?: string; coding?: Array<{ display?: string; code?: string }> } | undefined): string | undefined {
  return concept?.text?.trim()
    || concept?.coding?.find((coding) => coding.display?.trim())?.display?.trim()
    || concept?.coding?.find((coding) => coding.code?.trim())?.code?.trim();
}

function encounterDate(encounter: Encounter): string {
  return encounter.period?.end
    ?? encounter.period?.start
    ?? encounter.meta?.lastUpdated
    ?? "";
}

function renderCoverSheet(targetDisplay: string, patientDisplay: string): string {
  return `<section data-section="hipaa_cover_sheet" class="page-break"><h2>Confidential referral cover sheet</h2><dl><dt>To</dt><dd>${escapeHtml(targetDisplay)}</dd><dt>Regarding</dt><dd>${escapeHtml(patientDisplay)}</dd></dl><p>This transmission contains confidential health information intended only for the named recipient. If received in error, do not use or disclose it and notify the sender.</p></section>`;
}

function renderLetter(letterBody: string): string {
  return `<section data-section="letter" class="page-break"><h2>Referral letter</h2><div class="letter-body">${escapeHtml(letterBody).replaceAll("\n", "<br>")}</div></section>`;
}

export function renderDemographics(patient: Patient): string {
  const telecom = (patient.telecom ?? []).flatMap((point) => point.value ? [`${point.system ?? "contact"}: ${point.value}`] : []);
  const addresses = (patient.address ?? []).map((address) => [
    ...(address.line ?? []),
    [address.city, address.state, address.postalCode].filter(Boolean).join(" "),
  ].filter(Boolean).join(", "));
  return `<section data-section="demographics" class="page-break"><h2>Patient demographics</h2><dl><dt>Name</dt><dd>${escapeHtml(patientName(patient))}</dd><dt>Date of birth</dt><dd>${text(patient.birthDate)}</dd><dt>Administrative sex</dt><dd>${text(patient.gender)}</dd><dt>Contact</dt><dd>${text(telecom.join("; "))}</dd><dt>Address</dt><dd>${text(addresses.join("; "))}</dd></dl></section>`;
}

export function renderHistory(encounters: Encounter[]): string {
  const rows = encounters.map((encounter) => {
    const date = encounterDate(encounter);
    const type = conceptText(encounter.type?.[0]) ?? "Finalized exam";
    return `<article data-history-exam><h3>${escapeHtml(type)}</h3><p>${text(date)}</p></article>`;
  }).join("\n");
  return `<section data-section="history" class="page-break"><h2>Prior finalized exam history</h2>${rows || "<p>No prior finalized exams found.</p>"}</section>`;
}

export function renderClinicalSummary(summary: ClinicalSummary): string {
  const conditions = summary.conditions
    .filter((condition) => !condition.verificationStatus?.coding?.some(
      (coding) => coding.code === "entered-in-error" || coding.code === "refuted",
    ))
    .map((condition) => conceptText(condition.code) ?? "Condition");
  const medicationRequests = summary.medicationRequests
    .filter((request) => request.status !== "entered-in-error" && request.status !== "cancelled")
    .map((request) => conceptText(request.medicationCodeableConcept) ?? request.medicationReference?.display ?? "Medication");
  const medicationStatements = summary.medicationStatements
    .filter((statement) => statement.status !== "entered-in-error" && statement.status !== "not-taken")
    .map((statement) => conceptText(statement.medicationCodeableConcept) ?? statement.medicationReference?.display ?? "Medication");
  const allergies = summary.allergies
    .filter((allergy) => !allergy.verificationStatus?.coding?.some(
      (coding) => coding.code === "entered-in-error" || coding.code === "refuted",
    ))
    .map((allergy) => conceptText(allergy.code) ?? "Allergy");
  return `<section data-section="clinical_summary" class="page-break"><h2>Clinical summary</h2>${renderList("Problems", conditions)}${renderList("Medications", unique([...medicationRequests, ...medicationStatements]))}${renderList("Allergies", allergies)}</section>`;
}

export function renderCorrespondenceMedications(summary: ClinicalSummary): string {
  const requests = summary.medicationRequests
    .filter((request) => request.status !== "entered-in-error" && request.status !== "cancelled")
    .map((request) =>
      conceptText(request.medicationCodeableConcept)
      ?? request.medicationReference?.display
      ?? "Medication");
  const statements = summary.medicationStatements
    .filter((statement) => statement.status !== "entered-in-error" && statement.status !== "not-taken")
    .map((statement) =>
      conceptText(statement.medicationCodeableConcept)
      ?? statement.medicationReference?.display
      ?? "Medication");
  return `<section data-token-block="medications"><h2>Medications</h2>${renderListItems(unique([...requests, ...statements]), "None recorded")}</section>`;
}

export function renderCorrespondenceAllergies(summary: ClinicalSummary): string {
  const allergies = summary.allergies
    .filter((allergy) => !allergy.verificationStatus?.coding?.some(
      (coding) => coding.code === "entered-in-error" || coding.code === "refuted",
    ))
    .map((allergy) => conceptText(allergy.code) ?? "Allergy");
  return `<section data-token-block="allergies"><h2>Allergies</h2>${renderListItems(allergies, "None recorded")}</section>`;
}

function renderImages(images: ReferralImage[]): string {
  const rows = images.map(({ media, missing }) => {
    const title = media.content.title ?? conceptText(media.modality) ?? "Clinical image";
    const contentType = media.content.contentType ?? "application/octet-stream";
    const data = media.content.data;
    if (missing) {
      return `<p data-image-missing="true">${escapeHtml(title)} — image unavailable: ${escapeHtml(missing)}</p>`;
    }
    if (data && contentType.startsWith("image/")) {
      return `<figure><img alt="${escapeHtml(title)}" src="data:${escapeHtml(contentType)};base64,${escapeHtml(data)}"><figcaption>${escapeHtml(title)}</figcaption></figure>`;
    }
    if (data && contentType === "application/pdf") {
      return `<p><a download="${escapeHtml(title)}" href="data:application/pdf;base64,${escapeHtml(data)}">${escapeHtml(title)}</a></p>`;
    }
    return `<p>${escapeHtml(title)}</p>`;
  }).join("\n");
  return `<section data-section="images" class="page-break"><h2>Attached imaging</h2>${rows || "<p>No completed imaging found for this visit.</p>"}</section>`;
}

export function referralBinaryId(
  value: string,
  storageBaseUrls: readonly string[],
): string | undefined {
  const relative = /^Binary\/([A-Za-z0-9.-]+)(?:\/_history\/[A-Za-z0-9.-]+)?$/.exec(value);
  if (relative?.[1]) return relative[1];

  let candidate: URL;
  try {
    candidate = new URL(value);
  } catch {
    return undefined;
  }
  for (const baseValue of storageBaseUrls) {
    let base: URL;
    try {
      base = new URL(baseValue.endsWith("/") ? baseValue : `${baseValue}/`);
    } catch {
      continue;
    }
    if (candidate.origin !== base.origin || !candidate.pathname.startsWith(base.pathname)) continue;
    const path = candidate.pathname.slice(base.pathname.length).split("/").filter(Boolean);
    if (
      (path.length === 1 || path.length === 2)
      && /^[A-Za-z0-9.-]+$/.test(path[0] ?? "")
      && (path.length === 1 || /^[A-Za-z0-9.-]+$/.test(path[1] ?? ""))
    ) {
      return path[0];
    }
  }
  return undefined;
}

export function defaultReferralStorageBaseUrls(): string[] {
  const configured = process.env.MEDPLUM_STORAGE_BASE_URL?.trim();
  if (configured) return [configured];
  const medplumBase = process.env.MEDPLUM_BASE_URL?.trim();
  return medplumBase ? [new URL("storage/", medplumBase.endsWith("/") ? medplumBase : `${medplumBase}/`).toString()] : [];
}

function renderList(title: string, values: string[]): string {
  const items = values.length ? values.map((value) => `<li>${escapeHtml(value)}</li>`).join("") : "<li>None recorded</li>";
  return `<h3>${escapeHtml(title)}</h3><ul>${items}</ul>`;
}

function renderListItems(values: readonly string[], empty: string): string {
  const items = values.length ? values : [empty];
  return `<ul>${items.map((value) => `<li>${escapeHtml(value)}</li>`).join("")}</ul>`;
}

function renderDocument(input: {
  serviceRequestId: string;
  authoredOn?: string;
  patientDisplay: string;
  targetDisplay: string;
  sections: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Referral packet</title>
<style>
  body { color: #111; font-family: system-ui, sans-serif; line-height: 1.45; margin: 0 auto; max-width: 8.5in; padding: .5in; }
  header { border-bottom: 2px solid #222; margin-bottom: 1rem; padding-bottom: .5rem; }
  h1 { font-size: 1.35rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.05rem; margin-top: 0; }
  h3 { font-size: .95rem; margin-bottom: .25rem; }
  section { margin: 1rem 0; }
  dl { display: grid; grid-template-columns: 10rem 1fr; gap: .25rem .75rem; }
  dt { color: #555; font-weight: 600; }
  dd { margin: 0; }
  img { height: auto; max-width: 100%; }
  .letter-body { white-space: normal; }
  @media print { body { max-width: none; padding: 0; } .page-break { break-before: page; } .page-break:first-of-type { break-before: auto; } }
</style>
</head>
<body>
<header><h1>Referral packet</h1><div>Patient: ${escapeHtml(input.patientDisplay)}</div><div>To: ${escapeHtml(input.targetDisplay)}</div><div>Referral: ${escapeHtml(input.serviceRequestId)} · ${text(input.authoredOn)}</div></header>
${input.sections}
</body>
</html>`;
}

function text(value: string | undefined): string {
  return value?.trim() ? escapeHtml(value.trim()) : "—";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
