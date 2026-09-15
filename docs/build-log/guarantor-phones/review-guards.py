from pathlib import Path
import subprocess,json,re
r=Path(__file__).resolve().parents[3];out=r/'docs/build-log/guarantor-phones/review-guards';out.mkdir(exist_ok=True)
engine='mcp/src/clinic/guarantor-link-operation.ts';phone='mcp/src/clinic/patient-telecom.ts'
url=json.loads((r/'data/canonical-extensions/odos-no-textable-number.json').read_text())['url']
prefix='for (const child of verified) {\n      '
released=prefix+'const released = withExtension(child, GUARANTOR_CLAIM_URL);'
corrupt=f'withExtension(withExtension(child, GUARANTOR_CLAIM_URL), "{url}", {{url: "{url}", valueBoolean: true}})'
changes=[
('T12-final-refusal',engine,released,prefix+'const released = '+corrupt+';','mcp/tests/guarantorPhoneRecovery.test.ts','T12'),
('T5-second-corrected-child',engine,released,prefix+'const released = this.plan.kind === "correct" && child.id === "r2" ? '+corrupt+' : withExtension(child, GUARANTOR_CLAIM_URL);','mcp/tests/guarantorPhoneRecovery.test.ts','T5 consolidate'),
('T3-selected-marker',phone,'if (point === answer) return { ...point, extension: [...(extensions ?? []), { url: ODOS_TEXTABLE_NUMBER_EXTENSION_URL, valueBoolean: true }] };','if (point === answer) return { ...point, extension: extensions };','tests/guarantorPhoneForm.test.tsx','T3'),
('K7-rejected-bot-change',phone,'return { ...patient, extension: [...(otherExtensions ?? []), { url: ODOS_NO_TEXTABLE_NUMBER_EXTENSION_URL, valueBoolean: true }] };','return { ...patient, extension: [...(otherExtensions ?? []), { url: ODOS_NO_TEXTABLE_NUMBER_EXTENSION_URL, valueBoolean: true }], telecom: patient.telecom?.map(point => ({...point, extension: point.extension?.filter(e => e.url !== ODOS_TEXTABLE_NUMBER_EXTENSION_URL)})) };','tests/patientPhoneForm.test.tsx','K7:'),
]
results=[]
for name,file,old,new,test,pattern in changes:
 p=r/file;original=p.read_text();assert original.count(old)==(2 if file==engine else 1)
 cmd=['node','--import','tsx','--test','--test-name-pattern='+pattern,test]
 def check(stage):
  result=subprocess.run(cmd,cwd=r/'ui' if test.startswith('tests/') else r,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
  (out/(name+'-'+stage+'.txt')).write_text('\n'.join(x.rstrip() for x in result.stdout.replace(str(r),'<worktree>').splitlines())+'\n')
  return {'exit':result.returncode,'failedTests':re.findall(r'^not ok \d+ - (.*)',result.stdout,re.M)}
 green=check('green')
 try:p.write_text(original.replace(old,new));red=check('red')
 finally:p.write_text(original)
 restored=check('restored')
 row=dict(guard=name,file=file,original=old,mutation=new,command=cmd,green=green,red=red,restored=restored);results.append(row)
 (out/'results.json').write_text(json.dumps(results,indent=2)+'\n')
 print(name,green,red,restored)
 assert green['exit']==0 and red['exit']==1 and red['failedTests'] and restored['exit']==0
