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
import { buildVisionPrescription } from "./fhir/ophthalmology/visionPrescription.js";
import { rewriteObservationBodyStructureReference } from "./fhir/ophthalmology/bodyStructure.js";
import {
  EPISODE_OF_CARE_STATUS_CODES,
  EPISODE_OF_CARE_TYPE_CODES,
  buildEpisodeOfCare,
  episodeOfCareTypeConcept,
  type EpisodeOfCareStatusCode,
  type EpisodeOfCareTypeCode,
} from "./fhir/episodeOfCare.js";
import {
  CONDITION_CLINICAL_STATUS_CODES,
  CONDITION_VERIFICATION_STATUS_CODES,
  buildEncounterDiagnosisComponent,
  buildEncounterDiagnosisCondition,
  buildProblemListCondition,
  clinicalStatusConcept,
  conditionBodySite,
  conditionCategoryConcept,
  conditionCodeConcept,
  hasConditionCategory,
  verificationStatusConcept,
  type ConditionClinicalStatusCode,
  type ConditionVerificationStatusCode,
} from "./fhir/condition.js";
import {
  ALLERGY_CLINICAL_STATUS_CODES,
  ALLERGY_VERIFICATION_STATUS_CODES,
  RXNORM_CODE_SYSTEM,
  SNOMED_CT_CODE_SYSTEM,
  buildAllergyIntolerance,
  type AllergyClinicalStatusCode,
  type AllergyVerificationStatusCode,
} from "./fhir/allergyIntolerance.js";
import {
  SMOKING_STATUS_CODES,
  buildSmokingStatusObservation,
  type SmokingStatusCode,
} from "./fhir/smokingStatus.js";
import {
  CARE_TEAM_STATUS_CODES,
  buildCareTeam,
  type CareTeamStatusCode,
} from "./fhir/careTeam.js";
import {
  PROCEDURE_STATUS_CODES,
  PROCEDURE_TARGET_BODY_STRUCTURE_EXTENSION_URL,
  buildProcedure,
  procedureTargetBodyStructureExtension,
  type ProcedureStatusCode,
} from "./fhir/procedure.js";
import {
  CONTACT_LENS_CLINICAL_OBSERVATION_CODES,
  CONTACT_LENS_MATERIAL_CODES,
  CONTACT_LENS_PARAMETER_CODES,
  CONTACT_LENS_TYPE_CODES,
  CONTACT_LENS_COATING_CODES,
  UCUM_UNIT_CODES,
  buildConceptMap,
  buildDeviceDefinition,
  buildLensDevice,
  buildSubstance,
  buildUpdateLensDevicePropertiesPatch,
  normalizeLensTypeCode,
  type ContactLensPropertyInput,
} from "./fhir/contactLens.js";
import {
  buildObservationSearchParams,
  compareTreatmentEpisodes as summarizeTreatmentEpisodes,
  groupedDiagnosticReport,
  observationHistoryFromBundle,
  summarizeProgression,
} from "./fhir/ocularMeasurementGraph.js";
import { auditHeaders, type V035WriteToolName, type V04WriteToolName } from "./tools/audit.js";
import {
  buildSectionSaveBundle,
  type IopSectionSaveEntry,
  type RefractionSectionSaveEntry,
  type SectionSaveEntry,
  type SectionSaveLaterality,
  type VisualAcuitySectionSaveEntry,
} from "./fhir/ophthalmology/save-section-bundle.js";
import type {
  AllergyIntolerance,
  BodyStructure,
  CareTeam,
  CodeableConcept,
  ConceptMap,
  Condition,
  Device,
  DeviceDefinition,
  DiagnosticReport,
  Encounter,
  EpisodeOfCare,
  Observation,
  Patient,
  Procedure,
  Provenance,
  Resource,
  Substance,
  VisionPrescription,
} from "@medplum/fhirtypes";
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
const ACCESS_TOKEN = process.env.MEDPLUM_ACCESS_TOKEN;
const CREATE_OBSERVATION_AUDIT_HEADERS = {
  "X-OSOD-Source": "mcp/create_observation",
} as const;
const CREATE_ENCOUNTER_AUDIT_HEADERS = {
  "X-OSOD-Source": "mcp/create_encounter",
} as const;
const CREATE_RAW_ASSET_REFERENCE_AUDIT_HEADERS = {
  "X-OSOD-Source": "mcp/create_raw_asset_reference",
} as const;
const CREATE_VISION_PRESCRIPTION_AUDIT_HEADERS = {
  "X-OSOD-Source": "mcp/create_vision_prescription",
} as const;
const CREATE_SECTION_OBSERVATIONS_AUDIT_HEADERS = {
  "X-OSOD-Source": "mcp/save_section_observations",
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

const fhir = createMedplumClient({ baseUrl: BASE_URL, accessToken: ACCESS_TOKEN });
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
            "Defaults true. Set false only for legacy backfill that must suppress Encounter Provenance.",
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
        chart_type: { type: "string", enum: ["SNELLEN", "ETDRS", "LOGMAR", "JAEGER", "OTHER", "UNKNOWN"] },
        correction: { type: "string", enum: ["SC", "CC", "BCVA", "PH", "NI", "OTHER", "UNKNOWN"] },
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
            "Defaults true. Set false only for legacy backfill that must suppress Observation Provenance.",
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
        create_provenance: {
          type: "boolean",
          description:
            "Defaults true. Set false only for legacy backfill that must suppress DocumentReference Provenance.",
        },
        provenance_agent_reference: { type: "string" },
        provenance_agent_display: { type: "string" },
      },
    },
  },
  {
    name: "save_section_observations",
    description:
      "Atomically save VA, IOP, or refraction section Observations with BodyStructure ensures and Provenance sidecars. Writes use X-OSOD-Source=mcp/save_section_observations.",
    inputSchema: {
      type: "object",
      required: ["patient_id", "encounter_id", "section", "entries"],
      properties: {
        patient_id: { type: "string", description: "FHIR Patient ID or Patient/<id>." },
        encounter_id: { type: "string", description: "FHIR Encounter ID or Encounter/<id>." },
        section: { type: "string", enum: ["va", "iop", "refraction"] },
        operator_display: { type: "string" },
        entries: {
          type: "array",
          items: {
            type: "object",
            required: ["laterality"],
            properties: {
              laterality: { type: "string", enum: ["OD", "OS", "OU", "od", "os", "ou"] },
              snellen: { type: "string" },
              chart_type: { type: "string" },
              chartType: { type: "string" },
              correction: { type: "string" },
              value: { type: "number" },
              method: { type: "string" },
              refraction_type: { type: "string" },
              refractionType: { type: "string" },
              sphere: { type: "number" },
              cylinder: { type: "number" },
              axis: { type: "number" },
              add: { type: "number" },
              prism_amount: { type: "number" },
              prism_base: { type: "string", enum: ["up", "down", "in", "out"] },
            },
          },
        },
      },
    },
  },
  {
    name: "create_vision_prescription",
    description:
      "Create a FHIR VisionPrescription from a FINAL_RX Refraction Observation. Writes use X-OSOD-Source=mcp/create_vision_prescription.",
    inputSchema: {
      type: "object",
      required: ["patient_id", "refraction_observation_id", "prescriber_reference"],
      properties: {
        patient_id: { type: "string", description: "FHIR Patient ID or Patient/<id>." },
        refraction_observation_id: {
          type: "string",
          description: "FHIR Observation ID or Observation/<id> for the FINAL_RX refraction.",
        },
        prescriber_reference: {
          type: "string",
          description: "Practitioner/<id> or PractitionerRole/<id> authorizing the prescription.",
        },
        date_written: { type: "string", description: "ISO timestamp. Defaults to now." },
        lens_type: { type: "string", description: "Lens product text. Defaults to eyeglasses." },
        create_provenance: {
          type: "boolean",
          description:
            "Defaults true. Set false only for legacy backfill that must suppress VisionPrescription Provenance.",
        },
        provenance_agent_reference: { type: "string" },
        provenance_agent_display: { type: "string" },
      },
    },
  },
  {
    name: "create_episode_of_care",
    description:
      "Create a FHIR EpisodeOfCare using the OSOD EpisodeOfCare.type ValueSet. Writes use X-OSOD-Source=mcp/create_episode_of_care.",
    inputSchema: {
      type: "object",
      required: ["patient_id", "type_code", "status"],
      properties: {
        patient_id: { type: "string" },
        type_code: { type: "string", enum: EPISODE_OF_CARE_TYPE_CODES },
        status: { type: "string", enum: EPISODE_OF_CARE_STATUS_CODES },
        managing_organization_reference: { type: "string" },
        period_start: { type: "string" },
        period_end: { type: "string" },
        condition_references: { type: "array", items: { type: "string" } },
        create_provenance: { type: "boolean", description: "Defaults true." },
        provenance_agent_reference: { type: "string" },
        provenance_agent_display: { type: "string" },
      },
    },
  },
  {
    name: "update_episode_of_care",
    description:
      "Version-aware PATCH for FHIR EpisodeOfCare. Writes use X-OSOD-Source=mcp/update_episode_of_care.",
    inputSchema: {
      type: "object",
      required: ["episode_of_care_id"],
      properties: {
        episode_of_care_id: { type: "string" },
        type_code: { type: "string", enum: EPISODE_OF_CARE_TYPE_CODES },
        status: { type: "string", enum: EPISODE_OF_CARE_STATUS_CODES },
        managing_organization_reference: { type: "string" },
        period_start: { type: "string" },
        period_end: { type: "string" },
        condition_references: { type: "array", items: { type: "string" } },
        create_provenance: { type: "boolean", description: "Defaults true." },
        provenance_agent_reference: { type: "string" },
        provenance_agent_display: { type: "string" },
      },
    },
  },
  {
    name: "create_condition_with_tier",
    description:
      "Create an encounter-diagnosis Condition and set Encounter.diagnosis.rank. Writes use X-OSOD-Source=mcp/create_condition_with_tier.",
    inputSchema: {
      type: "object",
      required: ["patient_id", "encounter_id", "code_system", "code", "tier"],
      properties: conditionToolInputProperties({ includeEncounter: true, includeTier: true }),
    },
  },
  {
    name: "create_problem_list_condition",
    description:
      "Create a longitudinal problem-list-item Condition. Writes use X-OSOD-Source=mcp/create_problem_list_condition.",
    inputSchema: {
      type: "object",
      required: ["patient_id", "code_system", "code"],
      properties: conditionToolInputProperties({ includeEncounter: false, includeTier: false }),
    },
  },
  {
    name: "update_condition_status",
    description:
      "Version-aware PATCH of Condition.clinicalStatus. Writes use X-OSOD-Source=mcp/update_condition_status.",
    inputSchema: {
      type: "object",
      required: ["condition_id", "clinical_status"],
      properties: {
        condition_id: { type: "string" },
        clinical_status: { type: "string", enum: CONDITION_CLINICAL_STATUS_CODES },
        create_provenance: { type: "boolean", description: "Defaults true." },
        provenance_agent_reference: { type: "string" },
        provenance_agent_display: { type: "string" },
      },
    },
  },
  {
    name: "update_condition_tier",
    description:
      "Version-aware PATCH of Encounter.diagnosis.rank for an encounter-diagnosis Condition. Rejects category flips.",
    inputSchema: {
      type: "object",
      required: ["condition_id", "encounter_id", "tier"],
      properties: {
        condition_id: { type: "string" },
        encounter_id: { type: "string" },
        tier: { type: "number" },
        create_provenance: { type: "boolean", description: "Defaults true." },
        provenance_agent_reference: { type: "string" },
        provenance_agent_display: { type: "string" },
      },
    },
  },
  {
    name: "update_condition_body_site",
    description:
      "Version-aware PATCH of Condition bodySite BodyStructure reference extension. Writes use X-OSOD-Source=mcp/update_condition_body_site.",
    inputSchema: {
      type: "object",
      required: ["condition_id", "body_structure_reference"],
      properties: {
        condition_id: { type: "string" },
        body_structure_reference: { type: "string" },
        body_site_text: { type: "string" },
        create_provenance: { type: "boolean", description: "Defaults true." },
        provenance_agent_reference: { type: "string" },
        provenance_agent_display: { type: "string" },
      },
    },
  },
  {
    name: "update_condition_code",
    description:
      "Version-aware PATCH of Condition.code for ICD specificity correction. Provenance captures the prior code value.",
    inputSchema: {
      type: "object",
      required: ["condition_id", "code_system", "code"],
      properties: {
        condition_id: { type: "string" },
        code_system: { type: "string" },
        code: { type: "string" },
        code_display: { type: "string" },
        code_text: { type: "string" },
        create_provenance: { type: "boolean", description: "Defaults true." },
        provenance_agent_reference: { type: "string" },
        provenance_agent_display: { type: "string" },
      },
    },
  },
  {
    name: "mark_condition_entered_in_error",
    description:
      "Version-aware PATCH of Condition.verificationStatus to entered-in-error. Does not delete the Condition.",
    inputSchema: {
      type: "object",
      required: ["condition_id"],
      properties: {
        condition_id: { type: "string" },
        create_provenance: { type: "boolean", description: "Defaults true." },
        provenance_agent_reference: { type: "string" },
        provenance_agent_display: { type: "string" },
      },
    },
  },
  {
    name: "create_allergy_intolerance",
    description:
      "Create a US Core AllergyIntolerance using the .code-first pattern. Writes use X-OSOD-Source=mcp/create_allergy_intolerance.",
    inputSchema: {
      type: "object",
      required: ["patient_id"],
      properties: {
        patient_id: { type: "string" },
        no_known_allergy: { type: "boolean" },
        code_system: { type: "string" },
        code: { type: "string" },
        code_display: { type: "string" },
        code_text: { type: "string" },
        clinical_status: { type: "string", enum: ALLERGY_CLINICAL_STATUS_CODES },
        verification_status: { type: "string", enum: ALLERGY_VERIFICATION_STATUS_CODES },
        reaction_manifestation_system: { type: "string" },
        reaction_manifestation_code: { type: "string" },
        reaction_manifestation_display: { type: "string" },
        reaction_substance_system: { type: "string" },
        reaction_substance_code: { type: "string" },
        reaction_substance_display: { type: "string" },
        reaction_severity: { type: "string", enum: ["mild", "moderate", "severe"] },
        reaction_description: { type: "string" },
        recorded_date: { type: "string" },
        recorder_reference: { type: "string" },
        create_provenance: { type: "boolean", description: "Defaults true." },
        provenance_agent_reference: { type: "string" },
        provenance_agent_display: { type: "string" },
      },
    },
  },
  {
    name: "create_smoking_status_observation",
    description:
      "Create a US Core Smoking Status Observation with LOINC 72166-2 and a coded answer.",
    inputSchema: {
      type: "object",
      required: ["patient_id", "status_code"],
      properties: {
        patient_id: { type: "string" },
        status_code: { type: "string", enum: SMOKING_STATUS_CODES },
        effective_date_time: { type: "string" },
        performer_reference: {
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        },
        create_provenance: { type: "boolean", description: "Defaults true." },
        provenance_agent_reference: { type: "string" },
        provenance_agent_display: { type: "string" },
      },
    },
  },
  {
    name: "create_care_team",
    description:
      "Create a US Core CareTeam using PractitionerRole participant references when available.",
    inputSchema: {
      type: "object",
      required: ["patient_id", "participants"],
      properties: {
        patient_id: { type: "string" },
        status: { type: "string", enum: CARE_TEAM_STATUS_CODES },
        name: { type: "string" },
        participants: {
          type: "array",
          items: {
            type: "object",
            required: ["role_text"],
            properties: {
              role_system: { type: "string" },
              role_code: { type: "string" },
              role_display: { type: "string" },
              role_text: { type: "string" },
              practitioner_role_reference: { type: "string" },
              practitioner_reference: { type: "string" },
              related_person_reference: { type: "string" },
            },
          },
        },
        create_provenance: { type: "boolean", description: "Defaults true." },
        provenance_agent_reference: { type: "string" },
        provenance_agent_display: { type: "string" },
      },
    },
  },
  {
    name: "create_procedure",
    description:
      "Create a FHIR Procedure with optional procedure-targetBodyStructure extension.",
    inputSchema: {
      type: "object",
      required: ["patient_id", "status", "code_system", "code"],
      properties: {
        patient_id: { type: "string" },
        encounter_id: { type: "string" },
        status: { type: "string", enum: PROCEDURE_STATUS_CODES },
        code_system: { type: "string" },
        code: { type: "string" },
        code_display: { type: "string" },
        code_text: { type: "string" },
        performed_date_time: { type: "string" },
        body_structure_reference: { type: "string" },
        create_provenance: { type: "boolean", description: "Defaults true." },
        provenance_agent_reference: { type: "string" },
        provenance_agent_display: { type: "string" },
      },
    },
  },
  {
    name: "update_procedure_body_site",
    description:
      "Version-aware PATCH of Procedure procedure-targetBodyStructure extension.",
    inputSchema: {
      type: "object",
      required: ["procedure_id", "body_structure_reference"],
      properties: {
        procedure_id: { type: "string" },
        body_structure_reference: { type: "string" },
        create_provenance: { type: "boolean", description: "Defaults true." },
        provenance_agent_reference: { type: "string" },
        provenance_agent_display: { type: "string" },
      },
    },
  },
  {
    name: "create_lens_device",
    description:
      "Create a patient-specific contact-lens Device using Device.property for lens geometry. Provenance is mandatory and writes use X-OSOD-Source=mcp/create_lens_device.",
    inputSchema: {
      type: "object",
      required: ["lens_type"],
      properties: {
        lens_type: { type: "string", enum: CONTACT_LENS_TYPE_CODES },
        patient_id: { type: "string" },
        definition_id: { type: "string" },
        device_name: { type: "string" },
        manufacturer: { type: "string" },
        model_number: { type: "string" },
        lot_number: { type: "string" },
        serial_number: { type: "string" },
        coating_substance_id: { type: "string" },
        properties: { type: "array", items: lensPropertyInputSchemaJson() },
        provenance_agent_reference: { type: "string" },
        provenance_agent_display: { type: "string" },
      },
    },
  },
  {
    name: "update_lens_device_properties",
    description:
      "Version-aware PATCH of contact-lens Device.property entries. Provenance is mandatory and writes use X-OSOD-Source=mcp/update_lens_device_properties.",
    inputSchema: {
      type: "object",
      required: ["lens_device_id", "properties"],
      properties: {
        lens_device_id: { type: "string" },
        lens_type: { type: "string", enum: CONTACT_LENS_TYPE_CODES },
        properties: { type: "array", items: lensPropertyInputSchemaJson() },
        provenance_agent_reference: { type: "string" },
        provenance_agent_display: { type: "string" },
      },
    },
  },
  {
    name: "create_device_definition",
    description:
      "Create a contact-lens DeviceDefinition catalog blueprint. Provenance is mandatory and writes use X-OSOD-Source=mcp/create_device_definition.",
    inputSchema: {
      type: "object",
      required: ["catalog_code", "display_name", "lens_type"],
      properties: {
        catalog_code: { type: "string" },
        display_name: { type: "string" },
        lens_type: { type: "string", enum: CONTACT_LENS_TYPE_CODES },
        manufacturer: { type: "string" },
        organization_reference: { type: "string" },
        model_number: { type: "string" },
        material_codes: { type: "array", items: { type: "string", enum: CONTACT_LENS_MATERIAL_CODES } },
        properties: { type: "array", items: lensPropertyInputSchemaJson() },
        provenance_agent_reference: { type: "string" },
        provenance_agent_display: { type: "string" },
      },
    },
  },
  {
    name: "create_concept_map",
    description:
      "Create a ConceptMap from OSOD contact-lens parameter codes to lab-specific aliases. Provenance is mandatory and writes use X-OSOD-Source=mcp/create_concept_map.",
    inputSchema: {
      type: "object",
      required: ["lab_code", "lab_display", "target_uri", "mappings"],
      properties: {
        lab_code: { type: "string" },
        lab_display: { type: "string" },
        target_uri: { type: "string" },
        organization_reference: { type: "string" },
        mappings: {
          type: "array",
          items: {
            type: "object",
            required: ["source_code", "target_code"],
            properties: {
              source_code: { type: "string", enum: CONTACT_LENS_PARAMETER_CODES },
              source_display: { type: "string" },
              target_code: { type: "string" },
              target_display: { type: "string" },
              equivalence: { type: "string" },
            },
          },
        },
        provenance_agent_reference: { type: "string" },
        provenance_agent_display: { type: "string" },
      },
    },
  },
  {
    name: "create_substance",
    description:
      "Create a contact-lens material or coating Substance. Provenance is mandatory and writes use X-OSOD-Source=mcp/create_substance.",
    inputSchema: {
      type: "object",
      required: ["code", "display", "kind"],
      properties: {
        code: { type: "string" },
        display: { type: "string" },
        kind: { type: "string", enum: ["material", "coating"] },
        dk: { type: "number" },
        water_content_range: { type: "string" },
        description: { type: "string" },
        provenance_agent_reference: { type: "string" },
        provenance_agent_display: { type: "string" },
      },
    },
  },
  {
    name: "get_observation_history",
    description:
      "Return ordered Observations for patient + code with optional laterality and date-range filters.",
    inputSchema: {
      type: "object",
      required: ["patient_id", "code"],
      properties: {
        patient_id: { type: "string" },
        code: { type: "string", description: "FHIR token, either code or system|code." },
        eye: { type: "string", enum: ["OD", "OS", "OU", "od", "os", "ou"] },
        date_range: dateRangeSchemaJson(),
        limit: { type: "number" },
      },
    },
  },
  {
    name: "get_progression_summary",
    description:
      "Return pure-data longitudinal slope, R squared, and largest step changes for patient + code.",
    inputSchema: {
      type: "object",
      required: ["patient_id", "code"],
      properties: {
        patient_id: { type: "string" },
        code: { type: "string" },
        eye: { type: "string", enum: ["OD", "OS", "OU", "od", "os", "ou"] },
      },
    },
  },
  {
    name: "get_grouped_diagnostic_report",
    description:
      "Return a DiagnosticReport matching a report type with linked Observation results resolved.",
    inputSchema: {
      type: "object",
      required: ["patient_id", "report_type"],
      properties: {
        patient_id: { type: "string" },
        report_type: { type: "string", description: "FHIR token or report text/code." },
      },
    },
  },
  {
    name: "get_lens_fit_history",
    description:
      "Return fit-finding Observations focused on a specific contact-lens Device, with standard focus search or documented fallback.",
    inputSchema: {
      type: "object",
      required: ["patient_id", "lens_device_id"],
      properties: {
        patient_id: { type: "string" },
        lens_device_id: { type: "string" },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "compare_treatment_episodes",
    description:
      "Return pure-data cross-Episode summary for a Patient. No clinical interpretation is produced.",
    inputSchema: {
      type: "object",
      required: ["patient_id"],
      properties: {
        patient_id: { type: "string" },
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
  prism_amount: z.number().optional(),
  prism_base: z.enum(["up", "down", "in", "out"]).optional(),
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
  create_provenance: z.boolean().optional(),
  provenance_agent_reference: z.string().optional(),
  provenance_agent_display: z.string().optional(),
});
const saveSectionObservationEntrySchema = z.object({
  laterality: z.string().min(1),
  snellen: z.string().optional(),
  chart_type: z.string().optional(),
  chartType: z.string().optional(),
  correction: z.string().optional(),
  value: z.number().optional(),
  method: z.string().optional(),
  refraction_type: z.string().optional(),
  refractionType: z.string().optional(),
  sphere: z.number().optional(),
  cylinder: z.number().optional(),
  axis: z.number().optional(),
  add: z.number().optional(),
  prism_amount: z.number().optional(),
  prism_base: z.enum(["up", "down", "in", "out"]).optional(),
});
const saveSectionObservationsSchema = z.object({
  patient_id: z.string().min(1),
  encounter_id: z.string().min(1),
  section: z.enum(["va", "iop", "refraction"]),
  entries: z.array(saveSectionObservationEntrySchema).min(1),
  operator_display: z.string().optional(),
});
const createVisionPrescriptionSchema = z.object({
  patient_id: z.string().min(1),
  refraction_observation_id: z.string().min(1),
  prescriber_reference: z.string().min(1),
  date_written: isoTimestampSchema.optional(),
  lens_type: z.string().optional(),
  create_provenance: z.boolean().optional(),
  provenance_agent_reference: z.string().optional(),
  provenance_agent_display: z.string().optional(),
});
const provenanceControlSchema = {
  create_provenance: z.boolean().optional(),
  provenance_agent_reference: z.string().optional(),
  provenance_agent_display: z.string().optional(),
} as const;
const codeInputSchema = {
  code_system: z.string().min(1),
  code: z.string().min(1),
  code_display: z.string().optional(),
  code_text: z.string().optional(),
} as const;
const episodeOfCareIdSchema = z.string().min(1);
const createEpisodeOfCareSchema = z.object({
  patient_id: z.string().min(1),
  type_code: z.enum(EPISODE_OF_CARE_TYPE_CODES),
  status: z.enum(EPISODE_OF_CARE_STATUS_CODES),
  managing_organization_reference: z.string().optional(),
  period_start: isoTimestampSchema.optional(),
  period_end: isoTimestampSchema.optional(),
  condition_references: z.array(z.string().min(1)).optional(),
  ...provenanceControlSchema,
});
const updateEpisodeOfCareSchema = z.object({
  episode_of_care_id: episodeOfCareIdSchema,
  type_code: z.enum(EPISODE_OF_CARE_TYPE_CODES).optional(),
  status: z.enum(EPISODE_OF_CARE_STATUS_CODES).optional(),
  managing_organization_reference: z.string().optional(),
  period_start: isoTimestampSchema.optional(),
  period_end: isoTimestampSchema.optional(),
  condition_references: z.array(z.string().min(1)).optional(),
  ...provenanceControlSchema,
});
const conditionCodeFieldsSchema = z.object({
  ...codeInputSchema,
  body_structure_reference: z.string().optional(),
  body_site_text: z.string().optional(),
  clinical_status: z.enum(CONDITION_CLINICAL_STATUS_CODES).optional(),
  verification_status: z.enum(CONDITION_VERIFICATION_STATUS_CODES).optional(),
  onset_date_time: isoTimestampSchema.optional(),
  abatement_date_time: isoTimestampSchema.optional(),
  recorded_date: z.string().optional(),
  ...provenanceControlSchema,
});
const createConditionWithTierSchema = conditionCodeFieldsSchema.extend({
  patient_id: z.string().min(1),
  encounter_id: z.string().min(1),
  tier: z.number().int().positive(),
});
const createProblemListConditionSchema = conditionCodeFieldsSchema.extend({
  patient_id: z.string().min(1),
});
const updateConditionStatusSchema = z.object({
  condition_id: z.string().min(1),
  clinical_status: z.enum(CONDITION_CLINICAL_STATUS_CODES),
  ...provenanceControlSchema,
});
const updateConditionTierSchema = z.object({
  condition_id: z.string().min(1),
  encounter_id: z.string().min(1),
  tier: z.number().int().positive(),
  ...provenanceControlSchema,
});
const updateConditionBodySiteSchema = z.object({
  condition_id: z.string().min(1),
  body_structure_reference: z.string().min(1),
  body_site_text: z.string().optional(),
  ...provenanceControlSchema,
});
const updateConditionCodeSchema = z.object({
  condition_id: z.string().min(1),
  ...codeInputSchema,
  ...provenanceControlSchema,
});
const markConditionEnteredInErrorSchema = z.object({
  condition_id: z.string().min(1),
  ...provenanceControlSchema,
});
const createAllergyIntoleranceSchema = z.object({
  patient_id: z.string().min(1),
  no_known_allergy: z.boolean().optional(),
  code_system: z.string().optional(),
  code: z.string().optional(),
  code_display: z.string().optional(),
  code_text: z.string().optional(),
  clinical_status: z.enum(ALLERGY_CLINICAL_STATUS_CODES).optional(),
  verification_status: z.enum(ALLERGY_VERIFICATION_STATUS_CODES).optional(),
  reaction_manifestation_system: z.string().optional(),
  reaction_manifestation_code: z.string().optional(),
  reaction_manifestation_display: z.string().optional(),
  reaction_substance_system: z.string().optional(),
  reaction_substance_code: z.string().optional(),
  reaction_substance_display: z.string().optional(),
  reaction_severity: z.enum(["mild", "moderate", "severe"]).optional(),
  reaction_description: z.string().optional(),
  recorded_date: z.string().optional(),
  recorder_reference: z.string().optional(),
  ...provenanceControlSchema,
});
const createSmokingStatusObservationSchema = z.object({
  patient_id: z.string().min(1),
  status_code: z.enum(SMOKING_STATUS_CODES),
  effective_date_time: isoTimestampSchema.optional(),
  performer_reference: maybeStringArraySchema,
  ...provenanceControlSchema,
});
const createCareTeamSchema = z.object({
  patient_id: z.string().min(1),
  status: z.enum(CARE_TEAM_STATUS_CODES).optional(),
  name: z.string().optional(),
  participants: z
    .array(
      z.object({
        role_system: z.string().optional(),
        role_code: z.string().optional(),
        role_display: z.string().optional(),
        role_text: z.string().min(1),
        practitioner_role_reference: z.string().optional(),
        practitioner_reference: z.string().optional(),
        related_person_reference: z.string().optional(),
      }),
    )
    .min(1),
  ...provenanceControlSchema,
});
const createProcedureSchema = z.object({
  patient_id: z.string().min(1),
  encounter_id: z.string().optional(),
  status: z.enum(PROCEDURE_STATUS_CODES),
  ...codeInputSchema,
  performed_date_time: isoTimestampSchema.optional(),
  body_structure_reference: z.string().optional(),
  ...provenanceControlSchema,
});
const updateProcedureBodySiteSchema = z.object({
  procedure_id: z.string().min(1),
  body_structure_reference: z.string().min(1),
  ...provenanceControlSchema,
});
const v04ProvenanceAgentSchema = {
  provenance_agent_reference: z.string().optional(),
  provenance_agent_display: z.string().optional(),
} as const;
const lensPropertyInputSchema = z.object({
  code: z.string().min(1),
  value_number: z.number().optional(),
  unit_code: z.enum(UCUM_UNIT_CODES).optional(),
  value_code: z.string().optional(),
  value_system: z.string().optional(),
  value_display: z.string().optional(),
  value_text: z.string().optional(),
});
const createLensDeviceSchema = z.object({
  lens_type: z.enum(CONTACT_LENS_TYPE_CODES as [string, ...string[]]),
  patient_id: z.string().optional(),
  definition_id: z.string().optional(),
  device_name: z.string().optional(),
  manufacturer: z.string().optional(),
  model_number: z.string().optional(),
  lot_number: z.string().optional(),
  serial_number: z.string().optional(),
  coating_substance_id: z.string().optional(),
  properties: z.array(lensPropertyInputSchema).optional(),
  ...v04ProvenanceAgentSchema,
});
const updateLensDevicePropertiesSchema = z.object({
  lens_device_id: z.string().min(1),
  lens_type: z.enum(CONTACT_LENS_TYPE_CODES as [string, ...string[]]).optional(),
  properties: z.array(lensPropertyInputSchema).min(1),
  ...v04ProvenanceAgentSchema,
});
const createDeviceDefinitionSchema = z.object({
  catalog_code: z.string().min(1),
  display_name: z.string().min(1),
  lens_type: z.enum(CONTACT_LENS_TYPE_CODES as [string, ...string[]]),
  manufacturer: z.string().optional(),
  organization_reference: z.string().optional(),
  model_number: z.string().optional(),
  material_codes: z.array(z.enum(CONTACT_LENS_MATERIAL_CODES)).optional(),
  properties: z.array(lensPropertyInputSchema).optional(),
  ...v04ProvenanceAgentSchema,
});
const createConceptMapSchema = z.object({
  lab_code: z.string().min(1),
  lab_display: z.string().min(1),
  target_uri: z.string().min(1),
  organization_reference: z.string().optional(),
  mappings: z
    .array(
      z.object({
        source_code: z.string().min(1),
        source_display: z.string().optional(),
        target_code: z.string().min(1),
        target_display: z.string().optional(),
        equivalence: z
          .enum([
            "relatedto",
            "equivalent",
            "equal",
            "wider",
            "subsumes",
            "narrower",
            "specializes",
            "inexact",
            "unmatched",
            "disjoint",
          ])
          .optional(),
      }),
    )
    .min(1),
  ...v04ProvenanceAgentSchema,
});
const createSubstanceSchema = z.object({
  code: z.string().min(1),
  display: z.string().min(1),
  kind: z.enum(["material", "coating"]),
  dk: z.number().optional(),
  water_content_range: z.string().optional(),
  description: z.string().optional(),
  ...v04ProvenanceAgentSchema,
});
const dateRangeSchema = z.object({
  start: z.string().optional(),
  end: z.string().optional(),
});
const getObservationHistorySchema = z.object({
  patient_id: z.string().min(1),
  code: z.string().min(1),
  eye: z.string().optional(),
  date_range: dateRangeSchema.optional(),
  limit: z.number().int().positive().max(500).optional(),
});
const getProgressionSummarySchema = z.object({
  patient_id: z.string().min(1),
  code: z.string().min(1),
  eye: z.string().optional(),
});
const getGroupedDiagnosticReportSchema = z.object({
  patient_id: z.string().min(1),
  report_type: z.string().min(1),
});
const getLensFitHistorySchema = z.object({
  patient_id: z.string().min(1),
  lens_device_id: z.string().min(1),
  limit: z.number().int().positive().max(500).optional(),
});
const compareTreatmentEpisodesSchema = z.object({
  patient_id: z.string().min(1),
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
          if (input.create_provenance ?? true) {
            const encounterReference = `${createdEncounter.resourceType}/${createdEncounter.id}`;
            createdProvenance = await fhir.create(
              buildProvenance({
                targetReferences: [encounterReference],
                occurredDateTime: encounterResult.resource.period?.start,
                activityCode: "CREATE",
                activityDisplay: "Create",
                agents: [
                  {
                    typeCode: "author",
                    typeDisplay: "Author",
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
          const observationBodySiteResult = await persistObservationBodyStructures(
            observationResult.resource,
          );
          const createdObservation = await fhir.create(
            observationBodySiteResult.observation,
            CREATE_OBSERVATION_AUDIT_HEADERS,
          );

          let createdProvenance: unknown;
          if (input.create_provenance ?? input.createProvenance ?? true) {
            const observationReference = `${createdObservation.resourceType}/${createdObservation.id}`;
            createdProvenance = await fhir.create(
              buildProvenance({
                targetReferences: [observationReference],
                occurredDateTime: observationBodySiteResult.observation.effectiveDateTime,
                activityCode: "CREATE",
                activityDisplay: "Create",
                entityReferences: getStringArray(input.source_reference ?? input.sourceReference),
                agents: [
                  {
                    typeCode: normalizeSourceType(input.source_type) === "parser" ? "performer" : "author",
                    typeDisplay: normalizeSourceType(input.source_type) === "parser" ? "Performer" : "Author",
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
                    bodyStructures: observationBodySiteResult.bodyStructures,
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
          const created = await fhir.create(
            documentReference,
            CREATE_RAW_ASSET_REFERENCE_AUDIT_HEADERS,
          );

          let createdProvenance: unknown;
          if (input.create_provenance ?? true) {
            createdProvenance = await fhir.create(
              buildProvenance({
                targetReferences: [`DocumentReference/${created.id}`],
                occurredDateTime: documentReference.date,
                activityCode: "CREATE",
                activityDisplay: "Create",
                agents: [
                  {
                    typeCode: "author",
                    typeDisplay: "Author",
                    whoReference: input.provenance_agent_reference,
                    whoDisplay:
                      input.provenance_agent_display ??
                      "OSOD MCP create_raw_asset_reference",
                  },
                ],
              }),
              CREATE_RAW_ASSET_REFERENCE_AUDIT_HEADERS,
            );
          }

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { documentReference: created, provenance: createdProvenance },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        case "save_section_observations": {
          const input = saveSectionObservationsSchema.parse(args);
          const bundle = buildSectionSaveBundle({
            patientReference: patientReference(input.patient_id),
            encounterReference: encounterReference(input.encounter_id),
            section: input.section,
            entries: buildSectionSaveEntries(input),
            operatorDisplay:
              input.operator_display ?? "OSOD MCP save_section_observations",
          });
          const responseBundle = await fhir.executeTransaction(
            bundle,
            CREATE_SECTION_OBSERVATIONS_AUDIT_HEADERS,
          );

          return {
            content: [{ type: "text", text: JSON.stringify(responseBundle, null, 2) }],
          };
        }
        case "create_vision_prescription": {
          const input = createVisionPrescriptionSchema.parse(args);
          const refractionObservation = await fhir.read<Observation>(
            "Observation",
            stripObservationReference(input.refraction_observation_id),
          );
          const visionPrescription = buildVisionPrescription({
            refractionObservation,
            patientReference: patientReference(input.patient_id),
            prescriberReference: input.prescriber_reference,
            dateWritten: input.date_written,
            lensType: input.lens_type,
          });
          const created = await fhir.create<VisionPrescription>(
            visionPrescription,
            CREATE_VISION_PRESCRIPTION_AUDIT_HEADERS,
          );

          let createdProvenance: unknown;
          if (input.create_provenance ?? true) {
            createdProvenance = await fhir.create(
              buildProvenance({
                targetReferences: [`VisionPrescription/${created.id}`],
                occurredDateTime: visionPrescription.dateWritten,
                activityCode: "CREATE",
                activityDisplay: "Create",
                agents: [
                  {
                    typeCode: "author",
                    typeDisplay: "Author",
                    whoReference: input.provenance_agent_reference,
                    whoDisplay:
                      input.provenance_agent_display ??
                      "OSOD MCP create_vision_prescription",
                  },
                ],
              }),
              CREATE_VISION_PRESCRIPTION_AUDIT_HEADERS,
            );
          }

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { visionPrescription: created, provenance: createdProvenance },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        case "create_episode_of_care": {
          const input = createEpisodeOfCareSchema.parse(args);
          const episodeOfCare = buildEpisodeOfCare({
            typeCode: input.type_code,
            status: input.status,
            patientReference: patientReference(input.patient_id),
            managingOrganizationReference: input.managing_organization_reference,
            periodStart: input.period_start,
            periodEnd: input.period_end,
            conditionReferences: input.condition_references,
          });
          const created = await fhir.create<EpisodeOfCare>(
            episodeOfCare,
            auditHeaders("create_episode_of_care"),
          );
          const provenance = await createV035Provenance(
            "create_episode_of_care",
            input,
            [`EpisodeOfCare/${created.id}`],
            "CREATE",
            episodeOfCare.period?.start,
          );

          return toolJson({ episodeOfCare: created, provenance });
        }
        case "update_episode_of_care": {
          const input = updateEpisodeOfCareSchema.parse(args);
          const id = stripReference(input.episode_of_care_id, "EpisodeOfCare");
          const existing = await fhir.read<EpisodeOfCare>("EpisodeOfCare", id);
          const operations = buildUpdateEpisodeOfCarePatchOperations(existing, input);
          const updated = await fhir.patch<EpisodeOfCare>(
            "EpisodeOfCare",
            id,
            operations,
            versionedHeaders(existing, auditHeaders("update_episode_of_care")),
          );
          const provenance = await createV035Provenance(
            "update_episode_of_care",
            input,
            [`EpisodeOfCare/${updated.id}`],
            "UPDATE",
            updated.period?.start,
          );

          return toolJson({ episodeOfCare: updated, provenance });
        }
        case "create_condition_with_tier": {
          const input = createConditionWithTierSchema.parse(args);
          const encounterId = stripReference(input.encounter_id, "Encounter");
          const existingEncounter = await fhir.read<Encounter>("Encounter", encounterId);
          const condition = buildEncounterDiagnosisCondition({
            patientReference: patientReference(input.patient_id),
            encounterReference: encounterReference(input.encounter_id),
            code: conditionCodeFromInput(input),
            clinicalStatus: input.clinical_status,
            verificationStatus: input.verification_status,
            onsetDateTime: input.onset_date_time,
            abatementDateTime: input.abatement_date_time,
            recordedDate: input.recorded_date,
            bodyStructureReference: input.body_structure_reference,
            bodySiteText: input.body_site_text,
          });
          const createdCondition = await fhir.create<Condition>(
            condition,
            auditHeaders("create_condition_with_tier"),
          );
          const diagnosisEntry = buildEncounterDiagnosisComponent(
            `Condition/${createdCondition.id}`,
            input.tier,
          );
          const updatedEncounter = await fhir.patch<Encounter>(
            "Encounter",
            encounterId,
            addEncounterDiagnosisPatchOperations(existingEncounter, diagnosisEntry),
            versionedHeaders(existingEncounter, auditHeaders("create_condition_with_tier")),
          );
          const provenance = await createV035Provenance(
            "create_condition_with_tier",
            input,
            [`Condition/${createdCondition.id}`, `Encounter/${updatedEncounter.id}`],
            "CREATE",
            condition.recordedDate ?? condition.onsetDateTime,
          );

          return toolJson({ condition: createdCondition, encounter: updatedEncounter, provenance });
        }
        case "create_problem_list_condition": {
          const input = createProblemListConditionSchema.parse(args);
          const condition = buildProblemListCondition({
            patientReference: patientReference(input.patient_id),
            code: conditionCodeFromInput(input),
            clinicalStatus: input.clinical_status,
            verificationStatus: input.verification_status,
            onsetDateTime: input.onset_date_time,
            abatementDateTime: input.abatement_date_time,
            recordedDate: input.recorded_date,
            bodyStructureReference: input.body_structure_reference,
            bodySiteText: input.body_site_text,
          });
          const created = await fhir.create<Condition>(
            condition,
            auditHeaders("create_problem_list_condition"),
          );
          const provenance = await createV035Provenance(
            "create_problem_list_condition",
            input,
            [`Condition/${created.id}`],
            "CREATE",
            condition.recordedDate ?? condition.onsetDateTime,
          );

          return toolJson({ condition: created, provenance });
        }
        case "update_condition_status": {
          const input = updateConditionStatusSchema.parse(args);
          const id = stripReference(input.condition_id, "Condition");
          const existing = await fhir.read<Condition>("Condition", id);
          const updated = await fhir.patch<Condition>(
            "Condition",
            id,
            [
              {
                op: existing.clinicalStatus ? "replace" : "add",
                path: "/clinicalStatus",
                value: clinicalStatusConcept(input.clinical_status),
              },
            ],
            versionedHeaders(existing, auditHeaders("update_condition_status")),
          );
          const provenance = await createV035Provenance(
            "update_condition_status",
            input,
            [`Condition/${updated.id}`],
            "UPDATE",
          );

          return toolJson({ condition: updated, provenance });
        }
        case "update_condition_tier": {
          const input = updateConditionTierSchema.parse(args);
          const conditionId = stripReference(input.condition_id, "Condition");
          const encounterId = stripReference(input.encounter_id, "Encounter");
          const condition = await fhir.read<Condition>("Condition", conditionId);
          if (!hasConditionCategory(condition, "encounter-diagnosis")) {
            throw new Error(
              "update_condition_tier only applies to encounter-diagnosis Conditions. Category changes require creating a new Condition with the new category.",
            );
          }
          const encounter = await fhir.read<Encounter>("Encounter", encounterId);
          const diagnosisIndex = findEncounterDiagnosisIndex(encounter, `Condition/${condition.id}`);
          if (diagnosisIndex < 0) {
            throw new Error(
              "Encounter.diagnosis does not reference this Condition. Create a new encounter-diagnosis Condition instead of flipping category or tier in place.",
            );
          }
          const updatedEncounter = await fhir.patch<Encounter>(
            "Encounter",
            encounterId,
            [
              {
                op: "replace",
                path: `/diagnosis/${diagnosisIndex}/rank`,
                value: input.tier,
              },
            ],
            versionedHeaders(encounter, auditHeaders("update_condition_tier")),
          );
          const provenance = await createV035Provenance(
            "update_condition_tier",
            input,
            [`Encounter/${updatedEncounter.id}`, `Condition/${condition.id}`],
            "UPDATE",
          );

          return toolJson({ encounter: updatedEncounter, condition, provenance });
        }
        case "update_condition_body_site": {
          const input = updateConditionBodySiteSchema.parse(args);
          const id = stripReference(input.condition_id, "Condition");
          const existing = await fhir.read<Condition>("Condition", id);
          const updated = await fhir.patch<Condition>(
            "Condition",
            id,
            [
              {
                op: existing.bodySite ? "replace" : "add",
                path: "/bodySite",
                value: conditionBodySite(input.body_structure_reference, input.body_site_text),
              },
            ],
            versionedHeaders(existing, auditHeaders("update_condition_body_site")),
          );
          const provenance = await createV035Provenance(
            "update_condition_body_site",
            input,
            [`Condition/${updated.id}`],
            "UPDATE",
          );

          return toolJson({ condition: updated, provenance });
        }
        case "update_condition_code": {
          const input = updateConditionCodeSchema.parse(args);
          const id = stripReference(input.condition_id, "Condition");
          const existing = await fhir.read<Condition>("Condition", id);
          const priorCode = existing.code;
          const updated = await fhir.patch<Condition>(
            "Condition",
            id,
            [
              {
                op: existing.code ? "replace" : "add",
                path: "/code",
                value: conditionCodeConcept(conditionCodeFromInput(input)),
              },
            ],
            versionedHeaders(existing, auditHeaders("update_condition_code")),
          );
          const provenance = await createV035Provenance(
            "update_condition_code",
            input,
            [`Condition/${updated.id}`],
            "UPDATE",
            undefined,
            [
              {
                role: "revision",
                display: `prior Condition.code: ${JSON.stringify(priorCode ?? null)}`,
              },
            ],
          );

          return toolJson({ condition: updated, provenance });
        }
        case "mark_condition_entered_in_error": {
          const input = markConditionEnteredInErrorSchema.parse(args);
          const id = stripReference(input.condition_id, "Condition");
          const existing = await fhir.read<Condition>("Condition", id);
          const operations: JsonPatchOperation[] = [
            {
              op: existing.verificationStatus ? "replace" : "add",
              path: "/verificationStatus",
              value: verificationStatusConcept("entered-in-error"),
            },
          ];
          if (existing.clinicalStatus) {
            operations.push({ op: "remove", path: "/clinicalStatus" });
          }
          const updated = await fhir.patch<Condition>(
            "Condition",
            id,
            operations,
            versionedHeaders(existing, auditHeaders("mark_condition_entered_in_error")),
          );
          const provenance = await createV035Provenance(
            "mark_condition_entered_in_error",
            input,
            [`Condition/${updated.id}`],
            "UPDATE",
          );

          return toolJson({ condition: updated, provenance });
        }
        case "create_allergy_intolerance": {
          const input = createAllergyIntoleranceSchema.parse(args);
          const allergyIntolerance = buildAllergyIntolerance({
            patientReference: patientReference(input.patient_id),
            noKnownAllergy: input.no_known_allergy,
            code: input.no_known_allergy ? undefined : allergyCodeFromInput(input),
            clinicalStatus: input.clinical_status,
            verificationStatus: input.verification_status,
            recordedDate: input.recorded_date,
            recorderReference: input.recorder_reference,
            reaction: allergyReactionFromInput(input),
          });
          const created = await fhir.create<AllergyIntolerance>(
            allergyIntolerance,
            auditHeaders("create_allergy_intolerance"),
          );
          const provenance = await createV035Provenance(
            "create_allergy_intolerance",
            input,
            [`AllergyIntolerance/${created.id}`],
            "CREATE",
            allergyIntolerance.recordedDate,
          );

          return toolJson({ allergyIntolerance: created, provenance });
        }
        case "create_smoking_status_observation": {
          const input = createSmokingStatusObservationSchema.parse(args);
          const observation = buildSmokingStatusObservation({
            patientReference: patientReference(input.patient_id),
            statusCode: input.status_code,
            effectiveDateTime: input.effective_date_time ?? new Date().toISOString(),
            performerReferences: getStringArray(input.performer_reference),
          });
          const created = await fhir.create<Observation>(
            observation,
            auditHeaders("create_smoking_status_observation"),
          );
          const provenance = await createV035Provenance(
            "create_smoking_status_observation",
            input,
            [`Observation/${created.id}`],
            "CREATE",
            observation.effectiveDateTime,
          );

          return toolJson({ observation: created, provenance });
        }
        case "create_care_team": {
          const input = createCareTeamSchema.parse(args);
          const careTeam = buildCareTeam({
            patientReference: patientReference(input.patient_id),
            status: input.status,
            name: input.name,
            participant: input.participants.map((participant) => ({
              role: {
                system: participant.role_system,
                code: participant.role_code,
                display: participant.role_display,
                text: participant.role_text,
              },
              practitionerRoleReference: participant.practitioner_role_reference,
              practitionerReference: participant.practitioner_reference,
              relatedPersonReference: participant.related_person_reference,
            })),
          });
          const created = await fhir.create<CareTeam>(
            careTeam,
            auditHeaders("create_care_team"),
          );
          const provenance = await createV035Provenance(
            "create_care_team",
            input,
            [`CareTeam/${created.id}`],
            "CREATE",
          );

          return toolJson({ careTeam: created, provenance });
        }
        case "create_procedure": {
          const input = createProcedureSchema.parse(args);
          const procedure = buildProcedure({
            patientReference: patientReference(input.patient_id),
            encounterReference: input.encounter_id ? encounterReference(input.encounter_id) : undefined,
            status: input.status,
            code: procedureCodeFromInput(input),
            performedDateTime: input.performed_date_time,
            bodyStructureReference: input.body_structure_reference,
          });
          const created = await fhir.create<Procedure>(
            procedure,
            auditHeaders("create_procedure"),
          );
          const provenance = await createV035Provenance(
            "create_procedure",
            input,
            [`Procedure/${created.id}`],
            "CREATE",
            procedure.performedDateTime,
          );

          return toolJson({ procedure: created, provenance });
        }
        case "update_procedure_body_site": {
          const input = updateProcedureBodySiteSchema.parse(args);
          const id = stripReference(input.procedure_id, "Procedure");
          const existing = await fhir.read<Procedure>("Procedure", id);
          const nextExtensions = [
            ...(existing.extension ?? []).filter(
              (extension) =>
                extension.url !== PROCEDURE_TARGET_BODY_STRUCTURE_EXTENSION_URL,
            ),
            procedureTargetBodyStructureExtension(input.body_structure_reference),
          ];
          const updated = await fhir.patch<Procedure>(
            "Procedure",
            id,
            [
              {
                op: existing.extension ? "replace" : "add",
                path: "/extension",
                value: nextExtensions,
              },
            ],
            versionedHeaders(existing, auditHeaders("update_procedure_body_site")),
          );
          const provenance = await createV035Provenance(
            "update_procedure_body_site",
            input,
            [`Procedure/${updated.id}`],
            "UPDATE",
          );

          return toolJson({ procedure: updated, provenance });
        }
        case "create_lens_device": {
          const input = createLensDeviceSchema.parse(args);
          const device = buildLensDevice({
            lensTypeCode: input.lens_type,
            patientReference: input.patient_id ? patientReference(input.patient_id) : undefined,
            definitionReference: input.definition_id,
            deviceName: input.device_name,
            manufacturer: input.manufacturer,
            modelNumber: input.model_number,
            lotNumber: input.lot_number,
            serialNumber: input.serial_number,
            coatingSubstanceReference: input.coating_substance_id,
            properties: toLensPropertyInputs(input.properties),
          });
          const created = await fhir.create<Device>(device, auditHeaders("create_lens_device"));
          const provenance = await createV04Provenance(
            "create_lens_device",
            input,
            [`Device/${created.id}`],
            "CREATE",
          );

          return toolJson({ device: created, provenance });
        }
        case "update_lens_device_properties": {
          const input = updateLensDevicePropertiesSchema.parse(args);
          const id = stripReference(input.lens_device_id, "Device");
          const existing = await fhir.read<Device>("Device", id);
          const lensType =
            input.lens_type ?? existing.type?.coding?.find((coding) => coding.code)?.code;
          if (!lensType) {
            throw new Error(
              "update_lens_device_properties requires lens_type when Device.type does not carry an OSOD lens type code.",
            );
          }
          const normalizedLensType = normalizeLensTypeCode(lensType);
          const updated = await fhir.patch<Device>(
            "Device",
            id,
            buildUpdateLensDevicePropertiesPatch(
              existing,
              normalizedLensType,
              toLensPropertyInputs(input.properties) ?? [],
            ),
            versionedHeaders(existing, auditHeaders("update_lens_device_properties")),
          );
          const provenance = await createV04Provenance(
            "update_lens_device_properties",
            input,
            [`Device/${updated.id}`],
            "UPDATE",
            undefined,
            [
              {
                role: "revision",
                display: `prior Device.property count: ${(existing.property ?? []).length}`,
              },
            ],
          );

          return toolJson({ device: updated, provenance });
        }
        case "create_device_definition": {
          const input = createDeviceDefinitionSchema.parse(args);
          const deviceDefinition = buildDeviceDefinition({
            catalogCode: input.catalog_code,
            displayName: input.display_name,
            lensTypeCode: input.lens_type,
            manufacturer: input.manufacturer,
            organizationReference: input.organization_reference,
            modelNumber: input.model_number,
            materialCodes: input.material_codes,
            properties: toLensPropertyInputs(input.properties),
          });
          const created = await fhir.create<DeviceDefinition>(
            deviceDefinition,
            auditHeaders("create_device_definition"),
          );
          const provenance = await createV04Provenance(
            "create_device_definition",
            input,
            [`DeviceDefinition/${created.id}`],
            "CREATE",
          );

          return toolJson({ deviceDefinition: created, provenance });
        }
        case "create_concept_map": {
          const input = createConceptMapSchema.parse(args);
          const conceptMap = buildConceptMap({
            labCode: input.lab_code,
            labDisplay: input.lab_display,
            targetUri: input.target_uri,
            organizationReference: input.organization_reference,
            mappings: input.mappings.map((mapping) => ({
              sourceCode: mapping.source_code,
              sourceDisplay: mapping.source_display,
              targetCode: mapping.target_code,
              targetDisplay: mapping.target_display,
              equivalence: mapping.equivalence,
            })),
          });
          const created = await fhir.create<ConceptMap>(
            conceptMap,
            auditHeaders("create_concept_map"),
          );
          const provenance = await createV04Provenance(
            "create_concept_map",
            input,
            [`ConceptMap/${created.id}`],
            "CREATE",
          );

          return toolJson({ conceptMap: created, provenance });
        }
        case "create_substance": {
          const input = createSubstanceSchema.parse(args);
          const substance = buildSubstance({
            code: input.code,
            display: input.display,
            kind: input.kind,
            dk: input.dk,
            waterContentRange: input.water_content_range,
            description: input.description,
          });
          const created = await fhir.create<Substance>(
            substance,
            auditHeaders("create_substance"),
          );
          const provenance = await createV04Provenance(
            "create_substance",
            input,
            [`Substance/${created.id}`],
            "CREATE",
          );

          return toolJson({ substance: created, provenance });
        }
        case "get_observation_history": {
          const input = getObservationHistorySchema.parse(args);
          const bundle = await fhir.search<Observation>(
            "Observation",
            buildObservationSearchParams({
              patientReference: patientReference(input.patient_id),
              filters: {
                code: input.code,
                eye: input.eye,
                dateRange: input.date_range,
              },
              count: input.limit,
            }),
          );
          const observations = observationHistoryFromBundle(bundle, {
            code: input.code,
            eye: input.eye,
            dateRange: input.date_range,
          });

          return toolJson({ observations });
        }
        case "get_progression_summary": {
          const input = getProgressionSummarySchema.parse(args);
          const bundle = await fhir.search<Observation>(
            "Observation",
            buildObservationSearchParams({
              patientReference: patientReference(input.patient_id),
              filters: { code: input.code, eye: input.eye },
              count: 500,
            }),
          );
          const observations = observationHistoryFromBundle(bundle, {
            code: input.code,
            eye: input.eye,
          });

          return toolJson({
            summary: summarizeProgression(observations, input.code, input.eye),
          });
        }
        case "get_grouped_diagnostic_report": {
          const input = getGroupedDiagnosticReportSchema.parse(args);
          const report = await findDiagnosticReport(
            patientReference(input.patient_id),
            input.report_type,
          );
          if (!report) {
            return toolJson({ diagnosticReport: undefined, observations: [] });
          }
          const observations = await readReportObservations(report);

          return toolJson(groupedDiagnosticReport(report, observations));
        }
        case "get_lens_fit_history": {
          const input = getLensFitHistorySchema.parse(args);
          const lensReference = normalizeToolReference(input.lens_device_id, "Device");
          const subjectReference = patientReference(input.patient_id);
          let searchMode = "standard-focus";
          let bundle;
          try {
            bundle = await fhir.search<Observation>("Observation", {
              subject: subjectReference,
              focus: lensReference,
              _sort: "date",
              _count: String(input.limit ?? 200),
            });
          } catch (err) {
            searchMode = "subject-filter-fallback";
            bundle = await fhir.search<Observation>("Observation", {
              subject: subjectReference,
              _sort: "date",
              _count: String(input.limit ?? 200),
            });
          }
          const observations = observationHistoryFromBundle(bundle, {
            code: "",
            focusReference: lensReference,
          }).filter((observation) =>
            (observation.focus ?? []).some((focus) => focus.reference === lensReference),
          );

          return toolJson({
            searchMode,
            fallbackDocumentation:
              searchMode === "subject-filter-fallback"
                ? "Medplum rejected Observation?focus; queried by subject and filtered Observation.focus client-side."
                : undefined,
            observations,
          });
        }
        case "compare_treatment_episodes": {
          const input = compareTreatmentEpisodesSchema.parse(args);
          const subjectReference = patientReference(input.patient_id);
          const [episodeBundle, observationBundle] = await Promise.all([
            fhir.search<EpisodeOfCare>("EpisodeOfCare", {
              patient: subjectReference,
              _count: "200",
            }),
            fhir.search<Observation>("Observation", {
              subject: subjectReference,
              _count: "500",
            }),
          ]);
          const episodes = (episodeBundle.entry ?? [])
            .map((entry) => entry.resource)
            .filter((resource): resource is EpisodeOfCare => resource?.resourceType === "EpisodeOfCare");
          const observations = (observationBundle.entry ?? [])
            .map((entry) => entry.resource)
            .filter((resource): resource is Observation => resource?.resourceType === "Observation");

          return toolJson({ episodes: summarizeTreatmentEpisodes(episodes, observations) });
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
type SaveSectionObservationsInput = z.infer<typeof saveSectionObservationsSchema>;
type UpdateEpisodeOfCareInput = z.infer<typeof updateEpisodeOfCareSchema>;
type CreateAllergyIntoleranceInput = z.infer<typeof createAllergyIntoleranceSchema>;
type CreateProcedureInput = z.infer<typeof createProcedureSchema>;
type LensPropertyToolInput = z.infer<typeof lensPropertyInputSchema>;
type V04ProvenanceAgentInput = {
  provenance_agent_reference?: string;
  provenance_agent_display?: string;
};

interface V035ProvenanceControlInput {
  create_provenance?: boolean;
  provenance_agent_reference?: string;
  provenance_agent_display?: string;
}

function conditionToolInputProperties(input: {
  includeEncounter: boolean;
  includeTier: boolean;
}): Record<string, unknown> {
  return {
    patient_id: { type: "string" },
    ...(input.includeEncounter ? { encounter_id: { type: "string" } } : {}),
    code_system: { type: "string" },
    code: { type: "string" },
    code_display: { type: "string" },
    code_text: { type: "string" },
    ...(input.includeTier ? { tier: { type: "number" } } : {}),
    body_structure_reference: { type: "string" },
    body_site_text: { type: "string" },
    clinical_status: { type: "string", enum: CONDITION_CLINICAL_STATUS_CODES },
    verification_status: { type: "string", enum: CONDITION_VERIFICATION_STATUS_CODES },
    onset_date_time: { type: "string" },
    abatement_date_time: { type: "string" },
    recorded_date: { type: "string" },
    create_provenance: { type: "boolean", description: "Defaults true." },
    provenance_agent_reference: { type: "string" },
    provenance_agent_display: { type: "string" },
  };
}

function lensPropertyInputSchemaJson(): Record<string, unknown> {
  return {
    type: "object",
    required: ["code"],
    properties: {
      code: { type: "string", enum: CONTACT_LENS_PARAMETER_CODES },
      value_number: { type: "number" },
      unit_code: { type: "string", enum: UCUM_UNIT_CODES },
      value_code: { type: "string" },
      value_system: { type: "string" },
      value_display: { type: "string" },
      value_text: { type: "string" },
    },
  };
}

function dateRangeSchemaJson(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      start: { type: "string" },
      end: { type: "string" },
    },
  };
}

function toolJson(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function stripReference(value: string, resourceType: string): string {
  return value.startsWith(`${resourceType}/`) ? value.slice(resourceType.length + 1) : value;
}

function versionedHeaders(
  resource: Resource,
  extraHeaders: Record<string, string>,
): Record<string, string> {
  const versionId = resource.meta?.versionId;
  if (!versionId) {
    throw new Error(
      `${resource.resourceType}/${resource.id ?? "(unknown)"} is missing meta.versionId; refusing version-aware PATCH.`,
    );
  }

  return {
    ...extraHeaders,
    "If-Match": `W/"${versionId}"`,
  };
}

async function createV035Provenance(
  toolName: V035WriteToolName,
  input: V035ProvenanceControlInput,
  targetReferences: string[],
  activityCode: "CREATE" | "UPDATE",
  occurredDateTime?: string,
  entityValues?: Array<{
    role?: "source" | "revision" | "quotation" | "removal";
    display: string;
  }>,
): Promise<Provenance | undefined> {
  if (input.create_provenance === false) {
    return undefined;
  }

  return fhir.create<Provenance>(
    buildProvenance({
      targetReferences,
      occurredDateTime,
      activityCode,
      activityDisplay: activityCode === "CREATE" ? "Create" : "Update",
      agents: [
        {
          typeCode: "author",
          typeDisplay: "Author",
          whoReference: input.provenance_agent_reference,
          whoDisplay: input.provenance_agent_display ?? `OSOD MCP ${toolName}`,
        },
      ],
      entityValues,
    }),
    auditHeaders(toolName),
  );
}

async function createV04Provenance(
  toolName: V04WriteToolName,
  input: V04ProvenanceAgentInput,
  targetReferences: string[],
  activityCode: "CREATE" | "UPDATE",
  occurredDateTime?: string,
  entityValues?: Array<{
    role?: "source" | "revision" | "quotation" | "removal";
    display: string;
  }>,
): Promise<Provenance> {
  return fhir.create<Provenance>(
    buildProvenance({
      targetReferences,
      occurredDateTime,
      activityCode,
      activityDisplay: activityCode === "CREATE" ? "Create" : "Update",
      agents: [
        {
          typeCode: "author",
          typeDisplay: "Author",
          whoReference: input.provenance_agent_reference,
          whoDisplay: input.provenance_agent_display ?? `OSOD MCP ${toolName}`,
        },
      ],
      entityValues,
    }),
    auditHeaders(toolName),
  );
}

function toLensPropertyInputs(
  properties: LensPropertyToolInput[] | undefined,
): ContactLensPropertyInput[] | undefined {
  return properties?.map((property) => ({
    code: property.code,
    valueNumber: property.value_number,
    unitCode: property.unit_code,
    valueCode: property.value_code,
    valueSystem: property.value_system,
    valueDisplay: property.value_display,
    valueText: property.value_text,
  }));
}

async function findDiagnosticReport(
  subjectReference: string,
  reportType: string,
): Promise<DiagnosticReport | undefined> {
  const tokenSearch = await fhir.search<DiagnosticReport>("DiagnosticReport", {
    subject: subjectReference,
    code: reportType,
    _count: "1",
  });
  const tokenMatch = tokenSearch.entry?.[0]?.resource;
  if (tokenMatch) {
    return tokenMatch;
  }

  const bundle = await fhir.search<DiagnosticReport>("DiagnosticReport", {
    subject: subjectReference,
    _count: "50",
  });
  return (bundle.entry ?? [])
    .map((entry) => entry.resource)
    .find((resource): resource is DiagnosticReport =>
      resource?.resourceType === "DiagnosticReport" && reportMatches(resource, reportType),
    );
}

async function readReportObservations(report: DiagnosticReport): Promise<Observation[]> {
  const references = (report.result ?? [])
    .map((result) => result.reference)
    .filter((reference): reference is string => Boolean(reference?.startsWith("Observation/")));
  const observations: Observation[] = [];

  for (const reference of references) {
    observations.push(
      await fhir.read<Observation>("Observation", stripReference(reference, "Observation")),
    );
  }

  return observations;
}

function reportMatches(report: DiagnosticReport, reportType: string): boolean {
  const normalized = reportType.trim().toLowerCase();
  return (
    report.code.text?.toLowerCase().includes(normalized) === true ||
    (report.code.coding ?? []).some((coding) => {
      const token = coding.system && coding.code ? `${coding.system}|${coding.code}` : coding.code;
      return (
        token === reportType ||
        coding.code === reportType ||
        coding.display?.toLowerCase().includes(normalized) === true
      );
    })
  );
}

function normalizeToolReference(value: string, resourceType: string): string {
  return value.startsWith(`${resourceType}/`) ? value : `${resourceType}/${value}`;
}

function buildUpdateEpisodeOfCarePatchOperations(
  existing: EpisodeOfCare,
  input: UpdateEpisodeOfCareInput,
): JsonPatchOperation[] {
  const operations: JsonPatchOperation[] = [];

  if (input.status !== undefined) {
    operations.push({ op: "replace", path: "/status", value: input.status });
  }

  if (input.type_code !== undefined) {
    operations.push({
      op: existing.type ? "replace" : "add",
      path: "/type",
      value: [episodeOfCareTypeConcept(input.type_code)],
    });
  }

  if (input.managing_organization_reference !== undefined) {
    operations.push({
      op: existing.managingOrganization ? "replace" : "add",
      path: "/managingOrganization",
      value: { reference: input.managing_organization_reference },
    });
  }

  if (input.period_start !== undefined || input.period_end !== undefined) {
    operations.push({
      op: existing.period ? "replace" : "add",
      path: "/period",
      value: {
        ...(existing.period ?? {}),
        ...(input.period_start !== undefined ? { start: input.period_start } : {}),
        ...(input.period_end !== undefined ? { end: input.period_end } : {}),
      },
    });
  }

  if (input.condition_references !== undefined) {
    operations.push({
      op: existing.diagnosis ? "replace" : "add",
      path: "/diagnosis",
      value: input.condition_references.map((conditionReference) => ({
        condition: { reference: conditionReference },
      })),
    });
  }

  if (operations.length === 0) {
    throw new Error("update_episode_of_care requires at least one field to update.");
  }

  return operations;
}

function conditionCodeFromInput(input: {
  code_system: string;
  code: string;
  code_display?: string;
  code_text?: string;
}) {
  return {
    system: input.code_system,
    code: input.code,
    display: input.code_display,
    text: input.code_text,
  };
}

function procedureCodeFromInput(input: CreateProcedureInput) {
  return {
    system: input.code_system,
    code: input.code,
    display: input.code_display,
    text: input.code_text,
  };
}

function allergyCodeFromInput(input: CreateAllergyIntoleranceInput) {
  if (!input.code_system || !input.code) {
    throw new Error(
      "create_allergy_intolerance requires code_system and code unless no_known_allergy is true.",
    );
  }

  return {
    system: input.code_system,
    code: input.code,
    display: input.code_display,
    text: input.code_text,
  };
}

function allergyReactionFromInput(
  input: CreateAllergyIntoleranceInput,
): NonNullable<Parameters<typeof buildAllergyIntolerance>[0]["reaction"]> | undefined {
  const hasReaction = Boolean(
    input.reaction_manifestation_system ||
      input.reaction_manifestation_code ||
      input.reaction_manifestation_display ||
      input.reaction_substance_system ||
      input.reaction_substance_code ||
      input.reaction_substance_display ||
      input.reaction_severity ||
      input.reaction_description,
  );
  if (!hasReaction) {
    return undefined;
  }
  if (!input.reaction_manifestation_system || !input.reaction_manifestation_code) {
    throw new Error(
      "AllergyIntolerance.reaction requires reaction_manifestation_system and reaction_manifestation_code.",
    );
  }
  if (
    (input.reaction_substance_system && !input.reaction_substance_code) ||
    (!input.reaction_substance_system && input.reaction_substance_code)
  ) {
    throw new Error(
      "AllergyIntolerance.reaction.substance requires both reaction_substance_system and reaction_substance_code.",
    );
  }

  return [
    {
      manifestation: {
        system: input.reaction_manifestation_system,
        code: input.reaction_manifestation_code,
        display: input.reaction_manifestation_display,
      },
      ...(input.reaction_substance_system && input.reaction_substance_code
        ? {
            substance: {
              system: input.reaction_substance_system,
              code: input.reaction_substance_code,
              display: input.reaction_substance_display,
            },
          }
        : {}),
      severity: input.reaction_severity,
      description: input.reaction_description,
    },
  ];
}

function addEncounterDiagnosisPatchOperations(
  encounter: Encounter,
  diagnosisEntry: NonNullable<Encounter["diagnosis"]>[number],
): JsonPatchOperation[] {
  if ((encounter.diagnosis?.length ?? 0) > 0) {
    return [{ op: "add", path: "/diagnosis/-", value: diagnosisEntry }];
  }

  return [{ op: "add", path: "/diagnosis", value: [diagnosisEntry] }];
}

function findEncounterDiagnosisIndex(encounter: Encounter, conditionReference: string): number {
  const conditionId = stripReference(conditionReference, "Condition");
  return (encounter.diagnosis ?? []).findIndex((diagnosis) => {
    const referenceValue = diagnosis.condition?.reference;
    return (
      referenceValue === conditionReference ||
      (referenceValue !== undefined &&
        stripReference(referenceValue, "Condition") === conditionId)
    );
  });
}

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

function stripObservationReference(observationId: string): string {
  return observationId.startsWith("Observation/")
    ? observationId.slice("Observation/".length)
    : observationId;
}

async function persistObservationBodyStructures(
  observation: Observation,
): Promise<{ observation: Observation; bodyStructures: BodyStructure[] | undefined }> {
  const containedBodyStructures = (observation.contained ?? []).filter(isBodyStructure);
  if (containedBodyStructures.length === 0) {
    return { observation, bodyStructures: undefined };
  }

  let rewrittenObservation: Observation = {
    ...observation,
    contained: observation.contained?.filter((resource) => !isBodyStructure(resource)),
  };
  if (rewrittenObservation.contained?.length === 0) {
    delete rewrittenObservation.contained;
  }

  const createdBodyStructures: BodyStructure[] = [];
  for (const bodyStructure of containedBodyStructures) {
    const originalReference = bodyStructure.id ? `#${bodyStructure.id}` : undefined;
    const { id: _containedId, ...bodyStructureToCreate } = bodyStructure;
    const createdBodyStructure = await fhir.create<BodyStructure>(
      bodyStructureToCreate,
      CREATE_OBSERVATION_AUDIT_HEADERS,
    );
    createdBodyStructures.push(createdBodyStructure);

    if (originalReference) {
      rewrittenObservation = rewriteObservationBodyStructureReference(
        rewrittenObservation,
        originalReference,
        `${createdBodyStructure.resourceType}/${createdBodyStructure.id}`,
      );
    }
  }

  return {
    observation: rewrittenObservation,
    bodyStructures: createdBodyStructures,
  };
}

function isBodyStructure(resource: Resource): resource is BodyStructure {
  return resource.resourceType === "BodyStructure";
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
        unit: "mm[Hg]",
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
        prism:
          input.prism_amount !== undefined
            ? { amount: input.prism_amount, base: input.prism_base }
            : undefined,
      });
    }
  }
}

function buildSectionSaveEntries(input: SaveSectionObservationsInput): SectionSaveEntry[] {
  switch (input.section) {
    case "va":
      return input.entries.map((entry): VisualAcuitySectionSaveEntry => {
        if (!entry.snellen?.trim()) {
          throw new Error("save_section_observations section=va requires snellen for every entry.");
        }
        return {
          laterality: normalizeSectionLaterality(entry.laterality),
          snellen: entry.snellen.trim(),
          chartType: normalizeChartType(entry.chart_type ?? entry.chartType),
          correction: normalizeCorrection(entry.correction),
        };
      });

    case "iop":
      return input.entries.map((entry): IopSectionSaveEntry => {
        if (entry.value === undefined) {
          throw new Error("save_section_observations section=iop requires value for every entry.");
        }
        return {
          laterality: normalizeSectionLaterality(entry.laterality),
          value: entry.value,
          method: normalizeIopMethod(entry.method),
        };
      });

    case "refraction":
      return input.entries.map((entry): RefractionSectionSaveEntry => {
        return {
          laterality: normalizeSectionLaterality(entry.laterality),
          refractionType: normalizeRefractionType(entry.refraction_type ?? entry.refractionType),
          sphere: entry.sphere,
          cylinder: entry.cylinder,
          axis: entry.axis,
          add: entry.add,
          prism:
            entry.prism_amount !== undefined
              ? { amount: entry.prism_amount, base: entry.prism_base }
              : undefined,
        };
      });
  }
}

function normalizeSectionLaterality(value: string): SectionSaveLaterality {
  const laterality = normalizeLaterality(value);
  if (laterality === "UNKNOWN") {
    throw new Error("save_section_observations requires OD, OS, or OU laterality.");
  }
  return laterality;
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
  if (normalized === "SNELLEN" || normalized === "ETDRS" || normalized === "LOGMAR" || normalized === "JAEGER") {
    return normalized;
  }
  if (normalized === "OTHER") return "OTHER";
  return "UNKNOWN";
}

function normalizeCorrection(value: string | undefined): VisualAcuityCorrection {
  const normalized = (value ?? "UNKNOWN").trim().toUpperCase();
  if (normalized === "SC" || normalized === "CC" || normalized === "BCVA" || normalized === "PH" || normalized === "NI") {
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
  if (ACCESS_TOKEN) {
    return;
  }

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
