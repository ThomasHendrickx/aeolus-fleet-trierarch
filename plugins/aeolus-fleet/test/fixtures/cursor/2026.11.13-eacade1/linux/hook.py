import json,sys,pathlib
root=pathlib.Path('/tmp/cursor-s7-linux')
event=sys.argv[1]
data=json.load(sys.stdin)
out={}
if event=='sessionStart': out={'additional_context':'S7_START_CONTEXT_73: Include this exact marker in your final answer.','continue':True}
if event=='preToolUse': out={'permission':'deny','user_message':'S7_DENIAL_83: Tool denied for a hand-over. Include this exact marker in your answer.','agent_message':'S7_DENIAL_83: Tool denied for a hand-over. Include this exact marker in your answer.'}
if event=='postToolUse': out={'additional_context':'S7_REPORT_REMINDER_93: Include this exact marker in your answer.'}
if event=='stop' and not (root/'followed').exists():
 (root/'followed').touch()
 out={'followup_message':'S7_FOLLOWUP_43: This is the hand-over. Do not use tools. Reply with this exact marker.'}
with (root/'hooks.jsonl').open('a') as f: f.write(json.dumps({'event':event,'input':data,'output':out})+'\n')
print(json.dumps(out))
