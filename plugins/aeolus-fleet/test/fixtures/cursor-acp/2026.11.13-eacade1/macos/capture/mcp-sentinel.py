import sys,json,pathlib,os
marker=pathlib.Path(sys.argv[1]);marker.write_text(str(os.getpid()))
for line in sys.stdin:
 m=json.loads(line);n=m.get('method')
 if 'id' not in m:continue
 if n=='initialize':r={'protocolVersion':'2024-11-05','capabilities':{'tools':{}},'serverInfo':{'name':'acp-macos-sentinel','version':'1'}}
 elif n=='tools/list':r={'tools':[{'name':'acp_macos_sentinel','description':'Return a harmless probe marker','inputSchema':{'type':'object','properties':{}}}]}
 elif n=='tools/call':r={'content':[{'type':'text','text':'ACP_MAC_EXPLICIT_MCP'}]}
 else:r={}
 print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':r}),flush=True)
