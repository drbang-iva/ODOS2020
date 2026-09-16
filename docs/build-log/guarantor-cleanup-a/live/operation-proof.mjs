import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { PORTS, sourceRoot, refreshFixtureTokens, successfulHttp, http, grantPatients, createLiveClients, resourceEvidence, writeEvidence } from './live-fixture.mjs';

const appOrigin = `http://127.0.0.1:${PORTS.proof}`;
const fixture = await refreshFixtureTokens();
const startedAt = new Date().toISOString();
const paths = ['mcp/src/clinic/guarantor-search.ts', 'mcp/src/clinic/guarantor-link-operation.ts', 'mcp/src/clinic/guarantor-routes.ts', 'mcp/src/fhir-client.ts', 'ui/src/lib/guarantor-editor.ts', 'ui/src/lib/guarantor-link-operations.ts', 'mcp/src/authz/role-grants.ts'];
const provenance = () => ({ head: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).stdout.trim(), files: Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(resolve(sourceRoot, path))).digest('hex')])) });
const beforeSource = provenance();
const fromSource = path => import(pathToFileURL(resolve(sourceRoot, path)).href);
const { default: express } = await fromSource('mcp/node_modules/express/index.js');
const { registerGuarantorRoutes } = await fromSource('mcp/src/clinic/guarantor-routes.ts');
const { authenticateStaffRoute } = await fromSource('mcp/src/payments/payment-endpoint.ts');
const { GUARANTOR_CLAIM_URL: CLAIM } = await fromSource('mcp/src/clinic/guarantor-link-operation.ts');
const { audit, serviceFhir } = await createLiveClients(fixture);
const context = new AsyncLocalStorage();
const events = [], transactions = [], checks = [], cases = [];
const patients = [];
let scenario = 'setup', failed = 0, fatal;
let beforeTransaction, afterTransaction, afterResponse;
function responseEvidence(value, path) {
  if (path !== '/auth/me') return resourceEvidence(value);
  return { evidenceProjection: 'Authentication identity, membership and Person/Task policy rules only; full response digest retained',
    fullResponseSha256: createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    project: resourceEvidence(value.project), profile: resourceEvidence(value.profile),
    membership: resourceEvidence(value.membership), accessPolicy: resourceEvidence(value.accessPolicy),
  };
}
function transactionEvidence(transaction) {
  const { request, response, ...metadata } = transaction;
  return { ...metadata,
    ...(request ? { requestSha256: createHash('sha256').update(JSON.stringify(request)).digest('hex') } : {}),
    ...(response ? { responseSha256: createHash('sha256').update(JSON.stringify(response)).digest('hex') } : {}),
  };
}
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const value = input instanceof Request ? input.url : String(input);
  const url = new URL(value, value.startsWith('/guarantors/') ? appOrigin : fixture.baseUrl);
  assert.ok([fixture.baseUrl, appOrigin].includes(url.origin), 'Live proof stays on its two loopback origins.');
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  const principal = headers.get('authorization') === `Bearer ${fixture.principals.composite.token}` ? 'composite' : headers.get('authorization') === `Bearer ${fixture.serviceToken}` ? 'service' : 'other';
  const frame = context.getStore();
  const event = { sequence: events.length + 1, scenario, runner: frame?.runner, phase: frame?.transaction?.phase, principal, method, path: url.pathname + url.search, origin: url.origin };
  events.push(event);
  if (headers.has('if-match')) event.ifMatch = headers.get('if-match');
  if (typeof init?.body === 'string') event.request = resourceEvidence(JSON.parse(init.body), url.pathname);
  const response = await originalFetch(input instanceof Request ? new Request(url, input) : url, init);
  event.status = response.status;
  try { event.response = responseEvidence(await response.clone().json(), url.pathname); } catch { event.response = '<non-JSON>'; }
  if (afterResponse) await afterResponse(event, frame?.transaction);
  return response;
};
const instrumentedFhir = {
  ...serviceFhir,
  executeTransactionAsActor: async (...args) => {
    const entry = args[0].entry[0], frame = context.getStore();
    const transaction = { sequence: transactions.length + 1, scenario, runner: frame?.runner, phase: args[1].actionReason.split(' ')[1], method: entry.request.method, target: entry.request.url, ifMatch: entry.request.ifMatch, request: resourceEvidence(entry.resource) };
    transactions.push(transaction);
    return context.run({ ...frame, transaction }, async () => {
      try {
        if (beforeTransaction) await beforeTransaction(transaction);
        const result = await serviceFhir.executeTransactionAsActor(...args);
        transaction.status = Number.parseInt(result.entry?.[0]?.response?.status ?? '', 10);
        transaction.response = resourceEvidence(result.entry?.[0]?.resource);
        if (afterTransaction) await afterTransaction(transaction);
        return result;
      } catch (error) {
        transaction.error = { name: error.name, message: error.message };
        throw error;
      }
    });
  },
};
const app = express();
app.use(express.json());
app.use((req, _res, next) => context.run({ runner: req.header('x-g2b1-proof-runner') ?? 'editor' }, next));
registerGuarantorRoutes(app, {
  authenticateService: async () => { assert.equal(await serviceFhir.getAuthenticatedProfileReference(), fixture.serviceReference); },
  authenticate: header => authenticateStaffRoute({ baseUrl: fixture.baseUrl, authHeader: header, serviceClient: serviceFhir, audit }),
  serviceFhir: instrumentedFhir,
  recordAudit: row => audit.record(row, () => undefined),
});
const server = await new Promise((accept, reject) => { const server = app.listen(PORTS.proof, '127.0.0.1', () => accept(server)); server.once('error', reject); })
  .catch(async error => { await audit.close(); globalThis.fetch = originalFetch; throw error; });
async function route(path, body, runner='proof') {
  return context.run({runner}, async()=>{
    const response=await fetch(new URL(`/guarantors${path}`,appOrigin),{method:body||path.endsWith('/complete')?'POST':'GET',headers:{Authorization:`Bearer ${fixture.principals.composite.token}`,'Content-Type':'application/json','x-g2b1-proof-runner':runner},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,body:await response.json()};
  });
}
const check=(label,actual,expected)=>{assert.deepEqual(actual,expected,label);checks.push({scenario,label,actual,expected,passed:true});};
const read=(type,id)=>successfulHttp(fixture,'GET',`/fhir/R4/${type}/${id}`);
const make=resource=>successfulHttp(fixture,'POST',`/fhir/R4/${resource.resourceType}`,{body:{...resource,meta:{project:fixture.projectA}}});
async function person(label){const result=await route('',{firstName:label,lastName:'CleanupSynthetic',birthDate:'1980-01-02',phones:[{value:'',use:'mobile'},{value:'',use:'mobile'}],textable:'',middleName:'',address:'',city:'',state:'',postalCode:''});check('create201',result.status,201);return result.body;}
const discard=p=>route(`/${p.personId}/discard`,{reason:`Synthetic ${scenario} cleanup`,expectedVersion:p.versionId},'discard');
async function family(label,owned=false){
 const patient=await make({resourceType:'Patient',name:[{family:'CleanupSynthetic',given:[label]}]});patients.push(patient.id);
 const child=await make({resourceType:'RelatedPerson',active:true,patient:{reference:`Patient/${patient.id}`},name:[{family:'CleanupSynthetic',given:[label]}]});
 await grantPatients(fixture,'composite',[fixture.patientId,...patients]);
 let source;if(owned){source=await person(`${label} source`);const attached=await attach({child,destination:source});check('seed real attach200',attached.status,200);}
 return {patient,child,source,destination:await person(`${label} destination`)};
}
async function attach(f,kind='attach'){
 const child=await read('RelatedPerson',f.child.id),destination=await read('Person',f.destination.personId);
 const expected={[`RelatedPerson/${child.id}`]:child.meta.versionId,[`Person/${destination.id}`]:destination.meta.versionId};
 if(kind!=='attach'){const source=await read('Person',f.source.personId);expected[`Person/${source.id}`]=source.meta.versionId;}
 return route('/link-operations',{operationId:randomUUID(),kind,...kind==='attach'?{}:{sourcePersonId:f.source.personId},destinationPersonId:destination.id,relatedPersonIds:[child.id],expected,reason:`Synthetic ${scenario}`},'attach');
}
async function snapshot(f){
 const child=await read('RelatedPerson',f.child.id),destination=await read('Person',f.destination.personId);
 const source=f.source?await read('Person',f.source.personId):undefined;
 const owners=(await successfulHttp(fixture,'GET',`/fhir/R4/Person?link=${encodeURIComponent(`RelatedPerson/${child.id}`)}`)).entry?.map(e=>e.resource.id)??[];
 for(const p of [source,destination].filter(Boolean))check(`G1 ${p.id}`,p.active===false&&(p.link?.length??0)>0,false);
 return {child,destination,source,owners};
}
const undo=id=>route(`/link-operations/${id}/correct`,{operationId:randomUUID(),reason:'Synthetic discarded destination Undo'},'undo');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const bounded=async p=>{let timer;try{return await Promise.race([p,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Race schedule timed out')),15000))]);}finally{clearTimeout(timer);}};
async function run(label,fn){scenario=label;const result=await fn();cases.push({scenario,...result});console.log(JSON.stringify({scenario,status:'passed'}));}
try{
 await run('create-list-discard-O2-O10',async()=>{
  const p=await person('Abandoned');const original=await read('Person',p.personId);
  check('listed',(await route('/unused')).body.some(r=>r.personId===p.personId),true);
  const denied=await http(fixture,'PUT',`/fhir/R4/Person/${p.personId}`,{token:fixture.principals.staff.token,principal:'staff',body:{...original,active:false},headers:{'If-Match':`W/"${original.meta.versionId}"`}});
  check('O10 raw staff active write403',denied.status,403);
  check('discard200',(await discard(p)).status,200);const final=await read('Person',p.personId);check('inactive',final.active,false);check('unlinked',final.link?.length??0,0);
  check('not relisted',(await route('/unused')).body.some(r=>r.personId===p.personId),false);check('second discard409',(await discard(p)).status,409);return {original,final};
 });
 await run('retained-real-Move-Undo',async()=>{
  const f=await family('Move',true);const moved=await attach(f,'transfer');check('Move200',moved.status,200);const before=await snapshot(f);check('source retained inactive',before.source.active,false);
  check('retained excluded',(await route('/unused')).body.some(r=>r.personId===f.source.personId),false);check('retained discard409',(await discard({...f.source,versionId:before.source.meta.versionId})).status,409);
  const corrected=await undo(moved.body.task.id);check('Undo200',corrected.status,200);const final=await snapshot(f);check('source reactivated',final.source.active,true);check('source owns child',final.owners,[f.source.personId]);return {moved,corrected,before,final};
 });
 for(const kind of ['attach','transfer','consolidate'])await run(`X1-X3-${kind}`,async()=>{
  const f=await family(`Race ${kind}`,kind!=='attach');let attachPromise;const recorded=deferred(),resume=deferred();
  afterTransaction=async tx=>{if(tx.runner==='attach'&&tx.method==='POST'&&tx.target==='Task'){recorded.resolve();await bounded(resume.promise);}};
  beforeTransaction=async tx=>{if(tx.runner==='discard'&&tx.target===`Person/${f.destination.personId}`){beforeTransaction=undefined;attachPromise=attach(f,kind);await bounded(recorded.promise);}};
  let discarded,started;try{discarded=await discard(f.destination);check('discard wins200',discarded.status,200);resume.resolve();started=await attachPromise;}finally{resume.resolve();beforeTransaction=afterTransaction=undefined;}
  check('initial attach paused',[started.status,started.body.phase],[409,'attach-pending']);const first=transactions.length;
  const completed=await route(`/link-operations/${started.body.task.id}/complete`,undefined,'complete');check('Complete refuses',[completed.status,completed.body.phase],[409,'destination-inactive']);check('Complete no transaction writes',transactions.length-first,0);
  const paused=await snapshot(f);check('discarded zero links',[paused.destination.active,paused.destination.link?.length??0],[false,0]);check('paused no owner',paused.owners,[]);
  const corrected=await undo(started.body.task.id);check('existing Undo200',corrected.status,200);const final=await snapshot(f);check('claim released',final.child.extension?.filter(e=>e.url===CLAIM).length??0,0);check('Undo ownership',final.owners,kind==='attach'?[]:[f.source.personId]);return {discarded,started,completed,corrected,paused,final};
 });
 await run('X2-attach-wins',async()=>{
  const f=await family('Attach wins');let attached;
  beforeTransaction=async tx=>{if(tx.runner==='discard'&&tx.target===`Person/${f.destination.personId}`){beforeTransaction=undefined;attached=await attach(f);check('attach200',attached.status,200);}};
  const discarded=await discard(f.destination);beforeTransaction=undefined;check('discard loses409',discarded.status,409);const final=await snapshot(f);check('active owned',[final.destination.active,final.owners],[true,[f.destination.personId]]);return {attached,discarded,final};
 });
}catch(error){fatal={name:error.name,message:error.message,stack:error.stack};failed++;}
finally{
 const afterSource=provenance();if(JSON.stringify(beforeSource.files)!==JSON.stringify(afterSource.files)){failed++;fatal??={message:'Source changed during proof'};}
 const auditRows=await audit.queryRows({from:startedAt,limit:10000});
 if(!fatal)for(const label of ['create-list-discard-O2-O10','X1-X3-attach','X1-X3-transfer','X1-X3-consolidate']){scenario='audit';check(`discard audit actor and reason ${label}`,auditRows.some(row=>row.eventType==='guarantor.link.completed'&&row.actorId===fixture.principals.composite.profileReference.split('/')[1]&&row.actionReason===`guarantor.link discard Person; Synthetic ${label} cleanup`),true);}
 writeEvidence('operation-proof.json',{startedAt,beforeSource,afterSource,checks,cases,failed,fatal,auditRows,authorOnly:true});writeEvidence('operation-http.json',{events,transactions},0);
 await new Promise(resolve=>server.close(resolve));await audit.close();globalThis.fetch=originalFetch;
}
console.log(JSON.stringify({cases:cases.length,checks:checks.length,failed,fatal}));if(failed)process.exitCode=1;
