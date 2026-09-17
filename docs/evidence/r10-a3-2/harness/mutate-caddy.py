from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[4]
evidence = Path(__file__).resolve().parent
path = root/'.odos/r10-a3-2-served/Caddyfile'
original = path.read_text()
anchor = 'handle /clinical-graph* {'
assert original.count(anchor) == 1, 'W146 CADDY ANCHOR COUNT'
command = ['node', 'scripts/r10-served-route/check-caddy.mjs']
(evidence/'W146-command.txt').write_text(' '.join(command) + '\n')
try:
    path.write_text(original.replace(anchor, 'handle /wrong-path* {'))
    red = subprocess.run(command, cwd=root, capture_output=True, text=True)
    (evidence/'W146-generated-file-red.log').write_text(red.stdout + red.stderr + f'\nexit: {red.returncode}\n')
    assert red.returncode != 0 and 'line ' in red.stderr, 'W146 MUTATION SURVIVED OR NO LINE EVIDENCE'
    print('W146 generated-file mutant exit', red.returncode)
finally:
    path.write_text(original)
assert path.read_text() == original, 'W146 FILE RESTORE FAILED'
green = subprocess.run(command, cwd=root, capture_output=True, text=True)
(evidence/'W146-generated-file-green.log').write_text(green.stdout + green.stderr + f'\nexit: {green.returncode}\n')
assert green.returncode == 0
print('W146 restored exit', green.returncode)
(evidence/'generated-Caddyfile').write_text(original)
