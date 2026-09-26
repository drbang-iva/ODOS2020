import os,subprocess,sys,re
from pathlib import Path
root=Path(__file__).resolve().parents[3]
label,*args=sys.argv[1:]
env={k:v for k,v in os.environ.items() if not k.startswith(('ODOS_','MEDPLUM_'))}
assert not (root/'.odos/operator.env').exists()
assert not (root/'.odos/operator-identity.json').exists()
(root/'.odos/n1-evidence').mkdir(parents=True,exist_ok=True)
log=root/'.odos/n1-evidence'/f'{label}.log'
with log.open('w') as f:r=subprocess.run(args,cwd=root,env=env,stdout=f,stderr=subprocess.STDOUT)
lines=[l for l in log.read_text().splitlines() if re.match(r'^(# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)|not ok|# N1)',l)]
summary='\n'.join(lines)+f'\nexit={r.returncode}'
print(label+'\n'+summary)
(root/'.odos/n1-evidence'/f'{label}.summary').write_text(summary+'\n')
sys.exit(r.returncode)
