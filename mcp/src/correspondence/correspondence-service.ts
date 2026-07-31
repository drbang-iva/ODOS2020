import type {
  Basic,
  Binary,
  Bundle,
  DocumentReference,
  Encounter,
  Media,
  Organization,
  Resource,
  ServiceRequest,
} from "@medplum/fhirtypes";
import { searchAll } from "../fhir-search.js";
import {
  ReferralService,
  readCorrespondenceSender,
  referralBinaryId,
  type ReferralFhirClient,
} from "../referral/referral-service.js";
import { referralDirectionOf } from "../referral/referral-service.js";
import {
  buildRenderedLetterDocumentReference,
} from "./correspondence-document.js";
import {
  CorrespondenceLetterheadStore,
  type CorrespondenceLetterhead,
} from "./letterhead-store.js";
import {
  CorrespondenceTemplateStore,
  type CorrespondenceTemplate,
} from "./template-store.js";
import { resolveCorrespondenceTemplate } from "./tokens/registry.js";
import { ProviderSignatureImageStore } from "./signature-image-store.js";
import type { CorrespondenceRenderer } from "./weasyprint-renderer.js";

export const SETUP_PRACTICE_ORGANIZATION_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/setup-practice-organization";
export const CORRESPONDENCE_RENDER_WRITE_HEADERS = {
  "X-ODOS-Source": "mcp/correspondence-render",
} as const;

export interface CorrespondenceConfigFhirClient {
  read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T>;
  readBinaryData?(id: string): Promise<{ contentType: string; bytes: Uint8Array }>;
  search<T extends Resource>(
    resourceType: T["resourceType"],
    params?: Record<string, string>,
  ): Promise<Bundle<T>>;
  searchUrl?<T extends Resource>(url: string, resourceType?: T["resourceType"]): Promise<Bundle<T>>;
  create<T extends Resource>(resource: T, headers?: Record<string, string>): Promise<T>;
  update<T extends Resource>(
    resourceType: T["resourceType"],
    id: string,
    resource: T,
    headers?: Record<string, string>,
  ): Promise<T>;
}

export class CorrespondenceService {
  readonly templates: CorrespondenceTemplateStore;
  readonly letterhead: CorrespondenceLetterheadStore;
  readonly providerSignatures: ProviderSignatureImageStore;

  constructor(
    private readonly clinicalFhir: ReferralFhirClient,
    private readonly configFhir: CorrespondenceConfigFhirClient,
    private readonly renderer: CorrespondenceRenderer,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.templates = new CorrespondenceTemplateStore(configFhir);
    this.letterhead = new CorrespondenceLetterheadStore(configFhir);
    this.providerSignatures = new ProviderSignatureImageStore(configFhir);
  }

  async listTemplates(letterType = "referral"): Promise<CorrespondenceTemplate[]> {
    return this.templates.list(letterType);
  }

  async resolveReferralTemplate(
    serviceRequest: ServiceRequest,
    templateId: string,
  ): Promise<string> {
    const template = await this.templates.read(templateId);
    if (!template || template.letterType !== "referral") {
      throw new Error("The selected referral template is unavailable.");
    }
    const letterhead = await this.loadLetterhead();
    const context = await new ReferralService(this.clinicalFhir, this.now)
      .loadCorrespondenceTokenContext(serviceRequest, letterhead.phone);
    return sanitizeCorrespondenceBodyHtml(
      resolveCorrespondenceTemplate(template.bodyHtml, context),
    );
  }

  async renderReferral(input: {
    serviceRequest: ServiceRequest;
    authorReference: string;
    templateId?: string;
    editedBodyHtml?: string;
    signedByReference?: string;
  }): Promise<{
    pdf: Buffer;
    sourceHtml: string;
    bodyHtml: string;
    documentReference: DocumentReference;
  }> {
    const letterhead = await this.loadLetterhead();
    const context = await new ReferralService(this.clinicalFhir, this.now)
      .loadCorrespondenceTokenContext(input.serviceRequest, letterhead.phone);
    let bodyHtml: string;
    if (input.editedBodyHtml?.trim()) {
      bodyHtml = sanitizeCorrespondenceBodyHtml(input.editedBodyHtml);
    } else {
      const template = input.templateId
        ? await this.templates.read(input.templateId)
        : (await this.templates.list("referral"))[0];
      if (!template || template.letterType !== "referral") {
        throw new Error("A referral correspondence template is required.");
      }
      bodyHtml = sanitizeCorrespondenceBodyHtml(
        resolveCorrespondenceTemplate(template.bodyHtml, context),
      );
    }
    const sourceHtml = await assembleLockedLetterHtml({
      letterhead,
      logoDataUri: await this.imageDataUri(letterhead.logoReference),
      signatureDataUri: input.signedByReference
        ? await this.providerSignatureDataUri(input.signedByReference)
        : undefined,
      ...await this.signatory(input.signedByReference, context.senderName, context.senderCredentials),
      patientName: patientName(context.patient),
      patientDob: context.patient.birthDate,
      recipientName: context.recipientName,
      bodyHtml,
    });
    const pdf = await this.renderer.render(sourceHtml);
    const serviceRequestReference = serviceRequestReferenceOf(input.serviceRequest);
    const renderedAt = this.now();
    const documentReference = await this.clinicalFhir.create<DocumentReference>(
      buildRenderedLetterDocumentReference({
        patientReference: input.serviceRequest.subject.reference!,
        patientDisplay: input.serviceRequest.subject.display,
        encounterReference: input.serviceRequest.encounter?.reference,
        serviceRequestReference,
        authorReference: input.authorReference,
        renderedAt,
        filename: `referral-${input.serviceRequest.id}.pdf`,
        pdf,
        sourceHtml,
        docStatus: input.signedByReference ? "final" : "preliminary",
        ...(input.signedByReference
          ? { authenticatorReference: input.signedByReference }
          : {}),
      }),
      CORRESPONDENCE_RENDER_WRITE_HEADERS,
    );
    return { pdf, sourceHtml, bodyHtml, documentReference };
  }

  async renderConsultReport(input: {
    serviceRequest: ServiceRequest;
    authorReference: string;
    encounterReference?: string;
    templateId?: string;
    editedBodyHtml?: string;
    signedByReference?: string;
  }): Promise<{
    pdf: Buffer;
    sourceHtml: string;
    bodyHtml: string;
    sourceEncounter: {
      reference: string;
      date: string;
      label: string;
    };
    documentReference: DocumentReference;
  }> {
    if (referralDirectionOf(input.serviceRequest) !== "inbound") {
      throw new Error("Consult reports require an inbound referral.");
    }
    const patientReference = input.serviceRequest.subject.reference;
    const patientId = patientReference?.match(/^Patient\/([A-Za-z0-9.-]{1,64})$/)?.[1];
    if (!patientId) throw new Error("Inbound referral requires a Patient subject.");
    const encounter = await this.signedEncounter(patientId, input.encounterReference);
    const encounterReference = `Encounter/${encounter.id}`;
    const sender = input.signedByReference
      ? { reference: input.signedByReference }
      : input.serviceRequest.performer?.[0];
    if (!sender?.reference) {
      throw new Error("Inbound referral requires a receiving provider.");
    }
    const recipient = input.serviceRequest.requester;
    if (!recipient?.display?.trim()) {
      throw new Error("Inbound referral requires a snapshotted referrer display.");
    }
    const contextualRequest: ServiceRequest = {
      ...input.serviceRequest,
      requester: {
        reference: sender.reference,
        ...(sender.display ? { display: sender.display } : {}),
      },
      performer: [{
        ...(recipient.reference ? { reference: recipient.reference } : {}),
        display: recipient.display,
      }],
      encounter: { reference: encounterReference },
    };
    const letterhead = await this.loadLetterhead();
    const context = await new ReferralService(this.clinicalFhir, this.now)
      .loadCorrespondenceTokenContext(contextualRequest, letterhead.phone);
    context.consultQuestion = input.serviceRequest.reasonCode?.[0]?.text?.trim() ?? "";
    let bodyHtml: string;
    if (input.editedBodyHtml?.trim()) {
      bodyHtml = sanitizeCorrespondenceBodyHtml(input.editedBodyHtml);
    } else {
      const template = input.templateId
        ? await this.templates.read(input.templateId)
        : (await this.templates.list("consult-report"))[0];
      if (!template || template.letterType !== "consult-report") {
        throw new Error("A consult-report correspondence template is required.");
      }
      bodyHtml = sanitizeCorrespondenceBodyHtml(
        resolveCorrespondenceTemplate(template.bodyHtml, context),
      );
    }
    const sourceHtml = await assembleLockedLetterHtml({
      letterhead,
      logoDataUri: await this.imageDataUri(letterhead.logoReference),
      signatureDataUri: input.signedByReference
        ? await this.providerSignatureDataUri(input.signedByReference)
        : undefined,
      ...await this.signatory(input.signedByReference, context.senderName, context.senderCredentials),
      patientName: patientName(context.patient),
      patientDob: context.patient.birthDate,
      recipientName: context.recipientName,
      bodyHtml,
    });
    const pdf = await this.renderer.render(sourceHtml);
    const renderedAt = this.now();
    const documentReference = await this.clinicalFhir.create<DocumentReference>(
      buildRenderedLetterDocumentReference({
        patientReference,
        patientDisplay: input.serviceRequest.subject.display,
        encounterReference,
        serviceRequestReference: serviceRequestReferenceOf(input.serviceRequest),
        authorReference: input.authorReference,
        renderedAt,
        filename: `consult-report-${input.serviceRequest.id}.pdf`,
        pdf,
        sourceHtml,
        letterType: "consult-report",
        docStatus: input.signedByReference ? "final" : "preliminary",
        ...(input.signedByReference
          ? { authenticatorReference: input.signedByReference }
          : {}),
      }),
      CORRESPONDENCE_RENDER_WRITE_HEADERS,
    );
    const date = encounterDate(encounter);
    return {
      pdf,
      sourceHtml,
      bodyHtml,
      sourceEncounter: {
        reference: encounterReference,
        date,
        label: `Clinical content from signed encounter ${date || encounterReference}`,
      },
      documentReference,
    };
  }

  private async loadLetterhead(): Promise<CorrespondenceLetterhead> {
    return (await this.letterhead.read()) ?? this.defaultLetterhead();
  }

  private async defaultLetterhead(): Promise<CorrespondenceLetterhead> {
    const organizations = await searchAll<Organization>(this.configFhir, "Organization", {
      identifier: `${SETUP_PRACTICE_ORGANIZATION_IDENTIFIER_SYSTEM}|primary`,
      _count: "2",
    });
    if (organizations.length > 1) {
      throw new Error("Expected exactly one primary practice Organization.");
    }
    const organization = organizations[0];
    const phone = organization?.telecom?.find(
      (telecom) => telecom.system === "phone" && telecom.value?.trim(),
    )?.value?.trim() ?? "Phone not configured";
    const address = organization?.address?.[0];
    const contactBlock = [
      organization?.name?.trim() || "ODOS practice",
      ...(address?.line ?? []),
      [address?.city, address?.state, address?.postalCode].filter(Boolean).join(" "),
    ].filter(Boolean).join("\n");
    return {
      contactBlock,
      phone,
      footerText: "",
      active: true,
    };
  }

  private async imageDataUri(reference: string | undefined): Promise<string | undefined> {
    if (!reference) return undefined;
    const [resourceType, id] = reference.split("/");
    if (!id || (resourceType !== "Media" && resourceType !== "Binary")) {
      throw new Error("Letterhead image reference is invalid.");
    }
    if (resourceType === "Binary") {
      if (!this.configFhir.readBinaryData) {
        throw new Error("Letterhead Binary reader is unavailable.");
      }
      const binary = await this.configFhir.readBinaryData(id);
      return dataUri(binary.contentType, binary.bytes);
    }
    const media = await this.configFhir.read<Media>("Media", id);
    if (!media.content.contentType?.startsWith("image/")) {
      throw new Error("Letterhead Media must contain an image.");
    }
    if (media.content.data) {
      return `data:${media.content.contentType};base64,${media.content.data}`;
    }
    const binaryId = media.content.url
      ? referralBinaryId(media.content.url, [])
        ?? /^Binary\/([A-Za-z0-9.-]{1,64})$/.exec(media.content.url)?.[1]
      : undefined;
    if (!binaryId || !this.configFhir.readBinaryData) {
      throw new Error("Letterhead Media image bytes are unavailable.");
    }
    const binary = await this.configFhir.readBinaryData(binaryId);
    return dataUri(binary.contentType, binary.bytes);
  }

  private async providerSignatureDataUri(
    providerReference: string,
  ): Promise<string | undefined> {
    const resolved = await this.providerSignatures.readMedia(providerReference);
    if (!resolved) return undefined;
    const contentType = resolved.media.content.contentType;
    if (contentType !== "image/png" && contentType !== "image/jpeg") {
      throw new Error("Provider signature Media must contain a PNG or JPEG image.");
    }
    if (resolved.media.content.data) {
      return `data:${contentType};base64,${resolved.media.content.data}`;
    }
    return resolved.media.content.url
      ? this.imageDataUri(resolved.media.content.url)
      : undefined;
  }

  private async signatory(
    signedByReference: string | undefined,
    fallbackName: string,
    fallbackCredentials: string,
  ): Promise<{ signatoryName: string; signatoryCredentials: string }> {
    if (!signedByReference) {
      return {
        signatoryName: fallbackName,
        signatoryCredentials: fallbackCredentials,
      };
    }
    const signer = await readCorrespondenceSender(this.clinicalFhir, signedByReference);
    return {
      signatoryName: signer.name,
      signatoryCredentials: signer.credentials,
    };
  }

  private async signedEncounter(
    patientId: string,
    encounterReference: string | undefined,
  ): Promise<Encounter> {
    if (encounterReference) {
      const id = encounterReference.match(/^Encounter\/([A-Za-z0-9.-]{1,64})$/)?.[1];
      if (!id) throw new Error("A valid Encounter reference is required.");
      const encounter = await this.clinicalFhir.read<Encounter>("Encounter", id);
      if (encounter.subject?.reference !== `Patient/${patientId}` || encounter.status !== "finished") {
        throw new Error("Correspondence encounter must be a signed encounter for this patient.");
      }
      return encounter;
    }
    const bundle = await this.clinicalFhir.search<Encounter>("Encounter", {
      patient: patientId,
      status: "finished",
      _sort: "-date",
      _count: "1",
    });
    const encounter = (bundle.entry ?? []).flatMap((entry) =>
      entry.resource ? [entry.resource] : [])[0];
    if (!encounter?.id || encounter.status !== "finished") {
      throw new Error("No signed encounter is available for this correspondence.");
    }
    return encounter;
  }
}

export function sanitizeCorrespondenceBodyHtml(input: string): string {
  const withoutExecutableContent = input
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|iframe|object|embed|link|meta)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(script|style|iframe|object|embed|link|meta)\b[^>]*\/?>/gi, "");
  const allowed = new Set([
    "p", "br", "strong", "b", "em", "i", "u", "ul", "ol", "li",
    "h2", "h3", "section", "table", "thead", "tbody", "tr", "th", "td",
  ]);
  return withoutExecutableContent.replace(
    /<\/?([A-Za-z][A-Za-z0-9-]*)\b[^>]*>/g,
    (tag, rawName: string) => {
      const name = rawName.toLowerCase();
      if (!allowed.has(name)) return "";
      return tag.startsWith("</") ? `</${name}>` : `<${name}>`;
    },
  ).trim();
}

export async function assembleLockedLetterHtml(input: {
  letterhead: CorrespondenceLetterhead;
  logoDataUri?: string;
  signatureDataUri?: string;
  signatoryName?: string;
  signatoryCredentials?: string;
  patientName: string;
  patientDob?: string;
  recipientName: string;
  bodyHtml: string;
}): Promise<string> {
  const contact = escapeHtml(input.letterhead.contactBlock).replaceAll("\n", "<br>");
  const continued = `Re: ${input.patientName} — DOB ${input.patientDob ?? "not recorded"} — continued`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Referral letter</title>
<style>
@page {
  size: Letter;
  margin: 0.8in 0.75in 0.75in;
  @top-center { content: element(continued-header); }
  @bottom-left { content: "${cssString(input.letterhead.footerText)}"; font-size: 8pt; color: #555; }
  @bottom-right { content: "Page " counter(page) " of " counter(pages); font-size: 8pt; color: #555; }
}
@page :first { @top-center { content: none; } }
body { color: #17202a; font-family: "Noto Serif", Georgia, serif; font-size: 10.5pt; line-height: 1.45; }
.letterhead { align-items: start; border-bottom: 1.5pt solid #24364b; display: flex; justify-content: space-between; margin-bottom: 24pt; padding-bottom: 12pt; }
.letterhead img { max-height: 0.65in; max-width: 2.2in; }
.contact { font-family: "Noto Sans", Arial, sans-serif; font-size: 8.5pt; text-align: right; }
.continued { position: running(continued-header); font-family: "Noto Sans", Arial, sans-serif; font-size: 8pt; color: #555; }
.recipient { margin-bottom: 18pt; }
section, table, tr { break-inside: avoid; }
h2 { color: #24364b; font-family: "Noto Sans", Arial, sans-serif; font-size: 11pt; margin: 14pt 0 5pt; }
h3 { font-family: "Noto Sans", Arial, sans-serif; font-size: 10pt; margin-bottom: 4pt; }
table { border-collapse: collapse; margin: 8pt 0 14pt; width: 100%; }
th, td { border: 0.5pt solid #9ba8b5; padding: 4pt 6pt; text-align: left; }
th { background: #edf1f5; font-family: "Noto Sans", Arial, sans-serif; font-size: 8.5pt; }
.signature { margin-top: 24pt; }
.signature img { display: block; max-height: 0.55in; max-width: 2in; }
.signature-line { border-bottom: 0.5pt solid #24364b; min-height: 0.55in; width: 2.2in; }
.signature-identity { margin-top: 4pt; }
</style>
</head>
<body>
<div class="continued">${escapeHtml(continued)}</div>
<header class="letterhead">
  <div>${input.logoDataUri ? `<img alt="Practice logo" src="${input.logoDataUri}">` : ""}</div>
  <div class="contact">${contact}<br>${escapeHtml(input.letterhead.phone)}</div>
</header>
<div class="recipient"><strong>To:</strong> ${escapeHtml(input.recipientName)}<br><strong>Re:</strong> ${escapeHtml(input.patientName)} · DOB ${escapeHtml(input.patientDob ?? "not recorded")}</div>
<main>${input.bodyHtml}</main>
${input.signatoryName ? `<div class="signature"><div class="signature-line">${input.signatureDataUri ? `<img alt="Provider signature" src="${input.signatureDataUri}">` : ""}</div><div class="signature-identity">${escapeHtml(input.signatoryName)}${input.signatoryCredentials ? `, ${escapeHtml(input.signatoryCredentials)}` : ""}</div></div>` : ""}
</body>
</html>`;
}

function dataUri(contentType: string, bytes: Uint8Array): string {
  if (!contentType.startsWith("image/")) throw new Error("Letterhead Binary must contain an image.");
  return `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`;
}

function serviceRequestReferenceOf(serviceRequest: ServiceRequest): string {
  if (!serviceRequest.id) throw new Error("Referral must have an id before rendering.");
  return `ServiceRequest/${serviceRequest.id}`;
}

function patientName(patient: { id?: string; name?: Array<{ use?: string; text?: string; given?: string[]; family?: string }> }): string {
  const name = patient.name?.find((candidate) => candidate.use === "official") ?? patient.name?.[0];
  return name?.text?.trim()
    || [...(name?.given ?? []), name?.family].filter(Boolean).join(" ").trim()
    || (patient.id ? `Patient/${patient.id}` : "Patient");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function cssString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", " ");
}

function encounterDate(encounter: Encounter): string {
  return encounter.period?.end
    ?? encounter.period?.start
    ?? encounter.meta?.lastUpdated
    ?? "";
}
