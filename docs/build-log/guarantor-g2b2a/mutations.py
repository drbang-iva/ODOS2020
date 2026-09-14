from pathlib import Path
import subprocess,json,re
root=Path(__file__).resolve().parents[3]
out=root/'docs/build-log/guarantor-g2b2a/mutations';out.mkdir(exist_ok=True)
search='mcp/src/clinic/guarantor-search.ts';engine='mcp/src/clinic/guarantor-link-operation.ts';ui='ui/src/components/patient/GuarantorLinkScreens.tsx';panel='ui/src/components/patient/ResponsiblePartiesControl.tsx'
backend=['node','--import','tsx','--test','mcp/tests/guarantorSearchScreens.test.ts'];frontend=['node','--import','tsx','--test','tests/guarantorSearchScreens.test.tsx']
cases=[]
def add(name,path,old,new,front=False):cases.append((name,path,[(old,new)],front))
add('K1-unfiltered',search,'  const found = persons.filter(person => {','  const found = persons.filter(person => { if (true) return true;')
add('K2-raw-phone',search,'digits(contact.value ?? "") === digits(key.phone!)','(contact.value ?? "") === key.phone!')
a='return { status: 200, body: found.map(person => ({ personId: person.id'
add('K3-resource',search,a,'return { status: 200, body: found.map(person => ({ ...person, personId: person.id')
add('K4-inactive',search,'person.active === false || ','')
add('K4-zero-link',search,'!person.link?.length || ','')
add('K4-other-link',search,'person.link.some(link => !/^RelatedPerson\\/[A-Za-z0-9.-]{1,64}$/.test(link.target.reference ?? ""))','false')
add('K5-cap',search,'if (found.length > 20) return tooMany;','if (false) return tooMany;')
add('K5-error-mapping',search,'if (error instanceof FhirSearchLimitError) return tooMany;','if (false) return tooMany;')
add('K7-extra-patient',search,'  // fhir-service-write: Person','  bundle.entry!.push({resource:{resourceType:"Patient"},request:{method:"POST",url:"Patient"}});\n  // fhir-service-write: Person')
add('K7-name-check',search,'lastName: z.string().trim().min(1),\n  middleName','lastName: z.string().default(""),\n  middleName')
add('K8-draft-record',engine,'      const loaded = await operation.validate(plan);\n      return { status: 200, body: { expected: plan.expected','      const loaded = await operation.validate(plan);\n      await operation.record(plan);\n      return { status: 200, body: { expected: plan.expected')
cases.append(('K8-subset',engine,[('z.object({ kind: z.literal("consolidate"), sourcePersonId: idSchema, destinationPersonId: idSchema }).strict()','z.object({ kind: z.literal("consolidate"), sourcePersonId: idSchema, destinationPersonId: idSchema, relatedPersonIds: z.array(idSchema).optional() }).strict()')],False))
add('K9-auto-retry',ui,'if(e instanceof GuarantorScreenError&&e.status===409)setReview(true);','if(e instanceof GuarantorScreenError&&e.status===409){setReview(true);if(input&&draft){try{const next=await draftGuarantorOperation(input);await createGuarantorOperation({...input,relatedPersonIds:next.relatedPersonIds,expected:next.expected,operationId:newGuarantorOperationId(),reason});}catch{}}}',True)
add('K10-draft-before-person',ui,'setCreationAttempted(true);const result=await createNewGuarantor(newDetails);','setCreationAttempted(true);await draftGuarantorOperation(transfer("missing-person"));const result=await createNewGuarantor(newDetails);',True)
add('K10-second-person',ui,'perform(()=>makeDraft(input))','perform(async()=>{if(newDetails)await createNewGuarantor(newDetails);await makeDraft(input);})',True)
add('K11-swapped',ui,'sourcePersonId:kept.id===person.id?found.id!:person.id!,destinationPersonId:kept.id!','destinationPersonId:kept.id===person.id?found.id!:person.id!,sourcePersonId:kept.id!',True)
add('K12-pending',panel,'    <h3 className="font-semibold">{displayName(loaded.relatedPerson ?? {})}</h3>','    {loaded.kind === "pending" && <GuarantorLinkScreens person={{resourceType:"Person",id:"S"}} relatedPersonId={loaded.relatedPerson.id!} disabled={false} onReload={refresh}/> }\n    <h3 className="font-semibold">{displayName(loaded.relatedPerson ?? {})}</h3>',True)
add('K13-correct-undo',ui,'op.task.status==="completed"&&op.kind!=="correct"','op.task.status==="completed"',True)
add('K14-enabled',ui,'disabled={cards===undefined||(cards.length>0&&!none)}','disabled={false}',True)
results=[]
for name,path,replacements,front in cases:
 p=root/path;original=p.read_text();changed=original
 for old,new in replacements:
  assert changed.count(old)==1,(name,old,changed.count(old));changed=changed.replace(old,new)
 cwd=root/'ui' if front else root;cmd=frontend if front else backend
 green=subprocess.run(cmd,cwd=cwd,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT);(out/(name+'-green.tap')).write_text(green.stdout);assert green.returncode==0,name
 try:
  p.write_text(changed);red=subprocess.run(cmd,cwd=cwd,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT);(out/(name+'-red.tap')).write_text(red.stdout)
 finally:p.write_text(original)
 restored=subprocess.run(cmd,cwd=cwd,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT);(out/(name+'-restored.tap')).write_text(restored.stdout)
 row=dict(guard=name,green=green.returncode,red=red.returncode,restored=restored.returncode,failingTests=re.findall(r'^not ok .*$',red.stdout,re.M));results.append(row);print(json.dumps(row),flush=True)
 (out/'results.json').write_text(json.dumps(results,indent=2)+'\n')
 assert red.returncode!=0 and restored.returncode==0,(name,'mutation failed to demonstrate guard')
