from pathlib import Path
import subprocess, json, hashlib, sys, tempfile
root=Path(__file__).resolve().parents[2]; service=root/'mcp/src/clinical-graph/protocol-service.ts'; endpoint=root/'mcp/src/clinical-graph/protocol-endpoint.ts'
originals={service:service.read_text(),endpoint:endpoint.read_text()}; evidence=Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(tempfile.mkdtemp(prefix='protocol-sharing-')); evidence.mkdir(parents=True, exist_ok=True)
cases=[
 ('skip-item-dependency',service,'if (liveState.outcome === "already-applied") {','if (liveState.outcome === "already-applied") { return { application: liveState.application, alreadyApplied: true };','sibling charge|preserves shared records'),
 ('skip-action-liveness',service,'if (resolution.reason === "action-exists" && !actions.some','if (false && resolution.reason === "action-exists" && !actions.some','shared ownership J action: dead'),
 ('application-charge-dedupe',service,'row.encounterId === application.encounterId &&\n      row.procedureConceptKey === String(payload.procedureConceptKey)', 'row.protocolApplicationId === application.id &&\n      row.procedureConceptKey === String(payload.procedureConceptKey)', 'shared ownership (A:|D:)'),
 ('active-owner-only',service,'const existing = (await this.charges.list()).find((row) =>\n      row.encounterId', 'const activeOwners = new Set((await this.applications.list()).filter((row) => row.undoState === "active").map((row) => row.id));\n    const existing = (await this.charges.list()).find((row) =>\n      activeOwners.has(row.protocolApplicationId!) && row.encounterId', 'shared ownership H I'),
 ('skip-rehome',service,'if (!candidate) continue;\n      const resolution', 'if (candidate || !candidate) continue;\n      const resolution', 'shared ownership (A2|E):'),
 ('skip-charge-liveness',service,'if (resolution.reason === "charge-exists" && !charges.some','if (false && resolution.reason === "charge-exists" && !charges.some','shared ownership J:'),
 ('old-open-guard',service,' && normalizeApplicationScope(application) === "whole"\n    )) throw','\n    )) throw','whole-protocol open permits'),
 ('old-route-guard',endpoint,' && normalizeApplicationScope(application) === "whole"\n  )) return','\n  )) return','shared ownership C route'),
 ('drop-encounter-lock',service,'const IN_PROCESS_ENCOUNTER_LOCK = new InProcessProtocolItemAddLock();','const IN_PROCESS_ENCOUNTER_LOCK: ProtocolItemAddLock = { run: async (_key, operation) => operation() };','shared ownership K: paused commit'),
 ('drop-alternatives',service,', alternatives, needsConfirmation: true',', needsConfirmation: true','shared ownership L: sooner'),
]
summary=[]
source_hashes={str(path.relative_to(root)): hashlib.sha256(content.encode()).hexdigest() for path,content in originals.items()}
for path in originals:
 if subprocess.run(['git','diff','--quiet','HEAD','--',str(path)],cwd=root).returncode: raise SystemExit('Refusing mutations on a modified source file: '+str(path))
try:
 for name,path,old,new,pattern in cases:
  for p,v in originals.items():p.write_text(v)
  text=path.read_text(); assert old in text,name;path.write_text(text.replace(old,new,1))
  command=['node','--import','tsx','--test','--test-name-pattern='+pattern,'mcp/src/__tests__/protocol-phase5.test.ts']
  red=subprocess.run(command,cwd=root,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True); (evidence/(name+'-red.log')).write_text(red.stdout)
  path.write_text(originals[path]);green=subprocess.run(command,cwd=root,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True);(evidence/(name+'-green.log')).write_text(green.stdout)
  row={'mutation':name,'command':command,'sourceHashes':source_hashes,'redExit':red.returncode,'greenExit':green.returncode,'redCounts':[l for l in red.stdout.splitlines() if l.startswith(('# tests','# pass','# fail','# cancelled'))],'greenCounts':[l for l in green.stdout.splitlines() if l.startswith(('# tests','# pass','# fail','# cancelled'))]}; summary.append(row);print(json.dumps(row),flush=True)
finally:
 for p,v in originals.items():p.write_text(v)
(evidence/'mutations.json').write_text(json.dumps(summary,indent=2)+'\n')

print('Evidence: '+str(evidence))
if any(row['redExit'] == 0 or row['greenExit'] != 0 for row in summary): raise SystemExit(1)
