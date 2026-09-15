from pathlib import Path
import subprocess
base=Path.cwd()
cases=[('pending-deletion','mcp/src/clinical-graph/plan-sets/glaucoma.ts',"new Set(['corneal-hysteresis','erg'","new Set(['erg'"),('severe-resolver-removal','mcp/src/clinical-graph/diagnosis-dx-key-resolver.ts','ledgerFamilies.flatMap((family) =>','ledgerFamilies.filter(family => family !== "H40.11-severe").flatMap((family) =>'),('hidden-test-emitted','mcp/src/clinical-graph/plan-sets/generator.ts','if (!orderableKeys.has(t.orderable)) {','if (false) {'),('placeholder-handout-emitted','mcp/src/clinical-graph/plan-sets/generator.ts',' || urls.some(url => new URL(url).hostname === catalog.placeholderUrlHost)','')]
for name,path,old,new in cases:
 p=Path(path);original=p.read_text();assert old in original,name
 try:
  p.write_text(original.replace(old,new,1))
  r=subprocess.run(['node','--import','./mcp/node_modules/tsx/dist/loader.mjs','--test','mcp/src/__tests__/plan-set-generator.test.ts'],capture_output=True,text=True)
  Path(f'outputs/plan-authoring/mutation-{name}.log').write_text(r.stdout+r.stderr)
  print(name,r.returncode)
  assert r.returncode != 0, name+' survived'
 finally:p.write_text(original)
r=subprocess.run(['node','--import','./mcp/node_modules/tsx/dist/loader.mjs','--test','mcp/src/__tests__/plan-set-generator.test.ts'],capture_output=True,text=True)
Path('outputs/plan-authoring/generator-restored.log').write_text(r.stdout+r.stderr)
print('restored',r.returncode)
assert r.returncode==0
