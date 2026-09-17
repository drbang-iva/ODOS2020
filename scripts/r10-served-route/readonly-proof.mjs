import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,mkdirSync,existsSync,readdirSync,copyFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {loadVerifiedOperatorFhirClient} from '../operator-identity.ts';
import {canonicalFact,keyFor} from '../../mcp/tests/fixtures/r10/writer-harness.ts';
import {snapshot,comp} from '../../mcp/tests/fixtures/r10/factories.ts';
import {currentFindingIdentifier} from '../../mcp/src/clinical-graph/current-finding-identity.ts';
const root=resolve(fileURLToPath(new URL('../..',import.meta.url))),runtime=resolve(process.env.R10_RUNTIME??join(root,'.odos/r10-a3-2-served'));
const read=name=>JSON.parse(readFileSync(join(runtime,name),'utf8'));
const manifest=read('manifest.json'),credentials=read('credentials.json'),mainFixture=read('fixture.json');
assert.equal(manifest.project,'odos-r10-a3-2-served');
const evidence=join(process.env.R10_EVIDENCE ?? join(root,'docs/evidence/r10-a3-2'),'readonly');mkdirSync(evidence,{recursive:true});
const priorFiles=readdirSync(evidence,{withFileTypes:true}).filter(f=>f.isFile()&&f.name!=='run.log');if(priorFiles.length){const archive=join(evidence,'attempts',new Date().toISOString().replaceAll(':','-'));mkdirSync(archive,{recursive:true});for(const file of priorFiles)copyFileSync(join(evidence,file.name),join(archive,file.name));}
const fixturePath=join(runtime,'readonly-fixture.json');
const operator=await loadVerifiedOperatorFhirClient({baseUrl:`http://127.0.0.1:${manifest.ports.medplum}`,projectId:credentials.projectId,postgresUrl:`postgresql://medplum:medplum@127.0.0.1:${manifest.ports.postgres}/medplum`,credentialPath:join(runtime,'operator.env'),statePath:join(runtime,'operator-state.json')});
const save=(path,value)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n');
if(process.argv[2]==='seed'){
 const fixture=existsSync(fixturePath)?JSON.parse(readFileSync(fixturePath,'utf8')):{patientReference:mainFixture.patientReference};
 for(const kind of ['signedWitness','closed','preRebuild']){
  if(fixture[kind])continue;
  const encounter=await operator.fhir.create({resourceType:'Encounter',status:kind==='closed'?'finished':'in-progress',class:{code:'AMB'},subject:{reference:fixture.patientReference},period:{start:new Date().toISOString()},participant:[{individual:{reference:credentials.provider.practitionerReference}}]});
  const encounterReference=`Encounter/${encounter.id}`;
  const resource=kind==='preRebuild'?snapshot():canonicalFact();delete resource.id;delete resource.meta;
  resource.subject={reference:fixture.patientReference};resource.encounter={reference:encounterReference};resource.effectiveDateTime=new Date().toISOString();
  if(kind!=='preRebuild'){
   const key={...keyFor(),patientId:fixture.patientReference.slice(8),encounterId:encounter.id};
   resource.identifier=[currentFindingIdentifier(key)];resource.component=[comp('R10_CURRENT_META',JSON.stringify(key))];resource.status='final';
  }
  const observation=await operator.fhir.create(resource);
  fixture[kind]={encounterReference,observationReference:`Observation/${observation.id}`};save(fixturePath,fixture);
 }
 if(!fixture.unscopedReference){const old=snapshot();delete old.id;delete old.meta;delete old.encounter;old.subject={reference:fixture.patientReference};const stored=await operator.fhir.create(old);fixture.unscopedReference=`Observation/${stored.id}`;save(fixturePath,fixture);}
 console.log('Separate synthetic readonly fixtures seeded.');process.exit(0);
}
assert.equal(process.argv[2],'run','Use seed or run; run only after final app is ready');
const fixture=JSON.parse(readFileSync(fixturePath,'utf8')),base=`http://127.0.0.1:${manifest.ports.frontdoor}`;
const result={startedAt:new Date().toISOString(),build:read('build.json'),fixture,steps:[],screenshots:[],errors:[]};
const require=createRequire(join(root,'ui/package.json')), {chromium}=require('playwright-core');
const browser=await chromium.launch({executablePath:process.env.R10_CHROME??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const context=await browser.newContext({viewport:{width:1600,height:1100}}),page=await context.newPage();page.setDefaultTimeout(20000);
page.on('pageerror',()=>result.errors.push('Browser page error; details omitted to protect credentials.'));page.on('response',r=>{const path=new URL(r.url()).pathname;if(path==='/auth/login'||path==='/oauth2/token'){result.authStatuses??=[];result.authStatuses.push({path,status:r.status()});}});
const api=async path=>page.evaluate(async path=>{const session=JSON.parse(sessionStorage.getItem('odos.session.v1'));const response=await fetch(path,{headers:{Authorization:`Bearer ${session.accessToken}`}});return {status:response.status,body:await response.json()};},path);
const route=async encounter=>{await page.goto(`${base}/clinic?patientId=${fixture.patientReference.slice(8)}&encounterId=${encounter.slice(10)}`);await page.waitForLoadState('networkidle');};
const ocular=async()=>{await page.getByRole('button',{name:'By structure',exact:true}).click();const summary=page.locator('summary').filter({hasText:'Ocular Health'});if(await summary.count()&&!await summary.first().evaluate(e=>e.parentElement.open))await summary.first().click();const edit=page.getByRole('button',{name:'Edit Lens',exact:true});if(await edit.count())await edit.click();else await page.locator('[data-editor-section-id="ocular-health:anterior:lens"]').click();await page.getByRole('heading',{name:'Anterior & Posterior Segments'}).waitFor();};
const shot=async name=>{assert.equal(await page.locator('input[type=password]').count(),0);const path=join(evidence,`${name}.png`);await page.screenshot({path,fullPage:true});result.screenshots.push(path);save(join(evidence,`${name}-text.json`),await page.locator('body').innerText());};
const observation=async ref=>operator.fhir.read('Observation',ref.slice(12));
try{
 await page.goto(base+'/clinic');await page.getByPlaceholder('Email address').fill(credentials.provider.email);await page.getByPlaceholder('Password',{exact:true}).fill(credentials.provider.password);await page.getByRole('button',{name:'Enter',exact:true}).click();await page.getByPlaceholder('Password',{exact:true}).waitFor({state:'detached'});
 const html=await(await fetch(base)).text(),asset=html.match(/src="([^\"]+\.js)"/)?.[1];assert.ok(asset);result.servedBundle={path:asset,sha256:createHash('sha256').update(Buffer.from(await(await fetch(new URL(asset,base))).arrayBuffer())).digest('hex')};
 const signed=fixture.signedWitness,before=await observation(signed.observationReference);assert.equal(before.status,'final');
 await route(signed.encounterReference);await ocular();const lens=page.locator('#structure-ocular-health-anterior-lens'),od=lens.locator('[data-eye-panel="OD"]');
 const chip=od.getByRole('button',{name:'Nuclear Sclerosis',exact:true});assert.equal(await chip.getAttribute('aria-pressed'),'true');assert.equal(await chip.isDisabled(),true);assert.equal(await od.getByLabel('OD Remarks',{exact:true}).isEnabled(),true);assert.equal(await od.getByRole('button',{name:'Not performed / deferred',exact:true}).isEnabled(),true,'Signed fact leaves editable panel control available');await lens.scrollIntoViewIfNeeded();await shot('signed-witness-checked-locked');
 const prior=await api(`/clinical-graph/custom/ocular-health%3Aanterior%3Alens/history?patient=${fixture.patientReference}`);assert.equal(prior.status,200);assert.ok(prior.body.unscopedCount>=1);await page.getByText('Some older records could not be placed on a visit',{exact:true}).waitFor();await page.getByText('Some older records could not be placed on a visit',{exact:true}).scrollIntoViewIfNeeded();await shot('unscoped-priors-notice');result.steps.push({name:'W145 unscoped priors notice',unscopedCount:prior.body.unscopedCount,reference:fixture.unscopedReference});
 const remarks=`Synthetic signed witness Remarks ${Date.now()}`;await od.getByLabel('OD Remarks',{exact:true}).fill(remarks);
 const response=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().includes('/custom/ocular-health%3Aanterior%3Alens'));await page.getByRole('button',{name:'Save Ocular Health',exact:true}).click();const reply=await response;assert.equal(reply.status(),200);const saved=await reply.json();assert.equal(saved.complete,true);
 const after=await observation(signed.observationReference);assert.deepEqual(after,before,'Signed fact id, version and all content unchanged');
 await route(signed.encounterReference);await ocular();assert.equal(await od.getByLabel('OD Remarks',{exact:true}).inputValue(),remarks);assert.equal(await chip.getAttribute('aria-pressed'),'true');assert.equal(await chip.isDisabled(),true);await lens.scrollIntoViewIfNeeded();await shot('signed-witness-remarks-reloaded');await od.getByLabel('OD Remarks',{exact:true}).scrollIntoViewIfNeeded();await shot('signed-witness-remarks-value');
 result.steps.push({name:'W147 signed witness Remarks save',before,after,reply:saved,remarks,unchanged:true});
 for(const kind of ['closed','preRebuild']){
  const f=fixture[kind],before=await observation(f.observationReference);await route(f.encounterReference);await page.getByRole('button',{name:'By diagnosis',exact:true}).click();
  const finding=await api(`/clinical-graph/encounters/${f.encounterReference.slice(10)}/findings`);assert.equal(finding.status,200);assert.equal(finding.body.encounterEditable,false);assert.equal(finding.body.readOnlyReason,kind==='closed'?'encounter-closed':'pre-rebuild-test-encounter');
  const label=kind==='closed'?/Signed or closed visit/i:/Test data from before the rebuild/i;await page.getByText(label).first().waitFor();
  const standalone=page.getByRole('button',{name:'Record nuclear sclerosis standalone',exact:true});assert.equal(await standalone.count(),1,'Stored finding remains visible in diagnosis door');assert.equal(await standalone.isDisabled(),true,'Actual diagnosis finding mutation control locked');assert.equal(await page.getByPlaceholder('Search findings').count(),0,'No finding write search without editable selection');await shot(`${kind}-diagnosis-readonly`);await standalone.scrollIntoViewIfNeeded();await shot(`${kind}-diagnosis-locked-control`);
  await ocular();await page.getByText(label).first().waitFor();await page.getByText(label).first().scrollIntoViewIfNeeded();await shot(`${kind}-ocular-label`);assert.equal(await page.getByRole('button',{name:'Save Ocular Health',exact:true}).count(),0);assert.equal(await od.getByLabel('OD Remarks',{exact:true}).isDisabled(),true);assert.equal(await od.getByRole('button',{name:'Not performed / deferred',exact:true}).isDisabled(),true,'Closed or pre-rebuild panel locks Deferred');await lens.scrollIntoViewIfNeeded();await shot(`${kind}-ocular-readonly`);
  const after=await observation(f.observationReference);assert.deepEqual(after,before);result.steps.push({name:`f ${kind} both doors`,findingReadOnlyReason:finding.body.readOnlyReason,before,after,unchanged:true});
 }
 const staffContext=await browser.newContext({viewport:{width:1600,height:1100}}),staff=await staffContext.newPage();
 await staff.goto(base+'/clinic');await staff.getByPlaceholder('Email address').fill(credentials.staff.email);await staff.getByPlaceholder('Password',{exact:true}).fill(credentials.staff.password);await staff.getByRole('button',{name:'Enter',exact:true}).click();await staff.getByPlaceholder('Password',{exact:true}).waitFor({state:'detached'});
 await staff.goto(`${base}/clinic?patientId=${fixture.patientReference.slice(8)}&encounterId=${fixture.closed.encounterReference.slice(10)}`);await staff.waitForLoadState('networkidle');await staff.getByRole('button',{name:'By diagnosis',exact:true}).click();await staff.getByText('Signed or closed visit',{exact:true}).first().waitFor();assert.equal(await staff.locator('input[type=password]').count(),0);const staffShot=join(evidence,'staff-closed-diagnosis.png');await staff.screenshot({path:staffShot,fullPage:true});result.screenshots.push(staffShot);result.steps.push({name:'Independent staff browser context actual login and closed diagnosis read-only'});
}catch(error){const loginVisible=(await Promise.all(browser.contexts().flatMap(c=>c.pages()).map(p=>p.locator('input[type=password]').count()))).some(Boolean);result.failure=loginVisible?{message:'Synthetic authentication failed; credential-bearing details omitted.'}:{message:error.message,stack:error.stack};if(!loginVisible)await shot('failure');process.exitCode=1;}
finally{result.finishedAt=new Date().toISOString();save(join(evidence,'result.json'),result);await browser.close();}
console.log(JSON.stringify({steps:result.steps.map(s=>s.name),failure:result.failure?.message,screenshots:result.screenshots}));
