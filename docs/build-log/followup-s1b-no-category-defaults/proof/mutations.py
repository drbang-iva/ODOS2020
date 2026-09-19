from pathlib import Path
import subprocess, json
root=Path.cwd(); out=root/'docs/build-log/followup-s1b-no-category-defaults/proof/guards'; out.mkdir(exist_ok=True)
e=root/'mcp/src/clinical-graph/finding-section-group-endpoint.ts'; s=root/'mcp/src/clinical-graph/finding-section-group-store.ts'; c=root/'mcp/src/clinical-graph/finding-section-content.ts'; u=root/'ui/src/components/settings/FindingSectionGroupsSettings.tsx'
base={p:p.read_text() for p in [e,s,c,u]}
def run(name,phase,side,pattern):
 cmd=['node','--import','tsx','--test','--test-name-pattern='+pattern,'tests/findingSectionGroup.test.ts' if side=='mcp' else 'tests/findingSectionGroups.test.tsx']
 r=subprocess.run(cmd,cwd=root/side,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
 (out/f'{name}-{phase}.txt').write_text('$ '+' '.join(cmd)+'\n'+r.stdout)
 return r.returncode
# Reintroduce the category computation, using the legacy stored field as the old resolver did.
g1=base[e].replace('    const effectiveGroupKeys =', '''    const legacyRows = await serviceFhir.search<import("@medplum/fhirtypes").Basic>("Basic", { code: "https://odos2020.com/fhir/CodeSystem/odos-finding-section-group|odos-finding-section-group" });
    const category = await resolveVisitTypeCategoryForEncounter(encounter, undefined, serviceFhir);
    const defaults = (legacyRows.entry ?? []).flatMap(({resource}) => {
      const raw = resource?.extension?.find(x => x.url.endsWith("odos-finding-section-group-json"))?.valueString;
      const group = raw && JSON.parse(raw);
      return group?.active && group.defaultForVisitTypeCategories?.includes(category) ? [group.groupKey] : [];
    });
    const effectiveGroupKeys =''').replace('[...pulledInGroupKeys, ...contentPinnedGroupKeys]', '[...defaults, ...pulledInGroupKeys, ...contentPinnedGroupKeys]')
g1='import { resolveVisitTypeCategoryForEncounter } from "../clinic/clinic-summary.js";\n'+g1
cases=[('G1',e,g1,'mcp','S1b G1'),
 ('G2',s,base[s].replace('JSON.stringify(validated)','JSON.stringify({ ...validated, defaultForVisitTypeCategories: ["dry-eye"] })',1),'mcp','S1b G2'),
 ('G3',e,base[e].replace('  active: z.boolean(),','  defaultForVisitTypeCategories: z.array(z.string()).optional(),\n  active: z.boolean(),').replace('  active: groupFields.active.optional(),','  defaultForVisitTypeCategories: groupFields.defaultForVisitTypeCategories,\n  active: groupFields.active.optional(),'),'mcp','S1b G3'),
 ('G4',c,base[c].replace('if (fact.status === "live") add(', 'add('),'mcp','S1b G4'),
 ('G5',e,base[e].replace('[...pulledInGroupKeys, ...contentPinnedGroupKeys]','[...pulledInGroupKeys]'),'mcp','S1 G[1-6]|S1b G4'),
 ('G6',u,base[u].replace('            <label className="mt-4 flex', '            <fieldset><legend>Default visit-type categories</legend><select aria-label="Default visit-type categories"><option>Dry Eye</option></select></fieldset>\n            <label className="mt-4 flex'),'ui','S1b G6')]
results=[]
for name,p,mutant,side,pattern in cases:
 assert mutant!=base[p]
 try:
  p.write_text(mutant); red=run(name,'red',side,pattern)
 finally: p.write_text(base[p])
 green=run(name,'green',side,pattern)
 results.append(dict(guard=name,redExit=red,greenExit=green))
 print(results[-1],flush=True)
 assert red!=0 and green==0
(out/'results.json').write_text(json.dumps(results,indent=2)+'\n')
r=subprocess.run(['git','diff','--stat','--','mcp/src/clinical-graph/finding-section-content.ts'],text=True,capture_output=True)
assert not r.stdout
(out/'G4-restored-diff.txt').write_text('$ git diff --stat -- mcp/src/clinical-graph/finding-section-content.ts\n'+r.stdout)
