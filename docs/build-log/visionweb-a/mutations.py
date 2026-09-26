"""Run one intentional defect at a time, restore even on failure, retain summaries only."""
from pathlib import Path
import os, subprocess, re
ROOT=Path(__file__).resolve().parents[3]
SRC='mcp/src/'
CONFIG=SRC+'integrations/visionweb/config.ts'
SERIAL=SRC+'integrations/visionweb/vwOrderSerializer.ts'
CLIENT=SRC+'integrations/visionweb/visionWebClient.ts'
PARSE=SRC+'integrations/visionweb/uploadResponse.ts'
ADAPTER=SRC+'lab-orders/adapters/visionweb-lab-order-adapter.ts'
HELPERS=SRC+'lab-orders/lab-transmission-helpers.ts'
DISPATCH=SRC+'lab-orders/lab-order-dispatch.ts'
mutations=[
 ('V1',CONFIG,'entries.every(', 'entries.some(',['visionWebConfig']),
 ('V2',ADAPTER,'assertVisionWebTransmission(config);','assertVisionWebTransmission({...config, productionEnabled:true});',['visionWebLabOrderAdapter']),
 ('V3',CONFIG,'accounts(config)!.get(lab.trim())','accounts(config)!.values().next().value',['visionWebConfig','visionWebLabOrderAdapter']),
 ('V4',SERIAL,'value.toFixed(digits)','value.toFixed(2)',['vwOrderSerializer']),
 ('V5',SERIAL,'${[...errors].join(", ")}','${[...errors].slice(0,1).join(", ")}',['vwOrderSerializer']),
 ('V6',SERIAL,'else { errors.add(name); return; }','else { digits = 2; }',['vwOrderSerializer']),
 ('V7',SERIAL,'return value.replace(/&/g,','return value; return value.replace(/&/g,',['vwOrderSerializer']),
 ('V8a',PARSE,'const status = required("Status");','let status = required("Status"); if (!["Sent","Review","Error"].includes(status)) status="Sent";',['visionWebUploadResponse']),
 ('V9',ADAPTER,'let task=await fhir.create<Task>','const premature=await client.uploadOrder(config,{vwOrderXml:xml,subordid:req.order.header.orderId,msgguid:randomUUID(),sloid:account.supplierId});\n      let task=await fhir.create<Task>',['visionWebLabOrderAdapter']),
 ('V10',ADAPTER,'const detail=sanitizeVendorText(result.errorList??"",visionWebSecrets(config));','const detail=result.status==="Error" ? result.errorList??"" : sanitizeVendorText(result.errorList??"",visionWebSecrets(config));',['visionWebLabOrderAdapter']),
 ('V11',ADAPTER,'if((await findActiveTransmissions(fhir,req.orderTaskReference)).length)','if(false)',['visionWebLabOrderAdapter']),
 ('V12-cancel',ADAPTER,'async cancel(reference,staffReference){','async cancel(reference,staffReference){',['visionWebLabOrderAdapter']),
 ('V12-advance',ADAPTER,'async advanceTransportState(req){','async advanceTransportState(req){',['visionWebLabOrderAdapter']),
 ('V13',CLIENT,'const key = scope;','const key = "shared";',['visionWebClient']),
 ('V14',ADAPTER,'msgguid:randomUUID()','msgguid:"constant-guid"',['visionWebLabOrderAdapter']),
 ('V15',DISPATCH,'if (vendor !== "manual" && vendor !== "ocuco-gatekeeper")','if (!isLabOrderVendorId(vendor))',['labOrderDispatch']),
 ('V16',CLIENT,'catch { throw new Error(`VisionWeb ${operation} failed.`); }','catch { try { return await fetchImpl(url,init); } catch { throw new Error(`VisionWeb ${operation} failed.`); } }',['visionWebClient']),
 ('V17',HELPERS,'if (existing.link?.some(link=>link.relation==="next"))','if (false)',['labTransmissionHelpers']),
]
report=ROOT/'docs/build-log/visionweb-a/GUARDS.md'
report.write_text('# Mutation proofs\n\nDedicated synthetic Postgres supplied via ODOS_POSTGRES_URL. Each defect is restored before its green run. Counts include all tests in the named files.\n')
for name,path,old,new,tests in mutations:
 p=ROOT/path;original=p.read_text();assert old in original,name
 changed=original.replace(old,new,1)
 if name=='V9':
  needle='result=await client.uploadOrder(config,{vwOrderXml:xml,subordid:req.order.header.orderId,msgguid:randomUUID(),sloid:account.supplierId});'
  assert needle in changed
  changed=changed.replace(needle,'result=premature;')
 if name.startswith('V12-'):
  offset=changed.index(old)
  prefix,part=changed[:offset],changed[offset:]
  guard='if(uploaded==="uploading"||uploaded==="unknown")throw new Error(UNKNOWN);'
  assert guard in part
  changed=prefix+part.replace(guard,'if(false)throw new Error(UNKNOWN);',1)
  if name=='V12-advance':
   changed=changed.replace('const uploaded=uploadState(task);\n      if(false)','const uploaded=uploadState(task);\n      if(false)',1)
 command=['npm','--prefix','mcp','test','--']+['tests/'+t+'.test.ts' for t in tests]
 try:
  p.write_text(changed)
  red=subprocess.run(command,cwd=ROOT,env=os.environ,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
 finally:p.write_text(original)
 green=subprocess.run(command,cwd=ROOT,env=os.environ,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
 def summary(result):
  return '\n'.join(line for line in result.stdout.splitlines() if re.match(r'^# (tests|pass|fail|skipped) ',line) or line.startswith('not ok '))
 with report.open('a') as f:
  f.write('\n## '+name+'\n\nMutation: `'+path+'` — '+{'V12-cancel':'permit unknown cancellation','V12-advance':'permit transition rules before the upload-state gate'}.get(name,old.replace('\n',' '))+'\n\nCommand: `'+ ' '.join(command)+'`\n\nRED (exit '+str(red.returncode)+'):\n```text\n'+summary(red)+'\n```\nGREEN (exit '+str(green.returncode)+'):\n```text\n'+summary(green)+'\n```\n')
 print(name,'RED',red.returncode,'GREEN',green.returncode,flush=True)
 if red.returncode==0 or green.returncode!=0:
  print(summary(red),summary(green),flush=True)
  raise SystemExit('STOP: mutation did not demonstrate the guard or restoration failed')
