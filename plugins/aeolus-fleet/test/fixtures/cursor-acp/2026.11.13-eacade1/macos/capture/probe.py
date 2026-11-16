"""Capture ACP wire messages on macOS, sanitizing before writing any fixture."""
import json, pathlib, os, subprocess, threading, queue, time, re, sys, uuid, tempfile
CACHE=pathlib.Path.cwd()/'node_modules/.cache'
CACHE.mkdir(parents=True,exist_ok=True)
ROOT=pathlib.Path(tempfile.mkdtemp(prefix='cursor-acp-macos-',dir=CACHE))
OUT=pathlib.Path(os.environ.get('ACP_PROBE_OUTPUT',str(pathlib.Path.cwd()/'plugins/aeolus-fleet/test/fixtures/cursor-acp/2026.11.13-eacade1/macos')))
OUT.mkdir(parents=True,exist_ok=True)
START=time.monotonic()
LOCK=threading.Lock()
SESSION_MAP={}
def clean(v):
 if isinstance(v,dict):
  return {k:('[REDACTED]' if re.search(r'token|secret|password|authorization|user_email|authInfo|authId|userId|displayName',k,re.I) else clean(x)) for k,x in v.items()}
 if isinstance(v,list):return [clean(x) for x in v]
 if isinstance(v,str):
  v=v.replace(str(ROOT),'/workspace/probe').replace(str(pathlib.Path.cwd()),'/workspace/repository').replace(str(pathlib.Path.home()),'/home/probe')
  v=re.sub(r'(?:Users|home)-[^/\s"\\]+','workspace-probe',v)
  v=re.sub(r'/Users/[^/\s"\']+','/home/probe',v)
  v=re.sub(r'[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}','<email>',v,flags=re.I)
  v=re.sub(r'Bearer\s+[A-Za-z0-9._-]+','[REDACTED]',v,flags=re.I)
  v=re.sub(r'\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b',lambda m:SESSION_MAP.setdefault(m[0],'session-'+str(len(SESSION_MAP)+1)),v)
 return v
class Client:
 def __init__(self,name,trace,env=None,cwd=None,hold=0,option='reject-once'):
  self.name=name;self.trace=trace;self.n=0;self.pending={};self.permissions=queue.Queue();self.hold=hold;self.option=option;self.closed=False
  cfg={k:v for k,v in os.environ.items() if k in ['HOME','PATH','TMPDIR','SHELL']};cfg['CURSOR_AGENT_DISABLE_DEBUG_LOG']='1';cfg.update(env or {})
  self.p=subprocess.Popen(['agent','acp'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,env=cfg,cwd=cwd or ROOT)
  self.writer=threading.Lock();threading.Thread(target=self.read,daemon=True).start()
 def log(self,d,m):
  with LOCK:
   with (OUT/(self.trace+'.jsonl')).open('a') as f:f.write(json.dumps({'process':self.name,'direction':d,'elapsedMs':round((time.monotonic()-START)*1000),'message':clean(m)})+'\n')
 def send(self,m):
  self.log('sent',m)
  with self.writer:self.p.stdin.write(json.dumps(m)+'\n');self.p.stdin.flush()
 def request(self,method,params,timeout=120):
  self.n+=1;n=self.n;q=queue.Queue();self.pending[n]=q;self.send({'jsonrpc':'2.0','id':n,'method':method,'params':params})
  try:return q.get(timeout=timeout)
  except queue.Empty: self.log('observation',{'event':'request-timeout','method':method});raise TimeoutError(method)
 def read(self):
  for line in self.p.stdout:
   try:m=json.loads(line)
   except ValueError:continue
   if self.trace=='model-isolation' and isinstance(m.get('result'),dict) and m['result'].get('sessionId'):SESSION_MAP[m['result']['sessionId']]='session-'+self.name
   self.log('received',m)
   if m.get('method')=='session/request_permission':
    self.permissions.put(m);threading.Thread(target=self.answer,args=(m,),daemon=True).start()
   elif 'method' in m and 'id' in m:self.send({'jsonrpc':'2.0','id':m['id'],'error':{'code':-32601,'message':'Client method unavailable'}})
   elif 'id' in m and m['id'] in self.pending:self.pending[m['id']].put(m)
  self.log('observation',{'event':'process-exit','returncode':self.p.wait()})
 def answer(self,m):
  if self.hold:
   self.log('observation',{'event':'permission-hold-started','seconds':self.hold});print('permission hold started',flush=True);time.sleep(self.hold)
  self.send({'jsonrpc':'2.0','id':m['id'],'result':{'outcome':{'outcome':'selected','optionId':self.option}}})
 def init(self):return self.request('initialize',{'protocolVersion':1,'clientCapabilities':{},'clientInfo':{'name':'aeolus-acp-probe','version':'1'}})
 def new(self,**extra):
  r=self.request('session/new',{'cwd':str(ROOT),'mcpServers':[],**extra});self.sid=r.get('result',{}).get('sessionId');return r
 def model(self,m):return self.request('session/set_model',{'sessionId':self.sid,'modelId':m})
 def mode(self,m='ask'):return self.request('session/set_config_option',{'sessionId':self.sid,'configId':'mode','value':m})
 def prompt(self,text,timeout=120):return self.request('session/prompt',{'sessionId':self.sid,'prompt':[{'type':'text','text':text}]},timeout)
 def close(self):
  if self.p.poll() is None:self.p.terminate();self.p.wait(timeout=10)
def main():
 mode=sys.argv[1]
 if mode=='hold':
  c=Client('A','permission-hold',hold=1801)
  try:
   c.init();r=c.new();original=r['result']['models']['currentModelId'];c.model('composer-2.5[fast=true]')
   c.prompt('This is an ACP permission test in a disposable workspace. Use the shell tool to run exactly: python3 -c "print(\'ACP_MAC_HELD_PERMISSION\')". Do not read any files or use other tools. If permission is rejected, simply say denied and finish.',timeout=2100)
   c.log('observation',{'event':'permission-hold-completed'})
  finally:
   try:c.model(original)
   finally:c.close()
 elif mode=='models':
  a=Client('A','model-isolation');b=Client('B','model-isolation')
  try:
   a.init();b.init();ar=a.new();b.new();original=ar['result']['models']['currentModelId'];a.model('default[]');b.model('gpt-5.4-mini[reasoning=medium]')
   before=b.mode();a.model('composer-2.5[fast=true]');a.mode();after=b.mode();b.prompt('Reply with exactly ACP_MAC_MODEL_ISOLATION. Use no tools.');final=b.mode()
   get=lambda r:next(x['currentValue'] for x in r['result']['configOptions'] if x['id']=='model')
   a.log('observation',{'event':'live-model-isolation','status':'proven' if get(before)==get(after)==get(final) else 'failed','before':get(before),'after':get(after),'afterPrompt':get(final),'modelA':'composer-2.5[fast=true]'})
  finally:
   try:a.model(original)
   finally:a.close();b.close()
if __name__=='__main__':main()
