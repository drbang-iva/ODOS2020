import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(fileURLToPath(new URL('../../../..',import.meta.url)));
const require=createRequire(join(root,'ui/package.json'));
const {chromium}=require('playwright-core');
const runtime=join(root,'.odos/s1-proof');
const read=n=>JSON.parse(readFileSync(join(runtime,n),'utf8'));
const {ports}=read('manifest.json'), credentials=read('credentials.json'),fixture=read('fixture.json');
const base=`http://127.0.0.1:${ports.frontdoor}`;
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1100}});
try {
 await page.goto(base+'/clinic');
 await page.getByPlaceholder('Email address').fill(credentials.provider.email);
 await page.getByPlaceholder('Password',{exact:true}).fill(credentials.provider.password);
 await page.getByRole('button',{name:'Enter',exact:true}).click();
 await page.getByPlaceholder('Password',{exact:true}).waitFor({state:'detached'});
 await page.goto(`${base}/clinic?patientId=${fixture.patientReference.slice(8)}&encounterId=${fixture.current.slice(10)}`);
 await page.waitForLoadState('networkidle');
 await page.getByRole('button',{name:'By structure',exact:true}).click();
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
 await page.getByLabel('Other / notes',{exact:true}).fill('S1 synthetic dry-eye symptom finding');
 const [saved]=await Promise.all([page.waitForResponse(r=>r.request().method()==='POST'&&r.url().includes('/custom/dry-eye%3Asymptoms')),page.getByRole('button',{name:'Save Symptoms',exact:true}).click()]);
 assert.equal(saved.status(),200);
 await page.getByRole('button',{name:'Save Symptoms',exact:true}).waitFor();
 await page.screenshot({path:join(root,'docs/build-log/followup-s1-data-pins-open/01-base-saved.png')});
 const [removed]=await Promise.all([page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/section-groups')),page.getByRole('button',{name:'Remove Dry Eye Workup',exact:true}).click()]);
 assert.equal(removed.status(),200);
 await page.getByRole('heading',{name:'Symptoms',exact:true}).waitFor({state:'detached'});
 await page.getByRole('button',{name:'Back to exam overview',exact:true}).click();
 assert.equal(await page.locator('summary').filter({hasText:'Dry Eye Workup'}).count(),0);
 await page.screenshot({path:join(root,'docs/build-log/followup-s1-data-pins-open/02-base-removed.png')});
 const proof=await page.evaluate(async encounter=>{
   const session=JSON.parse(sessionStorage.getItem('odos.session.v1'));
   const response=await fetch('/fhir/R4/Observation?'+new URLSearchParams({encounter}),{headers:{Authorization:`Bearer ${session.accessToken}`}});
   const body=await response.json();
   return {status:response.status,observations:(body.entry??[]).flatMap(e=>e.resource?.code?.coding?.some(c=>c.code==='dry-eye:symptoms')?[e.resource]:[])};
 },fixture.current);
 assert.equal(proof.status,200);assert.ok(proof.observations.length>0);
 writeFileSync(join(root,'docs/build-log/followup-s1-data-pins-open/proof/base-fhir-read.json'),JSON.stringify(proof,null,2)+'\n');
 console.log(JSON.stringify({removed:removed.status(),sectionHidden:true,storedObservations:proof.observations.length,width:1440}));
}finally{await browser.close();}
