# §7 live lane draft — NOT RUN

Changed only `mcp/tests/r10OcularHealthDoorAuthzLive.test.ts` (new) and registered it in `mcp/package.json` `test:live-authz` (six suites). No CI workflow edit. No new production change. No existing test assertion was changed or removed.

The new suite awaits completion of the §3.4–§3.8 production consumers and the parent-authorized disposable-stack execution. This is test-first draft coverage, not executed live evidence or an evaluation. Syntax transpilation and TypeScript semantic checking of this test reported zero diagnostics. Static result: `live-suite-static-check.txt`.

## Rows covered

Under each canonical stored Staff/Provider policy, with its actual role-bound client: OH assert preliminary, clear entered-in-error, revive same id, panel create/update with TBUT value and version advancement, explicit negative Observation + Provenance, canonical fact void/undo using voidActionId, later-void supersession zero-write refusal, pre-rebuild save zero-write refusal, finished Encounter door/save refusals, signed canonical void refusal, and forged operation audit surfaced as auditPending. Provider additionally pulls a linked source finding through Condition/plan/link/facts/findings-Provenance steps and resends identically, asserting one Condition, unchanged fact versions, and exactly two command carry witnesses. Staff pull refuses before writes; provider closed destination pull refuses with 409.

Actual process MCP proof uses SDK StdioClientTransport launching current `src/index.ts`, service authentication selected by actual `createMcpServiceAuthentication`, and `ODOS_SESSION_PRACTITIONER_ID` set to the synthetic provider. Amend a final canonical fact on a finished Encounter, assert both transaction entries 2xx, read back Provenance, status/version advancement, byte-identical identifier/components/extensions. Second subprocess with mismatching session practitioner refuses, zero attempted FHIR writes, unchanged Observation and Provenance snapshot.

Raw canonical body passed to public create_observation yields schema refusal (accurately labelled). Real append against persisted canonical target exercises the new shared-finding guard. Both show zero attempted FHIR writes. No schemas/builders/policies changed to manufacture input.

Each row emits role/service mode, actor, project, policy references, resource reference, before/after state/version, lane `test:live-authz`, blocking true. Service evidence derives actual service ProjectMembership policy references or explicit admin membership; separately records provider policy context. No credential values or body/header buffers are captured by proxy/stdio handlers.

## Isolation

- Loopback Medplum required; caller/seeder project equality checked. Distinct fixture seeder and real constrained clients use existing helpers.
- Effective definitions loaded from FhirFindingDefinitionStore for each handler dependency construction, not compiled fixture seeds alone.
- Local reverse proxy measures non-read FHIR method/path metadata; boot activity settles before reset and measured tool calls. It captures no body or authorization headers.
- Child env is limited to local runtime/service keys; excludes inherited vendor config and access tokens. Actual production service auth executes at boot.
- `ODOS_AUDIT_DISABLED=1` excludes SQL audit adapter from this policy lane; clinical Provenance remains real. Local author runner supplies its own disposable ODOS_POSTGRES_URL. When absent (CI current step), a test-owned loopback TCP listener immediately closes SQL connections, preventing the process's background SQL worker from reaching default/shared databases. Background SQL success is not asserted by this FHIR policy proof. No runtime flags added.
- Both clients/subprocesses/listeners closed in finally; created synthetic FHIR resources tracked for cleanup. Parent stops its disposable containers at final delivery.

## Integration points to recheck before first live run

Future/current contract wires: history `eyes.OD.facts/panel`, negativeAct `{id,scope:string[],exclusions}`, top-level voidActionId and undo-superseded code, carry step fields. These match the contract and OH agent's explicit wire message, but require actual runtime confirmation once implementation lands. No fallback to legacy request bodies or weakened assertions is included.

Parent owns first authorized live run, red/fix/green evidence, full lane and final bundle. This draft does not satisfy §7 until that run passes.
