import { createHash } from "node:crypto";
import type { Bundle, Observation, ObservationComponent, Provenance, Resource } from "@medplum/fhirtypes";
import type { MedplumClient } from "../fhir-client.js";
import { collectAllFhirSearchPages } from "../fhir-search.js";
import { ODOS_EXTENSION_URLS, lateralityConcept, odosConcept } from "../fhir/ophthalmology/extensions.js";
import { buildProvenance } from "../fhir/ophthalmology/provenance.js";
import { customFieldEntries, type FindingQualifierValue } from "./custom-fields.js";
import type { AtomicFindingCatalogRow } from "./diagnosis-findings-endpoint.js";
import { DIAGNOSIS_FINDING_REASSERTION_CODE, ODOS_PROVENANCE_ACTIVITY_CODE_SYSTEM } from "./diagnosis-carry-provenance.js";
import type { ClinicalFindingDefinition } from "./glaucoma-suspect.js";
import { buildFindingReadAliases } from "./finding-read-aliases.js";
import { classifyFindingObservation, currentFindingIdentifier, currentFindingKeySchema, findPendingAudits, findingAuditKey, findingQualifiers,
  FINDING_OPERATION_AUDIT_SYSTEM, observationLaterality, parseCurrentFindingEnvelope, parseFindingOperation, SUPPORTS_DIAGNOSIS_URL,
  type CurrentFindingKey, type FindingOperation } from "./current-finding-identity.js";
import { loadEncounterFindingState, projectCurrentFindings, type EncounterFindingState, type FindingBaseline, type CurrentFindingProjection } from "./current-finding-reader.js";
import { isLiveObservation } from "./observation-liveness.js";

export { findPendingAudits } from "./current-finding-identity.js";

export type FindingCommandTarget =
  | { kind: "fact"; key: CurrentFindingKey; baseline?: FindingBaseline | { kind: "absent"; key: CurrentFindingKey };
      state: { status: "live" | "retired"; presence: "present" | "absent"; qualifiers: Record<string, FindingQualifierValue>; homes: string[] } }
  | { kind: "reassert"; key: CurrentFindingKey; baseline?: FindingBaseline }
  | { kind: "legacy-retire"; sourceReference: string; baseline?: { versionId: string } };
export interface FindingCommand { commandId: string; patientReference: string; encounterReference: string; surface: string; targets: FindingCommandTarget[] }
export interface FindingCommandDeps {
  fhir: Pick<MedplumClient, "baseUrl" | "read" | "search" | "searchUrl" | "createWithOutcome" | "update">;
  definitions: readonly ClinicalFindingDefinition[];
  catalog: readonly AtomicFindingCatalogRow[];
  staffReference: string;
  now?: () => string;
}
export type FindingOutcomeStatus = "applied" | "unchanged" | "already-applied" | "not-attempted" | "conflict" | "refused" | "unconfirmed";
export interface FindingOutcome { status: FindingOutcomeStatus; target: string; reference?: string; versionId?: string;
  auditPending?: boolean; reason?: string; fresh?: CurrentFindingProjection | Extract<EncounterFindingState, { incomplete: true }> }
export interface FindingCommandResult { commandId: string; complete: boolean; outcomes: FindingOutcome[] }

type Complete = Extract<EncounterFindingState, { incomplete: false }>;
type TargetState = Extract<FindingCommandTarget, {kind:"fact"}>["state"];
const WRITE_HEADERS = { "X-ODOS-Source": "diagnosis-findings" };
const refPattern = /^Observation\/([A-Za-z0-9.-]+)$/;
const homePattern = /^Condition\/[A-Za-z0-9.-]+$/;

export async function executeFindingCommand(deps: FindingCommandDeps, command: FindingCommand): Promise<FindingCommandResult> {
  validateCommand(command);
  const outcomes: FindingOutcome[] = Array(command.targets.length);
  const ordered = command.targets.map((target,index)=>({target,index})).sort((a,b)=>
    Number(a.target.kind==="legacy-retire")-Number(b.target.kind==="legacy-retire") || a.index-b.index);
  let state = await load(deps,command);
  if (state.incomplete === true) { const reason=state.reason;
    return { commandId:command.commandId, complete:false, outcomes:command.targets.map(t=>({status:"not-attempted",target:targetId(t),reason})) }; }
  let stop = false;
  for (const {target,index} of ordered) {
    if (stop) { outcomes[index]={status:"not-attempted",target:targetId(target),reason:"Earlier target did not complete."}; continue; }
    if (state.incomplete === true) { outcomes[index]={status:"not-attempted",target:targetId(target),reason:state.reason};stop=true;continue; }
    const outcome = await executeTarget(deps,command,target,state);
    outcomes[index]=outcome;
    if (["conflict","refused","unconfirmed","not-attempted"].includes(outcome.status)) stop=true;
    else if (ordered.at(-1)?.index!==index) {
      state=await load(deps,command);
      if (state.incomplete) stop=true;
    }
  }
  for (const {target,index} of ordered) if (!outcomes[index]) outcomes[index]={status:"not-attempted",target:targetId(target),reason:"Encounter state could not be refreshed."};
  return { commandId:command.commandId, complete:outcomes.every(o=>["applied","unchanged","already-applied"].includes(o.status) && !o.auditPending), outcomes };
}

async function load(deps: FindingCommandDeps, command: FindingCommand): Promise<EncounterFindingState> {
  return loadEncounterFindingState(deps.fhir,{patientReference:command.patientReference,encounterReference:command.encounterReference,
    definitions:deps.definitions,catalog:deps.catalog,includeAuditState:true});
}
async function findOwners(deps:FindingCommandDeps,command:FindingCommand,key:CurrentFindingKey):Promise<Observation[]> {
  const identifier=currentFindingIdentifier(key);
  const checked=<T extends Resource>(page:Bundle<T>):Bundle<T>=>{
    if(page.resourceType!=="Bundle" || page.type!=="searchset" || page.link?.some(l=>l.relation==="next" && !l.url) ||
      page.entry?.some(e=>!e.resource || e.resource.resourceType!=="Observation" || !e.resource.id))throw new Error("Invalid owner search page.");
    return page;
  };
  const client={baseUrl:deps.fhir.baseUrl,search:deps.fhir.search.bind(deps.fhir),
    ...(deps.fhir.searchUrl?{searchUrl:async <T extends Resource>(url:string,type:T["resourceType"])=>checked(await deps.fhir.searchUrl!<T>(url,type))}:{})};
  const first=checked(await deps.fhir.search<Observation>("Observation",{identifier:`${identifier.system}|${identifier.value}`,_count:"200"}));
  const found=await collectAllFhirSearchPages(client,"Observation",first,deps.fhir.baseUrl);
  if(found.some(o=>o.subject?.reference!==command.patientReference || o.encounter?.reference!==command.encounterReference ||
    !o.identifier?.some(i=>i.system===identifier.system && i.value===identifier.value)))throw new Error("Owner identity or scope mismatch.");
  return found;
}
async function freshProjection(deps:FindingCommandDeps,command:FindingCommand):Promise<FindingOutcome["fresh"]> {
  const state=await load(deps,command);
  return state.incomplete ? state : projectCurrentFindings(state);
}
async function executeTarget(deps: FindingCommandDeps, command: FindingCommand, target: FindingCommandTarget, state: Complete): Promise<FindingOutcome> {
  const id=targetId(target);
  if (target.kind==="reassert") return executeReassert(deps,command,target,state);
  if (target.kind==="legacy-retire") return executeRetire(deps,command,target,state);
  const projection=projectCurrentFindings(state);
  const ownerId=currentFindingIdentifier(target.key).value;
  let ownerRows:Observation[];
  try { ownerRows=await findOwners(deps,command,target.key); }
  catch { return {status:"not-attempted",target:id,reason:"Finding identity search could not be verified."}; }
  if (ownerRows.length>1 || ownerRows.some(o=>parseCurrentFindingEnvelope(o).status!=="valid")) return {status:"conflict",target:id,reason:"Canonical owner is ambiguous.",fresh:projection};
  const owner=ownerRows[0];
  const row=deps.catalog.find(r=>r.atomicFindingId===`${target.key.stableKey}::${target.key.fieldCode}::${target.key.optionCode}`);
  const definition=deps.definitions.find(d=>d.stableKey===target.key.stableKey);
  if (!row || !definition) return {status:"refused",target:id,reason:"Finding definition is unavailable."};
  if (!target.baseline) return {status:"refused",target:id,reason:"A complete baseline is required."};
  if (!validIntendedState(target.state,definition,target.key,state)) return {status:"refused",target:id,reason:"Intended qualifier or home is outside the effective catalog/encounter."};
  const components=qualifierComponents(target.key,target.state.qualifiers);
  const digest=factDigest(target.state,components);
  if (owner) {
    let marker:FindingOperation|undefined;
    try { marker=parseFindingOperation(owner); } catch { return {status:"refused",target:id,reason:"Owner operation marker is invalid."}; }
    if (marker?.commandId===command.commandId && marker.target===id && marker.digest===digest) {
      if (recordFactDigest(owner,definition,row)!==digest) return {status:"conflict",target:id,reference:`Observation/${owner.id}`,reason:"Owner changed after command was recorded.",fresh:projection};
      return ensureReplayAudit(deps,id,owner,marker);
    }
  }
  if (!validFactBaseline(target.baseline,target.key)) return {status:"refused",target:id,reason:"A complete baseline is required."};
  const current=projection.currentFacts.find(f=>f.projectionKey===id);
  if (projection.conflicts.some(f=>f.projectionKey===id)) return {status:"conflict",target:id,reason:"Finding has conflicting sources.",fresh:projection};
  if (!matchesBaseline(target.baseline,target.key,owner,current,state)) return {status:"conflict",target:id,reason:"Finding baseline changed.",fresh:projection};
  if (owner && recordFactDigest(owner,definition,row)===digest) {
    try {
      if (!(await findPendingAudits(deps.fhir,[owner])).has(`Observation/${owner.id}`))
        return {status:"unchanged",target:id,reference:`Observation/${owner.id}`,versionId:owner.meta?.versionId};
    } catch { return {status:"not-attempted",target:id,reason:"prior-audit-unrepaired"}; }
  }
  const baseline=target.baseline;
  let source:Observation|undefined;
  if (baseline.kind==="legacy") source=state.observations.find(o=>`Observation/${o.id}`===baseline.sourceReference);
  if (baseline.kind==="legacy" && !source) return {status:"conflict",target:id,reason:"Legacy source is missing.",fresh:projection};
  if (source) {
    try { const latest=await deps.fhir.read<Observation>("Observation",source.id!);
      if (latest.subject?.reference!==command.patientReference || latest.encounter?.reference!==command.encounterReference ||
        latest.meta?.versionId!==source.meta?.versionId) return {status:"conflict",target:id,reason:"Legacy source changed.",fresh:await freshProjection(deps,command)};
      source=latest;
    } catch { return {status:"not-attempted",target:id,reason:"Legacy source could not be verified."}; }
  }
  const update=!!owner || (baseline.kind==="legacy" && baseline.mode==="adopt");
  const prior=owner ?? (update ? source : undefined);
  if (prior && !(await repairPrior(deps,prior))) return {status:"not-attempted",target:id,reason:"prior-audit-unrepaired"};
  const recorded=(deps.now??(()=>new Date().toISOString()))();
  const operation:FindingOperation={commandId:command.commandId,target:id,digest,audit:{kind:"mutation",actor:deps.staffReference,
    recorded,activity:update?"UPDATE":"CREATE",targetReferences:["self",command.patientReference]}};
  const next=buildFact(target,components,operation,prior);
  let saved:Observation;
  try {
    if (update) saved=await deps.fhir.update<Observation>("Observation",prior!.id!,next,{...WRITE_HEADERS,"If-Match":etag(prior!.meta!.versionId!)});
    else {
      const result=await deps.fhir.createWithOutcome<Observation>(next,{...WRITE_HEADERS,
        "If-None-Exist":`identifier=${currentFindingIdentifier(target.key).system}|${ownerId}`});
      saved=result.resource;
      if (!result.created) {
        let loser:FindingOperation|undefined;
        try { loser=parseFindingOperation(saved); } catch { return {status:"conflict",target:id,reason:"Another command owns this finding."}; }
        if (parseCurrentFindingEnvelope(saved).status==="valid" && loser?.commandId===command.commandId && loser.target===id && loser.digest===digest &&
          recordFactDigest(saved,definition,row)===digest && saved.id) {
          if (saved.subject?.reference!==command.patientReference || saved.encounter?.reference!==command.encounterReference)
            return {status:"conflict",target:id,reason:"Returned owner is outside the encounter."};
          return ensureReplayAudit(deps,id,saved,loser);
        }
        return {status:"conflict",target:id,reason:"Another command owns this finding.",reference:saved.id?`Observation/${saved.id}`:undefined,
          versionId:saved.meta?.versionId,fresh:await freshProjection(deps,command)};
      }
    }
  } catch(error) { return recoverFactWrite(deps,command,target,digest,definition,row,error,prior); }
  if (!saved.id || !saved.meta?.versionId) return {status:"unconfirmed",target:id,reason:"Saved finding lacks an id or version.",
    ...(saved.id?{reference:`Observation/${saved.id}`}:{})};
  return finishMutationAudit(deps,id,saved,operation);
}

function buildFact(target:Extract<FindingCommandTarget,{kind:"fact"}>, qualifiers:ObservationComponent[], operation:FindingOperation, prior?:Observation):Observation {
  const key=target.key;
  const special=new Set(["R10_CURRENT_META","R10_OPERATION","GRADE"]);
  const prefix=`${key.fieldCode}::${key.optionCode}::`;
  return { ...(prior??{}),resourceType:"Observation",status:target.state.status==="retired"?"entered-in-error":"preliminary",
    effectiveDateTime:operation.audit.recorded,
    code:odosConcept(`${key.stableKey}::${key.fieldCode}::${key.optionCode}`),subject:{reference:`Patient/${key.patientId}`},
    encounter:{reference:`Encounter/${key.encounterId}`},valueBoolean:target.state.presence==="present",
    identifier:[...(prior?.identifier??[]).filter(i=>i.system!==currentFindingIdentifier(key).system),currentFindingIdentifier(key)],
    extension:[...(prior?.extension??[]).filter(e=>e.url!==ODOS_EXTENSION_URLS.eyeLaterality && e.url!==SUPPORTS_DIAGNOSIS_URL),
      {url:ODOS_EXTENSION_URLS.eyeLaterality,valueCodeableConcept:lateralityConcept(key.eye)},
      ...[...new Set(target.state.homes)].sort().map(home=>({url:SUPPORTS_DIAGNOSIS_URL,valueReference:{reference:home}}))],
    component:[...(prior?.component??[]).filter(c=>!(c.code.coding??[]).some(v=>special.has(v.code??"") || v.code?.startsWith(prefix))),
      ...qualifiers,{code:odosConcept("R10_CURRENT_META"),valueString:JSON.stringify(key)},
      {code:odosConcept("R10_OPERATION"),valueString:JSON.stringify(operation)}] };
}

function qualifierComponents(key:CurrentFindingKey, qualifiers:Record<string,FindingQualifierValue>):ObservationComponent[] {
  return Object.entries(qualifiers).sort(([a],[b])=>a.localeCompare(b)).map(([name,value])=>({
    code:odosConcept(`${key.fieldCode}::${key.optionCode}::${name}`),
    ...(typeof value==="number"?{valueQuantity:{value}}:typeof value==="string"?{valueCodeableConcept:odosConcept(value)}:{valueString:JSON.stringify(canonical(value))}) }));
}
function factDigest(state:TargetState, components:ObservationComponent[]):string {
  return sha({status:state.status,presence:state.presence,qualifierComponents:components.map(c=>({code:c.code.coding?.[0]?.code,
    value:c.valueQuantity?.value??c.valueCodeableConcept?.coding?.[0]?.code??c.valueString})),homes:[...new Set(state.homes)].sort()});
}
function recordFactDigest(observation:Observation,definition:ClinicalFindingDefinition,row:AtomicFindingCatalogRow):string {
  if(observation.status!=="preliminary" && observation.status!=="entered-in-error")return sha({invalidStatus:observation.status});
  const qualifiers=findingQualifiers(observation,definition,row,"");
  return factDigest({status:observation.status==="preliminary"?"live":"retired",presence:observation.valueBoolean===false?"absent":"present",
    qualifiers,homes:observation.extension?.flatMap(e=>e.url===SUPPORTS_DIAGNOSIS_URL && e.valueReference?.reference?[e.valueReference.reference]:[])??[]},
    qualifierComponents({v:1,patientId:"",encounterId:"",stableKey:row.findingDefinitionKey,fieldCode:row.fieldCode,optionCode:row.optionCode,eye:"OD"},qualifiers));
}
function validIntendedState(state:TargetState,definition:ClinicalFindingDefinition,key:CurrentFindingKey,loaded:Complete):boolean {
  const field=customFieldEntries(definition,true).find(f=>f.localCode===key.fieldCode);
  const option=field?.options?.find(o=>o.code===key.optionCode);
  if(!option || state.homes.some(h=>!loaded.conditions.some(c=>`Condition/${c.id}`===h)))return false;
  for(const [name,value] of Object.entries(state.qualifiers)) {
    const qualifier=option.qualifiers?.find(q=>q.key===name);
    if(!qualifier)return false;
    if(qualifier.kind==="graded" && !(typeof value==="string" && qualifier.options.includes(value)))return false;
    if(qualifier.kind==="enum" && !(typeof value==="string" && qualifier.options.some(o=>o.code===value)))return false;
    if(qualifier.kind==="numeric" && !(typeof value==="number" && Number.isFinite(value) && value>=qualifier.min && value<=qualifier.max))return false;
    if(qualifier.kind==="extent" && !(typeof value==="object" && value!==null && !Array.isArray(value) && Number.isInteger(value.from) &&
      Number.isInteger(value.to) && value.from>=1 && value.from<=12 && value.to>=1 && value.to<=12 && typeof value.clockwise==="boolean"))return false;
  }
  return true;
}

async function executeRetire(deps:FindingCommandDeps,command:FindingCommand,target:Extract<FindingCommandTarget,{kind:"legacy-retire"}>,state:Complete):Promise<FindingOutcome> {
  const id=targetId(target);
  let source:Observation;
  try { source=await deps.fhir.read<Observation>("Observation",target.sourceReference.slice("Observation/".length)); }
  catch(error) { return (error as {status?:number})?.status===404 ? {status:"conflict",target:id,reason:"Legacy source is missing."} :
    {status:"not-attempted",target:id,reason:"Legacy source could not be verified."}; }
  if(source.resourceType!=="Observation" || source.id!==target.sourceReference.slice("Observation/".length) ||
    source.subject?.reference!==command.patientReference || source.encounter?.reference!==command.encounterReference)
    return {status:"refused",target:id,reason:"Legacy source is outside the encounter."};
  if (!target.baseline) return {status:"refused",target:id,reason:"A source version is required."};
  const digest=sha({sourceReference:target.sourceReference,status:"entered-in-error"});
  let marker:FindingOperation|undefined;
  try { marker=parseFindingOperation(source); } catch { return {status:"refused",target:id,reason:"Source operation marker is invalid."}; }
  if (marker?.commandId===command.commandId && marker.target===id && marker.digest===digest) {
    if (source.status!=="entered-in-error") return {status:"conflict",target:id,reason:"Source changed after retirement was recorded.",fresh:projectCurrentFindings(state)};
    return ensureReplayAudit(deps,id,source,marker);
  }
  if (typeof target.baseline?.versionId!=="string" || !target.baseline.versionId) return {status:"refused",target:id,reason:"A source version is required."};
  const alias=buildFindingReadAliases(deps.definitions,deps.catalog);
  if (source.meta?.versionId!==target.baseline.versionId || observationLaterality(source)!=="UNKNOWN" ||
    classifyFindingObservation(source,deps.definitions,deps.catalog,alias).kind!=="legacy-atomic" || !isLiveObservation(source))
    return {status:"conflict",target:id,reason:"UNKNOWN source baseline changed.",fresh:projectCurrentFindings(state)};
  if (!(await repairPrior(deps,source))) return {status:"not-attempted",target:id,reason:"prior-audit-unrepaired"};
  const operation:FindingOperation={commandId:command.commandId,target:id,digest,audit:{kind:"mutation",actor:deps.staffReference,
    recorded:(deps.now??(()=>new Date().toISOString()))(),activity:"UPDATE",targetReferences:["self",command.patientReference]}};
  const next:Observation={...source,status:"entered-in-error",component:[...(source.component??[]).filter(c=>!c.code.coding?.some(v=>v.code==="R10_OPERATION")),
    {code:odosConcept("R10_OPERATION"),valueString:JSON.stringify(operation)}]};
  let saved:Observation;
  try { saved=await deps.fhir.update<Observation>("Observation",source.id!,next,{...WRITE_HEADERS,"If-Match":etag(source.meta!.versionId!)}); }
  catch(error) { return recoverRetireWrite(deps,command,target,digest,error,source); }
  return finishMutationAudit(deps,id,saved,operation);
}

async function executeReassert(deps:FindingCommandDeps,command:FindingCommand,target:Extract<FindingCommandTarget,{kind:"reassert"}>,state:Complete):Promise<FindingOutcome> {
  const id=targetId(target),baseline=target.baseline;
  if (!baseline || !["canonical","legacy"].includes(baseline.kind) || !validFactBaseline(baseline,target.key)) return {status:"refused",target:id,reason:"A current finding baseline is required."};
  const reference=baseline.kind==="canonical"?baseline.reference:baseline.sourceReference;
  const digest=sha({reference,versionId:baseline.versionId});
  const key=findingAuditKey(command.commandId,id,"reassertion",digest);
  try { if (await auditExists(deps,key)) return {status:"already-applied",target:id,reference,versionId:baseline.versionId}; }
  catch { return {status:"not-attempted",target:id,reason:"Audit state could not be verified."}; }
  const projection=projectCurrentFindings(state),fact=projection.currentFacts.find(f=>f.projectionKey===id);
  if (!fact || !matchesBaseline(baseline,target.key,state.observations.find(o=>`Observation/${o.id}`===reference && baseline.kind==="canonical"),fact,state))
    return {status:"conflict",target:id,reason:"Reassertion baseline changed.",fresh:projection};
  let latest:Observation;
  try { latest=await deps.fhir.read<Observation>("Observation",reference.slice("Observation/".length)); }
  catch(error) { return (error as {status?:number})?.status===404 ? {status:"conflict",target:id,reason:"Reassertion source is missing.",fresh:await freshProjection(deps,command)} :
    {status:"not-attempted",target:id,reason:"Reassertion source could not be verified."}; }
  if(latest.id!==reference.slice("Observation/".length) || latest.subject?.reference!==command.patientReference ||
    latest.encounter?.reference!==command.encounterReference || latest.meta?.versionId!==baseline.versionId ||
    (baseline.kind==="canonical" && (parseCurrentFindingEnvelope(latest).status!=="valid" ||
      !latest.identifier?.some(i=>i.system===currentFindingIdentifier(target.key).system && i.value===currentFindingIdentifier(target.key).value))))
    return {status:"conflict",target:id,reason:"Reassertion source changed.",fresh:await freshProjection(deps,command)};
  const recorded=(deps.now??(()=>new Date().toISOString()))();
  const audit=buildProvenance({targetReferences:[reference],patientReference:command.patientReference,recorded,activityCode:"UPDATE",
    activityDisplay:"Diagnosis finding reassertion",agents:[{whoReference:deps.staffReference,typeCode:"author"}]}) as Provenance;
  audit.activity={coding:[{system:ODOS_PROVENANCE_ACTIVITY_CODE_SYSTEM,code:DIAGNOSIS_FINDING_REASSERTION_CODE,display:"Diagnosis finding reasserted"}],
    text:"Diagnosis finding reassertion"};
  audit.meta={...audit.meta,tag:[...(audit.meta?.tag??[]),{system:FINDING_OPERATION_AUDIT_SYSTEM,code:key}]};
  try { const saved=await deps.fhir.createWithOutcome<Provenance>(audit,auditHeaders(key));
    return {status:saved.created?"applied":"already-applied",target:id,reference,versionId:baseline.versionId}; }
  catch(error) {
    if(definitivelyRefused(error))return {status:"refused",target:id,reference,versionId:baseline.versionId,reason:"Reassertion audit was refused."};
    try { if(await auditExists(deps,key)) return {status:"already-applied",target:id,reference,versionId:baseline.versionId}; }
    catch { return {status:"unconfirmed",target:id,reference,versionId:baseline.versionId,reason:"Reassertion audit response and lookup were lost."}; }
    return {status:"unconfirmed",target:id,reference,versionId:baseline.versionId,reason:"Reassertion audit was not confirmed."}; }
}

async function finishMutationAudit(deps:FindingCommandDeps,id:string,saved:Observation,operation:FindingOperation):Promise<FindingOutcome> {
  const reference=saved.id?`Observation/${saved.id}`:undefined;
  if (!reference) return {status:"unconfirmed",target:id,reason:"Saved finding lacks an id."};
  try { await createAudit(deps,operation,reference);return {status:"applied",target:id,reference,versionId:saved.meta?.versionId}; }
  catch(error) {
    if (definitivelyRefused(error)) return {status:"applied",target:id,reference,versionId:saved.meta?.versionId,auditPending:true};
    try { if (!(await findPendingAudits(deps.fhir,[saved])).has(reference)) return {status:"applied",target:id,reference,versionId:saved.meta?.versionId}; }
    catch { return {status:"unconfirmed",target:id,reference,versionId:saved.meta?.versionId,reason:"Audit response and lookup were lost."}; }
    return {status:"applied",target:id,reference,versionId:saved.meta?.versionId,auditPending:true}; }
}
async function ensureReplayAudit(deps:FindingCommandDeps,id:string,observation:Observation,operation:FindingOperation):Promise<FindingOutcome> {
  const reference=`Observation/${observation.id}`, versionId=observation.meta?.versionId;
  try { await createAudit(deps,operation,reference);
    return {status:"already-applied",target:id,reference,versionId}; }
  catch(error) {
    if(definitivelyRefused(error))return {status:"applied",target:id,reference,versionId,auditPending:true};
    try { if(!(await findPendingAudits(deps.fhir,[observation])).has(reference))return {status:"already-applied",target:id,reference,versionId}; }
    catch { return {status:"unconfirmed",target:id,reference,versionId,reason:"Audit response and lookup were lost."}; }
    return {status:"unconfirmed",target:id,reference,versionId,reason:"Audit write was not confirmed."};
  }
}
async function repairPrior(deps:FindingCommandDeps,observation:Observation):Promise<boolean> {
  try { const marker=parseFindingOperation(observation); if (!marker) return true;
    const reference=`Observation/${observation.id}`;
    if ((await findPendingAudits(deps.fhir,[observation])).has(reference)) await createAudit(deps,marker,reference);
    return true;
  } catch { return false; }
}
async function createAudit(deps:FindingCommandDeps,operation:FindingOperation,self:string):Promise<void> {
  const {audit}=operation;
  const targets=audit.targetReferences.map(r=>r==="self"?self:r);
  const key=findingAuditKey(operation.commandId,operation.target,audit.kind,operation.digest);
  const provenance=buildProvenance({targetReferences:targets,recorded:audit.recorded,activityCode:audit.activity,
    activityDisplay:audit.activity==="CREATE"?"Create":"Update",agents:[{whoReference:audit.actor,typeCode:"author"}]}) as Provenance;
  provenance.meta={...provenance.meta,tag:[...(provenance.meta?.tag??[]),{system:FINDING_OPERATION_AUDIT_SYSTEM,code:key}]};
  await deps.fhir.createWithOutcome<Provenance>(provenance,auditHeaders(key));
}
async function auditExists(deps:FindingCommandDeps,key:string):Promise<boolean> {
  const checked=<T extends Resource>(page:Bundle<T>):Bundle<T>=>{
    if(page.resourceType!=="Bundle" || page.type!=="searchset" || page.link?.some(l=>l.relation==="next" && !l.url) ||
      page.entry?.some(e=>e.resource?.resourceType!=="Provenance" || !e.resource.id))throw new Error("Invalid audit lookup.");
    return page;
  };
  const client={baseUrl:deps.fhir.baseUrl,search:deps.fhir.search.bind(deps.fhir),
    ...(deps.fhir.searchUrl?{searchUrl:async <T extends Resource>(url:string,type:T["resourceType"])=>checked(await deps.fhir.searchUrl!<T>(url,type))}:{})};
  const first=checked(await deps.fhir.search<Provenance>("Provenance",{_tag:`${FINDING_OPERATION_AUDIT_SYSTEM}|${key}`,_count:"200"}));
  const pages=await collectAllFhirSearchPages(client,"Provenance",first,deps.fhir.baseUrl);
  return pages.some(p=>p.meta?.tag?.some(t=>t.system===FINDING_OPERATION_AUDIT_SYSTEM && t.code===key));
}
function auditHeaders(key:string):Record<string,string> { return {...WRITE_HEADERS,"If-None-Exist":`_tag=${FINDING_OPERATION_AUDIT_SYSTEM}|${key}`}; }

async function recoverFactWrite(deps:FindingCommandDeps,command:FindingCommand,target:Extract<FindingCommandTarget,{kind:"fact"}>,digest:string,
  definition:ClinicalFindingDefinition,row:AtomicFindingCatalogRow,error:unknown,prior?:Observation):Promise<FindingOutcome> {
  const id=targetId(target),status=(error as {status?:number})?.status;
  if (status===409 || status===412) return {status:"conflict",target:id,reference:prior?.id?`Observation/${prior.id}`:undefined,
    reason:"Conditional finding write conflicted.",fresh:await freshProjection(deps,command).catch(()=>undefined)};
  if (status===400 || status===401 || status===403) return {status:"refused",target:id,reason:"Finding write was refused."};
  try { const state=await load(deps,command);if(state.incomplete) throw new Error("Reload incomplete.");
    const owners=await findOwners(deps,command,target.key);
    if(owners.length>1 || owners.some(o=>parseCurrentFindingEnvelope(o).status!=="valid"))
      return {status:"conflict",target:id,reason:"Recovered owner identity is ambiguous or invalid.",fresh:projectCurrentFindings(state)};
    const owner=owners[0];
    const marker=owner&&parseFindingOperation(owner);
    if (owner && marker?.commandId===command.commandId && marker.target===id && marker.digest===digest && recordFactDigest(owner,definition,row)===digest)
      return finishMutationAudit(deps,id,owner,marker);
    if (owner && marker?.commandId===command.commandId && marker.digest===digest) return {status:"conflict",target:id,reason:"Owner changed after command was recorded.",fresh:projectCurrentFindings(state)};
  } catch { return {status:"unconfirmed",target:id,reference:prior?.id?`Observation/${prior.id}`:undefined,
    versionId:prior?.meta?.versionId,reason:"Finding write response and reload were lost."}; }
  return {status:"unconfirmed",target:id,reference:prior?.id?`Observation/${prior.id}`:undefined,versionId:prior?.meta?.versionId,
    reason:"Finding write was not confirmed."};
}
async function recoverRetireWrite(deps:FindingCommandDeps,command:FindingCommand,target:Extract<FindingCommandTarget,{kind:"legacy-retire"}>,digest:string,
  error:unknown,prior:Observation):Promise<FindingOutcome> {
  const id=targetId(target),status=(error as {status?:number})?.status;
  if(status===409||status===412)return {status:"conflict",target:id,reference:target.sourceReference,
    reason:"Conditional retirement conflicted.",fresh:await freshProjection(deps,command).catch(()=>undefined)};
  if(status===400||status===401||status===403)return {status:"refused",target:id,reference:target.sourceReference,reason:"Retirement was refused."};
  try { const source=await deps.fhir.read<Observation>("Observation",prior.id!);
    const marker=parseFindingOperation(source);
    if(marker?.commandId===command.commandId && marker.target===id && marker.digest===digest && source.status==="entered-in-error")
      return finishMutationAudit(deps,id,source,marker);
    if(marker?.commandId===command.commandId && marker.digest===digest) return {status:"conflict",target:id,reference:target.sourceReference,reason:"Retired source changed."};
  } catch { return {status:"unconfirmed",target:id,reference:target.sourceReference,versionId:prior.meta?.versionId,
    reason:"Retirement response and reload were lost."}; }
  return {status:"unconfirmed",target:id,reference:target.sourceReference,versionId:prior.meta?.versionId,reason:"Retirement was not confirmed."};
}

function matchesBaseline(baseline:NonNullable<Extract<FindingCommandTarget,{kind:"fact"}>["baseline"]>,key:CurrentFindingKey,
  owner:Observation|undefined,current:CurrentFindingProjection["currentFacts"][number]|undefined,state:Complete):boolean {
  if(baseline.kind==="absent")return sameKey(baseline.key,key) && !owner && (!current || current.status==="retired") &&
    !projectCurrentFindings(state).conflicts.some(c=>c.projectionKey===`finding:${currentFindingIdentifier(key).value}`);
  if(baseline.kind==="canonical")return !!owner && baseline.reference===`Observation/${owner.id}` && baseline.versionId===owner.meta?.versionId &&
    current?.baseline?.kind==="canonical" && current.baseline.reference===baseline.reference;
  if(owner || !current || current.baseline?.kind!=="legacy")return false;
  const actual=current.baseline;
  return baseline.versionId===actual.versionId && baseline.sourceReference===actual.sourceReference && baseline.mode===actual.mode &&
    sameKey(baseline.key,actual.key) && sameKey(key,actual.key);
}
function validFactBaseline(baseline:Extract<FindingCommandTarget,{kind:"fact"}>["baseline"],key:CurrentFindingKey):baseline is NonNullable<Extract<FindingCommandTarget,{kind:"fact"}>["baseline"]> {
  if(!baseline || typeof baseline!=="object")return false;
  if(baseline.kind==="absent")return sameKey(baseline.key,key);
  if(baseline.kind==="canonical")return typeof baseline.versionId==="string" && !!baseline.versionId && refPattern.test(baseline.reference);
  if(baseline.kind==="legacy")return typeof baseline.versionId==="string" && !!baseline.versionId && refPattern.test(baseline.sourceReference) && ["adopt","materialize"].includes(baseline.mode) &&
    sameKey(baseline.key,key);
  return false;
}
function sameKey(a:CurrentFindingKey|undefined,b:CurrentFindingKey):boolean {
  return !!a && a.v===b.v && a.patientId===b.patientId && a.encounterId===b.encounterId && a.stableKey===b.stableKey &&
    a.fieldCode===b.fieldCode && a.optionCode===b.optionCode && a.eye===b.eye;
}
function targetId(target:FindingCommandTarget):string {return target.kind==="legacy-retire"?target.sourceReference:`finding:${currentFindingIdentifier(target.key).value}`;}
function canonical(value:unknown):unknown {
  if(Array.isArray(value))return value.map(canonical);
  if(value!==null && typeof value==="object")return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)]));
  return value;
}
function sha(value:unknown):string {return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");}
function etag(version:string):string {return `W/"${version}"`;}
function definitivelyRefused(error:unknown):boolean {
  const status=(error as {status?:number})?.status;
  return status!==undefined && status>=400 && status<500 && status!==408;
}
function validateCommand(command:FindingCommand):void {
  const invalid=()=>{const error=new Error("Invalid finding command.") as Error & {status:number};error.status=400;throw error;};
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(command?.commandId??"") ||
    !/^Patient\/[A-Za-z0-9.-]+$/.test(command?.patientReference??"") || !/^Encounter\/[A-Za-z0-9.-]+$/.test(command?.encounterReference??"") ||
    typeof command?.surface!=="string" || !command.surface.trim() || !Array.isArray(command?.targets) || !command.targets.length) invalid();
  const keys=new Set<string>();
  for(const t of command.targets){
    if(!t || !["fact","reassert","legacy-retire"].includes(t.kind))invalid();
    if(t.kind!=="legacy-retire"){
      if(!currentFindingKeySchema.safeParse(t.key).success ||
        t.key.patientId!==command.patientReference.slice(8) || t.key.encounterId!==command.encounterReference.slice(10) ||
        !t.key.stableKey || !t.key.fieldCode || !t.key.optionCode)invalid();
      if(t.kind==="fact" && (!t.state || !["live","retired"].includes(t.state.status) || !["present","absent"].includes(t.state.presence) ||
        !t.state.qualifiers || typeof t.state.qualifiers!=="object" || Array.isArray(t.state.qualifiers) ||
        Object.values(t.state.qualifiers).some(v=>!(typeof v==="string" || (typeof v==="number" && Number.isFinite(v)) ||
          (v!==null && typeof v==="object" && Number.isFinite(v.from) && Number.isFinite(v.to) && typeof v.clockwise==="boolean"))) ||
        !Array.isArray(t.state.homes) ||
        t.state.homes.some(h=>!homePattern.test(h)))) invalid();
    } else if(!refPattern.test(t.sourceReference))invalid();
    const id=targetId(t);if(keys.has(id))invalid();keys.add(id);
  }
}
