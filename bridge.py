"""Loopback-only queue for CANNJudge's same-origin browser worker.
No CANNJudge cookies, tokens or passwords leave the browser.
"""
from pathlib import Path
from datetime import datetime, timedelta, timezone
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import argparse, hashlib, hmac, html, json, os, re, secrets, threading, time, urllib.parse, urllib.request, uuid

ROOT = Path(__file__).resolve().parent
STATE = ROOT / "runtime"
ALLOWED = {"concatd", "confusiontransposed", "ctclossv2", "layernormv3", "multilabelmarginloss", "padv3grad", "prelugradupdate", "quantupdatescatter", "stridedslicegrad", "syncbatchnormgatherstats"}
ORIGIN = "https://cannjudge.cn"
LOCK = threading.RLock()

def dump(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)

def load(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))

def validate(p):
    slug = p.get("slug")
    if slug not in ALLOWED or p.get("problemPath") != "/public/ictcompetition/" + slug:
        raise ValueError("只允许决赛十题")
    files = p.get("files")
    if not isinstance(files, list) or not 0 < len(files) <= 1000:
        raise ValueError("无效文件列表")
    seen = set()
    for f in files:
        path = f.get("path", "")
        if not isinstance(f.get("content"), str) or not isinstance(path, str) or not path or path.startswith("/") or "\\" in path or any(v in ("", ".", "..") for v in path.split("/")) or path in seen:
            raise ValueError("文件路径无效或重复")
        seen.add(path)
    raw = json.dumps(files, ensure_ascii=False, separators=(",", ":")).encode()
    if not hmac.compare_digest(hashlib.sha256(raw).hexdigest(), p.get("sha256", "")):
        raise ValueError("工程包 SHA256 不匹配")
    return p

class Queue:
    def __init__(self, root):
        self.root = root
        self.jobs = root / "jobs"
        self.jobs.mkdir(parents=True, exist_ok=True)
        self.heartbeat = None

    def paths(self):
        return sorted(self.jobs.glob("*.json"))

    def enqueue(self, payload):
        validate(payload)
        with LOCK:
            previous_jobs = [load(path) for path in self.paths()]
            restore_id = payload.get("resubmitOf")
            if restore_id:
                source = next((job for job in previous_jobs if job["id"] == restore_id), None)
                if (source is None or source["state"] != "done"
                        or (source.get("result") or {}).get("status") != "Pass"
                        or source["payload"]["sha256"] != payload["sha256"]):
                    raise ValueError("恢复提交必须引用同一源码的已通过任务")
            for old in previous_jobs:
                if old["payload"]["sha256"] == payload["sha256"] and old["state"] not in ("cancelled", "error"):
                    if restore_id and old["state"] == "done":
                        continue
                    raise ValueError("相同版本已有任务 " + old["id"] + "；不重复提交")
            job = dict(id=str(uuid.uuid4()), state="queued", created=time.time(), payload=payload)
            dump(self.jobs / (job["id"] + ".json"), job)
            return job["id"]

    def get(self, jid):
        if not re.fullmatch(r"[0-9a-f-]{36}", jid):
            raise ValueError("无效任务 ID")
        return load(self.jobs / (jid + ".json"))

    def next(self, client):
        with LOCK:
            self.heartbeat = dict(at=time.time(), client=client)
            jobs = sorted((load(p) for p in self.paths()), key=lambda j: j['created'])
            # A possible POST is never repeated, including after a worker restart.
            for j in jobs:
                if j["state"] in ("claimed", "posting", "uncertain"):
                    if j.get("client") == client and j["state"] == "claimed":
                        return j
                    return None
            submitted = sorted((j for j in jobs if j["state"] == "submitted"),
                               key=lambda j: j.get("updated", j["created"]))
            cooling = time.time() < max((j.get("nextSubmitAfter", 0) for j in jobs), default=0)
            # Poll the least recently refreshed receipt first. Once all running
            # jobs are fresh, a new job may post after the same durable cooldown.
            if submitted and (cooling or time.time() - submitted[0].get("updated", 0) >= 30
                              or not any(j["state"] == "queued" for j in jobs)):
                return submitted[0]  # GET-only; never repeats a remote POST.
            # Observed website cooldown is three minutes. Persist the gate
            # across daemon restarts; read-only polling above remains available.
            if cooling:
                return None
            for j in jobs:
                if j["state"] == "queued":
                    j.update(state="claimed", client=client, updated=time.time())
                    dump(self.jobs / (j["id"] + ".json"), j)
                    return j
            return None

    def update(self, jid, action, body):
        with LOCK:
            j = self.get(jid)
            state = j["state"]
            if action == "begin":
                if state != "claimed" or body.get("client") != j.get("client"):
                    raise ValueError("任务不可开始；可能已经发送")
                j["state"] = "posting"
                j["nextSubmitAfter"] = time.time() + 185
            elif action == "receipt":
                sid = str(body.get("submissionId", ""))
                if not re.fullmatch(r"[a-zA-Z0-9_-]+", sid) or state not in ("posting", "uncertain", "submitted"):
                    raise ValueError("无效提交回执")
                if j.get("submissionId") and j["submissionId"] != sid:
                    raise ValueError("回执冲突")
                j.update(state="submitted", submissionId=sid, problemId=body.get("problemId"), contestId=body.get("contestId"))
            elif action == "result":
                if state not in ("submitted", "done"):
                    raise ValueError("未取得提交回执")
                if body.get("submissionId") != j.get("submissionId"):
                    raise ValueError("结果 ID 不匹配")
                j["result"] = body.get("result")
                if body.get("terminal"):
                    j["state"] = "done"
                if body.get("rankings") is not None:
                    j["rankings"] = body["rankings"]
            elif action == "error":
                j["error"] = str(body.get("error", ""))[:20000]
                if state == "claimed":
                    j["state"] = "error"
                elif state == "posting":
                    retry = re.fullmatch(r"HTTP 429 提交过于频繁，请在 (\d+) 秒后再提交", j["error"])
                    daily_limit = re.fullmatch(r"HTTP 429 当前账号今日提交次数已达上限（\d+次），请于北京时间 (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) 后再提交", j["error"])
                    if retry:
                        # Explicit rejection, unlike a timeout/lost response:
                        # the platform confirms that no submission was accepted.
                        j["state"] = "queued"
                        j["nextSubmitAfter"] = time.time() + int(retry[1]) + 5
                    elif daily_limit:
                        resume_at = datetime.strptime(daily_limit[1], "%Y-%m-%d %H:%M").replace(
                            tzinfo=timezone(timedelta(hours=8))).timestamp()
                        j["state"] = "queued"
                        j["nextSubmitAfter"] = max(time.time() + 185, resume_at + 5)
                    else:
                        j["state"] = "uncertain"
                # A submitted job stays resumable by read-only polling.
            else:
                raise ValueError("未知操作")
            j["updated"] = time.time()
            dump(self.jobs / (jid + ".json"), j)
            return {"state": j["state"]}

def handler(queue, token):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass
        def respond(self, code, obj):
            data = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            if self.headers.get("Origin") == ORIGIN:
                self.send_header("Access-Control-Allow-Origin", ORIGIN)
                self.send_header("Vary", "Origin")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
        def authorized(self):
            if self.headers.get("Host") != "127.0.0.1:" + str(self.server.server_port):
                self.respond(403, {"error": "Host rejected"}); return False
            if self.headers.get("Origin") not in (None, ORIGIN):
                self.respond(403, {"error": "Origin rejected"}); return False
            if not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + token):
                self.respond(403, {"error": "Unauthorized"}); return False
            return True
        def do_OPTIONS(self):
            if self.headers.get("Origin") != ORIGIN or self.headers.get("Host") != "127.0.0.1:" + str(self.server.server_port):
                self.respond(403, {"error": "Origin rejected"}); return
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", ORIGIN)
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.end_headers()
        def do_GET(self):
            if not self.authorized(): return
            try:
                parsed = urllib.parse.urlsplit(self.path)
                if parsed.path == "/health":
                    return self.respond(200, {"worker": queue.heartbeat, "jobs": [{k:v for k,v in load(p).items() if k != "payload"} for p in queue.paths()]})
                if parsed.path == "/next":
                    client = urllib.parse.parse_qs(parsed.query).get("client", [""])[0]
                    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", client): raise ValueError("invalid client")
                    return self.respond(200, {"job": queue.next(client)})
                self.respond(404, {"error": "Not found"})
            except (ValueError, OSError) as e: self.respond(400, {"error": str(e)})
        def do_POST(self):
            if not self.authorized(): return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0 or length > 8 * 1024 * 1024: raise ValueError("Invalid body size")
                if self.headers.get("Content-Type") != "application/json": raise ValueError("JSON required")
                body = json.loads(self.rfile.read(length))
                if self.path == '/enqueue':
                    return self.respond(200, {'id': queue.enqueue(body)})
                match = re.fullmatch(r"/jobs/([0-9a-f-]{36})/(begin|receipt|result|error)", self.path)
                if not match: return self.respond(404, {"error": "Not found"})
                self.respond(200, queue.update(match[1], match[2], body))
            except (ValueError, OSError) as e: self.respond(409, {"error": str(e)})
    return Handler

def build_entry(config):
    source = "\n".join((ROOT / f).read_text(encoding="utf-8-sig") for f in ("ranking.js", "helper.js", "background.js", "filesystem.js"))
    script = "(()=>{" + source + "\nstartFilesystemBackground().catch(e=>alert(e.message));})();void 0;"
    url = "javascript:" + urllib.parse.quote(script, safe="()!'*~")
    page = '<!doctype html><meta charset="utf-8"><title>CANNJudge 文件夹后台助手</title><style>body{font:18px/1.8 system-ui;max-width:850px;margin:60px auto}a{padding:12px;background:#5843df;color:white;border-radius:8px}code{background:#eee}</style><h1>十题后台助手 v3</h1><p>旧版连接本机 HTTP 被网站 CSP 禁止。此版通过你选定的队列目录交换文件，网站请求仍完全同源。</p><ol><li>将下方按钮拖入 Chrome 书签栏，替换旧后台书签。</li><li>刷新已登录的 CANNJudge 题目页，点击新书签。</li><li>在文件夹选择框中选择 <code>' + html.escape(str(STATE / 'exchange')) + '</code>，允许此目录的读取和写入。</li></ol><p><a href="' + html.escape(url, quote=True) + '">CANNJudge 十题后台 v3</a></p><p>之后保持标签页打开即可后台提交、回传成绩和全部题目/总分排名。不读取或导出网站凭据，不修改浏览器安全设置。</p><p>仅运行明确入队的十题版本；请求未确认时停止重发。连接后会处理本机已入队的工程。请先用 status 核对队列。</p>'
    (STATE / "后台提交入口.html").write_text(page, encoding="utf-8")
    (STATE / "background-start.js").write_text(script, encoding="utf-8")

def main():
    # The CLI only talks to its local queue, including on proxy-configured PCs.
    urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="command", required=True)
    sub.add_parser("serve")
    q = sub.add_parser("enqueue"); q.add_argument("payload", type=Path)
    s = sub.add_parser("status"); s.add_argument("--full", action="store_true")
    args = p.parse_args()
    queue = Queue(STATE)
    if args.command == "enqueue":
        payload = validate(load(args.payload))
        config = load(STATE / 'connection.json')
        req = urllib.request.Request(config['url'] + '/enqueue', data=json.dumps(payload, ensure_ascii=False).encode(), headers={'Authorization':'Bearer '+config['key'], 'Content-Type':'application/json'})
        print(urllib.request.urlopen(req, timeout=10).read().decode()); return
    if args.command == "status":
        config = load(STATE / "connection.json")
        req = urllib.request.Request(config["url"] + "/health", headers={"Authorization": "Bearer " + config["key"]})
        health=json.load(urllib.request.urlopen(req, timeout=5))
        if args.full:
            print(json.dumps(health,ensure_ascii=False)); return
        beat=health.get("worker")
        print("worker:", "not connected" if not beat else "last seen %.1fs ago" % (time.time()-beat["at"]))
        latest=None
        for job in sorted(health["jobs"],key=lambda j:j["created"]):
            payload=queue.get(job['id'])['payload'];result=job.get('result') or {}
            print(payload['title'],payload['version'],job['state'],result.get('ID',job.get('submissionId','')),result.get('status',''))
            visible=[r for r in result.get('result',[]) if r.get('testcase_status')!='Hidden']
            if visible:print('  cases:',json.dumps([{k:r[k] for k in ('testcase_status','time','best_time','precision_ratio') if k in r} for r in visible],ensure_ascii=False))
            if job.get('error'):print('  last error:',job['error'][:200])
            if job.get('nextSubmitAfter',0)>time.time():print('  cooldown:',round(job['nextSubmitAfter']-time.time()),'seconds')
            ranking=job.get('rankings')
            if ranking and ranking.get('capturedAt') and (not latest or ranking['capturedAt']>latest['capturedAt']):latest=ranking
        if latest:
            print('ranking at',latest['capturedAt'])
            print('  total:',json.dumps(latest.get('totalScore'),ensure_ascii=False))
            for problem in latest.get('problems',[]):
                print(' ',problem['title'],json.dumps(problem.get('rows'),ensure_ascii=False))
        return
    # A second server must not replace the running server's nonce or port.
    if (STATE / "connection.json").exists():
        old = load(STATE / "connection.json")
        try:
            req=urllib.request.Request(old["url"]+"/health",headers={"Authorization":"Bearer "+old["key"]})
            urllib.request.urlopen(req,timeout=2).close()
        except Exception: pass
        else: raise SystemExit("后台服务已运行，使用 status 查询")
    token = secrets.token_urlsafe(32)
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler(queue, token))
    config = {"url": "http://127.0.0.1:" + str(server.server_port), "key": token}
    dump(STATE / "connection.json", config); build_entry(config)
    print("Loopback queue listening; entry: " + str(STATE / "后台提交入口.html"), flush=True)
    from file_transport import FileTransport
    files = FileTransport(queue, STATE / 'exchange')
    thread = threading.Thread(target=files.run, daemon=True); thread.start()
    try: server.serve_forever()
    finally: files.stop.set(); thread.join(timeout=2); server.server_close()

if __name__ == "__main__": main()
