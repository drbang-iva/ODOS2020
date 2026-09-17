from pathlib import Path
import subprocess, hashlib, json
root=Path.cwd();source=root/'ui/src/components/charting/OcularHealthSection.tsx';out=root/'docs/evidence/r10-a3-2/frozen-scope';original=source.read_bytes();text=original.decode()
mutants=[
 ('template-as-recorded', '<p>{capture.negativeAct.assertedAt}', '<p>{normalTemplate}', 'V21 V22 a saved negative scope stays frozen after the live normal template changes'),
 ('refresh-replaces-frozen-scope','        const hydrated = Object.fromEntries(rows.map(([stableKey, , capture]) => [stableKey, capture]));','        if (reloadVersion > 0) for (const [, , capture] of rows) for (const eye of EYES) if (capture[eye].negativeAct) capture[eye].negativeAct = { ...capture[eye].negativeAct!, optionCodes: [] };\n        const hydrated = Object.fromEntries(rows.map(([stableKey, , capture]) => [stableKey, capture]));','V21 V22 posterior re-save stays pristine, round-trips selections, and preserves the saved negative scope')]
results=[]
for name,anchor,replacement,test in mutants:
 assert text.count(anchor)==1, f'LOUD ANCHOR FAILURE {name}: expected 1 got {text.count(anchor)}'
 print(f'{name}: exact anchor count 1',flush=True)
 command=['node','--import','tsx','--test',f'--test-name-pattern={test}','tests/customSections.test.tsx']
 try:
  source.write_text(text.replace(anchor,replacement))
  with (out/f'{name}-red.log').open('w') as log:red=subprocess.run(command,cwd=root/'ui',stdout=log,stderr=subprocess.STDOUT)
 finally:source.write_bytes(original)
 assert source.read_bytes()==original,'LOUD RESTORE FAILURE'
 with (out/f'{name}-restored.log').open('w') as log:green=subprocess.run(command,cwd=root/'ui',stdout=log,stderr=subprocess.STDOUT)
 results.append({'mutant':name,'mapping':'V21 / V22 / W-k','test':test,'anchorCount':1,'command':command,'redExit':red.returncode,'restoredExit':green.returncode,'restoredSha256':hashlib.sha256(source.read_bytes()).hexdigest()})
 assert red.returncode!=0,f'LOUD MUTANT SURVIVED {name}'
 assert green.returncode==0,f'LOUD RESTORED FAILURE {name}'
(out/'results.json').write_text(json.dumps({'originalSha256':hashlib.sha256(original).hexdigest(),'mutations':results},indent=2)+'\n')
print(json.dumps(results),flush=True)
