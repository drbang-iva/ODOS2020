import {realpathSync,mkdtempSync,readFileSync,writeFileSync,mkdirSync,symlinkSync,cpSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
const root=process.cwd();const temp=realpathSync(mkdtempSync(join(tmpdir(),'r10-a2b2-visual-')));
for(const revision of ['before','after']){
 const directory=join(temp,revision);mkdirSync(directory);
 const archive=execFileSync('git',['archive','b5376689','ui','src'],{maxBuffer:100*1024*1024});
 execFileSync('tar',['-x','-C',directory],{input:archive});
 if(revision==='after') for(const sub of ['ui/src','src'])cpSync(join(root,sub),join(directory,sub),{recursive:true});
 symlinkSync(join(root,'ui/node_modules'),join(directory,'ui/node_modules'));
 cpSync(join(root,'docs/evidence/r10-a2b2/round2/fixture.tsx'),join(directory,'ui/visual.tsx'));
 writeFileSync(join(directory,'ui/visual.html'),'<!doctype html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body><div id="root"></div><script type="module" src="/visual.tsx"></script></body></html>');
 writeFileSync(join(directory,'ui/visual.config.mjs'),`import react from ${JSON.stringify(join(root,'ui/node_modules/@vitejs/plugin-react/dist/index.js'))};export default {cacheDir:'.visual-vite-cache',resolve:{dedupe:['react','react-dom']},plugins:[react()],server:{host:'127.0.0.1',strictPort:true,fs:{allow:[${JSON.stringify(temp)},${JSON.stringify(root)}]}}};`);
}
writeFileSync('/tmp/r10-a2b2-round2-path',temp);console.log(temp);
