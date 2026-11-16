from probe import *
c=Client('cancel','lifecycle',hold=2100)
try:
 c.init();r=c.new();original=r['result']['models']['currentModelId'];c.model('composer-2.5[fast=true]')
 result=queue.Queue()
 def run():
  try:result.put(c.prompt('Use the shell tool to run exactly: python3 -c "print(\'ACP_MAC_CANCELLED\')". Do not use other tools.',timeout=60))
  except TimeoutError:pass
 threading.Thread(target=run,daemon=True).start();c.permissions.get(timeout=40)
 c.send({'jsonrpc':'2.0','method':'session/cancel','params':{'sessionId':c.sid}})
 r=result.get(timeout=15);c.log('observation',{'event':'cancel-result','result':r.get('result')})
 c.prompt('The last turn was cancelled. Reply exactly ACP_MAC_AFTER_CANCEL. Use no tools.')
finally:
 try:c.model(original)
 finally:c.close()
