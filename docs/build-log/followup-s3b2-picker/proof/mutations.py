from pathlib import Path
import json, subprocess, shlex
root=Path(__file__).resolve().parents[4]
store='mcp/src/clinical-graph/exam-scope-store.ts'
endpoint='mcp/src/clinical-graph/exam-overview-endpoint.ts'
picker='ui/src/components/charting/FollowingPicker.tsx'
server=lambda pattern,file: ['node','--import','tsx','--test','--test-name-pattern='+pattern,file]
ui=lambda pattern,file: ['node','--import','tsx','--test','--test-name-pattern='+pattern,file]
cases=[
 ('G1',store,'if (existing) return parseScope(existing);','',server('S3b2 G1','mcp/tests/examShapeRecord.test.ts'),'.'),
 ('G2',store,'const chosenAt = new Date().toISOString();','if (existing) throw new Error("mutation refuses existing row");\n    const chosenAt = new Date().toISOString();',server('S3b2 G2','mcp/tests/examShapeRecord.test.ts'),'.'),
 ('G3',store,'if (existing) return parseScope(existing);','if (existing) return { ...parseScope(existing), sectionsOpen: freezeProfiles(await resolve()).sectionsOpen };',server('S3b2 G3','mcp/tests/examShapeRecord.test.ts'),'.'),
 ('G4',store,'z.enum(["derived", "explicit"]).default("derived")','z.enum(["derived", "explicit"])',server('S3b2 G4','mcp/tests/examShapeRecord.test.ts'),'.'),
 ('G5',endpoint,'scope = await store.pick(encounterId,','await staff.fhir.create({ resourceType: "Condition", subject: encounter.subject });\n        scope = await store.pick(encounterId,',server('S3b2 G1 G2 G5','mcp/tests/examOverviewEndpoint.test.ts'),'.'),
 ('G6',picker,'useState<FollowingChoice["examScope"]>("office-visit")','useState<FollowingChoice["examScope"]>((globalThis as any).appointment?.category === "comprehensive" ? "comprehensive" : "office-visit")',ui('S3b2 G6','tests/followingPicker.test.tsx'),'ui'),
 ('G7',endpoint,'// Opening the board must not depend on bookkeeping persistence.','throw error;\n        // Opening the board must not depend on bookkeeping persistence.',server('S3b1 G8','mcp/tests/examOverviewEndpoint.test.ts'),'.'),
 ('G8','ui/tests/clinicalGraphRouting.test.tsx','assert.equal(callers.length, 57);','assert.equal(callers.length, 56);',ui('clinical-graph requests share','tests/clinicalGraphRouting.test.tsx'),'ui'),
]
results=[]
def run(command,cwd):
 p=subprocess.run(command,cwd=root/cwd,text=True,capture_output=True)
 summary='\n'.join(line for line in (p.stdout+'\n'+p.stderr).splitlines() if line.startswith(('ok ','not ok ','# tests ','# pass ','# fail ','# skipped ')))
 return {'exit':p.returncode,'summary':summary}
for guard,file,before,after,command,cwd in cases:
 path=root/file; original=path.read_text()
 assert before in original, guard
 try:
  path.write_text(original.replace(before,after,1))
  red=run(command,cwd)
 finally: path.write_text(original)
 green=run(command,cwd)
 row={'guard':guard,'file':file,'command':shlex.join(command),'cwd':cwd,'red':red,'green':green}; results.append(row)
 print(guard, 'red',red['exit'],'green',green['exit'],flush=True)
 (root/'docs/build-log/followup-s3b2-picker/mutations.json').write_text(json.dumps(results,indent=2)+'\n')
 assert red['exit'] != 0 and green['exit'] == 0, row
