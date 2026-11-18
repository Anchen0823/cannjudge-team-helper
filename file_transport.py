"""Filesystem RPC transport, used when the site's CSP disallows loopback fetch."""
import json,re,time,threading,urllib.parse
from pathlib import Path
from bridge import dump,load,LOCK
def dispatch(queue,req):
    path=req.get("path",""); method=req.get("method")
    if method=="GET":
        p=urllib.parse.urlsplit(path)
        if p.path=="/health":
            return {"worker":queue.heartbeat,"jobs":[{k:v for k,v in load(f).items() if k!="payload"} for f in queue.paths()]}
        if p.path=="/next":
            client=urllib.parse.parse_qs(p.query).get("client",[""])[0]
            if not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}",client):raise ValueError("invalid client")
            return {"job":queue.next(client)}
    if method=="POST":
        m=re.fullmatch(r"/jobs/([0-9a-f-]{36})/(begin|receipt|result|error)",path)
        if m:return queue.update(m[1],m[2],req.get("body") or {})
    raise ValueError("unknown local operation")
class FileTransport:
    def __init__(self,queue,folder):
        self.queue=queue;self.folder=folder;self.stop=threading.Event()
        (folder/"requests").mkdir(parents=True,exist_ok=True)
        (folder/"responses").mkdir(exist_ok=True)
        dump(folder/"queue-marker.json",{"type":"cannjudge-background-queue","version":1})
    def once(self):
        for source in sorted((self.folder/"requests").glob("*.json")):
            if not re.fullmatch(r"[0-9a-f-]{36}\.json",source.name):continue
            dest=self.folder/"responses"/source.name
            if dest.exists():continue
            try:
                if source.stat().st_size>8*1024*1024:raise ValueError("request too large")
                req=load(source)
                if req.get("id")!=source.stem:raise ValueError("request ID mismatch")
            except (FileNotFoundError,json.JSONDecodeError,UnicodeDecodeError):continue
            except Exception as e:
                dump(dest,{"id":source.stem,"ok":False,"error":str(e)});continue
            try:reply={"id":source.stem,"ok":True,"data":dispatch(self.queue,req)}
            except Exception as e:reply={"id":source.stem,"ok":False,"error":str(e)}
            dump(dest,reply)
    def run(self):
        while not self.stop.is_set():
            self.once();self.stop.wait(.2)
