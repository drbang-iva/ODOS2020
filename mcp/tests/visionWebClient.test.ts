import assert from "node:assert/strict";
import { test } from "node:test";
import { createVisionWebClient, sanitizeVendorText } from "../src/integrations/visionweb/visionWebClient.js";
import { visionWebConfigFromEnv } from "../src/integrations/visionweb/config.js";
import { env } from "./fixtures/visionweb/support.js";

const result = '<SingleOrder><OrderId>TEST</OrderId><SupplierId>9992</SupplierId><Status>Sent</Status></SingleOrder>';
test("V13 token request, scope and config isolation, expiration and absent expiry", async () => {
  let now = 0; const calls: Array<{url:string; init:RequestInit}> = [];
  const client = createVisionWebClient({now:()=>new Date(now), fetchImpl: async (url,init) => { calls.push({url:String(url),init:init!}); return Response.json({access_token:"TOKEN-SENTINEL-8e6", expires_in:120}); }});
  const config = visionWebConfigFromEnv(env);
  assert.equal(await client.getAccessToken(config,"scope A"),"TOKEN-SENTINEL-8e6");
  await client.getAccessToken(config,"scope A"); assert.equal(calls.length,1);
  await client.getAccessToken(config,"scope B"); assert.equal(calls.length,2);
  await client.getAccessToken({...config},"scope A"); assert.equal(calls.length,3);
  now = 61000; await client.getAccessToken(config,"scope A"); assert.equal(calls.length,4);
  assert.equal(calls[0].url,env.VISIONWEB_TOKEN_URL);
  assert.equal(calls[0].init.method,"POST");
  assert.equal(new Headers(calls[0].init.headers).get("Authorization"),`Basic ${Buffer.from(`${env.VISIONWEB_CLIENT_ID}:${env.VISIONWEB_CLIENT_SECRET}`).toString("base64")}`);
  assert.equal(String(calls[0].init.body),"grant_type=client_credentials&scope=scope+A");
  let count = 0;
  const uncached = createVisionWebClient({fetchImpl:async()=>{count++;return Response.json({access_token:"fake"});}});
  await uncached.getAccessToken(config,"s"); await uncached.getAccessToken(config,"s"); assert.equal(count,2);
});
test("V14 SOAP fields and V16 no retries, redirect and HTTPS at each client boundary", async () => {
  const config = visionWebConfigFromEnv(env); const calls: RequestInit[] = [];
  const client = createVisionWebClient({fetchImpl:async(url, init)=>{ calls.push(init!); assert.equal(String(url),config.soapUrl); return new Response(result); }});
  await client.uploadOrder(config,{vwOrderXml:"<VWOrder/>",subordid:"TEST",msgguid:"message-one",sloid:"9992"});
  const init = calls[0]; assert.equal(init.method,"POST"); assert.equal(init.redirect,"error"); assert.ok(init.signal instanceof AbortSignal);
  assert.equal(new Headers(init.headers).get("SOAPAction"),"http://services.visionweb.com/UploadFile");
  assert.equal(new Headers(init.headers).get("Content-Type"),"text/xml; charset=utf-8");
  const body = String(init.body); assert.match(body,/xmlns="http:\/\/services.visionweb.com"/);
  let previous = -1;
  for (const tag of ["username","pswd","filestring","subordid","refid","msgguid","sloid"]) {const at=body.indexOf(`<${tag}>`);assert.ok(at>previous);previous=at;}
  assert.match(body, /<!\[CDATA\[<VWOrder\/>\]\]>/);
  assert.doesNotMatch(body,/<(?:guid|cbsid|ordtype|filename)>/);
  let attempts=0; const failing = createVisionWebClient({fetchImpl:async()=>{attempts++;throw new Error("PW-SENTINEL-9f3");}});
  await assert.rejects(failing.uploadOrder(config,{vwOrderXml:"",subordid:"",msgguid:"",sloid:""}), {message:"VisionWeb upload failed."}); assert.equal(attempts,1);
  for (const method of ["getAccessToken","uploadOrder","getTrackingUpdates"] as const) {
    const bad={...config,soapUrl:"http://bad",tokenUrl:"http://bad",apiBaseUrl:"http://bad"};
    await assert.rejects(method === "getAccessToken" ? failing[method](bad,"s") : method === "uploadOrder" ? failing[method](bad,{vwOrderXml:"",subordid:"",msgguid:"",sloid:""}) : failing[method](bad,["TEST"]));
  }
  assert.equal(attempts,1);
});
test("V10 errors redact raw, escaped and encoded credentials and discard XML fragments", async () => {
  for (const secret of ["USER-SENTINEL-2b7","PW-SENTINEL-9f3","CLIENT-SENTINEL-5d0","SECRET-SENTINEL-4c1","TOKEN-SENTINEL-8e6","a&b"]) {
    assert.equal(sanitizeVendorText(` echo ${secret} `,[secret]),"echo [redacted]");
  }
  assert.equal(sanitizeVendorText("a&amp;b",["a&b"]),"[redacted]");
  for(const fragment of ["<VWOrder>","<Item>","<soap:Envelope>","CDATA"]) assert.equal(sanitizeVendorText(fragment,[]),"VisionWeb returned an unreadable error.");
  assert.equal(sanitizeVendorText("x".repeat(350),[]).length,300);
  const config=visionWebConfigFromEnv(env);
  for(const response of [new Response("SECRET-SENTINEL-4c1",{status:500}),new Response("SECRET-SENTINEL-4c1")]) {
    const client=createVisionWebClient({fetchImpl:async()=>response});
    await assert.rejects(client.getAccessToken(config,"s"),e=>e instanceof Error && !e.message.includes("SENTINEL"));
  }
});

test("V16 every network operation uses an exact thirty-second abort signal; tracking contract is exact",async()=>{
  const originalTimeout=AbortSignal.timeout;const delays:number[]=[];const calls:Array<{url:string;init:RequestInit}>=[];
  AbortSignal.timeout=(delay:number)=>{delays.push(delay);return originalTimeout(delay);};
  try{
    const config=visionWebConfigFromEnv(env);
    const client=createVisionWebClient({fetchImpl:async(url,init)=>{calls.push({url:String(url),init:init!});return String(url)===config.tokenUrl?Response.json({access_token:"TOKEN-SENTINEL-8e6",expires_in:120}):String(url)===config.soapUrl?new Response(result):Response.json({Status:60});}});
    await client.uploadOrder(config,{vwOrderXml:"<VWOrder/>",subordid:"TEST",msgguid:"msg",sloid:"9992"});
    assert.deepEqual(await client.getTrackingUpdates(config,["SP-TEST"]),{Status:60});
    assert.deepEqual(delays,[30000,30000,30000]);
    for(const {init} of calls){assert.equal(init.redirect,"error");assert.ok(init.signal instanceof AbortSignal);}
    const tracking=calls[2];assert.equal(tracking.url,"https://api.example/order/OrderTracking/GetTrackingUpdates");assert.equal(tracking.init.method,"POST");
    const headers=new Headers(tracking.init.headers);assert.equal(headers.get("username"),env.VISIONWEB_USERNAME);assert.equal(headers.get("password"),env.VISIONWEB_PASSWORD);assert.equal(headers.get("Authorization"),"Bearer TOKEN-SENTINEL-8e6");
    assert.deepEqual(JSON.parse(String(tracking.init.body)),{RefId:"RODEMO",OrderIds:["SP-TEST"],IncludeHistory:false});
    assert.match(String(calls[1].init.body),/scope=VW.OP.Order.WebApi/);
  }finally{AbortSignal.timeout=originalTimeout;}
});
