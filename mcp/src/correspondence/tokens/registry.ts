import type { Observation, ObservationComponent } from "@medplum/fhirtypes";
import { ODOS_OPHTHALMOLOGY_CODE_SYSTEM } from "../../fhir/ophthalmology/codeBindings.js";
import {
  renderCorrespondenceAllergies,
  renderCorrespondenceFindingsBlock,
  renderCorrespondenceMedications,
  renderCorrespondencePlanBlock,
  renderDemographics,
  renderHistory,
} from "../../referral/referral-service.js";
import type { CorrespondenceTokenContext } from "./types.js";

export const CORRESPONDENCE_TOKEN_NAMES = [
  "patient.name",
  "patient.dob",
  "recipient.name",
  "sender.name",
  "sender.credentials",
  "encounter.date",
  "practice.phone",
  "findings.block",
  "plan.block",
  "meds.list",
  "allergies.list",
  "history.block",
  "demographics.block",
  "va.table",
  "iop.table",
  "refraction.table",
  "vf.summary",
] as const;

export type CorrespondenceTokenName = (typeof CORRESPONDENCE_TOKEN_NAMES)[number];
export type CorrespondenceTokenResolver = (context: CorrespondenceTokenContext) => string;

export const CORRESPONDENCE_TOKEN_REGISTRY: Readonly<
  Record<CorrespondenceTokenName, CorrespondenceTokenResolver>
> = {
  "patient.name": (context) => escapeHtml(patientName(context)),
  "patient.dob": (context) => escapeHtml(formatDate(context.patient.birthDate)),
  "recipient.name": (context) => escapeHtml(context.recipientName),
  "sender.name": (context) => escapeHtml(context.senderName),
  "sender.credentials": (context) => escapeHtml(context.senderCredentials),
  "encounter.date": (context) => escapeHtml(formatDate(
    context.encounter.period?.start
    ?? context.encounter.period?.end
    ?? context.encounter.meta?.lastUpdated,
  )),
  "practice.phone": (context) => escapeHtml(context.practicePhone),
  "findings.block": (context) => renderCorrespondenceFindingsBlock(context.findings),
  "plan.block": (context) => renderCorrespondencePlanBlock(context.plans),
  "meds.list": (context) => renderCorrespondenceMedications(context.clinicalSummary),
  "allergies.list": (context) => renderCorrespondenceAllergies(context.clinicalSummary),
  "history.block": (context) => renderHistory(context.history),
  "demographics.block": (context) => renderDemographics(context.patient),
  "va.table": (context) => renderVisualAcuityTable(context.findings),
  "iop.table": (context) => renderIopTable(context.findings),
  "refraction.table": (context) => renderRefractionTable(context.findings),
  "vf.summary": renderUnavailableDataToken,
};

export function resolveCorrespondenceTemplate(
  templateHtml: string,
  context: CorrespondenceTokenContext,
): string {
  validateCorrespondenceTemplateTokens(templateHtml);
  return templateHtml.replace(/\{\{([^{}]+)\}\}/g, (_match, rawName: string) => {
    const name = rawName.trim() as CorrespondenceTokenName;
    return CORRESPONDENCE_TOKEN_REGISTRY[name](context);
  });
}

export function validateCorrespondenceTemplateTokens(templateHtml: string): void {
  for (const match of templateHtml.matchAll(/\{\{([^{}]+)\}\}/g)) {
    const name = match[1]?.trim() ?? "";
    if (!CORRESPONDENCE_TOKEN_NAMES.includes(name as CorrespondenceTokenName)) {
      throw new Error(`Unknown correspondence token: ${name}`);
    }
  }
  if (templateHtml.includes("{{") || templateHtml.includes("}}")) {
    const stripped = templateHtml.replace(/\{\{([^{}]+)\}\}/g, "");
    if (stripped.includes("{{") || stripped.includes("}}")) {
      throw new Error("Correspondence template contains malformed token syntax.");
    }
  }
}

function renderVisualAcuityTable(observations: readonly Observation[]): string {
  const rows = finalObservations(observations, "VISUAL_ACUITY").map((observation) => [
    laterality(observation),
    componentValue(observation, "VA_SNELLEN_RAW") ?? "—",
    componentConcept(observation, "VA_CORRECTION") ?? "—",
  ]);
  return renderTable("va", "Visual acuity", ["Eye", "Acuity", "Correction"], rows);
}

function renderIopTable(observations: readonly Observation[]): string {
  const rows = finalObservations(observations, "INTRAOCULAR_PRESSURE").map((observation) => [
    laterality(observation),
    quantityValue(observation.valueQuantity) ?? "—",
    conceptText(observation.method) ?? "—",
  ]);
  return renderTable("iop", "Intraocular pressure", ["Eye", "IOP", "Method"], rows);
}

function renderRefractionTable(observations: readonly Observation[]): string {
  const rows = finalObservations(observations, "REFRACTION").map((observation) => [
    laterality(observation),
    componentQuantity(observation, "SPHERE") ?? "—",
    componentQuantity(observation, "CYLINDER") ?? "—",
    componentQuantity(observation, "AXIS") ?? "—",
    componentQuantity(observation, "ADD") ?? "—",
    componentConcept(observation, "REFRACTION_TYPE") ?? "—",
  ]);
  return renderTable(
    "refraction",
    "Refraction",
    ["Eye", "Sphere", "Cylinder", "Axis", "Add", "Type"],
    rows,
  );
}

function finalObservations(
  observations: readonly Observation[],
  code: string,
): Observation[] {
  return observations.filter((observation) =>
    ["final", "amended", "corrected"].includes(observation.status)
    && hasOdosCode(observation.code, code));
}

function componentValue(observation: Observation, code: string): string | undefined {
  const component = findComponent(observation, code);
  return component?.valueString
    ?? (component?.valueQuantity ? quantityValue(component.valueQuantity) : undefined)
    ?? (component?.valueCodeableConcept ? conceptText(component.valueCodeableConcept) : undefined)
    ?? (component?.valueInteger !== undefined ? String(component.valueInteger) : undefined);
}

function componentQuantity(observation: Observation, code: string): string | undefined {
  const value = findComponent(observation, code)?.valueQuantity;
  return value ? quantityValue(value) : undefined;
}

function componentConcept(observation: Observation, code: string): string | undefined {
  return conceptText(findComponent(observation, code)?.valueCodeableConcept);
}

function findComponent(
  observation: Observation,
  code: string,
): ObservationComponent | undefined {
  return observation.component?.find((component) => hasOdosCode(component.code, code));
}

function hasOdosCode(
  concept: { coding?: Array<{ system?: string; code?: string }> } | undefined,
  code: string,
): boolean {
  return Boolean(concept?.coding?.some((coding) =>
    coding.system === ODOS_OPHTHALMOLOGY_CODE_SYSTEM && coding.code === code));
}

function laterality(observation: Observation): string {
  const odos = observation.bodySite?.coding?.find(
    (coding) => coding.system === ODOS_OPHTHALMOLOGY_CODE_SYSTEM,
  );
  return odos?.code ?? odos?.display ?? observation.bodySite?.text ?? "—";
}

function quantityValue(
  value: { value?: number; unit?: string } | undefined,
): string | undefined {
  if (value?.value === undefined) return undefined;
  return `${value.value}${value.unit ? ` ${value.unit}` : ""}`;
}

function conceptText(
  concept: { text?: string; coding?: Array<{ display?: string; code?: string }> } | undefined,
): string | undefined {
  return concept?.text?.trim()
    || concept?.coding?.find((coding) => coding.display?.trim())?.display?.trim()
    || concept?.coding?.find((coding) => coding.code?.trim())?.code?.trim();
}

function renderTable(
  token: string,
  title: string,
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const body = rows.length
    ? rows.map((row) =>
        `<tr>${row.map((value) => `<td>${escapeHtml(value)}</td>`).join("")}</tr>`).join("")
    : `<tr><td colspan="${headers.length}">No finalized data recorded for this encounter.</td></tr>`;
  return `<section data-correspondence-table="${token}"><h2>${escapeHtml(title)}</h2><table><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></section>`;
}

function patientName(context: CorrespondenceTokenContext): string {
  const name = context.patient.name?.find((candidate) => candidate.use === "official")
    ?? context.patient.name?.[0];
  return name?.text?.trim()
    || [...(name?.given ?? []), name?.family].filter(Boolean).join(" ").trim()
    || (context.patient.id ? `Patient/${context.patient.id}` : "Patient");
}

function formatDate(value: string | undefined): string {
  if (!value) return "";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[2]}/${match[3]}/${match[1]}` : value;
}

/**
 * No token resolver may render text describing ODOS's internal state, capabilities, or
 * roadmap on a document that leaves the practice. Unavailable data renders empty. If a
 * clinician needs to know a section is unavailable, that belongs in the compose UI, not
 * in the rendered letter.
 */
function renderUnavailableDataToken(): string {
  return "";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
