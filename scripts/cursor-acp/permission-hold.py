"""Hold a harmless real ACP shell permission for 30 minutes, then allow once."""
import json
from pathlib import Path
import tempfile
import time

from probe import Client, MESSAGES, OUTPUT, REPLACEMENTS, save

with tempfile.TemporaryDirectory(prefix='aeolus-acp-hold-') as folder:
    folder = Path(folder)
    REPLACEMENTS[str(folder)] = '/workspace/probe'
    client = Client('permission-hold', folder)
    start = None
    elapsed = None
    try:
        client.initialize()
        client.new(folder)
        client.send({'jsonrpc': '2.0', 'id': 3, 'method': 'session/prompt', 'params': {'sessionId': client.session, 'prompt': [{'type': 'text', 'text': 'Use the shell to run exactly: python3 -c "print(731924)". Do not substitute another tool. This is a controlled protocol probe.'}]}})
        while True:
            message = client.messages.get(timeout=2400)
            if message.get('method') == 'session/request_permission':
                start = time.monotonic()
                print('Permission received; holding for 1800 seconds', flush=True)
                save('permission-hold.jsonl')
                time.sleep(1800)
                elapsed = time.monotonic() - start
                client.send({'jsonrpc': '2.0', 'id': message['id'], 'result': {'outcome': {'outcome': 'selected', 'optionId': 'allow-once'}}})
                print('Permission answered after 1800 seconds', flush=True)
            elif message.get('id') == 3 and 'method' not in message:
                print(json.dumps(message), flush=True)
                break
    finally:
        save('permission-hold.jsonl')
        (OUTPUT / 'permission-hold.capture.json').write_text(json.dumps({'heldSeconds': elapsed, 'targetSeconds': 1800}) + '\n')
        client.close()
