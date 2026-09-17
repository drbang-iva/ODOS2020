from pathlib import Path
import subprocess
p=Path('mcp/src/clinical-graph/custom-section-endpoint.ts')
original=p.read_text()
out=Path('docs/evidence/r10-a3-2')
mutations=[('editability-on-witness', 'if (reason && !(witness && ["signed-or-cancelled", "inactive-definition"].includes(reason)))', 'if (reason)'), ('skip-witness-match', 'if (!exact.has(factId(claim.key)) && !claimMatches(claim, context))', 'if (!witness && !exact.has(factId(claim.key)) && !claimMatches(claim, context))')]
command=['node','--import','tsx','--test','--test-name-pattern=W147','mcp/tests/r10A3OcularDoor.test.ts']
for name,anchor,replacement in mutations:
 if original.count(anchor)!=1: raise RuntimeError(f'ANCHOR_MISS {name}: {original.count(anchor)} matches')
 try:
  p.write_text(original.replace(anchor,replacement))
  r=subprocess.run(command,capture_output=True,text=True)
  (out/f'w147-{name}-red.log').write_text(r.stdout+r.stderr)
  if r.returncode==0: raise RuntimeError(f'MUTATION_SURVIVED {name}')
 finally: p.write_text(original)
 r=subprocess.run(command,capture_output=True,text=True)
 (out/f'w147-{name}-restored.log').write_text(r.stdout+r.stderr)
 if r.returncode: raise RuntimeError(f'RESTORE_FAILED {name}')
 print(f'{name}: red then restored green')
assert p.read_text()==original
