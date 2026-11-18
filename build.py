"""Build an offline, credential-free bookmarklet for one immutable code snapshot."""
from pathlib import Path
import argparse,base64,gzip,hashlib,html,json,datetime,urllib.parse
p=argparse.ArgumentParser()
p.add_argument('--code',type=Path,required=True)
p.add_argument('--submission',default='',help='An existing submission of this same problem')
p.add_argument('--contest-reference',default='',help='An existing submission in this contest, for a new problem')
p.add_argument('--path',required=True,help='/public/contest/problem')
p.add_argument('--title',required=True)
p.add_argument('--version',required=True)
p.add_argument('--out',type=Path,required=True)
p.add_argument('--account',required=True)
p.add_argument('--team',required=True)
a=p.parse_args()
if bool(a.submission)==bool(a.contest_reference):p.error('provide exactly one of --submission or --contest-reference')
if not a.path.startswith('/public/') or any(x in a.path for x in ('?','#','..')):p.error('invalid problem path')
code=a.code.resolve()
if not code.is_dir():p.error('code directory does not exist')
if code.is_relative_to(a.out.resolve()) or a.out.resolve().is_relative_to(code):p.error('源码目录与输出目录必须分开存放')
files=[]
for f in sorted(code.rglob('*')):
    if f.is_symlink():p.error('symlinks are not allowed')
    if not f.is_file():continue
    rel=f.relative_to(code).as_posix()
    if any(x in f.relative_to(code).parts for x in ('.git','build','build_out','__pycache__')):continue
    if f.suffix.lower() not in ('.cpp','.h','.hpp','.cc','.cxx','.txt','.md','.sh','.py','.json','.cmake','.asc'):continue
    files.append({'path':rel,'content':f.read_text(encoding='utf-8-sig')})
if not files:p.error('工程目录中没有可打包的源码文件')
raw=json.dumps(files,ensure_ascii=False,separators=(',',':')).encode()
payload=dict(title=a.title,slug=a.path.rstrip('/').split('/')[-1],problemPath=a.path.rstrip('/'),version=a.version,
             profile=dict(account=a.account,team=a.team),baselineSubmission=a.submission,contestReference=a.contest_reference,created=datetime.datetime.now(datetime.timezone.utc).isoformat(),sha256=hashlib.sha256(raw).hexdigest(),files=files)
blob=base64.b64encode(gzip.compress(json.dumps(payload,ensure_ascii=False).encode(),mtime=0)).decode()
source=Path(__file__).with_name('ranking.js').read_text(encoding='utf-8-sig')+'\n'+Path(__file__).with_name('helper.js').read_text(encoding='utf-8-sig')
# Source is trusted local helper code; only JSON data is decompressed, never eval.
script='(async()=>{'+source+'\nconst bytes=Uint8Array.from(atob('+json.dumps(blob)+'),c=>c.charCodeAt(0));const data=JSON.parse(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text());await startHelper(data);})().catch(e=>alert(e.message));void 0;'
url='javascript:'+urllib.parse.quote(script,safe="()!'*~")
a.out.mkdir(parents=True,exist_ok=True)
(a.out/'payload.json').write_text(json.dumps(payload,ensure_ascii=False,indent=2),encoding='utf-8')
(a.out/'submit.js').write_text(script,encoding='utf-8')
launcher='(()=>{'+source+'\nif(location.origin!=="https://cannjudge.cn"){alert("请在已登录的 CANNJudge 页面使用");return;} const input=document.createElement("input");input.type="file";input.accept=".json";input.onchange=async()=>{try{const f=input.files[0];if(!f)return;const p=JSON.parse(await f.text());validatePackage(p);await startHelper(p);}catch(e){alert(e.message);}};input.click();})();void 0;'
launcherUrl='javascript:'+urllib.parse.quote(launcher,safe="()!'*~")
rankConfig={k:payload[k] for k in ('title','baselineSubmission','profile')}
rankConfig['baselineSubmission']=a.submission or a.contest_reference
rankScript='(()=>{'+Path(__file__).with_name('ranking.js').read_text(encoding='utf-8-sig')+'\nstartRankOnly('+json.dumps(rankConfig,ensure_ascii=False)+').catch(e=>alert(e.message));})();void 0;'
rankUrl='javascript:'+urllib.parse.quote(rankScript,safe="()!'*~")
page=f"""<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>CANNJudge 队员入口</title>
<style>body{{max-width:700px;margin:8vh auto;padding:0 24px;font:17px/1.8 system-ui;color:#182533}}a{{display:inline-block;padding:5px 14px;background:#155587;color:white;border-radius:5px}}code{{overflow-wrap:anywhere}}</style>
<h1>{html.escape(a.title)} · {html.escape(a.version)}</h1>
<p>查榜账号 <strong>{html.escape(a.account)}</strong>，队伍 <strong>{html.escape(a.team)}</strong>。</p>
<ol><li>在 Chrome 按 Ctrl+Shift+B 显示书签栏，把需要的按钮拖进去。<p><a href="{html.escape(launcherUrl,quote=True)}">提交工程包</a> <a href="{html.escape(rankUrl,quote=True)}">查团队排名</a></p></li>
<li>登录 CANNJudge 并打开 <a href="https://cannjudge.cn{html.escape(payload['problemPath'],quote=True)}">本题页面</a>。</li>
<li>在题目页点击书签。查榜会直接显示逐题排名和总分。提交时选择此入口旁的 <code>payload.json</code>，核对题目和文件差异，再点提交。</li></ol>
<p>下一版工程重新打包后可继续使用同一个提交书签。更换查榜账号、队伍或赛事后重新拖入查榜书签。</p></html>"""
(a.out/'ranking-only.js').write_text(rankScript,encoding='utf-8')
(a.out/'launcher.js').write_text(launcher,encoding='utf-8')
(a.out/'提交入口.html').write_text(page,encoding='utf-8')
print('Generated',len(files),'files; bookmarklet',len(url),'characters; SHA256',payload['sha256'])
print(a.out.resolve()/'提交入口.html')
