import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
const root=resolve('.'),runtime=join(root,'.odos/s3c2b-proof');
const read=name=>JSON.parse(readFileSync(join(runtime,name),'utf8'));
const {ports,project}=read('manifest.json');assert.equal(project,'odos-s3c2b-proof');
const credentials=read('credentials.json'),{patientId,encounterId}=read('queue-visits.json');
const base=`http://127.0.0.1:${ports.frontdoor}`,directory='docs/build-log/followup-s3c2b-not-today';
mkdirSync(join(directory,'screenshots'),{recursive:true});
const {chromium}=createRequire(join(root,'ui/package.json'))('playwright-core');
const browser=await chromium.launch({channel:'chrome',headless:true});
const results=[];
try {
 for(const width of [1440,390]) {
  const context=await browser.newContext({viewport:{width,height:1100}});
  try {
   const page=await context.newPage();page.setDefaultTimeout(30000);
   const errors=[];page.on('pageerror',error=>errors.push(error.message));
   await page.goto(`${base}/clinic`);
   await page.getByPlaceholder('Email address').fill(credentials.staff.email);
   await page.getByPlaceholder('Password',{exact:true}).fill(credentials.staff.password);
   await page.getByRole('button',{name:'Enter',exact:true}).click();
   try {await page.getByPlaceholder('Password',{exact:true}).waitFor({state:'detached'});} catch {throw new Error('Synthetic login failed; credential diagnostics withheld.');}
   await page.goto(`${base}/clinic?patientId=${patientId}&encounterId=${encounterId}`);
   await page.getByRole('button',{name:'By structure',exact:true}).click();
   if(width===390) await page.getByRole('button',{name:/^Photos(?: · \d+)?$/}).click();
   await page.getByRole('tab',{name:'Follow-up',exact:true}).click();
   const panel=page.getByRole('tabpanel',{name:'Follow-up',exact:true});
   const row=panel.locator('.odos-follow-up-queue li').filter({has:page.getByRole('heading',{name:'Optic nerve photos',exact:true})});
   await row.getByRole('button',{name:'Not today',exact:true}).waitFor();
   await page.evaluate(()=>document.fonts.ready);
   await page.screenshot({path:join(directory,'screenshots',`${width}-for-review.png`),animations:'disabled',fullPage:true});
   let gets=0,puts=0;
   const count=request=>{if(request.url().endsWith('/follow-up-queue')&&request.method()==='GET')gets++;if(request.url().endsWith('/follow-up-queue/decisions')&&request.method()==='PUT')puts++;};
   page.on('request',count);
   await row.getByRole('button',{name:'Not today',exact:true}).click();
   await row.getByRole('button',{name:'Put back',exact:true}).waitFor();
   assert.equal(await row.locator('.odos-follow-up-queue-state').textContent(),'Not today');
   const whoWhen=await row.locator('.odos-follow-up-queue-decision').textContent();assert.match(whoWhen,/Synthetic staff/);
   assert.ok(await row.locator('time').getAttribute('datetime'));
   assert.match(await row.textContent(),/The shape will not put it back\./);
   assert.equal(await panel.getByRole('alert').count(),0);
   await page.screenshot({path:join(directory,'screenshots',`${width}-not-today.png`),animations:'disabled',fullPage:true});
   await row.getByRole('button',{name:'Put back',exact:true}).click();
   await row.getByRole('button',{name:'Not today',exact:true}).waitFor();
   assert.equal(gets,0);assert.equal(puts,2);assert.deepEqual(errors,[]);
   results.push({width,role:'staff',whoWhen,puts,extraGets:gets,pageErrors:errors});
  } finally {await context.close();}
 }
 writeFileSync(join(directory,'browser-proof.json'),JSON.stringify({syntheticOnly:true,results},null,2)+'\n');
 console.log('Real Chrome: staff Not today and Put back, attribution/time, no extra GET, 1440 and 390.');
} finally {await browser.close();}
