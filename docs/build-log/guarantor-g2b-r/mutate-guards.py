import hashlib
import json
from pathlib import Path
import re
import subprocess

root = Path(__file__).resolve().parents[3]
evidence = Path(__file__).resolve().parent
engine = root / 'mcp/src/clinic/guarantor-link-operation.ts'
screen = root / 'ui/src/components/patient/GuarantorLinkScreens.tsx'
link_projection = 'owned = { link: [...new Set((person.link ?? []).map(link => link.target.reference ?? ""))].sort(), active: person.active };'
admission = '      if (corrections.some(task => operation.trusted(task) && task.status === "in-progress" && task.basedOn?.some(r => r.reference === `Task/${original.id}`) && readPlan(task).kind === "correct")) throw new Refusal(409, "A correction of this operation is already in progress.");'
cases = [
    ('R1', engine, 'if (!intentMatches(fresh, intent))', 'if (guarantorContentHash(fresh) !== intent.intendedContentHash)', 'mcp', '^R1'),
    ('R2', engine, 'else if (intentMatches(child, intent))', 'else if (intent.phase === "releasing" ? guarantorContentHash(child) === intent.intendedContentHash : intentMatches(child, intent))', 'mcp', '^R2'),
    ('R3', engine, link_projection, 'owned = { active: person.active };', 'mcp', '^R3'),
    ('R4', engine, ': guarantorContentHash(resource) === intent.intendedContentHash;', ': true;', 'mcp', '^R4'),
    ('R5', engine, link_projection, 'owned = { link: [...new Set((person.link ?? []).map(link => link.target.reference ?? ""))].sort() };', 'mcp', '^R5'),
    ('R6', engine, admission, '', 'mcp', '^R6: second'),
    ('R6-UI', screen, '&&!op.correctionInProgress&&<>', '&&<>', 'ui', '^R6 UI'),
]
records = []

def run_case(label, state, package, pattern):
    test_file = 'tests/guarantorOwnedRecovery.test.ts' if package == 'mcp' else 'tests/guarantorRecoveryHistory.test.tsx'
    command = ['node', '--import', 'tsx', '--test', '--test-name-pattern=' + pattern, test_file]
    result = subprocess.run(command, cwd=root / package, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    output = result.stdout.replace('file://' + str(root) + '/', '').replace(str(root) + '/', '')
    (evidence / f'{label}-{state}.tap').write_text(output)
    return {'command': command, 'cwd': package, 'exitCode': result.returncode,
            'counts': dict(re.findall(r'^# (tests|pass|fail|skipped) (\d+)$', output, re.M)),
            'failingTests': re.findall(r'^not ok \d+ - (.*)$', output, re.M)}

for label, path, before, after, package, pattern in cases:
    original = path.read_text()
    assert original.count(before) == 1, f'{label}: mutation anchor must match exactly once'
    green = run_case(label, 'green', package, pattern)
    assert green['exitCode'] == 0, (label, green)
    mutant = original.replace(before, after)
    record = {'guard': label, 'file': str(path.relative_to(root)), 'before': before, 'after': after,
              'sourceSha256': hashlib.sha256(original.encode()).hexdigest(), 'green': green}
    try:
        path.write_text(mutant)
        assert path.read_text() == mutant and mutant != original
        record['mutantSha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
        record['red'] = run_case(label, 'red', package, pattern)
    finally:
        path.write_text(original)
        assert hashlib.sha256(path.read_bytes()).hexdigest() == record['sourceSha256']
    record['restored'] = run_case(label, 'restored', package, pattern)
    records.append(record)
    (evidence / 'mutations.json').write_text(json.dumps(records, indent=2) + '\n')
    print(json.dumps({'guard': label, 'green': green['counts'], 'red': record['red']['counts'], 'failingTests': record['red']['failingTests'], 'restored': record['restored']['counts']}), flush=True)
    assert record['red']['exitCode'] != 0 and record['red']['failingTests'], (label, 'mutation survived')
    assert record['restored']['exitCode'] == 0, (label, 'restored run failed')
