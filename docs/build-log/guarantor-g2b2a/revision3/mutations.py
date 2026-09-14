from pathlib import Path
import subprocess,json,re
root=Path(__file__).resolve().parents[4]
out=Path(__file__).resolve().parent
search='mcp/src/clinic/guarantor-search.ts';engine='mcp/src/clinic/guarantor-link-operation.ts';ui='ui/src/components/patient/GuarantorLinkScreens.tsx'
check='  if (!staffHasBusinessAction(staff, "guarantor.link")) return { status: 403, body: { error: "guarantor.link action required." } };\n'
constructor='    if (!staffHasBusinessAction(staff, "guarantor.link")) throw new Refusal(403, "guarantor.link action required.");\n'
pause='if(e instanceof GuarantorScreenError&&e.status===409&&e.body?.task){setReview(false);try{await onReload();reset();setHistory(undefined);setHistoryOpen(false);}catch{setReloadRequired(true);setNotice("The paused operation could not be reloaded. Reload the patient page before continuing.");}return;}'
cases=[('K6-search',search,check,0),('K6-create',search,check,1),('K6-draft-history',engine,constructor,0),('K15-paused',ui,pause,0),('K15-reload-failure',ui,'setReloadRequired(true);',0)]
results=[]
for name,path,needle,index in cases:
 p=root/path;original=p.read_text();positions=[m.start() for m in re.finditer(re.escape(needle),original)];assert len(positions)>index
 at=positions[index];broken=original[:at]+original[at+len(needle):]
 front=path==ui;cmd=['node','--import','tsx','--test','tests/guarantorSearchScreens.test.tsx' if front else 'mcp/tests/guarantorSearchScreens.test.ts']
 row={'guard':name}
 try:
  for phase in ['green','red','restored']:
   p.write_text(broken if phase=='red' else original)
   r=subprocess.run(cmd,cwd=root/'ui' if front else root,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
   text=r.stdout.replace(str(root)+'/', '')
   (out/f'{name}-{phase}.tap').write_text('\n'.join(line.rstrip() for line in text.splitlines())+'\n')
   row[phase]=r.returncode
   if phase=='red':row['failingTests']=re.findall(r'^not ok .*$',text,re.M)
   assert r.returncode==(1 if phase=='red' else 0),(name,phase)
 finally:p.write_text(original)
 results.append(row);print(json.dumps(row),flush=True)
(out/'mutation-results.json').write_text(json.dumps(results,indent=2)+'\n')
