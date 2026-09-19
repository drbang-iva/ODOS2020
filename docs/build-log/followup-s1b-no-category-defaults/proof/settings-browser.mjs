import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
const root=process.cwd(), out=join(root,'docs/build-log/followup-s1b-no-category-defaults');
const require=createRequire(join(root,'ui/package.json')), {chromium}=require('playwright-core');
const runtime=join(root,'.odos/s1b-proof');
const {admin}=JSON.parse(readFileSync(join(runtime,'credentials.json'),'utf8'));
const phase=process.argv[2];
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1100}});
try {
 await page.goto('http://127.0.0.1:30090/settings/chart-fields-sections');
 await page.getByPlaceholder('Email address').fill(admin.email);
 await page.getByPlaceholder('Password',{exact:true}).fill(admin.password);
 await page.getByRole('button',{name:'Enter',exact:true}).click();
 await page.getByPlaceholder('Password',{exact:true}).waitFor({state:'detached'});
 await page.goto('http://127.0.0.1:30090/settings/chart-fields-sections');
 await page.getByRole('button',{name:'+ Create group…',exact:true}).waitFor();
 const section=page.locator('section').filter({has:page.getByRole('heading',{name:phase==='before'?'Visit-type section groups':'Finding section groups',exact:true})});
 await section.getByRole('button',{name:'Edit',exact:true}).first().click();
 if(phase==='before') await page.getByText('Default visit-type categories',{exact:true}).waitFor();
 else assert.equal(await page.getByText('Default visit-type categories',{exact:true}).count(),0);
 await page.screenshot({path:join(out,`01-settings-${phase}.png`)});
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 if(phase==='after'){
  await page.getByRole('button',{name:'+ Create group…',exact:true}).click();
  await page.getByLabel('Group key',{exact:true}).fill('synthetic-s1b');
  await page.getByLabel('Label',{exact:true}).fill('Synthetic S1b Workup');
  await page.getByLabel('Section-key prefixes').fill('synthetic:s1b:');
  const [created]=await Promise.all([page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/finding-section-groups')),page.getByRole('button',{name:'Save group',exact:true}).click()]);
  assert.equal(created.status(),201);
  await page.getByRole('dialog').waitFor({state:'detached'});
  const row=section.locator('div.flex.flex-wrap').filter({hasText:'Synthetic S1b Workup'});
  await row.getByRole('button',{name:'Edit',exact:true}).click();
  await page.getByLabel('Label',{exact:true}).fill('Synthetic S1b Edited');
  const [edited]=await Promise.all([page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/finding-section-groups/synthetic-s1b')),page.getByRole('button',{name:'Save group',exact:true}).click()]);
  assert.equal(edited.status(),200);
  await page.getByRole('dialog').waitFor({state:'detached'});
  await page.getByText('Synthetic S1b Edited',{exact:true}).waitFor();
  await page.screenshot({path:join(out,'02-settings-created-edited.png')});
 }
 console.log(JSON.stringify({phase,width:1440,pickerVisible:phase==='before',createEdit:phase==='after'}));
}finally{await browser.close();}
