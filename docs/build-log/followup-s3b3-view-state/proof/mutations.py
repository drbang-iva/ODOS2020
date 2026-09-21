import json, re, subprocess, shlex
from pathlib import Path

root = Path(__file__).resolve().parents[4]
store = 'mcp/src/clinical-graph/exam-view-state-store.ts'
view = 'ui/src/lib/exam-view-state.ts'
scene = 'ui/src/scenes/EncounterCharting.tsx'
board = 'ui/src/components/charting/ExamOverviewBoard.tsx'
scope = 'mcp/src/clinical-graph/exam-scope-store.ts'

def replace(source, old, new):
    assert source.count(old) == 1, (old, source.count(old))
    return source.replace(old, new)

mutations = [
 ('G1', store, lambda s: s.replace('constructor(private readonly fhir:', 'private readonly clientKey = Math.random().toString();\n  constructor(private readonly fhir:').replace('${VIEW_SYSTEM}|${encounterId}', '${VIEW_SYSTEM}|${encounterId}:${this.clientKey}').replace('value: encounterId }', 'value: `${encounterId}:${this.clientKey}` }'), 'mcp', 'tests/examViewStateStore.test.ts', 'S3b3 G1'),
 ('G2', store, lambda s: s.replace('urn:odos:encounter-exam-view-state', 'urn:odos:encounter-exam-scope').replace('"exam-view-state"', '"exam-scope"'), 'mcp', 'tests/examViewStateStore.test.ts', 'S3b3 G2'),
 ('G3', board, lambda s: replace(s, 'if (shelved.has(editor.id)) return data !== false || editor.id === activeEditorId;', 'if (shelved.has(editor.id)) return false;'), 'ui', 'tests/examViewState.test.tsx', 'S3b3 G3'),
 ('G4', view, lambda s: replace(s, '  } catch {\n    return empty();\n  }', '  } catch (error) {\n    throw error;\n  }'), 'ui', 'tests/examViewState.test.tsx', 'S3b3 G4'),
 ('G5', scene, lambda s: replace(s, '  const { state: activeExamView, change: changeExamView } = useExamViewState(encounterId);', '''  const viewRequest = useMemo(() => (async (...args: Parameters<typeof fetch>) => {
    try { return await fetch(...args); } catch (error) {
      if (args[1]?.method === "PUT") setSectionGroupError("View state could not be saved.");
      throw error;
    }
  }) as typeof fetch, []);
  const { state: activeExamView, change: changeExamView } = useExamViewState(encounterId, viewRequest);'''), 'ui', 'tests/examViewStateServer.test.tsx', 'S3b3 G5'),
 ('G6', view, lambda s: replace(s, 'timer = setTimeout(() => { void flush(); }, 300);', 'void flush();'), 'ui', 'tests/examViewStateServer.test.tsx', 'S3b3 G6'),
 ('G7', store, lambda s: replace(s, '''const persisted = await this.fhir.create(resource, {
      "If-None-Exist": new URLSearchParams({ identifier: `${VIEW_SYSTEM}|${encounterId}` }).toString(),
    });''', 'const persisted = await this.fhir.create(resource);'), 'mcp', 'tests/examViewStateStore.test.ts', 'S3b3 G7'),
 ('G8', view, lambda s: replace(s, '    await request(url(encounterId), {', '    window.localStorage.setItem(`odos:exam-view:v1:${encounterId}`, JSON.stringify(state));\n    await request(url(encounterId), {'), 'ui', 'tests/examViewStateServer.test.tsx', 'S3b3 G8'),
 ('G9', scope, lambda s: replace(s, '    if (existing) return parseScope(existing);', ''), 'ui', 'tests/examOverviewBoard.test.tsx ../mcp/tests/examShapeRecord.test.ts ../mcp/tests/examOverviewEndpoint.test.ts', 'S3b1 G1|S3b2 G1|S3b1 G2 legacy|bookkeeping|unconfirmed shape'),
]
results = []
for guard, file, mutate, cwd, testfile, pattern in mutations:
    path = root / file
    original = path.read_bytes()
    command = ['node', '--import', 'tsx', '--test', f'--test-name-pattern={pattern}', *testfile.split()]
    def run():
        p = subprocess.run(command, cwd=root/cwd, text=True, capture_output=True)
        lines = [line for line in (p.stdout+'\n'+p.stderr).splitlines() if re.match(r'^(not ok |ok |# (tests|pass|fail|skipped|cancelled) |  error:|  expected:|  actual:)', line)]
        return {'exit': p.returncode, 'summary': lines}
    try:
        path.write_text(mutate(original.decode()))
        red = run()
    finally:
        path.write_bytes(original)
    assert path.read_bytes() == original
    green = run()
    result = {'guard': guard, 'mutationFile': file, 'command': f'cd {cwd} && '+shlex.join(command), 'red': red, 'green': green, 'byteRestored': True}
    if file in [scope, board]:
        result['restoredDiff'] = subprocess.check_output(['git', 'diff', '--', file], cwd=root, text=True)
        assert result['restoredDiff'] == ''
    results.append(result)
    (root/'docs/build-log/followup-s3b3-view-state/mutations.json').write_text(json.dumps(results, indent=2)+'\n')
    print(guard, 'red', red['exit'], 'green', green['exit'], flush=True)
    assert red['exit'] != 0 and green['exit'] == 0, result
