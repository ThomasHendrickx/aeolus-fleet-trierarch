import json,sys,pathlib
root=pathlib.Path(__file__).parent
event=sys.argv[1]; data=json.load(sys.stdin); mode=(root/'mode').read_text(); out={}
if event=='sessionStart':
 out={'additional_context':'S7_START_ADAPTED: Include this exact marker in your final answer.'}
 (root/'started').write_text('started')
if event=='preToolUse':
 (root/'active').write_text('active')
 if mode=='deny': out={'permission':'deny','user_message':'S7_DENIAL_ADAPTED: hand-over says report this exact marker.', 'agent_message':'S7_DENIAL_ADAPTED: hand-over says report this exact marker.'}
if event=='postToolUse': out={'additional_context':'S7_REPORT_ADAPTED: report reminder, include this exact marker in the final response.'}
with (root/'hooks.jsonl').open('a') as f: f.write(json.dumps({'event':event,'input':data,'output':out,'exitStatus':0})+'\n')
print(json.dumps(out))
