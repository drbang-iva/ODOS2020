import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
const dir='docs/evidence/r10-a3-1/fixback/';
const result={};
for(const name of readdirSync(dir).filter(x=>x.startsWith('ruling-')&&x.endsWith('.txt'))){
 const text=readFileSync(dir+name,'utf8');
 result[name]={counts:[...text.matchAll(/^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)/gm)].map(x=>`${x[1]} ${x[2]}`),failures:[...text.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map(x=>x[1])};
}
writeFileSync(dir+'ruling-test-counts.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
