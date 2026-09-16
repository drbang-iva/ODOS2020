from pathlib import Path
import sys, subprocess, difflib, json, re

root = Path(sys.argv[1]).resolve()
evidence = Path(sys.argv[2]).resolve()
evidence.mkdir(parents=True, exist_ok=True)
search = 'mcp/src/clinic/guarantor-search.ts'
engine = 'mcp/src/clinic/guarantor-link-operation.ts'
ui = 'ui/src/components/patient/GuarantorLinkScreens.tsx'
mutants = [
 ('O1',search,'&& !person.link?.length','',r'O1 '),
 ('O2',search,'person.active !== false && ','',r'O2 '),
 ('O3',search,'&& !referenced.has(`Person/${person.id}`)','',r'O3 '),
 ('O4',search,'if (!unusedPerson(person, project, referenced) || person.meta?.versionId !== parsed.data.expectedVersion)','if (person.meta?.versionId !== parsed.data.expectedVersion)',r'O4 '),
 ('O5-fields',search,'resource: { ...person, active: false }','resource: { ...person, active: false, name: [] }',r'O5 '),
 ('O5-audit',search,'await deps.recordAudit(buildOdosAuditEventRow','await Promise.resolve(buildOdosAuditEventRow',r'O5 '),
 ('O5-version',search,', ifMatch: `W/"${person.meta.versionId}"`','',r'O5 '),
 ('O6',search,'if (error instanceof FhirSearchLimitError || error instanceof FhirSearchPageLimitError) return searchRefused;','if (error instanceof FhirSearchLimitError || error instanceof FhirSearchPageLimitError) return {status:200,body:[]};',r'O6 '),
 ('O7',search,'if (!staffHasBusinessAction(staff, "guarantor.link"))','if (false)',r'O7 '),
 ('O9',engine,'if (loaded.destination!.active === false) throw new Refusal(422, "Destination guarantor is inactive.");','',r'O9 '),
 ('O9-registration','mcp/src/clinic/responsible-party-demographics.ts','&& person.active !== false','',r'O9 '),
 ('X1',engine,'if (this.plan.kind !== "correct" && destination.active === false) await this.pause("destination-inactive", reference(destination));','',r'X1 '),
 ('X1-plus',engine,'await this.pause("destination-inactive", reference(destination));','throw new Paused("destination-inactive", reference(destination));',r'X1 '),
 ('X2',search,', ifMatch: `W/"${person.meta.versionId}"`','',r'X2 '),
 ('X4',engine,'if (loaded.destination!.active === false) throw new Refusal(422, "Destination guarantor is inactive.");','',r'X4 '),
 ('X5',engine,'this.plan.kind !== "correct" && destination.active === false','destination.active === false',r'O2b '),
 ('X7',engine,'await this.refuseInactiveDestination(destination);','',r'X7 '),
 ('O11',search,', status: "in-progress"','',r'O15 .* undone-before-link'),
 ('O12',search,', status: "in-progress"','',r'O12 '),
 ('O14',search,'console.warn("Guarantor discard secondary audit failed; write-level audit retained.", error);','throw error;',r'O14 '),
 ('O15',engine,'...(!link.length ? { active: false } : {})','',r'O15 '),
 ('O8',ui,'if(created)await discardGuarantor(created.personId,{reason:"Create new guarantor cancelled before confirming",expectedVersion:created.versionId});','',None),
 ('U1',ui,'textable || "no textable number selected"','"no textable number selected"',None),
 ('U2',ui,'setLast("");setFirst("");setPhone("");','',None),
]
inventory='scripts/fhir-read-grant-check.ts'
entry=next(line for line in (root/inventory).read_text().splitlines(True) if 'Unused guarantor discard is version-conditional' in line)
mutants.append(('service-inventory',inventory,entry,'',None))
summary=[]
assert subprocess.check_output(['git','status','--porcelain'],cwd=root,text=True)==''
for label,path,old,new,pattern in mutants:
 file=root/path
 original=file.read_text()
 assert old in original,(label,old)
 test='mcp/tests/guarantorRegistrationAttach.test.ts' if label in ['X4','O9-registration'] else 'mcp/tests/guarantorUnused.test.ts'
 command=['node','--import','tsx','--test',f'--test-name-pattern={pattern}',test]
 cwd=root
 if path==ui:
  command=['node','--import','tsx','--test','tests/guarantorSearchScreens.test.tsx','tests/unusedGuarantorsSettings.test.tsx']
  cwd=root/'ui'
 if label=='service-inventory':command=['node','--import','tsx',inventory]
 def run(state):
  result=subprocess.run(command,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,cwd=cwd)
  output=result.stdout.replace(str(root),'<repo>')
  (evidence/f'{label}-{state}.txt').write_text('cwd: '+('ui' if cwd!=root else '.')+'\n$ '+' '.join(command)+'\n'+output+f'\nExit: {result.returncode}\n')
  counts={name:int(count) for name,count in re.findall(r'^# (tests|pass|fail|skipped) (\d+)$',output,re.M)}
  return {'exit':result.returncode,**counts}
 green=run('green');assert green['exit']==0,(label,green)
 mutated=original.replace(old,new)
 (evidence/f'{label}-mutant.diff').write_text(''.join(difflib.unified_diff(original.splitlines(True),mutated.splitlines(True),fromfile=path,tofile=path)))
 try:
  file.write_text(mutated)
  assert file.read_text()==mutated and mutated!=original
  red=run('red')
 finally:file.write_text(original)
 assert subprocess.check_output(['git','status','--porcelain'],cwd=root,text=True)==''
 restored=run('restored')
 summary.append({'guard':label,'green':green,'red':red,'restored':restored,'restoredTreeClean':True})
 print(json.dumps(summary[-1]),flush=True)
 (evidence/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
 assert red['exit']!=0 and restored['exit']==0,label
