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
import { createMedplumClient } from "./fhir-client.js";

const BASE_URL = process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103";
const EMAIL = process.env.MEDPLUM_ADMIN_EMAIL;
const PASSWORD = process.env.MEDPLUM_ADMIN_PASSWORD;

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

  return server;
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
