from pathlib import Path
import subprocess, json, re, shlex
root=Path(__file__).resolve().parents[4]
store='mcp/src/clinical-graph/exam-scope-store.ts'
endpoint='mcp/src/clinical-graph/exam-overview-endpoint.ts'
board='ui/src/components/charting/ExamOverviewBoard.tsx'
projection='mcp/src/clinical-graph/exam-overview-projection.ts'
out=root/'docs/build-log/followup-s3b1-shape-record/mutations.json'
server='mcp/tests/examShapeRecord.test.ts'; scopes='mcp/tests/examScopeStore.test.ts'; ui='ui/tests/examOverviewBoard.test.tsx'; ends='mcp/tests/examOverviewEndpoint.test.ts'
write_existing=('return this.write(encounterId, "comprehensive", setBy, null, undefined, shape);','return this.write(encounterId, existing ? parseScope(existing).examScope as ExamScope : "comprehensive", setBy, existing?.meta?.versionId ?? null, existing, shape);')
cases=[
 ('G1',store,[('if (existing) return parseScope(existing);',''),write_existing],'S3b1 G1',[server]),
 ('G2a',store,[('const shape = ["profilesApplied", "sectionsOpen", "shapedAt"].some(key => key in value) ? shapeSchema.parse(value) : undefined;','const shape = shapeSchema.parse(value);')],'S3b1 G2',[ui]),
 ('G2b',store,[('if (existing) return parseScope(existing);','if (existing && parseScope(existing).shapedAt) return parseScope(existing);'),write_existing],'S3b1 G2',[ui]),
 ('G3',board,[('const editor = editorForFinding(group, editorEntries);', 'const editor = editorForFinding(group, editorEntries);\n    if (!(projection.sectionsOpen ?? []).includes(editor?.id ?? \"\")) continue;'),('return opened.has(editor.id) || groups.some','return (projection.sectionsOpen ?? []).includes(editor.id) && (opened.has(editor.id) || groups.some'),('(scopeDrawsRow && !editor.readOnly && (!definition.singleBlank || index === 0));','(scopeDrawsRow && !editor.readOnly && (!definition.singleBlank || index === 0)));')],'S3b1 G3',[ui]),
 ('G4-stale',store,[('if ((existing?.meta?.versionId ?? null) !== expectedVersion) throw concurrentEdit();','expectedVersion = existing?.meta?.versionId ?? null;')],'S2a scope store guards',[scopes]),
 ('G4-create',store,[('this.fhir.create(resource, { "If-None-Exist": `identifier=${encodeURIComponent(`${SCOPE_SYSTEM}|${encounterId}`)}` })','this.fhir.create(resource)')],'S3b1 G4 conditional',[server]),
 ('G4-token',store,[('if (persistedValue.writeToken !== writeToken) throw concurrentEdit();','')],'S3b1 G4 write-token',[server]),
 ('G5',store,[('({ profileKey, version, versionId })),','({ profileKey, versionId })),')],'S3b1 G5',[server]),
 ('G6',projection,[('const policy = Object.hasOwn(registry, examScope)','const visitTypeCategoryId = "medical";\n  const policy = Object.hasOwn(registry, visitTypeCategoryId)'),('? registry[examScope]','? registry[visitTypeCategoryId]')],'S2a G7',[ends]),
 ('G8',endpoint,[('// Opening the board must not depend on bookkeeping persistence.','throw error;\n        // Opening the board must not depend on bookkeeping persistence.')],'S3b1 G8',[ends,ui]),
 ('conflict-reread',endpoint,[('scope = await scopeStore.get(encounterId); } catch','scope = { examScope: "comprehensive" }; } catch')],'S3b1 conflict',[ends]),
 ('diagnosis-match',endpoint,[('families.has(normalizeFamily(family))','false')],'S3b1 overview freezes',[ends]),
]
results=[]
for name,file,replacements,pattern,tests in cases:
 path=root/file; original=path.read_text(); mutated=original
 for old,new in replacements:
  assert old in mutated,(name,old)
  mutated=mutated.replace(old,new,1)
 cmd=['node','--import','tsx','--test','--test-name-pattern='+pattern,*tests]
 def run():
  result=subprocess.run(cmd,cwd=root,capture_output=True,text=True)
  text=result.stdout+result.stderr
  summary='\n'.join(line for line in text.splitlines() if re.match(r'^(# (tests|pass|fail|skipped)|not ok)',line))
  return result.returncode,summary
 try:
  path.write_text(mutated); red_code,red=run()
 finally: path.write_text(original)
 green_code,green=run()
 results.append({'guard':name,'command':shlex.join(cmd),'redExit':red_code,'red':red,'greenExit':green_code,'green':green})
 out.write_text(json.dumps(results,indent=2)+'\n')
 print(name, 'RED',red_code,'GREEN',green_code,flush=True)
 assert red_code!=0 and green_code==0,(name,red,green)
