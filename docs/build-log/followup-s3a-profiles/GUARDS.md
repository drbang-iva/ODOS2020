# Mutation evidence

All mutations restored; author verification only. G7b uses separate local-helper variants because a failing count stops the test before its per-caller loop.

## G1

File: `mcp/src/clinical-graph/follow-up-profile-store.ts`

```sh
'node' '--import' 'tsx' '--test' '--test-name-pattern=^G1' 'mcp/src/__tests__/follow-up-profile-keys.test.ts'
```

Red, exit 1:
```text
not ok 1 - G1 every seed section resolves in the real catalogues or names its unavailable reason
  error: 'glaucoma: fictional-section'
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
```

Restored, exit 0:
```text
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## G2

File: `mcp/src/clinical-graph/follow-up-profile-store.ts`

```sh
'node' '--import' 'tsx' '--test' '--test-name-pattern=^G2' 'mcp/src/__tests__/follow-up-profile-keys.test.ts'
```

Red, exit 1:
```text
not ok 1 - G2 every seed test is orderable, pending, or explicitly unavailable
  error: 'glaucoma: fictional-orderable'
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
```

Restored, exit 0:
```text
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## G3-seed

File: `mcp/src/clinical-graph/follow-up-profile-store.ts`

```sh
'node' '--import' 'tsx' '--test' '--test-name-pattern=^G3' 'mcp/src/__tests__/follow-up-profile-keys.test.ts'
```

Red, exit 1:
```text
not ok 1 - G3 no MDM field anywhere in any seed
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
```

Restored, exit 0:
```text
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## G3-request

File: `mcp/src/clinical-graph/follow-up-profile-endpoint.ts`

```sh
'node' '--import' 'tsx' '--test' '--test-name-pattern=^G3' 'mcp/tests/followUpProfileEndpoint.test.ts'
```

Red, exit 1:
```text
not ok 1 - G3 strict request rejects root and nested MDM and every unknown field
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
```

Restored, exit 0:
```text
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## G4

File: `mcp/src/clinical-graph/follow-up-profile-store.ts`

```sh
'node' '--import' 'tsx' '--test' '--test-name-pattern=^G4' 'mcp/tests/followUpProfileStore.test.ts'
```

Red, exit 1:
```text
not ok 1 - mcp/tests/followUpProfileStore.test.ts
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
```

Restored, exit 0:
```text
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## G5a

File: `mcp/src/clinical-graph/follow-up-profile-store.ts`

```sh
'node' '--import' 'tsx' '--test' '--test-name-pattern=^G5a' 'mcp/tests/followUpProfileStore.test.ts'
```

Red, exit 1:
```text
not ok 1 - G5a stale caller version is refused before a write
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
```

Restored, exit 0:
```text
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## G5b

File: `mcp/src/clinical-graph/follow-up-profile-store.ts`

```sh
'node' '--import' 'tsx' '--test' '--test-name-pattern=^G5b' 'mcp/tests/followUpProfileStore.test.ts'
```

Red, exit 1:
```text
not ok 1 - G5b concurrent creates of one profile key have exactly one winner
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
```

Restored, exit 0:
```text
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## G5c

File: `mcp/src/clinical-graph/follow-up-profile-store.ts`

```sh
'node' '--import' 'tsx' '--test' '--test-name-pattern=^G5c' 'mcp/tests/followUpProfileStore.test.ts'
```

Red, exit 1:
```text
not ok 1 - G5c concurrent first seed overlays have exactly one winner
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
```

Restored, exit 0:
```text
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## G6

File: `mcp/src/clinical-graph/follow-up-profile-endpoint.ts`

```sh
'node' '--import' 'tsx' '--test' '--test-name-pattern=^G6' 'mcp/tests/followUpProfileEndpoint.test.ts'
```

Red, exit 1:
```text
not ok 1 - G6 chart-read staff can read but cannot create or update
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
```

Restored, exit 0:
```text
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## G7

File: `mcp/src/clinical-graph/follow-up-profile-endpoint.ts`

```sh
'node' '--import' 'tsx' '--test' '--test-name-pattern=^G7' 'mcp/tests/followUpProfileEndpoint.test.ts'
```

Red, exit 1:
```text
not ok 1 - G7 practice cannot publish a missing section or orderable without a reason
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
```

Restored, exit 0:
```text
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## server-fault

File: `mcp/src/clinical-graph/follow-up-profile-endpoint.ts`

```sh
'node' '--import' 'tsx' '--test' '--test-name-pattern=^write failures distinguish' 'mcp/tests/followUpProfileEndpoint.test.ts'
```

Red, exit 1:
```text
not ok 1 - write failures distinguish client conflicts and missing profiles from server faults
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
```

Restored, exit 0:
```text
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## G8-registry

File: `data/canonical-extensions/registry.json`

```sh
'npm' 'run' 'preflight'
```

Red, exit 1:
```text
ODOS preflight complete: 0 warning(s), 3 hard block(s). Reports: .odos/preflight-report.json and .odos/preflight-report.md
```

Restored, exit 0:
```text
ODOS preflight complete: 0 warning(s), 0 hard block(s). Reports: .odos/preflight-report.json and .odos/preflight-report.md
```

## G8-frontdoor

File: `deploy/frontdoor/Caddyfile`

```sh
'node' '.claude/skills/tier0-census/scripts/check-frontdoor-coverage.mjs'
```

Red, exit 1:
```text
! missing-backend /follow-up-profiles: backend family has no front-door block
Front-door route parity: 1 finding(s); FAIL (blocking).
```

Restored, exit 0:
```text
Front-door route parity: 0 finding(s); PASS (blocking).
```

## UI-save

File: `ui/src/components/settings/FollowUpProfilesSettings.tsx`

```sh
'node' '--import' 'tsx' '--test' '--test-name-pattern=^Settings reset' 'ui/tests/followUpProfilesSettings.test.tsx'
```

Red, exit 1:
```text
not ok 1 - Settings reset carries the current version and conflict leaves the edit intact
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
```

Restored, exit 0:
```text
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## UI-picker

File: `ui/src/components/settings/FollowUpProfilesSettings.tsx`

```sh
'node' '--import' 'tsx' '--test' '--test-name-pattern=^Settings picker' 'ui/tests/followUpProfilesSettings.test.tsx'
```

Red, exit 1:
```text
not ok 1 - Settings picker adds a real section and saves the caller version without changing shipped data
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
```

Restored, exit 0:
```text
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## UI-read-only

File: `ui/src/components/settings/FollowUpProfilesSettings.tsx`

```sh
'node' '--import' 'tsx' '--test' '--test-name-pattern=^Settings read-only' 'ui/tests/followUpProfilesSettings.test.tsx'
```

Red, exit 1:
```text
not ok 1 - Settings read-only catalogue permits inspection but no save controls or writes
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
```

Restored, exit 0:
```text
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## G7b-loop

File: `ui/src/lib/follow-up-profiles.ts`

```sh
cd ui && node --import tsx --test --test-name-pattern='clinical-graph requests share' tests/clinicalGraphRouting.test.tsx
```

Red, exit 1:
```text
not ok 1 - clinical-graph requests share the literal Vite route and Medplum authorization helpers
  operator: 'doesNotMatch'
# tests 1
# pass 0
# fail 1
# skipped 0
```

Restored, exit 0:
```text
ok 1 - clinical-graph requests share the literal Vite route and Medplum authorization helpers
# tests 1
# pass 1
# fail 0
# skipped 0
```

## G7b-count

File: `ui/src/lib/follow-up-profiles.ts`

```sh
cd ui && node --import tsx --test --test-name-pattern='clinical-graph requests share' tests/clinicalGraphRouting.test.tsx
```

Red, exit 1:
```text
not ok 1 - clinical-graph requests share the literal Vite route and Medplum authorization helpers
    56 !== 57
  operator: 'strictEqual'
# tests 1
# pass 0
# fail 1
# skipped 0
```

Restored, exit 0:
```text
ok 1 - clinical-graph requests share the literal Vite route and Medplum authorization helpers
# tests 1
# pass 1
# fail 0
# skipped 0
```

## Served route rate limit

File: `mcp/src/index.ts`

```sh
node docs/build-log/followup-s3a-profiles/rate-mutation.mjs
```

Red, exit 1:
```text
AssertionError [ERR_ASSERTION]: Profile requests must reach 429 within 121 attempts
```

Restored, exit 0:
```text
All three profile routes: unauthenticated 401 before limit; 429 with rate-limit/retry headers at limit.
```
