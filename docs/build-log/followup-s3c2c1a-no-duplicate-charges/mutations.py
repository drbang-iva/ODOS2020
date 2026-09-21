import os
from pathlib import Path
import re
import subprocess

root = Path.cwd()
endpoint = root / 'mcp/src/clinical-graph/manual-procedure-charge-endpoint.ts'
client = root / 'ui/src/lib/clinical-graph-client.ts'
original = endpoint.read_bytes()
client_original = client.read_bytes()
s = original.decode()
lock = 'IN_PROCESS_ENCOUNTER_LOCK.run(params.data.encounterId, async () => {'
create_start = s.index('export async function handleProcedureChargeCreateRequest')
create_end = s.index('export async function handleProcedureChargePatchRequest')
create = s[create_start:create_end]
bypass = create.replace('return ' + lock, 'return (async () => {').replace('  });\n}', '  })();\n}')
mutations = {
 'G1': s.replace('if (await findLiveProcedureCharge(staff.fhir, params.data.encounterId, body.data.procedureConceptKey))', 'if (false)'),
 'G2': s.replace('if (body.data.state === "accepted" && proposal.state === "removed" &&', 'if (false && body.data.state === "accepted" && proposal.state === "removed" &&'),
 'G3': s[:create_start] + bypass + s[create_end:],
 'G4': s.replace('return ' + lock, 'return new (IN_PROCESS_ENCOUNTER_LOCK.constructor as new () => typeof IN_PROCESS_ENCOUNTER_LOCK)().run(params.data.encounterId, async () => {', 1),
 'G5': s.replace('proposal.state !== "removed" &&\n    proposal.id !== excludeProposalId', 'proposal.state === "accepted" &&\n    proposal.id !== excludeProposalId'),
 'G6': client_original.decode().replace('(response.status === 409 && body.code === "concurrent-edit")', 'response.status === 409'),
 'G7': s.replace('code: "duplicate-charge"', 'code: "concurrent-edit"'),
}
env = dict(os.environ)
if not env.get('ODOS_POSTGRES_URL'):
 raise SystemExit('ODOS_POSTGRES_URL required')
report = []
try:
 for guard, mutation in mutations.items():
  target = client if guard == 'G6' else endpoint
  baseline = client_original if guard == 'G6' else original
  assert mutation.encode() != baseline
  for phase in ['red', 'green']:
   target.write_bytes(mutation.encode() if phase == 'red' else baseline)
   cwd = root / 'ui' if guard == 'G6' else root / 'mcp'
   test = 'tests/procedureCharges.test.tsx' if guard == 'G6' else 'src/__tests__/procedure-charges.test.ts'
   command = ['node', '--import', 'tsx', '--test', f'--test-name-pattern=^{guard} ', test]
   run = subprocess.run(command, cwd=cwd, env=env, capture_output=True, text=True, timeout=30)
   output = run.stdout + run.stderr
   summary = '\n'.join(line for line in output.splitlines() if re.match(r'^(not ok |ok |# (tests|pass|fail|cancelled|skipped))', line))
   mismatch = re.search(r'Expected values to be strictly equal:\n(.*?)\n  code:', output, re.S)
   if mismatch:
    summary += '\n' + '\n'.join(line.strip() for line in mismatch.group(1).splitlines() if line.strip())
   report.append(f'{guard} {phase}: exit {run.returncode}\n{summary}')
   print(report[-1], flush=True)
   assert (run.returncode != 0) if phase == 'red' else (run.returncode == 0), f'{guard} {phase} failed expectation'
finally:
 endpoint.write_bytes(original)
 client.write_bytes(client_original)
 (root / 'docs/build-log/followup-s3c2c1a-no-duplicate-charges/guard-results.txt').write_text('\n\n'.join(report) + '\n')
 assert endpoint.read_bytes() == original
 assert client.read_bytes() == client_original
