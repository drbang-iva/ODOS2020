import { assertVisionWebConfigured, assertVisionWebTransmission, isHttpsUrl, type VisionWebConfig } from "./config.js";
import { parseVisionWebUploadResponse, VISIONWEB_UNREADABLE, type VisionWebUploadResult } from "./uploadResponse.js";
import { escapeVisionWebXml } from "./vwOrderSerializer.js";
export interface VisionWebUploadRequest { vwOrderXml: string; subordid: string; msgguid: string; sloid: string }
export interface VisionWebClient {
  getAccessToken(config: VisionWebConfig, scope: string): Promise<string>;
  uploadOrder(config: VisionWebConfig, request: VisionWebUploadRequest): Promise<VisionWebUploadResult>;
  getTrackingUpdates(config: VisionWebConfig, orderIds: string[]): Promise<unknown>;
}
export function sanitizeVendorText(text: string, secrets: readonly string[]): string {
  if (/<VWOrder|<Item>|<soap|CDATA/i.test(text)) return "VisionWeb returned an unreadable error.";
  let clean = text;
  const forms = secrets.filter(Boolean).flatMap(secret => [secret, escapeVisionWebXml(secret)]).sort((a,b)=>b.length-a.length);
  for (const secret of forms) clean = clean.split(secret).join("[redacted]");
  return clean.replace(/\s+/g, " ").trim().slice(0,300);
}
export function visionWebSecrets(config: VisionWebConfig): string[] {
  return [config.username,config.password,config.clientId,config.clientSecret,
    Buffer.from(`${config.clientId ?? ""}:${config.clientSecret ?? ""}`).toString("base64")].filter((s): s is string => !!s);
}
export function createVisionWebClient(options: {fetchImpl?: typeof fetch; now?: () => Date} = {}): VisionWebClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (()=>new Date());
  const cache = new WeakMap<VisionWebConfig, Map<string,{token:string;expires:number}>>();
  const tokens = new WeakMap<VisionWebConfig, Set<string>>();
  async function request(url: string | undefined, init: RequestInit, operation: string): Promise<Response> {
    if (!isHttpsUrl(url)) throw new Error(`VisionWeb ${operation} failed.`);
    let response: Response;
    try { response = await fetchImpl(url,{...init,redirect:"error",signal:AbortSignal.timeout(30 * 1000)}); }
    catch { throw new Error(`VisionWeb ${operation} failed.`); }
    if (!response.ok) throw new Error(`VisionWeb ${operation} failed with HTTP ${response.status}.`);
    return response;
  }
  async function json(response: Response): Promise<unknown> {
    try { return await response.json(); } catch { throw new Error(VISIONWEB_UNREADABLE); }
  }
  const client: VisionWebClient = {
    async getAccessToken(config,scope) {
      assertVisionWebConfigured(config);
      const key = scope;
      const cached = cache.get(config)?.get(key);
      if (cached && cached.expires > now().getTime()) return cached.token;
      const response = await request(config.tokenUrl,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded",Authorization:`Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`},body:new URLSearchParams({grant_type:"client_credentials",scope}).toString()},"token");
      const value = await json(response);
      if (!value || typeof value !== "object" || !("access_token" in value) || typeof value.access_token !== "string" || !value.access_token) throw new Error(VISIONWEB_UNREADABLE);
      const token = value.access_token;
      let known=tokens.get(config); if (!known) {known=new Set();tokens.set(config,known);} known.add(token);
      if ("expires_in" in value && typeof value.expires_in === "number" && Number.isFinite(value.expires_in) && value.expires_in > 60) {
        let entries=cache.get(config); if(!entries){entries=new Map();cache.set(config,entries);}
        entries.set(key,{token,expires:now().getTime()+(value.expires_in-60)*1000});
      }
      return token;
    },
    async uploadOrder(config,input) {
      assertVisionWebTransmission(config);
      if (input.vwOrderXml.includes("]]>")) throw new Error("VisionWeb upload failed.");
      const values: Array<[string,string]> = [["username",config.username],["pswd",config.password],["filestring",input.vwOrderXml],["subordid",input.subordid],["refid",config.refId],["msgguid",input.msgguid],["sloid",input.sloid]];
      const body = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><UploadFile xmlns="http://services.visionweb.com">${values.map(([k,v])=>`<${k}>${k==="filestring"?`<![CDATA[${v}]]>`:escapeVisionWebXml(v)}</${k}>`).join("")}</UploadFile></soap:Body></soap:Envelope>`;
      const response=await request(config.soapUrl,{method:"POST",headers:{"Content-Type":"text/xml; charset=utf-8",SOAPAction:"http://services.visionweb.com/UploadFile"},body},"upload");
      let raw:string; try{raw=await response.text();}catch{throw new Error(VISIONWEB_UNREADABLE);}
      const result=parseVisionWebUploadResponse(raw);
      const secrets=[...visionWebSecrets(config),...(tokens.get(config)??[])];
      return {...result,errorList:result.errorList ? sanitizeVendorText(result.errorList,secrets) : undefined};
    },
    async getTrackingUpdates(config,orderIds) {
      assertVisionWebConfigured(config);
      const token=await client.getAccessToken(config,"VW.OP.Order.WebApi");
      const response=await request(`${config.apiBaseUrl.replace(/\/$/,"")}/order/OrderTracking/GetTrackingUpdates`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`,username:config.username,password:config.password},body:JSON.stringify({RefId:config.refId,OrderIds:orderIds,IncludeHistory:false})},"tracking");
      return json(response);
    },
  };
  return client;
}
