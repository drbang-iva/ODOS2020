from pathlib import Path
import subprocess,json,re
r=Path(__file__).resolve().parents[3]; out=r/'docs/build-log/guarantor-phones/mutations';out.mkdir(parents=True,exist_ok=True)
shared='mcp/src/clinic/patient-telecom.ts';projection='mcp/src/clinic/responsible-party-demographics.ts';engine='mcp/src/clinic/guarantor-link-operation.ts';registration='mcp/src/clinic/patient-registration-endpoint.ts';component='ui/src/components/patient/ResponsiblePartiesControl.tsx'
core='mcp/tests/guarantorPhoneContract.test.ts';recovery='mcp/tests/guarantorPhoneRecovery.test.ts';form='tests/guarantorPhoneForm.test.tsx';reg='mcp/tests/patientRegistrationAuthz.test.ts'
changes=[
('T1',shared,'const extensions = point.extension?.filter(e => e.url !== ODOS_TEXTABLE_NUMBER_EXTENSION_URL);','const extensions = point.extension;',core,'T1'),
('T2-merge',projection,'return { ...target, ...fields, extension: extension.length ? extension : undefined };','return { ...target, ...projectResponsiblePartyDemographics(source) };',core,'T2'),
('T2-component',component,'const demographics = projectResponsiblePartyDemographics;','const demographics = (person: Person) => structuredClone({ name: person.name, telecom: person.telecom, address: person.address });',form,'T2'),
('T3',projection,'const { extension: refusal, ...fields } = projectResponsiblePartyDemographics(source);','const { extension: refusal, ...fields } = projectResponsiblePartyDemographics(hasResponsiblePartyRefusal(source) ? source : { ...source, extension: target.extension });',form,'T3'),
('T4-raw',projection,'...(hasResponsiblePartyRefusal(source) ? { extension: [{ url: ODOS_NO_TEXTABLE_NUMBER_EXTENSION_URL, valueBoolean: true }] } : {})','extension: source.extension',form,'T4'),
('T4-empty',projection,'...(hasResponsiblePartyRefusal(source) ? { extension: [{ url: ODOS_NO_TEXTABLE_NUMBER_EXTENSION_URL, valueBoolean: true }] } : {})','...(hasResponsiblePartyRefusal(source) ? { extension: [{ url: ODOS_NO_TEXTABLE_NUMBER_EXTENSION_URL, valueBoolean: true }] } : ("resourceType" in source && source.resourceType === "RelatedPerson") ? { extension: [] } : {})',form,'T4'),
('T5',engine,'applyResponsiblePartyDemographics(child, destination)','{ ...child, name: destination.name, telecom: destination.telecom, address: destination.address }',recovery,'T5'),
('T6',engine,'...(hasResponsiblePartyRefusal(child) ? { noTextableNumber: true } : {})','...{}',recovery,'T6'),
('T7',registration,'JSON.parse(JSON.stringify(requestedFields)),\n    JSON.parse(JSON.stringify(committedFields)),','JSON.parse(JSON.stringify({name:requested.name,telecom:requested.telecom})),\n    JSON.parse(JSON.stringify({name:committed.name,telecom:committed.telecom})),',recovery,'T7'),
('T8',registration,'if (!existingIds.has(party.localId)) errors.push(...Object.values(validatePatientPhones(party.phones, party.textable)));','',reg,'T8'),
('T9','mcp/src/comms/suppression-gate.ts','return resource.extension?.some((entry) => entry.url === ODOS_NO_TEXTABLE_NUMBER_EXTENSION_URL && entry.valueBoolean === true) ?? false;','return resource.resourceType === "Patient" && (resource.extension?.some((entry) => entry.url === ODOS_NO_TEXTABLE_NUMBER_EXTENSION_URL && entry.valueBoolean === true) ?? false);',form,'T9'),
('T10',shared,'if (!slot) return [point];','if (!slot) return [];',form,'T10'),
('T11','data/canonical-extensions/odos-no-textable-number.json',',\n    { "type": "element", "expression": "RelatedPerson" }','',core,'T11'),
('T12',engine,'...(hasResponsiblePartyRefusal(child) ? { noTextableNumber: true } : {})','noTextableNumber: hasResponsiblePartyRefusal(child)',recovery,'T12'),
('T13',registration,'return applyResponsiblePartyDemographics({\n    resourceType: "RelatedPerson",','const target: RelatedPerson = {\n    resourceType: "RelatedPerson",',recovery,'T13'),
]
results=[]
for name,file,old,new,test,pattern in changes:
 p=r/file;original=p.read_text();assert original.count(old)==1,(name,original.count(old))
 cwd=r/'ui' if test.startswith('tests/') else r
 cmd=['node','--import','tsx','--test','--test-name-pattern='+pattern,test]
 def check(stage):
  result=subprocess.run(cmd,cwd=cwd,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
  (out/(name+'-'+stage+'.txt')).write_text(result.stdout.replace(str(r),'<worktree>'))
  return {'exit':result.returncode,'failedTests':re.findall(r'^not ok \d+ - (.*)',result.stdout,re.M),'counts':re.findall(r'^# (?:tests|pass|fail|skipped) .*',result.stdout,re.M)}
 green=check('green');assert green['exit']==0,(name,green)
 modified=original.replace(old,new)
 if name=='T13':
  tail='  }, source);'
  assert tail in modified
  modified=modified.replace(tail,'  };\n  return { ...applyResponsiblePartyDemographics(target, source), extension: target.extension };')
 try:
  p.write_text(modified);red=check('red')
 finally:p.write_text(original)
 restored=check('restored')
 row={'guard':name,'file':file,'original':old,'mutation':new,'command':cmd,'green':green,'red':red,'restored':restored};results.append(row)
 (out/'results.json').write_text(json.dumps(results,indent=2)+'\n')
 print(name,green['exit'],red['exit'],restored['exit'],red['failedTests'],flush=True)
 assert red['exit']!=0 and red['failedTests'] and restored['exit']==0,(name,row)
