import type { Basic, Bundle, Procedure, Provenance } from "@medplum/fhirtypes";
import { z } from "zod";
import {
  assertBusinessActionAllowed,
  type BusinessAction,
  type PracticeRoleId,
} from "../authz/roles.js";
import { buildProvenance } from "../fhir/ophthalmology/provenance.js";
import {
  AESTHETICS_PROCEDURE_TYPE_SYSTEM,
  FhirProcedureDefinitionStore,
  buildProcedureFromDefinition,
  type ClinicalProcedureDefinition,
  type ProcedureDefinitionFhirClient,
} from "./procedure-definition-store.js";

export interface ProcedureDefinitionEndpointFhirClient extends ProcedureDefinitionFhirClient {
  create<T extends Basic | Procedure | Provenance>(
    resource: T,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
  search<T extends Basic | Procedure>(
    resourceType: T["resourceType"],
    params?: Record<string, string>,
  ): Promise<Bundle<T>>;
}

export interface ProcedureDefinitionEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<{
    staffReference: string;
    actorRole: PracticeRoleId;
    fhir: ProcedureDefinitionEndpointFhirClient;
  } | null>;
  procedureDefinitions?: () => ClinicalProcedureDefinition[];
  now?: () => string;
}

const WRITE_HEADERS = {
  "X-OSOD-Source": "mcp/create_definition_backed_procedure",
} as const;

const captureSchema = z.object({
  patientReference: z.string().regex(/^Patient\/[^/]+$/),
  encounterReference: z.string().regex(/^Encounter\/[^/]+$/),
  performedDateTime: z.string().datetime().optional(),
}).strict();

const historyQuerySchema = z.object({
  patient: z.string().regex(/^Patient\/[^/]+$/),
  encounter: z.string().regex(/^Encounter\/[^/]+$/).optional(),
}).strict();

export async function handleProcedureDefinitionCatalogRequest(
  deps: ProcedureDefinitionEndpointDeps,
  input: { authHeader: string | undefined },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) {
    return { status: 401, body: { error: "Authentication required to read procedure definitions." } };
  }
  if (!staffMay(staff.actorRole, "chart.read")) {
    return { status: 403, body: { error: "chart.read role required" } };
  }
  const definitions = deps.procedureDefinitions?.() ??
    await new FhirProcedureDefinitionStore(staff.fhir).list();
  return {
    status: 200,
    body: {
      definitions: definitions.filter((definition) => definition.active).map(definitionSummary),
    },
  };
}

export async function handleProcedureDefinitionCaptureRequest(
  deps: ProcedureDefinitionEndpointDeps,
  input: {
    authHeader: string | undefined;
    params: unknown;
    body: unknown;
  },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) {
    return { status: 401, body: { error: "Authentication required to record a procedure." } };
  }
  if (!staffMay(staff.actorRole, "aesthetics.procedure.write")) {
    return { status: 403, body: { error: "aesthetics.procedure.write role required" } };
  }
  const stableKey = readStableKey(input.params);
  if (!stableKey) {
    return { status: 400, body: { error: "A valid procedure-definition stableKey is required." } };
  }
  const parsed = captureSchema.safeParse(input.body);
  if (!parsed.success) {
    return {
      status: 400,
      body: { error: parsed.error.issues[0]?.message ?? "Invalid procedure capture." },
    };
  }
  const definitions = deps.procedureDefinitions?.() ??
    await new FhirProcedureDefinitionStore(staff.fhir).list();
  const definition = definitions.find((candidate) =>
    candidate.stableKey === stableKey &&
    candidate.active &&
    candidate.discipline === "aesthetics"
  );
  if (!definition) {
    return { status: 404, body: { error: `Active procedure definition ${stableKey} does not exist.` } };
  }
  const performedDateTime = parsed.data.performedDateTime ??
    deps.now?.() ??
    new Date().toISOString();
  const procedure = await staff.fhir.create(
    buildProcedureFromDefinition(definition, {
      patientReference: parsed.data.patientReference,
      encounterReference: parsed.data.encounterReference,
      performedDateTime,
    }),
    WRITE_HEADERS,
  );
  const procedureReference = `Procedure/${procedure.id}`;
  const provenance = await staff.fhir.create(
    buildProvenance({
      targetReferences: [procedureReference, parsed.data.patientReference],
      occurredDateTime: performedDateTime,
      activityCode: "CREATE",
      activityDisplay: "Create",
      agents: [{
        typeCode: "author",
        typeDisplay: "Author",
        whoReference: staff.staffReference,
      }],
    }),
    WRITE_HEADERS,
  );
  return {
    status: 201,
    body: {
      procedure,
      procedureReference,
      ...(provenance.id ? { provenanceReference: `Provenance/${provenance.id}` } : {}),
    },
  };
}

export async function handleProcedureDefinitionHistoryRequest(
  deps: ProcedureDefinitionEndpointDeps,
  input: {
    authHeader: string | undefined;
    params: unknown;
    query: unknown;
  },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) {
    return { status: 401, body: { error: "Authentication required to read procedure history." } };
  }
  if (!staffMay(staff.actorRole, "chart.read")) {
    return { status: 403, body: { error: "chart.read role required" } };
  }
  const stableKey = readStableKey(input.params);
  const parsed = historyQuerySchema.safeParse(input.query);
  if (!stableKey || !parsed.success) {
    return { status: 400, body: { error: "Valid procedure definition and patient are required." } };
  }
  const definitions = deps.procedureDefinitions?.() ??
    await new FhirProcedureDefinitionStore(staff.fhir).list();
  const definition = definitions.find((candidate) => candidate.stableKey === stableKey);
  if (!definition) {
    return { status: 404, body: { error: `Procedure definition ${stableKey} does not exist.` } };
  }
  const code = definition.fhirProcedureCode;
  const coding = procedureSearchCoding(code);
  if (!coding?.system || !coding.code) {
    return { status: 409, body: { error: `Procedure definition ${stableKey} has no searchable code.` } };
  }
  const bundle = await staff.fhir.search<Procedure>("Procedure", {
    subject: parsed.data.patient,
    code: `${coding.system}|${coding.code}`,
    ...(parsed.data.encounter ? { encounter: parsed.data.encounter } : {}),
    _sort: "-date",
    _count: "200",
  });
  return {
    status: 200,
    body: {
      rows: (bundle.entry ?? []).flatMap((entry) => entry.resource ? [{
        recordedAt: entry.resource.performedDateTime ?? entry.resource.meta?.lastUpdated ?? "",
        values: [],
        procedureReference: entry.resource.id ? `Procedure/${entry.resource.id}` : undefined,
      }] : []),
    },
  };
}

function procedureSearchCoding(
  code: ClinicalProcedureDefinition["fhirProcedureCode"],
): { system?: string; code?: string } | undefined {
  if ("system" in code && "code" in code) return code;
  return code.coding?.find((candidate) => candidate.system && candidate.code);
}

function definitionSummary(definition: ClinicalProcedureDefinition) {
  return {
    resourceKind: "procedure",
    stableKey: definition.stableKey,
    sectionKey: definition.sectionKey,
    display: definition.display,
    discipline: definition.discipline,
    active: definition.active,
    sourceStatus: definition.sourceStatus,
    perEye: false,
    customFields: [],
    notBillReady: definition.notBillReady,
    codeSystem: AESTHETICS_PROCEDURE_TYPE_SYSTEM,
  };
}

function readStableKey(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const stableKey = (value as Record<string, unknown>).stableKey;
  return typeof stableKey === "string" && stableKey.trim() ? stableKey.trim() : undefined;
}

function staffMay(role: PracticeRoleId, action: BusinessAction): boolean {
  try {
    assertBusinessActionAllowed(role, action);
    return true;
  } catch {
    return false;
  }
}
