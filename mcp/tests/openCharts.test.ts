import { buildProcedureFeeDefinition } from "../src/clinical-graph/procedure-fee-schedule.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { registerClinicRoutes } from "../src/clinic/clinic-routes.js";
import { buildProtocolBasic, PROTOCOL_BASIC_CODES } from "../src/clinical-graph/protocol-store.js";

const NOW = "2026-09-23T16:00:00Z";
const ZONE_CODE = "https://odos2020.com/fhir/CodeSystem/practice-time-zone-config|odos-practice-time-zone-config";
function setting(zone = "America/New_York", updated = "2026-09-23T12:00:00Z"): any {
  return { resourceType: "Basic", id: `zone-${updated}`, meta: { lastUpdated: updated }, code: { coding: [{ system: ZONE_CODE.split("|")[0], code: ZONE_CODE.split("|")[1] }] }, extension: [{ url: "https://odos2020.com/fhir/StructureDefinition/odos-practice-time-zone-config", valueString: JSON.stringify({ timeZone: zone }) }] };
}
function encounter(id: string, status = "in-progress", start: string | undefined = "2026-09-23T14:00:00Z", extra: any = {}): any {
  return { resourceType: "Encounter", id, status, class: { code: "AMB" }, subject: { reference: "Patient/p1" }, period: start ? { start } : undefined, ...extra };
}
function proposal(id: string, key: string): any {
  return buildProtocolBasic({ id: `proposal-${id}`, encounterId: id, state: "accepted", procedureConceptKey: key }, PROTOCOL_BASIC_CODES.chargeProposal);
}
function fixture(rows: any[] = [], now = NOW) {
  const reads: string[] = [], serviceReads: string[] = [];
  const state: any = { role: "provider", authenticated: true, env: "America/New_York", serviceRows: [], fail: undefined, serviceFail: false };
  const all = [{ resourceType: "Patient", id: "p1", name: [{ given: ["Synthetic"], family: "Patient" }] }, ...rows];
  const search = async (source: any[], log: string[], type: string, params: Record<string,string> = {}) => {
    log.push(type);
    if (log === serviceReads && state.serviceFail || log === reads && (state.fail === type || state.failEncounter && params.encounter?.split(",").includes(`Encounter/${state.failEncounter}`))) throw new Error("synthetic read failure");
    let result = source.filter(r => r.resourceType === type);
    for (const [key,value] of Object.entries(params)) {
      if (key === "_id") result = result.filter(r => value.split(",").includes(r.id));
      if (key === "status") result = result.filter(r => value.split(",").includes(r.status));
      if (key === "code") result = result.filter(r => r.code?.coding?.some((c: any) => value === `${c.system}|${c.code}`));
      if (key === "date") result = result.filter(r => r.period?.start && (value.startsWith("lt") ? Date.parse(r.period.start) < Date.parse(value.slice(2)) : Date.parse(r.period.start) >= Date.parse(value.slice(2))));
      if (["encounter", "context", "target"].includes(key)) result = result.filter(r => {
        const field = key === "encounter" && type === "DocumentReference" ? r.context?.encounter : r[key];
        return (Array.isArray(field) ? field : [field]).some(ref => value.split(",").includes(ref?.reference));
      });
    }
    if (params._sort) result.sort((a,b) => (params._sort === "-_lastUpdated" ? (b.meta?.lastUpdated ?? "").localeCompare(a.meta?.lastUpdated ?? "") : (b.period?.start ?? "").localeCompare(a.period?.start ?? "")));
    const offset = Number(params._offset ?? 0), count = Number(params._count ?? result.length + 1);
    const page = result.slice(offset, offset + count);
    return { resourceType: "Bundle", type: "searchset", entry: page.map(resource => ({resource})), ...(offset + count < result.length ? {link:[{relation:"next",url:`http://localhost:18103/fhir/R4/${type}?${new URLSearchParams({...params,_offset:String(offset+count)})}`}]} : {}) };
  };
  const client = (source: any[], log: string[]): any => ({ baseUrl: "http://localhost:18103/", search: (type: string, params: any) => search(source,log,type,params), searchUrl: (url: string,type: string) => search(source,log,type,Object.fromEntries(new URL(url,"http://localhost:18103/").searchParams)), create: async () => assert.fail("read only"), update: async () => assert.fail("read only"), read: async (type: string,id: string) => source.find(r=>r.resourceType===type&&r.id===id) });
  const fhir = client(all,reads), serviceFhir = client(state.serviceRows,serviceReads);
  async function request(path = "/clinic/open-charts", expand = false) {
    const handlers = new Map<string,any>();
    registerClinicRoutes({get:(path: string,...routeHandlers: any[])=>handlers.set(path,routeHandlers.at(-1)),post:()=>{}} as any, {authenticateService: async()=>{},authenticate:async()=>state.authenticated?{staffReference:"Practitioner/caller",actorRole:state.role,roles:[state.role],fhir}:null,timeZone:state.env,now:()=>now,serviceFhir} as any);
    assert.ok(handlers.has(path), `registered route ${path}`);
    let status=200, body:any;
    const res:any={status:(code:number)=>{status=code;return res;},json:(value:any)=>{body=value;return res;},setHeader:()=>{},headersSent:false};
    await handlers.get(path)({header:()=>state.authenticated?"Bearer synthetic":undefined,query:expand?{expand:"older"}:{}},res);
    return {status,body};
  }
  return {state,all,reads,serviceReads,request};
}
const ids = (rows: any[]) => rows.map(r=>r.encounterId);

test("O1 M1 statuses included; signed and excluded statuses absent", async()=>{
 const f=fixture([...["arrived","triaged","in-progress","cancelled","entered-in-error"].map(s=>encounter(s,s)),encounter("signed","finished",undefined,{period:{start:"2026-09-23T12:00:00Z",end:NOW}}),{resourceType:"Provenance",recorded:NOW,target:[{reference:"Encounter/signed"}]}]);
 const r=await f.request();assert.equal(r.status,200);assert.deepEqual(ids(r.body.today.rows).sort(),["arrived","in-progress","triaged"]);
});
test("O2 M4 statuses belong only to needs review",async()=>{const r=await fixture(["planned","onleave","unknown"].map(s=>encounter(s,s))).request();assert.deepEqual(ids(r.body.needsReview).sort(),["onleave","planned","unknown"]);assert.equal(r.body.today.rows.length,0);assert.match(r.body.needsReview[0].reason,/not one ODOS writes/);});
test("O3 migrated unfinished and finished excluded",async()=>{const r=await fixture(["arrived","finished"].map(s=>encounter(s,s,undefined,{period:{start:NOW},meta:{tag:[{system:"https://odos2020.com/tags/migration",code:"eyefinity-import"}]}}))).request();assert.equal(r.body.today.rows.length,0);assert.equal(r.body.needsReview.length,0);});
test("O4 finished window and exact sign-off instant",async()=>{const r=await fixture([encounter("six","finished","2026-09-17T14:00:00Z"),encounter("seven","finished","2026-09-16T14:00:00Z"),encounter("near","finished",NOW,{period:{start:NOW,end:NOW}}),encounter("exact","finished",NOW,{period:{start:NOW,end:NOW}}),{resourceType:"Provenance",target:[{reference:"Encounter/near"}],recorded:"2026-09-23T16:00:00.001Z"},{resourceType:"Provenance",target:[{reference:"Encounter/exact"}],recorded:NOW}]).request();assert.deepEqual(ids(r.body.today.rows),["near"]);assert.deepEqual(ids(r.body.lastClinicDay.rows),["six"]);assert.equal(r.body.counts.signatureMissing,2);});
for(const status of ["noshow","cancelled","entered-in-error"]) test(`O5 appointment ${status} needs review`,async()=>{const r=await fixture([encounter("e","arrived",NOW,{appointment:[{reference:"Appointment/a"}]}),{resourceType:"Appointment",id:"a",status}]).request();assert.equal(r.body.today.rows.length,0);assert.equal(r.body.needsReview[0].reason,`Appointment ${status}, chart still open`);});
test("O6 missing service date needs review",async()=>{const r=await fixture([encounter("e","arrived",undefined,{period:undefined})]).request();assert.equal(r.body.needsReview[0].reason,"No service date");assert.equal(r.body.today.rows.length,0);});
test("O7 walk-in does not need an Appointment",async()=>{const r=await fixture([encounter("walk")]).request();assert.deepEqual(ids(r.body.today.rows),["walk"]);assert.deepEqual(r.body.today.rows[0].owner,{unassigned:true});});
test("O8 zone edge and DST local dates",async()=>{const edge=await fixture([encounter("edge","arrived","2026-09-23T03:30:00Z")]).request();assert.equal(edge.body.lastClinicDay.date,"2026-09-22");const dst=await fixture([encounter("oct","arrived","2026-11-01T03:30:00Z"),encounter("nov","arrived","2026-11-01T04:30:00Z")],"2026-11-01T17:00:00Z").request();assert.deepEqual(ids(dst.body.today.rows),["nov"]);assert.equal(dst.body.lastClinicDay.date,"2026-10-31");assert.deepEqual(ids(dst.body.lastClinicDay.rows),["oct"]);});
test("O9 overnight visit stays on start date",async()=>{const r=await fixture([encounter("overnight","in-progress","2026-09-23T03:50:00Z")]).request();assert.equal(r.body.today.rows.length,0);assert.equal(r.body.lastClinicDay.rows[0].serviceDate,"2026-09-22");});
test("O10 rescheduled appointment cannot change service date",async()=>{const r=await fixture([encounter("e","arrived",NOW,{appointment:[{reference:"Appointment/a"}]}),{resourceType:"Appointment",id:"a",status:"booked",start:"2026-09-22T12:00:00Z"}]).request();assert.deepEqual(ids(r.body.today.rows),["e"]);});
test("O11 last clinic day skips weekends and cancelled-only days",async()=>{const r=await fixture([encounter("fri","arrived","2026-09-18T14:00:00Z"),encounter("sat","cancelled","2026-09-19T14:00:00Z"),encounter("sun","finished","2026-09-20T14:00:00Z",{meta:{tag:[{system:"https://odos2020.com/tags/migration",code:"eyefinity-import"}]}})],"2026-09-21T16:00:00Z").request();assert.equal(r.body.lastClinicDay.date,"2026-09-18");const empty=await fixture([encounter("today")]).request();assert.equal(empty.body.lastClinicDay,null);});
test("O12 all buckets newest first, undated review last",async()=>{const r=await fixture([encounter("early","arrived","2026-09-23T12:00:00Z"),encounter("late","arrived",NOW),encounter("undated","planned",NOW,{period:undefined}),encounter("review","planned",NOW)]).request();assert.deepEqual(ids(r.body.today.rows),["late","early"]);assert.deepEqual(ids(r.body.needsReview),["review","undated"]);});
test("O13 participant then appointment then Unassigned",async()=>{const r=await fixture([encounter("participant","arrived",NOW,{participant:[{individual:{reference:"RelatedPerson/x"}},{individual:{reference:"Practitioner/p"}}],appointment:[{reference:"Appointment/a"}]}),encounter("appointment","arrived",NOW,{appointment:[{reference:"Appointment/a"}]}),encounter("walk"),{resourceType:"Appointment",id:"a",status:"booked",participant:[{actor:{reference:"Practitioner/a"}}]},{resourceType:"Practitioner",id:"p",name:[{text:"Synthetic Provider"}]},{resourceType:"Practitioner",id:"a",name:[{text:"Synthetic Appointment Owner"}]}]).request();assert.equal(r.body.today.rows.find((r:any)=>r.encounterId==="participant").owner.reference,"Practitioner/p");assert.equal(r.body.today.rows.find((r:any)=>r.encounterId==="appointment").owner.reference,"Practitioner/a");assert.deepEqual(r.body.today.rows.find((r:any)=>r.encounterId==="walk").owner,{unassigned:true});});
test("O14 content, no content, and failed content read",async()=>{const f=fixture([encounter("content"),encounter("empty"),{resourceType:"Observation",id:"o",status:"final",encounter:{reference:"Encounter/content"}}]);let r=await f.request();assert.equal(r.body.today.rows.find((r:any)=>r.encounterId==="content").kind,"open");assert.equal(r.body.today.rows.find((r:any)=>r.encounterId==="empty").kind,"nothing-charted");f.state.fail="Observation";r=await f.request();assert.equal(r.status,200);for(const row of r.body.today.rows){assert.equal(row.kind,"open");assert.deepEqual(row.reasons,[{code:"checks-unavailable"}]);}});
test("O15 malformed proposal anywhere makes checks unavailable",async()=>{const f=fixture([encounter("e"),{resourceType:"Observation",status:"final",encounter:{reference:"Encounter/e"}},proposal("other","custom")]);const malformed=f.all.find(r=>r.resourceType==="Basic");malformed.extension[0].valueString="{";const r=await f.request();assert.equal(r.status,200);assert.deepEqual(r.body.today.rows[0].reasons,[{code:"checks-unavailable"}]);});
test("O15 no interpretation blockers is none-found",async()=>{const r=await fixture([encounter("e"),{resourceType:"Observation",status:"final",encounter:{reference:"Encounter/e"}}]).request();assert.deepEqual(r.body.today.rows[0].reasons,[{code:"none-found",label:"No interpretation blockers found"}]);});
test("O16 older counts and expansion",async()=>{const f=fixture([encounter("last","arrived","2026-09-22T14:00:00Z"),encounter("old1","arrived","2026-09-18T14:00:00Z"),encounter("old2","arrived","2026-09-17T14:00:00Z")]);const r=await f.request();assert.equal(r.body.older.count,2);assert.equal(r.body.older.oldestServiceDate,"2026-09-17");assert.equal("rows" in r.body.older,false);assert.deepEqual(r.body.older.byOwner,[{owner:{unassigned:true},count:2,oldestServiceDate:"2026-09-17"}]);const expanded=await f.request("/clinic/open-charts",true);assert.deepEqual(ids(expanded.body.older.rows),["old1","old2"]);for(const row of expanded.body.older.rows)assert.deepEqual(row.reasons,[{code:"nothing-charted"}]);});
test("O17 bounded candidate reads keep newest and name the incomplete leg",async()=>{const f=fixture(Array.from({length:1001},(_,i)=>encounter(`e${i}`,"arrived",new Date(Date.parse(NOW)-i*1000).toISOString())));const r=await f.request("/clinic/open-charts/desk");assert.equal(r.status,200);assert.equal(r.body.complete,false);assert.ok(r.body.incomplete.includes("unfinished"));assert.equal(r.body.today.rows.length,1000);assert.equal(r.body.today.rows[0].serviceStart,NOW.replace("Z",".000Z"));});
test("O18 desk exact allowlist, no clinical reads or abnormal rows",async()=>{const f=fixture([encounter("open"),encounter("signed-missing","finished"),encounter("review","planned")]);const r=await f.request("/clinic/open-charts/desk");assert.deepEqual(Object.keys(r.body).sort(),["complete","lastClinicDay","older","timeZone","timeZoneSource","today"]);assert.deepEqual(Object.keys(r.body.today).sort(),["count","date","rows"]);assert.deepEqual(Object.keys(r.body.older).sort(),["byOwner","count"]);assert.equal(r.body.today.count,1);assert.deepEqual(Object.keys(r.body.today.rows[0]).sort(),["owner","patient","priorDay","serviceDate","serviceStart","status"]);assert.deepEqual(Object.keys(r.body.today.rows[0].patient).sort(),["name","reference"]);assert.deepEqual(r.body.today.rows[0].owner,{unassigned:true});assert.equal(r.body.today.rows[0].status,"chart open");assert.equal(r.body.today.rows[0].priorDay,false);assert.ok(f.reads.every(type=>["Encounter","Appointment","Patient","Practitioner","Provenance","Basic"].includes(type)));});
test("O19 route authentication and business actions",async()=>{for(const role of ["provider","staff","admin"]){const f=fixture();f.state.role=role;assert.equal((await f.request()).status,role==="provider"?200:403);assert.equal((await f.request("/clinic/open-charts/desk")).status,200);f.state.authenticated=false;assert.equal((await f.request()).status,401);assert.equal((await f.request("/clinic/open-charts/desk")).status,401);}});
test("O20 Z1 stored valid zone wins through service identity",async()=>{const f=fixture();f.state.serviceRows.push(setting("America/Chicago"));const r=await f.request();assert.equal(r.body.timeZone,"America/Chicago");assert.equal(r.body.timeZoneSource,"setting");assert.equal(f.reads.includes("Basic"),false);});
test("O20 Z2 invalid stored value never falls back",async()=>{for(const bad of [setting("not-a-zone"),{...setting(),extension:[]}]){const f=fixture();f.state.serviceRows.push(bad);const r=await f.request();assert.equal(r.status,409);assert.deepEqual(r.body,{code:"practice-time-zone-invalid"});}});
test("O20 Z3 newest setting plus warning",async()=>{const f=fixture();f.state.serviceRows.push(setting("America/Chicago","2026-09-22T12:00:00Z"),setting("America/Denver"));const r=await f.request();assert.equal(r.body.timeZone,"America/Denver");assert.equal(r.body.warnings.length,1);});
test("O20 Z4 absent uses valid environment",async()=>{const r=await fixture().request();assert.equal(r.body.timeZoneSource,"environment");assert.equal(r.body.timeZone,"America/New_York");});
test("O20 Z5 absent and invalid environment refuses",async()=>{for(const env of [undefined,"invalid"]){const f=fixture();f.state.env=env;const r=await f.request();assert.equal(r.status,409);assert.deepEqual(r.body,{code:"practice-time-zone-unset"});}});
test("O20 Z6 service read failure never falls back",async()=>{const f=fixture();f.state.serviceFail=true;const r=await f.request();assert.equal(r.status,502);assert.deepEqual(r.body,{code:"practice-time-zone-unreadable"});});

for (const reason of ["duplicate-fee", "unclassified-fee", "no-interpreted-result", "needs-interpretation"] as const) test(`O15 gate reason ${reason} preserves its label`, async()=>{
 const key="synthetic-imaging";
 const f=fixture([encounter("e"),proposal("e",key)]);
 if(reason!=="unclassified-fee")f.state.serviceRows.push(buildProcedureFeeDefinition({procedureConceptKey:key,display:"Synthetic imaging",interpretation:"oct"}));
 if(reason==="duplicate-fee")f.state.serviceRows.push(buildProcedureFeeDefinition({procedureConceptKey:key,display:"Synthetic imaging duplicate",interpretation:"oct"}));
 if(reason==="needs-interpretation")f.all.push(buildProtocolBasic({id:"action",encounterId:"e",state:"selected",actionType:"order",payload:{orderableKey:key},materializedFhirRef:"ServiceRequest/order"},PROTOCOL_BASIC_CODES.planActionInstance));
 const r=await f.request();assert.equal(r.status,200);assert.deepEqual(r.body.today.rows[0].reasons,[{code:reason,label:reason==="unclassified-fee"?key:"Synthetic imaging"}]);
 assert.equal(f.serviceReads.filter(t=>t==="ChargeItemDefinition").length,1);
 assert.equal(f.reads.filter(t=>t==="Basic").length,2);
});
test("O14 gate-input read failure cannot erase existing content",async()=>{const f=fixture([encounter("e"),proposal("e","synthetic")]);f.state.serviceRows.push(buildProcedureFeeDefinition({procedureConceptKey:"synthetic",display:"Synthetic",interpretation:"oct"}));const original=f.state.serviceRows[0];Object.defineProperty(original,"title",{get(){throw new Error("synthetic unreadable fee");}});const r=await f.request();assert.equal(r.status,200);assert.equal(r.body.today.rows[0].kind,"open");assert.deepEqual(r.body.today.rows[0].reasons,[{code:"checks-unavailable"}]);});
test("doctor content is batched and collapsed older rows are not read",async()=>{const f=fixture([encounter("today"),encounter("last","arrived","2026-09-22T14:00:00Z"),encounter("old","arrived","2026-09-18T14:00:00Z")]);await f.request();assert.equal(f.reads.filter(t=>t==="Observation").length,1);assert.equal(f.reads.filter(t=>t==="Basic").length,2);});
test("O17 provenance bound returns partial response instead of 500",async()=>{const f=fixture([encounter("e","finished",NOW,{period:{start:NOW,end:NOW}}),...Array.from({length:1001},(_,i)=>({resourceType:"Provenance",id:`p${i}`,recorded:NOW,target:[{reference:"Encounter/e"}]}))]);const r=await f.request();assert.equal(r.status,200);assert.equal(r.body.complete,false);assert.ok(r.body.incomplete.includes("provenance"));});
test("historical clinic-day lookup stops at newest eligible visit",async()=>{const f=fixture(Array.from({length:1001},(_,i)=>encounter(`past${i}`,"finished","2026-09-10T14:00:00Z")));const r=await f.request();assert.equal(r.status,200);assert.equal(r.body.complete,true);assert.equal(r.body.lastClinicDay.date,"2026-09-10");});
test("historical clinic-day lookup marks an exhausted ineligible bound",async()=>{const f=fixture(Array.from({length:1001},(_,i)=>encounter(`past${i}`,"cancelled","2026-09-10T14:00:00Z")));const r=await f.request();assert.equal(r.status,200);assert.equal(r.body.complete,false);assert.ok(r.body.incomplete.includes("last-clinic-day"));});
test("R4 counts and older count never depend on expansion",async()=>{const f=fixture([encounter("today"),encounter("last","arrived","2026-09-22T14:00:00Z"),encounter("old","arrived","2026-09-18T14:00:00Z"),encounter("review","planned")]);const collapsed=await f.request();const expanded=await f.request("/clinic/open-charts",true);assert.deepEqual(expanded.body.counts,collapsed.body.counts);assert.equal(expanded.body.older.count,collapsed.body.older.count);assert.equal(expanded.body.older.count,1);assert.equal(expanded.body.counts.nothingCharted,2);assert.equal(expanded.body.counts.needsReview,1);});

test("R4 expanded older read failure cannot change current counts",async()=>{const f=fixture([encounter("today"),encounter("last","arrived","2026-09-22T14:00:00Z"),encounter("old","arrived","2026-09-18T14:00:00Z")]);f.state.failEncounter="old";const collapsed=await f.request();const expanded=await f.request("/clinic/open-charts",true);assert.deepEqual(expanded.body.counts,collapsed.body.counts);assert.equal(expanded.body.older.count,collapsed.body.older.count);assert.deepEqual(expanded.body.older.rows[0].reasons,[{code:"checks-unavailable"}]);});
test("O12 last clinic day and expanded older rows are newest first",async()=>{
 const f=fixture([encounter("last-early","arrived","2026-09-22T12:00:00Z"),encounter("last-late","arrived","2026-09-22T15:00:00Z"),encounter("old-early","arrived","2026-09-18T12:00:00Z"),encounter("old-late","arrived","2026-09-18T15:00:00Z")]);
 const r=await f.request("/clinic/open-charts",true);assert.deepEqual(ids(r.body.lastClinicDay.rows),["last-late","last-early"]);assert.deepEqual(ids(r.body.older.rows),["old-late","old-early"]);
});
test("O18 desk deep keys include prior rows and assigned older owners only",async()=>{
 const owner={participant:[{individual:{reference:"Practitioner/p"}}]};
 const f=fixture([encounter("today","arrived",NOW,owner),encounter("last","arrived","2026-09-22T14:00:00Z",owner),encounter("old","arrived","2026-09-18T14:00:00Z",owner)]);
 const r=await f.request("/clinic/open-charts/desk");
 function keys(value:any,path=""):string[]{if(Array.isArray(value))return [...new Set(value.flatMap(item=>keys(item,`${path}[]`)))].sort();if(!value||typeof value!=="object")return [];return Object.entries(value).flatMap(([key,item])=>[`${path}.${key}`,...keys(item,`${path}.${key}`)]).sort();}
 assert.deepEqual(keys(r.body),keys({complete:true,timeZone:"",timeZoneSource:"",today:{date:"",count:0,rows:[{patient:{reference:"",name:""},owner:{reference:"",name:""},serviceStart:"",serviceDate:"",status:"",priorDay:false}]},lastClinicDay:{date:"",count:0,rows:[{patient:{reference:"",name:""},owner:{reference:"",name:""},serviceStart:"",serviceDate:"",status:"",priorDay:true}]},older:{count:0,byOwner:[{owner:{reference:"",name:""},count:0,oldestServiceDate:""}]}}));
 assert.equal(r.body.lastClinicDay.rows[0].priorDay,true);
});
