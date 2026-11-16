"""Capture absent login, refused load, and crash recovery without reading credentials."""
from pathlib import Path
import tempfile

from probe import Client, MESSAGES, REPLACEMENTS, save

with tempfile.TemporaryDirectory(prefix='aeolus-acp-boundaries-') as folder:
    folder = Path(folder)
    REPLACEMENTS[str(folder)] = '/workspace/probe'
    home = folder / 'empty-home'
    home.mkdir()
    client = Client('no-login', folder, home)
    try:
        client.initialize()
        response = client.call(2, 'session/new', {'cwd': str(folder), 'mcpServers': []})
        print('no-login:', response.get('error', {}).get('code'))
        save('no-login.jsonl')
    finally:
        client.close()
    MESSAGES.clear()
    client = Client('missing', folder)
    try:
        client.initialize()
        response = client.call(2, 'session/load', {'sessionId': '00000000-0000-4000-8000-000000000001', 'cwd': str(folder), 'mcpServers': []})
        print('missing-session:', response.get('error', {}).get('code'))
        save('missing-session.jsonl')
    finally:
        client.close()
    MESSAGES.clear()
    client = Client('killed', folder)
    try:
        client.initialize()
        client.new(folder)
        session = client.session
        client.send({'jsonrpc': '2.0', 'id': 3, 'method': 'session/prompt', 'params': {'sessionId': session, 'prompt': [{'type': 'text', 'text': 'Think carefully about the integers from one to one thousand and explain their mathematical properties. Do not use tools.'}]}})
        # An agent update proves the request has reached the session before killing.
        while True:
            message = client.messages.get(timeout=120)
            if message.get('method') == 'session/update' and message['params']['update']['sessionUpdate'].startswith('agent_'):
                break
        client.process.kill()
        client.process.wait(timeout=10)
    finally:
        client.close()
    client = Client('restart', folder)
    try:
        client.initialize()
        response = client.call(2, 'session/load', {'sessionId': session, 'cwd': str(folder), 'mcpServers': []})
        print('killed-turn load:', 'result' in response)
        save('killed-turn.jsonl')
    finally:
        client.close()
