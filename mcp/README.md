# osod-mcp — MCP server for OSOD FHIR data

Exposes Medplum-backed OSOD FHIR resources as [Model Context Protocol](https://modelcontextprotocol.io) tools. Any MCP client (Claude Desktop, Claude Code, Iris OpenClaw, Cursor, Zed, etc.) can read and write OSOD data through this server.

Zero Medplum SDK — plain `fetch` against FHIR REST.

## Tools exposed (v0.1)

| Tool | What it does |
|---|---|
| `list_patients` | FHIR Bundle of Patients (optional name filter) |
| `get_patient` | Single Patient resource by ID |
| `get_encounters` | Encounters for a given Patient |
| `get_observations` | Observations for a Patient (optional category filter) |
| `get_charge_items` | ChargeItems for a Patient or Encounter (shows locally loaded procedure codes) |
| `fhir_search` | Escape hatch — arbitrary FHIR search |

## Transport modes

Set `OSOD_MCP_TRANSPORT` to choose the MCP transport:

| Env var | Values | Default | Notes |
|---|---|---|---|
| `OSOD_MCP_TRANSPORT` | `stdio` \| `sse` | `stdio` | `stdio` remains fully backward-compatible for Claude Desktop / Claude Code launch-on-demand configs |

When `OSOD_MCP_TRANSPORT=sse`, these additional env vars apply:

| Env var | Default | Purpose |
|---|---|---|
| `OSOD_MCP_HTTP_HOST` | `127.0.0.1` | HTTP bind host for the SSE transport |
| `OSOD_MCP_HTTP_PORT` | `3333` | HTTP bind port for the SSE transport |
| `OSOD_MCP_TLS` | unset | Required if binding SSE to `0.0.0.0` or any non-loopback host; this is a fail-closed gate only, not TLS cert loading |

If `OSOD_MCP_HTTP_HOST` is `0.0.0.0` or any non-loopback interface and `OSOD_MCP_TLS` is not set, the server exits with an error before binding.

## Run

```bash
cd mcp
npm install
npm run build

# Env:
export MEDPLUM_BASE_URL=http://localhost:8103
export MEDPLUM_ADMIN_EMAIL=drbang@ivaeyecare.com
export MEDPLUM_ADMIN_PASSWORD='<your password from osod/.env>'

# Stdio transport (default) — MCP clients launch this on demand
node dist/index.js

# Equivalent explicit stdio launch
OSOD_MCP_TRANSPORT=stdio node dist/index.js

# HTTP + SSE transport on loopback only
OSOD_MCP_TRANSPORT=sse \
OSOD_MCP_HTTP_HOST=127.0.0.1 \
OSOD_MCP_HTTP_PORT=3333 \
node dist/index.js

# External bind requires the TLS gate acknowledgement
OSOD_MCP_TRANSPORT=sse \
OSOD_MCP_HTTP_HOST=0.0.0.0 \
OSOD_MCP_HTTP_PORT=3333 \
OSOD_MCP_TLS=required \
node dist/index.js
```

## Configure in Claude Desktop / Claude Code

Add to your MCP config (`~/.claude/mcp.json` or Claude Desktop's `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "osod": {
      "command": "node",
      "args": ["/Users/ericr.bang/Documents/GitHub/osod/mcp/dist/index.js"],
      "env": {
        "MEDPLUM_BASE_URL": "http://localhost:8103",
        "MEDPLUM_ADMIN_EMAIL": "drbang@ivaeyecare.com",
        "MEDPLUM_ADMIN_PASSWORD": "<password>"
      }
    }
  }
}
```

Existing Claude Desktop / Claude Code stdio configs continue to work unchanged because `stdio` is still the default transport.

## SSE endpoints

When `OSOD_MCP_TRANSPORT=sse`, the server exposes:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/mcp/sse` | Opens the server-sent events stream |
| `POST` | `/mcp/messages?sessionId=<id>` | Receives MCP client messages for the active SSE session |

On startup, the server logs the full loopback URL for the SSE endpoint and the message endpoint.

Agents that have this configured can then call `osod.list_patients()`, `osod.get_observations({ patient_id: "..." })`, etc., in a normal MCP flow regardless of transport.

## Add tools as OSOD grows

Each new OSOD capability that agents should access adds one tool definition + one handler case. See `src/index.ts` for the pattern.

Next v0.1 tools to add when the data arrives:
- `create_observation` (with anatomical-location tag enforcement)
- `create_encounter`
- `schedule_appointment`
- `search_by_anatomical_location`
- `get_imaging_studies`
