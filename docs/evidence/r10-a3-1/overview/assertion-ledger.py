from pathlib import Path
import subprocess,re,json
base='1706d7c8417b04791471d4332b4ecd712883bf11';out=Path('docs/evidence/r10-a3-1')
def read(file,old=False):return subprocess.check_output(['git','show',f'{base}:{file}'],text=True) if old else Path(file).read_text()
def testblock(s,needle):
 start=s.index('test("'+needle);end=s.index('\n});',start)+4;return start,s[start:end]
def assertions(s,needle):
 offset,block=testblock(s,needle);return [{'line':s[:offset+m.start()].count('\n')+1,'text':m.group(0)} for m in re.finditer(r'assert\.[\s\S]*?;',block)]
rows=[];file='mcp/tests/r10A3ReleaseScenarios.test.ts';old=read(file,True);new=read(file)
for slot,mapping in [('T7','V27'),('T8','W80'),('T9','W81/V27'),('T19','V28/W107/W119')]:
 before=assertions(old,slot+' ');after=assertions(new,slot+' ')
 for index,a in enumerate(before):
  b=after[1] if slot=='T19' else after[index]
  rows.append({'file':file,'slot':slot,'before':a,'after':b,'row':mapping,'change':'real handler/store fixture; todo removed; expected semantic result preserved'})
 if slot=='T19':
  for index in [0,2,3]:rows.append({'file':file,'slot':slot,'before':None,'after':after[index],'row':mapping,'change':'new handler response/prompt/eye assertion'})
file='mcp/tests/examOverviewProjection.test.ts';needle='Exams clinical completeness is traceable';old=read(file,True);new=read(file)
for a,b in zip(assertions(old,needle),assertions(new,needle)):
 assert a['text']==b['text'];rows.append({'file':file,'before':a,'after':b,'row':'V27/W81','change':'assertion byte-identical; fixture now real shared definition and explicit absent canonical fact'})
(out/'overview/assertion-migrations.json').write_text(json.dumps([r for r in rows if r.get('slot')!='T19'],indent=2)+'\n')
(out/'protocol/assertion-migrations.json').write_text(json.dumps([r for r in rows if r.get('slot')=='T19'],indent=2)+'\n')
fixtures=[{'file':'mcp/tests/examOverviewProjection.test.ts','before':{'line':512,'text':'definition("ocular-health:anterior:cornea", "ocular-health:anterior:cornea")'},'after':{'line':514,'text':'canonicalLens'},'row':'V27/W81'}, {'file':'mcp/tests/examOverviewProjection.test.ts','before':{'line':524,'text':'observation("ocular-health", "ocular-health:anterior:cornea", { component: [stringComponent("EXAM_STATE", "normal")] })'},'after':{'line':526,'text':'{...canonicalFact("ocular-health"),valueBoolean:false}'},'row':'V27/W81'}, {'file':'mcp/tests/dryEyeInitiationProtocols.test.ts','before':None,'after':{'line':379,'text':'fhir.add({resourceType:"Encounter",id:ENCOUNTER_ID,status:"in-progress",class:{code:"AMB"},subject:{reference:`Patient/${PATIENT_ID}`}});'},'row':'V24/W91','change':'Previously missing Encounter fixture; all original assertions retained'}]
(out/'overview/fixture-migrations.json').write_text(json.dumps(fixtures[:2],indent=2)+'\n');(out/'protocol/fixture-migrations.json').write_text(json.dumps(fixtures[2:],indent=2)+'\n')
print(json.dumps({'base':base,'assertions':len(rows),'fixtures':len(fixtures)}))
