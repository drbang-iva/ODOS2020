import {chromium} from '../../../../ui/node_modules/playwright-core/index.mjs';
import {writeFileSync} from 'node:fs';
const directory=new URL('.',import.meta.url).pathname;
const browser=await chromium.launch({channel:'chrome'});
const evidence=[];
try {for(const [revision,port] of [['before',15371],['after',15372]]) for(const state of ['ou','conflict','prebuild','unavailable','partial','audit']){
 const page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(`http://127.0.0.1:${port}/visual.html?state=${state}`,{waitUntil:'networkidle'});
 await page.locator('#proof').waitFor();
 if(state==='partial'){
  const suggestion=page.getByRole('button',{name:'Add suggested diagnosis Synthetic diagnosis'});
  if(await suggestion.count()) { await suggestion.click(); await page.locator('.odos-diagnosis-visit-row').waitFor({timeout:8000}); }
  if(revision==='after')await page.getByRole('button',{name:'Finish linking'}).waitFor({timeout:8000});
 }
 await page.evaluate(()=>document.fonts.ready);
 const body=await page.locator('body').innerText();
 if(errors.length)throw new Error(`${revision}/${state}: ${errors.join('; ')}`);
 if(revision==='after'){
  const expected={ou:'OU',conflict:'Conflicting records',prebuild:'Test data from before the rebuild',unavailable:'Findings unavailable',partial:'Finish linking',audit:'Audit record pending.'}[state];
  if(!body.includes(expected))throw new Error(`${state} missing ${expected}: ${body}`);
  if(state==='ou' && (await page.locator('tbody tr').count()!==1 || await page.locator('select[aria-label^=Laterality]').inputValue()!=='OU'))throw new Error('OU grouping not rendered');
  if(state==='conflict' && await page.locator('tbody tr').first().locator('button:enabled,select:enabled').count())throw new Error('Conflict has enabled controls');
  if(state==='prebuild' && await page.locator('#proof button:enabled,#proof select:enabled,#proof input:enabled').count())throw new Error('Pre-rebuild has enabled controls');
  if(state==='audit' && !await page.getByRole('button',{name:'Repair',exact:true}).isVisible())throw new Error('Audit repair is not visible');
 }
 await page.screenshot({path:`${directory}/${state}-${revision}.png`,animations:'disabled'});
 evidence.push({revision,state,body});await page.close();
 console.log(`${revision}/${state}`);
}} finally {await browser.close();}
writeFileSync(`${directory}/capture-observations.json`,JSON.stringify(evidence,null,2));
