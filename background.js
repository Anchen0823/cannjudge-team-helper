/* Same-origin CANNJudge worker. No credentials are sent to the local queue. */
function backgroundTerminal(status) {
  return /^(pass|accepted|fail|failed|wrong answer|runtime error|compile error|compilation error|time limit exceeded|memory limit exceeded|system error|judge error|internal error|output limit exceeded)$/i.test(String(status||'').trim());
}
function backgroundEvidence(state) {
  const result={};
  for(const key of ['_id','ID','status','score','created_at','updated_at','time','msg'])if(state[key]!=null)result[key]=state[key];
  result.result=(Array.isArray(state.result)?state.result:[]).map(row=>{
    if(row.testcase_status==='Hidden')return {testcase_status:'Hidden'};
    const clean={};for(const key of ['testcase_status','time','best_time','bestTime','precision_ratio','msg','type','case_type'])if(row[key]!=null)clean[key]=row[key];
    return clean;
  });
  return result;
}
async function resolveBackgroundProblem(request,payload) {
  // The reference submission supplies contest identity, not another participant's code.
  const reference=payload.baselineSubmission || payload.contestReference;
  if(!reference) throw Error('工程包缺少同赛事的提交记录 ID，请重新打包');
  const anchor=await request('/api/submissions/'+encodeURIComponent(reference));
  let contestId=anchor.contest_id||anchor.contest?._id||anchor.problem?.contest_id;
  if(!contestId) {
    const p=await request('/api/problems/'+encodeURIComponent(anchor.problem?._id||anchor.problem_id));
    contestId=p.contest_id;
  }
  if(typeof contestId!=='string'||!contestId)throw Error('无法确认赛事 ID');
  const list=await request('/api/problems/contest/'+encodeURIComponent(contestId));
  if(!Array.isArray(list))throw Error('赛事题目格式改变');
  const matches=list.filter(p=>[p.name,p.canonical_name,p.title].some(n=>String(n||'').toLowerCase()===payload.slug.toLowerCase()));
  if(matches.length!==1)throw Error('题目绑定不唯一或题目不可见');
  const problemId=matches[0]._id;
  const detail=await request('/api/problems/'+encodeURIComponent(problemId));
  if(String(detail.contest_id||'')!==contestId)throw Error('题目赛事不匹配');
  if(![detail.name,detail.canonical_name,detail.title].some(n=>String(n||'').toLowerCase()===payload.slug.toLowerCase()))throw Error('题目名称不匹配');
  return {problemId,contestId};
}
async function processBackgroundJob(job,env) {
  const {local,request,client,storage,notice}=env,payload=job.payload;
  let {submissionId,problemId,contestId}=job;
  const route='/jobs/'+job.id;
  if(!submissionId) {
    validatePackage(payload);
    if(!['concatd','confusiontransposed','ctclossv2','layernormv3','multilabelmarginloss','padv3grad','prelugradupdate','quantupdatescatter','stridedslicegrad','syncbatchnormgatherstats'].includes(payload.slug)||payload.problemPath!=='/public/ictcompetition/'+payload.slug)throw Error('任务超出十题范围');
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(payload.files)));
    const actual=Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('');
    if(actual!==payload.sha256)throw Error('工程包校验失败');
    const user=JSON.parse(storage.getItem('cannjudge_user')||'null');
    if(!user?._id)throw Error('CANNJudge 未登录');
    ({problemId,contestId}=await resolveBackgroundProblem(request,payload));
    const template=await request('/api/problems/'+encodeURIComponent(problemId)+'/template');
    if(!Array.isArray(template?.data?.files))throw Error('模板格式改变');
    const plan=buildSubmission(payload.files,template.data.files);
    // Durable gate BEFORE the one and only remote POST.
    await local(route+'/begin',{client});
    notice(payload.title+'：正在提交 '+payload.version);
    const response=await request('/api/submissions/submit',{problemId,userId:user._id,files:plan.files,...legacyFields(plan.files)});
    submissionId=String(response?.data?.submissionId||'');
    if(!/^[a-zA-Z0-9_-]+$/.test(submissionId))throw Error('平台未返回提交 ID；不会重复发送');
    // Persist the receipt before transmitting it locally so a lost bridge reply is recoverable.
    try{storage.setItem('cannjudge_background_receipt_'+job.id,JSON.stringify({submissionId,problemId,contestId,sha256:payload.sha256}));}catch{}
    await local(route+'/receipt',{submissionId,problemId,contestId});
  }
  notice(payload.title+'：查询成绩 '+submissionId);
  const state=await request('/api/submissions/'+encodeURIComponent(submissionId));
  const terminal=backgroundTerminal(state.status);
  const body={submissionId,terminal,result:backgroundEvidence(state)};
  if(terminal) {
    try {body.rankings=await readOwnRankings(request,problemId,contestId,payload.profile);}
    catch(e){body.rankings={error:e.message,capturedAt:new Date().toISOString()};}
  }
  await local(route+'/result',body);
  notice(payload.title+'：'+String(state.status||'状态未知')+' · '+submissionId);
}
async function startBackground(config) {
  if(location.origin!=='https://cannjudge.cn')throw Error('请在已登录的 CANNJudge 页面启动后台助手');
  if(!config.transport&&(!/^http:\/\/127\.0\.0\.1:\d+$/.test(config.url)||typeof config.key!=='string'))throw Error('本地队列地址无效');
  if(window.__cannBackground)throw Error('后台助手已经运行');
  const client=crypto.randomUUID(),status=document.createElement('div'),text=document.createElement('span'),stop=document.createElement('button');
  status.style.cssText='position:fixed;bottom:12px;right:12px;z-index:2147483647;background:#fff;color:#222;border:1px solid #bbb;padding:12px;border-radius:8px;max-width:480px;font:14px system-ui';
  text.textContent='后台助手连接中…';stop.textContent='停止后台助手';stop.style.marginLeft='12px';status.append(text,stop);document.body.append(status);
  let stopped=false,busy=false,timer;
  const notice=s=>text.textContent=s;
  const fetchJson=async(url,options={})=>{
    const ctrl=new AbortController(),timeout=setTimeout(()=>ctrl.abort(),30000);
    try{const r=await fetch(url,{...options,signal:ctrl.signal,cache:'no-store'});const data=await r.json();if(!r.ok)throw Error('HTTP '+r.status+' '+(data.error||data.message||data.msg||''));return data;}
    finally{clearTimeout(timeout);}
  };
  const local=config.transport||((path,data)=>fetchJson(config.url+path,{method:data?'POST':'GET',credentials:'omit',headers:{Authorization:'Bearer '+config.key,...(data?{'Content-Type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{})}));
  const request=(path,data)=>fetchJson(path,{method:data?'POST':'GET',credentials:'same-origin',headers:data?{'Content-Type':'application/json'}:{},...(data?{body:JSON.stringify(data)}:{})});
  window.__cannBackground={stop:()=>{stopped=true;clearTimeout(timer);notice(busy?'停止中：等待当前请求结束，不再领取新任务':'后台助手已停止');if(!busy){status.remove();delete window.__cannBackground;}}};
  stop.onclick=()=>window.__cannBackground?.stop();
  const tick=async()=>{
    if(stopped)return;busy=true;let job;
    try {
      const health=await local('/health');
      // Recover receipts already recorded in this browser, without another remote POST.
      for(const pending of health.jobs||[])if(['posting','uncertain'].includes(pending.state)) {
        const receipt=JSON.parse(localStorage.getItem('cannjudge_background_receipt_'+pending.id)||'null');
        if(receipt)await local('/jobs/'+pending.id+'/receipt',receipt);
      }
      ({job}=await local('/next?client='+encodeURIComponent(client)));
      if(job)await processBackgroundJob(job,{local,request,client,storage:localStorage,notice});
      else if((health.jobs||[]).some(j=>['posting','uncertain','claimed'].includes(j.state)))notice('有未确认的任务；队列已停止发送，等待核对回执');
      else notice('后台助手在线 · 等待本地任务');
    }catch(e){
      notice('后台助手：'+e.message);
      if(job)try{await local('/jobs/'+job.id+'/error',{error:e.message});}catch{}
    }finally{
      busy=false;
      if(!stopped)timer=setTimeout(tick,5000);
      else{status.remove();delete window.__cannBackground;}
    }
  };
  await tick();
}
