const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync(__dirname+'/helper.js','utf8');
const plain=vm.createContext({});vm.runInContext(source,plain);
const parse=x=>JSON.parse(JSON.stringify(x));
const template=[{path:'op_kernel/a.cpp',content:'old'},{path:'build.sh',content:'locked',editable:false}];
let p=parse(plain.buildSubmission([{path:'op_kernel/a.cpp',content:'new'},{path:'build.sh',content:'changed'},{path:'op_host/new.h',content:'h'}],template));
assert.equal(p.files.length,2);assert.deepEqual(p.skipped,['build.sh']);assert(p.changed.includes('+ op_host/new.h'));
for(const local of [[],[{path:'../bad.h',content:''}],[{path:'op_kernel/a.cpp',content:''},{path:'foo/new.h',content:''}],[{path:'op_kernel/a.cpp',content:''},{path:'op_kernel/a.cpp',content:''}]])assert.throws(()=>plain.buildSubmission(local,template));
const extras=Array.from({length:21},(_,i)=>({path:`op_host/a${i}.h`,content:''}));assert.throws(()=>plain.buildSubmission([{path:'op_kernel/a.cpp',content:''},...extras],template));
function setup(mode='ok'){
 const calls=[],elements=[];
 const document={body:{append(){}},createElement(tag){const e={tag,style:{},children:[],append(...a){this.children.push(...a)},showModal(){},remove(){},addEventListener(){}};elements.push(e);return e}};
 const ctx=vm.createContext({console,document,location:{origin:'https://cannjudge.cn',pathname:'/public/ictcompetition/confusiontransposed'},window:{},localStorage:{getItem(){return JSON.stringify({_id:'test-user'})}},AbortController,setTimeout:()=>1,clearTimeout(){},
 fetch:async(path,init)=>{calls.push({path,init});let body;
 if(init.method==='POST'){
  if(mode==='network')throw Error('network interrupted');
  body={data:{submissionId:'new-id'}};
 }else if(path.includes('/template'))body={data:{files:template}};
 else if(path.includes('/api/problems/'))body={name:mode==='wrong-problem'?'Other':'ConfusionTransposeD'};
 else if(path.includes('new-id'))body={status:'Accepted'};
 else body={problem_id:'problem-id'};
 return {ok:mode!=='unauthorized',status:mode==='unauthorized'?401:200,json:async()=>body};
 }});
 vm.runInContext(source,ctx);
 return {ctx,calls,elements};
}
(async()=>{
 const payload={title:'ConfusionTransposeD',slug:'confusiontransposed',problemPath:'/public/ictcompetition/confusiontransposed',baselineSubmission:'old-id',version:'test',files:[{path:'op_kernel/a.cpp',content:'new'}]};
 for(const mode of ['ok','network','wrong-problem','unauthorized']){
  const s=setup(mode);await s.ctx.startHelper(payload);
  const button=s.elements.find(e=>e.tag==='button');
  if(mode==='wrong-problem'||mode==='unauthorized'){assert(button.disabled);assert.equal(s.calls.filter(c=>c.init.method==='POST').length,0);continue;}
  assert.equal(button.disabled,false);
  await button.onclick();await button.onclick();
  assert.equal(s.calls.filter(c=>c.init.method==='POST').length,1,'must never retry POST');
  const body=JSON.parse(s.calls.find(c=>c.init.method==='POST').init.body);
  assert.equal(body.problemId,'problem-id');assert.equal(body.files[0].content,'new');assert.equal(body.files.length,1);
  assert.equal(s.calls[0].init.credentials,'same-origin');
  if(mode==='ok')assert(s.elements.some(e=>e.tag==='a'&&e.href.endsWith('/submission/new-id')));
 }
 const corrupt=setup();corrupt.ctx.crypto=require('crypto').webcrypto;corrupt.ctx.TextEncoder=TextEncoder;await assert.rejects(corrupt.ctx.startHelper({...payload,sha256:'0'.repeat(64)}));assert.equal(corrupt.calls.length,0);
 const s=setup();s.ctx.location.origin='https://example.org';await assert.rejects(s.ctx.startHelper(payload));assert.equal(s.calls.length,0);
 console.log('PASS: merge/protected paths/missing files/duplicates/new-file limits; auth and problem binding; same-origin session; one POST; lost-response no retry; result link');
})().catch(e=>{console.error(e);process.exitCode=1});
