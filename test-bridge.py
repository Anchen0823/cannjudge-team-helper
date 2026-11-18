from pathlib import Path
import tempfile,unittest,hashlib,json,threading,urllib.request,urllib.error
from bridge import Queue,handler,ThreadingHTTPServer,ORIGIN,validate
from file_transport import FileTransport
import uuid
from unittest.mock import patch
def package():
 files=[{'path':'op_kernel/a.cpp','content':'// test\n'}]
 return dict(slug='layernormv3',problemPath='/public/ictcompetition/layernormv3',files=files,sha256=hashlib.sha256(json.dumps(files,ensure_ascii=False,separators=(',',':')).encode()).hexdigest())
class TestQueue(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.q=Queue(Path(self.temp.name))
 def tearDown(self):self.temp.cleanup()
 def test_explicit_restore_requires_pass_and_blocks_duplicate(self):
  p=package();jid=self.q.enqueue(p)
  restore=dict(p,resubmitOf=jid)
  with self.assertRaises(ValueError):self.q.enqueue(restore)
  self.q.next('w');self.q.update(jid,'begin',{'client':'w'})
  self.q.update(jid,'receipt',{'submissionId':'restore-source'})
  self.q.update(jid,'result',{'submissionId':'restore-source','terminal':True,'result':{'status':'Pass'}})
  with self.assertRaises(ValueError):self.q.enqueue(p)
  restored=self.q.enqueue(restore)
  self.assertNotEqual(restored,jid)
  with self.assertRaises(ValueError):self.q.enqueue(restore)
  invalid=dict(restore,resubmitOf='unknown')
  with self.assertRaises(ValueError):self.q.enqueue(invalid)
 def test_duplicate_and_binding(self):
  p=package();self.q.enqueue(p)
  with self.assertRaises(ValueError):self.q.enqueue(p)
  p['slug']='unrelated'
  with self.assertRaises(ValueError):validate(p)
 def test_once_only_across_restart_and_receipt_resume(self):
  jid=self.q.enqueue(package());j=self.q.next('worker-a');self.assertEqual(j['id'],jid)
  self.assertIsNone(self.q.next('worker-b'))
  self.q.update(jid,'begin',{'client':'worker-a'})
  with self.assertRaises(ValueError):self.q.update(jid,'begin',{'client':'worker-a'})
  restarted=Queue(self.q.root);self.assertIsNone(restarted.next('worker-b'))
  restarted.update(jid,'error',{'error':'response lost'})
  self.assertEqual(restarted.get(jid)['state'],'uncertain')
  self.assertIsNone(restarted.next('worker-a'))
  restarted.update(jid,'receipt',{'submissionId':'remote-id'})
  self.assertEqual(restarted.next('worker-b')['submissionId'],'remote-id')
  restarted.update(jid,'result',{'submissionId':'remote-id','terminal':True,'result':{'status':'Pass'}})
  self.assertIsNone(restarted.next('worker-b'))
 def test_http_auth_cors_and_enqueue(self):
  server=ThreadingHTTPServer(('127.0.0.1',0),handler(self.q,'test-secret'))
  thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
  url='http://127.0.0.1:'+str(server.server_port)
  def req(path,auth=True,origin=None,host=None,data=None):
   headers={'Authorization':'Bearer test-secret'} if auth else {}
   if origin:headers['Origin']=origin
   if host:headers['Host']=host
   if data is not None:headers['Content-Type']='application/json'
   return urllib.request.urlopen(urllib.request.Request(url+path,headers=headers,data=None if data is None else json.dumps(data).encode()),timeout=3)
  try:
   for args in [dict(auth=False),dict(origin='https://evil.example'),dict(host='evil.example')]:
    with self.assertRaises(urllib.error.HTTPError) as e:req('/health',**args)
    self.assertEqual(e.exception.code,403)
   with req('/health',origin=ORIGIN) as r:self.assertEqual(r.headers['Access-Control-Allow-Origin'],ORIGIN)
   with req('/enqueue',data=package()) as r:jid=json.load(r)['id']
   with req('/next?client=test') as r:self.assertEqual(json.load(r)['job']['id'],jid)
  finally:server.shutdown();server.server_close();thread.join()
 def test_pipeline_preserves_cooldown_and_refreshes_receipts(self):
  with patch('bridge.time.time',return_value=1000):
   first=self.q.enqueue(package());self.q.next('w')
   self.q.update(first,'begin',{'client':'w'})
   self.q.update(first,'receipt',{'submissionId':'first-remote'})
   p=package();p['slug']='prelugradupdate';p['problemPath']='/public/ictcompetition/prelugradupdate'
   p['files'][0]['content']='// second\n'
   p['sha256']=hashlib.sha256(json.dumps(p['files'],ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
   second=self.q.enqueue(p)
  with patch('bridge.time.time',return_value=1184):
   self.assertEqual(self.q.next('w')['id'],first)
  with patch('bridge.time.time',return_value=1186):
   self.assertEqual(self.q.next('w')['id'],first)
   self.q.update(first,'result',{'submissionId':'first-remote','terminal':False,'result':{'status':'Running'}})
   self.assertEqual(self.q.next('w')['id'],second)
   self.q.update(second,'begin',{'client':'w'})
   self.q.update(second,'receipt',{'submissionId':'second-remote'})
  with patch('bridge.time.time',return_value=1190):
   polled=self.q.next('w')['id']
   self.assertIn(polled,(first,second))
   self.q.update(polled,'result',{'submissionId':self.q.get(polled)['submissionId'],'terminal':False,'result':{'status':'Running'}})
   self.assertEqual(self.q.next('w')['id'],second if polled==first else first)
 def test_explicit_rate_rejection_waits_and_survives_restart(self):
  with patch('bridge.time.time',return_value=1000):
   jid=self.q.enqueue(package());self.q.next('w');self.q.update(jid,'begin',{'client':'w'})
   self.q.update(jid,'error',{'error':'HTTP 429 提交过于频繁，请在 102 秒后再提交'})
   self.assertEqual(self.q.get(jid)['state'],'queued')
  q=Queue(self.q.root)
  with patch('bridge.time.time',return_value=1106):self.assertIsNone(q.next('w'))
  with patch('bridge.time.time',return_value=1108):self.assertEqual(q.next('w')['id'],jid)
 def test_file_transport_once_only_and_partial_write(self):
  folder=self.q.root/'exchange';fs=FileTransport(self.q,folder)
  jid=self.q.enqueue(package())
  def rpc(path,method='GET',body=None):
   rid=str(uuid.uuid4());p=folder/'requests'/(rid+'.json')
   p.write_text('',encoding='utf-8');fs.once()
   self.assertFalse((folder/'responses'/p.name).exists())
   p.write_text(json.dumps({'id':rid,'path':path,'method':method,'body':body}),encoding='utf-8')
   fs.once();reply=json.loads((folder/'responses'/p.name).read_text())
   fs.once();self.assertEqual(reply,json.loads((folder/'responses'/p.name).read_text()))
   return reply
  self.assertEqual(rpc('/next?client=file-worker')['data']['job']['id'],jid)
  self.assertTrue(rpc('/jobs/'+jid+'/begin','POST',{'client':'file-worker'})['ok'])
  self.assertFalse(rpc('/jobs/'+jid+'/begin','POST',{'client':'file-worker'})['ok'])
  self.assertIsNone(rpc('/next?client=another')['data']['job'])
  self.assertTrue(rpc('/jobs/'+jid+'/receipt','POST',{'submissionId':'file-result'})['ok'])
  self.assertEqual(rpc('/next?client=another')['data']['job']['submissionId'],'file-result')
  self.assertFalse(rpc('/../../secrets')['ok'])
if __name__=='__main__':unittest.main()
