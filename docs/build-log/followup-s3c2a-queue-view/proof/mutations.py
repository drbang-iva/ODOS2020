from pathlib import Path
import subprocess, os, re, json
root=Path(__file__).resolve().parents[4]
out=root/'docs/build-log/followup-s3c2a-queue-view/mutations.json'
env={**os.environ,'ODOS_POSTGRES_URL':'postgresql://medplum:medplum@127.0.0.1:29857/medplum'}
queue='mcp/src/clinical-graph/follow-up-queue-endpoint.ts'
ui='ui/src/components/charting/FollowUpQueue.tsx'
endpoint='mcp/tests/followUpQueueEndpoint.test.ts'
component='ui/tests/followUpQueue.test.tsx'
def edit(before,after):
 def mutate(s):
  if before not in s: raise RuntimeError('Mutation anchor missing: '+before)
  return s.replace(before,after,1)
 return mutate
cases=[
 ('R3-tab-count','ui/src/components/charting/ExamRightPanel.tsx',lambda s: re.sub(r'      <button\n        id=\{`\$\{instanceId\}-follow-up-tab`\}[\s\S]*?</button>\n','',s), 'ui/tests/examOverviewBoard.test.tsx','DXIMAGING imaging preference survives stages'),
 ('R4-surface-counts','ui/src/scenes/EncounterCharting.tsx',lambda s: re.sub(r'        \{rightPanelForward && \(\n          <ExamRightPanelSurface\n            active=\{rightPanelState.activeTab === "follow-up"\}[\s\S]*?        \)\}\n','',s),'ui/tests/examOverviewBoard.test.tsx','C1 panel is available off|C1 modal editor still'),
 ('R5-route-inventory','mcp/src/index.ts',edit('app.get("/clinical-graph/encounters/:encounterId/follow-up-queue"','app.get("/mutation-removed-route"'),'mcp/tests/findingDefinitionStore.test.ts','every definition-backed clinical-graph HTTP closure'),
 ('G1',queue,edit('    return { status: 200, body: deriveFollowUpQueue', '''    const { FhirFollowUpProfileStore } = await import("./follow-up-profile-store.js");
    const liveProfiles = await new FhirFollowUpProfileStore(serviceFhir).list();
    for (const test of scope.testsProposed ?? []) {
      const source = test.sources.find(source => source.kind === "profile");
      const live = liveProfiles.find(p => source?.kind === "profile" && p.profileKey === source.profileKey)?.testsQueuedByDefault.find(row => row.orderable === test.orderable && row.focus === test.focus);
      if (live) test.label = live.label;
    }
    return { status: 200, body: deriveFollowUpQueue'''),endpoint,'S3c2a G1\\b'),
 ('G2',queue,edit(' && (action.payload.focus ?? "") === (test.focus ?? "")',''),endpoint,'S3c2a G2\\b'),
 ('G3-state',queue,edit(' && !["removed", "cancelled"].includes(action.state)',''),endpoint,'S3c2a G3\\b'),
 ('G3-encounter',queue,edit('action.encounterId === encounterId && ','') ,endpoint,'S3c2a G3\\b'),
 ('G4',queue,edit('if (actionIds.length) return', 'if (actionIds.length && fee) return'),endpoint,'S3c2a G4\\b'),
 ('G5',queue,edit('if (!fee) return','if (!fee || test.unavailableReason) return'),endpoint,'S3c2a G5\\b'),
 ('G6',queue,edit('PROTOCOL_BASIC_CODES.planActionInstance).list(),','PROTOCOL_BASIC_CODES.planActionInstance).list().catch(() => []),'),endpoint,'S3c2a G6\\b'),
 ('G7',queue,edit('if (testsProposed === undefined) return { recorded: false };','if (testsProposed === undefined) testsProposed = [];'),endpoint,'S3c2a G7\\b'),
 ('G8',queue,edit('const encounter = await staff.fhir.read<Encounter>("Encounter", encounterId);','const encounter = { subject: { reference: "Patient/p1" } };'),endpoint,'S3c2a G8\\b'),
 ('G9','mcp/src/clinical-graph/exam-overview-endpoint.ts',edit('          label: test.label,\n',''), 'mcp/tests/examOverviewEndpoint.test.ts','S3c2a G9\\b'),
 ('G9-merge','mcp/src/clinical-graph/exam-scope-store.ts',edit('    // The first snapshot owns display fields;', '    Object.assign(existing, { label: test.label, unavailableReason: test.unavailableReason, resultSection: test.resultSection, choice: test.choice });\n    // The first snapshot owns display fields;'),'mcp/tests/examShapeRecord.test.ts','S3c2a G9\\b'),
 ('G10','mcp/src/clinical-graph/exam-scope-store.ts',edit('label: profileTestSchema.shape.label.optional(),','label: profileTestSchema.shape.label,'),endpoint,'S3c2a G10\\b'),
 ('G11',ui,edit('    if (!active) return;\n',''), 'ui/tests/examOverviewBoard.test.tsx','S3c2a G11\\b'),
 ('G12-empty',ui,edit('The tests for this visit could not be loaded.','No tests are proposed for this visit.'),component,'S3c2a G12\\b'),
 ('G12-alert',ui,edit('<div role="status"><p>The tests','<div role="alert"><p>The tests'),component,'S3c2a G12\\b'),
 ('G13',ui,edit('<div className="odos-follow-up-queue-heading">','{row.state === "for-review" && <button>Accept</button>}<div className="odos-follow-up-queue-heading">'),component,'S3c2a G13\\b'),
 ('G14','ui/src/lib/follow-up-queue.ts',edit('clinicalGraphApiBase()','""'),'ui/tests/clinicalGraphRouting.test.tsx','clinical-graph requests share the literal'),
]
results=[]
for name,file,mutate,test,pattern in cases:
 target=root/file; original=target.read_text()
 cwd=root/'ui' if test.startswith('ui/') else root
 command=['node','--import','tsx','--test','--test-name-pattern='+pattern,test[3:] if test.startswith('ui/') else test]
 def run():
  r=subprocess.run(command,cwd=cwd,env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
  lines=[line for line in r.stdout.splitlines() if re.match(r'^(not ok|ok |# (tests|pass|fail|cancelled|skipped|todo))',line)]
  return r.returncode,'\n'.join(lines),r.stdout
 try:
  target.write_text(mutate(original))
  code,summary,raw=run()
  if code==0: raise RuntimeError(name+' mutation survived')
  if name=='G14' and ('59' not in raw or '58' not in raw or ':41:' not in raw): raise RuntimeError('G14 did not fail at caller count')
  red={'exit':code,'summary':summary}
 finally: target.write_text(original)
 code,summary,raw=run()
 if code!=0: raise RuntimeError(name+' restore failed: '+raw[-2500:])
 results.append({'guard':name,'file':file,'command':('cd ui && ' if cwd!=root else '')+' '.join(command),'red':red,'green':{'exit':code,'summary':summary}})
 out.write_text(json.dumps(results,indent=2)+'\n')
 print(name+': red -> restored green',flush=True)
