import json, pathlib, re, sys
root = pathlib.Path(__file__).resolve().parent.parent
payload = json.load(sys.stdin)
event = sys.argv[1]
mode = (root/'mode').read_text().strip()
output = {}
markers = []
suffix = '_RESUME' if 'RESUME' in str(payload.get('tool_input', {})) else '_FRESH'
if event == 'sessionStart':
    output = {'additional_context':'S7_MAC_START_CONTEXT: Include this exact marker in your final answer.'}
    markers.append('started')
if event == 'preToolUse':
    markers.append('active')
    if mode == 'deny':
        output = {'permission':'deny','user_message':'S7_MAC_DENIAL: Tool denied for a hand-over. Include this exact marker in your final answer.','agent_message':'S7_MAC_DENIAL: Tool denied for a hand-over. Include this exact marker in your final answer.'}
        markers.append('hand-over-confirmed')
        output = {key: value.replace('S7_MAC_DENIAL', 'S7_MAC_DENIAL'+suffix) if isinstance(value,str) else value for key,value in output.items()}
    else: output = {'permission':'allow'}
if event == 'postToolUse':
    output = {'additional_context':'S7_MAC_REPORT_REMINDER'+suffix+': Include this exact report reminder marker in your final answer.'}
if event == 'sessionEnd' and payload.get('final_status') == 'completed' and mode == 'tool-free':
    markers.append('hand-over-confirmed')
for marker in markers: (root/marker).write_text(event+'\n')
def sanitize(value):
    if isinstance(value,dict): return {k:('<EMAIL>' if k=='user_email' else sanitize(v)) for k,v in value.items()}
    if isinstance(value,list): return [sanitize(v) for v in value]
    if isinstance(value,str):
        value=value.replace(str(root),'<WORKSPACE>')
        value=re.sub(r'/Users/[^/\s"\']+', '<HOME>',value)
        return value
    return value
with (root/'hooks.jsonl').open('a') as f:
    f.write(json.dumps({'event':event,'input':sanitize(payload),'output':output,'markers':markers,'exitStatus':0})+'\n')
print(json.dumps(output))
