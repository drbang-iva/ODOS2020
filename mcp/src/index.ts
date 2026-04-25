#!/usr/bin/env node
/**
 * OSOD MCP Server
 *
 * Exposes Medplum FHIR resources as MCP tools so Claude, Iris, Netra,
 * Dharma, or any MCP-compatible agent can read and write OSOD data.
 *
 * Transport: stdio (standard MCP). Suitable for launch-on-demand by
 * Claude Desktop, Claude Code, Iris's OpenClaw, etc.
 *
 * Auth: reads MEDPLUM_BASE_URL / ADMIN_EMAIL / ADMIN_PASSWORD from env;
 * performs PKCE OAuth2 login for stdio startup or the first SSE session,
 * then refreshes on demand.
 *
 * Zero Medplum SDK — plain fetch against the FHIR REST API.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { isIP } from "node:net";
import { z } from "zod";
import { createMedplumClient, type JsonPatchOperation } from "./fhir-client.js";
import { osodConcept, normalizeLaterality, patientReference, encounterReference } from "./fhir/ophthalmology/extensions.js";
import { buildIopObservation } from "./fhir/ophthalmology/iop.js";
import { buildVisualAcuityObservation } from "./fhir/ophthalmology/visualAcuity.js";
import { buildRefractionObservation } from "./fhir/ophthalmology/refraction.js";
import { buildDocumentReference } from "./fhir/ophthalmology/rawAssets.js";
import { buildProvenance } from "./fhir/ophthalmology/provenance.js";
import type { Encounter, Patient } from "@medplum/fhirtypes";
import type {
  IopMethod,
  RefractionType,
  SourceType,
  VisualAcuityChartType,
  VisualAcuityCorrection,
} from "./fhir/ophthalmology/types.js";

const BASE_URL = process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103";
const EMAIL = process.env.MEDPLUM_ADMIN_EMAIL;
const PASSWORD = process.env.MEDPLUM_ADMIN_PASSWORD;
const CREATE_OBSERVATION_AUDIT_HEADERS = {
  "X-OSOD-Source": "mcp/create_observation",
} as const;
const CREATE_ENCOUNTER_AUDIT_HEADERS = {
  "X-OSOD-Source": "mcp/create_encounter",
} as const;
const UPDATE_PATIENT_AUDIT_HEADERS = {
  "X-OSOD-Source": "mcp/update_patient",
} as const;
const HL7_V3_ACT_ENCOUNTER_CLASS_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/v3-ActCode";
const AMA_CPT_CODE_SYSTEM = "http://www.ama-assn.org/go/cpt";
// Verified against http://terminology.hl7.org/CodeSystem/v3-ActCode.
const HL7_V3_ACT_ENCOUNTER_CLASS_CODES = [
  "AMB",
  "EMER",
  "IMP",
  "HH",
  "SS",
  "VR",
  "OBSENC",
  "PRENC",
] as const;
const FHIR_ENCOUNTER_STATUS_CODES = [
  "planned",
  "arrived",
  "triaged",
  "in-progress",
  "onleave",
  "finished",
  "cancelled",
  "entered-in-error",
  "unknown",
] as const;
const FHIR_PATIENT_GENDER_CODES = ["male", "female", "other", "unknown"] as const;
const FHIR_HUMAN_NAME_USE_CODES = [
  "usual",
  "official",
  "temp",
  "nickname",
  "anonymous",
  "old",
  "maiden",
] as const;
const FHIR_CONTACT_POINT_SYSTEM_CODES = [
  "phone",
  "fax",
  "email",
  "pager",
  "url",
  "sms",
  "other",
] as const;
const FHIR_CONTACT_POINT_USE_CODES = ["home", "work", "temp", "old", "mobile"] as const;
const FHIR_ADDRESS_USE_CODES = ["home", "work", "temp", "old", "billing"] as const;
const FHIR_ADDRESS_TYPE_CODES = ["postal", "physical", "both"] as const;

const fhir = createMedplumClient({ baseUrl: BASE_URL });
let authPromise: Promise<void> | undefined;

/* --------------------------------------------------------------------------
 * Tool definitions — start minimal; grow as OSOD needs more agent surfaces.
 * Every tool returns plain FHIR JSON so the consuming agent sees exactly
 * what a human developer would see in the admin UI.
 * ------------------------------------------------------------------------ */

const tools = [
  {
    name: "list_patients",
    description:
      "List patients in the OSOD instance. Returns a FHIR Bundle of Patient resources.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Optional name filter (family or given name substring match).",
        },
        limit: { type: "number", description: "Max results (default 20)." },
      },
    },
  },
  {
    name: "get_patient",
    description: "Fetch a single Patient resource by ID. Returns full FHIR JSON.",
    inputSchema: {
      type: "object",
      required: ["patient_id"],
      properties: {
        patient_id: { type: "string", description: "FHIR Patient resource ID." },
      },
    },
  },
  {
    name: "update_patient",
    description:
      "Update native FHIR Patient fields using JSON Patch replace operations. Writes use X-OSOD-Source=mcp/update_patient.",
    inputSchema: {
      type: "object",
      required: ["patient_id"],
      properties: {
        patient_id: { type: "string", description: "FHIR Patient ID or Patient/<id>." },
        active: { type: "boolean" },
        gender: { type: "string", enum: FHIR_PATIENT_GENDER_CODES },
        birth_date: {
          type: "string",
          description: "FHIR Patient.birthDate in YYYY-MM-DD format.",
        },
        name: {
          type: "object",
          description: "Replaces all Patient.name with a single HumanName.",
          required: ["family", "given"],
          properties: {
            family: { type: "string" },
            given: { type: "array", items: { type: "string" } },
            prefix: { type: "array", items: { type: "string" } },
            suffix: { type: "array", items: { type: "string" } },
            use: { type: "string", enum: FHIR_HUMAN_NAME_USE_CODES, default: "official" },
          },
        },
        telecom: {
          type: "array",
          description: "Replaces all Patient.telecom.",
          items: {
            type: "object",
            required: ["system", "value"],
            properties: {
              system: { type: "string", enum: FHIR_CONTACT_POINT_SYSTEM_CODES },
              value: { type: "string" },
              use: { type: "string", enum: FHIR_CONTACT_POINT_USE_CODES },
              rank: { type: "number" },
            },
          },
        },
        address: {
          type: "array",
          description: "Replaces all Patient.address.",
          items: {
            type: "object",
            properties: {
              use: { type: "string", enum: FHIR_ADDRESS_USE_CODES },
              type: { type: "string", enum: FHIR_ADDRESS_TYPE_CODES },
              line: { type: "array", items: { type: "string" } },
              city: { type: "string" },
              state: { type: "string" },
              postal_code: { type: "string" },
              country: { type: "string" },
            },
          },
        },
      },
    },
  },
  {
    name: "get_encounters",
    description:
      "List Encounter resources for a given Patient. Returns a FHIR Bundle.",
    inputSchema: {
      type: "object",
      required: ["patient_id"],
      properties: {
        patient_id: { type: "string", description: "FHIR Patient resource ID." },
        limit: { type: "number", description: "Max results (default 20)." },
      },
    },
  },
  {
    name: "get_observations",
    description:
      "List Observation resources for a given Patient. Supports anatomical-location filter for OSOD Director orbital queries.",
    inputSchema: {
      type: "object",
      required: ["patient_id"],
      properties: {
        patient_id: { type: "string", description: "FHIR Patient resource ID." },
        category: {
          type: "string",
          description:
            "Optional Observation category (e.g. vital-signs, exam, imaging).",
        },
        limit: { type: "number", description: "Max results (default 50)." },
      },
    },
  },
  {
    name: "get_charge_items",
    description:
      "List ChargeItem resources for a given Patient or Encounter. Use to see CPT codes billed during an encounter.",
    inputSchema: {
      type: "object",
      properties: {
        patient_id: { type: "string", description: "Optional Patient filter." },
        encounter_id: {
          type: "string",
          description: "Optional Encounter filter (scoped to one visit).",
        },
        limit: { type: "number", description: "Max results (default 50)." },
      },
    },
  },
  {
    name: "fhir_search",
    description:
      "Escape hatch: perform an arbitrary FHIR search against any resource type. Returns a FHIR Bundle. Use sparingly; prefer the specific tools above.",
    inputSchema: {
      type: "object",
      required: ["resource_type"],
      properties: {
        resource_type: {
          type: "string",
          description:
            "FHIR resourceType (e.g. Patient, Encounter, Observation).",
        },
        params: {
          type: "object",
          description: "FHIR search parameters as key-value pairs.",
        },
      },
    },
  },
  {
    name: "create_encounter",
    description:
      "Create a FHIR Encounter for a Patient. Writes use X-OSOD-Source=mcp/create_encounter.",
    inputSchema: {
      type: "object",
      required: ["patient_id", "class_code", "status"],
      properties: {
        patient_id: { type: "string", description: "FHIR Patient ID or Patient/<id>." },
        class_code: {
          type: "string",
          enum: HL7_V3_ACT_ENCOUNTER_CLASS_CODES,
          description:
            "FHIR Encounter.class code from http://terminology.hl7.org/CodeSystem/v3-ActCode.",
        },
        status: {
          type: "string",
          enum: FHIR_ENCOUNTER_STATUS_CODES,
          description: "Native FHIR Encounter.status enum.",
        },
        practitioner_reference: {
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          description: "Practitioner/<id> reference(s) for Encounter.participant.individual.",
        },
        type_system: {
          type: "string",
          description:
            "Code system for Encounter.type visit type. CPT billing codes belong in ChargeItem, not Encounter.type.",
        },
        type_code: { type: "string" },
        type_display: { type: "string" },
        period_start: { type: "string", description: "ISO timestamp for Encounter.period.start." },
        period_end: { type: "string", description: "ISO timestamp for Encounter.period.end." },
        reason_code: {
          type: "string",
          description: "Reason code for Encounter.reasonCode.coding.",
        },
        reason_system: {
          type: "string",
          description:
            "Reason code system. Defaults to http://snomed.info/sct when reason_code is supplied.",
        },
        reason_display: { type: "string" },
        create_provenance: {
          type: "boolean",
          description:
            "When true, also creates Provenance for the generated Encounter using the supplied agent metadata.",
        },
        provenance_agent_reference: { type: "string" },
        provenance_agent_display: { type: "string" },
      },
    },
  },
  {
    name: "create_observation",
    description:
      "Create a FHIR-native ophthalmic Observation for visual acuity, IOP, or refraction. Writes use X-OSOD-Source=mcp/create_observation.",
    inputSchema: {
      type: "object",
      required: ["type", "patient_id", "encounter_id", "laterality"],
      properties: {
        type: {
          type: "string",
          enum: ["iop", "va", "refraction"],
          description: "Observation type.",
        },
        patient_id: { type: "string", description: "FHIR Patient ID or Patient/<id>." },
        encounter_id: { type: "string", description: "FHIR Encounter ID or Encounter/<id>." },
        laterality: {
          type: "string",
          enum: ["od", "os", "ou", "unknown", "OD", "OS", "OU", "UNKNOWN"],
        },
        measured_at: {
          type: "string",
          description: "ISO timestamp. Defaults to current server time if omitted.",
        },
        source_reference: {
          type: "string",
          description:
            "Optional source DocumentReference/Media/ImagingStudy/Observation/QuestionnaireResponse reference for Observation.derivedFrom.",
        },
        device_reference: { type: "string" },
        performer_reference: { type: "string" },
        quality_score: { type: "number" },
        confidence_score: { type: "number" },
        method: {
          type: "string",
          description: "IOP method (GAT/iCare/Tonopen/NCT/Perkins) or refraction method.",
        },
        value: { type: "number", description: "IOP value in mmHg." },
        snellen: { type: "string", description: "Raw Snellen acuity such as 20/40." },
        logmar: { type: "number" },
        letter_score: { type: "number" },
        chart_type: { type: "string", enum: ["SNELLEN", "ETDRS", "LOGMAR", "OTHER", "UNKNOWN"] },
        correction: { type: "string", enum: ["SC", "CC", "PH", "NI", "OTHER", "UNKNOWN"] },
        distance: { type: "number" },
        distance_unit: { type: "string", enum: ["ft", "m"] },
        refraction_type: {
          type: "string",
          enum: ["AUTOREFRACTION", "MANIFEST", "CYCLOPLEGIC", "FINAL_RX", "OTHER"],
        },
        sphere: { type: "number" },
        cylinder: { type: "number" },
        axis: { type: "number" },
        add: { type: "number" },
        create_provenance: {
          type: "boolean",
          description:
            "When true, also creates Provenance for the generated Observation using the supplied agent/source metadata.",
        },
        provenance_agent_reference: { type: "string" },
        provenance_agent_display: { type: "string" },
      },
    },
  },
  {
    name: "create_raw_asset_reference",
    description:
      "Create a DocumentReference index for an ophthalmic PDF/image/vendor export. Attachment.hash is SHA-1/base64; OSOD SHA-256 goes in the source-sha256 extension.",
    inputSchema: {
      type: "object",
      required: ["patient_id", "content_type"],
      properties: {
        patient_id: { type: "string" },
        encounter_id: { type: "string" },
        content_type: { type: "string" },
        title: { type: "string" },
        original_filename: { type: "string" },
        creation: { type: "string" },
        size: { type: "number" },
        sha1_base64: { type: "string" },
        sha256: { type: "string" },
        url: { type: "string" },
        data: { type: "string" },
        description: { type: "string" },
        author_reference: { type: "string" },
        custodian_reference: { type: "string" },
      },
    },
  },
] as const;

/* ----- Input validation schemas (Zod) ----- */
const listPatientsSchema = z.object({
  name: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
});
const getByIdSchema = z.object({ patient_id: z.string().min(1) });
const updatePatientNameSchema = z.object({
  family: z.string(),
  given: z.array(z.string()),
  prefix: z.array(z.string()).optional(),
  suffix: z.array(z.string()).optional(),
  use: z.enum(FHIR_HUMAN_NAME_USE_CODES).default("official"),
});
const updatePatientTelecomSchema = z.object({
  system: z.enum(FHIR_CONTACT_POINT_SYSTEM_CODES),
  value: z.string(),
  use: z.enum(FHIR_CONTACT_POINT_USE_CODES).optional(),
  rank: z.number().optional(),
});
const updatePatientAddressSchema = z.object({
  use: z.enum(FHIR_ADDRESS_USE_CODES).optional(),
  type: z.enum(FHIR_ADDRESS_TYPE_CODES).optional(),
  line: z.array(z.string()).optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postal_code: z.string().optional(),
  country: z.string().optional(),
});
const updatePatientSchema = z.object({
  patient_id: z.string({ required_error: "patient_id is required." }).min(1, "patient_id is required."),
  active: z.boolean().optional(),
  gender: z.enum(FHIR_PATIENT_GENDER_CODES).optional(),
  birth_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "birth_date must use YYYY-MM-DD format.")
    .optional(),
  name: updatePatientNameSchema.optional(),
  telecom: z.array(updatePatientTelecomSchema).optional(),
  address: z.array(updatePatientAddressSchema).optional(),
});
const getEncountersSchema = z.object({
  patient_id: z.string().min(1),
  limit: z.number().int().positive().max(200).optional(),
});
const getObsSchema = z.object({
  patient_id: z.string().min(1),
  category: z.string().optional(),
  limit: z.number().int().positive().max(500).optional(),
});
const getChargesSchema = z.object({
  patient_id: z.string().optional(),
  encounter_id: z.string().optional(),
  limit: z.number().int().positive().max(500).optional(),
});
const fhirSearchSchema = z.object({
  resource_type: z.string().min(1),
  params: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
});
const maybeStringArraySchema = z.union([z.string(), z.array(z.string())]).optional();
const encounterClassCodeSchema = z.enum(HL7_V3_ACT_ENCOUNTER_CLASS_CODES, {
  errorMap: (issue, ctx) => {
    if (issue.code === z.ZodIssueCode.invalid_enum_value) {
      return {
        message: `class_code must be one of: ${HL7_V3_ACT_ENCOUNTER_CLASS_CODES.join(", ")}.`,
      };
    }
    if (issue.code === z.ZodIssueCode.invalid_type) {
      return {
        message: `class_code is required and must be one of: ${HL7_V3_ACT_ENCOUNTER_CLASS_CODES.join(", ")}.`,
      };
    }
    return { message: ctx.defaultError };
  },
});
const encounterStatusSchema = z.enum(FHIR_ENCOUNTER_STATUS_CODES, {
  errorMap: (issue, ctx) => {
    if (issue.code === z.ZodIssueCode.invalid_enum_value) {
      return {
        message: `status must be one of: ${FHIR_ENCOUNTER_STATUS_CODES.join(", ")}.`,
      };
    }
    if (issue.code === z.ZodIssueCode.invalid_type) {
      return {
        message: `status is required and must be one of: ${FHIR_ENCOUNTER_STATUS_CODES.join(", ")}.`,
      };
    }
    return { message: ctx.defaultError };
  },
});
const isoTimestampSchema = z.string().datetime({ message: "Expected an ISO timestamp." });
const createEncounterSchema = z.object({
  patient_id: z.string({ required_error: "patient_id is required." }).min(1, "patient_id is required."),
  class_code: encounterClassCodeSchema,
  status: encounterStatusSchema,
  practitioner_reference: maybeStringArraySchema,
  type_system: z
    .string()
    .refine((system) => system.trim() !== AMA_CPT_CODE_SYSTEM, {
      message: "Encounter.type must describe visit type; CPT billing codes belong in ChargeItem.",
    })
    .optional(),
  type_code: z.string().optional(),
  type_display: z.string().optional(),
  period_start: isoTimestampSchema.optional(),
  period_end: isoTimestampSchema.optional(),
  reason_code: z.string().optional(),
  reason_system: z.string().optional(),
  reason_display: z.string().optional(),
  create_provenance: z.boolean().optional(),
  provenance_agent_reference: z.string().optional(),
  provenance_agent_display: z.string().optional(),
});
const createObservationSchema = z.object({
  type: z.enum(["iop", "va", "refraction"]),
  patient_id: z.string().min(1),
  encounter_id: z.string().min(1),
  laterality: z.string().optional(),
  eye: z.string().optional(),
  measured_at: z.string().optional(),
  measuredAt: z.string().optional(),
  source_reference: maybeStringArraySchema,
  sourceReference: maybeStringArraySchema,
  device_reference: z.string().optional(),
  device: z.string().optional(),
  performer_reference: maybeStringArraySchema,
  performer: maybeStringArraySchema,
  quality_score: z.number().optional(),
  qualityScore: z.number().optional(),
  confidence_score: z.number().optional(),
  confidenceScore: z.number().optional(),
  source_label: z.string().optional(),
  source_type: z.string().optional(),
  method: z.string().optional(),
  value: z.number().optional(),
  snellen: z.string().optional(),
  logmar: z.number().optional(),
  letter_score: z.number().int().optional(),
  letterScore: z.number().int().optional(),
  chart_type: z.string().optional(),
  chartType: z.string().optional(),
  correction: z.string().optional(),
  distance: z.number().optional(),
  distance_unit: z.enum(["ft", "m"]).optional(),
  distanceUnit: z.enum(["ft", "m"]).optional(),
  allow_unparseable: z.boolean().optional(),
  allowUnparseable: z.boolean().optional(),
  refraction_type: z.string().optional(),
  refractionType: z.string().optional(),
  sphere: z.number().optional(),
  cylinder: z.number().optional(),
  axis: z.number().optional(),
  add: z.number().optional(),
  create_provenance: z.boolean().optional(),
  createProvenance: z.boolean().optional(),
  provenance_agent_reference: z.string().optional(),
  provenanceAgentReference: z.string().optional(),
  provenance_agent_display: z.string().optional(),
  provenanceAgentDisplay: z.string().optional(),
});
const createRawAssetReferenceSchema = z.object({
  patient_id: z.string().min(1),
  encounter_id: z.string().optional(),
  content_type: z.string().min(1),
  title: z.string().optional(),
  original_filename: z.string().optional(),
  creation: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  sha1_base64: z.string().optional(),
  sha256: z.string().optional(),
  url: z.string().optional(),
  data: z.string().optional(),
  description: z.string().optional(),
  author_reference: maybeStringArraySchema,
  custodian_reference: z.string().optional(),
});

/* --------------------------------------------------------------------------
 * MCP server wiring
 * ------------------------------------------------------------------------ */

function createServer(): Server {
  const server = new Server(
    { name: "osod-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;

    try {
      switch (name) {
        case "list_patients": {
          const { name: nameQ, limit } = listPatientsSchema.parse(args);
          const p: Record<string, string> = { _count: String(limit ?? 20) };
          if (nameQ) p.name = nameQ;
          const bundle = await fhir.search("Patient", p);
          return { content: [{ type: "text", text: JSON.stringify(bundle, null, 2) }] };
        }
        case "get_patient": {
          const { patient_id } = getByIdSchema.parse(args);
          const resource = await fhir.read("Patient", patient_id);
          return { content: [{ type: "text", text: JSON.stringify(resource, null, 2) }] };
        }
        case "update_patient": {
          const input = updatePatientSchema.parse(args);
          const operations = buildUpdatePatientPatchOperations(input);
          const updatedPatient = await fhir.patch<Patient>(
            "Patient",
            stripPatientReference(input.patient_id),
            operations,
            UPDATE_PATIENT_AUDIT_HEADERS,
          );
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ patient: updatedPatient }, null, 2),
              },
            ],
          };
        }
        case "get_encounters": {
          const { patient_id, limit } = getEncountersSchema.parse(args);
          const bundle = await fhir.search("Encounter", {
            subject: `Patient/${patient_id}`,
            _count: String(limit ?? 20),
          });
          return { content: [{ type: "text", text: JSON.stringify(bundle, null, 2) }] };
        }
        case "get_observations": {
          const { patient_id, category, limit } = getObsSchema.parse(args);
          const p: Record<string, string> = {
            subject: `Patient/${patient_id}`,
            _count: String(limit ?? 50),
          };
          if (category) p.category = category;
          const bundle = await fhir.search("Observation", p);
          return { content: [{ type: "text", text: JSON.stringify(bundle, null, 2) }] };
        }
        case "get_charge_items": {
          const { patient_id, encounter_id, limit } = getChargesSchema.parse(args);
          const p: Record<string, string> = { _count: String(limit ?? 50) };
          if (patient_id) p.subject = `Patient/${patient_id}`;
          if (encounter_id) p.context = `Encounter/${encounter_id}`;
          const bundle = await fhir.search("ChargeItem", p);
          return { content: [{ type: "text", text: JSON.stringify(bundle, null, 2) }] };
        }
        case "fhir_search": {
          const { resource_type, params } = fhirSearchSchema.parse(args);
          const p: Record<string, string> = {};
          for (const [k, v] of Object.entries(params ?? {})) p[k] = String(v);
          // Escape hatch — resource_type is user-supplied, must loosen the type.
          const bundle = await fhir.search(resource_type as never, p);
          return { content: [{ type: "text", text: JSON.stringify(bundle, null, 2) }] };
        }
        case "create_encounter": {
          const input = createEncounterSchema.parse(args);
          const encounterResult = buildCreateEncounterResource(input);
          const createdEncounter = await fhir.create(
            encounterResult.resource,
            CREATE_ENCOUNTER_AUDIT_HEADERS,
          );

          let createdProvenance: unknown;
          if (input.create_provenance) {
            const encounterReference = `${createdEncounter.resourceType}/${createdEncounter.id}`;
            createdProvenance = await fhir.create(
              buildProvenance({
                targetReferences: [encounterReference],
                occurredDateTime: encounterResult.resource.period?.start,
                activityCode: "ENCOUNTER_CREATE",
                activityDisplay: "Encounter create",
                agents: [
                  {
                    typeCode: "manual",
                    typeDisplay: "Manual entry",
                    whoReference: input.provenance_agent_reference,
                    whoDisplay:
                      input.provenance_agent_display ?? "OSOD MCP create_encounter",
                  },
                ],
              }),
              CREATE_ENCOUNTER_AUDIT_HEADERS,
            );
          }

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    encounter: createdEncounter,
                    provenance: createdProvenance,
                    warnings: encounterResult.warnings.length
                      ? encounterResult.warnings
                      : undefined,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        case "create_observation": {
          const input = createObservationSchema.parse(args);
          const observationResult = buildCreateObservationResource(input);
          const createdObservation = await fhir.create(
            observationResult.resource,
            CREATE_OBSERVATION_AUDIT_HEADERS,
          );

          let createdProvenance: unknown;
          if (input.create_provenance || input.createProvenance) {
            const observationReference = `${createdObservation.resourceType}/${createdObservation.id}`;
            createdProvenance = await fhir.create(
              buildProvenance({
                targetReferences: [observationReference],
                occurredDateTime: observationResult.resource.effectiveDateTime,
                activityCode: "OPHTHALMIC_DATA_CAPTURE",
                activityDisplay: "Ophthalmic data capture",
                entityReferences: getStringArray(input.source_reference ?? input.sourceReference),
                agents: [
                  {
                    typeCode: normalizeSourceType(input.source_type) === "parser" ? "parser" : "manual",
                    typeDisplay: normalizeSourceType(input.source_type) === "parser" ? "Parser" : "Manual entry",
                    whoReference:
                      input.provenance_agent_reference ?? input.provenanceAgentReference,
                    whoDisplay:
                      input.provenance_agent_display ??
                      input.provenanceAgentDisplay ??
                      "OSOD MCP create_observation",
                  },
                ],
              }),
              CREATE_OBSERVATION_AUDIT_HEADERS,
            );
          }

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    observation: createdObservation,
                    provenance: createdProvenance,
                    warnings: observationResult.warnings,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        case "create_raw_asset_reference": {
          const input = createRawAssetReferenceSchema.parse(args);
          const documentReference = buildDocumentReference({
            patientReference: patientReference(input.patient_id),
            encounterReference: input.encounter_id
              ? encounterReference(input.encounter_id)
              : undefined,
            contentType: input.content_type,
            title: input.title,
            originalFilename: input.original_filename,
            creation: input.creation,
            size: input.size,
            sha1Base64: input.sha1_base64,
            sha256: input.sha256,
            url: input.url,
            data: input.data,
            description: input.description,
            authorReferences: getStringArray(input.author_reference),
            custodianReference: input.custodian_reference,
          });
          const created = await fhir.create(documentReference, CREATE_OBSERVATION_AUDIT_HEADERS);
          return { content: [{ type: "text", text: JSON.stringify(created, null, 2) }] };
        }
        default:
          return {
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${msg}` }],
        isError: true,
      };
    }
  });

  return server;
}

type UpdatePatientInput = z.infer<typeof updatePatientSchema>;
type CreateObservationInput = z.infer<typeof createObservationSchema>;
type CreateEncounterInput = z.infer<typeof createEncounterSchema>;

function buildUpdatePatientPatchOperations(input: UpdatePatientInput): JsonPatchOperation[] {
  const operations: JsonPatchOperation[] = [];

  if (input.active !== undefined) {
    operations.push({ op: "replace", path: "/active", value: input.active });
  }

  if (input.gender !== undefined) {
    operations.push({ op: "replace", path: "/gender", value: input.gender });
  }

  if (input.birth_date !== undefined) {
    operations.push({ op: "replace", path: "/birthDate", value: input.birth_date });
  }

  if (input.name !== undefined) {
    operations.push({
      op: "replace",
      path: "/name",
      value: [
        {
          use: input.name.use,
          family: input.name.family,
          given: input.name.given,
          ...(input.name.prefix !== undefined ? { prefix: input.name.prefix } : {}),
          ...(input.name.suffix !== undefined ? { suffix: input.name.suffix } : {}),
        },
      ],
    });
  }

  if (input.telecom !== undefined) {
    operations.push({
      op: "replace",
      path: "/telecom",
      value: input.telecom.map((telecom) => ({
        system: telecom.system,
        value: telecom.value,
        ...(telecom.use !== undefined ? { use: telecom.use } : {}),
        ...(telecom.rank !== undefined ? { rank: telecom.rank } : {}),
      })),
    });
  }

  if (input.address !== undefined) {
    operations.push({
      op: "replace",
      path: "/address",
      value: input.address.map((address) => ({
        ...(address.use !== undefined ? { use: address.use } : {}),
        ...(address.type !== undefined ? { type: address.type } : {}),
        ...(address.line !== undefined ? { line: address.line } : {}),
        ...(address.city !== undefined ? { city: address.city } : {}),
        ...(address.state !== undefined ? { state: address.state } : {}),
        ...(address.postal_code !== undefined ? { postalCode: address.postal_code } : {}),
        ...(address.country !== undefined ? { country: address.country } : {}),
      })),
    });
  }

  if (operations.length === 0) {
    throw new Error("update_patient requires at least one field to update.");
  }

  return operations;
}

function stripPatientReference(patientId: string): string {
  return patientId.startsWith("Patient/") ? patientId.slice("Patient/".length) : patientId;
}

function buildCreateEncounterResource(input: CreateEncounterInput) {
  const warnings: string[] = [];
  const practitionerReferences = getStringArray(input.practitioner_reference);
  const hasType = Boolean(input.type_system || input.type_code || input.type_display);
  const hasPeriod = Boolean(input.period_start || input.period_end);
  const hasReason = Boolean(input.reason_code || input.reason_display);

  if (input.type_system && !input.type_code) {
    warnings.push("type_system was supplied without type_code; Encounter.type coding has no code.");
  }

  const encounter: Encounter = {
    resourceType: "Encounter",
    status: input.status,
    class: {
      system: HL7_V3_ACT_ENCOUNTER_CLASS_SYSTEM,
      code: input.class_code,
    },
    subject: { reference: patientReference(input.patient_id) },
    ...(practitionerReferences?.length
      ? {
          participant: practitionerReferences.map((practitionerReference) => ({
            individual: { reference: practitionerReference },
          })),
        }
      : {}),
    ...(hasType
      ? {
          type: [
            {
              ...(input.type_system || input.type_code || input.type_display
                ? {
                    coding: [
                      {
                        ...(input.type_system ? { system: input.type_system } : {}),
                        ...(input.type_code ? { code: input.type_code } : {}),
                        ...(input.type_display ? { display: input.type_display } : {}),
                      },
                    ],
                  }
                : {}),
              ...(input.type_display ? { text: input.type_display } : {}),
            },
          ],
        }
      : {}),
    ...(hasPeriod
      ? {
          period: {
            ...(input.period_start ? { start: input.period_start } : {}),
            ...(input.period_end ? { end: input.period_end } : {}),
          },
        }
      : {}),
    ...(hasReason
      ? {
          reasonCode: [
            {
              ...(input.reason_code
                ? {
                    coding: [
                      {
                        system: input.reason_system ?? "http://snomed.info/sct",
                        code: input.reason_code,
                        ...(input.reason_display ? { display: input.reason_display } : {}),
                      },
                    ],
                  }
                : {}),
              ...(input.reason_display ? { text: input.reason_display } : {}),
            },
          ],
        }
      : {}),
  };

  return { resource: encounter, warnings };
}

function buildCreateObservationResource(input: CreateObservationInput) {
  const eye = normalizeLaterality(input.laterality ?? input.eye ?? "");
  const measuredAt = input.measured_at ?? input.measuredAt ?? new Date().toISOString();
  const common = {
    patientReference: patientReference(input.patient_id),
    encounterReference: encounterReference(input.encounter_id),
    eye,
    measuredAt,
    deviceReference: input.device_reference ?? input.device,
    performerReferences: getStringArray(input.performer_reference ?? input.performer),
    sourceReferences: getStringArray(input.source_reference ?? input.sourceReference),
    qualityScore: input.quality_score ?? input.qualityScore,
    confidenceScore: input.confidence_score ?? input.confidenceScore,
    sourceLabel: input.source_label,
    sourceType: normalizeSourceType(input.source_type),
  };

  switch (input.type) {
    case "iop": {
      if (input.value === undefined) {
        throw new Error("create_observation type=iop requires value.");
      }
      return buildIopObservation({
        ...common,
        value: input.value,
        unit: "mmHg",
        method: osodConcept(normalizeIopMethod(input.method), normalizeIopMethod(input.method)),
      });
    }

    case "va": {
      if (!input.snellen) {
        throw new Error("create_observation type=va requires snellen.");
      }
      return buildVisualAcuityObservation({
        ...common,
        snellen: input.snellen,
        logmar: input.logmar,
        letterScore: input.letter_score ?? input.letterScore,
        chartType: normalizeChartType(input.chart_type ?? input.chartType),
        correction: normalizeCorrection(input.correction),
        distance: input.distance,
        distanceUnit: input.distance_unit ?? input.distanceUnit,
        method: input.method,
        allowUnparseable: input.allow_unparseable ?? input.allowUnparseable,
      });
    }

    case "refraction": {
      return buildRefractionObservation({
        ...common,
        refractionType: normalizeRefractionType(input.refraction_type ?? input.refractionType ?? input.method),
        sphere: input.sphere,
        cylinder: input.cylinder,
        axis: input.axis,
        add: input.add,
      });
    }
  }
}

function getStringArray(value: string | string[] | undefined): string[] | undefined {
  if (Array.isArray(value)) {
    return value;
  }
  return value ? [value] : undefined;
}

function normalizeIopMethod(value: string | undefined): IopMethod {
  const normalized = (value ?? "UNKNOWN").trim().toUpperCase().replace(/[-_ ]/g, "");
  if (normalized === "GAT") return "GAT";
  if (normalized === "ICARE") return "ICARE";
  if (normalized === "TONOPEN" || normalized === "TONO-PEN") return "TONOPEN";
  if (normalized === "NCT") return "NCT";
  if (normalized === "PERKINS") return "PERKINS";
  if (normalized === "OTHER") return "OTHER";
  return "UNKNOWN";
}

function normalizeChartType(value: string | undefined): VisualAcuityChartType {
  const normalized = (value ?? "UNKNOWN").trim().toUpperCase();
  if (normalized === "SNELLEN" || normalized === "ETDRS" || normalized === "LOGMAR") {
    return normalized;
  }
  if (normalized === "OTHER") return "OTHER";
  return "UNKNOWN";
}

function normalizeCorrection(value: string | undefined): VisualAcuityCorrection {
  const normalized = (value ?? "UNKNOWN").trim().toUpperCase();
  if (normalized === "SC" || normalized === "CC" || normalized === "PH" || normalized === "NI") {
    return normalized;
  }
  if (normalized === "OTHER") return "OTHER";
  return "UNKNOWN";
}

function normalizeRefractionType(value: string | undefined): RefractionType {
  const normalized = (value ?? "OTHER").trim().toUpperCase().replace(/[- ]/g, "_");
  if (
    normalized === "AUTOREFRACTION" ||
    normalized === "MANIFEST" ||
    normalized === "CYCLOPLEGIC" ||
    normalized === "FINAL_RX"
  ) {
    return normalized;
  }
  return "OTHER";
}

function normalizeSourceType(value: string | undefined): SourceType {
  const normalized = (value ?? "manual").trim().toLowerCase();
  if (
    normalized === "manual" ||
    normalized === "parser" ||
    normalized === "device" ||
    normalized === "vendor-export" ||
    normalized === "unknown"
  ) {
    return normalized;
  }
  return "unknown";
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  const unwrapped = normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized;

  if (unwrapped === "localhost" || unwrapped === "::1") {
    return true;
  }

  if (isIP(unwrapped) === 4 && unwrapped.startsWith("127.")) {
    return true;
  }

  return false;
}

function getHttpPort(): number {
  const rawPort = process.env.OSOD_MCP_HTTP_PORT ?? "3333";
  const port = Number(rawPort);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `osod-mcp: invalid OSOD_MCP_HTTP_PORT "${rawPort}". Expected an integer between 1 and 65535.`,
    );
  }

  return port;
}

function formatHttpOrigin(host: string, port: number): string {
  const needsBrackets = host.includes(":") && !host.startsWith("[");
  return `http://${needsBrackets ? `[${host}]` : host}:${port}`;
}

function enforceSseTlsGate(host: string): void {
  if (isLoopbackHost(host)) {
    return;
  }

  if (!process.env.OSOD_MCP_TLS) {
    throw new Error(
      `osod-mcp: OSOD_MCP_TLS must be set before binding SSE transport to non-loopback host "${host}". This fail-closed rule applies to 0.0.0.0 and any external interface.`,
    );
  }
}

async function authenticateWithMedplum(): Promise<void> {
  if (!EMAIL || !PASSWORD) {
    throw new Error(
      "osod-mcp: MEDPLUM_ADMIN_EMAIL and MEDPLUM_ADMIN_PASSWORD must be set in env.",
    );
  }

  authPromise ??= (async () => {
    await fhir.login(EMAIL, PASSWORD);
    console.error("osod-mcp: authenticated with Medplum");
  })();

  return authPromise;
}

async function main(): Promise<void> {
  const transportMode = process.env.OSOD_MCP_TRANSPORT ?? "stdio";

  switch (transportMode) {
    case "stdio": {
      await authenticateWithMedplum();
      const server = createServer();
      const transport = new StdioServerTransport();
      await server.connect(transport);
      console.error("osod-mcp: MCP server running on stdio");
      return;
    }

    case "sse": {
      const host = process.env.OSOD_MCP_HTTP_HOST ?? "127.0.0.1";
      const port = getHttpPort();

      enforceSseTlsGate(host);

      const app = express();
      const transports = new Map<string, SSEServerTransport>();

      app.use(express.json({ limit: "4mb" }));

      app.get("/mcp/sse", async (_req, res) => {
        try {
          await authenticateWithMedplum();
          const transport = new SSEServerTransport("/mcp/messages", res);
          const server = createServer();

          transports.set(transport.sessionId, transport);
          res.on("close", () => {
            transports.delete(transport.sessionId);
          });

          await server.connect(transport);
          console.error(`osod-mcp: SSE session connected (${transport.sessionId})`);
        } catch (err) {
          console.error("osod-mcp: failed to establish SSE session:", err);
          if (!res.headersSent) {
            res.status(500).send("Failed to establish SSE session");
          }
        }
      });

      app.post("/mcp/messages", async (req, res) => {
        const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;

        if (!sessionId) {
          res.status(400).send("Missing sessionId query parameter");
          return;
        }

        const transport = transports.get(sessionId);

        if (!transport) {
          res.status(400).send(`No SSE transport found for sessionId "${sessionId}"`);
          return;
        }

        try {
          await transport.handlePostMessage(req, res, req.body);
        } catch (err) {
          console.error(`osod-mcp: failed to handle SSE message for session ${sessionId}:`, err);
          if (!res.headersSent) {
            res.status(500).send("Failed to handle SSE message");
          }
        }
      });

      const origin = formatHttpOrigin(host, port);

      await new Promise<void>((resolve, reject) => {
        const listener = app.listen(port, host, () => {
          console.error(`osod-mcp: MCP server running on SSE at ${origin}/mcp/sse`);
          console.error(`osod-mcp: POST messages to ${origin}/mcp/messages?sessionId=<id>`);
          resolve();
        });

        listener.on("error", reject);
      });
      return;
    }

    default:
      throw new Error(
        `osod-mcp: invalid OSOD_MCP_TRANSPORT "${transportMode}". Expected "stdio" or "sse".`,
      );
  }
}

main().catch((err: unknown) => {
  console.error("osod-mcp fatal:", err);
  process.exit(1);
});
