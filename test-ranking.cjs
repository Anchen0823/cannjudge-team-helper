const fs=require('fs'),vm=require('vm'),assert=require('assert');
const ctx=vm.createContext({URLSearchParams,console});vm.runInContext(fs.readFileSync(__dirname+'/ranking.js','utf8'),ctx);
const profile={account:'player',team:'示例队旧名'};
(async()=>{
 assert(ctx.ownRank({submitter:{nickname:'PlAyEr'}},profile));
 assert(ctx.ownRank({team:{team_name:'示例队旧名'}},profile));
 assert(!ctx.ownRank({submitter:{nickname:'player-other'}},profile));
 assert.equal(ctx.rankSummary({},undefined).rank,null);
 const ordered=ctx.sortContestRank([{score:20,passCount:1,submissionCount:2},{score:20,passCount:2,submissionCount:4},{score:20,passCount:2,submissionCount:3}],'score');
 assert.equal(ordered[0].submissionCount,3);
 assert.equal(ctx.sortContestRank([{score:20,passCount:1},{score:10,passCount:2}],'num')[0].score,10);
 const calls=[];
 const req=async path=>{
 calls.push(path);
 if(path==='/api/problems/contest/cid')return [{_id:'pid',title:'ConfusionTransposeD'}];
 if(path.endsWith('/stats'))return [{score:100,team:{name:'other'}},{score:90,team:{name:'示例队旧名'}}];
 if(path.startsWith('/api/contests/'))return {ranking_mode:'score'};
 const u=new URL(path,'https://cannjudge.cn');
 if(u.searchParams.get('page')==='1')return {rows:[{submission_id:'a',rank:8,score:10,submitter:{nickname:'Player'}}],pages:2};
 return {rows:[{submission_id:'b',score:9,team:{team_name:'示例队旧名'}}],pages:2};
 };
 const result=await ctx.readOwnRankings(req,'pid','cid',profile);
 assert.equal(result.problem.length,2);assert.equal(result.problem[0].rank,8);assert.equal(result.problem[1].rank,null);assert.equal(result.contest[0].rank,2);
 assert.equal(calls.filter(p=>p.includes('page=2')).length,2);
 const denied=await ctx.readOwnRankings(async path=>{if(path.includes('/ranking?'))return {rows:[],pages:1};throw Error('403 frozen');},'pid','cid',profile);
 assert(denied.warnings[0].includes('403'));assert.equal(denied.contest.length,0);
 const invalid=await ctx.readOwnRankings(async()=>({error:'frozen'}),'pid',null,profile);assert.equal(invalid.problems[0].state,'error');
 // All contest problems, including empty and failed rankings, remain visible.
 let active=0,maxActive=0;
 const all=await ctx.readOwnRankings(async path=>{
   if(path==='/api/problems/contest/all')return [
     {_id:'p1',title:'ConcatD'}, {_id:'p2',title:'ConfusionTransposeD'},
     {_id:'p3',title:'CtcLossV2'}, {_id:'p4',title:'LayerNormV3'}, {_id:'p4',title:'duplicate'}];
   if(path==='/api/contests/all')return {title:'ICT',ranking_mode:'num'};
   if(path.endsWith('/stats'))return [
     {team:{name:'示例队旧名'},score:200,passCount:2},
     {team:{name:'other'},score:150,passCount:3}];
   active++;maxActive=Math.max(maxActive,active);
   await new Promise(r=>setTimeout(r,2));active--;
   if(path.includes('/p3/'))throw Error('HTTP 403 封榜');
   if(path.includes('/p4/'))return {rows:[],pages:1};
   return {rows:[{submission_id:path.includes('/p1/')?'s1':'s2',rank:6,score:80,team:{name:'示例队旧名'}}],pages:1};
 },'p2','all',profile);
 assert.equal(all.problems.length,4);assert.equal(all.problems.find(p=>p.id==='p3').state,'error');
 assert.equal(all.problems.find(p=>p.id==='p4').state,'not-found');assert.equal(all.complete,false);
 assert.equal(all.totalScore[0].rank,1);assert.equal(all.totalScore[0].score,200);
 assert.equal(all.contest[0].rank,2);assert(maxActive<=3&&maxActive>1);
 const rendered=ctx.rankingSnapshotText(all);
 for(const title of ['ConcatD','ConfusionTransposeD','CtcLossV2','LayerNormV3','总分排名','官方排名','200','403'])assert(rendered.includes(title));
 assert(!rendered.includes('得分 160')); // totals must not be re-summed from task rows.
 const empty=await ctx.readOwnRankings(async path=>path.includes('/problems/contest/')?[]:path.endsWith('/stats')?[]:{},'p','empty',profile);
 assert.equal(empty.problems.length,0);
 // Regression: supplied 都对 vs platform 都队. Problem record has Player,
 // aggregate ranking has only a team object and no account name.
 async function spellingFixture(withId=true, renamed=false) {
   return ctx.readOwnRankings(async path=>{
     if(path==='/api/problems/contest/spelling')return [{_id:'sp',title:'ConcatD'}];
     if(path==='/api/contests/spelling')return {ranking_mode:'score'};
     if(path.endsWith('/stats'))return [
       ...Array.from({length:122},(_,i)=>({score:1000-i,team:{_id:'other-'+i,name:'Other '+i}})),
       {score:321,passCount:2,team:{...(withId?{_id:'real-team'}:{}),name:renamed?'平台新队名':'示例队'}},
       // A similarly spelled *different* team must not also be selected.
       {score:1,team:{_id:'decoy',name:'示例队旧名'}}
     ];
     if(new URL(path,'https://cannjudge.cn').searchParams.get('q')==='示例队旧名')return {rows:[],pages:1};
     return {rows:[{submission_id:'own',rank:108,score:47.8,submitter:{nickname:'Player'},
       team:{...(withId?{_id:'real-team'}:{}),team_name:'示例队'}}],pages:1};
   },'sp','spelling',profile);
 }
 for(const [withId,renamed] of [[true,false],[true,true],[false,false]]) {
   const fixed=await spellingFixture(withId,renamed);
   assert.equal(fixed.totalScore.length,1);assert.equal(fixed.totalScore[0].rank,123);
   assert.equal(fixed.totalScore[0].score,321); // Synthetic fixture, not a claimed live score.
   assert.equal(fixed.resolvedTeams[0].name,'示例队');
   assert(fixed.warnings.some(w=>w.includes('实际队伍')));
 }
 assert(!ctx.ownRank({team:{_id:'wrong',name:'示例队'}},
   {...profile,resolvedTeams:[{id:'real-team',name:'示例队'}]}));
 // Closing the panel removes future polling, including late request completion.
 let timerCount=0,cleared=0;
 const elements=[];
 ctx.document={createElement(){const e={style:{},append(){}};elements.push(e);return e;}};
 ctx.setTimeout=()=>++timerCount;ctx.clearTimeout=()=>cleared++;
 let resolve;const blocked=new Promise(r=>resolve=r);
 const panel=ctx.mountRanking({append(){}},async()=>blocked,'pid',null,profile);
 panel.stop();resolve({rows:[],pages:1});
 await new Promise(r=>setImmediate(r));
 assert.equal(timerCount,0);assert(cleared>0);
 console.log('PASS: typo team name / account-to-team ID resolution / renamed team / missing ID fallback / wrong-ID exclusion; all-problem coverage including empty/error, three-worker bound, score total vs official solved rank, display/export completeness; exact account/team match, overall rank vs search position, pagination, deduplication, score/num tie rules, frozen/errors, close cancels polling');
})().catch(e=>{console.error(e);process.exitCode=1});
