from pathlib import Path
import subprocess
import re

root = Path.cwd()
out = root / 'docs/build-log/followup-s2a-exam-scope/proof/guards'
out.mkdir(exist_ok=True)
endpoint = 'mcp/src/clinical-graph/exam-overview-endpoint.ts'
projection = 'mcp/src/clinical-graph/exam-overview-projection.ts'
store = 'mcp/src/clinical-graph/exam-scope-store.ts'
board = 'ui/src/components/charting/ExamOverviewBoard.tsx'
scene = 'ui/src/scenes/EncounterCharting.tsx'
server = ['node', '--import', 'tsx', '--test', 'mcp/tests/examOverviewEndpoint.test.ts', 'mcp/tests/examOverviewProjection.test.ts', 'mcp/tests/examScopeStore.test.ts']
ui = ['node', '--import', 'tsx', '--test', 'ui/tests/examOverviewBoard.test.tsx']
category_import = 'import { resolveVisitTypeCategoryForEncounter } from "../clinic/clinic-summary.js";\n'
category_change = ('examScope: scope.examScope,', 'examScope: (await resolveVisitTypeCategoryForEncounter(encounter, undefined, serviceFhir)) === "exams" ? "comprehensive" : "unknown",')
mutations = [
 ('G1', endpoint, [category_change], server, category_import),
 ('G2', endpoint, [('new FhirEncounterExamScopeStore(serviceFhir).get(encounterId)', 'Promise.resolve({ examScope: "comprehensive" })')], server, ''),
 ('G3', store, [('resource ? parseScope(resource) : { examScope: "comprehensive" }', 'resource ? parseScope(resource) : { examScope: "office-visit" }')], server, ''),
 ('G4', board, [('|| traceRows.length > 0 || groups.length > 0', '|| traceRows.length > 0')], ui, ''),
 ('G5', scene, [('onExamScopeChanged={refreshExamOverview}', 'onExamScopeChanged={() => { setVisitCharge(undefined); refreshExamOverview(); }}')], ui, ''),
 ('G6-row', board, [("Not required for this exam's scope", 'Not required for this visit type')], ui, ''),
 ('G6-trace', board, [("This count is relative to this exam's scope and is not a billing-code check.", 'This count is relative to the visit type and is not a billing-code check.')], ui, ''),
 ('G7', endpoint, [category_change], server, category_import),
 ('G8', scene, [('{!activeExamOverviewProjection && (', '{!activeExamOverviewProjection && examOverviewProjection?.examScope === "comprehensive" && (')], ui, ''),
 ('store-version', store, [('if ((existing?.meta?.versionId ?? null) !== expectedVersion) throw concurrentEdit();', '')], server, ''),
 ('store-create', store, [('if (result.examScope !== examScope || result.setAt !== setAt || result.setBy?.reference !== setBy.reference) throw concurrentEdit();', '')], server, ''),
]
def run(command, target):
 result = subprocess.run(command, capture_output=True, text=True)
 lines = (result.stdout + result.stderr).splitlines()
 summary = ['Command: ' + ' '.join(command), 'Exit: ' + str(result.returncode)]
 summary += [line.replace(str(root), '.') for line in lines if re.match(r'^(not ok |# (tests|pass|fail|cancelled|skipped|todo) )', line)]
 target.write_text('\n'.join(summary) + '\n')
 return result.returncode
for name, filename, replacements, command, prefix in mutations:
 path = root / filename
 original = path.read_text()
 mutated = original
 for before, after in replacements:
  assert before in mutated, (name, before)
  mutated = mutated.replace(before, after, 1)
 try:
  path.write_text(prefix + mutated)
  assert run(command, out / f'{name}-red.txt') != 0, name + ' survived mutation'
 finally:
  path.write_text(original)
 assert run(command, out / f'{name}-green.txt') == 0, name + ' failed after restoration'
 print(name + ': red then restored green', flush=True)
