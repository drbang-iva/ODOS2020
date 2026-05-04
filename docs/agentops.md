# AgentOps Governance

AI agents on your hardware. Your rules, your machine, your call.

v0.55d adds the local AgentOps governance layer for clinician-facing AI agent writes. The cloud LLM can reason over text and return structured tool-call JSON. The local OSOD runtime decides whether the action can run, records the audit trail, and executes any FHIR write against the practice-local Medplum server.

## What Ships

- Information Blocking Safety Valve: every block maps to a current 45 CFR Part 171 exception and emits an OSOD audit row plus FHIR `AuditEvent`.
- Device identity: every governed agent is represented as a FHIR R4 `Device`; every underlying model is also a `Device`; the agent `Device.parent` points to the model `Device`.
- AIAST tagging: every AI-mutated FHIR resource gets `meta.security` code `AIAST` from `http://terminology.hl7.org/CodeSystem/v3-ObservationValue`.
- Threshold matrix: local YAML policy files define LOW / MEDIUM / HIGH / CRITICAL thresholds by tool, resource type, action, impact, initiation mode, and agent.
- Local execution termination: agent sidecars can reach only the internal Docker network and local FHIR endpoint. Only `osod-core` has egress for LLM text/JSON round trips.
- Rollback: AgentOps rollbacks use compensating transactions with new Provenance records and the existing `nullify` / `amend` activity codes.

## Device Pattern

Agent-class Devices use `https://osod.dev/fhir/StructureDefinition/agent-identity`.

Model-class Devices use `https://osod.dev/fhir/StructureDefinition/model-identity`.

The agent Device carries logical name, clinical role, risk class, `initiation_mode_capabilities`, BAA attestation status, and optional resource quotas. The model Device carries vendor name, model version, BAA eligibility, and MCP carve-out status. Historical writes remain attributable because model upgrades create new Device versions instead of mutating prior provenance.

## Threshold Policies

Shipped defaults live in:

- `data/agentops-policies/defaults/generic.yaml`
- `data/agentops-policies/defaults/iris-starter.yaml`

Practice overrides live outside this repo at:

`<practice-osod>/policies/agentops/practice-local.yaml`

Resolution order is generic defaults, then agent-specific defaults, then practice-local overrides. More specific rules win. If a duplicate same-effective-date collision reaches runtime, OSOD applies the most restrictive rule and emits `agentops.policy.collision` so clinical operations continue under least privilege.

v0.55d ships user-initiated defaults only. The `autonomously-initiated` axis exists in the schema for future adapters, but no shipped default authorizes that mode.

## Safety Valve

Agent-source blocked responses use RFC 7807 problem details:

```json
{
  "type": "https://osod.dev/fhir/exception/171.205",
  "title": "Health IT Performance Exception",
  "status": 429,
  "detail": "The requested AgentOps action was not completed under the practice's local governance policy.",
  "instance": "/AuditEvent/<id>"
}
```

The response always uses `Content-Type: application/problem+json` and includes `X-OSOD-Audit-Event-Id`. The body detail is generic and does not include patient identifiers, rule IDs, agent IDs, PHI-derived strings, or local rationale.

The care-access privacy exception is retained internally for compliance review but externally masks as a generic Privacy response by default so a caller cannot infer protected reproductive-health context from response shape.

## Local Runtime

`docker-compose.yml` defines the v0.55d AgentOps runtime profile:

- `osod-core`: supervisor, policy loader, Safety Valve, Attachment.data mutator, local FHIR mediation.
- `osod-agent-iris`: first sidecar agent on `osod-internal` only.
- `osod-internal`: internal Docker bridge network.
- `osod-egress`: egress network attached to `osod-core` only.

Docker daemon `userns-remap` remains a host-level operator prerequisite for production AgentOps deployments. The sidecar network limits where agents can connect; OAuth scopes from v0.55a limit what they can write; host user namespace remapping limits who the sidecar maps to if a container escape bug exists.

## Image Bytes

Before any subscription payload reaches an agent sidecar, OSOD strips every `Attachment.data` field, replaces it with `Attachment.hash`, adds the OSOD `source-sha256` extension, and sets `Attachment.url` to the local FHIR source. Agents can display images to clinicians through the local URL, but raw image bytes do not enter an LLM context.

## Registering An Agent

`POST /agentops/agents/register` accepts admin-reviewed agent metadata. A request without admin approval returns pending review; it does not auto-register. Vendor BAA gaps require explicit practice-admin attestation. Anthropic-vendored registrations that declare third-party MCP data routing are blocked.

This is a local governance registry, not a distribution channel. OSOD ships the static Iris starter policies and the practice owns all overrides.

## Watch Items

- Anthropic BAA coverage: row 45 remains a per-commit hot-zone verification item.
- HTI-5: row 43 remains Proposed as of 2026-05-04 and is rechecked per v0.55d hot-zone discipline.
- HL7 AI Transparency on FHIR: row 52 remains Tier-B-PROVISIONAL. v0.55d relies on FHIR R4 Device, FHIR R4 Provenance, and THO AIAST directly; IG-specific shape reconciliation is v0.6+ work.
