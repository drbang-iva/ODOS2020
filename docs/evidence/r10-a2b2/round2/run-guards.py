from pathlib import Path
import subprocess, re, json
root=Path(__file__).resolve().parents[4]
out=Path(__file__).resolve().parent
table=root/'ui/src/components/charting/DiagnosisFindingsTable.tsx'
workspace=root/'ui/src/components/charting/DiagnosisWorkspace.tsx'
originals={p:p.read_text() for p in [table,workspace]}
def run(guard,state,suite):
 result=subprocess.run(['node','--import','tsx','--test',f'--test-name-pattern={guard}',f'tests/{suite}.test.tsx'],cwd=root/'ui',capture_output=True,text=True)
 (out/f'{guard}-{state}.tap').write_text((result.stdout+result.stderr).replace(str(root),'<repo>'))
 counts={k:int(v) for k,v in re.findall(r'^# (tests|pass|fail|skipped|todo) (\d+)$',result.stdout,re.M)}
 counts['exit']=result.returncode
 return counts
results={}
try:
 s=originals[table];start=s.index('    const suggestions:');end=s.index('    return <div',start)
 old=subprocess.check_output(['git','show','b5376689:ui/src/components/charting/DiagnosisFindingsTable.tsx'],cwd=root,text=True)
 old=old[old.index('    const suggestions='):old.index('    return <div',old.index('    const suggestions='))]
 table.write_text(s[:start]+old+s[end:])
 red=run('W88','red','r10DiagnosisTable');table.write_text(s)
 green=run('W88','green','r10DiagnosisTable');results['W88']={'red':red,'green':green}
 s=originals[workspace]
 mutated=s.replace('    if (laterality && supportEye && laterality !== supportEye) return;','')
 mutated=mutated.replace('disabled: Boolean(supportingEyeUnion(pendingDiagnosis.supportingFacts) && supportingEyeUnion(pendingDiagnosis.supportingFacts) !== eye)','disabled: false')
 assert mutated!=s
 workspace.write_text(mutated)
 red=run('W89','red','r10DiagnosisWorkspace');workspace.write_text(s)
 green=run('W89','green','r10DiagnosisWorkspace');results['W89']={'red':red,'green':green}
 for guard,result in results.items():
  assert result['red']['fail']>0 and result['red']['exit']!=0,result
  assert result['green']['fail']==0 and result['green']['exit']==0,result
 print(json.dumps(results,indent=2))
finally:
 for p,s in originals.items():p.write_text(s)
 (out/'counts.json').write_text(json.dumps(results,indent=2)+'\n')
