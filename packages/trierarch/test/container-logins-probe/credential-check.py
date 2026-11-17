#!/usr/bin/env python3
"""Which of the host's credentials a container holds, by kind, never by value.

Reads what the container holds on stdin (its processes' environments and
command lines, and a tar of its home, workspace and scratch folders), and the
container's mounts from `podman inspect` in the file named by --mounts. It
holds every credential of this computer in memory only and prints the kinds
it found, as a JSON list: "access token", "refresh token", "model token",
"api key", "crew token", or "harness home" for a mount of a host harness home.
"""

import argparse
import json
import sys
from pathlib import Path

HOME = Path.home()
HARNESS_HOMES = ['.claude', '.claude.json', '.codex', '.cursor', '.config/cursor', '.copilot', '.config/github-copilot', '.aeolus']


def read_json(path: Path):
    try:
        text = path.read_text()
    except OSError:
        return None
    return json.loads('\n'.join(line for line in text.splitlines() if not line.strip().startswith('//')))


def read_text(path: Path) -> str:
    try:
        return path.read_text().strip()
    except OSError:
        return ''


def credentials() -> dict:
    found = {'access token': [], 'refresh token': [], 'model token': [], 'api key': [], 'crew token': []}
    claude = (read_json(HOME / '.claude/.credentials.json') or {}).get('claudeAiOauth', {})
    found['access token'].append(claude.get('accessToken', ''))
    found['refresh token'].append(claude.get('refreshToken', ''))
    codex = read_json(HOME / '.codex/auth.json') or {}
    tokens = codex.get('tokens') or {}
    found['access token'] += [tokens.get('access_token', ''), tokens.get('id_token', '')]
    found['refresh token'].append(tokens.get('refresh_token', ''))
    found['api key'].append(codex.get('OPENAI_API_KEY') or '')
    cursor = read_json(HOME / '.config/cursor/auth.json') or {}
    found['access token'].append(cursor.get('accessToken', ''))
    found['refresh token'].append(cursor.get('refreshToken', ''))
    copilot = (read_json(HOME / '.copilot/config.json') or {}).get('authTokens', {})
    found['access token'] += [token for user in copilot.values() for token in user.values()]
    trierarch = HOME / '.aeolus/trierarch'
    found['model token'].append(read_text(trierarch / 'model-token'))
    found['api key'] += [read_text(key) for key in (trierarch / 'keys').glob('*')] if (trierarch / 'keys').is_dir() else []
    found['crew token'].append(read_text(trierarch / 'crew-token'))
    return {kind: [value for value in values if isinstance(value, str) and len(value) >= 16] for kind, values in found.items()}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--mounts', required=True)
    args = parser.parse_args()
    held = sys.stdin.buffer.read()
    kinds = sorted(kind for kind, values in credentials().items() if any(value.encode() in held for value in values))
    homes = [str(HOME / name) for name in HARNESS_HOMES]
    mounts = json.loads(Path(args.mounts).read_text())
    if any(mount.get('Source', '') == home or mount.get('Source', '').startswith(home + '/') for mount in mounts for home in homes):
        kinds.append('harness home')
    print(json.dumps(kinds))


if __name__ == '__main__':
    main()
