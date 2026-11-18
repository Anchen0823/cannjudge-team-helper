function validatePackage(p) {
  if(!p||!Array.isArray(p.files)||!p.files.length||p.files.length>1000||!/^\/public\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(p.problemPath)||typeof p.slug!=='string'||typeof p.title!=='string'||typeof p.baselineSubmission!=='string')throw Error('不是有效的 CANNJudge 工程包');
  if(p.profile && (typeof p.profile.account!=='string'||typeof p.profile.team!=='string'))throw Error('排名关注配置无效');
  for(const f of p.files)if(typeof f.path!=='string'||typeof f.content!=='string')throw Error('工程文件格式无效');
}
/* CANNJudge batch submission helper. Runs only on the exact HTTPS origin. */
function buildSubmission(local, template) {
  const norm = s => String(s ?? '').replace(/\r\n/g, '\n');
  const valid = p => typeof p === 'string' && p && !p.startsWith('/') && !p.includes('\\') && !p.split('/').some(s => !s || s === '.' || s === '..');
  const incoming = new Map();
  for (const f of local) {
    if (!valid(f.path) || typeof f.content !== 'string' || incoming.has(f.path)) throw Error('本地文件路径非法或重复');
    incoming.set(f.path, f.content);
  }
  const files = [], changed = [], skipped = [], known = new Set();
  for (const f of template) {
    if (!valid(f.path) || known.has(f.path)) throw Error('模板路径非法或重复');
    known.add(f.path);
    const old = String(f.content ?? '');
    const content = incoming.has(f.path) ? incoming.get(f.path) : old;
    if (f.editable === false) {
      if (norm(content) !== norm(old)) skipped.push(f.path);
      continue;
    }
    if (!incoming.has(f.path)) throw Error('本地缺少可编辑文件：' + f.path);
    files.push({path:f.path, content});
    if (norm(content) !== norm(old)) changed.push(f.path);
  }
  let added = 0;
  for (const [path, content] of incoming) {
    if (known.has(path)) continue;
    const parts = path.split('/');
    if (parts.length !== 2 || !['op_host','op_kernel','op_api'].includes(parts[0]) || !/^(?=.{1,128}$)[\w][\w.-]*\.(h|cpp)$/.test(parts[1])) throw Error('平台不允许新增：'+path);
    if (++added > 20) throw Error('新增文件超过平台 20 个上限');
    files.push({path,content}); changed.push('+ '+path);
  }
  if (!files.length) throw Error('模板没有可提交文件');
  return {files,changed,skipped};
}
function legacyFields(files) {
  const find = fn => files.find(f=>fn(f.path, f.path.split('/').pop()))?.content || '';
  return {
    tiling_h:find((p,b)=>b==='tiling.h'||p.startsWith('op_kernel/')&&/_tiling\.h$/i.test(b)),
    tiling_key_h:find((p,b)=>b==='tiling_key.h'||p.startsWith('op_kernel/')&&(/^tiling_key_/i.test(b)||/_tiling_key\.h$/i.test(b))),
    host_cpp:find((p,b)=>p.startsWith('op_host/')&&/\.(cc|cpp|cxx|h|hpp)$/i.test(b))||find((p,b)=>b==='host.cpp'),
    kernel_cpp:find((p,b)=>p.startsWith('op_kernel/')&&/\.(cc|cpp|cxx)$/i.test(b))||find((p,b)=>b==='kernel.cpp')
  };
}
async function startHelper(payload) {
  validatePackage(payload);
  if(payload.sha256) {
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(payload.files)));
    const actual=Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('');
    if(actual!==payload.sha256)throw Error('工程包校验失败，请重新生成，不提交不完整文件');
  }
  if (location.origin !== 'https://cannjudge.cn') throw Error('请在 https://cannjudge.cn 的本题页面点击书签');
  if (location.pathname !== payload.problemPath && !location.pathname.startsWith(payload.problemPath+'/')) throw Error('当前不是 '+payload.title+' 的题目页面');
  if (window.__cannBatchSubmitActive) throw Error('已有提交助手在运行，请先关闭它；发送中不能重复提交');
  const user=JSON.parse(localStorage.getItem('cannjudge_user')||'null');
  if (!user?._id) throw Error('请先登录 CANNJudge');
  window.__cannBatchSubmitActive=true;
  const box=document.createElement('dialog');
  box.style.cssText='max-width:760px;width:85vw;padding:24px;border:1px solid #bbb;border-radius:12px;background:white;color:#222;z-index:2147483647';
  const heading=document.createElement('h2');heading.textContent=payload.title+' 批量提交';
  const text=document.createElement('pre');text.style.cssText='white-space:pre-wrap;max-height:50vh;overflow:auto';
  const submit=document.createElement('button');submit.textContent='核对中…';submit.disabled=true;
  const close=document.createElement('button');close.textContent='关闭';close.style.marginLeft='16px';
  box.append(heading,text,submit,close);document.body.append(box);box.showModal();
  let sent=false, busy=false, ranking=null;
  const dismiss=()=>{if(busy)return;ranking?.stop();box.remove();window.__cannBatchSubmitActive=false;};
  close.onclick=dismiss;box.addEventListener('cancel',e=>{e.preventDefault();dismiss();});
  const request=async(path, data)=>{
    const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),30000);
    try {
      const r=await fetch(path,{method:data?'POST':'GET',credentials:'same-origin',cache:'no-store',signal:ctrl.signal,
        headers:data?{'Content-Type':'application/json'}:{},...(data?{body:JSON.stringify(data)}:{})});
      const body=await r.json();
      if(!r.ok)throw Error('HTTP '+r.status+': '+(body.message||body.msg||body.error||'请求失败'));
      return body;
    } finally {clearTimeout(timer);}
  };
  try {
    text.textContent='读取当前登录会话可访问的模板…';
    const query='?userId='+encodeURIComponent(user._id);
    const previous=await request('/api/submissions/'+encodeURIComponent(payload.baselineSubmission||payload.contestReference)+query);
    let problemId=previous.problem?._id||previous.problem_id;
    if(!payload.baselineSubmission&&payload.contestReference) {
      const anchor=await request('/api/problems/'+encodeURIComponent(problemId)+query);
      const contestId=anchor.contest_id||previous.contest_id||previous.contest?._id;
      if(!contestId)throw Error('无法取得赛事 ID');
      const list=await request('/api/problems/contest/'+encodeURIComponent(contestId)+query);
      if(!Array.isArray(list))throw Error('赛事题目格式改变');
      const matches=list.filter(p=>[p.name,p.canonical_name,p.title].some(n=>String(n||'').toLowerCase()===payload.slug.toLowerCase()));
      if(matches.length!==1)throw Error('无法唯一绑定本题');
      problemId=matches[0]._id;
    }
    if(typeof problemId!=='string'||!problemId)throw Error('无法从基准提交取得题目 ID');
    const problem=await request('/api/problems/'+encodeURIComponent(problemId)+query);
    const names=[problem.name,problem.canonical_name,problem.title].filter(Boolean).map(s=>String(s).toLowerCase());
    if(!names.includes(payload.slug.toLowerCase())&&!names.includes(payload.title.toLowerCase()))throw Error('基准提交题目与本地工程不一致');
    const template=await request('/api/problems/'+encodeURIComponent(problemId)+'/template'+query);
    if(!Array.isArray(template?.data?.files))throw Error('模板响应格式改变，停止提交');
    const plan=buildSubmission(payload.files,template.data.files);
    text.textContent='版本：'+payload.version+'\n生成时间：'+payload.created+'\n快照 SHA256：'+payload.sha256+'\n\n相对模板变更：\n'+plan.changed.join('\n')+'\n\n将提交 '+plan.files.length+' 个可编辑文件。'+(plan.skipped.length?'\n平台保护文件的本地修改不会提交：\n'+plan.skipped.join('\n'):'')+'\n\n这是生成时的代码快照；本地修改后须重新生成入口。';
    try {const last=JSON.parse(localStorage.getItem('cannjudge_helper_receipt_'+problemId)||'null');if(last?.sha256===payload.sha256&&payload.sha256)text.textContent+='\n注意：相同快照曾提交为 '+last.id+'（'+last.time+'），请避免误重复提交。';}catch{}
    if(payload.profile)ranking=mountRanking(box,request,problemId,problem.contest_id||previous.contest_id||previous.contest?._id,payload.profile);
    const replace=document.createElement('button');replace.textContent='载入新版工程包';box.append(replace);
    replace.onclick=()=>{if(busy)return;const input=document.createElement('input');input.type='file';input.accept='.json';input.onchange=async()=>{try{const f=input.files[0];if(!f)return;const next=JSON.parse(await f.text());validatePackage(next);dismiss();await startHelper(next);}catch(e){alert(e.message);}};input.click();};
    submit.textContent='提交此版本';submit.disabled=false;
    submit.onclick=async()=>{
      if(sent||busy)return;
      sent=true;busy=true;submit.disabled=true;close.disabled=true;
      submit.textContent='正在提交…';
      try {
        const result=await request('/api/submissions/submit',{problemId,userId:user._id,files:plan.files,...legacyFields(plan.files)});
        const id=String(result?.data?.submissionId||'');
        if(!/^[a-zA-Z0-9_-]+$/.test(id))throw Error('服务器未返回可识别的提交 ID，请在网站检查记录，勿重复提交');
        try{localStorage.setItem('cannjudge_helper_receipt_'+problemId,JSON.stringify({id,sha256:payload.sha256,time:new Date().toISOString()}));}catch{}
        const link=document.createElement('a');link.href=payload.problemPath+'/submission/'+encodeURIComponent(id);link.textContent='打开本次评测结果';link.style.display='block';box.append(link);
        text.textContent+='\n\n已提交：'+id+'\n正在查询状态…';submit.textContent='已提交（禁止重复发送）';
        // Bounded read-only polling. Network errors never retry the POST.
        for(let i=0;i<30;i++) {
          const state=await request('/api/submissions/'+encodeURIComponent(id)+query);
          const status=state.status??state.result??'请打开结果页查看';
          text.textContent=text.textContent.replace(/\n当前状态：[\s\S]*$/,'')+'\n当前状态：'+String(status);
          if(!/pending|queue|running|judging|compiling|waiting/i.test(String(status))){ranking?.refresh();break;}
          await new Promise(r=>setTimeout(r,3000));
        }
      } catch(e) {
        text.textContent+='\n\n'+e.message+'\n已停止，绝不自动重试提交。若请求超时或响应丢失，请先检查网站提交记录。';
        submit.textContent='已停止，请检查提交记录';
      } finally {busy=false;close.disabled=false;}
    };
  } catch(e) {text.textContent='检查失败，未提交：'+e.message;submit.textContent='不可提交';}
}
