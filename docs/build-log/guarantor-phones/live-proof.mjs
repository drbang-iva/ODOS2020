import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root=process.cwd();
const bootstrap=await import(pathToFileURL(process.env.GUARANTOR_PROOF_BOOTSTRAP).href);
const {refreshFixtureTokens,createLiveClients,writeEvidence,successfulHttp,grantPatients}=bootstrap;
const fixture=await refreshFixtureTokens();
const {audit,serviceFhir}=await createLiveClients(fixture);
const {authenticateStaffRoute}=await import('../../../mcp/src/payments/payment-endpoint.ts');
const {registerClinicRoutes}=await import('../../../mcp/src/clinic/clinic-routes.ts');
const {registerGuarantorRoutes}=await import('../../../mcp/src/clinic/guarantor-routes.ts');
const {handleGuarantorOperation}=await import('../../../mcp/src/clinic/guarantor-link-operation.ts');
const {resolveSmsNumber}=await import('../../../mcp/src/comms/suppression-gate.ts');
const mcp=createRequire(resolve(root,'mcp/package.json')),ui=createRequire(resolve(root,'ui/package.json'));
const express=mcp('express'),{chromium}=ui('playwright-core');
const {createServer}=await import(ui.resolve('vite'));
const {default:react}=await import(ui.resolve('@vitejs/plugin-react'));
const originalFetch=globalThis.fetch,events=[];
const now='2026-09-15T12:00:00.000Z';
globalThis.fetch=async(input,init={})=>{
  const response=await originalFetch(input,init);
  const url=new URL(typeof input==='string'?input:input.url??String(input));
  if(url.hostname==='127.0.0.1'&&url.pathname.startsWith('/fhir/')){
    const json=await response.clone().json().catch(()=>undefined);
    events.push({method:init.method??'GET',path:url.pathname+url.search,status:response.status,ifMatch:new Headers(init.headers).get('If-Match')??undefined,request:init.body?JSON.parse(String(init.body)):undefined,response:json});
  }
  return response;
};
const authenticate=authHeader=>authenticateStaffRoute({baseUrl:fixture.baseUrl,authHeader,serviceClient:serviceFhir,audit});
const recordAudit=async row=>{await audit.record(row,()=>undefined);};
const operationDeps={serviceFhir,serviceReference:fixture.serviceReference,recordAudit,now:()=>now};
const ports=[28974,28975], servers=[];
async function serve(directory,port){
  const app=express();app.use(express.json());
  app.get('/desk/whoami',async(req,res)=>{const staff=await authenticate(req.header('authorization'));res.json({roles:staff?.roles??[],businessActions:staff?.businessActions??[]});});
  registerClinicRoutes(app,{authenticateService:async()=>{},authenticate,authenticateRegistration:authenticate,serviceFhir,now:()=>now,attachRegistrationGuarantor:(staff,body)=>handleGuarantorOperation(operationDeps,staff,{action:'create',body})});
  registerGuarantorRoutes(app,{authenticateService:async()=>{},authenticate,serviceFhir,recordAudit,now:()=>now});
  app.use('/communications',(_req,res)=>res.status(503).json({error:'Ancillary preferences service outside fixture'}));
  app.use('/clinical-graph',(_req,res)=>res.status(404).json({error:'Ancillary clinical route outside fixture'}));
  const {default:tailwindConfig}=await import(pathToFileURL(resolve(directory,'tailwind.config.js')).href);
  const server=await createServer({configFile:false,root:directory,css:{postcss:{plugins:[ui('tailwindcss')({...tailwindConfig,content:[resolve(directory,'index.html'),resolve(directory,'src/**/*.{ts,tsx}')]}),ui('autoprefixer')()]}},plugins:[react(),{name:'guarantor-proof',configureServer(vite){vite.middlewares.use(app);}}],server:{host:'127.0.0.1',port,strictPort:true,fs:{allow:[root,process.env.GUARANTOR_BASE_ROOT]},proxy:{'/fhir':{target:fixture.baseUrl,changeOrigin:true},'/auth':{target:fixture.baseUrl,changeOrigin:true}}}});
  await server.listen();servers.push(server);return server;
}
let browser;
try{
  for(const name of ['odos-no-textable-number','odos-textable-number']){
    const resource=JSON.parse(readFileSync(resolve(root,`data/canonical-extensions/${name}.json`),'utf8'));
    delete resource.id; await successfulHttp(fixture,'POST','/fhir/R4/StructureDefinition',{body:{...resource,meta:{project:fixture.projectA}}});
  }
  await serve(resolve(root,'ui'),ports[0]);
  const staff=await authenticate(`Bearer ${fixture.principals.staff.token}`);assert.ok(staff.businessActions.includes('patients.register'));
  const party={localId:'parent',kind:'person',relationship:'parent',firstName:'Synthetic',middleName:'',lastName:'Phone Parent',phones:[{value:'864-555-0101',use:'home'},{value:'864-555-0102',use:'mobile'}],textable:'phone2',address:'1 Synthetic Way',city:'Synthetic Town',state:'SC',postalCode:'29601',financialResponsible:true,consentAuthority:true,primary:true,courtOrderNotes:'Synthetic custody sentinel',effectiveDate:'2026-01-01',endDate:''};
  const body={demographics:{firstName:'Synthetic',middleName:'',lastName:'Phone Child',preferredName:'',birthDate:'2015-01-01',gender:'unknown',phones:[{value:'',use:'mobile'},{value:'',use:'mobile'}],textable:'',email:'',address:'',city:'',state:'',postalCode:''},responsibleParties:[party],confirmDuplicate:true};
  async function register(body){const response=await fetch(`http://127.0.0.1:${ports[0]}/clinic/patients`,{method:'POST',headers:{Authorization:`Bearer ${fixture.principals.staff.token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});const result=await response.json();events.push({method:'POST',path:'/clinic/patients',request:body,status:response.status,response:result});assert.equal(response.status,201,JSON.stringify(result));return result;}
  const first=await register(body);
  const childBundle=await serviceFhir.searchProject('RelatedPerson',fixture.projectA,{patient:`Patient/${first.patient.id}`});
  const child=childBundle.entry[0].resource;
  const parent=(await serviceFhir.searchProject('Person',fixture.projectA,{link:`RelatedPerson/${child.id}`})).entry[0].resource;
  const {firstName,middleName,lastName,phones,textable,address,city,state,postalCode,...role}=party;
  const second=await register({...body,demographics:{...body.demographics,lastName:'Phone Sibling'},responsibleParties:[{...role,kind:'existing',personId:parent.id}]});
  assert.equal(second.guarantorLinks[0].status,'linked',JSON.stringify(second.guarantorLinks));
  const sibling=(await serviceFhir.searchProject('RelatedPerson',fixture.projectA,{patient:`Patient/${second.patient.id}`})).entry[0].resource;
  await grantPatients(fixture,'staff',[first.patient.id,second.patient.id]);
  const latest=await refreshFixtureTokens();
  browser=await chromium.launch({channel:'chrome'});
  const context=await browser.newContext({viewport:{width:1440,height:2400}});
  await context.addInitScript(({token})=>sessionStorage.setItem('odos.session.v1',JSON.stringify({accessToken:token,expiresAt:Date.now()+3600000})),{token:latest.principals.staff.token});
  const page=await context.newPage();
  page.on('response',async response=>{const url=new URL(response.url());if(url.pathname.startsWith('/fhir/')){const req=response.request();events.push({browser:true,method:req.method(),path:url.pathname+url.search,status:response.status(),ifMatch:req.headers()['if-match'],request:req.postDataJSON(),response:await response.json().catch(()=>undefined)});}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  async function open(port){await page.goto(`http://127.0.0.1:${port}/clinic?patientId=${first.patient.id}`);await page.getByRole('button',{name:'Edit demographics',exact:true}).click();await page.getByRole('button',{name:'Save guarantor',exact:true}).waitFor();await page.evaluate(()=>document.fonts.ready);}
  await serve(resolve(process.env.GUARANTOR_BASE_ROOT,'ui'),ports[1]);
  await open(ports[1]);
  await page.getByRole('group',{name:'Responsible parties',exact:true}).screenshot({path:resolve(root,'docs/build-log/guarantor-phones/before.png')});
  await open(ports[0]);
  const group=page.getByRole('group',{name:'Responsible parties',exact:true});
  async function states(){const resources=await Promise.all([['Person',parent.id],['RelatedPerson',child.id],['RelatedPerson',sibling.id]].map(([type,id])=>serviceFhir.readExtended(type,id)));return {resources,refusals:resources.map(r=>r.extension?.some(e=>e.url.endsWith('/odos-no-textable-number')&&e.valueBoolean===true)??false),sms:resources.slice(1).map(r=>resolveSmsNumber(r,new Date(now))??null)};}
  const initial=await states();assert.deepEqual(initial.sms,['864-555-0102','864-555-0102']);
  await group.getByRole('radio',{name:'Neither — none of my numbers can receive texts',exact:true}).check();
  await group.getByRole('button',{name:'Save guarantor',exact:true}).click();
  await group.getByRole('button',{name:'Save guarantor',exact:true}).waitFor();
  await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Save guarantor'&&b.disabled));
  const neither=await states();assert.deepEqual(neither.refusals,[true,true,true]);assert.deepEqual(neither.sms,[null,null]);
  await group.screenshot({path:resolve(root,'docs/build-log/guarantor-phones/after-neither.png')});
  // Reload orders the marked Cell entry first. Choose the number by its displayed value.
  await group.getByRole('radio',{name:/864-555-0102/}).check();
  await group.getByRole('button',{name:'Save guarantor',exact:true}).click();
  await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Save guarantor'&&b.disabled));
  const restored=await states();assert.deepEqual(restored.refusals,[false,false,false]);assert.deepEqual(restored.sms,['864-555-0102','864-555-0102']);
  await group.screenshot({path:resolve(root,'docs/build-log/guarantor-phones/after-textable.png')});
  writeEvidence('live-result.json',{route:`/clinic?patientId=${first.patient.id}`,initial,neither,restored,pageErrors:errors,registrationStatus:[201,201],siblingAttach:second.guarantorLinks,limits:'Real route modules and Medplum policies; ancillary communications preferences and clinical-graph services are not provisioned. SMS selection executes the shipped resolver; no SMS is sent.'});
  console.log(JSON.stringify({registered:2,siblingAttach:'linked',initial:initial.sms,neither:neither.sms,restored:restored.sms,pageErrors:errors}));
}finally{writeEvidence('live-requests.json',events);if(browser)await browser.close();for(const server of servers)await server.close();globalThis.fetch=originalFetch;await audit.close();}
