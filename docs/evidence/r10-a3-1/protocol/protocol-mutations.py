from pathlib import Path
import subprocess,json
root=Path.cwd();scratch=root/'.odos/r10-a3-1'
mutations=[
('W82-valued','protocol-service.ts','throw new ProtocolFindingWriteRefusal(422,"shared-finding-charted-in-ocular-health");','void 0;'),
('W82-preseed','protocol-endpoint.ts','await assertProtocolMutation(staff,parsed.data,definition ? selectedProtocolItems(definition.items,parsed.data.selections ?? []) : []);','void definition;'),
('W82-original-payload','protocol-service.ts','[payload,item.payload].some','[payload].some'),
('W91-closed','protocol-endpoint.ts','if (isClosedEncounter(encounter)) throw','if (false) throw'),
('W108-prebuild','protocol-endpoint.ts','if (sharedProjection.preRebuild) throw','if (false) throw'),
('W108-unapply-preflight','protocol-service.ts','await this.projection.validateMutation?.(application,[],[','await Promise.resolve([','...removalActions.flatMap(row=>row.materializedFhirRef ? [row.materializedFhirRef] : []),\n    ]);','...removalActions.flatMap(row=>row.materializedFhirRef ? [row.materializedFhirRef] : []),\n    ]);'),
('W108-restore','protocol-endpoint.ts','await validate?.();','void validate;'),
('V28-shared-removal','protocol-endpoint.ts','assertNotSharedFindingWrite(observation,findingDefinitions);','void observation;'),
('T22-real-restore','protocol-endpoint.ts','await updateProjected(fhir, resourceType, id, resource, { "If-Match": `W/"${revokedVersion}"` });','void resource;'),
('W107-eyes','protocol-service.ts','const entry=sharedEyes.get(key) ?? new Set<"OD"|"OS">();','const entry=new Set<"OD"|"OS">();'),
('W119-panel','protocol-service.ts','if (!panel.conflict && Object.keys(panel.values).length && panel.panelBaseline)','if (false)'),
('W114-stored','protocol-endpoint.ts','new FhirFindingDefinitionStore(staff.fhir).list()','new FhirFindingDefinitionStore({...staff.fhir,search:async()=>({resourceType:"Bundle",type:"searchset",entry:[]})} as any).list()'),
('V28-cleared','protocol-service.ts','if (fact.status === "live" && !fact.legacy)','if (!fact.legacy)'),
('V28-inactive','protocol-service.ts','d.active && sharedKeys.has(d.stableKey)','sharedKeys.has(d.stableKey)'),
]
results=[]
for name,file,*pairs in mutations:
 p=root/'mcp/src/clinical-graph'/file;original=p.read_bytes();text=original.decode()
 for a,b in zip(pairs[::2],pairs[1::2]):
  assert a in text,(name,a);text=text.replace(a,b,1)
 try:
  p.write_text(text);red=subprocess.run(['node','--import','tsx','--test','mcp/tests/r10A3Protocols.test.ts'],capture_output=True,text=True)
  (scratch/(name+'-protocol-red.tap')).write_text(red.stdout+red.stderr)
 finally:p.write_bytes(original)
 green=subprocess.run(['node','--import','tsx','--test','mcp/tests/r10A3Protocols.test.ts'],capture_output=True,text=True)
 (scratch/(name+'-protocol-green.tap')).write_text(green.stdout+green.stderr)
 results.append({'mutation':name,'red':red.returncode,'restored':green.returncode})
 if red.returncode==0 or green.returncode!=0:break
(scratch/'protocol-mutation-results.json').write_text(json.dumps(results,indent=2));print(json.dumps(results,indent=2))
