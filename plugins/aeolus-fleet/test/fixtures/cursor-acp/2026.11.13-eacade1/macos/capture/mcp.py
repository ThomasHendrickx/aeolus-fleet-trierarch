from probe import *
conf=ROOT/'mcp-config';conf.mkdir(exist_ok=True)
workspace=ROOT/'mcp-workspace';(workspace/'.cursor').mkdir(parents=True,exist_ok=True)
server=pathlib.Path(__file__).with_name('mcp-sentinel.py').resolve()
def configured(marker):return {'command':'python3','args':[str(server),str(ROOT/marker)]}
(conf/'mcp.json').write_text(json.dumps({'mcpServers':{'user-sentinel':configured('user-mcp-started')}}))
(workspace/'.cursor/mcp.json').write_text(json.dumps({'mcpServers':{'project-sentinel':configured('project-mcp-started')}}))
c=Client('MCP','configuration',env={'CURSOR_CONFIG_DIR':str(conf)},cwd=workspace)
try:
 c.init();r=c.new(cwd=str(workspace),mcpServers=[{'name':'explicit-sentinel','command':'python3','args':[str(server),str(ROOT/'explicit-mcp-started')],'env':[]}]);original=r['result']['models']['currentModelId']
 c.model('composer-2.5[fast=true]');c.prompt('Use only the acp_macos_sentinel tool from explicit-sentinel once, then reply with its marker. Do not run shell commands or read files.')
 c.log('observation',{'event':'mcp-exclusion','userConfigured':True,'projectConfigured':True,'explicitStarted':(ROOT/'explicit-mcp-started').exists(),'userStarted':(ROOT/'user-mcp-started').exists(),'projectStarted':(ROOT/'project-mcp-started').exists(),'userConfiguration':'CURSOR_CONFIG_DIR/mcp.json','projectConfiguration':'workspace/.cursor/mcp.json'})
finally:
 try:c.model(original)
 finally:c.close()
