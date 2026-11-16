from probe import *
import hashlib
conf=ROOT/'permission-config';conf.mkdir(exist_ok=True)
workspace=ROOT/'permission-workspace';workspace.mkdir(exist_ok=True)
env={'CURSOR_CONFIG_DIR':str(conf),'CURSOR_DATA_DIR':str(conf/'data')}
command='Use only the shell tool to execute exactly: python3 -c "print(\'ACP_MAC_ALLOW_ALWAYS\')". Then finish. Do not read files or use other tools.'
c=Client('allow-always','configuration',env=env,cwd=workspace,option='allow-always')
def prompt(label):
 n=c.permissions.qsize();c.prompt(command);c.log('observation',{'event':'allow-always-permissions','stage':label,'permissionCount':c.permissions.qsize()-n})
try:
 c.init();c.new(cwd=str(workspace));c.model('composer-2.5[fast=true]');prompt('first-prompt');prompt('same-session');c.new(cwd=str(workspace));c.model('composer-2.5[fast=true]');prompt('new-session-same-process')
 c.log('observation',{'event':'allow-always-files','files':[{'path':str(p.relative_to(conf)),'settings':({'permissions':json.loads(p.read_text())['permissions']} if p.name in ['cli-config.json','cli.json','permissions.json'] else json.loads(p.read_text()))} for p in conf.rglob('*.json') if p.name in ['cli-config.json','cli.json','permissions.json','acp-config.json']]})
finally:c.close()
c=Client('allow-always-restarted','configuration',env=env,cwd=workspace)
try:
 c.init();c.new(cwd=str(workspace));c.model('composer-2.5[fast=true]');prompt('new-process')
finally:c.close()
# A new workspace with no trust configuration, initialized solely through ACP.
workspace=ROOT/'untrusted-workspace';workspace.mkdir(exist_ok=True);(workspace/'marker.txt').write_text('ACP_MAC_TRUST_MARKER\n')
conf=ROOT/'trust-config';conf.mkdir(exist_ok=True)
c=Client('workspace-trust','configuration',env={'CURSOR_CONFIG_DIR':str(conf),'CURSOR_DATA_DIR':str(conf/'data')},cwd=workspace,option='allow-once')
try:
 c.init();c.new(cwd=str(workspace));c.model('composer-2.5[fast=true]');c.prompt('Read marker.txt in this workspace using the file read tool, then reply with its contents. Do not run shell commands or modify files.');c.log('observation',{'event':'workspace-trust','configuration':'empty isolated CURSOR_CONFIG_DIR','workspace':'fresh directory with marker.txt, no git or Cursor config','result':'see read tool wire events; no client trust method implemented'})
finally:c.close()
# A shell that exceeds its requested foreground timeout, then completes in background.
c=Client('background-shell','configuration',env=env,cwd=workspace,option='allow-once')
try:
 c.init();c.new(cwd=str(workspace));c.model('composer-2.5[fast=true]');c.prompt('Run exactly this shell command with a 1000 millisecond foreground timeout: python3 -c "import time; print(\'ACP_MAC_BACKGROUND_START\', flush=True); time.sleep(25); print(\'ACP_MAC_BACKGROUND_END\', flush=True)". If it runs in background, wait for completion, then reply with the final output. Do not run other commands or read files.',timeout=120)
 c.log('observation',{'event':'background-shell-completed'})
finally:c.close()
