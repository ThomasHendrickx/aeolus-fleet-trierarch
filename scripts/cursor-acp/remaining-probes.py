"""Explore the remaining A1 boundaries in private folders with harmless inputs."""
import json
from pathlib import Path
import tempfile
import time

from probe import Client, MESSAGES, OUTPUT, REPLACEMENTS, save


def prompt(client, number, content):
    return client.call(number, 'session/prompt', {'sessionId': client.session, 'prompt': content}, timeout=180)


def text(value):
    return [{'type': 'text', 'text': value}]


with tempfile.TemporaryDirectory(prefix='aeolus-acp-remaining-') as folder:
    folder = Path(folder)
    REPLACEMENTS[str(folder)] = '/workspace/probe'
    client = Client('new-model', folder)
    try:
        client.initialize()
        response = client.new(folder, modelId='gpt-5.4-mini[reasoning=medium]')
        print('session/new modelId result:', response['result']['models']['currentModelId'], flush=True)
        save('new-model.jsonl')
    finally:
        client.close()
    MESSAGES.clear()
    client = Client('failed-turn', folder)
    try:
        client.initialize(); client.new(folder)
        result = prompt(client, 3, [{'type': 'text', 'text': 'Describe this image.'}, {'type': 'image', 'mimeType': 'image/png', 'data': 'bm90LWFuLWltYWdl'}])
        print('failed image turn:', json.dumps(result), flush=True)
        save('failed-turn.jsonl')
    finally:
        client.close()
    MESSAGES.clear()
    # A private home uses the machine's login via a link, without reading it.
    # Neither the shared auth nor shared Cursor configuration is changed.
    home = folder / 'mcp-home'
    auth_folder = home / '.config/cursor'
    auth_folder.mkdir(parents=True)
    (auth_folder / 'auth.json').symlink_to(Path.home() / '.config/cursor/auth.json')
    cursor_folder = home / '.cursor'
    cursor_folder.mkdir()
    sentinel = folder / 'sentinel.py'
    sentinel.write_text('from pathlib import Path\nPath(__file__).with_suffix(".started").touch()\n')
    config = {'mcpServers': {'a1-user-sentinel': {'command': 'python3', 'args': [str(sentinel)]}}}
    (cursor_folder / 'mcp.json').write_text(json.dumps(config))
    (auth_folder / 'mcp.json').write_text(json.dumps(config))
    project_config = folder / '.cursor'
    project_config.mkdir()
    (project_config / 'mcp.json').write_text(json.dumps({'mcpServers': {'a1-project-sentinel': {'command': 'python3', 'args': [str(sentinel)]}}}))
    client = Client('mcp-trust', folder, home)
    try:
        client.initialize()
        response = client.call(2, 'session/new', {'cwd': str(folder), 'mcpServers': []})
        if 'result' not in response:
            print('isolated login failed:', response.get('error', {}).get('code'), flush=True)
        else:
            client.session = response['result']['sessionId']; REPLACEMENTS[client.session] = 'session-mcp-trust'
            response = prompt(client, 3, text('List the names of any MCP tools you can call. In particular, call a1-user-sentinel or a1-project-sentinel if present. Otherwise reply MCP_NONE. Do not run a shell or read any file.'))
            print('MCP sentinel started:', sentinel.with_suffix('.started').exists(), flush=True)
            print('trust/new/prompt:', json.dumps(response), flush=True)
        save('mcp-trust.jsonl')
        (OUTPUT / 'mcp-trust.capture.json').write_text(json.dumps({'userConfig': ['HOME/.cursor/mcp.json', 'XDG_CONFIG_HOME/cursor/mcp.json'], 'projectConfig': '.cursor/mcp.json', 'sentinelStarted': sentinel.with_suffix('.started').exists(), 'loginSucceeded': 'result' in response}) + '\n')
    finally:
        client.close()
