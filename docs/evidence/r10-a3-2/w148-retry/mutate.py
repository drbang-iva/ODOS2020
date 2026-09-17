import json, pathlib, subprocess, sys
root = pathlib.Path(__file__).resolve().parents[4]
case = json.loads(pathlib.Path(sys.argv[1]).read_text())
p = root / case['file']; original = p.read_bytes(); source = original.decode()
count = source.count(case['anchor'])
if count != 1:
    raise SystemExit(f"ANCHOR MISS: {case['name']}: expected exactly 1 anchor, found {count} in {case['file']}")
out = pathlib.Path(__file__).resolve().parent
try:
    p.write_text(source.replace(case['anchor'], case['replacement'], 1))
    with (out / (case['name'] + '-mutation-red.tap')).open('w') as log:
        red = subprocess.run(case['command'], cwd=root / case.get('cwd','.'), stdout=log, stderr=subprocess.STDOUT).returncode
finally:
    p.write_bytes(original)
assert p.read_bytes() == original, 'RESTORATION FAILED'
with (out / (case['name'] + '-restored-green.tap')).open('w') as log:
    green = subprocess.run(case['command'], cwd=root / case.get('cwd','.'), stdout=log, stderr=subprocess.STDOUT).returncode
record={'name':case['name'],'anchorCount':count,'redExit':red,'greenExit':green,'restoredBytes':True}
(out / (case['name'] + '-mutation.json')).write_text(json.dumps(record,indent=2)+'\n')
print(json.dumps(record))
if red == 0 or green != 0: raise SystemExit('MUTATION PROOF FAILED')
