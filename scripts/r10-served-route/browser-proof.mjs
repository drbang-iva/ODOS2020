import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const root=resolve(new URL('../..',import.meta.url).pathname);
const require=createRequire(join(root,'ui/package.json'));
const {chromium}=require('playwright-core');
const runtime=resolve(process.env.R10_RUNTIME ?? join(root,'.odos/r10-a3-2-served'));
const read=name=>JSON.parse(readFileSync(join(runtime,name),'utf8'));
const manifest=read('manifest.json'), fixture=read('fixture.json'), credentials=read('credentials.json');
assert.equal(manifest.project,'odos-r10-a3-2-served');
const base=`http://127.0.0.1:${manifest.ports.frontdoor}`;
const evidence=join(root,'docs/evidence/r10-a3-2/served-route');mkdirSync(evidence,{recursive:true});
const mode=process.argv[2] ?? 'inspect';
for(const suffix of ['result.json','failure.png','failure.txt']){const previous=join(evidence,`${mode}-${suffix}`);if(existsSync(previous))copyFileSync(previous,join(evidence,`${mode}-attempt-${Date.now()}-${suffix}`));}
const result={mode,startedAt:new Date().toISOString(),build:read('build.json'),steps:[],screenshots:[],errors:[]};
function record(step){result.steps.push(step);writeFileSync(join(evidence,`${mode}-result.json`),JSON.stringify(result,null,2));}
const browser=await chromium.launch({executablePath:process.env.R10_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const contexts=[]; let activePage;
async function authenticated(role='provider') {
 const context=await browser.newContext({viewport:{width:1600,height:1100}});contexts.push(context);
 const page=await context.newPage();page.setDefaultTimeout(15000);page.setDefaultNavigationTimeout(30000);
 page.on('pageerror',error=>result.errors.push({kind:'pageerror',message:error.message}));
 await page.goto(base+'/clinic');
 await page.getByPlaceholder('Email address').fill(credentials[role].email);
 await page.getByPlaceholder('Password',{exact:true}).fill(credentials[role].password);
 await page.getByRole('button',{name:'Enter',exact:true}).click();
 await page.getByPlaceholder('Password',{exact:true}).waitFor({state:'detached'});
 return page;
}
async function api(page,path,method='GET',body) {
 const response=await page.evaluate(async ({path,method,body})=>{
  const session=JSON.parse(sessionStorage.getItem('odos.session.v1'));
  const response=await fetch(path,{method,headers:{Authorization:`Bearer ${session.accessToken}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:response.status,body:await response.json()};
 },{path,method,body});
 return response;
}
async function route(page,encounter=fixture.current) {
 await page.goto(`${base}/clinic?patientId=${fixture.patientReference.slice(8)}&encounterId=${encounter.slice(10)}`);
 await page.waitForLoadState('networkidle');
}
async function openOcular(page) {
 await page.getByRole('button',{name:'By structure',exact:true}).click();
 const summary=page.locator('summary').filter({hasText:'Ocular Health'});
 if(await summary.count() && !await summary.first().evaluate(element=>element.parentElement.open)) await summary.first().click();
 await page.locator('[data-editor-section-id="ocular-health:anterior:lens"],button[aria-label="Edit Lens"]').click();
 await page.getByRole('heading',{name:'Anterior & Posterior Segments'}).waitFor();
}
async function undoActualSection(page,destinationPath) {
 const strip=page.locator('[data-undo-scope="section"]').filter({has:page.getByRole('button',{name:'Undo',exact:true})}).first();
 await strip.scrollIntoViewIfNeeded();
 await screenshot(page,'g-undo-control');
 const response=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===destinationPath+'/void/undo',{timeout:30000});
 const [reply]=await Promise.all([response,(async()=>{await strip.getByRole('button',{name:'Undo',exact:true}).focus();await strip.getByRole('button',{name:'Undo',exact:true}).press('Enter');const confirm=page.getByRole('button',{name:'Continue',exact:true});const needsConfirmation=await Promise.race([response.then(()=>false),confirm.waitFor({state:'visible'}).then(()=>true)]);if(needsConfirmation)await confirm.click();})()]);
 assert.equal(reply.status(),200);result.undoActivation={method:'keyboard focus and Enter on actual enabled section Undo button',pointerLimitation:'Existing Add section group absolute-positioned control intercepts pointer clicks; g-undo-control.png retains the obstruction. No layout change or force click.'};const body=await reply.json();result.lastUndoResponse=body;writeFileSync(join(evidence,`${mode}-result.json`),JSON.stringify(result,null,2));return body;
}
async function screenshot(page,name) {
 assert.equal(await page.locator('input[type=password]').count(),0,'Never screenshot credentials');
 const path=join(evidence,name+'.png');await page.screenshot({path,fullPage:true});result.screenshots.push(path);
}
try {
 const page=await authenticated();activePage=page;await route(page,mode==='inspect-destination'?fixture.destination:fixture.current);
 const html=await (await fetch(base)).text();
 const asset=html.match(/src="([^\"]+\.js)"/)?.[1];
 if(asset){const bytes=Buffer.from(await (await fetch(new URL(asset,base))).arrayBuffer());result.servedBundle={path:asset,sha256:createHash('sha256').update(bytes).digest('hex')};}
 if(mode==='final') {
  const path=`/clinical-graph/encounters/${fixture.current.slice(10)}/findings`;
  const nucleus=async()=>{
    const payload=await api(page,path);assert.equal(payload.status,200,JSON.stringify(payload.body));
    return payload.body.searchIndex.filter(row=>row.key?.stableKey==='ocular-health:anterior:lens'&&row.key?.optionCode==='nuclear-sclerosis');
  };
  await page.reload();await page.waitForLoadState('networkidle');await openOcular(page);
  const lens=page.locator('#structure-ocular-health-anterior-lens');
  for(const eye of ['OD','OS'])assert.equal(await lens.locator(`[data-eye-panel="${eye}"]`).getByRole('button',{name:'Nuclear Sclerosis',exact:true}).getAttribute('aria-pressed'),'true');
  const baseline=await nucleus();assert.equal(baseline.filter(row=>row.status==='live'&&row.presence==='present').length,2);
  await lens.scrollIntoViewIfNeeded();await screenshot(page,'b-final-ocular-OU');
  record({name:'b',status:'PASS',facts:baseline.map(row=>({key:row.key,baseline:row.baseline,homes:row.homes}))});
  const od=lens.locator('[data-eye-panel="OD"]');
  const changedGrade=baseline.find(row=>row.eye==='OD').qualifiers?.grade==='2+'?'3+':'2+';
  await od.locator('[data-finding-row="nuclear-sclerosis"]').getByRole('group',{name:'Grade',exact:true}).getByRole('button',{name:changedGrade,exact:true}).click();
  let [reply]=await Promise.all([page.waitForResponse(response=>response.request().method()==='POST'&&response.url().includes('/custom/ocular-health%3Aanterior%3Alens'),{timeout:30000}),page.getByRole('button',{name:'Save Ocular Health',exact:true}).click()]);
  assert.equal((await reply).status(),200);
  const graded=await nucleus();assert.equal(graded.find(row=>row.eye==='OD').qualifiers.grade,changedGrade);
  assert.deepEqual(graded.find(row=>row.eye==='OS').baseline,baseline.find(row=>row.eye==='OS').baseline);
  await page.getByRole('button',{name:'By diagnosis',exact:true}).click();
  const state=read('proof-state.json');
  await page.locator('.odos-diagnosis-visit-row').first().click();
  const rows=page.locator('tr').filter({has:page.getByRole('button',{name:'Clear present nuclear sclerosis',exact:true})});
  await rows.nth(1).waitFor();assert.equal(await rows.count(),2);
  await rows.first().scrollIntoViewIfNeeded();await screenshot(page,'c-diagnosis-split');await page.setViewportSize({width:2200,height:1500});await rows.last().scrollIntoViewIfNeeded();await screenshot(page,'c-diagnosis-split-wide');await page.locator('.odos-diagnosis-findings-table-wrap').evaluate(element=>{element.scrollLeft=element.scrollWidth;});await screenshot(page,'c-diagnosis-split-laterality');await page.setViewportSize({width:1600,height:1100});
  const osRow=page.locator('tr:has(select[aria-label="Laterality nuclear sclerosis"] option[value="OS"]:checked)');
  [reply]=await Promise.all([page.waitForResponse(response=>response.request().method()==='PUT'&&response.url().endsWith('/findings')),osRow.getByRole('button',{name:'Clear present nuclear sclerosis',exact:true}).click()]);assert.equal((await reply).status(),200);
  await openOcular(page);
  assert.equal(await lens.locator('[data-eye-panel="OS"]').getByRole('button',{name:'Nuclear Sclerosis',exact:true}).getAttribute('aria-pressed'),'false');
  await lens.scrollIntoViewIfNeeded();await screenshot(page,'c-ocular-OS-cleared');
  await page.getByRole('button',{name:'By diagnosis',exact:true}).click();await page.locator('.odos-diagnosis-visit-row').first().click();
  await page.getByPlaceholder('Search findings').fill('nuclear sclerosis');
  [reply]=await Promise.all([page.waitForResponse(response=>response.request().method()==='PUT'&&response.url().endsWith('/findings')),page.locator('.odos-diagnosis-finding-search-results button').filter({hasText:/OS$/}).click()]);assert.equal((await reply).status(),200);
  const reasserted=await nucleus();assert.equal(reasserted.find(row=>row.eye==='OS').baseline.reference,baseline.find(row=>row.eye==='OS').baseline.reference);
  record({name:'c',status:'PASS',graded:graded.map(row=>({key:row.key,baseline:row.baseline,qualifiers:row.qualifiers})),reasserted:reasserted.map(row=>({key:row.key,baseline:row.baseline}))});
  await openOcular(page);
  const beforeRetry=await nucleus();
  await lens.locator('[data-eye-panel="OD"]').getByLabel('OD Remarks',{exact:true}).fill('Synthetic dropped reply proof '+Date.now());
  const arm=await fetch(`http://127.0.0.1:${manifest.ports.control}/drop-next`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method:'POST',path:'/clinical-graph/custom/ocular-health%3Aanterior%3Alens'})});assert.equal(arm.status,204);
  const requests=[];const track=request=>{if(request.method()==='POST'&&request.url().includes('/custom/ocular-health%3Aanterior%3Alens'))requests.push(request.postData());};page.on('request',track);
  await page.getByRole('button',{name:'Save Ocular Health',exact:true}).click();await page.getByRole('button',{name:'Retry',exact:true}).waitFor();
  const panelAfterDrop=await api(page,`/clinical-graph/custom/ocular-health%3Aanterior%3Alens/history?patient=${fixture.patientReference}&encounter=${fixture.current}`);
  await screenshot(page,'e-unconfirmed-retry');
  await page.getByRole('button',{name:'Retry',exact:true}).click();await page.getByRole('button',{name:'Retry',exact:true}).waitFor({state:'detached'});page.off('request',track);
  assert.equal(requests.length,2);assert.equal(requests[0],requests[1]);
  const panelAfterRetry=await api(page,`/clinical-graph/custom/ocular-health%3Aanterior%3Alens/history?patient=${fixture.patientReference}&encounter=${fixture.current}`);
  assert.deepEqual(panelAfterRetry.body.eyes.OD.panel.baseline,panelAfterDrop.body.eyes.OD.panel.baseline);
  const afterRetry=await nucleus();assert.deepEqual(afterRetry.map(row=>row.baseline),beforeRetry.map(row=>row.baseline));
  record({name:'e',status:'PASS',identicalRequest:true,panelAfterDrop:panelAfterDrop.body.eyes.OD.panel.baseline,panelAfterRetry:panelAfterRetry.body.eyes.OD.panel.baseline,commandId:JSON.parse(requests[0]).commandId,facts:afterRetry.map(row=>row.baseline),drop:await(await fetch(`http://127.0.0.1:${manifest.ports.control}/status`)).json()});
  const tear=page.locator('#structure-ocular-health-anterior-tear-film').locator('[data-eye-panel="OD"]');
  const tbutValue=await tear.getByRole('combobox',{name:'TBUT',exact:true}).inputValue()==='9'?'8':'9';await tear.getByRole('combobox',{name:'TBUT',exact:true}).fill(tbutValue);await tear.getByRole('combobox',{name:'TBUT',exact:true}).press('Enter');
  [reply]=await Promise.all([page.waitForResponse(response=>response.request().method()==='POST'&&response.url().includes('/custom/ocular-health%3Aanterior%3Atear-film')),page.getByRole('button',{name:'Save Ocular Health',exact:true}).click()]);assert.equal((await reply).status(),200);
  await route(page);await openOcular(page);assert.equal(await tear.getByRole('combobox',{name:'TBUT',exact:true}).inputValue(),tbutValue);await tear.scrollIntoViewIfNeeded();await screenshot(page,'h-TBUT-reloaded');
  const tearHistory=await api(page,`/clinical-graph/custom/ocular-health%3Aanterior%3Atear-film/history?patient=${fixture.patientReference}&encounter=${fixture.current}`);
  record({name:'h',status:'PASS',panel:tearHistory.body.eyes.OD.panel});
  if(await lens.locator('[data-eye-panel="OD"]').getByRole('button',{name:'Cortical Cataract',exact:true}).getAttribute('aria-pressed')==='true'){await lens.locator('[data-eye-panel="OD"]').getByRole('button',{name:'Cortical Cataract',exact:true}).click();if(await page.getByRole('button',{name:'Continue',exact:true}).isVisible())await page.getByRole('button',{name:'Continue',exact:true}).click();const [cleanReply]=await Promise.all([page.waitForResponse(response=>response.request().method()==='POST'&&response.url().includes('/custom/ocular-health%3Aanterior%3Alens')),page.getByRole('button',{name:'Save Ocular Health',exact:true}).click()]);assert.equal((await cleanReply).status(),200);}
  const second=await authenticated();await route(second);await openOcular(second);
  await route(page);await openOcular(page);
  const secondOD=second.locator('#structure-ocular-health-anterior-lens [data-eye-panel="OD"]');
  await secondOD.getByRole('button',{name:'Cortical Cataract',exact:true}).click();
  [reply]=await Promise.all([second.waitForResponse(response=>response.request().method()==='POST'&&response.url().includes('/custom/ocular-health%3Aanterior%3Alens')),second.getByRole('button',{name:'Save Ocular Health',exact:true}).click()]);assert.equal((await reply).status(),200);
  const beforeDeselect=await api(page,path);
  const cortex=row=>row.key?.optionCode==='cortical-cataract'&&row.eye==='OD';
  const added=beforeDeselect.body.searchIndex.find(cortex);assert.equal(added.presence,'present');
  await lens.locator('[data-eye-panel="OD"]').getByRole('button',{name:'Nuclear Sclerosis',exact:true}).click();
  await page.getByRole('button',{name:'Continue',exact:true}).click();
  await screenshot(page,'d-pending-unrelated-deselect');
  [reply]=await Promise.all([page.waitForResponse(response=>response.request().method()==='POST'&&response.url().includes('/custom/ocular-health%3Aanterior%3Alens'),{timeout:30000}),page.getByRole('button',{name:'Save Ocular Health',exact:true}).click()]);assert.equal((await reply).status(),200);
  const afterDeselect=await api(page,path);assert.deepEqual(afterDeselect.body.searchIndex.find(cortex).baseline,added.baseline);
  assert.notEqual(afterDeselect.body.searchIndex.find(row=>row.key?.optionCode==='nuclear-sclerosis'&&row.eye==='OD').presence,'present');
  await route(page);await openOcular(page);await route(second);await openOcular(second);
  const grade=(target,value)=>target.locator('#structure-ocular-health-anterior-lens [data-eye-panel="OD"] [data-finding-row="cortical-cataract"]').getByRole('group',{name:'Grade',exact:true}).getByRole('button',{name:value,exact:true}).click();
  await grade(page,'1+');await grade(second,'3+');
  [reply]=await Promise.all([second.waitForResponse(response=>response.request().method()==='POST'&&response.url().includes('/custom/ocular-health%3Aanterior%3Alens')),second.getByRole('button',{name:'Save Ocular Health',exact:true}).click()]);assert.equal((await reply).status(),200);
  const later=await api(second,path);
  [reply]=await Promise.all([page.waitForResponse(response=>response.request().method()==='POST'&&response.url().includes('/custom/ocular-health%3Aanterior%3Alens'),{timeout:30000}),page.getByRole('button',{name:'Save Ocular Health',exact:true}).click()]);const conflict=await reply;assert.equal(conflict.status(),409);
  const afterConflict=await api(second,path);assert.deepEqual(afterConflict.body.searchIndex.find(cortex).baseline,later.body.searchIndex.find(cortex).baseline);assert.equal(afterConflict.body.searchIndex.find(cortex).qualifiers.grade,'3+');
  await screenshot(page,'d-two-context-stale-conflict');
  record({name:'d',status:'PASS',contexts:2,addition:added.baseline,afterUnrelatedDeselect:afterDeselect.body.searchIndex.find(cortex).baseline,laterValue:later.body.searchIndex.find(cortex),conflict:await conflict.json()});
  await route(page);await page.getByRole('button',{name:'By diagnosis',exact:true}).click();await page.locator('.odos-diagnosis-visit-row').first().click();
  await page.getByPlaceholder('Search findings').fill('nuclear sclerosis');
  [reply]=await Promise.all([page.waitForResponse(response=>response.request().method()==='PUT'&&response.url().endsWith('/findings')),page.locator('.odos-diagnosis-finding-search-results button').filter({hasText:/OD$/}).click()]);assert.equal((await reply).status(),200);
  const sourceFacts=await nucleus();assert.equal(sourceFacts.filter(row=>row.presence==='present'&&row.homes.includes(state.conditionReference)).length,2);
  await route(page,fixture.destination);await page.getByRole('button',{name:'By diagnosis',exact:true}).click();
  for(let older=0;!await page.locator(`[data-source-condition-reference="${state.conditionReference}"]`).count()&&older<20;older++){const load=page.getByRole('button',{name:'Load older encounters',exact:true});assert.ok(await load.count(),'Source diagnosis must be reachable in actual Previous Exams paging');await load.click();await page.waitForLoadState('networkidle');}
  const pullPath=`/clinical-graph/encounters/${fixture.destination.slice(10)}/previous-exams`;
  const pullRequests=[];const trackPull=request=>{if(request.method()==='POST'&&new URL(request.url()).pathname===pullPath)pullRequests.push(request.postData());};page.on('request',trackPull);
  const armed=await fetch(`http://127.0.0.1:${manifest.ports.control}/drop-next`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method:'POST',path:pullPath})});assert.equal(armed.status,204);
  await page.locator(`[data-source-condition-reference="${state.conditionReference}"]`).click();await page.getByRole('button',{name:'Finish carrying',exact:true}).waitFor();
  const destinationPath=`/clinical-graph/encounters/${fixture.destination.slice(10)}`;
  const droppedCarry=await api(page,destinationPath+'/findings');
  await screenshot(page,'g-carry-unconfirmed');
  [reply]=await Promise.all([page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===pullPath),page.getByRole('button',{name:'Finish carrying',exact:true}).click()]);const carriedReply=await reply;assert.equal(carriedReply.status(),200);
  await page.getByRole('button',{name:'Finish carrying',exact:true}).waitFor({state:'detached'});page.off('request',trackPull);
  assert.equal(pullRequests.length,2);assert.equal(pullRequests[0],pullRequests[1]);
  const carry=await carriedReply.json();const carried=await api(page,destinationPath+'/findings');
  const carriedFacts=carried.body.searchIndex.filter(row=>row.key?.optionCode==='nuclear-sclerosis'&&row.presence==='present'&&row.status==='live');assert.equal(carriedFacts.length,2);
  assert.deepEqual(carriedFacts.map(row=>row.baseline),droppedCarry.body.searchIndex.filter(row=>row.key?.optionCode==='nuclear-sclerosis'&&row.presence==='present'&&row.status==='live').map(row=>row.baseline));
  assert.equal(new Set(carriedFacts.flatMap(row=>row.homes)).size,1);
  const overviewBefore=await api(page,destinationPath+'/exam-overview'),completeBefore=await api(page,destinationPath+'/diagnosis-completeness');assert.equal(overviewBefore.status,200);assert.equal(completeBefore.status,200);
  result.carryProgress={identicalCarryRequest:true,carry,carriedFacts,overview:overviewBefore.body,completeness:completeBefore.body};writeFileSync(join(evidence,`${mode}-result.json`),JSON.stringify(result,null,2));
  await openOcular(page);await screenshot(page,'g-carried-OU');
  await page.getByRole('button',{name:'Clear Ocular Health',exact:true}).click();
  [reply]=await Promise.all([page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===destinationPath+'/void'&&!response.url().includes('preview')),page.getByRole('alertdialog').getByRole('button',{name:'Clear Ocular Health',exact:true}).click()]);const voidResponse=await reply;assert.equal(voidResponse.status(),200);const voided=await voidResponse.json();
  await page.getByRole('button',{name:'Undo',exact:true}).first().waitFor();
  const afterVoid=await api(page,destinationPath+'/findings');assert.equal(afterVoid.body.searchIndex.filter(row=>row.key?.optionCode==='nuclear-sclerosis'&&row.presence==='present'&&row.status==='live').length,0);
  const overviewVoid=await api(page,destinationPath+'/exam-overview'),completeVoid=await api(page,destinationPath+'/diagnosis-completeness');
  const carriedOverview=body=>body.findings.filter(row=>row.findingKey==='ocular-health:anterior:lens'&&row.provenance.state==='carried-unreasserted');
  assert.equal(carriedOverview(overviewBefore.body).length,2);assert.ok(carriedOverview(overviewBefore.body).every(row=>row.creditsCompleteness===false));assert.equal(carriedOverview(overviewVoid.body).length,0);assert.deepEqual(completeVoid.body.diagnoses,[]);assert.deepEqual(completeBefore.body.diagnoses,[]);
  await screenshot(page,'g-section-void');
  const undoResult=await undoActualSection(page,destinationPath);
  const restored=await api(page,destinationPath+'/findings');const restoredFacts=restored.body.searchIndex.filter(row=>row.key?.optionCode==='nuclear-sclerosis'&&row.presence==='present'&&row.status==='live');assert.equal(restoredFacts.length,2);assert.deepEqual(restoredFacts.map(row=>row.baseline.reference).sort(),carriedFacts.map(row=>row.baseline.reference).sort());
  const overviewUndo=await api(page,destinationPath+'/exam-overview'),completeUndo=await api(page,destinationPath+'/diagnosis-completeness');
  const restoredOverview=overviewUndo.body.findings.filter(row=>row.findingKey==='ocular-health:anterior:lens'&&row.provenance.state==='current');assert.equal(restoredOverview.length,2);assert.ok(restoredOverview.every(row=>row.creditsCompleteness===false));assert.deepEqual(completeUndo.body.diagnoses,[]);
  await screenshot(page,'g-section-undo');
  record({name:'g',status:'PASS',completenessLimitation:'Shipped nuclear cataract has no configured keyFindings; exact missing-requirement arrays remain empty, so this scenario does not prove a diagnosis-completeness transition. Findings remain explicitly uncredited throughout; after Undo their advanced versions read current/edited per W75/W126.',identicalCarryRequest:true,carry,carriedFacts,voided,undo:undoResult,restoredFacts,overview:{before:overviewBefore.body,void:overviewVoid.body,undo:overviewUndo.body},completeness:{before:completeBefore.body,void:completeVoid.body,undo:completeUndo.body}});

 }
 if(mode==='undo-only') {
  const previous=JSON.parse(readFileSync(join(evidence,'final-result.json'),'utf8'));assert.ok(previous.carryProgress);
  await route(page,fixture.destination);await openOcular(page);
  const prefix=`/clinical-graph/encounters/${fixture.destination.slice(10)}`;
  const before=await api(page,prefix+'/findings');assert.equal(before.body.searchIndex.filter(row=>row.key?.optionCode==='nuclear-sclerosis'&&row.status==='live'&&row.presence==='present').length,0);
  const undo=await undoActualSection(page,prefix);
  const after=await api(page,prefix+'/findings');const facts=after.body.searchIndex.filter(row=>row.key?.optionCode==='nuclear-sclerosis'&&row.status==='live'&&row.presence==='present');assert.equal(facts.length,2);assert.deepEqual(facts.map(row=>row.baseline.reference).sort(),previous.carryProgress.carriedFacts.map(row=>row.baseline.reference).sort());
  const overview=await api(page,prefix+'/exam-overview');const carried=overview.body.findings.filter(row=>row.findingKey==='ocular-health:anterior:lens'&&row.provenance.state==='current');assert.equal(carried.length,2);assert.ok(carried.every(row=>row.creditsCompleteness===false));
  await page.locator('#structure-ocular-health-anterior-lens').scrollIntoViewIfNeeded();await screenshot(page,'g-section-undo');record({name:'g-undo-continuation',status:'PASS',sourceResult:'final-result.json',undo,restoredFacts:facts,overview:overview.body,completeness:await api(page,prefix+'/diagnosis-completeness')});
 }
 if(mode==='before') {
  let payload=await api(page,`/clinical-graph/encounters/${fixture.current.slice(10)}/findings`);
  assert.equal(payload.status,200);
  const offered=payload.body.searchIndex.filter(row=>row.key?.stableKey==='ocular-health:anterior:lens' && row.key?.optionCode==='nuclear-sclerosis');
  assert.equal(offered.length,2);
  const diagnosisKey=offered[0].diagnosisKeys[0];assert.ok(diagnosisKey);
  const pick=await api(page,`/clinical-graph/encounters/${fixture.current.slice(10)}/diagnosis-picks`,'POST',{commandId:crypto.randomUUID(),diagnosisKey,action:'confirm',source:'catalog-search',laterality:'OU'});
  assert.equal(pick.status,200,JSON.stringify(pick.body));
  const conditionReference=`Condition/${pick.body.condition.id}`;
  writeFileSync(join(runtime,'proof-state.json'),JSON.stringify({conditionReference,diagnosisKey,patientReference:fixture.patientReference,encounterReference:fixture.current},null,2));
  await route(page);await page.getByRole('button',{name:'By diagnosis',exact:true}).click();
  await page.locator('.odos-diagnosis-visit-row').filter({hasText:pick.body.condition.code.text}).first().click();
  await page.getByPlaceholder('Search findings').fill('nuclear sclerosis');
  const [assertResponse]=await Promise.all([page.waitForResponse(response=>response.request().method()==='PUT' && response.url().endsWith('/findings')),page.locator('.odos-diagnosis-finding-search-results button').filter({hasText:'nuclear sclerosis'}).first().click()]);
  const written=await assertResponse;assert.equal(written.status(),200,await written.text());
  payload=await api(page,`/clinical-graph/encounters/${fixture.current.slice(10)}/findings`);
  const facts=payload.body.searchIndex.filter(row=>row.key?.optionCode==='nuclear-sclerosis'&&row.status==='live'&&row.presence==='present');assert.equal(facts.length,2);
  await screenshot(page,'a-before619-diagnosis-OU');
  await openOcular(page);
  const lens=page.locator('article').filter({has:page.getByRole('heading',{name:'Lens',exact:true})});
  for(const eye of ['OD','OS'])assert.equal(await lens.locator(`[data-eye-panel="${eye}"]`).getByRole('button',{name:'Nuclear Sclerosis',exact:true}).getAttribute('aria-pressed'),'false');
  await screenshot(page,'a-before619-ocular-missing');
  record({name:'a',status:'PASS',conditionReference,facts:facts.map(row=>({key:row.key,baseline:row.baseline,homes:row.homes}))});
 }
 if(mode==='inspect-destination'){const prefix=`/clinical-graph/encounters/${fixture.destination.slice(10)}`;for(const suffix of ['exam-overview','diagnosis-completeness','findings'])writeFileSync(join(evidence,`destination-${suffix}.json`),JSON.stringify(await api(page,prefix+'/'+suffix),null,2));await page.getByRole('button',{name:'By structure',exact:true}).click();await screenshot(page,'destination-overview-inspection');}
 if(mode==='inspect' || mode==='inspect-structure' || mode==='inspect-ocular') {
  if(mode==='inspect-ocular') await openOcular(page);
  if(mode==='inspect-structure') { await page.getByRole('button',{name:'By structure',exact:true}).click(); await page.waitForLoadState('networkidle'); }
  await screenshot(page,`inspection-${mode}-route`);
  writeFileSync(join(evidence,`inspection-${mode}-route.txt`),await page.locator('body').innerText());
  record({name:'provider-real-login-and-app-route',status:'PASS',url:page.url()});
  const facts=await api(page,`/clinical-graph/encounters/${fixture.current.slice(10)}/findings`);
  writeFileSync(join(evidence,'inspection-findings.json'),JSON.stringify(facts,null,2));
 }
} catch(error) { if(activePage && await activePage.locator('input[type=password]').count()===0){await screenshot(activePage,mode+'-failure');writeFileSync(join(evidence,mode+'-failure.txt'),await activePage.locator('body').innerText());} const safeError=!activePage || await activePage.locator('input[type=password]').count()>0?{message:'Authentication did not complete; credential-bearing details withheld.'}:{message:error.message,stack:error.stack};for(const credential of [credentials.provider,credentials.staff])for(const key of ['message','stack'])if(safeError[key])safeError[key]=safeError[key].replaceAll(credential.password,'[REDACTED]');result.failure=safeError;process.exitCode=1;}
finally {result.finishedAt=new Date().toISOString();writeFileSync(join(evidence,`${mode}-result.json`),JSON.stringify(result,null,2));await browser.close();}
console.log(JSON.stringify({mode,steps:result.steps,failure:result.failure?.message,screenshots:result.screenshots}));
