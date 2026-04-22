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
| `get_charge_items` | ChargeItems for a Patient or Encounter (shows CPT codes) |
| `fhir_search` | Escape hatch — arbitrary FHIR search |

## Run

```bash
cd mcp
npm install
npm run build

# Env:
export MEDPLUM_BASE_URL=http://localhost:8103
export MEDPLUM_ADMIN_EMAIL=drbang@ivaeyecare.com
export MEDPLUM_ADMIN_PASSWORD='<your password from osod/.env>'

# Stdio transport — MCP clients launch this on demand
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

Agents that have this configured can then call `osod.list_patients()`, `osod.get_observations({ patient_id: "..." })`, etc., in a normal MCP flow.

## Add tools as OSOD grows

Each new OSOD capability that agents should access adds one tool definition + one handler case. See `src/index.ts` for the pattern.

Next v0.1 tools to add when the data arrives:
- `create_observation` (with anatomical-location tag enforcement)
- `create_encounter`
- `schedule_appointment`
- `search_by_anatomical_location`
- `get_imaging_studies`
