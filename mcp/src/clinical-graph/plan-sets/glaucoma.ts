import type { PlanSetSpec } from './types.js';
export const PENDING_ORDERABLES: ReadonlySet<string> = new Set(['corneal-hysteresis','erg','oct-angiography','anterior-segment-oct']);
const testDefinitions: Record<string, PlanSetSpec['tests'][number]> = {
  photos:{title:'Optic nerve photos',orderable:'fundus-photography',focus:'optic nerve',performContext:'in-office-today'},
  gonio:{title:'Gonioscopy',orderable:'gonioscopy',performContext:'in-office-today'},
  field:{title:'Automated perimetry',orderable:'visual-field-threshold',performContext:'schedule'},
  pachy:{title:'Corneal pachymetry',orderable:'corneal-pachymetry',performContext:'in-office-today'},
  oct:{title:'OCT optic nerve',orderable:'scodi-optic-nerve',performContext:'schedule'},
  hysteresis:{title:'Corneal hysteresis',orderable:'corneal-hysteresis',performContext:'schedule'},
  erg:{title:'ERG',orderable:'erg',performContext:'schedule'},
  phnr:{title:'ERG PhNR',orderable:'erg',performContext:'schedule'},
  octa:{title:'OCT angiography, optic nerve vessel density',orderable:'oct-angiography',performContext:'schedule'},
  asoct:{title:'Anterior segment OCT',orderable:'anterior-segment-oct',performContext:'schedule'},
};
function spec(key:string,title:string,families:string[],tests:string[],interval:number,unit:'weeks'|'months'='months',note?:string):PlanSetSpec {
  return {key,version:key==='glaucoma-suspect-initial'?2:1,title,families,tests:tests.map(k=>({...testDefinitions[k]})),counseling:[{title:`Counseling — ${title}`,topicKey:key,narrativeTemplate:`Discussed ${title.toLowerCase()}${note ? `: ${note}` : ""}. Questions answered.`}],handouts:[{title:`${title} handout`}],followUp:{title:`Follow-up — ${title}`,interval,unit,reason:`${title} monitoring`,followUpKind:'medical'},source:{eyefinity:true,note:'Operator-approved glaucoma plan-set content; unorderable tests and unavailable handouts are reported as hidden.'}};
}
const five=['photos','gonio','field','pachy','oct'];
export const GLAUCOMA_PLAN_SET_SPECS: PlanSetSpec[] = [
  spec('glaucoma-suspect-initial','Glaucoma suspect',['H40.00-','H40.01-','H40.02-'],[...five,'hysteresis','phnr','octa'],6),
  spec('glaucoma-oht','Ocular hypertension',['H40.05-'],[...five,'hysteresis'],6),
  spec('glaucoma-narrow-angle','Anatomical narrow angle',['H40.03-'],['gonio','pachy','photos','oct','asoct'],6,'months','angle-closure warning signs · medications that dilate (antihistamines, decongestants, anticholinergics)'),
  spec('glaucoma-pac','Primary angle closure without damage',['H40.06-'],['gonio','oct','field','photos','asoct'],1),
  spec('glaucoma-steroid-responder','Steroid responder',['H40.04-'],['oct','field','photos','pachy'],2,'weeks'),
  spec('glaucoma-poag','Primary open-angle glaucoma',['H40.11-'],[...five,'hysteresis','erg','octa'],3,'months','adherence and drop technique'),
  spec('glaucoma-ltg','Low-tension glaucoma',['H40.12-'],[...five,'hysteresis','erg','octa','asoct'],3),
];
