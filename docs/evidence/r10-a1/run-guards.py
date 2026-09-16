"""Replay deliberate faults in a caller-supplied disposable copy, restoring every changed byte."""
import hashlib, json, pathlib, subprocess, sys
source=pathlib.Path(__file__).resolve().parents[3]
scratch=pathlib.Path(sys.argv[1]).resolve()
assert scratch != source and (scratch/'mcp/src/clinical-graph').is_dir()
out=source/'docs/evidence/r10-a1/guards'
out.mkdir(exist_ok=True)
identity='mcp/src/clinical-graph/current-finding-identity.ts'
reader='mcp/src/clinical-graph/current-finding-reader.ts'
mutations=[
 ('G1','mcp/src/clinical-graph/ocular-health-definition.ts','buildOcularHealthDefinitions(POSTERIOR_STRUCTURES,','buildOcularHealthDefinitions([POSTERIOR_STRUCTURES[1], POSTERIOR_STRUCTURES[0], ...POSTERIOR_STRUCTURES.slice(2)],','currentFindingIdentity.test.ts','compiled ocular'),
 ('G2',identity,'return catalog.find(row => row.atomicFindingId === atomicFindingId);','return catalog.find(row => row.atomicFindingId === atomicFindingId.split("::").slice(0, 3).join("::"));','currentFindingIdentity.test.ts','exact catalog'),
 ('G3',reader,'    if (translated) {','    view.component = view.component?.map(c => ({...c, code: {...c.code, coding: c.code.coding?.map(v => ({...v, code:v.code?.replace(/^(OD|OS)_/, "")}))}}));\n    if (translated) {','currentFindingReader.test.ts','raw sources are immutable'),
 ('G4a',reader,'const latest = group.filter(s => time(s.observation) === newest).sort(sourceOrder);','const latest = group.filter(s => time(s.observation) === group.map(v => time(v.observation)).sort()[0]).sort(sourceOrder);','currentFindingReader.test.ts','latest snapshot omission'),
 ('G4b',reader,'const canonical = group.filter(a => a.canonical);','const canonical = group.filter(a => a.canonical || (a.status === "retired" && a.contributor.kind === "legacy-atomic"));','currentFindingReader.test.ts','retired legacy atomic'),
 ('G4c',reader,'const canonical = group.filter(a => a.canonical);','const canonical = group.filter(a => a.canonical && a.status === "live");','currentFindingReader.test.ts','canonical fact dominates'),
 ('G5',identity,'laterality === "OU" ? ["OD", "OS"] : []','laterality === "OU" ? [] : []','currentFindingReader.test.ts','legacy OU expands'),
 ('G6',identity,'if (markers[0] === "urn:odos:negative-act") return { kind: "negative-act", definition };','if (markers[0] === "urn:odos:negative-act") return { kind: "legacy-section-snapshot", definition };','currentFindingReader.test.ts','negative act remains raw'),
 ('G7','mcp/tests/fixtures/r10/compat-rows.ts','  return projection.currentFacts.filter','  return [{atomicFindingId:"stale",presence:"present",laterality:"OD",source:"section",observationReference:"Observation/stale"}];\n  return projection.currentFacts.filter','r10-parity.test.ts','legacy fixture'),
 ('G8',reader,'if (state.incomplete) throw new Error(`Cannot project incomplete finding state: ${state.reason}`);','if (state.incomplete) return {currentFacts:[],panels:[],definitionViews:[],conflicts:[],unresolved:[]};','currentFindingReader.test.ts','loader traverses pages'),
 ('G9','mcp/src/clinical-graph/finding-section-helpers.ts','candidate.valueType === "multi-select"','candidate.valueType === "multi-selecu"','findingSectionHelpers.test.ts','history bytes unchanged'),
 ('G10',identity,'if (identifiers[0].value !== currentFindingIdentifier(key).value) return invalid("Identity hash mismatch.");','/* Deliberate mutation: trust an unchecked hash. */','currentFindingIdentity.test.ts','canonical envelope rejects hash'),
]
results=[]
for label,file,before,after,test,pattern in mutations:
 path=scratch/file; original=path.read_bytes();text=original.decode()
 assert text.count(before)==1,(label,'mutation site count',text.count(before))
 command=['node','--import','tsx','--test',f'--test-name-pattern={pattern}',f'tests/{test}']
 mutated=text.replace(before,after).encode()
 try:
  path.write_bytes(mutated)
  red=subprocess.run(command,cwd=scratch/'mcp',capture_output=True,text=True)
  (out/f'{label}-red.txt').write_text(red.stdout+red.stderr)
  assert red.returncode != 0 and 'ERR_ASSERTION' in red.stdout,(label,'not an assertion failure')
 finally:
  path.write_bytes(original)
 assert path.read_bytes()==original
 green=subprocess.run(command,cwd=scratch/'mcp',capture_output=True,text=True)
 (out/f'{label}-green.txt').write_text(green.stdout+green.stderr)
 assert green.returncode==0,(label,'restore did not pass')
 results.append({'guard':label,'file':file,'before':before,'mutation':after,'command':command,'cwd':'<scratch>/mcp','redExit':red.returncode,'greenExit':green.returncode,
   'originalSha256':hashlib.sha256(original).hexdigest(),'mutantSha256':hashlib.sha256(mutated).hexdigest(),'restoredSha256':hashlib.sha256(path.read_bytes()).hexdigest()})
 print(label,'RED',red.returncode,'GREEN',green.returncode,flush=True)
 (out/'results.json').write_text(json.dumps(results,indent=2)+'\n')
