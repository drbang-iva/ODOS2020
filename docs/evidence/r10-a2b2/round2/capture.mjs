import {chromium} from '../../../../ui/node_modules/playwright-core/index.mjs';
import {writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const directory=new URL('.',import.meta.url).pathname;
const browser=await chromium.launch({channel:'chrome'});
const evidence=[];
try {
 for(const [revision,port] of [['before',15471],['after',15472]]) {
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/visual.html`,{waitUntil:'networkidle'});
  const buttons=page.getByRole('button',{name:'Add suggested diagnosis Synthetic diagnosis'});
  await buttons.first().waitFor();
  const count=await buttons.count();assert.equal(count,revision==='before'?2:1);
  await buttons.first().click();
  const scope=page.getByRole('group',{name:'Scope for Synthetic diagnosis',exact:true});
  await scope.waitFor();
  const disabled={};for(const eye of ['OD','OS','OU'])disabled[eye]=await scope.getByRole('button',{name:eye,exact:true}).isDisabled();
  assert.deepEqual(disabled,revision==='before'?{OD:false,OS:false,OU:false}:{OD:true,OS:true,OU:false});
  assert.deepEqual(errors,[]);
  await page.screenshot({path:`${directory}/suggestion-${revision}.png`});
  evidence.push({revision,suggestionButtons:count,scopeDisabled:disabled});await page.close();
 }
} finally {await browser.close();}
writeFileSync(`${directory}/visual.json`,JSON.stringify(evidence,null,2)+'\n');console.log(evidence);
