"""Identify whether ACP starts unrelated user or project MCP servers.

Each sentinel writes a private marker and then exits. No external server or
credential is supplied. The machine login is linked, never read or changed.
"""
import json
from pathlib import Path
import tempfile
import time

from probe import Client, MESSAGES, OUTPUT, REPLACEMENTS, save

with tempfile.TemporaryDirectory(prefix='aeolus-acp-mcp-') as root:
    root = Path(root)
    REPLACEMENTS[str(root)] = '/workspace/probe'
    observations = []
    for source in ('home', 'xdg', 'project'):
        folder = root / source
        folder.mkdir()
        home = folder / 'home'
        auth_folder = home / '.config/cursor'
        auth_folder.mkdir(parents=True)
        (auth_folder / 'auth.json').symlink_to(Path.home() / '.config/cursor/auth.json')
        sentinel = folder / 'sentinel.py'
        marker = folder / 'sentinel.started'
        sentinel.write_text('from pathlib import Path\nPath(__file__).with_suffix(".started").touch()\n')
        target = {'home': home / '.cursor/mcp.json', 'xdg': auth_folder / 'mcp.json', 'project': folder / '.cursor/mcp.json'}[source]
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps({'mcpServers': {f'a1-{source}-sentinel': {'command': 'python3', 'args': [str(sentinel)]}}}))
        MESSAGES.clear()
        client = Client(f'mcp-{source}', folder, home)
        try:
            before_init = marker.exists()
            client.initialize()
            after_init = marker.exists()
            response = client.call(2, 'session/new', {'cwd': str(folder), 'mcpServers': []})
            time.sleep(1)
            after_new = marker.exists()
            observation = {'source': source, 'beforeInitialize': before_init, 'afterInitialize': after_init, 'afterNew': after_new, 'sessionCreated': 'result' in response}
            observations.append(observation)
            print(json.dumps(observation), flush=True)
            save(f'mcp-{source}.jsonl')
        finally:
            client.close()
    (OUTPUT / 'mcp-exclusion.capture.json').write_text(json.dumps(observations, indent=2) + '\n')
