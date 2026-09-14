from pathlib import Path
import subprocess,json
root=Path(__file__).resolve().parents[3];ev=root/'docs/build-log/diagnosis-center-fixback'
guards=[
('most-recent-governs','mcp/src/clinical-graph/diagnosis-newness.ts','const latest = matches[0];','const latest = matches.find((row) => !row.condition.clinicalStatus?.coding?.some((coding) => coding.code === "resolved")) ?? matches[0];','mcp','most recent resolved supersedes','tests/diagnosisNewness.test.ts'),
('resolved-history','mcp/src/clinical-graph/diagnosis-newness.ts','value: latestVisit.every(isResolved) ?','value: false ?','mcp','suggestion: resolved prior','tests/diagnosisNewness.test.ts'),
('history-window','mcp/src/clinical-graph/diagnosis-newness.ts','date >= start || date < twelveMonthsBefore(start)','date >= start','mcp','outside twelve-month window','tests/diagnosisNewness.test.ts'),
('computed-override-precedence','mcp/src/clinical-graph/diagnosis-newness-endpoint.ts','if (choice) rows.push(choice);','if (false && choice) rows.push(choice);','mcp','doctor Established beats computed New','tests/diagnosisNewness.test.ts'),
('visit-signed','ui/src/components/charting/DiagnosisWorkspace.tsx','encounter.status === "finished" || Boolean(visitStatusError)','false || Boolean(visitStatusError)','ui','diagnosis status controls: finished','tests/diagnosisWorkspace.test.tsx'),
('newness-signed','ui/src/components/charting/DiagnosisWorkspace.tsx','encounter.status === "finished"}\n                      className','false}\n                      className','ui','diagnosis status controls: finished','tests/diagnosisWorkspace.test.tsx'),
('server-signed','mcp/src/clinical-graph/diagnosis-newness-endpoint.ts','if (encounter.status === "finished")','if (false)','mcp','newness endpoint locks','tests/diagnosisNewness.test.ts'),
('ranking-feed','ui/src/components/charting/AssessmentSection.tsx','diagnosisNewness[`Condition/${condition.id}`]),','undefined),','ui','Assessment ranking feed','tests/diagnosisNewness.test.tsx'),
('override-precedence','mcp/src/clinical-graph/diagnosis-newness.ts','if (override) return','if (false && override) return','mcp','explicit Established wins','tests/diagnosisNewness.test.ts'),
('assessment-pointer','ui/src/components/charting/AssessmentSection.tsx','onOpenDiagnosis?.(conditionReference)','onOpenDiagnosis?.("Condition/wrong")','ui','Assessment completion pointer','tests/diagnosisWorkspace.test.tsx'),
('status-degradation','ui/src/components/charting/DiagnosisWorkspace.tsx','() => ({ rows: [], error: "Visit status could not be loaded. Try again." })','() => { throw new Error("Status failure"); }','ui','diagnosis status controls: status-read-failure','tests/diagnosisWorkspace.test.tsx'),
]
results=[]
for name,file,old,new,cwd,pattern,testfile in guards:
 p=root/file;original=p.read_text();assert old in original,name
 try:
  p.write_text(original.replace(old,new,1));r=subprocess.run(['node','--import','tsx','--test','--test-name-pattern='+pattern,testfile],cwd=root/cwd,capture_output=True,text=True)
  (ev/(name+'-broken.tap')).write_text(r.stdout+r.stderr);red=r.returncode;assert red!=0,name
 finally:p.write_text(original)
 r=subprocess.run(['node','--import','tsx','--test','--test-name-pattern='+pattern,testfile],cwd=root/cwd,capture_output=True,text=True)
 (ev/(name+'-restored.tap')).write_text(r.stdout+r.stderr);assert r.returncode==0,name
 results.append({'guard':name,'brokenExit':red,'restoredExit':r.returncode})
(ev/'guards.json').write_text(json.dumps(results,indent=2)+'\n');print(json.dumps(results))
