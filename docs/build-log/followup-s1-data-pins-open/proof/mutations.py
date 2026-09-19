from pathlib import Path
import subprocess,json
root=Path(__file__).resolve().parents[4]
out=Path(__file__).parent/'guards';out.mkdir(exist_ok=True)
endpoint='mcp/src/clinical-graph/finding-section-group-endpoint.ts'
content='mcp/src/clinical-graph/finding-section-content.ts'
client='ui/src/lib/finding-section-groups.ts'
chart='ui/src/scenes/EncounterCharting.tsx'
server=['npm','--prefix','mcp','test','--','tests/findingSectionGroup.test.ts']
ui=['node','--import','tsx','--test','ui/tests/findingSectionGroups.test.tsx']
cases=[
 ('G1',endpoint,'if (sectionKeys.length) return','if (false) return',server),
 ('G2',content,'if (fact.status === "live") add','if (false) add',server),
 ('G3',endpoint,'...pulledInGroupKeys, ...contentPinnedGroupKeys','...pulledInGroupKeys',server),
 ('G4-server',endpoint,'groups.filter(group => group.sectionKeyPrefixes','groups.filter(group => group.active && group.sectionKeyPrefixes',server),
 ('G4-client',client,'pinned.has(group.groupKey) || (group.active && effective.has(group.groupKey))','group.active && effective.has(group.groupKey)',ui),
 ('G5',content,'if (observation.status === "entered-in-error") continue;','',server),
 ('G6',endpoint,'if (sectionKeys.length) return','if (true) return',server),
 ('G7',chart,'            ...(current.contentPinnedGroupKeys ?? []),','',ui),
 ('G8-questionnaire-score',content,'if (observation.code.coding?.some(code => questionnaireCodes.some(expected => code.system === expected.system && code.code === expected.code)))','if (false)',server),
 ('G8-questionnaire-response',content,'if (response.status !== "entered-in-error" &&','if (false &&',server),
 ('G8-image',content,'if (document.status !== "entered-in-error" &&','if (false &&',server),
 ('G8-score',content,'if (observation.meta?.profile?.includes(OBSERVATION_MEIBOMIAN_GLAND_SCORE_PROFILE_URL))','if (false)',server),
]
results=[]
for name,file,old,new,cmd in cases:
 p=root/file;s=p.read_text();assert s.count(old)==1,(name,s.count(old))
 try:
  p.write_text(s.replace(old,new));red=subprocess.run(cmd,cwd=root,capture_output=True,text=True)
  (out/f'{name}-red.txt').write_text(red.stdout+red.stderr)
 finally:p.write_text(s)
 green=subprocess.run(cmd,cwd=root,capture_output=True,text=True)
 (out/f'{name}-green.txt').write_text(green.stdout+green.stderr)
 result={'guard':name,'redExit':red.returncode,'greenExit':green.returncode,'command':' '.join(cmd)}
 results.append(result);print(json.dumps(result),flush=True)
 if red.returncode==0 or green.returncode!=0:raise RuntimeError(f'{name} mutation did not prove red and restored green')
(out/'results.json').write_text(json.dumps(results,indent=2)+'\n')
