"""Check allow-always persistence using an isolated home and a harmless command."""
import hashlib
import json
from pathlib import Path
import tempfile

from probe import Client, MESSAGES, OUTPUT, REPLACEMENTS, save, sanitize


def snapshot(folder):
    return {str(path.relative_to(folder)): hashlib.sha256(path.read_bytes()).hexdigest() for path in folder.rglob('*.json') if path.is_file() and not path.is_symlink()}


def run_prompt(client, number, option):
    client.send({'jsonrpc': '2.0', 'id': number, 'method': 'session/prompt', 'params': {'sessionId': client.session, 'prompt': [{'type': 'text', 'text': 'Run this exact command with the shell, without substituting another tool: python3 -c "print(731924)". This is a controlled protocol probe.'}]}})
    permissions = 0
    while True:
        message = client.messages.get(timeout=180)
        if message.get('method') == 'session/request_permission':
            permissions += 1
            client.send({'jsonrpc': '2.0', 'id': message['id'], 'result': {'outcome': {'outcome': 'selected', 'optionId': option}}})
        elif message.get('id') == number and 'method' not in message:
            return permissions, message


with tempfile.TemporaryDirectory(prefix='aeolus-acp-persistence-') as folder:
    folder = Path(folder)
    REPLACEMENTS[str(folder)] = '/workspace/probe'
    home = folder / 'home'
    auth_folder = home / '.config/cursor'
    auth_folder.mkdir(parents=True)
    (auth_folder / 'auth.json').symlink_to(Path.home() / '.config/cursor/auth.json')
    client = Client('allow-always', folder, home)
    try:
        client.initialize(); client.new(folder)
        before = snapshot(home)
        permissions, response = run_prompt(client, 3, 'allow-always')
        after = snapshot(home)
        changed = [path for path, digest in after.items() if before.get(path) != digest]
        print('first permissions:', permissions, 'changed paths:', changed, flush=True)
    finally:
        client.close()
    client = Client('new-process', folder, home)
    try:
        client.initialize(); client.new(folder)
        second_permissions, response = run_prompt(client, 3, 'reject-once')
        print('new-process permissions:', second_permissions, flush=True)
        save('permission-persistence.jsonl')
        (OUTPUT / 'permission-persistence.capture.json').write_text(json.dumps(sanitize({'firstPermissions': permissions, 'newProcessPermissions': second_permissions, 'changedPaths': changed}), indent=2) + '\n')
    finally:
        client.close()
