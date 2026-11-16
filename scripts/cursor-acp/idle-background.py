"""Measure idle ACP memory and observe a harmless background shell turn."""
import json
from pathlib import Path
import tempfile
import time

from probe import Client, MESSAGES, OUTPUT, REPLACEMENTS, save, sanitize


def rss(pid):
    for line in Path(f'/proc/{pid}/status').read_text().splitlines():
        if line.startswith('VmRSS:'):
            return int(line.split()[1])
    return 0


def process_tree(pid):
    result = [pid]
    children = Path(f'/proc/{pid}/task/{pid}/children')
    for child in children.read_text().split():
        result.extend(process_tree(int(child)))
    return result


with tempfile.TemporaryDirectory(prefix='aeolus-acp-idle-') as folder:
    folder = Path(folder)
    REPLACEMENTS[str(folder)] = '/workspace/probe'
    client = Client('idle-background', folder)
    try:
        client.initialize(); client.new(folder)
        client.call(3, 'session/prompt', {'sessionId': client.session, 'prompt': [{'type': 'text', 'text': 'Reply exactly ACP_IDLE. Do not use tools.'}]}, timeout=180)
        time.sleep(5)
        pids = process_tree(client.process.pid)
        memory = {'idleSeconds': 5, 'rootRssKiB': rss(client.process.pid), 'treeRssKiB': sum(rss(pid) for pid in pids), 'processCount': len(pids), 'measurement': 'Linux /proc VmRSS; sum includes shared pages'}
        print(json.dumps(memory), flush=True)
        (OUTPUT / 'idle-memory.capture.json').write_text(json.dumps(memory, indent=2) + '\n')
        client.send({'jsonrpc': '2.0', 'id': 4, 'method': 'session/prompt', 'params': {'sessionId': client.session, 'prompt': [{'type': 'text', 'text': 'Run exactly this shell command: sleep 12; printf ACP_BG_DONE > background.done . Use a 1000 millisecond timeout so it continues in the background, then reply ACP_BACKGROUND without waiting for it. Do not use other commands or tools.'}]}})
        started = time.monotonic()
        permissions = 0
        while True:
            message = client.messages.get(timeout=180)
            if message.get('method') == 'session/request_permission':
                permissions += 1
                client.send({'jsonrpc': '2.0', 'id': message['id'], 'result': {'outcome': {'outcome': 'selected', 'optionId': 'allow-once'}}})
            elif message.get('id') == 4 and 'method' not in message:
                elapsed = time.monotonic() - started
                print('background prompt elapsed:', round(elapsed, 3), flush=True)
                break
        marker_at_end = (folder / 'background.done').exists()
        deadline = time.monotonic() + 30
        while not (folder / 'background.done').exists() and time.monotonic() < deadline:
            time.sleep(0.2)
        marker_observed = (folder / 'background.done').exists()
        print('marker at prompt end:', marker_at_end, 'observed later:', marker_observed, flush=True)
        (OUTPUT / 'background.capture.json').write_text(json.dumps({'elapsedSeconds': elapsed, 'requestedSleepSeconds': 12, 'permissionRequests': permissions, 'markerAtPromptEnd': marker_at_end, 'markerObserved': marker_observed}, indent=2) + '\n')
        save('idle-background.jsonl')
    finally:
        client.close()
