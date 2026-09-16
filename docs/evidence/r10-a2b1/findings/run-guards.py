from pathlib import Path
import subprocess
import re
root=Path(__file__).resolve().parents[4]
endpoint=root/'mcp/src/clinical-graph/diagnosis-findings-endpoint.ts'
writer=root/'mcp/src/clinical-graph/current-finding-writer.ts'
reader=root/'mcp/src/clinical-graph/current-finding-reader.ts'
evidence=Path(__file__).resolve().parent
rules=[
 ('W4',endpoint,"...(current?.status==='live'?liveHomes(context,current):[])","...[]",'W4 assert'),
 ('W7',endpoint,"if(!staffHasBusinessAction(staff,'chart.write'))", "if(!staffHasBusinessAction(staff,'chart.diagnosis.write'))",'W7 staff'),
 ('W8',endpoint,"if(context.incomplete)return unavailable(context);","if(context.incomplete)return {status:200,body:{findings:[]}};",'W8 unavailable'),
 ('W26',endpoint,"if(target.state.homes.some(h=>!domain(context).has(h))||new Set(target.state.homes).size!==target.state.homes.length)","if(false)",'W26 out-of-domain'),
 ('W27',endpoint,"if(missing!==-1)return", "if(false)return",'W27 missing'),
 ('W28a',endpoint,"return findingCommandResponse(await executeFindingCommand(writerDeps,command));","if(body.operation==='clear')for(const t of command.targets)if(t.kind==='fact')t.state.homes=[];\n    return findingCommandResponse(await executeFindingCommand(writerDeps,command));",'W28a clear'),
 ('W28b',endpoint,"return findingCommandResponse(await executeFindingCommand(writerDeps,command));","if(body.operation==='assert')for(const t of command.targets)if(t.kind==='fact'){const f=context.projection.currentFacts.find(f=>f.projectionKey===targetId(t.key));if(f?.status==='retired')t.state.homes=f.homes;}\n    return findingCommandResponse(await executeFindingCommand(writerDeps,command));",'W28b retired'),
 ('W31',endpoint,"result.outcomes.map(({fresh,...outcome})=>outcome)","result.outcomes",'W31 conflict'),
 ('W32',endpoint,"if(destination&&!sameState(destination))return invalid('destination-differs',body.targets.findIndex(t=>t.key.eye===eye));", "if(false)return invalid('destination-differs',0);",'W32 eye-change'),
 ('W33',endpoint,"baseline:fact?.baseline??{kind:'absent' as const,key}","baseline:{kind:'absent' as const,key}",'W28b retired'),
 ('W34',endpoint,"if(classification==='reused-with-different-content')return invalid('command-reused',index);", "if(classification==='reused-with-different-content')classification='exact-replay';",'W34 same command'),
 ('W39',endpoint,"if(record&&!['preliminary','entered-in-error'].includes(record.status))", "if(record&&!['preliminary','entered-in-error','final'].includes(record.status))",'W39 mixed'),
 ('W41',reader,'if (httpStatus === 404 || httpStatus === 410)','if (httpStatus === 404)','W8 unavailable'),
 ('W42',endpoint,"await repairPendingAudits(commandDependencies(staff,context,deps),{...body.data,encounterReference:context.state.encounterReference})","{commandId:body.data.commandId,complete:true,executionOrder:[],outcomes:[]}",'W42 repair'),
 ('W43',endpoint,"if(context.projection.preRebuild)return invalid('pre-rebuild-test-encounter');","if(false)return invalid('pre-rebuild-test-encounter');",'W43 pre-rebuild'),
 ('W44',endpoint,"&&o.cause!=='halted-by-earlier-target'","&&o.cause!=='halted-by-earlier-target'&&o.cause!=='refresh'",'W44 refresh'),
 ('W45',writer,'const witnesses=await findAuditsByTag({fhir:state.fhir},REASSERT_COMMAND_SYSTEM,reassertCommandWitness(command.commandId,id));','const witnesses:Provenance[]=[];','W45 reassert'),
]
def replace_tokens(source,before,after):
 positions=[i for i,c in enumerate(source) if not c.isspace()]
 compact=''.join(source[i] for i in positions)
 needle=re.sub(r'\s+','',before)
 start=compact.find(needle)
 if start<0:raise RuntimeError('Missing mutation anchor: '+before)
 finish=start+len(needle)
 return source[:positions[start]]+after+source[positions[finish-1]+1:]
summary=[]
for guard,path,before,after,pattern in rules:
 original=path.read_text()
 mutated=replace_tokens(original,before,after)
 if guard=='W26':mutated=replace_tokens(mutated,"if(selected&&!context.state.conditions.some(c=>`Condition/${c.id}`===selected&&isCurrentVisitDiagnosis(c)))","if(false)")
 if guard=='W43':mutated=replace_tokens(mutated,"if(context.projection.preRebuild)return 'pre-rebuild-test-encounter';","if(false)return 'pre-rebuild-test-encounter';")
 command=['node','--import','tsx','--test','--test-name-pattern',pattern,'mcp/tests/diagnosisFindingsCommands.test.ts']
 try:
  path.write_text(mutated)
  red=subprocess.run(command,cwd=root,capture_output=True,text=True)
  (evidence/(guard+'-red.tap')).write_text(red.stdout+red.stderr)
 finally:path.write_text(original)
 green=subprocess.run(command,cwd=root,capture_output=True,text=True)
 (evidence/(guard+'-green.tap')).write_text(green.stdout+green.stderr)
 summary.append(f'{guard}: red exit={red.returncode}; restored green exit={green.returncode}')
 print(summary[-1],flush=True)
 if red.returncode==0 or green.returncode!=0:raise RuntimeError(guard+' failed guard proof')
(evidence/'guards.txt').write_text('\n'.join(summary)+'\n')
