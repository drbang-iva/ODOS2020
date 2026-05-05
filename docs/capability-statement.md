# Truthful CapabilityStatement

v0.55e synthesizes `/metadata` from structured rules backed by integration tests. OSOD only advertises structured claims that the local build can prove.

## Structured Claim Rules

`data/canonical-extensions/capability-statement-rules.json` lists every claim the synthesizer may emit. Each rule names the claim path, backing integration test, expected test result, certification severity, and certification anchor.

Mandatory certification claims use `required_for_certification: true`. If a backing test for one of those claims fails, the build fails and v0.55e cannot tag.

Optional claims use `required_for_certification: false`. If a backing test for one of those claims fails, CI can continue, but the claim is omitted from the runtime CapabilityStatement.

## Runtime Suppression

The synthesizer reads the latest test-result manifest and local practice feature config at request time. Optional Patient and System export claims are emitted only when enabled and backed by passing tests.

## Narrative Text

The `CapabilityStatement.text` narrative documents uncovered surfaces, such as unsupported `_typeFilter` query construction. The narrative does not claim coverage for suppressed structured claims.

## Public Sanitization and Caching

Every string emitted into public `/metadata` routes through `sanitizeForPublicEmission()`. The sanitizer strips internal LAN addresses, mounted filesystem paths, practice-internal identifiers, connection strings, and internal AgentOps Device references before serialization.

`/metadata` uses short public caching with ETags derived from the test-result manifest, rules file, and local feature config. Static API documentation can be cached longer; dynamic conformance JSON revalidates quickly.

## Audit Throttling

Routine `GET /metadata` traffic does not write an audit row. `capability_statement.served` is reserved for structural regression detection and discovery-abuse rate-limit anomalies.
