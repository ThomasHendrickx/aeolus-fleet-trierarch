from probe import *
import base64
# Separate HOME and config locations. No shared login file is opened or modified.
for case in ['missing-login','synthetic-expired-login']:
 home=ROOT/case;conf=home/'.cursor';conf.mkdir(parents=True,exist_ok=True)
 if case=='synthetic-expired-login':
  def part(x):return base64.urlsafe_b64encode(json.dumps(x).encode()).decode().rstrip('=')
  fake=part({'alg':'none'})+'.'+part({'exp':1,'sub':'synthetic-expired-fixture'})+'.synthetic'
  (conf/'auth.json').write_text(json.dumps({'accessToken':fake,'refreshToken':'synthetic-expired-refresh'}))
 c=Client(case,'configuration',env={'HOME':str(home),'CURSOR_CONFIG_DIR':str(conf),'XDG_CONFIG_HOME':str(home/'.config'),'CURSOR_DATA_DIR':str(conf),'AGENT_CLI_CREDENTIAL_STORE':'file'})
 try:
  c.init();r=c.new();c.log('observation',{'event':case,'sessionCreated':'result' in r,'credentials':'synthetic expired credential' if case=='synthetic-expired-login' else 'empty isolated home'})
  if c.sid:
   c.prompt('Reply exactly ACP_MAC_AUTH_PROBE. Do not use tools.',timeout=45)
 finally:c.close()
