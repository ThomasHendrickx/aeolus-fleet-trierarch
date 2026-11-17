import json, pathlib, re, sys
root = pathlib.Path(__file__).resolve().parent.parent
payload = json.load(sys.stdin)
event = payload.get('hook_event_name', sys.argv[1])
output = {}
if event == 'sessionStart':
    output = {'additional_context': 'S7_MAC_START_CONTEXT: reply with this marker when asked.'}
if event == 'stop':
    output = {'followup_message': 'S7_MAC_STOP_FOLLOWUP: reply exactly with this marker and call no tools.'} if payload.get('loop_count', 0) == 0 else {}
def sanitize(value):
    if isinstance(value, dict): return {k: ('<EMAIL>' if k == 'user_email' else sanitize(v)) for k,v in value.items()}
    if isinstance(value, list): return [sanitize(v) for v in value]
    if isinstance(value, str):
        value = value.replace(str(root), '<WORKSPACE>')
        return re.sub(r'/Users/[^/\s"\']+', '<HOME>', value)
    return value
with (root / 'hooks.jsonl').open('a') as f:
    f.write(json.dumps({'event':event, 'input':sanitize(payload), 'output':output, 'exitStatus':0})+'\n')
print(json.dumps(output))
