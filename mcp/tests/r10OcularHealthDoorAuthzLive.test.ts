import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { AccessPolicy, Bundle, ClientApplication, Condition, Encounter, Observation, Patient, Practitioner, ProjectMembership, Provenance, Resource } from "@medplum/fhirtypes";
import { ODOS_PRACTICE_ROLE_SYSTEM, buildMedplumAccessPolicy, getRoleDeclaration } from "../src/authz/roles.js";
import { authenticateMedplumService, createMedplumClient, type MedplumClient } from "../src/fhir-client.js";
import { createMcpServiceAuthentication } from "../src/service-auth-options.js";
import { searchAll } from "../src/fhir-search.js";
import { FhirFindingDefinitionStore } from "../src/clinical-graph/finding-definition-store.js";
import { customFieldEntries } from "../src/clinical-graph/custom-fields.js";
import { handleCustomSectionCaptureRequest, handleCustomSectionHistoryRequest } from "../src/clinical-graph/custom-section-endpoint.js";
import { handleDiagnosisFindingsMutationRequest, materializeAtomicFindingCatalog } from "../src/clinical-graph/diagnosis-findings-endpoint.js";
import { handleDiagnosisPullRequest } from "../src/clinical-graph/diagnosis-carry-forward-endpoint.js";
import { handleEncounterVoidRequest } from "../src/clinical-graph/encounter-void-endpoint.js";
import { handleEncounterUndoRequest } from "../src/clinical-graph/encounter-undo-endpoint.js";
import { classifyFindingObservation, FINDING_OPERATION_AUDIT_SYSTEM, findingAuditKey, parseFindingOperation } from "../src/clinical-graph/current-finding-identity.js";
import { buildFindingReadAliases } from "../src/clinical-graph/finding-read-aliases.js";
import { buildEncounterDiagnosisCondition } from "../src/fhir/condition.js";
import { DIAGNOSIS_KEY_IDENTIFIER_SYSTEM } from "../src/clinical-graph/diagnosis-pick-endpoint.js";
import { odosConcept, ODOS_EXTENSION_URLS, lateralityConcept } from "../src/fhir/ophthalmology/extensions.js";
import { createLiveAuthorizationClients, requireMedplumAdmin } from "./integration-helpers.js";
import { createRoleClient, cleanupReferences, clientCredentialsToken } from "./liveRoleClient.js";
import { TEST_FHIR_AUDIT_CONTEXT, TEST_FHIR_AUDIT_RECORDER } from "./fhirAuditTestStub.js";

type Claim = { key: Record<string, unknown>; baseline: unknown; presence: "present"; qualifiers: Record<string, unknown>; homes: string[] };
const resourceRef = (resource: Resource) => `${resource.resourceType}/${resource.id}`;
const resourceState = (resource: Resource) => ({ reference: resourceRef(resource), status: (resource as Observation).status, versionId: resource.meta?.versionId });
function toolBody(result: Awaited<ReturnType<Client["callTool"]>>): any {
  assert.equal(result.isError, undefined, JSON.stringify(result));
  const text = (result.content as Array<{type:string;text?:string}>).find(item => item.type === "text")?.text;
  assert.ok(text); return JSON.parse(text);
}

async function connectServiceProcess(baseUrl: string, projectId: string, practitionerId: string, serviceEnv: Record<string,string|undefined>) {
  const explicitPostgres = process.env.ODOS_POSTGRES_URL;
  if (explicitPostgres) assert.ok(["localhost","127.0.0.1"].includes(new URL(explicitPostgres).hostname),"MCP SQL background workers must stay local");
  const writes: Array<{ method: string; path: string }> = [];
  let activeRequests = 0;
  const upstream = new URL(baseUrl);
  const proxy = createServer((incoming, outgoing) => {
    activeRequests++; outgoing.once("close", () => activeRequests--);
    if (incoming.url?.startsWith("/fhir/R4") && !["GET", "HEAD", "OPTIONS"].includes(incoming.method ?? "GET")) {
      writes.push({ method: incoming.method!, path: incoming.url.split("?")[0] });
    }
    const forwarded = httpRequest(new URL(incoming.url ?? "/", upstream), {
      method: incoming.method, headers: {...incoming.headers, host: upstream.host},
    }, response => { outgoing.writeHead(response.statusCode ?? 502, response.headers); response.pipe(outgoing); });
    forwarded.on("error", () => { outgoing.statusCode = 502; outgoing.end(); });
    incoming.pipe(forwarded);
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  let sqlSink: ReturnType<typeof createTcpServer> | undefined;
  let postgresUrl = explicitPostgres;
  if (!postgresUrl) {
    sqlSink = createTcpServer(socket => socket.destroy());
    await new Promise<void>(resolve => sqlSink!.listen(0,"127.0.0.1",resolve));
    postgresUrl = `postgresql://synthetic:synthetic@127.0.0.1:${(sqlSink.address() as AddressInfo).port}/r10_a3_unused`;
  }
  assert.ok(["localhost","127.0.0.1"].includes(new URL(postgresUrl).hostname),"MCP SQL background workers must stay local");
  const inheritedKeys = ["PATH","HOME","TMPDIR","MEDPLUM_CLIENT_ID","MEDPLUM_CLIENT_SECRET","MEDPLUM_ADMIN_EMAIL","MEDPLUM_ADMIN_PASSWORD","ODOS_POSTGRES_URL"];
  const childEnv = Object.fromEntries(inheritedKeys.flatMap(key => process.env[key] === undefined ? [] : [[key,process.env[key]!]]));
  Object.assign(childEnv,Object.fromEntries(Object.entries(serviceEnv).filter((entry):entry is [string,string]=>entry[1]!==undefined)));
  Object.assign(childEnv, { ODOS_POSTGRES_URL: postgresUrl, MEDPLUM_BASE_URL: proxyUrl, MEDPLUM_PROJECT_ID: projectId, ODOS_MCP_TRANSPORT: "stdio", ODOS_SESSION_PRACTITIONER_ID: practitionerId, ODOS_AUDIT_ACTOR_ID: practitionerId, ODOS_AUDIT_DISABLED: "1" });
  // The runtime's audit SQL adapter is outside this policy lane; clinical Provenance stays real.
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/index.ts"], cwd: fileURLToPath(new URL("../", import.meta.url)), env: childEnv, stderr: "pipe" });
  transport.stderr?.on("data", () => undefined);
  const client = new Client({name:"r10-ocular-health-live",version:"1"});
  const closeProxy = async () => {
    await new Promise<void>((resolve,reject) => proxy.close(error => error ? reject(error) : resolve()));
    if (sqlSink) await new Promise<void>((resolve,reject) => sqlSink!.close(error => error ? reject(error) : resolve()));
  };
  try {
  await client.connect(transport);
  const deadline = Date.now() + 10_000;
  do {
    await new Promise(resolve => setTimeout(resolve,100));
    if (activeRequests === 0) break;
    assert.ok(Date.now() < deadline,"MCP startup FHIR requests did not settle");
  } while (true);
  } catch(error) { await transport.close(); await closeProxy(); throw error; }
  writes.length = 0;
  return {client,writes,close:async()=>{await client.close();await closeProxy();}};
}

test("R10 A3 Ocular Health saves and lifecycle enforce stored role policies and real MCP dispatch", async t => {
  const credentials = requireMedplumAdmin(t,"r10OcularHealthDoorAuthzLive"); if(!credentials) return;
  const baseUrl = process.env.MEDPLUM_BASE_URL?.replace(/\/$/,"") ?? "http://localhost:8103";
  assert.ok(["localhost","127.0.0.1"].includes(new URL(baseUrl).hostname),"Synthetic local stack only");
  const {seederFhir,seederAccessToken,callerFhir,callerAccessToken} = await createLiveAuthorizationClients({baseUrl,...credentials});
  const projectId = await callerFhir.getActiveProjectId();
  const seederActorReference = await callerFhir.getAuthenticatedProfileReference();
  assert.equal(await seederFhir.getActiveProjectId(),projectId,"Seeder and constrained callers share the disposable project");
  const policies = await searchAll<AccessPolicy>(callerFhir,"AccessPolicy",{_project:projectId});
  const cleanup = new Set<string>();
  const track = <T extends Resource>(resource:T):T => {assert.ok(resource.id);cleanup.add(resourceRef(resource));return resource;};
  const practitioner = track(await seederFhir.create<Practitioner>({resourceType:"Practitioner",active:true,name:[{family:"R10A3SyntheticProvider"}]}));
  const practitionerReference=resourceRef(practitioner);
  let providerProof: {fact:Observation;encounter:Encounter;policyReference:string;patientReference:string;preRebuildFact:Observation;preRebuildEncounter:Encounter} | undefined;
  let bodyFailure: unknown;
  try {
    for(const role of ["staff","provider"] as const) await t.test(role,async roleTest=>{
      const matching=policies.filter(policy=>{const tags=policy.meta?.tag?.filter(tag=>tag.system===ODOS_PRACTICE_ROLE_SYSTEM)??[];return tags.length===1&&tags[0].code===role;});
      assert.equal(matching.length,1); const policy=matching[0]; assert.ok(policy.id);
      assert.deepEqual(policy.resource,buildMedplumAccessPolicy(getRoleDeclaration(role)).resource,"Stored canonical policy is synchronized");
      const policyReference=resourceRef(policy);
      const patient=track(await seederFhir.create<Patient>({resourceType:"Patient",name:[{family:`R10A3Synthetic-${role}`}]}));
      const patientReference=resourceRef(patient);
      const {token}=await createRoleClient({baseUrl,roleId:role,policyReference,patientReference,practitionerReference,projectId,runId:randomUUID(),adminToken:callerAccessToken,track});
      const real=createMedplumClient({baseUrl,accessToken:token,audit:TEST_FHIR_AUDIT_RECORDER,auditContext:TEST_FHIR_AUDIT_CONTEXT});
      const attempts:Array<{method:string;type:string}>=[];
      const fhir={...real,
        create:async(resource:Resource,headers?:Record<string,string>)=>{attempts.push({method:"POST",type:resource.resourceType});return track(await real.create(resource,headers));},
        createWithOutcome:async(resource:Resource,headers?:Record<string,string>)=>{attempts.push({method:"POST",type:resource.resourceType});const outcome=await real.createWithOutcome(resource,headers);if(outcome.created)track(outcome.resource);return outcome;},
        update:async(type:Resource["resourceType"],id:string,resource:Resource,headers?:Record<string,string>)=>{attempts.push({method:"PUT",type});return real.update(type,id,resource,headers);},
        patch:async(...args:Parameters<typeof real.patch>)=>{attempts.push({method:"PATCH",type:args[0]});return real.patch(...args);},
        executeTransaction:async(bundle:Bundle,headers?:Record<string,string>)=>{
          attempts.push(...(bundle.entry??[]).map(entry=>({method:entry.request?.method??"UNKNOWN",type:entry.request?.url?.split("/")[0]??entry.resource?.resourceType??"UNKNOWN"})));
          const result=await real.executeTransaction(bundle,headers);
          for(let i=0;i<(result.entry?.length??0);i++) {const entry=result.entry![i];const location=entry.response?.location;const match=location?.match(/(?:^|\/)([A-Z][A-Za-z]+\/[^/]+)(?:\/_history\/[^/]+)?$/);if(match)cleanup.add(match[1]);else if(entry.resource?.id)track(entry.resource);else {const request=bundle.entry?.[i]?.request;if(request?.method==="PUT"&&request.url)cleanup.add(request.url);}}
          return result;
        },
      } as MedplumClient;
      const authHeader=`Bearer ${token}`;
      const deps=async()=>{const effective=await new FhirFindingDefinitionStore(fhir).list();return {fhirBaseUrl:baseUrl,authenticate:async(header:string|undefined)=>header===authHeader?{staffReference:practitionerReference,actorRole:role,fhir}:null,findingDefinitions:()=>effective};};
      const evidence=(operation:string,before:unknown,after:unknown,resource:string,extra={})=>roleTest.diagnostic(JSON.stringify({actorRole:role,actorReference:practitionerReference,project:projectId,resource,operation,before,after,policyReference,policyVersion:policy.meta?.versionId,lane:"test:live-authz",blocking:true,...extra}));
      let visitSequence=0;
      const visit=async()=>{
        const encounter=track(await seederFhir.create<Encounter>({resourceType:"Encounter",status:"in-progress",class:{code:"AMB"},period:{start:new Date(Date.now()-86_400_000+(++visitSequence)*1000).toISOString()},subject:{reference:patientReference},participant:[{individual:{reference:practitionerReference}}]}));
        assert.equal(encounter.status,"in-progress");assert.ok(encounter.meta?.versionId);
        return encounter;
      };
      const effective=await new FhirFindingDefinitionStore(fhir).list();
      const definition=effective.find(row=>row.stableKey==="ocular-health:anterior:tear-film");assert.ok(definition);
      const fields=customFieldEntries(definition);const tbut=fields.find(field=>field.valueType==="number"&&/tbut/i.test(field.display));assert.ok(tbut,"Live effective Tear Film has TBUT field");
      const optionField=fields.find(field=>field.valueType==="multi-select");assert.ok(optionField);
      const option=optionField.options?.find(row=>row.active);assert.ok(option);
      const e=await visit();const encounterReference=resourceRef(e);
      const history=async(encounter=e,stableKey=definition.stableKey)=>{const response=await handleCustomSectionHistoryRequest(await deps(),{authHeader,params:{stableKey},query:{patient:patientReference,encounter:resourceRef(encounter)}});assert.equal(response.status,200,JSON.stringify(response.body));return response.body as any;};
      const claim=(fact:any):Claim=>({key:fact.key,baseline:fact.baseline,presence:"present",qualifiers:fact.qualifiers??{},homes:fact.homes??[]});
      const selectedFact=async(encounter=e)=>(await history(encounter)).eyes.OD.facts.find((row:any)=>row.key.optionCode===option.code);
      const save=async(eyes:unknown,encounter=e,commandId=randomUUID())=>handleCustomSectionCaptureRequest(await deps(),{authHeader,params:{stableKey:definition.stableKey},body:{commandId,patientReference,encounterReference:resourceRef(encounter),eyes}});
      const assertResponse=(response:{status:number;body:unknown},status=200)=>assert.equal(response.status,status,JSON.stringify(response.body));
      const readFact=async()=>{const fact=await selectedFact();assert.equal(fact.baseline.kind,"canonical");return real.read<Observation>("Observation",fact.baseline.reference.slice("Observation/".length));};
      const initial=await history();const absent=initial.eyes.OD.facts.find((row:any)=>row.key.optionCode===option.code);assert.ok(absent);
      assertResponse(await save({OD:{loaded:[],selected:[claim(absent)],panel:{baseline:initial.eyes.OD.panel.baseline,state:{deferred:false,values:{[tbut.localCode]:6}}}}}));
      let fact=await readFact();assert.equal(fact.status,"preliminary");assert.ok(fact.meta?.versionId);evidence("save assert","absent",resourceState(fact),resourceRef(fact));
      let sheet=await history();assert.equal(sheet.eyes.OD.panel.values[tbut.localCode],6);const panelBefore=await real.read<Observation>("Observation",sheet.eyes.OD.panel.baseline.reference.slice("Observation/".length));
      evidence("panel create","absent",{...resourceState(panelBefore),tbut:6},resourceRef(panelBefore));
      let loaded=claim(await selectedFact());let before=fact;
      assertResponse(await save({OD:{loaded:[loaded],selected:[]}}));fact=await readFact();assert.equal(fact.status,"entered-in-error");assert.notEqual(fact.meta?.versionId,before.meta?.versionId);evidence("save clear",resourceState(before),resourceState(fact),resourceRef(fact));
      loaded=claim(await selectedFact());before=fact;assertResponse(await save({OD:{loaded:[],selected:[loaded]}}));fact=await readFact();assert.equal(fact.id,before.id);assert.equal(fact.status,"preliminary");assert.notEqual(fact.meta?.versionId,before.meta?.versionId);evidence("save revive",resourceState(before),resourceState(fact),resourceRef(fact));
      sheet=await history();loaded=claim(await selectedFact());assertResponse(await save({OD:{loaded:[loaded],selected:[loaded],panel:{baseline:sheet.eyes.OD.panel.baseline,state:{deferred:false,values:{[tbut.localCode]:9}}}}}));
      sheet=await history();assert.equal(sheet.eyes.OD.panel.values[tbut.localCode],9);const panelAfter=await real.read<Observation>("Observation",sheet.eyes.OD.panel.baseline.reference.slice("Observation/".length));assert.equal(panelAfter.id,panelBefore.id);assert.notEqual(panelAfter.meta?.versionId,panelBefore.meta?.versionId);evidence("panel update",{...resourceState(panelBefore),tbut:6},{...resourceState(panelAfter),tbut:9},resourceRef(panelAfter));
      const negativeVisit=await visit();const negativeId=randomUUID();assertResponse(await save({OD:{loaded:[],selected:[],negativeAct:{id:negativeId,scope:[option.code],exclusions:[]}}},negativeVisit));
      const negativeRows=await searchAll<Observation>(real,"Observation",{encounter:resourceRef(negativeVisit)});const negative=negativeRows.find(row=>row.identifier?.some(id=>id.system==="urn:odos:negative-act"));assert.ok(negative);assert.equal(negative.status,"preliminary");assert.equal((await searchAll<Provenance>(real,"Provenance",{target:resourceRef(negative)})).length,1);evidence("negative act","absent",resourceState(negative),resourceRef(negative));
      const params={encounterId:e.id};const voidFact=()=>deps().then(d=>handleEncounterVoidRequest(d,{authHeader,params,body:{scope:"observation",observationReference:resourceRef(fact)}}));
      const void1=await voidFact();assertResponse(void1);const action1=(void1.body as any).voidActionId;assert.ok(action1);before=fact;fact=await readFact();assert.equal(fact.status,"entered-in-error");evidence("void",resourceState(before),resourceState(fact),resourceRef(fact),{voidActionId:action1});
      const undo=(voidActionId:string)=>deps().then(d=>handleEncounterUndoRequest(d,{authHeader,params,body:{scope:"section",sectionKey:definition.sectionKey??definition.stableKey,voidActionId}}));
      const undo1=await undo(action1);assertResponse(undo1);before=fact;fact=await readFact();assert.equal(fact.status,"preliminary");assert.notEqual(fact.meta?.versionId,before.meta?.versionId);evidence("undo",resourceState(before),resourceState(fact),resourceRef(fact),{voidActionId:action1});
      const void2=await voidFact();assertResponse(void2);const action2=(void2.body as any).voidActionId;assert.ok(action2);assert.notEqual(action2,action1);let count=attempts.length;const superseded=await undo(action1);assertResponse(superseded,409);assert.equal((superseded.body as any).code,"undo-superseded");assert.equal(attempts.length,count);evidence("superseded undo",action2,"409 zero writes",encounterReference,{voidActionId:action1});assertResponse(await undo(action2));
      const legacyVisit=await visit();track(await seederFhir.create<Observation>({resourceType:"Observation",status:"preliminary",code:odosConcept(definition.stableKey),subject:{reference:patientReference},encounter:{reference:resourceRef(legacyVisit)},extension:[{url:ODOS_EXTENSION_URLS.eyeLaterality,valueCodeableConcept:lateralityConcept("OD")}]}));
      count=attempts.length;const legacy=await save({OD:{loaded:[],selected:[]}},legacyVisit);assertResponse(legacy,409);assert.equal(attempts.length,count);assert.match(JSON.stringify(legacy.body),/pre-rebuild/);evidence("pre-rebuild save","legacy read-only","409 zero writes",resourceRef(legacyVisit));
      const closed=await visit();const closedSaved=await seederFhir.update("Encounter",closed.id!,{...closed,status:"finished"});assert.notEqual(closedSaved.meta?.versionId,closed.meta?.versionId);
      const key={...absent.key,encounterId:closed.id};const target={kind:"fact",key,baseline:{kind:"absent",key},state:{status:"live",presence:"present",qualifiers:{},homes:[]}};
      count=attempts.length;assertResponse(await handleDiagnosisFindingsMutationRequest(await deps(),{authHeader,params:{encounterId:closed.id},body:{commandId:randomUUID(),patientReference,operation:"assert",targets:[target]}}),409);assert.equal(attempts.length,count);evidence("closed door PUT","finished","409 zero writes",resourceRef(closed));
      count=attempts.length;assertResponse(await save({OD:{loaded:[],selected:[]}},closed),409);assert.equal(attempts.length,count);evidence("closed save","finished","409 zero writes",resourceRef(closed));
      const sourceVisit=await visit();const catalog=materializeAtomicFindingCatalog(await new FhirFindingDefinitionStore(fhir).list());const carryRow=catalog.find(row=>row.diagnosisKeys.length>0);assert.ok(carryRow);
      const diagnosis=track(await seederFhir.create<Condition>(buildEncounterDiagnosisCondition({patientReference,encounterReference:resourceRef(sourceVisit),code:{text:"Synthetic carry diagnosis"},verificationStatus:"confirmed",identifiers:[{system:DIAGNOSIS_KEY_IDENTIFIER_SYSTEM,value:`${sourceVisit.id}::${carryRow.diagnosisKeys[0]}::right`}]})));
      const linkedSource=await seederFhir.update("Encounter",sourceVisit.id!,{...sourceVisit,diagnosis:[{condition:{reference:resourceRef(diagnosis)}}]});
      assert.equal(linkedSource.status,"in-progress");assert.notEqual(linkedSource.meta?.versionId,sourceVisit.meta?.versionId);
      const sourceKey={v:1,patientId:patient.id,encounterId:sourceVisit.id,stableKey:carryRow.findingDefinitionKey,fieldCode:carryRow.fieldCode,optionCode:carryRow.optionCode,eye:"OD"};
      assertResponse(await handleDiagnosisFindingsMutationRequest(await deps(),{authHeader,params:{encounterId:sourceVisit.id},body:{commandId:randomUUID(),patientReference,operation:"assert",context:{selectedConditionReference:resourceRef(diagnosis)},targets:[{kind:"fact",key:sourceKey,baseline:{kind:"absent",key:sourceKey},state:{status:"live",presence:"present",qualifiers:{},homes:[resourceRef(diagnosis)]}}]}}));
      const sourceFact=(await searchAll<Observation>(real,"Observation",{encounter:resourceRef(sourceVisit)}))[0];assert.ok(sourceFact);
      const pullBody={commandId:randomUUID(),sourceEncounterReference:resourceRef(sourceVisit),sourceConditionReference:resourceRef(diagnosis)};
      const destination=await visit();const pull=(visit:Encounter,body=pullBody)=>deps().then(d=>handleDiagnosisPullRequest(d,{authHeader,params:{encounterId:visit.id},body}));
      count=attempts.length;assertResponse(await pull(closed),role==="provider"?409:403);assert.equal(attempts.length,count);evidence("closed pull","finished",`${role==="provider"?409:403} zero writes`,resourceRef(closed));
      if(role==="provider") {
        const carried=await pull(destination);assertResponse(carried);const body=carried.body as any;assert.ok(body.conditionReference);assert.equal(body.conditionStep,"applied");assert.equal(body.planStep,"applied");assert.equal(body.linkStep,"applied");assert.equal(body.lineageStep,"applied");assert.equal(body.findings.complete,true);
        const storedVisit=await real.read<Encounter>("Encounter",destination.id!);assert.ok(storedVisit.diagnosis?.some(row=>row.condition.reference===body.conditionReference));assert.notEqual(storedVisit.meta?.versionId,destination.meta?.versionId);
        const factsBefore=await searchAll<Observation>(real,"Observation",{encounter:resourceRef(destination)});const conditionsBefore=await searchAll<Condition>(real,"Condition",{encounter:resourceRef(destination)});assert.equal(factsBefore.length,1);assert.equal(conditionsBefore.length,1);
        const commandAudits=await searchAll<Provenance>(real,"Provenance",{_tag:`urn:odos:carry-command:v1|${pullBody.commandId}:plan,urn:odos:carry-command:v1|${pullBody.commandId}:findings`});assert.equal(commandAudits.length,2);
        const replay=await pull(destination);assertResponse(replay);const factsAfter=await searchAll<Observation>(real,"Observation",{encounter:resourceRef(destination)});assert.deepEqual(factsAfter.map(resourceState),factsBefore.map(resourceState));assert.equal((await searchAll<Condition>(real,"Condition",{encounter:resourceRef(destination)})).length,1);assert.equal((await searchAll<Provenance>(real,"Provenance",{_tag:`urn:odos:carry-command:v1|${pullBody.commandId}:plan,urn:odos:carry-command:v1|${pullBody.commandId}:findings`})).length,2);
        evidence("provider pull and identical resend","no diagnosis/facts",{condition:body.conditionReference,facts:factsAfter.map(resourceState),planAndFindingsProvenances:2},resourceRef(destination));
        const finalFact=await seederFhir.update("Observation",sourceFact.id!,{...sourceFact,status:"final"});const finalVisit=await seederFhir.update("Encounter",linkedSource.id!,{...linkedSource,status:"finished"});assert.notEqual(finalFact.meta?.versionId,sourceFact.meta?.versionId);assert.notEqual(finalVisit.meta?.versionId,linkedSource.meta?.versionId);const preRebuildEncounter=await visit();
        const preKey={...sourceKey,encounterId:preRebuildEncounter.id};
        assertResponse(await handleDiagnosisFindingsMutationRequest(await deps(),{authHeader,params:{encounterId:preRebuildEncounter.id},body:{commandId:randomUUID(),patientReference,operation:"assert",targets:[{kind:"fact",key:preKey,baseline:{kind:"absent",key:preKey},state:{status:"live",presence:"present",qualifiers:{},homes:[]}}]}}));
        const preOwner=(await searchAll<Observation>(real,"Observation",{encounter:resourceRef(preRebuildEncounter)}))[0];assert.ok(preOwner);
        const preRebuildFact=await seederFhir.update("Observation",preOwner.id!,{...preOwner,status:"final"});assert.notEqual(preRebuildFact.meta?.versionId,preOwner.meta?.versionId);
        track(await seederFhir.create<Observation>({resourceType:"Observation",status:"preliminary",code:odosConcept(carryRow.findingDefinitionKey),subject:{reference:patientReference},encounter:{reference:resourceRef(preRebuildEncounter)},extension:[{url:ODOS_EXTENSION_URLS.eyeLaterality,valueCodeableConcept:lateralityConcept("OD")}]}));
        providerProof={fact:finalFact,encounter:finalVisit,policyReference,patientReference,preRebuildFact,preRebuildEncounter};
      } else {count=attempts.length;assertResponse(await pull(destination),403);assert.equal(attempts.length,count);evidence("staff pull","unchanged","403 zero writes",resourceRef(destination));}
      fact=await readFact();const signed=await seederFhir.update("Observation",fact.id!,{...fact,status:"final"});count=attempts.length;assertResponse(await voidFact(),422);assert.equal(attempts.length,count);evidence("signed canonical void",resourceState(signed),"422 zero writes",resourceRef(signed));
      const marker=parseFindingOperation(signed);assert.ok(marker);const audits=await searchAll<Provenance>(seederFhir,"Provenance",{target:resourceRef(signed)});const own=audits.find(audit=>audit.meta?.tag?.some(tag=>tag.system===FINDING_OPERATION_AUDIT_SYSTEM&&tag.code===findingAuditKey(marker.commandId,marker.target,marker.audit.kind,marker.digest)));assert.ok(own,"Canonical writer has its operation audit");
      const forged=await seederFhir.update("Provenance",own.id!,{...own,agent:[{...own.agent[0],who:{reference:seederActorReference}}]});assert.notEqual(forged.meta?.versionId,own.meta?.versionId);const mismatchHistory=await history();assert.equal(mismatchHistory.eyes.OD.facts.find((row:any)=>row.key.optionCode===option.code).auditPending,true);evidence("mismatched audit surfaced",resourceState(own),"auditPending true",resourceRef(signed));
    });

    assert.ok(providerProof,"Provider setup completed");
    await t.test("MCP service identity: closed canonical amendment, real session binding and zero-write refusals",async serviceTest=>{
      const provisioningPrincipal=await callerFhir.getAuthenticatedProfileReference();
      const provisionResponse=await fetch(`${baseUrl}/admin/projects/${projectId}/client`,{method:"POST",headers:{Authorization:`Bearer ${callerAccessToken}`,"Content-Type":"application/json"},body:JSON.stringify({name:`r10-a3-service-${randomUUID()}`,description:"Disposable synthetic A3 lifecycle service"})});
      assert.equal(provisionResponse.status,201,"Lane admin provisions disposable service identity");
      const application=await provisionResponse.json() as ClientApplication;
      assert.ok(application.id && application.secret);
      const initialToken=await clientCredentialsToken(baseUrl,application.id,application.secret,"admin");
      const initialSessionResponse=await fetch(`${baseUrl}/auth/me`,{headers:{Authorization:`Bearer ${initialToken}`}});
      assert.equal(initialSessionResponse.status,200);
      const initialSession=await initialSessionResponse.json();
      assert.ok(initialSession.membership?.id);
      const membershipUrl=`${baseUrl}/admin/projects/${projectId}/members/${initialSession.membership.id}`;
      const membershipResponse=await fetch(membershipUrl,{headers:{Authorization:`Bearer ${callerAccessToken}`}});
      assert.equal(membershipResponse.status,200);
      const initialMembership=await membershipResponse.json() as ProjectMembership;
      const {accessPolicy:_legacyPolicy,...membershipWithoutPolicy}=initialMembership;
      try {
      const configureResponse=await fetch(membershipUrl,{method:"POST",headers:{Authorization:`Bearer ${callerAccessToken}`,"Content-Type":"application/fhir+json"},body:JSON.stringify({...membershipWithoutPolicy,admin:true,access:[]})});
      assert.equal(configureResponse.status,200,"Configure only the new service membership");
      const serviceToken=await clientCredentialsToken(baseUrl,application.id,application.secret,"admin");
      const serviceEnv={MEDPLUM_CLIENT_ID:application.id,MEDPLUM_CLIENT_SECRET:application.secret};
      const sessionResponse=await fetch(`${baseUrl}/auth/me`,{headers:{Authorization:`Bearer ${serviceToken}`}});
      assert.equal(sessionResponse.status,200);
      const session=await sessionResponse.json();
      assert.equal(session.profile?.resourceType,"ClientApplication");
      assert.equal(session.profile?.id,application.id);
      assert.equal(session.user,undefined,"Client service has no super-admin User identity");
      assert.notEqual(session.profile?.superAdmin,true,"Never use a super admin for this lifecycle proof");
      assert.equal(session.project?.id,projectId);
      const service=createMedplumClient({baseUrl,audit:TEST_FHIR_AUDIT_RECORDER,auditContext:TEST_FHIR_AUDIT_CONTEXT});
      const mode=await createMcpServiceAuthentication(serviceEnv,projectId,authenticateMedplumService).authenticate(service);assert.equal(mode,"client-credentials");assert.equal(await service.getActiveProjectId(),projectId);
      const serviceActor=await service.getAuthenticatedProfileReference();
      const memberships=(await searchAll<ProjectMembership>(service,"ProjectMembership",{_project:projectId})).filter(row=>row.profile?.reference===serviceActor);
      assert.equal(memberships.length,1,"Service identity has one membership in the disposable project");
      const servicePolicyReferences=[...new Set([...(memberships[0].access??[]).flatMap(access=>access.policy?.reference?[access.policy.reference]:[]),...(memberships[0].accessPolicy?.reference?[memberships[0].accessPolicy.reference]:[])])];
      assert.equal(memberships[0].admin,true,"Project-scoped service admin membership");
      const assertPolicyFree=(membership:ProjectMembership)=>{
        assert.deepEqual(membership.access??[],[],"Service membership has no policy access entries");
        assert.equal(membership.accessPolicy,undefined,"Service membership has no legacy policy");
      };
      assert.throws(()=>assertPolicyFree({...memberships[0],access:[{policy:{reference:providerProof!.policyReference}}]}),/no policy access entries/);
      assert.throws(()=>assertPolicyFree({...memberships[0],accessPolicy:{reference:providerProof!.policyReference}}),/no legacy policy/);
      assertPolicyFree(memberships[0]);
      assert.deepEqual(servicePolicyReferences,[]);
      assert.notEqual(serviceActor,provisioningPrincipal,"Service principal differs from lane admin");
      assert.equal(memberships[0].project.reference,`Project/${projectId}`);
      assert.equal(serviceActor,`ClientApplication/${application.id}`);
      const awaitedProject=await service.getActiveProjectId();
      const evidence=(operation:string,before:unknown,after:unknown,extra={})=>serviceTest.diagnostic(JSON.stringify({actorRole:"MCP service identity",serviceAuthentication:mode,sessionPractitioner:practitionerReference,project:projectId,activeProject:awaitedProject,superAdmin:false,resource:resourceRef(providerProof!.fact),operation,before,after,serviceActor,policyReferences:servicePolicyReferences,serviceAdminMembership:memberships[0].admin===true,provisioningLogin:credentials.email,provisioningPrincipal,clinicianPolicyReference:providerProof!.policyReference,lane:"test:live-authz",blocking:true,...extra}));
      const processHandle=await connectServiceProcess(baseUrl,projectId,practitioner.id!,serviceEnv);
      try {
        const before=await service.read<Observation>("Observation",providerProof!.fact.id!);
        assert.equal(before.status,"final");assert.equal((await service.read<Encounter>("Encounter",providerProof!.encounter.id!)).status,"finished");
        const result=toolBody(await processHandle.client.callTool({name:"amend_observation",arguments:{observation_id:before.id,clinician_id:practitioner.id,target_status:"amended",amendment_text:"Synthetic R10 closed-encounter amendment",signature_data_base64:Buffer.from("synthetic signature").toString("base64")}}));
        const responseReadback=await service.read<Observation>("Observation",before.id!);
        let provenanceReadback:unknown;
        try {const persisted=track(await service.read<Provenance>("Provenance",result.provenance.id));provenanceReadback={reference:resourceRef(persisted),target:persisted.target};}
        catch(error){provenanceReadback={error:error instanceof Error?error.message:String(error)};}
        evidence("amend transaction response",resourceState(before),result.responseBundle.entry.map((entry:any)=>({status:entry.response?.status,outcome:entry.response?.outcome})),{provenance:resourceRef(result.provenance),observationReadback:resourceState(responseReadback),protectedFieldsUnchanged:["identifier","component","extension"].every(field=>JSON.stringify((responseReadback as any)[field])===JSON.stringify((before as any)[field])),provenanceReadback});
        assert.equal(result.responseBundle.entry.length,2);assert.match(String(result.responseBundle.entry[0].response?.status),/^200(?:\s|$)/,"Observation PATCH entry is 200");
        const after=await service.read<Observation>("Observation",before.id!);assert.equal(after.status,"amended");assert.notEqual(after.meta?.versionId,before.meta?.versionId);assert.deepEqual(after.identifier,before.identifier);assert.deepEqual(after.component,before.component);assert.deepEqual(after.extension,before.extension);
        evidence("amend closed canonical",resourceState(before),resourceState(after),{bundleEntryStatuses:result.responseBundle.entry.map((entry:any)=>entry.response.status),provenance:resourceRef(result.provenance),provenanceReadback,knownDefect:"kickoff rev 2.5 §3.13: project-scoped lifecycle Provenance PUT cannot create client-chosen id; result recorded, not required"});
        processHandle.writes.length=0;
        const invalid=await processHandle.client.callTool({name:"create_observation",arguments:{...after,patient_id:providerProof!.patientReference.slice(8),encounter_id:providerProof!.encounter.id}});assert.equal(invalid.isError,true);assert.equal(processHandle.writes.length,0);evidence("generic create shared body (public schema refusal)",resourceState(after),"tool error; zero FHIR writes");
        const append=await processHandle.client.callTool({name:"append_observation_context",arguments:{source_observation_id:after.id,patient_id:providerProof!.patientReference.slice(8),encounter_id:providerProof!.encounter.id,intended_observation_type:"Synthetic shared append",text:"Synthetic append",clinician_id:practitioner.id,signature_data_base64:Buffer.from("synthetic signature").toString("base64")}});assert.equal(append.isError,true);assert.match(JSON.stringify(append),/Shared findings are charted in the finding doors/);assert.equal(processHandle.writes.length,0);evidence("generic append canonical target",resourceState(after),"tool error; zero FHIR writes");
        const preTarget=providerProof!.preRebuildFact;
        const beforePre=await service.read<Observation>("Observation",preTarget.id!);
        const preAudits=await searchAll<Provenance>(service,"Provenance",{target:resourceRef(preTarget)});
        processHandle.writes.length=0;
        const preRefusal=await processHandle.client.callTool({name:"amend_observation",arguments:{observation_id:preTarget.id,clinician_id:practitioner.id,target_status:"amended",amendment_text:"Synthetic pre-rebuild refusal",signature_data_base64:Buffer.from("synthetic signature").toString("base64")}});
        assert.equal(preRefusal.isError,true);assert.match(JSON.stringify(preRefusal),/pre-rebuild-test-encounter/);assert.equal(processHandle.writes.length,0);
        assert.deepEqual(await service.read("Observation",preTarget.id!),beforePre);
        assert.deepEqual((await searchAll<Provenance>(service,"Provenance",{target:resourceRef(preTarget)})).map(resourceState),preAudits.map(resourceState));
        evidence("pre-rebuild canonical amendment",resourceState(beforePre),"refused; zero attempted/persisted FHIR writes",{resource:resourceRef(preTarget),encounter:resourceRef(providerProof!.preRebuildEncounter)});
      } finally {await processHandle.close();}
      const mismatch=await connectServiceProcess(baseUrl,projectId,randomUUID(),serviceEnv);
      try {const before=await service.read<Observation>("Observation",providerProof!.fact.id!);const auditsBefore=await searchAll<Provenance>(service,"Provenance",{target:resourceRef(before)});const response=await mismatch.client.callTool({name:"amend_observation",arguments:{observation_id:before.id,clinician_id:practitioner.id,target_status:"corrected",amendment_text:"Synthetic mismatch",signature_data_base64:Buffer.from("synthetic signature").toString("base64")}});assert.equal(response.isError,true);assert.match(JSON.stringify(response),/match.*session/);assert.equal(mismatch.writes.length,0);assert.deepEqual(await service.read("Observation",before.id!),before);assert.deepEqual((await searchAll<Provenance>(service,"Provenance",{target:resourceRef(before)})).map(resourceState),auditsBefore.map(resourceState));evidence("mismatching session practitioner",resourceState(before),"refused; zero attempted/persisted FHIR writes",{actualSessionPractitioner:"different synthetic practitioner"});}finally{await mismatch.close();}
      const effective=await new FhirFindingDefinitionStore(service).list();const catalog=materializeAtomicFindingCatalog(effective);const final=await service.read<Observation>("Observation",providerProof!.fact.id!);assert.equal(classifyFindingObservation(final,effective,catalog,buildFindingReadAliases(effective,catalog)).kind,"canonical-fact");
      } finally {
        for(const reference of [`ProjectMembership/${initialMembership.id}`,resourceRef(application)]) {
          const response=await fetch(`${baseUrl}/fhir/R4/${reference}`,{method:"DELETE",headers:{Authorization:`Bearer ${callerAccessToken}`}});
          serviceTest.diagnostic(JSON.stringify({operation:"disposable service identity cleanup",reference,status:response.status,removed:[200,204,404,410].includes(response.status),provisioningLogin:credentials.email}));
        }
      }
    });
  } catch (error) {
    bodyFailure = error;
    throw error;
  } finally {
    const errors:unknown[]=[];
    for(const [token,refs] of [[callerAccessToken,[...cleanup].filter(ref=>ref.startsWith("ProjectMembership/"))],[seederAccessToken,[...cleanup].filter(ref=>!ref.startsWith("ProjectMembership/"))]] as const) {try{await cleanupReferences(baseUrl,token,refs);}catch(error){errors.push(error);}}
    if(errors.length)throw new AggregateError(bodyFailure === undefined ? errors : [bodyFailure, ...errors],"Synthetic R10 A3 live-proof cleanup failed");
  }
});
