import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(fileURLToPath(new URL('../../../..',import.meta.url)));
const require=createRequire(join(root,'ui/package.json'));
const {chromium}=require('playwright-core');
const runtime=join(root,'.odos/s1b-proof');
const read=n=>JSON.parse(readFileSync(join(runtime,n),'utf8'));
const {ports}=read('manifest.json'), credentials=read('credentials.json'),fixture=read('fixture.json');
const target=fixture.current;
const base=`http://127.0.0.1:${ports.frontdoor}`;
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1100}});
try {
 await page.goto(base+'/clinic');
 await page.getByPlaceholder('Email address').fill(credentials.provider.email);
 await page.getByPlaceholder('Password',{exact:true}).fill(credentials.provider.password);
 await page.getByRole('button',{name:'Enter',exact:true}).click();
 await page.getByPlaceholder('Password',{exact:true}).waitFor({state:'detached'});
 await page.goto(`${base}/clinic?patientId=${fixture.patientReference.slice(8)}&encounterId=${target.slice(10)}`);
 await page.waitForLoadState('networkidle');
 await page.getByRole('button',{name:'By structure',exact:true}).click();
 if(process.argv[2] !== 'resume'){
 assert.equal(await page.locator('summary').filter({hasText:'Dry Eye Workup'}).count(),0);
 await page.screenshot({path:join(root,'docs/build-log/followup-s1b-no-category-defaults/03-comprehensive-hidden.png')});
 await page.locator('summary').filter({hasText:'Ocular Health'}).click();
 await page.locator('[data-editor-section-id="ocular-health:anterior:cornea"]').click();
 await page.waitForTimeout(1000);
 if(await page.getByRole('combobox',{name:'Add section group',exact:true}).count()){
 await page.getByRole('combobox',{name:'Add section group',exact:true}).click();
 await page.getByRole('option',{name:'Dry Eye Workup',exact:true}).click();
 }
 await page.getByRole('button',{name:'Back to exam overview',exact:true}).click();
 await page.locator('summary').filter({hasText:'Dry Eye Workup'}).click();
 await page.locator('[data-editor-section-id="dry-eye:symptoms"]').click();
 await page.screenshot({path:join(root,'docs/build-log/followup-s1b-no-category-defaults/04-pulled-in.png')});
 {
  await page.getByLabel('Other / notes',{exact:true}).fill('S1b synthetic finding');
  const [saved]=await Promise.all([page.waitForResponse(r=>r.request().method()==='POST'&&r.url().includes('/custom/dry-eye%3Asymptoms')),page.getByRole('button',{name:'Save Symptoms',exact:true}).click()]);
  assert.equal(saved.status(),200);
  await page.getByText('Has findings this visit',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Remove Dry Eye Workup',exact:true}).count(),0);
  const refusal=await page.evaluate(async encounter=>{
   const session=JSON.parse(sessionStorage.getItem('odos.session.v1'));
   const r=await fetch(`/clinical-graph/encounters/${encounter.slice(10)}/section-groups`,{method:'POST',headers:{Authorization:`Bearer ${session.accessToken}`,'Content-Type':'application/json'},body:JSON.stringify({action:'remove',groupKey:'dry-eye-workup'})});
   return {status:r.status,body:await r.json()};
  },target);
  assert.equal(refusal.status,409);assert.deepEqual(refusal.body.sectionKeys,['dry-eye:symptoms']);
  await page.locator('td').filter({hasText:'S1b synthetic finding'}).first().waitFor();
  await page.screenshot({path:join(root,'docs/build-log/followup-s1b-no-category-defaults/05-save-pinned.png')});
  writeFileSync(join(root,'docs/build-log/followup-s1b-no-category-defaults/proof/fresh-http.json'),JSON.stringify(refusal,null,2)+'\n');
  console.log('Fresh saved finding pins immediately; API removal returns 409; section and history stay visible.');
 }
 }
 const cleared=await page.evaluate(async encounter=>{
   const session=JSON.parse(sessionStorage.getItem('odos.session.v1'));
   const response=await fetch(`/clinical-graph/encounters/${encounter.slice(10)}/void`,{method:'POST',headers:{Authorization:`Bearer ${session.accessToken}`,'Content-Type':'application/json'},body:JSON.stringify({scope:'section',sectionKey:'dry-eye:symptoms'})});
   return {status:response.status,body:await response.json()};
 },target);
 assert.equal(cleared.status,200);
 assert.ok(cleared.body.voided.length>0);
 writeFileSync(join(root,'docs/build-log/followup-s1b-no-category-defaults/proof/clear-http.json'),JSON.stringify(cleared,null,2)+'\n');
 await page.reload();
 await page.waitForLoadState('networkidle');
 await page.getByRole('button',{name:'By structure',exact:true}).click();
 await page.locator('summary').filter({hasText:'Dry Eye Workup'}).click();
 await page.locator('[data-editor-section-id="dry-eye:symptoms"]').click();
 await page.getByRole('button',{name:'Remove Dry Eye Workup',exact:true}).waitFor();
 {
  await page.screenshot({path:join(root,'docs/build-log/followup-s1b-no-category-defaults/06-empty-before-remove.png')});
  const [removed]=await Promise.all([page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/section-groups')),page.getByRole('button',{name:'Remove Dry Eye Workup',exact:true}).click()]);
  assert.equal(removed.status(),200);
  await page.getByRole('heading',{name:'Symptoms',exact:true}).waitFor({state:'detached'});
  await page.getByRole('button',{name:'Back to exam overview',exact:true}).click();
  assert.equal(await page.locator('summary').filter({hasText:'Dry Eye Workup'}).count(),0);
  await page.screenshot({path:join(root,'docs/build-log/followup-s1b-no-category-defaults/07-empty-removed.png')});
  console.log('Empty group removed with HTTP 200; section disappears.');
 }
}finally{await browser.close();}
