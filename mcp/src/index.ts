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
 * performs PKCE OAuth2 login once on startup, refreshes on demand.
 *
 * Zero Medplum SDK — plain fetch against the FHIR REST API.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createMedplumClient } from "./fhir-client.js";

const BASE_URL = process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103";
const EMAIL = process.env.MEDPLUM_ADMIN_EMAIL;
const PASSWORD = process.env.MEDPLUM_ADMIN_PASSWORD;

if (!EMAIL || !PASSWORD) {
  console.error(
    "osod-mcp: MEDPLUM_ADMIN_EMAIL and MEDPLUM_ADMIN_PASSWORD must be set in env.",
  );
  process.exit(1);
}

const fhir = createMedplumClient({ baseUrl: BASE_URL });

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
] as const;

/* ----- Input validation schemas (Zod) ----- */
const listPatientsSchema = z.object({
  name: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
});
const getByIdSchema = z.object({ patient_id: z.string().min(1) });
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

/* --------------------------------------------------------------------------
 * MCP server wiring
 * ------------------------------------------------------------------------ */

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

async function main(): Promise<void> {
  await fhir.login(EMAIL!, PASSWORD!);
  console.error("osod-mcp: authenticated with Medplum");

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("osod-mcp: MCP server running on stdio");
}

main().catch((err: unknown) => {
  console.error("osod-mcp fatal:", err);
  process.exit(1);
});
