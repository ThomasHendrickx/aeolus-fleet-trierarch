import pathlib,json,subprocess,time,signal
root=pathlib.Path('/tmp/cursor-s7-linux/adapted');root.mkdir(exist_ok=True);(root/'.cursor').mkdir(exist_ok=True)
(root/'hook.py').write_text('''import json,sys,pathlib
root=pathlib.Path(__file__).parent
event=sys.argv[1]; data=json.load(sys.stdin); mode=(root/'mode').read_text(); out={}
if event=='sessionStart':
 out={'additional_context':'S7_START_ADAPTED: Include this exact marker in your final answer.'}
 (root/'started').write_text('started')
if event=='preToolUse':
 (root/'active').write_text('active')
 if mode=='deny': out={'permission':'deny','user_message':'S7_DENIAL_ADAPTED: hand-over says report this exact marker.', 'agent_message':'S7_DENIAL_ADAPTED: hand-over says report this exact marker.'}
if event=='postToolUse': out={'additional_context':'S7_REPORT_ADAPTED: report reminder, include this exact marker in the final response.'}
with (root/'hooks.jsonl').open('a') as f: f.write(json.dumps({'event':event,'input':data,'output':out,'exitStatus':0})+'\\n')
print(json.dumps(out))
''')
(root/'.cursor/hooks.json').write_text(json.dumps({'version':1,'hooks':{e:[{'command':f'python3 {root}/hook.py {e}'}] for e in ['sessionStart','preToolUse','postToolUse','sessionEnd','stop']}}))
for mode,prompt in [('deny','Run printf S7_TOOL. Report all context markers received. Do not retry a denied tool.'),('report','Run printf S7_TOOL. Report all context markers received.'),('tool-free','Do not use tools. Reply S7_TOOL_FREE.'),('interrupt','Run sleep 60 in the shell, then report completion.')]:
 chat=None
 for turn in ['fresh','resume']:
  label=mode+'-'+turn;(root/'mode').write_text(mode);(root/'hooks.jsonl').write_text('')
  for marker in ['started','active']:
   (root/marker).unlink(missing_ok=True)
  args=['agent','-p',prompt,'--output-format','stream-json','--trust']+(['--resume',chat] if chat else [])
  if mode in ['interrupt','report']: args+=['--force']
  lifecycle=[{'state':'busy','source':'process start'}]
  with (root/(label+'.events.jsonl')).open('w') as out,(root/(label+'.stderr')).open('w') as err:
   proc=subprocess.Popen(args,cwd=root,stdout=out,stderr=err)
   if mode=='interrupt':
    deadline=time.monotonic()+45
    while proc.poll() is None and time.monotonic()<deadline:
     if 'preToolUse' in (root/'hooks.jsonl').read_text():
      time.sleep(1);proc.send_signal(signal.SIGINT);lifecycle.append({'signal':'SIGINT','target':'owned Cursor process'});break
     time.sleep(.1)
   try: status=proc.wait(timeout=90)
   except subprocess.TimeoutExpired:
    proc.kill();status=proc.wait();lifecycle.append({'signal':'SIGKILL','target':'owned Cursor process','reason':'timeout'})
  lifecycle.append({'state':'idle','source':'process exit','exitStatus':status})
  (root/(label+'.exit')).write_text(str(status)+'\n');(root/(label+'.hooks.jsonl')).write_text((root/'hooks.jsonl').read_text())
  (root/(label+'.capture.json')).write_text(json.dumps({'command':args,'build':'2026.11.13-eacade1','os':'Linux','host':'agent-host-1','lifecycle':lifecycle,'started':(root/'started').exists(),'active':(root/'active').exists()},indent=2)+'\n')
  for line in (root/(label+'.events.jsonl')).read_text().splitlines():
   d=json.loads(line)
   if d.get('session_id'):chat=d['session_id'];break
  print(label,status,[(json.loads(l)['event'],json.loads(l)['input'].get('final_status')) for l in (root/'hooks.jsonl').read_text().splitlines()],flush=True)
