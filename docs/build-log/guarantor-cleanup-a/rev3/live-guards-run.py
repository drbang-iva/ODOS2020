from pathlib import Path
import sys, subprocess, difflib, json, os

root, evidence, private = (Path(arg).resolve() for arg in sys.argv[1:4])
evidence.mkdir(parents=True, exist_ok=True)
mutants = [
 ('O13','mcp/src/clinic/guarantor-search.ts',', { "link:missing": "true" }','', 'live/rev3-scale.mjs'),
 ('O8-live','ui/src/components/patient/GuarantorLinkScreens.tsx','if(created)await discardGuarantor(created.personId,{reason:"Create new guarantor cancelled before confirming",expectedVersion:created.versionId});','', 'browser/live-browser.mjs'),
]
summary=[]
assert subprocess.check_output(['git','status','--porcelain'],cwd=root,text=True)==''
for label,path,old,new,script in mutants:
 file=root/path
 original=file.read_text()
 assert original.count(old)==1,(label,original.count(old))
 pictures={p:p.read_bytes() for p in (root/'docs/build-log/guarantor-cleanup-a/browser').glob('*.png')}
 def run(stage):
  env={**os.environ,'GUARANTOR_CLEANUP_A_SOURCE_ROOT':str(root),'GUARANTOR_CLEANUP_A_LIVE_DIR':str(private),'GUARANTOR_CLEANUP_A_EVIDENCE_DIR':str(evidence/f'{label}-{stage}-resources'),'PROOF_STAGE':stage}
  command=['node','--import','tsx',f'docs/build-log/guarantor-cleanup-a/{script}']
  result=subprocess.run(command,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,cwd=root,env=env)
  (evidence/f'{label}-{stage}.txt').write_text('$ '+' '.join(command)+'\n'+result.stdout.replace(str(root),'<repo>')+f'\nExit: {result.returncode}\n')
  for p,data in pictures.items():p.write_bytes(data)
  return result.returncode
 green=run('green');assert green==0,label
 mutated=original.replace(old,new)
 (evidence/f'{label}-mutant.diff').write_text(''.join(difflib.unified_diff(original.splitlines(True),mutated.splitlines(True),fromfile=path,tofile=path)))
 try:
  file.write_text(mutated);assert file.read_text()==mutated
  red=run('red')
 finally:
  file.write_text(original)
  for p,data in pictures.items():p.write_bytes(data)
 restored=run('restored')
 clean=subprocess.check_output(['git','status','--porcelain'],cwd=root,text=True)==''
 summary.append({'guard':label,'green':green,'red':red,'restored':restored,'restoredTreeClean':clean})
 (evidence/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
 print(json.dumps(summary[-1]),flush=True)
 assert red!=0 and restored==0 and clean,label
