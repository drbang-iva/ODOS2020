from pathlib import Path
import subprocess, os, json
root = Path(__file__).resolve().parents[3]
evidence = Path(__file__).resolve().parent
source = root / 'mcp/src/clinical-graph/diagnosis-visit-status-store.ts'
original = source.read_text()
results = []
try:
    for phase in ['broken', 'restored']:
        database = 'dx_newness_guard_' + phase
        subprocess.run(['docker', 'exec', 'odos-dx-newness-proof', 'createdb', '-U', 'postgres', database], check=True)
        source.write_text(original.replace('[STATUS_SCHEMA_FILE, NEWNESS_SCHEMA_FILE]', '[STATUS_SCHEMA_FILE]') if phase == 'broken' else original)
        env = dict(os.environ, ODOS_NEWNESS_TEST_POSTGRES='postgres://postgres:synthetic-dx-proof@127.0.0.1:19972/' + database)
        result = subprocess.run(['node', '--import', 'tsx', '--test', '--test-name-pattern=Postgres migration', 'tests/diagnosisNewness.test.ts'], cwd=root/'mcp', env=env, text=True, capture_output=True)
        (evidence / ('migration-entry-' + phase + '.tap')).write_text(result.stdout + result.stderr)
        results.append({'phase': phase, 'exit': result.returncode})
        assert (result.returncode != 0) if phase == 'broken' else (result.returncode == 0)
finally:
    source.write_text(original)
(evidence/'migration-guard.json').write_text(json.dumps(results, indent=2)+'\n')
print(json.dumps(results))
