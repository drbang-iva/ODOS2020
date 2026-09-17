import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
const root=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const runtime=join(root,'.odos/r10-a3-2-served');
const identity=JSON.parse(readFileSync(join(runtime,'identity.json'),'utf8'));
assert.equal(identity.project,'odos-r10-a3-2-served');
assert.equal(identity.dirty,false,'SSE proof requires the final clean build');
const base=`http://127.0.0.1:${identity.ports.frontdoor}`;
const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),10000);
const result={build:identity,frontdoor:base,events:[],passed:false};
let reader;
try {
 const response=await fetch(base+'/mcp/sse',{headers:{Accept:'text/event-stream'},signal:controller.signal});
 assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/event-stream/);
 reader=response.body.getReader();const decoder=new TextDecoder();let buffer='';let initialized=false;
 while(!initialized){
  const {done,value}=await reader.read();assert.equal(done,false,'SSE ended before initialization');buffer+=decoder.decode(value,{stream:true});
  for(let boundary;(boundary=buffer.indexOf('\n\n'))>=0;){
   const frame=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);
   const event=frame.split('\n').find(line=>line.startsWith('event:'))?.slice(6).trim();
   const data=frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim()).join('\n');
   if(event==='endpoint'){
    const endpoint=new URL(data,base);assert.equal(endpoint.origin,base);assert.equal(endpoint.pathname,'/mcp/messages');
    const posted=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'r10-served-proof',version:'1'}}}),signal:controller.signal});
    assert.equal(posted.status,202);result.events.push({event,postStatus:posted.status});
   }else if(event==='message'){
    const message=JSON.parse(data);assert.equal(message.id,1);assert.ok(message.result?.serverInfo);assert.ok(message.result?.protocolVersion);
    result.events.push({event,id:message.id,protocolVersion:message.result.protocolVersion,serverInfo:message.result.serverInfo});initialized=true;
   }
  }
 }
 result.passed=true;
}finally{
 clearTimeout(timeout);if(reader)await reader.cancel();controller.abort();
 const evidence=join(process.env.R10_EVIDENCE??join(root,'.odos/r10-a3-2-fixback'),'sse');mkdirSync(evidence,{recursive:true});writeFileSync(join(evidence,'result.json'),JSON.stringify(result,null,2)+'\n');
}
console.log(JSON.stringify({passed:result.passed,head:identity.head,dirty:identity.dirty,events:result.events}));
