import { randomUUID } from "node:crypto";
import type { Basic, Bundle, Encounter, Observation, Provenance, Resource } from "@medplum/fhirtypes";
import { z } from "zod";
import { assertBusinessActionAllowed, type PracticeRoleId } from "../authz/roles.js";
import { ODOS_OPHTHALMOLOGY_CODE_SYSTEM } from "../fhir/ophthalmology/codeBindings.js";
import { odosConcept, reference } from "../fhir/ophthalmology/extensions.js";
import { FhirComplaintDefinitionStore } from "./complaint-definition-store.js";
import { renderComplaintNarrative } from "./complaint-model.js";
import { FhirEncounterComplaintStore } from "./encounter-complaint-store.js";
import { buildHpiFindingDefinition, HPI_STABLE_KEY } from "./hpi-definition.js";
import {
  captureGlaucomaFinding,
  type ClinicalFindingDefinition,
  type ClinicalGraphProvenance,
  type FindingValue,
} from "./glaucoma-suspect.js";

export interface HpiFhirClient {
  read<T extends Encounter>(resourceType: T["resourceType"], id: string): Promise<T>;
  search<T extends Resource>(resourceType: T["resourceType"], params?: Record<string, string>): Promise<Bundle<T>>;
  searchUrl?<T extends Resource>(url: string, resourceType: T["resourceType"]): Promise<Bundle<T>>;
  create<T extends Basic>(resource: T, extraHeaders?: Record<string, string>): Promise<T>;
  update<T extends Basic | Encounter>(resourceType: T["resourceType"], id: string, resource: T, extraHeaders?: Record<string, string>): Promise<T>;
  executeTransaction(bundle: Bundle, extraHeaders?: Record<string, string>): Promise<Bundle>;
}

export interface HpiEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<{
    staffReference: string;
    actorRole: PracticeRoleId;
    fhir: HpiFhirClient;
  } | null>;
  findingDefinitions?: () => ClinicalFindingDefinition[];
  now?: () => string;
}

const WRITE_HEADERS = { "X-ODOS-Source": "mcp/save_hpi_ros" } as const;
export const HPI_OBSERVATION_IDENTIFIER_SYSTEM = "https://odos2020.com/fhir/NamingSystem/hpi-observation-encounter";
const rosFlagSchema = z.object({
  code: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
  display: z.string().trim().min(1).max(120),
  category: z.enum(["eye", "general"]),
  status: z.enum(["positive", "negative"]),
}).strict();
const hpiRequestSchema = z.object({
  patientReference: z.string().regex(/^Patient\/[A-Za-z0-9.-]+$/),
  encounterReference: z.string().regex(/^Encounter\/[A-Za-z0-9.-]+$/),
  reviewOfSystems: z.array(rosFlagSchema).max(128),
  reviewAttestations: z.array(z.enum(["eye", "general"])).max(2).default([]),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  for (const flag of value.reviewOfSystems) {
    if (seen.has(flag.code)) context.addIssue({ code: z.ZodIssueCode.custom, message: `Review-of-systems flag ${flag.code} is duplicated.` });
    seen.add(flag.code);
  }
  if (new Set(value.reviewAttestations).size !== value.reviewAttestations.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Review attestations cannot contain duplicates." });
  }
});

export async function handleHpiDefinitionRequest(
  deps: Pick<HpiEndpointDeps, "authenticate" | "findingDefinitions">,
  input: { authHeader: string | undefined },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to read HPI definition." } };
  if (!staffMay(staff.actorRole, "chart.read")) return { status: 403, body: { error: "chart.read role required" } };
  const definition = resolveHpiDefinition(deps.findingDefinitions?.());
  return {
    status: 200,
    body: { definition: {
      id: definition.id,
      stableKey: definition.stableKey,
      display: definition.display,
      fields: definition.valueSchema.fields,
      terminologyStatus: definition.valueSchema.terminologyStatus,
    } },
  };
}

export async function handleHpiCaptureRequest(
  deps: HpiEndpointDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to save history." } };
  if (!staffMay(staff.actorRole, "chart.write")) return { status: 403, body: { error: "chart.write role required" } };
  const parsed = hpiRequestSchema.safeParse(input.body);
  if (!parsed.success) return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid history request." } };

  const encounterId = parsed.data.encounterReference.slice("Encounter/".length);
  const encounter = await staff.fhir.read<Encounter>("Encounter", encounterId);
  if (encounter.subject?.reference !== parsed.data.patientReference) {
    return { status: 400, body: { error: "History patient does not match the encounter subject." } };
  }
  if (encounter.status === "finished" || encounter.status === "cancelled" || encounter.status === "entered-in-error") {
    return { status: 409, body: { error: "Signed or closed encounters cannot be edited." } };
  }
  const definition = resolveHpiDefinition(deps.findingDefinitions?.());
  const rosError = validateRos(parsed.data.reviewOfSystems, definition);
  if (rosError) return { status: 400, body: { error: rosError } };

  const definitions = await new FhirComplaintDefinitionStore(staff.fhir).list();
  const complaints = (await new FhirEncounterComplaintStore(staff.fhir).listByEncounter(encounterId))
    .filter((complaint) => complaint.status === "active")
    .sort((left, right) => left.ordinal - right.ordinal);
  if (!complaints.length) return { status: 400, body: { error: "At least one presenting complaint is required before saving history." } };

  const recordedAt = deps.now?.() ?? new Date().toISOString();
  const captureProvenance: ClinicalGraphProvenance = {
    source: "manual",
    recordedAt,
    actorReference: staff.staffReference,
    note: [
      "MANDATE-14-DEFERRED: complaint, HPI, and ROS concepts remain ODOS-local; no external terminology code is asserted.",
      ...parsed.data.reviewAttestations.map((group) => `${group} review-of-systems remaining items attested negative.`),
    ].join(" "),
  };
  const findingId = `finding-${HPI_STABLE_KEY}-${randomUUID()}`;
  const captured = captureGlaucomaFinding({
    definition,
    patientReference: parsed.data.patientReference,
    encounterReference: parsed.data.encounterReference,
    laterality: "UNKNOWN",
    value: historyFindingValue(
      complaints,
      definitions,
      parsed.data.reviewOfSystems,
      parsed.data.reviewAttestations,
    ),
    sourceType: "manual",
    performerReferences: [staff.staffReference],
    recordedAt,
    provenance: captureProvenance,
    findingInstanceId: findingId,
    observationId: findingId,
  });
  const existingBundle = await staff.fhir.search<Observation>("Observation", {
    encounter: parsed.data.encounterReference,
    code: `${ODOS_OPHTHALMOLOGY_CODE_SYSTEM}|${HPI_STABLE_KEY}`,
    _count: "200",
  });
  if (existingBundle.link?.some((link) => link.relation === "next")) {
    throw new Error("History upsert found more matching Observations than it can safely reconcile.");
  }
  const liveHistory = (existingBundle.entry ?? []).flatMap((entry) => {
    const observation = entry.resource;
    return observation && isLiveHistoryObservation(observation, parsed.data.encounterReference)
      ? [observation]
      : [];
  });
  if (liveHistory.some((observation) => !observation.id)) {
    throw new Error("History upsert found a persisted Observation without an id.");
  }
  const identifierValue = encounterId;
  const canonical = chooseCanonicalHistory(liveHistory, identifierValue);
  const observation = historyObservationForUpsert(captured.observation, canonical, identifierValue);
  const observationFullUrl = "urn:uuid:hpi-observation";
  const observationTarget = canonical?.id ? `Observation/${canonical.id}` : observationFullUrl;
  const activityCode = canonical ? "UPDATE" : "CREATE";
  const provenanceResource: Provenance = {
    ...captured.provenance,
    activity: odosConcept(activityCode, [
      "Capture presenting complaints, history narrative, and review of systems",
      ...parsed.data.reviewAttestations.map((group) => `${group} remaining items reviewed negative`),
    ].join("; ")),
    target: [
      reference(observationTarget),
      reference(parsed.data.encounterReference),
      reference(parsed.data.patientReference),
    ],
  };
  const duplicateEntries = liveHistory
    .filter((candidate) => candidate.id !== canonical?.id)
    .map((duplicate) => ({
      resource: { ...duplicate, status: "entered-in-error" as const },
      request: {
        method: "PUT" as const,
        url: `Observation/${duplicate.id}`,
        ...(duplicate.meta?.versionId ? { ifMatch: `W/\"${duplicate.meta.versionId}\"` } : {}),
      },
    }));
  const transactionRequest: Bundle = {
    resourceType: "Bundle",
    type: "transaction",
    entry: [
      canonical?.id
        ? {
            resource: observation,
            request: {
              method: "PUT",
              url: `Observation/${canonical.id}`,
              ...(canonical.meta?.versionId ? { ifMatch: `W/\"${canonical.meta.versionId}\"` } : {}),
            },
          }
        : {
            fullUrl: observationFullUrl,
            resource: observation,
            request: {
              method: "PUT",
              url: `Observation?identifier=${HPI_OBSERVATION_IDENTIFIER_SYSTEM}|${identifierValue}`,
            },
          },
      { fullUrl: "urn:uuid:hpi-provenance", resource: provenanceResource, request: { method: "POST", url: "Provenance" } },
      ...duplicateEntries,
    ],
  };
  const transaction = await staff.fhir.executeTransaction(transactionRequest, {
    ...WRITE_HEADERS,
    Prefer: "return=representation",
  });
  assertSuccessfulTransaction(transactionRequest, transaction);
  const observationReference = canonical?.id
    ? `Observation/${canonical.id}`
    : transactionResourceReference(transaction, 0, "Observation");
  const provenanceReference = transactionResourceReference(transaction, 1, "Provenance");
  return {
    status: 200,
    body: {
      observationReference,
      encounterReference: parsed.data.encounterReference,
      narratives: complaints.map((complaint) => renderComplaintNarrative(
        complaint,
        definitions.find((candidate) => candidate.stableKey === complaint.complaintKey),
      )),
      ...(provenanceReference ? { provenanceReference } : {}),
    },
  };
}

function isLiveHistoryObservation(observation: Observation, encounterReference: string): boolean {
  return observation.status !== "entered-in-error" && observation.status !== "cancelled" &&
    observation.encounter?.reference === encounterReference &&
    observation.code.coding?.some((coding) =>
      coding.system === ODOS_OPHTHALMOLOGY_CODE_SYSTEM && coding.code === HPI_STABLE_KEY
    ) === true;
}

function chooseCanonicalHistory(observations: Observation[], identifierValue: string): Observation | undefined {
  return [...observations].sort((left, right) => {
    const leftIdentified = hasHistoryIdentifier(left, identifierValue) ? 1 : 0;
    const rightIdentified = hasHistoryIdentifier(right, identifierValue) ? 1 : 0;
    return rightIdentified - leftIdentified ||
      historyInstant(right).localeCompare(historyInstant(left)) ||
      (left.id ?? "").localeCompare(right.id ?? "");
  })[0];
}

function historyObservationForUpsert(
  captured: Observation,
  existing: Observation | undefined,
  identifierValue: string,
): Observation {
  const identifiers = (existing?.identifier ?? []).filter((identifier) =>
    identifier.system !== HPI_OBSERVATION_IDENTIFIER_SYSTEM
  );
  return {
    ...captured,
    ...(existing?.id ? { id: existing.id } : { id: undefined }),
    ...(existing?.meta ? { meta: existing.meta } : {}),
    identifier: [
      ...identifiers,
      { system: HPI_OBSERVATION_IDENTIFIER_SYSTEM, value: identifierValue },
    ],
  };
}

function hasHistoryIdentifier(observation: Observation, identifierValue: string): boolean {
  return observation.identifier?.some((identifier) =>
    identifier.system === HPI_OBSERVATION_IDENTIFIER_SYSTEM && identifier.value === identifierValue
  ) === true;
}

function historyInstant(observation: Observation): string {
  return observation.effectiveDateTime ?? observation.issued ?? observation.meta?.lastUpdated ?? "";
}

function assertSuccessfulTransaction(request: Bundle, response: Bundle): void {
  const entries = response.entry;
  if (response.type !== "transaction-response" || !entries || entries.length !== request.entry?.length) {
    throw new Error("History upsert did not return a complete transaction response.");
  }
  for (const entry of entries) {
    const status = Number.parseInt(entry.response?.status ?? "", 10);
    if (!Number.isInteger(status) || status < 200 || status >= 300) {
      throw new Error(`History upsert transaction failed with ${entry.response?.status ?? "no status"}.`);
    }
  }
}

function transactionResourceReference(
  transaction: Bundle,
  index: number,
  resourceType: "Observation" | "Provenance",
): string {
  const location = transaction.entry?.[index]?.response?.location;
  const match = location?.match(new RegExp(`^${resourceType}/([A-Za-z0-9.-]+)(?:/_history/[A-Za-z0-9.-]+)?$`));
  if (!match) throw new Error(`History upsert transaction did not identify the ${resourceType}.`);
  return `${resourceType}/${match[1]}`;
}

function historyFindingValue(
  complaints: Awaited<ReturnType<FhirEncounterComplaintStore["listByEncounter"]>>,
  definitions: Awaited<ReturnType<FhirComplaintDefinitionStore["list"]>>,
  reviewOfSystems: z.infer<typeof rosFlagSchema>[],
  reviewAttestations: Array<"eye" | "general">,
): Extract<FindingValue, { type: "components" }> {
  const components: Extract<FindingValue, { type: "components" }>["components"] = complaints.map((complaint) => ({
    code: `HISTORY_COMPLAINT_${complaint.ordinal}`,
    display: complaint.ordinal === 1 ? "Primary complaint history" : `Complaint ${complaint.ordinal} history`,
    value: renderComplaintNarrative(complaint, definitions.find((candidate) => candidate.stableKey === complaint.complaintKey)),
  }));
  for (const flag of reviewOfSystems) {
    components.push({ code: `ROS_${snakeCase(flag.code)}`, display: flag.display, value: flag.status });
  }
  for (const group of reviewAttestations) {
    components.push({
      code: `ROS_ATTESTED_${snakeCase(group)}`,
      display: `${group === "eye" ? "Eye" : "General"} review of systems attested`,
      value: true,
    });
  }
  return { type: "components", components };
}

function validateRos(flags: z.infer<typeof rosFlagSchema>[], definition: ClinicalFindingDefinition): string | undefined {
  const field = asRecord(asRecord(definition.valueSchema.fields).reviewOfSystems);
  const options = Array.isArray(field.options) ? field.options.map(asRecord) : [];
  const byCode = new Map(options.flatMap((option) =>
    typeof option.code === "string" && typeof option.category === "string"
      ? [[option.code, option] as const]
      : []
  ));
  for (const flag of flags) {
    const option = byCode.get(flag.code);
    if (!option) {
      if (flag.code.startsWith("custom-") && flag.category === "general") continue;
      return `Review-of-systems flag ${flag.code} is unknown or inactive.`;
    }
    if (option.active === false) return `Review-of-systems flag ${flag.code} is unknown or inactive.`;
    if (option.category !== flag.category) return `Review-of-systems flag ${flag.code} has the wrong category.`;
  }
  return undefined;
}

function resolveHpiDefinition(suppliedDefinitions: ClinicalFindingDefinition[] | undefined): ClinicalFindingDefinition {
  const definitions = suppliedDefinitions ?? [buildHpiFindingDefinition({
    source: "manual",
    recordedAt: new Date(0).toISOString(),
    actorReference: "Practitioner/odos-system",
  })];
  const definition = definitions.find((candidate) => candidate.stableKey === HPI_STABLE_KEY);
  if (!definition) throw new Error("HPI finding definition seed is missing.");
  return definition;
}

function snakeCase(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, "$1_$2").replaceAll("-", "_").toUpperCase();
}

function staffMay(role: PracticeRoleId, action: "chart.read" | "chart.write"): boolean {
  try {
    assertBusinessActionAllowed(role, action);
    return true;
  } catch {
    return false;
  }
}

function resourceReference(id: string | undefined, fallbackId: string | undefined): string {
  const resolvedId = id ?? fallbackId;
  if (!resolvedId) throw new Error("Observation create response did not include an id.");
  return `Observation/${resolvedId}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
