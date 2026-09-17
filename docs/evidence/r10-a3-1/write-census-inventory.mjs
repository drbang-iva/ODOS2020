import ts from '../../mcp/node_modules/typescript/lib/typescript.js';
import {writeFileSync} from 'node:fs';
import {resolve,relative} from 'node:path';
const root=process.cwd();
const config=ts.readConfigFile(resolve(root,'mcp/tsconfig.json'),ts.sys.readFile);
const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,resolve(root,'mcp'));
const program=ts.createProgram(parsed.fileNames,parsed.options), checker=program.getTypeChecker();
const rows=[];
for(const source of program.getSourceFiles()) {
 const file=relative(root,source.fileName);
 if(!file.startsWith('mcp/src/')||file.includes('__tests__'))continue;
 const counts=new Map();
 function walk(node){
  if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)) {
   const method=node.expression.name.text;
   if(['create','createWithOutcome','update','patch','executeTransaction','executeTransactionAsActor'].includes(method)) {
    const first=node.arguments[0];
    const generic=node.typeArguments?.some(t=>t.getText(source).includes('Observation'));
    const type=first&&checker.getTypeAtLocation(first);
    const property=type&&checker.getPropertyOfType(type,'resourceType');
    const resourceType=property?checker.typeToString(checker.getTypeOfSymbolAtLocation(property,first)):'';
    const obvious=generic||first?.getText(source)==='"Observation"'||first?.getText(source)==="'Observation'"||resourceType.includes('Observation');
    if(obvious||method.startsWith('executeTransaction')) {
     let owner='top-level';
     for(let p=node.parent;p;p=p.parent) {
      if(ts.isCaseClause(p)&&ts.isStringLiteral(p.expression)){owner='tool:'+p.expression.text;break;}
      if(ts.isFunctionDeclaration(p)&&p.name){owner=p.name.text;break;}
      if(ts.isMethodDeclaration(p)){owner=p.name.getText(source);break;}
      if(ts.isVariableDeclaration(p)&&p.name&&p.initializer&&(ts.isArrowFunction(p.initializer)||ts.isFunctionExpression(p.initializer))){owner=p.name.getText(source);break;}
     }
     const ordinal=(counts.get(owner)||0)+1;counts.set(owner,ordinal);
     rows.push({file,function:owner,ordinal,line:source.getLineAndCharacterOfPosition(node.getStart(source)).line+1,method,resourceType,expression:node.getText(source).slice(0,180)});
    }
   }
  }
  ts.forEachChild(node,walk);
 }
 walk(source);
}
writeFileSync('.odos/r10-a3-1/write-census-inventory.json',JSON.stringify(rows,null,2));
console.log(JSON.stringify({candidateCallSites:rows.length,files:new Set(rows.map(r=>r.file)).size,index:rows.filter(r=>r.file==='mcp/src/index.ts')}));
