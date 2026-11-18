const fs=require('fs'),vm=require('vm'),assert=require('assert'),{webcrypto,createHash}=require('crypto');
const context=vm.createContext({crypto:webcrypto,TextEncoder,console});
vm.runInContext(fs.readFileSync(__dirname+'/helper.js','utf8')+'\n'+fs.readFileSync(__dirname+'/background.js','utf8'),context);
const files=[{path:'op_kernel/a.cpp',content:'new'}],payload={slug:'layernormv3',title:'LayerNormV3',problemPath:'/public/ictcompetition/layernormv3',baselineSubmission:'example-reference',version:'test',files,sha256:createHash('sha256').update(JSON.stringify(files)).digest('hex')};
function setup(mode){
 const calls=[],saved={};
 const env={client:'worker',notice(){},storage:{getItem(k){return k==='cannjudge_user'?JSON.stringify({_id:'user'}):saved[k]},setItem(k,v){saved[k]=v}},
 local:async(p,b)=>{calls.push({local:p,body:b});if(mode==='gate-lost'&&p.endsWith('/begin'))throw Error('lost gate reply');return {};},
 request:async(p,b)=>{
  calls.push({remote:p,body:b});
  if(p==='/api/submissions/example-reference')return {contest_id:'contest'};
  if(p==='/api/problems/contest/contest')return [{_id:'problem',name:mode==='wrong-problem'?'other':'LayerNormV3'}];
  if(p==='/api/problems/problem')return {name:'LayerNormV3',contest_id:'contest'};
  if(p==='/api/problems/problem/template')return {data:{files:[{path:'op_kernel/a.cpp',content:'old'}]}};
  if(p==='/api/submissions/submit'){if(mode==='post-lost')throw Error('lost POST reply');return {data:{submissionId:'remote'}};}
  if(p==='/api/submissions/remote')return {status:'Pass',files:[{path:'private',content:'not a result'}],result:[{testcase_status:'Pass',time:4.2,msg:''},{testcase_status:'Hidden',msg:'hidden',time:7}]};
  throw Error('unexpected '+p);
 }};
 return {env,calls,saved};
}
context.readOwnRankings=async()=>({totalScore:[{score:1}]});
(async()=>{
 for(const mode of ['ok','gate-lost','post-lost','wrong-problem']){
  const s=setup(mode),job={id:'job',payload};
  if(mode==='ok')await context.processBackgroundJob(job,s.env);else await assert.rejects(context.processBackgroundJob(job,s.env));
  const posts=s.calls.filter(c=>c.remote==='/api/submissions/submit');
  assert.equal(posts.length,['ok','post-lost'].includes(mode)?1:0);
  if(mode==='ok'){
   assert(s.saved.cannjudge_background_receipt_job);
   assert(s.calls.findIndex(c=>c.local?.endsWith('/begin'))<s.calls.findIndex(c=>c.remote==='/api/submissions/submit'));
   const evidence=s.calls.find(c=>c.local?.endsWith('/result')).body;
   assert(evidence.terminal);assert(!evidence.result.files);assert.deepEqual(JSON.parse(JSON.stringify(evidence.result.result[1])),{testcase_status:'Hidden'});
  }
 }
 const s=setup('ok');await context.processBackgroundJob({id:'job',payload,submissionId:'remote',problemId:'problem',contestId:'contest'},s.env);
 assert(!s.calls.some(c=>c.remote==='/api/submissions/submit'));
 for(const status of ['Running','Queued','Compiling','unexpected',''])assert(!context.backgroundTerminal(status));
 assert(context.backgroundTerminal('Pass'));assert(context.backgroundTerminal('Runtime Error'));
 console.log('PASS background worker: problem binding, hash, durable gate, one POST, lost responses, result/receipt resume, evidence filtering');
})().catch(e=>{console.error(e);process.exitCode=1});
