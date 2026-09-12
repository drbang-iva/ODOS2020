"""Run sequential J guards in this task worktree; always restore exact file bytes."""
import json
import re
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[3]
out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('/tmp/odos-item1bi-mutations')
out.mkdir(parents=True, exist_ok=True)
gate = root / 'mcp/src/comms/suppression-gate.ts'
config = root / 'mcp/src/comms/comms-config.ts'
api = root / 'mcp/src/comms/comms-api.ts'
registry = root / 'data/canonical-extensions/registry.json'
originals = {p: p.read_text() for p in [gate, config, api, registry]}
marker = '''    active.find((point) => point.extension?.some((entry) =>
      entry.url === ODOS_TEXTABLE_NUMBER_EXTENSION_URL && entry.valueBoolean === true))
    ?? preferredPhoneCandidate(active)'''

def replace(path, old, new):
    source = originals[path]
    assert source.count(old) == 1, (path, old, source.count(old))
    path.write_text(source.replace(old, new, 1))

def run(label, testfile, pattern):
    cmd = ['node', '--import', 'tsx', '--test', '--test-name-pattern='+pattern, 'mcp/tests/'+testfile+'.test.ts']
    result = subprocess.run(cmd, cwd=root, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    (out/(label+'.log')).write_text(result.stdout)
    counts = {key: int(re.search(r'^# '+key+r' (\d+)$', result.stdout, re.M)[1]) for key in ['tests', 'pass', 'fail']}
    return {'exit': result.returncode, **counts}

def early_marker():
    replace(gate, 'const active = activePhoneCandidates(resource, now);', 'const active = resource.telecom ?? [];')

def delete_registry():
    data = json.loads(originals[registry])
    data['extensions'] = [e for e in data['extensions'] if e['sliceConsumer'] != 'item-1b-i']
    registry.write_text(json.dumps(data, indent=2)+'\n')

cases = [
 ('J1', 'commsSuppression', 'J1:', lambda: replace(gate, marker, '    preferredPhoneCandidate(active)')),
 ('J2', 'commsSuppression', 'J2:', lambda: replace(gate, 'entry.url === ODOS_TEXTABLE_NUMBER_EXTENSION_URL && entry.valueBoolean === true', 'entry.url === ODOS_TEXTABLE_NUMBER_EXTENSION_URL')),
 ('J3', 'commsSuppression', 'J3:', lambda: replace(gate, 'return hasNoTextableNumber(resource) ? undefined : resolveSmsHistoryNumber(resource, now);', 'return resolveSmsHistoryNumber(resource, now);')),
 ('J4', 'commsSuppression', 'J4:', early_marker),
 ('J5', 'commsSuppression', 'J5:', early_marker),
 ('J6', 'commsSuppression', 'J6:', early_marker),
 ('J7', 'commsSuppression', 'J7:', lambda: replace(gate, 'return preferredPhoneCandidate(activePhoneCandidates(resource, now))?.value?.trim();', 'return resolveSmsHistoryNumber(resource, now);')),
 ('J8', 'commsSuppression', 'J8:', lambda: replace(gate, '?? preferredPhoneCandidate(active)', '?? undefined')),
 ('J9', 'commsSuppression', 'J9:', lambda: replace(gate, 'return active.find((point) => point.system === "sms")\n    ?? active.find((point) => point.use === "mobile")', 'return active.find((point) => point.use === "mobile")')),
 ('J10', 'commsProfileBindings', 'J10:', delete_registry),
 ('J12', 'commsApi', 'J12:', lambda: replace(api, 'if (system === "phone") return resolveSmsNumber(resource, now);', 'if (system === "phone") return resource.telecom?.find(point => point.extension?.some(entry => entry.url === "https://odos2020.com/fhir/StructureDefinition/odos-textable-number" && entry.valueBoolean === true))?.value ?? resolveSmsNumber(resource, now);')),
 ('J13', 'commsConfig', 'J13', lambda: replace(config, 'new Date(), resolveSmsHistoryNumber)', 'new Date(), resolveVoiceNumber)')),
 ('J14', 'commsConfig', 'J14|H8 / FB1', lambda: replace(config, 'new Date(), resolveSmsHistoryNumber)', 'new Date(), resolveSmsNumber)')),
]
results = []
try:
    for guard, testfile, pattern, mutate in cases:
        try:
            mutate()
            if guard == 'J13':
                config.write_text(config.read_text().replace('  resolveSmsHistoryNumber,', '  resolveSmsHistoryNumber,\n  resolveVoiceNumber,'))
            red = run(guard+'-red', testfile, pattern)
        finally:
            for path, text in originals.items(): path.write_text(text)
        green = run(guard+'-green', testfile, pattern)
        row = {'guard':guard, 'red':red, 'green':green}
        results.append(row)
        (out/'results.json').write_text(json.dumps(results, indent=2)+'\n')
        print(json.dumps(row), flush=True)
        assert red['exit'] != 0 and red['fail'] > 0, (guard, 'mutation survived')
        assert green['exit'] == 0 and green['fail'] == 0, (guard, 'restore failed')
finally:
    for path, text in originals.items(): path.write_text(text)
