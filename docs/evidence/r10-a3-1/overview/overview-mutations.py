from pathlib import Path
import subprocess,json
root=Path.cwd(); scratch=root/'.odos/r10-a3-1'
mutations=[
('W80-homes','exam-overview-endpoint.ts','const linkedConditions = encounterConditions.map(','const ignoredLinkedConditions = encounterConditions.map(', 'const provenanceByObservation =','const linkedConditions = encounterConditions;\n    const provenanceByObservation ='),
('W81-inactive','exam-overview-projection.ts','d.active && d.valueSchema.type','d.valueSchema.type'),
('W81-context','exam-overview-projection.ts','Object.keys(panel.values).length && panel.panelBaseline','(panel.other || panel.remarks || panel.deferred || Object.keys(panel.values).length) && panel.panelBaseline'),
('W81-carry','exam-overview-projection.ts','if (!carriedWithoutCurrentEvidence.has(contributor.reference))','if (true)'),
('W118-values','exam-overview-projection.ts','if (Object.keys(panel.values).length && panel.panelBaseline)','if (false && panel.panelBaseline)'),
('W114-stored','diagnosis-completeness-endpoint.ts','new FhirFindingDefinitionStore(staff.fhir).list()','Promise.resolve(new FhirFindingDefinitionStore({ ...staff.fhir, search: async () => ({resourceType:"Bundle",type:"searchset",entry:[]}) } as any).list())'),
('V27-chart-change','exam-overview-endpoint.ts','if (!sameClinicalContent) continue;','if (false) continue;'),
('V27-reassert','exam-overview-endpoint.ts','if (!reasserted) carriedWithoutCurrentEvidence.add(reference);','carriedWithoutCurrentEvidence.add(reference);'),
('V27-legacy-view','exam-overview-projection.ts','const legacyViews = shared.preRebuild ?','const legacyViews = false ?'),
]
results=[]
for item in mutations:
 name,file,*pairs=item;p=root/'mcp/src/clinical-graph'/file;original=p.read_bytes();text=original.decode()
 for a,b in zip(pairs[::2],pairs[1::2]):
  assert a in text,(name,a);text=text.replace(a,b,1)
 try:
  p.write_text(text)
  red=subprocess.run(['node','--import','tsx','--test','mcp/tests/r10A3Overview.test.ts'],capture_output=True,text=True)
  (scratch/(name+'-overview-red.tap')).write_text(red.stdout+red.stderr)
 finally:p.write_bytes(original)
 green=subprocess.run(['node','--import','tsx','--test','mcp/tests/r10A3Overview.test.ts'],capture_output=True,text=True)
 (scratch/(name+'-overview-green.tap')).write_text(green.stdout+green.stderr)
 results.append({'mutation':name,'red':red.returncode,'restored':green.returncode})
 if red.returncode==0 or green.returncode!=0:break
(scratch/'overview-mutation-results.json').write_text(json.dumps(results,indent=2));print(json.dumps(results,indent=2))
