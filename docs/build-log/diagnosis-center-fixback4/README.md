# PR #594 fixback 4 — route-count test

Starting head: `ff6155b4f5016e2d4d0f170ac7eee383841d54d6`; branch: `drbang-iva/dx-status`.

The PR's two newness routes bring the inline clinical-graph route count from 99 to 101. Both handlers consume staff-authenticated FHIR reads and the diagnosis-status/newness store; neither consumes finding definitions. Their registrations use `authenticateStaffRouteForAction` and `diagnosisVisitStatusStore`, matching the diagnosis visit-status routes. The existing definition-backed dependency counts remain 49 clinical and 6 procedure calls.

## Files changed

- `mcp/tests/findingDefinitionStore.test.ts`: expect 101 routes, explain the two newness routes' dependency choice in one comment, and assert both newness handler names beside the existing handler assertions.
- `docs/build-log/diagnosis-center-fixback3/README.md`: link its recorded CI blocker to this repair.
- This directory: complete test output, preflight output, red/green evidence, and the test source hash.

No production code, decisions, terminology, dependency manifests, or cross-repo files changed. No new Mandate 14 ledger or decisions-index entry is needed.

## Executed verification

| Command | Result | Evidence |
| --- | --- | --- |
| `npm --prefix mcp test` with disposable PostgreSQL and `ODOS_ALLOW_UNGATED_MCP=1` | exit 0; 4,835 tests, 4,786 pass, 0 fail, 49 skipped | `mcp-full.txt`, `mcp-full.json`, `test-environment.json` |
| `npm run preflight` | exit 0; 48 resource types, 901 operations, 0 warnings, 0 hard blocks | `preflight.txt`, `preflight.json` |
| Targeted route-count test at 99, routes present | exit 1; 0 pass, 1 fail; `101 !== 99` | `route-count-broken.txt` |
| Same test restored to 101 | exit 0; 1 pass, 0 fail | `route-count-restored.txt` |

Targeted command, run from `mcp/`:

```sh
node --import tsx --test --test-name-pattern='every definition-backed clinical-graph HTTP closure' tests/findingDefinitionStore.test.ts
```

The initial red/green run is also retained as `route-count-red.txt` and `route-count-green.txt`. After the full suite, the finished test was deliberately changed back to 99, verified in place, observed failing, restored byte-for-byte to 101, and rerun green. Production routes stayed present throughout. `source-sha256.json` pins the final test source.

The first full-suite attempt exposed missing local setup: unavailable PostgreSQL on the default port and a missing root `tsx` loader. The successful rerun used existing root dependencies linked into the task worktree and a dedicated, volume-free PostgreSQL 16 container on a random loopback port, selected through a process-only `ODOS_POSTGRES_URL`. The container was stopped and removed afterward. The standard test harness's `ODOS_ALLOW_UNGATED_MCP=1` acknowledgement allows its exit status to reflect executed tests while explicitly reporting unavailable live-stack coverage. The 49 skips remain visible in the full output; this is not live authorization proof.

## Delivery status

CodeRabbit comment 4008579887 on fixback 3's README is addressed by this repair. The authorized delivery is one push to PR #594, with a one-line reply and thread resolution. No merge or evaluation marker.

**Status: author verification complete; independent evaluation required. NOT EVALUATED — hand the final pushed head to Fable (high) or Opus (medium) in Claude before merge.**
