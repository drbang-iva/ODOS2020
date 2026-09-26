import json, subprocess, re, sys
from pathlib import Path
root=Path(__file__).resolve().parents[3]
header='ui/src/components/charting/EncounterHeader.tsx'
scene='ui/src/scenes/EncounterCharting.tsx'
nav='ui/src/lib/exam-navigation.ts'
css='ui/src/styles/charting.css'
sheet='ui/src/components/charting/ExamEntrySheet.tsx'
files=json.loads(subprocess.check_output(['node','-e',"process.stdout.write(JSON.stringify(require('node:fs').globSync('tests/**/*.test.tsx').sort()))"],cwd=root/'ui',text=True))
l3='diagnosis.completeness.is.called.only.from.the.explicit.EncounterHeader.sign.path'
split='the.visit-level.control.is.disabled.with.the.amendment.tooltip.after.sign.and.absent.from.non-clinical.sheets'
review='ui/src/components/charting/ExamReview.tsx'
mutations=[
 ('F1-labels','N1.G6','N1 G6',[(review,'sectionStateLabel(row.state)','row.state')]),
 ('F2-unconfigured','N1.F2.unconfigured','N1 F2 unconfigured',[(review,'completeness.status === "unconfigured"','false')]),
 ('F2-unavailable','N1.F2.failed','N1 F2 failed',[(review,'<p>Status unavailable</p>','<p>Loading completeness…</p>')]),
 ('F3-disabled','N1.F3','N1 F3',[(review,'disabled={disabled}','disabled={false}')]),
 ('G1','N1.G1','N1 G1',[(nav,'["entrance", "Entrance"],','')]),
 ('G2','N1.G2','N1 G2',[(nav,'  const key = new URLSearchParams(search).get("exam");','  if (typeof window !== "undefined") window.localStorage.getItem("odos:encounter-chart-view");\n  const key = new URLSearchParams(search).get("exam");')]),
 ('G3','N1.G3','N1 G3',[(nav,'role === "tech" ? "pretest" : "overview"','role === "tech" ? "pretest" : "diagnoses"')]),
 ('G4','N1.G4','N1 G4',[
  ('ui/src/components/StartExam.tsx','import { openEncounter }','import { useViewState }'),
  ('ui/src/components/StartExam.tsx','  const [visitTypeId,','  const setView = useViewState(state => state.setView);\n  const [visitTypeId,'),
  ('ui/src/components/StartExam.tsx','openEncounter(patient.id, encounterId);','setView({ kind: "encounter", patientId: patient.id, encounterId });')]),
 ('G5','N1.G5','N1 G5',[(scene,'    if (entrySheetSection) {\n      entrySheetGuard.requestTransition(EXAM_DESTINATIONS','    if (false) {\n      entrySheetGuard.requestTransition(EXAM_DESTINATIONS')]),
 ('G6-header','N1.G6','N1 G6',[(header,'onReviewAndSign={() => onOpenReview?.()}','onReviewAndSign={requestFinishEncounter}')]),
 ('G7','N1.G7','N1 G7',[('ui/src/components/charting/ExamOverviewBoard.tsx','"In progress"','"Partial examination"')]),
 ('G8-width','N1.G8','N1 G8',[(css,'.odos-exam-navigation {\n  display: grid;','.odos-exam-navigation {\n  min-width: 1400px;\n  display: grid;')]),
 ('G8-modal','N1.G8','N1 G8',[(sheet,'const modal = sectionId === "engage";','const modal = sectionId === "visit-charges" || sectionId === "engage";')]),
 ('G8-cover','N1.G8','N1 G8',[(css,None,'\n.odos-exam-entry-layer:has(#visit-charges-sheet):not([hidden]) { position: fixed; inset: 0; width: 100vw; height: 100vh; z-index: 100; }\n')]),
 ('L3-slot',l3,'diagnosis completeness is called only',[(header,'onReviewAndSign','onReviewAndSignMutated')]),
 ('L3-handoff',l3,'diagnosis completeness is called only',[(header,'onSignAndFinish: requestFinishEncounter','onSignAndFinishMutated: requestFinishEncounter')]),
 ('G6-short','N1.G6','N1 G6',[(header,'odos-chart-bar-sign-short">Review</span>','odos-chart-bar-sign-short">Sign</span>')]),
 ('G6-stack','N1.G6','N1 G6',[(css,'.odos-sign-advisory { z-index: 60; }','.odos-sign-advisory { z-index: 50; }')]),
 ('R3-clear',split,'the visit-level control is disabled',[(sheet,'!nonClinical && encounterReference && onEncounterCleared','!modal && encounterReference && onEncounterCleared')]),
]
selection=set(sys.argv[1:])
for label,pattern,expected,edits in mutations:
 if selection and label not in selection:continue
 originals={p:(root/p).read_text() for p,_,_ in edits}
 print('START '+label,flush=True)
 try:
  for p,old,new in edits:
   target=root/p;s=target.read_text()
   if old is None:s+=new
   else:
    assert old in s,(label,p,old)
    s=s.replace(old,new)
   target.write_text(s)
  file='tests/diagnosisLinkL3.test.tsx' if label.startswith('L3-') else 'tests/encounterVoid.test.tsx' if label=='R3-clear' else 'tests/examNavigationN1.test.tsx'
  shard=f'{files.index(file)+1}/{len(files)}'
  print('SHARD '+file+' '+shard,flush=True)
  command=['python3','docs/build-log/exam-nav-n1/run.py',label+'-red','env',f'NODE_OPTIONS=--test-shard={shard} --test-name-pattern={pattern}','npm','--prefix','ui','test']
  red=subprocess.run(command,cwd=root)
 finally:
  for p,s in originals.items():(root/p).write_text(s)
 log=(root/'.odos/n1-evidence'/f'{label}-red.log').read_text()
 failed=re.findall(r'^not ok \d+ - (.+)$',log,re.M)
 if red.returncode==0 or not failed or any(not name.startswith(expected) for name in failed):
  print('STOP: unexpected mutation result '+label+' '+json.dumps(failed),flush=True);sys.exit(2)
 command[2]=label+'-green'
 green=subprocess.run(command,cwd=root)
 if green.returncode:
  print('STOP: restored state failed '+label,flush=True);sys.exit(3)
 for p,s in originals.items():assert (root/p).read_text()==s
 print('PROVED '+label,flush=True)
