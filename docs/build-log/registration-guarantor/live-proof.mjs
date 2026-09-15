import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root=process.cwd();
const {refreshFixtureTokens,createLiveClients,writeEvidence,successfulHttp,grantPatients}=await import(pathToFileURL(resolve(root,'.odos/registration-majority-live/fixture.mjs')).href);
const fixture=await refreshFixtureTokens();
const {audit,serviceFhir}=await createLiveClients(fixture);
const {authenticateStaffRoute}=await import('../../../mcp/src/payments/payment-endpoint.ts');
const {registerClinicRoutes}=await import('../../../mcp/src/clinic/clinic-routes.ts');
const {registerGuarantorRoutes}=await import('../../../mcp/src/clinic/guarantor-routes.ts');
const {registerCommsApiRoutes}=await import('../../../mcp/src/comms/comms-api.ts');
const {createCommsDispatch}=await import('../../../mcp/src/comms/comms-config.ts');
const {loadDefaultEducationCatalogReader}=await import('../../../mcp/src/comms/education-catalog.ts');
const {generatePatientStatementForOperator}=await import('../../../mcp/src/statements/statements.ts');
const {seedAgeOfMajority}=await import('../../../scripts/seed-age-of-majority.ts');
const {buildAgeOfMajorityConfigResource,ODOS_AGE_OF_MAJORITY_CONFIG_SYSTEM,ODOS_AGE_OF_MAJORITY_CONFIG_CODE}=await import('../../../mcp/src/clinic/age-of-majority-config.ts');
const mcp=createRequire(resolve(root,'mcp/package.json')),ui=createRequire(resolve(root,'ui/package.json'));
const express=mcp('express'),{chromium}=ui('playwright-core');
const {createServer}=await import(ui.resolve('vite'));
const {default:react}=await import(ui.resolve('@vitejs/plugin-react'));
const originalFetch=globalThis.fetch,events=[],checks=[];
const now='2026-09-15T12:00:00.000Z';
globalThis.fetch=async(input,init={})=>{
  const url=new URL(typeof input==='string'?input:input.url??String(input));
  assert.ok(['127.0.0.1','localhost'].includes(url.hostname),'Loopback requests only');
  const response=await originalFetch(input,init);
  if(url.pathname.startsWith('/fhir/')) events.push({method:init.method??'GET',path:url.pathname+url.search,status:response.status,ifMatch:new Headers(init.headers).get('If-Match')??undefined,request:init.body?JSON.parse(String(init.body)):undefined,response:await response.clone().json().catch(()=>undefined)});
  return response;
};
const authenticate=authHeader=>authenticateStaffRoute({baseUrl:fixture.baseUrl,authHeader,serviceClient:serviceFhir,audit});
const recordAudit=async row=>{await audit.record(row,()=>undefined);};
const port=29164,servers=[];
async function serve(){
  const app=express();app.use(express.json());
  app.get('/desk/whoami',async(req,res)=>{const staff=await authenticate(req.header('authorization'));res.json({roles:staff?.roles??[],businessActions:staff?.businessActions??[]});});
  registerClinicRoutes(app,{authenticateService:async()=>{},authenticate,authenticateRegistration:authenticate,serviceFhir,now:()=>now});
  registerGuarantorRoutes(app,{authenticateService:async()=>{},authenticate,serviceFhir,recordAudit,now:()=>now});
  registerCommsApiRoutes(app,{authenticateService:async()=>{},authenticate,fhir:serviceFhir,dispatch:createCommsDispatch([]),educationCatalog:loadDefaultEducationCatalogReader(),trackedLinkStore:{},publicBaseUrl:`http://127.0.0.1:${port}`,practiceName:'Synthetic Practice',audit,now:()=>now});
  app.use('/clinical-graph',(_req,res)=>res.status(404).json({error:'Ancillary clinical route outside fixture'}));
  const directory=resolve(root,'ui'),{default:tailwindConfig}=await import(pathToFileURL(resolve(directory,'tailwind.config.js')).href);
  const server=await createServer({configFile:false,root:directory,css:{postcss:{plugins:[ui('tailwindcss')({...tailwindConfig,content:[resolve(directory,'index.html'),resolve(directory,'src/**/*.{ts,tsx}')]}),ui('autoprefixer')()]}},plugins:[react(),{name:'majority-proof',configureServer(vite){vite.middlewares.use(app);}}],server:{host:'127.0.0.1',port,strictPort:true,fs:{allow:[root]},proxy:{'/fhir':{target:fixture.baseUrl,changeOrigin:true},'/auth':{target:fixture.baseUrl,changeOrigin:true}}}});
  await server.listen();servers.push(server);
}
let browser,page;
try{
  for(const name of ['odos-no-textable-number','odos-textable-number']){
    const resource=JSON.parse(readFileSync(resolve(root,`data/canonical-extensions/${name}.json`),'utf8'));
    delete resource.id;await successfulHttp(fixture,'POST','/fhir/R4/StructureDefinition',{body:{...resource,meta:{project:fixture.projectA}}});
  }
  const seed=await seedAgeOfMajority(serviceFhir,{projectId:fixture.projectA,apply:true});checks.push({seed});
  const query={code:`${ODOS_AGE_OF_MAJORITY_CONFIG_SYSTEM}|${ODOS_AGE_OF_MAJORITY_CONFIG_CODE}`};
  let setting=(await serviceFhir.searchProject('Basic',fixture.projectA,query)).entry[0].resource;
  if (JSON.parse(setting.extension[0].valueString).ageOfMajorityYears !== 18) setting=await successfulHttp(fixture,'PUT',`/fhir/R4/Basic/${setting.id}`,{body:buildAgeOfMajorityConfigResource({ageOfMajorityYears:18},setting)});
  await serve();
  const party={localId:'parent',kind:'person',relationship:'parent',firstName:'Synthetic',middleName:'',lastName:'Majority Guardian',birthDate:'1980-01-01',phones:[{value:'864-555-0101',use:'home'},{value:'864-555-0102',use:'mobile'}],textable:'phone2',address:'1 Synthetic Way',city:'Synthetic Town',state:'SC',postalCode:'29601',financialResponsible:true,consentAuthority:true,primary:true,courtOrderNotes:'',effectiveDate:'2026-01-01',endDate:''};
  const body={demographics:{firstName:'Synthetic',middleName:'',lastName:'Majority Child',preferredName:'',birthDate:'2015-01-01',gender:'unknown',phones:[{value:'864-555-0103',use:'mobile'},{value:'',use:'mobile'}],textable:'phone1',email:'',address:'',city:'',state:'',postalCode:''},responsibleParties:[party],confirmDuplicate:true};
  async function register(body,expected=201){const response=await fetch(`http://127.0.0.1:${port}/clinic/patients`,{method:'POST',headers:{Authorization:`Bearer ${fixture.principals.staff.token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});const result=await response.json();events.push({method:'POST',path:'/clinic/patients',request:body,status:response.status,response:result});assert.equal(response.status,expected,JSON.stringify(result));return result;}
  const first=await register(body);
  const child=(await serviceFhir.searchProject('RelatedPerson',fixture.projectA,{patient:`Patient/${first.patient.id}`})).entry[0].resource;
  const parent=(await serviceFhir.searchProject('Person',fixture.projectA,{link:`RelatedPerson/${child.id}`})).entry[0].resource;
  assert.equal(parent.birthDate,party.birthDate);assert.equal(child.birthDate,undefined);
  const second=await register({...body,demographics:{...body.demographics,lastName:'Majority Nineteen',birthDate:'2007-01-01'}});
  const guardian=(await serviceFhir.searchProject('RelatedPerson',fixture.projectA,{patient:`Patient/${second.patient.id}`})).entry[0].resource;
  await grantPatients(fixture,'staff',[first.patient.id,second.patient.id]);
  await grantPatients(fixture,'composite',[first.patient.id,second.patient.id]);
  const encounter=await successfulHttp(fixture,'POST','/fhir/R4/Encounter',{body:{resourceType:'Encounter',meta:{project:fixture.projectA},status:'in-progress',class:{system:'http://terminology.hl7.org/CodeSystem/v3-ActCode',code:'AMB'},subject:{reference:`Patient/${second.patient.id}`},period:{start:now}}});
  const invoice=await successfulHttp(fixture,'POST','/fhir/R4/Invoice',{body:{resourceType:'Invoice',meta:{project:fixture.projectA},status:'issued',subject:{reference:`Patient/${second.patient.id}`},date:now,totalGross:{value:10,currency:'USD'},totalNet:{value:10,currency:'USD'},lineItem:[{sequence:1,chargeItemCodeableConcept:{text:'Synthetic service'},priceComponent:[{type:'base',amount:{value:10,currency:'USD'}}]}]}});
  const latest=await refreshFixtureTokens();browser=await chromium.launch({channel:'chrome'});const context=await browser.newContext({viewport:{width:1440,height:1100}});
  await context.addInitScript(({token})=>sessionStorage.setItem('odos.session.v1',JSON.stringify({accessToken:token,expiresAt:Date.now()+3600000})),{token:latest.principals.composite.token});
  page=await context.newPage();page.on('response',async response=>{const url=new URL(response.url());if(url.pathname.startsWith('/fhir/')){const req=response.request();events.push({browser:true,method:req.method(),path:url.pathname+url.search,status:response.status(),ifMatch:req.headers()['if-match'],request:req.postDataJSON(),response:await response.json().catch(()=>undefined)});}});
  await page.goto(`http://127.0.0.1:${port}/settings/age-of-majority`);
  await page.getByLabel('Age of majority (years)').waitFor();await page.screenshot({path:resolve(root,'docs/build-log/registration-guarantor/settings-18.png')});
  await page.getByLabel('Age of majority (years)').fill('21');await page.getByRole('button',{name:'Save age of majority',exact:true}).click();await page.getByText('Age of majority saved.',{exact:true}).waitFor();
  await page.screenshot({path:resolve(root,'docs/build-log/registration-guarantor/settings-21.png')});
  setting=await serviceFhir.readExtended('Basic',setting.id);assert.equal(JSON.parse(setting.extension[0].valueString).ageOfMajorityYears,21);checks.push({settingsUiSaved21:true});
  await page.goto(`http://127.0.0.1:${port}/clinic?patientId=${second.patient.id}&encounterId=${encounter.id}`);
  await page.getByRole('button',{name:'By diagnosis',exact:true}).click();
  await page.getByRole('tab',{name:'Engage',exact:true}).click();
  await page.getByText('Synthetic Majority Guardian',{exact:false}).first().waitFor();
  await page.screenshot({path:resolve(root,'docs/build-log/registration-guarantor/engage-21.png')});checks.push({engageGuardianAt21:true});
  const {createOperatorScriptFhirClient}=await import('../../../mcp/src/fhir-client.ts');
  const statementFhir=createOperatorScriptFhirClient({baseUrl:fixture.baseUrl,accessToken:latest.principals.composite.token,reason:'Synthetic majority statement proof'});
  const statement=await generatePatientStatementForOperator(statementFhir,{patientReference:`Patient/${second.patient.id}`,generatedAt:now});assert.equal(statement.generatedCount,1,JSON.stringify(statement.rejects));
  assert.equal(statement.statements[0].detail.header.recipientName,'Synthetic Majority Guardian');checks.push({statementGuardianAt21:true,statement});
  await successfulHttp(fixture,'DELETE',`/fhir/R4/Basic/${setting.id}`);
  const missing=await register(body,422);assert.match(missing.error,/ageOfMajorityYears/);checks.push({missingSetting422:true});
  await page.reload();await page.getByRole('button',{name:'By diagnosis',exact:true}).click();await page.getByRole('tab',{name:'Engage',exact:true}).click();await page.getByText('Age of majority is not configured',{exact:true}).waitFor();await page.screenshot({path:resolve(root,'docs/build-log/registration-guarantor/engage-missing.png')});
  writeEvidence('live-final-resources.json',{first:await serviceFhir.readExtended('Patient',first.patient.id),second:await serviceFhir.readExtended('Patient',second.patient.id),parent:await serviceFhir.readExtended('Person',parent.id),child:await serviceFhir.readExtended('RelatedPerson',child.id),guardian,encounter,invoice,settingDeleted:setting.id});
  writeEvidence('live-result.json',{checks});console.log(JSON.stringify(checks.map(c=>Object.keys(c))));
}catch(error){if(page){await page.screenshot({path:resolve(root,'docs/build-log/registration-guarantor/live-failure.png')});writeEvidence('live-page.json',{url:page.url(),text:await page.locator('body').innerText()});}writeEvidence('live-failure.json',{error:String(error),stack:error.stack,checks});throw error;}
finally{writeEvidence('live-http.json',{events});await browser?.close();for(const server of servers)await server.close();await audit.close();}
