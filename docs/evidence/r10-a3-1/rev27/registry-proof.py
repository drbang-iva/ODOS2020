import json,subprocess,pathlib,re
root=pathlib.Path.cwd(); out=root/'docs/evidence/r10-a3-1/rev27'; p=root/'data/canonical-extensions/registry.json'; original=p.read_bytes(); rows=[]
try:
 for name in ['carry-plan','carry-versions']:
  url='https://odos2020.com/fhir/StructureDefinition/'+name
  data=json.loads(original); found=[e for e in data['extensions'] if e['url']==url]
  assert len(found)==1, 'ANCHOR MISS: '+url
  data['extensions']=[e for e in data['extensions'] if e['url']!=url]
  p.write_text(json.dumps(data,indent=2)+'\n')
  r=subprocess.run(['npm','run','preflight'],capture_output=True,text=True)
  report=json.loads((root/'.odos/preflight-report.json').read_text())
  findings=[f for ps in report['passes'] for f in ps['findings'] if f['code']=='odos-extension-url-shape']
  for f in findings:
   f['sourceLine']=(root/f['source']).read_text().splitlines()[f['line']-1]
  assert r.returncode!=0 and len(findings)==1 and url in findings[0]['sourceLine'], 'RED DID NOT NAME TARGET: '+url
  (out/(name+'-red.txt')).write_text(r.stdout+r.stderr+'\n'+json.dumps(findings,indent=2)+'\n')
  p.write_bytes(original)
  g=subprocess.run(['npm','run','preflight'],capture_output=True,text=True)
  (out/(name+'-green.txt')).write_text(g.stdout+g.stderr)
  assert g.returncode==0, 'GREEN FAILED: '+name
  rows.append({'url':url,'redExit':r.returncode,'greenExit':g.returncode,'finding':findings[0],'restoredByteIdentical':p.read_bytes()==original})
finally:p.write_bytes(original)
(out/'registry-guards.json').write_text(json.dumps(rows,indent=2)+'\n')
print(json.dumps(rows,indent=2))
