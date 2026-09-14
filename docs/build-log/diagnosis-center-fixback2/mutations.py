from pathlib import Path
import subprocess,json
root=Path(__file__).resolve().parents[3]
ev=Path(__file__).resolve().parent
cases=[
 ('visit-resolution','mcp/src/clinical-graph/diagnosis-newness.ts',' || prior.visitStatus === "resolved-this-visit"','', 'mcp','stye recurrence','tests/diagnosisNewness.test.ts'),
 ('mixed-eye','mcp/src/clinical-graph/diagnosis-newness.ts','value: latestVisit.every(isResolved)','value: latestVisit.some(isResolved)', 'mcp','mixed-eye latest','tests/diagnosisNewness.test.ts'),
 ('doctor-survives','mcp/src/clinical-graph/diagnosis-newness-endpoint.ts','history = undefined;','throw new Error("History failure");', 'mcp','history failure preserves','tests/diagnosisNewness.test.ts'),
 ('unavailable-ui','ui/src/components/charting/DiagnosisWorkspace.tsx','newnessError || newnessRows[selectedReference!]?.source === "unavailable"','newnessError', 'ui','partial newness response','tests/diagnosisWorkspace.test.tsx'),
]
results=[]
for name,file,old,new,cwd,pattern,testfile in cases:
 p=root/file;original=p.read_text();assert old in original,name
 try:
  p.write_text(original.replace(old,new,1))
  red=subprocess.run(['node','--import','tsx','--test','--test-name-pattern='+pattern,testfile],cwd=root/cwd,capture_output=True,text=True)
  (ev/(name+'-broken.tap')).write_text(red.stdout+red.stderr)
  assert red.returncode != 0,name
 finally:p.write_text(original)
 green=subprocess.run(['node','--import','tsx','--test','--test-name-pattern='+pattern,testfile],cwd=root/cwd,capture_output=True,text=True)
 (ev/(name+'-restored.tap')).write_text(green.stdout+green.stderr)
 assert green.returncode == 0,name
 results.append({'guard':name,'brokenExit':red.returncode,'restoredExit':green.returncode})
(ev/'mutations.json').write_text(json.dumps(results,indent=2)+'\n')
print(json.dumps(results))
