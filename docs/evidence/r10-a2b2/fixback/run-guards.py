from pathlib import Path
import subprocess, re, json

root = Path(__file__).resolve().parents[4]
out = Path(__file__).resolve().parent
workspace = root / 'ui/src/components/charting/DiagnosisWorkspace.tsx'
table = root / 'ui/src/components/charting/DiagnosisFindingsTable.tsx'
client = root / 'ui/src/lib/diagnosis-findings.ts'
originals = {p: p.read_text() for p in [workspace, table, client]}
mutations = {
 'W55': (workspace, [('''      const rows = previous.operation === "eye-change"
        ? findings.searchIndex.filter(row => row.atomicFindingId === atomicFindingId && row.kind === "fact" && row.status === "live")
        : targetRows;''', '      const rows = targetRows;')]),
 'W56': (client, [('o.clinicalWrite === "confirmed"', 'o.status === "applied"')]),
 'W57': (client, [('''return { status: 502, body: { result: "command", commandId: (body as {commandId:string}).commandId, complete: false, executionOrder: [0], outcomes: [{ status: "unconfirmed", clinicalWrite: "unknown", target: encounterReference, reason: "Response could not be confirmed." }] } };''', '''return { status: 502, body: { result: "unavailable", kind: "upstream", error: "Findings unavailable" } };''')]),
 'W58': (table, [('rows.every(r => r.carried && r.status === "live" && r.presence === "present")', 'rows.every(r => r.carried && r.status === "live")')]),
 'W59': (workspace, [('const canWriteDiagnosis = diagnosisAllowed && findings?.encounterEditable === true;', 'const canWriteDiagnosis = diagnosisAllowed;'), ('if (!findings?.encounterEditable || !findings.canWrite) return;', 'if (!findings?.canWrite) return;')]),
 'W60': (client, [('operation === "assert" || operation === "link" ? [...new Set', 'operation === "link" ? (selected ? [selected] : []) : operation === "assert" ? [...new Set')]),
 'W61': (client, [('operation === "move" ? (selected ? [selected] : []) :', 'operation === "move" ? [...new Set([...row.homes, ...(selected ? [selected] : [])])] :')]),
 'W62': (table, [('group.some(r => !r.editable || !r.key || !r.baseline)', 'group.some(r => !r.key || !r.baseline)')]),
 'W63': (workspace, [('      window.dispatchEvent(new CustomEvent("odos:encounter-findings-changed", { detail: { encounterReference } }));\n', '')]),
 'W64': (table, [('row.kind === "conflict" ? "Conflicting records" : charted ? "Charted" : "Offered"', 'charted ? "Charted" : "Offered"'), ('row.kind === "conflict" ? "Conflicting records" : charted ? "Saved" : "Choose presence"', 'charted ? "Saved" : "Choose presence"')]),
}

def run(guard, state):
 suite = 'r10DiagnosisTable' if guard in ['W58','W61','W62','W64'] else 'r10DiagnosisWorkspace'
 command = ['node','--import','tsx','--test',f'--test-name-pattern={guard}',f'tests/{suite}.test.tsx']
 result = subprocess.run(command, cwd=root/'ui', capture_output=True, text=True)
 log = (result.stdout+result.stderr).replace(str(root),'<repo>').replace('/Users/ericr.bang','<home>')
 (out/f'{guard}-{state}.tap').write_text(log)
 counts = {k:int(v) for k,v in re.findall(r'^# (tests|pass|fail|skipped|todo) (\d+)$', result.stdout, re.M)}
 counts['exit'] = result.returncode
 assert counts.get('tests',0)>0, counts
 return counts

results={}
try:
 for guard,(path,replacements) in mutations.items():
  text = originals[path]
  for before,after in replacements:
   assert before in text, (guard,before)
   if guard=='W59' and before.startswith('if '):
    start=text.index('  async function addDiagnosis(')
    text=text[:start]+text[start:].replace(before,after,1)
   else: text=text.replace(before,after,1)
  try:
   path.write_text(text)
   red=run(guard,'red')
  finally: path.write_text(originals[path])
  green=run(guard,'green')
  results[guard]={'red':red,'green':green}
  print(guard,json.dumps(results[guard]),flush=True)
  assert red['exit']!=0 and red['fail']>0, (guard,'survived',red)
  assert green['exit']==0 and green['fail']==0, (guard,'restoration failed',green)
finally:
 for path,text in originals.items(): path.write_text(text)
 (out/'counts.json').write_text(json.dumps(results,indent=2)+'\n')
