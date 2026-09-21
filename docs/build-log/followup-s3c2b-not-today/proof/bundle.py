import json,subprocess
from pathlib import Path
root=Path(__file__).resolve().parents[4]
directory=root/'docs/build-log/followup-s3c2b-not-today'
mutations=json.loads((directory/'mutations.json').read_text())
suites=json.loads((directory/'suite-summaries.json').read_text())
text='''# S3c-2b sealed author bundle

Not today / Put back now persist per encounter, independently of the frozen shape.
Staff and providers with chart.write can decide; every decision records who and when.
Already ordered takes precedence; Put back alone removes a decision.
R1 separates Encounter status mapping from downstream 502 failures in GET and PUT.
UI actions and failures are scoped to each row; successful PUT supplies the replacement list.
No orders, plan actions, charges, ServiceRequests or clinical terminology were added by this feature.

Coded-by: Codex — runtime model identifier unavailable, runtime effort unavailable; recommended Sol, high effort.
NOT EVALUATED — independent evaluator: Claude Opus 5. Do not merge on author evidence.

Base: a4e7866fbe20731edb5fd27759d6e6dfffa65a0f.
Implementation/build commit: cbccc45627a405027e528068ef940e2ea9307f4b.
Branch: drbang-iva/followup-s3c2b-not-today. PR URL and final head are supplied in the PR/task handoff.

## Premises

- P1: corrected by operator R1 in companion kickoff 02da7c00. Old combined catch misclassified downstream status errors; new GET/PUT keep that mapping only for the Encounter read.
- P2: GET block and limiter at 8688–8706 verified at base; PUT inserted immediately afterward.
- P3: scope store conditional update/create and writeToken confirmation verified; separate decision store uses the same concurrency pattern plus bounded reapplication.
- P4: provider and staff hold chart.write; canonical admin has chart.read without chart.write. Live reader is a non-owner identity bound to that policy.
- P5: finished Encounter refusal precedent verified; decision endpoint uses the required ordinary conflict sentence.
- P6: practitionerNamesByReference was private; only export was added and the helper is reused.
- P7: shared error helper maps concurrent-edit/412 specially and preserves ordinary 409 wording; UI uses it.
- P8: full definition inventory inspected; 106 becomes 107, dependencies remain 50/6. UI caller-file census remains 59; routing test untouched. Named-route consumers and Observation inventories remain unchanged; full suites passed.
- P9: unshaped body remains exactly recorded:false, GET never calls service read(), prior three-state payload has no buttons. Every original test line remains an exact prefix of its extended file.

## Files and grants

| File | Before → after / permitted change |
| --- | --- |
| mcp/src/clinical-graph/follow-up-decision-store.ts | New Basic record store; conditional writes, one-key retries, three-attempt conflict |
| mcp/src/clinical-graph/follow-up-queue-endpoint.ts | Three-state GET → four-state GET and strict PUT; R1 mapping, permissions, transitions |
| mcp/src/clinical-graph/exam-overview-endpoint.ts | Only `async function practitionerNamesByReference` → `export async function practitionerNamesByReference` |
| mcp/src/index.ts | Exactly one 21-line block following the GET; dynamic import, own limiter, literal app.put registration |
| mcp/tests/followUpDecisionStore.test.ts | New 5 tests |
| mcp/tests/followUpQueueEndpoint.test.ts | Original 10 tests unchanged; 10 tests appended |
| mcp/tests/findingDefinitionStore.test.ts | Only 106 → 107 and the one permitted explanatory comment; 50/6 unchanged |
| ui/src/components/charting/FollowUpQueue.tsx | Permission-aware buttons, who/when, per-row saving/errors, returned queue replacement |
| ui/src/lib/follow-up-queue.ts | Existing client file gains PUT and validator; missing canDecide defaults false |
| ui/src/styles/charting.css | Four queue-specific style rules appended |
| ui/tests/followUpQueue.test.tsx | Original 5 tests unchanged; 5 tests appended |
| docs/build-log/followup-s3c2b-not-today/ | Proof scripts, summaries, mutation evidence, live responses and screenshots |

All restricted changes were mechanically compared with base. No scripts, fixtures, shape/profile stores, board, panel tabs, registry, deployment, policy or workflow files were edited.

## Suites and checks

'''
for k,v in suites.items():text+=f"- {k}: "+', '.join(f'{n} {count}' for n,count in v.items())+'\n'
text+='''
UI: 1834 base + 5 added = 1839; command `npm --prefix ui test`.
MCP: 6222 base + 15 added = 6237; 6183 passed and 54 skipped. The skipped live lanes are not claimed as authorization proof.
MCP command from mcp/, exactly the CI file inventory:

```sh
node --import tsx --test --test-concurrency=1 'src/__tests__/**/*.test.ts' 'tests/**/*.test.ts' '../tests/boundaries/**/*.test.ts' '../tests/observation-status-machine/**/*.test.ts' '../tests/setup-wizard/**/*.test.ts' '../tests/preflight/**/*.test.ts' '../tests/smart/**/*.test.ts' '../tests/cds/**/*.test.ts' '../tests/agentops/**/*.test.ts' '../tests/bulk-data/**/*.test.ts' '../tests/mandate-8/**/*.test.ts'
```

Every MCP run sets ODOS_POSTGRES_URL to dedicated odos-s3c2b-postgres on localhost:32781. Full runs also set ODOS_REAL_WEASYPRINT_TEST=1 and WEASYPRINT_BIN to verified disposable WeasyPrint 69.0. Native Node 22.22.3 expands the quoted globs. Suite summaries only are retained.

Base and restored candidate: `npx tsc --noEmit`, `npx tsc --noEmit -p mcp/tsconfig.json`, `npx tsc --noEmit -p ui/tsconfig.json` — exit 0, no diagnostics. `npm run preflight` — 0 warnings, 0 hard blocks. Clean MCP/UI production build succeeded; Vite reported its existing bundle-size advisory.

## Guards: broken → red → restored → green

Each command below runs from its indicated package directory with the dedicated PostgreSQL environment. Source is restored in finally before the green run. The JSON contains assertion excerpts as well as these summaries.

'''
for m in mutations:
 text+=f"### {m['guard']} — {m['file']}\n\n`{m['red']['command']}` (cwd `{m['red']['cwd']}`)\n\n"
 for label in ['red','green']:
  r=m[label];text+=f"{label.upper()} exit {r['exit']}:\n\n```text\n"+'\n'.join(r['failures']+r['summary'])+'\n```\n\n'
text+='''## Real synthetic proof

Proof 1–3: live-proof.json quotes the staff PUT, decision JSON, reload, profile edit, explicit re-pick, non-owner read-only GET/403, signed 409, and provider Put back. The feature writes only its Basic decision record. Fixture setup uses existing scope/profile/diagnosis mechanisms; it does not create an order or charge.

'''
if (directory/'live-proof.json').exists():text+='```json\n'+(directory/'live-proof.json').read_text()+'```\n\n'
text+='Proof 4: actual served clinic route in Chrome, synthetic staff identity, desktop and mobile; no component substitute. Preview images show For review and Not today with actor/time and Put back.\n\n'
if (directory/'browser-proof.json').exists():text+='```json\n'+(directory/'browser-proof.json').read_text()+'```\n\n'
text+='''## Limits and follow-ups

- Accept and orders/charges, Completed (2c): not done.
- Free-text Not today reason: not done.
- Exam board, right-panel tabs and shape record changes: not done.
- Seeded-reason wording cleanup: not done.
- Mandate 14: no new medical code, orderable, clinical interval or external FHIR URL; no ledger rows required or added.
- Decisions index: no new product decision authored; R1 already recorded by the operator in performance-od at 02da7c00. Cross-repo follow-up: independent Claude Opus 5 evaluation at final PR head.
- #647 remained open at recheck; no rebase needed. Its index changes are above this insertion.
- No outside-allowlist edit required. A concurrent preflight run saw the full suite's temporary RiskAssessment probe; the probe was removed by its existing test, then preflight passed separately. No guard or policy changed.
- Proof setup correction: bootstrap owner was unsuitable as read-only caller; created a distinct non-owner canonical Admin-policy reader. Throttled login attempts were retried after the server window, without changing production limits.
- NOT EVALUATED. Author tests, mutations, browser proof and bots are not independent acceptance.

## Final containers

'''
if (directory/'docker-ps-final.txt').exists():text+='```text\n'+(directory/'docker-ps-final.txt').read_text()+'```\n'
text+='\nneeds-review\n'
(directory/'BUNDLE.md').write_text(text)
