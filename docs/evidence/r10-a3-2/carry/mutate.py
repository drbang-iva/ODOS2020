from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[4]
evidence = Path(__file__).resolve().parent
source_path = root / 'ui/src/components/charting/PreviousExams.tsx'
source = source_path.read_text()
mutations = [
    ('W142-new-command', 'previous && !previous.complete && action !== "replan" ? previous.request : {', 'false ? previous!.request : {', 'W142'),
    ('W143-no-reload', 'if (action === "replan") {', 'if (false && action === "replan") {', 'W143'),
    ('W143-no-replan', '...(action === "replan" ? { replan: true } : {}),', '...(action === "replan" ? { replan: false } : {}),', 'W143'),
    ('W143-old-command', 'commandId: crypto.randomUUID(),', 'commandId: previous?.request.commandId ?? crypto.randomUUID(),', 'W143'),
    ('W145-ignore-count', 'setUnscopedCount(current => Math.max(current, page.unscopedCount ?? 0));', 'setUnscopedCount(0);', 'W145'),
]
try:
    for name, anchor, replacement, pattern in mutations:
        assert source.count(anchor) == 1, f'ANCHOR COUNT {name}: {source.count(anchor)}'
        source_path.write_text(source.replace(anchor, replacement))
        result = subprocess.run(['node', '--import', 'tsx', '--test', f'--test-name-pattern={pattern}', 'tests/diagnosisCarryForward.test.tsx'], cwd=root/'ui', text=True, capture_output=True)
        (evidence/f'{name}.log').write_text(result.stdout + result.stderr)
        assert result.returncode != 0, f'MUTATION SURVIVED: {name}'
        print(name, 'RED', result.returncode)
        source_path.write_text(source)
finally:
    source_path.write_text(source)
assert source_path.read_text() == source
result = subprocess.run(['node', '--import', 'tsx', '--test', 'tests/diagnosisCarryForward.test.tsx'], cwd=root/'ui', text=True, capture_output=True)
(evidence/'restored-green.tap').write_text(result.stdout + result.stderr)
assert result.returncode == 0
print('RESTORED GREEN')
