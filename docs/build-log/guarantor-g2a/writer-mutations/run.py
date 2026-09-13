from pathlib import Path
import subprocess,json,tempfile,shutil,os
repo=Path(__file__).resolve().parents[4]
output=Path(__file__).resolve().parent
scratch=Path(tempfile.mkdtemp(prefix="odos-guarantor-mutations-"))
(scratch/'ui/src/lib').mkdir(parents=True)
(scratch/'ui/tests').mkdir(parents=True)
(scratch/'ui/node_modules').symlink_to(repo/'ui/node_modules',target_is_directory=True)
(scratch/'mcp').symlink_to(repo/'mcp',target_is_directory=True)
for name in ['fhir.ts','guarantor-editor.ts']:
 shutil.copyfile(repo/'ui/src/lib'/name,scratch/'ui/src/lib'/name)
shutil.copyfile(repo/'ui/tests/guarantorPropagation.test.tsx',scratch/'ui/tests/guarantorPropagation.test.tsx')
shutil.copyfile(repo/'ui/package.json',scratch/'ui/package.json')
os.chdir(scratch/'ui')
p=Path('src/lib/guarantor-editor.ts'); original=p.read_text()
mutations=[
('Q9c-status','status: superseded ? "superseded" : !writes.size','status: !writes.size','Q9c'),
('Q2','for (const item of snapshot.children) writes.set(item.resource.id!, await writeChild(item, accepted));','for (const item of []) writes.set(item.resource.id!, await writeChild(item, accepted));','Q2 fresh'),
('Q6a','if (version(current.person) !== version(snapshot.person) ||','if (false && (version(current.person) !== version(snapshot.person) ||','Q6a independently'),
('Q10','export async function saveGuarantor(snapshot: GuarantorSnapshot, demographics: GuarantorDemographics): Promise<GuarantorResult> {','export async function saveGuarantor(snapshot: GuarantorSnapshot, demographics: GuarantorDemographics): Promise<GuarantorResult> {\n await fhir.create({resourceType: \"Person\", id: \"silently-created\"}, source);','Q10 directly'),
('Q1-Q2','for (const item of snapshot.children) writes.set(item.resource.id!, await writeChild(item, accepted));','for (const item of []) writes.set(item.resource.id!, await writeChild(item, accepted));','Q1'),
('Q3','...projectResponsiblePartyDemographics(person) }, source','...projectResponsiblePartyDemographics(person), extension: item.resource.extension?.map((e, i) => i === 0 ? { ...e, valueBoolean: !e.valueBoolean } : e) }, source','Q3'),
('Q4','const writes = new Map<string, GuarantorChildResult["writeStatus"]>();','await fhir.update(await fhir.read<Patient>("Patient", "a"), source);\n  const writes = new Map<string, GuarantorChildResult["writeStatus"]>();','Q4'),
('Q5a-Q6a','if (version(current.person) !== version(snapshot.person) ||','if (false && (version(current.person) !== version(snapshot.person) ||','Q5a'),
('Q5b','fhir.update(intended, source, version(snapshot.person))','fhir.update(intended, source)','Q5b'),
('Q6b','source, version(item.resource))','source)','Q6b'),
('Q7','for (const item of snapshot.children) writes.set','for (const item of snapshot.children.slice(0, 1)) writes.set','Q7'),
('Q8-label','patientName: item.patientName, classification','patientName: "Guardian", classification','Q8 late'),
('Q8-unknown','catch { children.push(resultChild(item, "unknown")); }','catch { children.push(resultChild(item, "mismatched")); }','Q8 failed'),
('Q9a','if (demographicsMatch(snapshot.person, demographics)) {','if (false) {','Q9a'),
('Q9b','if (demographicsMatch(item.resource, current.person)) continue;','if (false) continue;','Q9b'),
('Q9c','current = await readSnapshot(await fhir.read<Person>("Person", previous.person.id!));','current = await readSnapshot(previous.person);','Q9c'),
('Q10-Q12','if (matches.length !== 1 || matches[0].id !== snapshot.person.id) throw','if (false) throw','Q10'),
('Q13','trailing = await fhir.read<Person>("Person", snapshot.person.id!);','trailing = snapshot.person;','Q13'),
]
results=[]
try:
 for name,old,new,pattern in mutations:
  assert old in original,name
  mutated=original.replace(old,new,1)
  if name in ['Q5a-Q6a','Q6a']:mutated=mutated.replace('!== c.resource.meta?.versionId)) return stopped','!== c.resource.meta?.versionId))) return stopped',1)
  if name=='Q9b':mutated=mutated.replace('if (!demographicsMatch(fresh, current.person)) writes.set','if (true) writes.set')
  p.write_text(mutated)
  r=subprocess.run(['node','--import','tsx','--test','--test-name-pattern='+pattern,'tests/guarantorPropagation.test.tsx'],capture_output=True,text=True)
  (output/(name+'.txt')).write_text((r.stdout+r.stderr).replace(str(scratch), "<isolated-workspace>"))
  results.append({'guard':name,'exit':r.returncode,'failed':[l for l in r.stdout.splitlines() if l.startswith('not ok') or l.startswith('# fail')]})
  p.write_text(original)
finally:p.write_text(original)
green=subprocess.run(['node','--import','tsx','--test','tests/guarantorPropagation.test.tsx'],capture_output=True,text=True)
(output/'restored-green.txt').write_text((green.stdout+green.stderr).replace(str(scratch), "<isolated-workspace>"))
(output/'results.json').write_text(json.dumps(results,indent=2)+'\n')
print(json.dumps(results,indent=2))
shutil.rmtree(scratch)
assert green.returncode == 0
assert all(r['exit'] != 0 and r['failed'] for r in results)

