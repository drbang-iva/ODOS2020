# Reaper error vs refusal — author evidence

Genuine removal errors now report FAILED and exit 1 even when nothing was deleted.
Guard refusals before deletion still report SKIP and exit 0.
Partial removals still report FAILED and name the destroyed resources.
Reap also pins the raw volume CreatedAt value at its refreshed inventory and checks it before volume removal.
Missing, malformed, zero, future, non-string, or changed values refuse; unchanged values remain removable.
No independent evaluation or merge was performed. Status: NEEDS-REVIEW / NOT EVALUATED.

## Scope and provenance

Branch: `codex/reaper-error-vs-refusal`. Base: `8802dcbaf868fc17f4e414566f97a754bceddd57`.
Implementation source SHA-256: `7239155a9ba1031c2a544001f77d7cb2ca29bc976ab850c46fd049a4c14fa866`. The PR head identifies the evidence commit.

Files: `scripts/stack-lifecycle.mjs`, `scripts/stack-lifecycle.test.mjs`, one line in `docs/install.md`, this bundle and `checks.txt`.
No dependency, CI, clinical, account, migration, recency-policy, --only-policy, protection-set, foreign-resource-guard, or removal-order change.
The new volume timestamp check is enabled only by reap; down retains its existing removal behavior.
The extra volume-inventory type check prevents an implausible non-string value from crashing before a refusal can be reached; valid recency values and policy are unchanged.

Both required companion records were read from GitHub main with `gh api .../contents/<path>?ref=main`; the verified companion checkout was `/Users/ericr.bang/GitHub/performance-od`, whose local main lacked them:
- `decisions/2026-09-20-odos-stack-reaper-error-vs-refusal-codex-kickoff.md`
- `decisions/2026-09-20-odos-stack-lifecycle-pr636-fixback2-eval.md`

## Premises re-verified

At fetched main `8802dcbaf868fc17f4e414566f97a754bceddd57`:
- `scripts/stack-lifecycle.mjs:282-291`: after zero deletions, the catch refreshed inventory, then logged SKIP even with no refusal reason. `:296` returned zero because failures stayed empty. Reproduced with two real stopped Alpine containers: SKIPPED 1, FAILED 0, exit 0; 2/2 containers survived.
- `scripts/stack-lifecycle.mjs:228-229`: per-volume reinspection checked only its Compose project label before `docker volume rm`; no CreatedAt identity comparison. Changed and missing timestamp tests both removed the volume before this fix.
- The named E2 race really pauses at the first `docker rm`, after planning and the pre-removal check. Docker rejects the now-running container, and refreshed refusal reasons preserve SKIP. Its existing assertions were retained.
- Docker server 29.2.1 and docker-compose 5.1.3 verified with their version commands.
- Host-count detail drift: eight current Compose projects, including five network-only projects, rather than the earlier four-stack snapshot. All eight fail the default age/running eligibility check. This is a non-blocking snapshot detail; the defect and safety requirements still apply.
- The companion local-main lag is a retrieval detail, resolved by reading remote main. No false blocking premise was found.

## Classification mechanism

`RemovalRefusal extends Error` and `isRemovalRefusal(error)` use `instanceof`, without matching messages.
The existing pre-removal reasons, per-volume label check and new timestamp guard mark refusals explicitly. When Docker rejects removal after a restart race, the existing refreshed refusal reasons become a marked refusal.
Any recorded deletion takes precedence over the refusal type: FAILED with the destroyed resource names. With no deletion, a marked refusal skips; a plain error fails. If post-error inventory also fails, the FAILED message preserves both the original removal error and the refresh error.
The timestamp identity is the raw daemon string, avoiding millisecond truncation when comparing values. Its parsed value must be finite, positive and no later than the observation time. There is no comparison with container creation time or daemon version.

## Commands and results

Commands/output, including all mutation logs, are in [checks.txt](checks.txt). Trailing whitespace in TAP diagnostics is trimmed for git diff --check; original byte-for-byte logs remain in local `.odos/reaper-proof/`. Mutation commands containing spaces in a test-name pattern were executed as an argv array; quote the complete `--test-name-pattern=...` argument when replaying in a shell.

- `npm run test:stack-lifecycle`: **37 tests, 37 pass, 0 fail, 0 skipped; exit 0**. All 25 existing tests remain, with their expected behavior unchanged. Twelve cases were added.
- `npm run preflight`: **0 warnings, 0 hard blocks; exit 0**.
- `git diff --check`, `node --check scripts/stack-lifecycle.mjs`, `node --check scripts/stack-lifecycle.test.mjs`: **exit 0**, no output.
- `npm ci --ignore-scripts`: **10 packages added; 11 audited; 0 vulnerabilities**. No manifest or lockfile changed.
- `node --test --test-name-pattern=E4 scripts/stack-lifecycle.test.mjs` with a Docker shim that records calls and exits 77: **1 pass, 0 fail; Docker invocations 0**.

For each mutation, the exact replacement was asserted to occur once, the edited file was read back to verify the mutant, and the original bytes were restored in `finally` before the green command. The logs record the replacement, command, exit code, output and restored source hash. These are author proofs, not an independent verdict.

| Mutation / guarded behavior | Broken | Restored |
|---|---|---|
| e1-error-as-skip | tests 2, pass 0, fail 2; exit 1 | tests 2, pass 2, fail 0; exit 0 |
| e2-race-as-error | tests 1, pass 0, fail 1; exit 1 | tests 1, pass 1, fail 0; exit 0 |
| e3-lost-deletion-record | tests 1, pass 0, fail 1; exit 1 | tests 1, pass 1, fail 0; exit 0 |
| e4-refusal-type | tests 1, pass 0, fail 1; exit 1 | tests 1, pass 1, fail 0; exit 0 |
| e5-missing-check | tests 8, pass 2, fail 6; exit 1 | tests 8, pass 8, fail 0; exit 0 |
| e5-reject-unchanged | tests 2, pass 0, fail 2; exit 1 | tests 2, pass 2, fail 0; exit 0 |
| e1-refresh-loses-original | tests 1, pass 0, fail 1; exit 1 | tests 1, pass 1, fail 0; exit 0 |
| e5-inventory-type | tests 1, pass 0, fail 1; exit 1 | tests 1, pass 1, fail 0; exit 0 |

Named coverage: E1 = first Docker removal failure (including a second failure during refresh); E2 = “reap refreshes inventory and spares a project restarted between its plan and removal”; E3 = “reap fails and names a destroyed container when a second stopped container starts during removal”; E4 = direct type classification; E5 = unchanged, changed, absent, invalid, zero, future, non-string, non-string-at-inventory, and legacy-unchanged timestamp cases.
The initial eight E5 cases were mutation-tested together; the subsequently added inventory-type case has its own red/green pair. The final suite includes all nine.

## WHAT DID THIS FIX BREAK?

1. **Ordinary-run failure noise:** read-only inspection of the eight real host projects finds zero eligible under default settings; all remain age/running refusals. Therefore this snapshot supplies no real eligible-project failure-rate estimate. To exercise normal deletion without touching active work, five disposable uniquely scoped network-only replicas of the host's five network-only project shapes were reaped: **REMOVED 5; SKIPPED 0; FAILED 0; exit 0**. No noise appeared in that sample. This is not a claim about long-run failure frequency. Genuine Docker failures now intentionally exit non-zero.
2. **CreatedAt compatibility on this daemon:** all **10/10 host volumes** had usable timestamps and **10/10** stayed identical across two inspections. Native unchanged-volume removal and a stable legacy-style timestamp both pass. Changed/absent/unusable values remain present after refusal. No false refusal was observed on Docker 29.2.1. Older daemon behavior was simulated at the CLI metadata boundary, not tested on an older engine.
3. **Existing-test meaning:** all **25 original expectations** remain. Diagnostics were added to E2/E3; fixture names now use UUIDs, including the formerly fixed default-project directory, to avoid cross-run collisions. No original expected exit, count, protection, recency, or resource-survival assertion was relaxed. The new classification changes the uncovered genuine-error case intentionally.

Final census: **0 fixture containers, 0 fixture volumes, 0 fixture networks**. Existing host resource identities/names/project labels, container running flags and volume timestamps were unchanged across the recorded before/after census: **13 containers, 10 volumes, 12 networks; 8 Compose projects**. The census began after initial reproductions; the first read-only list also showed the same eight projects. The first and final lists also show one host project changing from three running containers to zero; the two detailed census snapshots were identical, so this is not a claim that host runtime state stayed fixed throughout the whole task. Host resource details remain in local `.odos/reaper-proof/host-resources-*.json`; no practice data was read.
Every valid reap invocation used a unique fixture-only prefix longer than 12 characters. The two original argument-rejection tests deliberately use missing/short --only and fail before inventory; they never have a valid destructive execution path. Fixture teardown targets exact names/IDs/labels, never prune. No operator stack was reaped.

## Initial-run caveats

The first baseline suite recorded 24/25 because its global unmanaged-resource census raced a separate new probe deleting its own fixture. A concurrent unchanged-volume probe also saw an inventory deletion race. Docker probes were then serialized; the original failed test and both unchanged-volume cases passed before implementation (serialized run: 3 passing controls, 6 expected failing new guards). No production change was made for those harness races.
The first Node CLI shim used immediate `process.exit`, truncating pipe output and causing JSON parse failures. It was corrected to synchronous writes plus `exitCode`; the timestamp cases were then rerun against old production code and failed for actual unwanted deletion. Those initial failures are retained in checks.txt and are not counted as valid mutation evidence.

## Risks, boundaries and handoff

CreatedAt hardening does **not** close the final inspect-to-remove TOCTOU window. A replacement with an identical reported timestamp is also indistinguishable. A legacy daemon can report content-change time, so a changed value may conservatively refuse even when the name still denotes the same volume; a stable old value is accepted. Primary references, accessed 2026-09-20: [Moby issue 38274](https://github.com/moby/moby/issues/38274) and [Moby fix 44719](https://github.com/moby/moby/pull/44719).
Global inventory churn can still cause genuine inspection errors; this slice preserves their non-zero exit rather than changing inventory policy. Initial-plan refusals are still printed before the per-removal SKIPPED counter is initialized; that existing counter behavior is unchanged.

No new strategy decision was authored; performance-od is read-only, so decisions/INDEX.md is unchanged. Mandate 14 ledger additions: **0**, because this tooling change adds no medical codes, FHIR canonicals or regulatory assertions.
No cross-repo implementation follow-up. Required follow-up: independent Fable/Opus evaluation at the final PR head, at the requested tier; bot checks do not substitute for it. No merge, independent verdict, operator override label, bot-trigger comment or review-thread resolution is authorized by this bundle.
