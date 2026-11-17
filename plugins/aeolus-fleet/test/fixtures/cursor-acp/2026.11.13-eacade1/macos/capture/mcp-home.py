from probe import *
home=ROOT/'mcp-private-home';conf=home/'.config/cursor';conf.mkdir(parents=True,exist_ok=True);(home/'.cursor').mkdir(exist_ok=True)
(home/'Library').mkdir(exist_ok=True)
(home/'Library/Keychains').symlink_to(pathlib.Path.home()/'Library/Keychains',target_is_directory=True)
server=pathlib.Path(__file__).with_name('mcp-sentinel.py').resolve()
def configured(marker):return {'command':'python3','args':[str(server),str(ROOT/marker)]}
(home/'.cursor/mcp.json').write_text(json.dumps({'mcpServers':{'home-sentinel':configured('home-mcp-started')}}))
(conf/'mcp.json').write_text(json.dumps({'mcpServers':{'xdg-sentinel':configured('xdg-mcp-started')}}))
workspace=ROOT/'mcp-home-workspace';(workspace/'.cursor').mkdir(parents=True,exist_ok=True)
(workspace/'.cursor/mcp.json').write_text(json.dumps({'mcpServers':{'project-home-sentinel':configured('project-home-mcp-started')}}))
c=Client('MCP-home','configuration',env={'HOME':str(home),'XDG_CONFIG_HOME':str(home/'.config'),'CURSOR_CONFIG_DIR':str(conf),'CURSOR_DATA_DIR':str(home/'.cursor')},cwd=workspace)
def observe(stage):c.log('observation',{'event':'mcp-default-home','stage':stage,'homeStarted':(ROOT/'home-mcp-started').exists(),'xdgStarted':(ROOT/'xdg-mcp-started').exists(),'projectStarted':(ROOT/'project-home-mcp-started').exists()})
try:
 observe('before-initialize');c.init();time.sleep(2);observe('after-initialize');r=c.new(cwd=str(workspace),mcpServers=[]);time.sleep(3);observe('after-session-new')
 if c.sid:
  c.model('composer-2.5[fast=true]');c.prompt('Reply exactly ACP_MAC_EMPTY_MCP. Do not use tools.');observe('after-prompt')
finally:c.close()
