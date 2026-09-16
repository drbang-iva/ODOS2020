# Findings handler author evidence

Branch: `drbang-iva/r10-a2b1-findings`. Own initial checkpoint: `653000d1`.
Integration dependencies: writer/reader `15722129`, pagination `a7448944`, candidates/pick `153bb322`.

- `handler-green.tap`: findings legacy migration, canonical operation suite and diagnosis write gate: **112 passed, 0 failed**.
- `premise-replay.log`: every E1–E17 replay and A1 comparison assertion executes: **17/17**.
- `all17-green.tap`: unchanged parity wrapper asserts **17 emitted probes + 17 PASS comparisons**.
- `build.log`: `npm --prefix mcp run build` exit **0**.
- `read-grant.log`: `npx tsx scripts/fhir-read-grant-check.ts` exit **0**; route wiring preserves prior guarded source locations.
- `guards.txt` + paired raw TAP: **17 assigned guard mutations**, every mutation exit **1**, every restored check exit **0**. W7 and W44/W45 here are handler/unit probes; parent owns live and writer-library proof.
- `initial-red.tap`, `replay-red.tap`, `partial-eye-red.tap`: missing command support, typed replay lookup failure, and removed-eye-first partial replay reproduced before implementation.
- `assertion-ledger.md`: **104** changed/removed existing assertions, original file:line, before/after text and V/W mapping.

All capture and five divergence baseline files remain byte-identical: the only changed path under `mcp/tests/fixtures/r10/` is `premise-replay.ts`.

## Explicit blocker

`capture-instrumentation-blocked.tap`: full findings + parity run is **280 passed / 1 failed** (before final extra eye replay test). The capture-instrumentation test's loader hard-requires removed private `atomicFindingRows` / `sectionFindingRows` helpers from the endpoint. The door now reads `projectCurrentFindings`; keeping dead obsolete implementations would defeat the replacement. `capture-baseline.mjs` is outside the literal authorized file set; no change was made. Parent requested the narrow operator ruling. Captures and divergences themselves are untouched.

No containers were started by this agent. No UI, policies, credentials, clinical codes, or decisions were changed. No push, PR, merge, or evaluation marker. **NOT EVALUATED**; parent owns final integration checks and independent evaluation handoff.
