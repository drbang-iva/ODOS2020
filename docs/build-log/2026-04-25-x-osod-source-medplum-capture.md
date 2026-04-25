# X-OSOD-Source Capture in Medplum AuditEvent — verification

## Test methodology

Environment:
- Docker compose stack from `osod/docker-compose.yml`
- Medplum server image: `medplum/medplum-server:latest`
- Container image digest: `sha256:2661c4e6b3a893dce216e80cc1d744e96e777874b3283242bed7f026f57b5487`
- Medplum server package version inside container: `5.1.8`
- FHIR base URL: `http://localhost:8103/fhir/R4`

Verification path:
1. Authenticate against local Medplum.
2. Create a test `Patient`.
3. Start the OSOD MCP server over stdio with an already-issued Medplum access token, so the test exercises the real MCP handler without tripping Medplum's login rate limit.
4. Record timestamp immediately before the Encounter create: `2026-04-25T08:33:38.118Z`.
5. Call the `create_encounter` MCP tool with `class_code=AMB` and `status=finished`.
6. Created Encounter: `Encounter/933b65b9-cd0c-482f-8973-e165550597c0`.
7. Query Medplum `AuditEvent` for the created Encounter and for recent audit records.

Primary query used:

```text
GET http://localhost:8103/fhir/R4/AuditEvent?date=ge2026-04-25T08%3A33%3A38.118Z&entity=Encounter%2F933b65b9-cd0c-482f-8973-e165550597c0
```

Additional accepted queries checked:

```text
GET http://localhost:8103/fhir/R4/AuditEvent?entity=Encounter%2F933b65b9-cd0c-482f-8973-e165550597c0
GET http://localhost:8103/fhir/R4/AuditEvent?date=ge2026-04-25T08%3A33%3A38.118Z
GET http://localhost:8103/fhir/R4/AuditEvent?_lastUpdated=ge2026-04-25T08%3A33%3A38.118Z
GET http://localhost:8103/fhir/R4/AuditEvent?_count=50&_sort=-date
```

All queries were accepted by Medplum and returned `0` Bundle entries.

The test harness inspects returned AuditEvents, when any exist, for `mcp/create_encounter` in:
- `AuditEvent.agent[*].name`
- `AuditEvent.agent[*].requestor`
- `AuditEvent.source.observer.display`
- `AuditEvent.entity[*].what`
- `AuditEvent.entity[*].name`
- `AuditEvent.entity[*].detail`
- Any `extension` subtree

## What was observed

AuditEvent does NOT include the `X-OSOD-Source` header in any field. In this local Medplum `5.1.8` docker-compose instance, the relevant AuditEvent searches returned no FHIR `AuditEvent` resources at all for the Encounter create, and a recent AuditEvent search also returned zero entries.

Medplum's container logs show OAuth login events with request IDs and trace IDs, but those log lines are not FHIR `AuditEvent` resources and do not surface the MCP write-source header.

Resource-level attribution must come from Provenance per Mandate 7a: every write tool that needs reviewable agent attribution should also create a Provenance pointing at the resource. The `X-OSOD-Source` header still has value for HTTP-layer access logs and reverse-proxy attribution, but is NOT a substitute for Provenance.

## Recommendation

File follow-up decision in `performance-od/decisions/2026-04-25-x-osod-source-vs-provenance-attribution.md`:

- Every write tool that requires reviewable per-resource attribution MUST create a FHIR `Provenance` resource pointing at the created or updated resource.
- `X-OSOD-Source` remains a request-level diagnostic header for HTTP-layer logs, reverse proxies, and future middleware.
- Default Provenance creation to ON for `create_encounter` and `create_observation`.
- Keep Provenance default OFF for `update_patient` because demographic PATCH is lower-stakes, but expose a `create_provenance` flag for callers who want reviewable attribution.
- `create_raw_asset_reference` should gain optional Provenance in the next raw-asset slice if raw vendor imports need reviewable per-resource attribution.
