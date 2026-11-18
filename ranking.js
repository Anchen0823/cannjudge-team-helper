function rankIdentity(row) {
  const user=row.submitter||row.user||{},team=row.team||{};
  return {teamId:String(team._id||team.id||team.team_id||row.team_id||''),team:String(team.team_name||team.name||team.team_id||''),user:String(user.nickname||user.username||user.ID||row.user_id||''),
    aliases:[user.nickname,user.username,user.ID,user.gitcode_username,user.huawei_username].filter(x=>x!=null).map(x=>String(x).trim().toLowerCase())};
}
function ownRank(row, profile) {
  const who=rankIdentity(row);
  if(who.aliases.includes(profile.account.trim().toLowerCase()))return true;
  if(profile.resolvedTeams?.length)return profile.resolvedTeams.some(t=>
    who.teamId&&t.id ? who.teamId===t.id : Boolean(t.name)&&who.team.trim()===t.name);
  return Boolean(profile.team.trim())&&who.team.trim()===profile.team.trim();
}
function rankSummary(row, rank) {
  const who=rankIdentity(row);
  return {rank: Number.isFinite(Number(rank))&&Number(rank)>0?Number(rank):null,team:who.team,teamId:who.teamId,user:who.user,
    score:row.score??null,passed:row.passCount??null,submissions:row.submissionCount??null,status:row.status??null};
}
function sortContestRank(rows, mode) {
  const n=x=>Number.isFinite(Number(x))?Number(x):0;
  return rows.slice().sort((a,b)=>mode==='num'?
    n(b.passCount)-n(a.passCount)||n(b.score)-n(a.score)||n(a.submissionCount)-n(b.submissionCount):
    n(b.score)-n(a.score)||n(b.passCount)-n(a.passCount)||n(a.submissionCount)-n(b.submissionCount));
}
async function readProblemOwnRanking(request, problemId, profile) {
  const warnings=[],rows=[],seen=new Set();
  for(const q of new Set([profile.account,profile.team])) {
    for(let page=1;page<=100;page++) {
      const result=await request('/api/problems/'+encodeURIComponent(problemId)+'/ranking?'+new URLSearchParams({page:String(page),size:'100',q}));
      const list=result.rows||result.list;
      if(!Array.isArray(list))throw Error('题目排行榜格式改变或不可见');
      for(const row of list) {
        if(!ownRank(row,profile))continue;
        // Search position is NOT an overall rank. Missing rank stays unknown.
        const value=rankSummary(row,row.rank);
        value.accountMatch=rankIdentity(row).aliases.includes(profile.account.trim().toLowerCase());
        const key=row.submission_id||row.submission?._id||JSON.stringify(value);
        if(!seen.has(key)){seen.add(key);rows.push(value);}
      }
      const pages=Number(result.pages)||Math.ceil(Number(result.total)/Math.max(1,Number(result.size)||100));
      if(pages>0?page>=pages:list.length<100)break;
      if(page===100)warnings.push('题目搜索超过 100 页，结果不完整');
    }
  }
  return {rows,warnings};
}
async function readOwnRankings(request, problemId, contestId, profile) {
  const warnings=[],startedAt=new Date().toISOString();
  let problems=[{_id:problemId,title:'当前题目'}],complete=true,contestRows=[],scoreRows=[],rankingMode='score',contestTitle='赛事',contestStats=null;
  if(contestId) {
    const encoded=encodeURIComponent(contestId);
    const [info,listing]=await Promise.allSettled([
      request('/api/contests/'+encoded),request('/api/problems/contest/'+encoded)
    ]);
    if(listing.status==='fulfilled'&&Array.isArray(listing.value)) {
      const ids=new Set();problems=[];
      for(const p of listing.value) {
        const id=p._id||p.id;
        if(!id){complete=false;warnings.push('赛事题目列表有缺少 ID 的条目');continue;}
        if(!ids.has(String(id))){ids.add(String(id));problems.push({...p,_id:String(id)});}
      }
      problems.sort((a,b)=>String(a.title||a.name||a._id).localeCompare(String(b.title||b.name||b._id),'zh-CN',{numeric:true}));
    } else {complete=false;warnings.push('无法读取完整题目列表，仅查询当前题目：'+(listing.reason?.message||'响应格式不符'));}
    if(info.status==='fulfilled') {
      const contest=info.value;
      contestTitle=contest.title||contest.name||contestTitle;
      rankingMode=contest.ranking_mode==='num'?'num':'score';
      if(contest.show_total_ranking===false)warnings.push('赛事总榜已关闭');
      else try {
        const stats=await request('/api/submissions/contest/'+encoded+'/stats');
        if(!Array.isArray(stats))throw Error('赛事总榜格式改变或不可见');
        // Wait for account-linked per-problem records to resolve the actual team.
        contestStats=stats;
      }catch(e){warnings.push('总榜读取失败：'+e.message);}
    }else warnings.push('赛事信息读取失败：'+info.reason.message);
  }else{complete=false;warnings.push('未取得赛事 ID，仅查询当前题目');}
  const results=new Array(problems.length);let cursor=0;
  // At most three independent problem requests in flight. Preserve every listed problem,
  // including unranked / inaccessible ones; one error must not erase the other results.
  async function worker() {
    while(cursor<problems.length) {
      const index=cursor++,p=problems[index];
      const entry={id:p._id,title:p.title||p.name||p._id,rows:[],warnings:[],state:'ok'};
      try {
        const data=await readProblemOwnRanking(request,p._id,profile);
        entry.rows=data.rows;entry.warnings=data.warnings;
        if(data.warnings.length)entry.state='partial';
        else if(!entry.rows.length)entry.state='not-found';
      }catch(e){entry.state='error';entry.warnings.push(e.message);}
      results[index]=entry;
    }
  }
  await Promise.all(Array.from({length:Math.min(3,problems.length)},worker));
  const resolvedTeams=[],teamKeys=new Set();
  for(const p of results)for(const row of p.rows) {
    // Only learn a team from an exact account match, not from a fuzzy search hit.
    if(!row.accountMatch||(!row.teamId&&!row.team))continue;
    const id=row.teamId||'',name=row.team.trim(),key=id||name;
    if(!teamKeys.has(key)){teamKeys.add(key);resolvedTeams.push({id,name});}
  }
  const matchingProfile={...profile,resolvedTeams};
  if(resolvedTeams.some(t=>t.name&&t.name!==profile.team.trim()))
    warnings.push('根据账号 '+profile.account+' 的逐题记录识别到实际队伍：'+resolvedTeams.map(t=>t.name||t.id).join('、')+'；总榜按实际队伍 ID 匹配，缺少 ID 时按实际名称匹配（配置名称：'+profile.team+'）。');
  if(resolvedTeams.length>1)warnings.push('此账号关联多个队伍，分别展示匹配到的总榜记录。');
  if(contestStats) {
    sortContestRank(contestStats,rankingMode).forEach((row,i)=>{if(ownRank(row,matchingProfile))contestRows.push(rankSummary(row,i+1));});
    sortContestRank(contestStats,'score').forEach((row,i)=>{if(ownRank(row,matchingProfile))scoreRows.push(rankSummary(row,i+1));});
  }
  return {startedAt,capturedAt:new Date().toISOString(),profile,resolvedTeams,contestTitle,rankingMode,
    complete:complete&&results.every(p=>p.state!=='error'&&p.state!=='partial'),
    problems:results,problem:results.find(p=>p.id===problemId)?.rows||[],contest:contestRows,totalScore:scoreRows,warnings};
}
function rankingSnapshotText(next) {
  const format=rows=>rows.length?rows.map(x=>'第 '+(x.rank??'未知')+' 名 | '+[x.team,x.user].filter(Boolean).join(' / ')+' | 得分 '+(x.score??'未提供')+(x.passed!=null?' | 通过 '+x.passed+' 题':'')).join('\n'):'未找到匹配记录（可能尚未上榜、封榜或不可见）';
  const sections=next.problems.map(p=>p.title+'\n'+(p.state==='error'?'读取失败':format(p.rows))+(p.warnings.length?'\n提示：'+p.warnings.join('；'):''));
  return next.contestTitle+'\n更新：'+new Date(next.capturedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})+
    '\n\n总分排名（按总分排序）：\n'+format(next.totalScore)+
    (next.rankingMode==='num'?'\n\n赛事官方排名（按通过题数）：\n'+format(next.contest):'')+
    '\n\n逐题排名 · '+next.problems.length+' 道题'+(next.complete?'':' · 存在未完整读取项')+'\n\n'+sections.join('\n\n')+
    (next.warnings.length?'\n\n提示：'+next.warnings.join('\n'):'')+
    '\n\n总分来自赛事汇总接口，不累加重复的个人/队伍记录。各榜单在一次刷新过程中依次读取，并非原子快照。';
}

function mountRanking(box,request,problemId,contestId,profile) {
  const area=document.createElement('section'),heading=document.createElement('h3'),body=document.createElement('pre');
  heading.textContent='全赛事排名 · '+profile.account+' / '+profile.team;
  body.style.cssText='white-space:pre-wrap;max-height:55vh;overflow:auto';
  const refresh=document.createElement('button'),pause=document.createElement('button'),download=document.createElement('button');
  refresh.textContent='立即刷新排名';pause.textContent='暂停自动刷新';download.textContent='导出排名 JSON';download.disabled=true;
  area.append(heading,body,refresh,pause,download);box.append(area);
  let stopped=false,paused=false,inflight=false,timer=null,snapshot=null;

  const update=async()=>{
    if(stopped||inflight)return;
    clearTimeout(timer);inflight=true;refresh.disabled=true;
    try {
      const next=await readOwnRankings((...args)=>{if(stopped)throw Error('助手已关闭');return request(...args);},problemId,contestId,profile);
      if(stopped)return;
      const old=snapshot?.totalScore[0]?.rank,now=next.totalScore[0]?.rank;
      snapshot=next;
      heading.textContent='全赛事排名 · '+profile.account+' / '+(next.resolvedTeams.map(t=>t.name||t.id).join('、')||profile.team);
      body.textContent=rankingSnapshotText(next)+(old&&now&&old!==now?'\n总分名次变化：'+old+' → '+now:'');
      download.disabled=false;
    }catch(e){if(!stopped)body.textContent='本次刷新失败：'+e.message+'\n未将旧数据当作当前排名；导出仍为上次成功快照。';}
    finally{inflight=false;refresh.disabled=false;if(!stopped&&!paused)timer=setTimeout(()=>{if(document.hidden){timer=setTimeout(update,60000);}else update();},60000);}
  };
  refresh.onclick=update;
  pause.onclick=()=>{paused=!paused;pause.textContent=paused?'恢复自动刷新':'暂停自动刷新';clearTimeout(timer);if(!paused)update();};
  download.onclick=()=>{
    if(!snapshot)return;
    const url=URL.createObjectURL(new Blob([JSON.stringify(snapshot,null,2)],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download='cannjudge-ranking-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  update();
  return {refresh:update,stop(){stopped=true;clearTimeout(timer);}};
}
async function startRankOnly(config) {
  if(location.origin!=='https://cannjudge.cn')throw Error('请在已登录的 CANNJudge 网站使用排名书签');
  if(window.__cannRankOnlyActive)throw Error('排行榜窗口已打开');
  window.__cannRankOnlyActive=true;
  const box=document.createElement('dialog');box.style.cssText='width:85vw;max-width:760px;padding:24px;border-radius:12px;background:white;color:#222';
  const label=document.createElement('h2');label.textContent='赛事全部题目与总分排行';
  const status=document.createElement('p');status.textContent='读取赛事信息…';
  const close=document.createElement('button');close.textContent='关闭';
  box.append(label,status,close);document.body.append(box);box.showModal();
  let panel,closed=false;
  close.onclick=()=>{closed=true;panel?.stop();box.remove();window.__cannRankOnlyActive=false;};
  box.addEventListener('cancel',e=>{e.preventDefault();close.onclick();});
  const request=async(path)=>{
    if(closed)throw Error('窗口已关闭');
    const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),30000);
    try{const r=await fetch(path,{credentials:'same-origin',cache:'no-store',signal:ctrl.signal});const body=await r.json();if(!r.ok)throw Error('HTTP '+r.status+'：'+(body.message||'请检查登录状态或榜单权限'));return body;}finally{clearTimeout(timer);}
  };
  try {
    const sub=await request('/api/submissions/'+encodeURIComponent(config.baselineSubmission));
    const pid=sub.problem?._id||sub.problem_id;
    if(!pid)throw Error('无法识别题目，请确认基准提交可访问');
    const problem=await request('/api/problems/'+encodeURIComponent(pid));
    if(closed)return;
    status.textContent='每 60 秒刷新；关闭此窗口即停止。未找到记录不等于排名为零。';
    panel=mountRanking(box,request,pid,problem.contest_id||sub.contest_id||sub.contest?._id,config.profile);
  }catch(e){if(!closed)status.textContent=e.message;}
}
