from pathlib import Path
import json, subprocess
root=Path(__file__).resolve().parents[4]
path=root/'ui/src/components/charting/FollowingPicker.tsx'
cases=[
 ('G9a','{error && <p role="status">','{error && <p role="alert">','tests/examOverviewBoard.test.tsx'),
 ('G9b','if (!cancelled) setError(err instanceof Error ? err.message : String(err));','if (!cancelled) setError(undefined);','tests/followingPicker.test.tsx'),
]
results=[]
for guard,before,after,testfile in cases:
 original=path.read_text(); assert before in original
 command=['node','--import','tsx','--test','--test-name-pattern=S3b2 '+guard,testfile]
 def run():
  p=subprocess.run(command,cwd=root/'ui',text=True,capture_output=True)
  return {'exit':p.returncode,'summary':'\n'.join(line for line in (p.stdout+'\n'+p.stderr).splitlines() if line.startswith(('ok ','not ok ','# tests ','# pass ','# fail ','# skipped ')))}
 try:
  path.write_text(original.replace(before,after,1)); red=run()
 finally: path.write_text(original)
 green=run()
 results.append({'guard':guard,'command':' '.join(command),'cwd':'ui','red':red,'green':green})
 print(guard,'red',red['exit'],'green',green['exit'],flush=True)
 (root/'docs/build-log/followup-s3b2-picker/mutations-g9.json').write_text(json.dumps(results,indent=2)+'\n')
 assert red['exit']!=0 and green['exit']==0
