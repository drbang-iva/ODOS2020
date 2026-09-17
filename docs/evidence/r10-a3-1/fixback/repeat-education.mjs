import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
const env=Object.fromEntries(['PATH','HOME','TMPDIR','SHELL','LANG','LC_ALL','USER','LOGNAME'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
const config=JSON.parse(readFileSync('.odos/r10-a3-1/fixback/ci-credentials.json'));
Object.assign(env,{ODOS_POSTGRES_URL:config.postgres,ODOS_REAL_WEASYPRINT_TEST:'1'});
const rows=[];
for(let i=1;i<=100;i++){
 const r=spawnSync(process.execPath,['--import','./mcp/node_modules/tsx/dist/loader.mjs','--test','mcp/tests/educationEnrollmentApi.test.ts'],{env,encoding:'utf8'});
 rows.push({iteration:i,status:r.status});
 if(r.status){writeFileSync(process.argv[2],r.stdout+r.stderr);writeFileSync(process.argv[2]+'.json',JSON.stringify(rows,null,2)+'\n');console.log(JSON.stringify(rows));process.exit(1);}
}
writeFileSync(process.argv[2]+'.json',JSON.stringify(rows,null,2)+'\n');console.log(JSON.stringify({runs:rows.length,failures:0}));
