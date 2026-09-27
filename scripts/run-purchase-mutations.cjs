#!/usr/bin/env node
// Sequential targeted mutations run in a private copy, never the running owner.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');const {createHash}=require('node:crypto');const assert=require('node:assert/strict');
const {classifyMutationResult,replaceOnce}=require('../test/runtime/purchaseMutationRunner.cjs');
const root=path.resolve(__dirname,'..'),output=process.env.CELLIFI_MUTATION_OUTPUT;
assert.ok(output&&path.isAbsolute(output),'CELLIFI_MUTATION_OUTPUT must be an absolute private report directory');
fs.mkdirSync(output,{recursive:true,mode:0o700});
const reportPath=path.join(output,'mutation-report.json');fs.rmSync(reportPath,{force:true});
const manifest=JSON.parse(fs.readFileSync(path.join(root,'test/purchase-mutations.json'),'utf8'));
const scratch=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cellifi-stock-mutations-')));
const report={schemaVersion:'1',files:{}},receipts=[];
const hash=source=>createHash('sha256').update(source).digest('hex');
try{
 for(const dir of ['src','test'])fs.cpSync(path.join(root,dir),path.join(scratch,dir),{recursive:true});
 for(const file of ['jest.config.js','tsconfig.json','tsconfig.test.json','package.json','.env.test'])if(fs.existsSync(path.join(root,file)))fs.copyFileSync(path.join(root,file),path.join(scratch,file));
 fs.symlinkSync(path.join(root,'node_modules'),path.join(scratch,'node_modules'),'dir');
 const run=label=>{
  const resultPath=path.join(output,`${label}.json`),log=fs.openSync(path.join(output,`${label}.log`),'w',0o600);
  const result=spawnSync(process.execPath,[path.join(root,'node_modules/jest/bin/jest.js'),'--config',path.join(scratch,'jest.config.js'),'--rootDir',scratch,'--runInBand','--runTestsByPath',...manifest.tests.map(file=>path.join(scratch,file)),'--json',`--outputFile=${resultPath}`],{cwd:scratch,env:process.env,stdio:['ignore',log,log],timeout:60000});fs.closeSync(log);
  if(result.error)throw result.error;
  const data=JSON.parse(fs.readFileSync(resultPath,'utf8')),status=classifyMutationResult(data,result.status);
  receipts.push({label,status,tests:data.numTotalTests,resultHash:hash(fs.readFileSync(resultPath))});return status;
 };
 assert.equal(run('baseline'),'Survived');
 for(const [index,mutation] of manifest.mutations.entries()){
  assert.match(mutation.file,/^src\/inventory\/services\/[A-Za-z]+\.ts$/);
  const source=fs.readFileSync(path.join(root,mutation.file),'utf8');
  fs.writeFileSync(path.join(scratch,mutation.file),replaceOnce(source,mutation.from,mutation.to));
  let status;try{status=run(`mutant-${index}`);}finally{fs.writeFileSync(path.join(scratch,mutation.file),source);}
  report.files[mutation.file]??={source,mutants:[]};
  report.files[mutation.file].mutants.push({id:String(index),mutatorName:mutation.name,status});
  process.stdout.write(`${index+1}/${manifest.mutations.length} ${mutation.name}: ${status}\n`);
 }
 fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});
 fs.writeFileSync(path.join(output,'execution.json'),JSON.stringify({passed:receipts.every(row=>row.label==='baseline'||row.status==='Killed'),targeted:true,equivalentExclusions:manifest.equivalentExclusions,receipts,manifestHash:hash(JSON.stringify(manifest))},null,2)+'\n',{mode:0o600});
 if(receipts.some(row=>row.label!=='baseline'&&row.status!=='Killed'))process.exitCode=1;
}finally{fs.rmSync(scratch,{recursive:true,force:true});}
