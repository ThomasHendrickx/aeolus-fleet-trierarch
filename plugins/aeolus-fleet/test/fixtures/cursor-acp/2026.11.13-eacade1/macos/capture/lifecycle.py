from probe import *
import signal
c=Client('A','lifecycle',option='allow-once')
try:
 c.init();r=c.new(modelId='gpt-5.4-mini[reasoning=medium]');original=r['result']['models']['currentModelId']
 c.log('observation',{'event':'session-new-model','requested':'gpt-5.4-mini[reasoning=medium]','actual':original})
 c.model('composer-2.5[fast=true]');c.prompt('Reply exactly ACP_MAC_FIRST_TURN. Do not use tools.')
 c.prompt('Reply exactly ACP_MAC_SECOND_TURN. Do not use tools.')
 c.prompt('Use only the shell tool to execute exactly: python3 -c "import sys; print(\'ACP_MAC_TOOL_FAILED\'); sys.exit(7)". Report the result and stop. Do not read any files.')
 c.request('session/prompt',{'sessionId':str(uuid.uuid4()),'prompt':[{'type':'text','text':'Reply ACP_MAC_MISSING_SESSION'}]})
 rss=int(subprocess.check_output(['ps','-o','rss=','-p',str(c.p.pid)],text=True).strip());c.log('observation',{'event':'idle-rss','kilobytes':rss,'scope':'agent acp PID, excludes children','after':'two completed turns and failing shell'})
 sid=c.sid
 c.close()
 c=Client('A-resumed','lifecycle');c.init();c.request('session/load',{'sessionId':sid,'cwd':str(ROOT),'mcpServers':[]});c.sid=sid
 c.prompt('Reply exactly ACP_MAC_RESUMED. Do not use tools.')
 c.request('session/load',{'sessionId':str(uuid.uuid4()),'cwd':str(ROOT),'mcpServers':[]})
finally:
 try:c.model(original)
 finally:c.close()
# Kill only this probe-owned process. The tool is kept pending, so it cannot start a child.
c=Client('killed','lifecycle',hold=2100)
try:
 c.init();c.new();c.model('composer-2.5[fast=true]');sid=c.sid
 done=queue.Queue()
 def prompt():
  try:done.put(c.prompt('Use the shell tool to execute exactly: python3 -c "print(\'ACP_MAC_KILL_PENDING\')". Do not use other tools.',timeout=45))
  except TimeoutError:pass
 threading.Thread(target=prompt,daemon=True).start()
 c.permissions.get(timeout=45)
 c.log('observation',{'event':'signal','signal':'SIGKILL','target':'owned agent acp PID','while':'session/prompt open and permission pending'})
 c.p.kill();c.p.wait(timeout=10)
finally:c.close()
c=Client('after-kill','lifecycle')
try:
 c.init();c.request('session/load',{'sessionId':sid,'cwd':str(ROOT),'mcpServers':[]});c.sid=sid;c.model('composer-2.5[fast=true]');c.prompt('The previous turn was interrupted. Reply exactly ACP_MAC_AFTER_KILL. Do not run any tools.')
finally:
 try:c.model(original)
 finally:c.close()
