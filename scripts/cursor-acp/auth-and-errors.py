"""Capture synthetic expired-credential refusal and an unknown-session error.

The synthetic credential is unsigned test data, never a real expired login.
Its bytes are confined to a private credential file and never enter fixtures.
"""
import base64
import json
from pathlib import Path
import tempfile

from probe import Client, MESSAGES, REPLACEMENTS, save

with tempfile.TemporaryDirectory(prefix='aeolus-acp-auth-') as folder:
    folder = Path(folder)
    REPLACEMENTS[str(folder)] = '/workspace/probe'
    home = folder / 'home'
    auth_folder = home / '.config/cursor'
    auth_folder.mkdir(parents=True)
    def encoded(value):
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip('=')
    synthetic = '.'.join([encoded({'alg': 'none', 'typ': 'JWT'}), encoded({'exp': 1, 'sub': 'acp-a1-synthetic'}), 'synthetic'])
    (auth_folder / 'auth.json').write_text(json.dumps({'accessToken': synthetic}))
    client = Client('synthetic-expired', folder, home, credential_store='file')
    try:
        client.initialize()
        response = client.call(2, 'session/new', {'cwd': str(folder), 'mcpServers': []})
        print('synthetic expired refusal code:', response.get('error', {}).get('code'), flush=True)
        save('synthetic-expired.jsonl')
    finally:
        client.close()
    MESSAGES.clear()
    client = Client('unknown-prompt', folder)
    try:
        client.initialize()
        response = client.call(2, 'session/prompt', {'sessionId': '00000000-0000-4000-8000-000000000001', 'prompt': [{'type': 'text', 'text': 'ACP_A1_UNKNOWN_SESSION'}]})
        print('unknown prompt session code:', response.get('error', {}).get('code'), flush=True)
        save('unknown-prompt-session.jsonl')
    finally:
        client.close()
