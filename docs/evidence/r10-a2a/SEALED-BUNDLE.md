# R10 A2a sealed bundle — NOT EVALUATED

Library implementation by Codex (GPT-6 Astra, high; bounded writer helper: GPT-5.6 Sol). Independent evaluator: Claude Opus. No evaluation marker has been posted. PR and final head are recorded in the handoff; this bundle pins the tested code by hashes.

## Summary and boundary

The reader exposes scoped homes and their sources, typed load failures, write baselines, retired UNKNOWN state, scoped negative suppression, and optional pending-audit state. The writer applies one planned Observation write per target, enforces conditional concurrency, carries frozen audit repair payloads, and classifies replay, conflict, refusal and uncertain responses. A new command repairs an earlier audit before replacing its marker. Reassertions write only Provenance; UNKNOWN retirement follows destination facts.

Production imports remain library-to-library only. Application handlers, routes, UI, clients and policies are unchanged by this PR. Partial/excluded negatives intentionally preserve unrelated snapshot positives; the UI-produced full-scope case converges with today's display.

Contract: PerformanceOD revision 3.1, `05d83563b34c8e213a959cac7c6e15ee387bfd74`, `decisions/2026-09-16-odos-r10-a2-codex-kickoff.md`. Both adjudications were read. All §2 premises were rechecked; their source files remain unchanged across `6a3ad04a`, `b761a8a2`, and final base `87ca9f1d10c63a4796068c0a8d8cbda88fdf968c`. See [premises](premises.md).

Branch: `drbang-iva/r10-a2a`. Code commits after rebase: `d00b49da3ecb30e9cce98f90df239ca893807133` and `0830f5a5b8f179e28b57324e70dfddb3d7edf36e`. Final fetch/rebase targeted `87ca9f1d10c63a4796068c0a8d8cbda88fdf968c` (#612); the rebase had no conflicts. [Source hashes](source-sha256.json) bind the checks to the code, independent of later evidence-only commits.

## Files touched, all within §4

- `mcp/scripts/r10-a2a-preflight.mjs`
- `mcp/src/clinical-graph/current-finding-identity.ts`
- `mcp/src/clinical-graph/current-finding-reader.ts`
- `mcp/src/clinical-graph/current-finding-writer.ts`
- `mcp/tests/currentFindingIdentity.test.ts`
- `mcp/tests/currentFindingReader.test.ts`
- `mcp/tests/currentFindingWriter.test.ts`
- `mcp/tests/fixtures/r10/premise-replay.ts`
- `mcp/tests/fixtures/r10/writer-harness.ts`
- `docs/evidence/r10-a2a/`: this bundle, four-row source ledger, raw HTTP/results, guard mutations and outputs, check outputs, scope checker and source hashes.

No new decision was made; PerformanceOD and `decisions/INDEX.md` were left unchanged. The accepted contract already records the decisions. No dependency or lockfile changes.

## Disposable capability gate and writer proof

Server: `5.1.30-9b1bd92`; Node `v24.18.1`; image `medplum/medplum-server@sha256:358ab425b29390067b6cb82bfbaeee48580a703f7cc5b730bed2b2ba7184c1de`. Endpoint `http://127.0.0.1:29023`; project `odos-r10-a2a`; synthetic patients and identities only. Provider/staff policies were recompiled and the attached memberships verified on rebased code head `d00b49da3ecb30e9cce98f90df239ca893807133`. Their compiler is byte-identical at the final code head.

| Role | Login | AccessPolicy id | Version |
|---|---|---|---|
| provider | `r10-a2a-provider@example.invalid` | `b9d6df9d-2dde-4dd4-8253-cab5d596bf9c` | `561f3ecf-538e-44aa-8ea9-673cf53352d7` |
| staff | `r10-a2a-staff@example.invalid` | `cbf76362-24e6-4905-aa90-79f3c74d8043` | `61eb5048-8306-4147-a51e-755dc51c7d99` |

[G-a..G-d results](gate-results.json): **8 passed / 0 failed**. [Raw gate HTTP](gate-http.json), [compiled policies/memberships](principals.json), [policy recompilation HTTP](recompile-http.json), [runtime](runtime.json), [bootstrap HTTP](bootstrap-http.json).

- G-a: both synchronized calls return one id; one Provenance persists; the third returns 200 / `created:false`.
- G-b: exact planned identity/marker/typed qualifier/home fields round-trip; duplicate create returns the original; valid update succeeds; stale If-Match returns 412 and preserves the record.
- G-c: each role retrieves the tag-keyed audit.
- G-d: each role retrieves exactly two records for two existing tag tokens and one absent token.

[Live writer results](writer-results.json): **15 passed / 0 failed**, through `executeFindingCommand`, at `0830f5a5b8f179e28b57324e70dfddb3d7edf36e`. [Raw writer HTTP](writer-http.json). W1, W2, W13, W19, W20 and W23 ran under both roles; both roles also ran the two-target lost-second-response replay. Staff unlink made one Observation write, attempted zero Condition writes, and preserved both the source and the sibling home. W20 records the repaired C1 audit and asserts its target is the Observation carrying the `self` marker.

## Mandate 14

[Four ledger rows](mandate-14.md) each have two agreeing primary sources, direct URLs, and access date **2026-09-16**: `_tag` over `meta.tag`, comma-OR token search, conditional create using that search, and R4 Provenance's element inventory. Sources are HL7 R4 and pinned Medplum source/types. The ledger is documentary; executable capability probes establish behavior. No new clinical terminology code was introduced.

## Real check counts

| Suite / command | Result |
|---|---|
| `currentFindingIdentity.test.ts` | 17 passed / 0 failed / 0 skipped |
| `currentFindingReader.test.ts` | 32 passed / 0 failed / 0 skipped |
| `currentFindingWriter.test.ts` | 33 passed / 0 failed / 0 skipped |
| `r10-parity.test.ts` | **170 passed / 0 failed / 0 skipped** |
| Focused total | 252 passed / 0 failed / 0 skipped |
| `npm --prefix mcp test` | **5441 passed / 0 failed / 52 skipped**, 5493 total |
| `npm --prefix ui test` | **1629 passed / 0 failed / 0 skipped**, 1629 total |
| `npm --prefix mcp run build` | exit 0 |
| `npm --prefix ui run build` | exit 0; existing large-chunk warning |
| `npm run preflight` | exit 0; 0 warnings / 0 hard blocks |
| Scope/assertion checker | exactly 4 authorized changed statements; other existing assertions unchanged |
| `git diff --check` | exit 0 |

Raw TAP per focused suite and compressed full-suite output are under [checks](checks/). Full MCP uses a separate PostgreSQL 16 test database `odos_r10_a2a_tests` on `127.0.0.1:29024`, with `ODOS_POSTGRES_URL` injected from ignored private configuration. `ODOS_ALLOW_UNGATED_MCP=1` was explicit: 44 general live-stack checks plus 8 other environmental checks were skipped. The 8 capability and 15 writer live proofs above were separately executed against real Medplum policies; the broad suite is not their substitute.

The five established parity divergences are byte-identical to origin/main; see [hash confirmation](parity-confirmation.json). The two additional recovery boundary checks were also observed red (2 failed) before their repairs and green in the 33-test writer suite ([red](checks/recovery-boundaries-red.txt), [green](checks/recovery-boundaries-green.txt)).

## Four existing assertion changes — three tests

The raw-negative assertions, E8's negative-act count and panel-context assertions stay intact. [Executable scope check and exact before/after](assertion-changes.json):

| Original location | Before | After |
|---|---|---|
| `currentFindingReader.test.ts:86` | `assert.equal(p.currentFacts.length, 1)` | `assert.equal(p.currentFacts.length, 0)` |
| `currentFindingReader.test.ts:87` | `assert.equal(p.currentFacts[0].presence, "present")` | `(removed)` |
| `currentFindingReader.test.ts:172` | `assert.equal(p.currentFacts[0].presence,"present")` | `assert.equal(p.currentFacts.length,0)` |
| `fixtures/r10/premise-replay.ts:146` | `assert.equal(p.currentFacts[0].presence,'present')` | `assert.equal(p.currentFacts.length,0)` |

## Mandate 17 — every §6 guard red then green

All 17 required mutations were killed by behavioral assertions, restored, and checked green. For live guards, the red run stops on the provider's demonstrated failure; the restored run passes both roles. These are author checks, not independent evaluation. The final guard rerun uses the recompiled policies listed above; see [guard principals](guards/principals.json). [Machine summary](guard-summary.json).

| Guard | Red | Restored green | Evidence |
|---|---|---|---|
| [W1](guards/W1.json) | 1 failed provider probe | 2 passed role probes | [Mutation](guards/W1-mutant.diff) · [red](guards/W1-red.txt) · [green](guards/W1-green.txt) |
| [W2](guards/W2.json) | 1 failed provider probe | 2 passed role probes | [Mutation](guards/W2-mutant.diff) · [red](guards/W2-red.txt) · [green](guards/W2-green.txt) |
| [W5](guards/W5.json) | 0 passed / 1 failed | 1 passed / 0 failed | [Mutation](guards/W5-mutant.diff) · [red](guards/W5-red.txt) · [green](guards/W5-green.txt) |
| [W6](guards/W6.json) | 0 passed / 1 failed | 1 passed / 0 failed | [Mutation](guards/W6-mutant.diff) · [red](guards/W6-red.txt) · [green](guards/W6-green.txt) |
| [W11](guards/W11.json) | 0 passed / 1 failed | 1 passed / 0 failed | [Mutation](guards/W11-mutant.diff) · [red](guards/W11-red.txt) · [green](guards/W11-green.txt) |
| [W13](guards/W13.json) | 1 failed provider probe | 2 passed role probes | [Mutation](guards/W13-mutant.diff) · [red](guards/W13-red.txt) · [green](guards/W13-green.txt) |
| [W14](guards/W14.json) | 0 passed / 1 failed | 1 passed / 0 failed | [Mutation](guards/W14-mutant.diff) · [red](guards/W14-red.txt) · [green](guards/W14-green.txt) |
| [W15](guards/W15.json) | 0 passed / 1 failed | 1 passed / 0 failed | [Mutation](guards/W15-mutant.diff) · [red](guards/W15-red.txt) · [green](guards/W15-green.txt) |
| [W16](guards/W16.json) | 0 passed / 4 failed | 4 passed / 0 failed | [Mutation](guards/W16-mutant.diff) · [red](guards/W16-red.txt) · [green](guards/W16-green.txt) |
| [W18](guards/W18.json) | 1 passed / 1 failed | 2 passed / 0 failed | [Mutation](guards/W18-mutant.diff) · [red](guards/W18-red.txt) · [green](guards/W18-green.txt) |
| [W19](guards/W19.json) | 1 failed provider probe | 2 passed role probes | [Mutation](guards/W19-mutant.diff) · [red](guards/W19-red.txt) · [green](guards/W19-green.txt) |
| [W20](guards/W20.json) | 1 failed provider probe | 2 passed role probes | [Mutation](guards/W20-mutant.diff) · [red](guards/W20-red.txt) · [green](guards/W20-green.txt) |
| [W21](guards/W21.json) | 0 passed / 1 failed | 1 passed / 0 failed | [Mutation](guards/W21-mutant.diff) · [red](guards/W21-red.txt) · [green](guards/W21-green.txt) |
| [W22](guards/W22.json) | 0 passed / 1 failed | 1 passed / 0 failed | [Mutation](guards/W22-mutant.diff) · [red](guards/W22-red.txt) · [green](guards/W22-green.txt) |
| [W23](guards/W23.json) | 1 failed provider probe | 2 passed role probes | [Mutation](guards/W23-mutant.diff) · [red](guards/W23-red.txt) · [green](guards/W23-green.txt) |
| [W24](guards/W24.json) | 0 passed / 1 failed | 1 passed / 0 failed | [Mutation](guards/W24-mutant.diff) · [red](guards/W24-red.txt) · [green](guards/W24-green.txt) |
| [W25](guards/W25.json) | 0 passed / 1 failed | 1 passed / 0 failed | [Mutation](guards/W25-mutant.diff) · [red](guards/W25-red.txt) · [green](guards/W25-green.txt) |

W15's red is specifically the attempted Condition-write spy (`1 != 0`). W16 also demonstrates all three amended existing tests (four statements including E8). W20's green checks the repaired audit's expanded self target. W24's mutation changes baseline verification on a replay only: its second target incorrectly applies; restored code preserves the conflict.

Reproduce the guards with `node docs/evidence/r10-a2a/run-guards.mjs W1 W2 W5 W6 W11 W13 W14 W15 W16 W18 W19 W20 W21 W22 W23 W24 W25` from the retained task worktree after restarting its disposable stack. The runner retains exact mutant diffs and restores each source in a finally block. Ordinary checks and live proof commands are recorded with their outputs. Private credentials are not in this bundle.

## Risks, follow-ups and status

- This is a library slice. A2b owns handlers, status mapping, Retry controls and client serialization; A3 owns all remaining consumers, carry lineage and lifecycle audit repair. Their joint release rule remains in force.
- Multi-target writes are deliberately non-atomic. Conflict/refusal/uncertainty stops later targets; already completed targets remain applied. Durable markers retain audit debt.
- Tests use synthetic records and current compiled provider/staff policies on the pinned local Medplum image. They do not certify other deployments or policy variants.
- Review bots are a first pass. Independent Claude Opus evaluation at the final exact PR head and its local merge with main is still required.

**Status: author implementation and required proofs complete; NOT EVALUATED; no merge.** PR review state is recorded in the final handoff. [Stop receipt](stopped-containers.json): `odos-r10-a2a-medplum-1`, `odos-r10-a2a-postgres-1`, `odos-r10-a2a-redis-1`, and `odos-r10-a2a-test-postgres` were stopped with the requested command, retained, and verified not running.
