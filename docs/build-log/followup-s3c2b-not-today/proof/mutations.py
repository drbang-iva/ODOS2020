import json, os, re, subprocess
from pathlib import Path
root=Path(__file__).resolve().parents[4]
out=root/'docs/build-log/followup-s3c2b-not-today/mutations.json'
endpoint='mcp/src/clinical-graph/follow-up-queue-endpoint.ts'
store='mcp/src/clinical-graph/follow-up-decision-store.ts'
ui='ui/src/components/charting/FollowUpQueue.tsx'
env={**os.environ,'ODOS_POSTGRES_URL':'postgresql://medplum:medplum@127.0.0.1:32781/medplum'}
def replace(s,a,b):
 assert a in s, a
 return s.replace(a,b,1)
def before_order(s):
 a='    const decision = decisions[followUpDecisionKey(test)];\n    if (decision) return { ...row, state: "not-today", decidedBy: decision.by.display ?? decision.by.reference, decidedAt: decision.at };\n'
 s=replace(s,a,'')
 return replace(s,'    if (actionIds.length)',a+'    if (actionIds.length)')
def wrong_mapping(s):
 body='''catch (error) {
    const status = (error as { status?: number })?.status;
    if (status === 401 || status === 403) return { status: 403, body: { error: "Encounter is outside the caller's patient compartment." } };
    if (status === 404 || status === 410) return { status: 404, body: { error: "Encounter was not found." } };
    return loadFailure();
  }'''
 return s.replace('catch { return loadFailure(); }', body)
cases=[
 ('G1',endpoint,lambda s:replace(s,'const decision = decisions[followUpDecisionKey(test)];','const decision = undefined;'),'mcp/tests/followUpQueueEndpoint.test.ts','S3c2b G1 T4'),
 ('G2',store,lambda s:replace(s,'`${row.orderable}|${row.focus ?? ""}`','row.orderable'),'mcp/tests/followUpDecisionStore.test.ts','S3c2b G2'),
 ('G3',endpoint,before_order,'mcp/tests/followUpQueueEndpoint.test.ts','S3c2b G3'),
 ('G4',endpoint,lambda s:replace(s,'if (row?.state !== "for-review")','if (false)'),'mcp/tests/followUpQueueEndpoint.test.ts','S3c2b G4'),
 ('G5',store,lambda s:replace(s,', { "If-Match": `W/"${existing.meta!.versionId}"` }',''),'mcp/tests/followUpDecisionStore.test.ts','S3c2b G5'),
 ('G6',store,lambda s:replace(s,'attempt < 3','attempt < 4'),'mcp/tests/followUpQueueEndpoint.test.ts','S3c2b G6'),
 ('G7',store,lambda s:replace(s,'if (confirmed.writeToken === writeToken) return confirmed.decisions;','return confirmed.decisions;'),'mcp/tests/followUpDecisionStore.test.ts','S3c2b G7'),
 ('G8',endpoint,lambda s:replace(s,'if (!staffHasBusinessAction(staff, "chart.write"))','if (!staffHasBusinessAction(staff, "chart.read"))'),'mcp/tests/followUpQueueEndpoint.test.ts','S3c2b G8'),
 ('G9',endpoint,lambda s:replace(s,'if (encounter.status === "finished")','if (false)'),'mcp/tests/followUpQueueEndpoint.test.ts','S3c2b G9'),
 ('G10',endpoint,lambda s:replace(s,'  const encounter = await encounterForCaller(staff.fhir, encounterId);','  await new FhirFollowUpDecisionStore(deps.serviceFhir ?? staff.fhir).get(encounterId);\n  const encounter = await encounterForCaller(staff.fhir, encounterId);'),'mcp/tests/followUpQueueEndpoint.test.ts','S3c2b G10'),
 ('G11-empty',endpoint,lambda s:replace(s,'new FhirFollowUpDecisionStore(serviceFhir).get(encounterId),','new FhirFollowUpDecisionStore(serviceFhir).get(encounterId).catch(() => ({})),'),'mcp/tests/followUpQueueEndpoint.test.ts','S3c2b G11'),
 ('G11-mapping',endpoint,wrong_mapping,'mcp/tests/followUpQueueEndpoint.test.ts','S3c2b G11'),
 ('G12',ui,lambda s:replace(s,'(row.state === "for-review" || row.state === "not-today")','(row.state === "for-review" || row.state === "not-today" || row.state === "unavailable")'),'ui/tests/followUpQueue.test.tsx','S3c2b G12'),
 ('G13-alert',ui,lambda s:replace(s,'<p role="status" className="odos-follow-up-queue-error">','<p role="alert" className="odos-follow-up-queue-error">'),'ui/tests/followUpQueue.test.tsx','S3c2b G13'),
 ('G13-message',ui,lambda s:replace(s,'error instanceof Error ? error.message : "The decision could not be saved."','"A fixed error"'),'ui/tests/followUpQueue.test.tsx','S3c2b G13'),
 ('G14',ui,lambda s:replace(s,'      if (generation.current === currentGeneration) {','      await loadFollowUpQueue(encounterId);\n      if (generation.current === currentGeneration) {'),'ui/tests/followUpQueue.test.tsx','S3c2b G14'),
 ('G15',ui,lambda s:replace(s,'{row.decidedBy} ·','·'),'ui/tests/followUpQueue.test.tsx','S3c2b G15'),
 ('G16','mcp/src/index.ts',lambda s:replace(s,'app.put("/clinical-graph/encounters/:encounterId/follow-up-queue/decisions"','app["put"]("/clinical-graph/encounters/:encounterId/follow-up-queue/decisions"'),'mcp/tests/findingDefinitionStore.test.ts','every definition-backed clinical-graph HTTP closure'),
]
def run(file,pattern):
 cwd=root/('ui' if file.startswith('ui/') else 'mcp')
 args=['node','--import','tsx','--test',f'--test-name-pattern={pattern}',str(Path(file).relative_to(cwd.name))]
 p=subprocess.run(args,cwd=cwd,env=env,text=True,capture_output=True,timeout=60)
 lines=p.stdout.splitlines()
 summary=[l for l in lines if re.match(r'^# (tests|pass|fail|skipped|cancelled) ',l)]
 failures=[l for l in lines if l.startswith('not ok ')]
 error=[]
 for i,l in enumerate(lines):
  if 'error:' in l:
   error.extend(lines[i:i+9])
 error=[l for l in error if str(root) not in l and 'stack:' not in l]
 return {'command':' '.join(args),'cwd':cwd.name,'exit':p.returncode,'summary':summary,'failures':failures,'errorExcerpt':error}
results=[]
for name,file,mutate,test,pattern in cases:
 original=(root/file).read_text()
 try:
  (root/file).write_text(mutate(original))
  red=run(test,pattern)
 finally: (root/file).write_text(original)
 green=run(test,pattern)
 results.append({'guard':name,'file':file,'red':red,'green':green})
 out.write_text(json.dumps(results,indent=2)+'\n')
 print(name,red['exit'],green['exit'],flush=True)
 assert red['exit']!=0 and red['failures'] and green['exit']==0, name
