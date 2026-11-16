#!/usr/bin/env python3
"""Slice C1's probe: one harness's login road in the session image, recorded.

    probe.py <claude-code|codex|cursor|copilot> --out <capture.json>
    probe.py exec-sigint --out <capture.json>

Run on a Linux computer with rootless Podman, the session image and the
harness logged in on the host. The harness runs in a container of the image,
its home and workspace fresh folders of their own, its binary mounted
read-only where the image does not hold it yet (design 4.3 puts it there).
The container gets only the session's own proxy token, in a read-only file;
login-proxy.py, the trierarch's side, injects the host login. The probe runs:

1. turns over pasta forwarding the proxy's port alone, as the design runs them;
2. a turn in a container with no network at all, the proxy reached over a
   Unix socket, so nothing the turn needs goes another way;
3. a search of the container's environments, command lines, home, workspace
   and scratch, while a turn runs, for every credential of this computer
   (credential-check.py), by kind only;
4. a renewal of the host login between two turns, where the harness has one
   to renew;
5. a turn with a refused login, as a host login that could not be renewed.

The capture holds the answers and requests scrubbed of ids, and no header
value. Nothing of the host login is written anywhere.
"""

import argparse
import base64
import hashlib
import json
import os
import re
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
HOME = Path.home()
IMAGE = 'ghcr.io/thomashendrickx/aeolus-session:0.40.0'
PROMPT = 'Reply with the single word PONG and nothing else.'
PASTA = 'pasta:--no-map-gw,-t,none,-u,none,-T,{port},-U,none'
CURSOR_VERSION = '2026.11.13-eacade1'
MOUNTS = {
    'codex': ('/usr/lib/node_modules/@openai/codex', '/opt/codex'),
    'cursor': (str(HOME / f'.local/share/cursor-agent/versions/{CURSOR_VERSION}'), '/opt/cursor'),
    'copilot': (str(HOME / '.npm-global/lib/node_modules/@github/copilot'), '/opt/copilot'),
}
ID = re.compile(r'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}')
ANSI = re.compile(r'\x1b\[[0-9;]*[A-Za-z]')


def run(*args: str, check: bool = True, **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(args, check=check, capture_output=True, text=True, **kwargs)


def scrub(text: str) -> str:
    text = ANSI.sub('', text)
    text = ID.sub('<id>', text)
    text = re.sub(r'(cf-ray|request id|x-request-id):\s*[\w<>-]+', r'\1: <id>', text, flags=re.IGNORECASE)
    text = re.sub(r'(?:127\.)?0\.0\.1:\d+|localhost:\d+', '127.0.0.1:<port>', text)
    text = text.replace(str(HOME), '<home>')
    return re.sub(r'\s+', ' ', text).strip()[-300:]


class Probe:
    def __init__(self, harness: str):
        self.harness = harness
        self.scratch = Path(tempfile.mkdtemp(prefix=f'c1-{harness}-', dir='/tmp'))
        for folder in ('home', 'work', 'run'):
            (self.scratch / folder).mkdir(mode=0o700)
        # Named after its scratch folder, unique on this computer, so a probe removes only its own container.
        self.name = f'aeolus-{self.scratch.name}'
        self.token = self.session_token()
        token_file = self.scratch / 'run/proxy-token'
        token_file.write_text(self.token)
        token_file.chmod(0o600)
        self.log = self.scratch / 'requests.jsonl'
        self.proxy = None
        self.port = 0

    def session_token(self) -> str:
        """The session's own token. Cursor reads its login file as a JWT, so for Cursor it has that shape, its claims naming nobody, its signature the random part."""
        random = secrets.token_urlsafe(32)
        if self.harness != 'cursor':
            return random
        part = lambda claims: base64.urlsafe_b64encode(json.dumps(claims, separators=(',', ':')).encode()).rstrip(b'=').decode()
        now = int(time.time())
        claims = {'sub': 'aeolus-session', 'time': str(now), 'randomness': secrets.token_hex(8), 'exp': now + 3600, 'iss': 'https://authentication.cursor.sh', 'scope': 'openid profile email offline_access', 'aud': 'https://cursor.com', 'type': 'session'}
        return f"{part({'alg': 'HS256', 'typ': 'JWT'})}.{part(claims)}.{random}"

    # The trierarch's side.
    def start_proxy(self, refuse: bool = False) -> None:
        self.stop_proxy()
        port_file = self.scratch / 'port'
        port_file.unlink(missing_ok=True)
        socket = self.scratch / 'run/proxy.sock'
        socket.unlink(missing_ok=True)
        env = {**os.environ, 'COPILOT_API_HOST': copilot_api_host()} if self.harness == 'copilot' else os.environ
        args = [sys.executable, str(HERE / 'login-proxy.py'), '--port-file', str(port_file), '--socket', str(socket), '--log', str(self.log), '--token-file', str(self.scratch / 'run/proxy-token')]
        self.proxy = subprocess.Popen(args + (['--refuse'] if refuse else []), env=env)
        while not port_file.exists() or not port_file.read_text():
            time.sleep(0.1)
        self.port = int(port_file.read_text())

    def stop_proxy(self) -> None:
        if self.proxy is not None:
            self.proxy.terminate()
            self.proxy.wait()
            self.proxy = None

    def requests(self) -> list:
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    # The session's side.
    def prepare_home(self) -> dict:
        """The ship's home for the harness, and the environment its container gets: no credential in either, the proxy token only in its file."""
        home = self.scratch / 'home'
        base = f'http://127.0.0.1:{self.port}'
        if self.harness == 'claude-code':
            (home / '.claude').mkdir(exist_ok=True)
            (home / '.claude/settings.json').write_text(json.dumps({'apiKeyHelper': 'cat /run/aeolus/proxy-token'}))
            return {'ANTHROPIC_BASE_URL': f'{base}/anthropic'}
        if self.harness == 'codex':
            (home / '.codex').mkdir(exist_ok=True)
            (home / '.codex/config.toml').write_text('\n'.join([
                'model_provider = "aeolus"',
                '[model_providers.aeolus]',
                'name = "aeolus"',
                f'base_url = "{base}/chatgpt"',
                'wire_api = "responses"',
                '[model_providers.aeolus.auth]',
                'command = "cat"',
                'args = ["/run/aeolus/proxy-token"]',
                '',
            ]))
            return {}
        if self.harness == 'cursor':
            (home / '.config/cursor').mkdir(parents=True, exist_ok=True)
            login = home / '.config/cursor/auth.json'
            login.write_text(json.dumps({'accessToken': self.token, 'refreshToken': self.token}))
            login.chmod(0o600)
            (home / '.cursor').mkdir(exist_ok=True)
            (home / '.cursor/cli-config.json').write_text(json.dumps({'version': 1, 'network': {'useHttp1ForAgent': True}}))
            return {}
        return {
            'COPILOT_PROVIDER_BASE_URL': f'{base}/copilot',
            'COPILOT_PROVIDER_TYPE': 'openai',
            'COPILOT_PROVIDER_WIRE_API': 'responses',
            'COPILOT_PROVIDER_API_KEY_COMMAND': 'cat /run/aeolus/proxy-token',
            'COPILOT_MODEL': 'gpt-5.4-nano',
            'COPILOT_AUTO_UPDATE': 'false',
        }

    def start_container(self, isolated: bool = False) -> None:
        """The session's container: pasta forwarding the proxy's port alone; or, isolated, no network and a forwarder to the proxy's socket."""
        self.stop_container()
        env = self.prepare_home()
        network = ['--network', 'none'] if isolated else ['--network', PASTA.format(port=self.port)]
        mounts = ['-v', f"{self.scratch / 'home'}:/home/ubuntu", '-v', f"{self.scratch / 'work'}:/work", '-v', f"{self.scratch / 'run'}:/run/aeolus:ro"]
        if self.harness in MOUNTS:
            source, target = MOUNTS[self.harness]
            mounts += ['-v', f'{source}:{target}:ro']
        environment = [item for name, value in env.items() for item in ('-e', f'{name}={value}')]
        run('podman', 'run', '-d', '--name', self.name, *network, '--userns=keep-id:uid=1000,gid=1000', *mounts, *environment, '-w', '/work', IMAGE, 'sleep', 'infinity')
        if isolated:
            forwarder = f"require('net').createServer(c=>c.pipe(require('net').connect('/run/aeolus/proxy.sock')).pipe(c)).listen({self.port},'127.0.0.1')"
            subprocess.Popen(['podman', 'exec', self.name, 'node', '-e', forwarder], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            time.sleep(1)

    def stop_container(self) -> None:
        run('podman', 'rm', '-f', '-t', '0', self.name, check=False)

    def command(self) -> list:
        if self.harness == 'claude-code':
            return ['claude', '-p', PROMPT]
        if self.harness == 'codex':
            return ['node', '/opt/codex/bin/codex.js', 'exec', '--skip-git-repo-check', PROMPT]
        if self.harness == 'cursor':
            return ['/opt/cursor/cursor-agent', '--endpoint', f'http://localhost:{self.port}/cursor', '-p', '--trust', PROMPT]
        return ['node', '/opt/copilot/npm-loader.js', '-p', PROMPT, '--allow-all-tools']

    def turn(self, name: str, while_running=None) -> dict:
        process = subprocess.Popen(['podman', 'exec', self.name, *self.command()], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        if while_running is not None:
            time.sleep(4)
            while_running()
        output, _ = process.communicate(timeout=300)
        completed = process.returncode == 0 and 'PONG' in output
        answer = 'PONG' if completed else scrub(output)
        return {'name': name, 'completed': completed, 'answer': answer}

    def search_container(self) -> list:
        """Every credential kind the container holds, read while a turn runs."""
        held = run('podman', 'exec', self.name, 'sh', '-c', 'cat /proc/[0-9]*/environ /proc/[0-9]*/cmdline 2>/dev/null; env', check=False).stdout.encode()
        held += subprocess.run(['podman', 'exec', self.name, 'tar', 'cf', '-', '--ignore-failed-read', '/home/ubuntu', '/work', '/tmp', '/run'], capture_output=True).stdout
        mounts = self.scratch / 'mounts.json'
        mounts.write_text(run('podman', 'inspect', '--format', '{{json .Mounts}}', self.name).stdout)
        checked = subprocess.run([sys.executable, str(HERE / 'credential-check.py'), '--mounts', str(mounts)], input=held, capture_output=True, check=True)
        self.found = json.loads(checked.stdout)
        return self.found

    def version(self) -> str:
        if self.harness == 'cursor':
            return CURSOR_VERSION
        command = {'claude-code': ['claude'], 'codex': ['node', '/opt/codex/bin/codex.js'], 'copilot': ['node', '/opt/copilot/npm-loader.js']}[self.harness]
        words = scrub(run('podman', 'exec', self.name, *command, '--version', check=False).stdout).split(' ')
        return next(word.rstrip('.') for word in words if re.match(r'^\d+\.\d+', word))

    def close(self) -> None:
        self.stop_container()
        self.stop_proxy()
        run('podman', 'unshare', 'rm', '-rf', str(self.scratch), check=False)


def copilot_api_host() -> str:
    """The Copilot API of the host login's plan, as GitHub answers it."""
    import urllib.request
    tokens = json.loads('\n'.join(line for line in (HOME / '.copilot/config.json').read_text().splitlines() if not line.strip().startswith('//')))['authTokens']
    token = next(iter(next(iter(tokens.values())).values()))
    request = urllib.request.Request('https://api.github.com/copilot_internal/user', headers={'authorization': f'token {token}', 'accept': 'application/json', 'user-agent': 'aeolus-c1-probe'})
    return json.load(urllib.request.urlopen(request))['endpoints']['api'].removeprefix('https://')


def access_hash() -> str:
    tokens = json.loads((HOME / '.codex/auth.json').read_text())['tokens']
    return hashlib.sha256(tokens['access_token'].encode()).hexdigest()


def renew_codex() -> None:
    """The host's Codex renews its own ChatGPT login, no turn: `codex app-server`, `account/read` with `refreshToken`."""
    server = subprocess.Popen(['codex', 'app-server'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)

    def call(message: dict) -> None:
        server.stdin.write(json.dumps(message) + '\n')
        server.stdin.flush()
        while 'id' in message:
            answer = json.loads(server.stdout.readline())
            if answer.get('id') == message['id']:
                if 'error' in answer:
                    raise RuntimeError('account/read refused')
                return

    call({'id': 1, 'method': 'initialize', 'params': {'clientInfo': {'name': 'aeolus-c1-probe', 'version': '0'}}})
    call({'method': 'initialized'})
    call({'id': 2, 'method': 'account/read', 'params': {'refreshToken': True}})
    server.terminate()
    server.wait()


HOST_LOGINS = {
    'claude-code': ('long-lived, nothing to renew', 'The model token (`claude setup-token`) is an OAuth access of one year the trierarch keeps. This computer holds none, so the probe injected the host Claude Code\'s own subscription access, the same kind of bearer, read from its login file at every request.'),
    'codex': ('by its harness on the host', 'The host\'s Codex renewed its ChatGPT login with no turn (`codex app-server`, `account/read` with `refreshToken: true`); the proxy read the new access at the next request.'),
    'cursor': ('only by signing in again', f'Cursor CLI {CURSOR_VERSION} renews an access only with an API key (`auth-refresh.ts`: `loginWithApiKey`, once `exp` is within 300 seconds); the host\'s access read on 16 Nov ends in about 60 days, then needs `agent login` on the host. The proxy reads the host login at every request, so the container needs nothing when it is signed in again.'),
    'copilot': ('long-lived, nothing to renew', '`copilot login` keeps a GitHub OAuth token with no expiry and no refresh token; the proxy sends it to the Copilot API of the login\'s plan, as `api.github.com/copilot_internal/user` names it.'),
}

RENEWALS = {'codex': ('codex app-server: account/read {"refreshToken": true}', renew_codex, access_hash)}


def probe(harness: str) -> dict:
    probe = Probe(harness)
    try:
        probe.start_proxy()
        probe.start_container()
        turns = [probe.turn('first', while_running=probe.search_container), probe.turn('second')]
        version = probe.version()
        probe.start_container(isolated=True)
        turns.append(probe.turn('no network but the proxy'))
        capture = {
            'harness': harness,
            'harnessVersion': version,
            'image': IMAGE.split('/')[-1],
            'runtime': f"podman {run('podman', 'version', '--format', '{{.Client.Version}}').stdout.strip()} rootless on linux/amd64; pasta forwarding the proxy port alone, then no network but the proxy's socket",
            'road': 'proxy',
            'turns': turns,
            'hostLogin': dict(zip(('renewal', 'evidence'), HOST_LOGINS[harness])),
        }
        if harness in RENEWALS:
            command, renew, current = RENEWALS[harness]
            probe.start_container()
            before = current()
            renew()
            capture['renewal'] = {'command': command, 'accessChanged': current() != before, 'turnsAfter': [probe.turn('after renewal')]}
        capture['container'] = {'checked': ['environment', 'files', 'processes'], 'searchedFor': ['access token', 'refresh token', 'model token', 'api key', 'crew token', 'harness home'], 'found': probe.found}
        served = len(probe.requests())
        probe.start_proxy(refuse=True)
        probe.start_container()
        refused_turn = probe.turn('refused login')
        refused_statuses = [request['status'] for request in probe.requests()[served:] if request['credential'] == 'injected by the proxy']
        capture['requests'] = probe.requests()[:served]
        capture['refused'] = {'turn': refused_turn, 'vendorStatus': refused_statuses[0] if refused_statuses else 0, 'vendorStatuses': sorted(set(refused_statuses))}
        return capture
    finally:
        probe.close()


def exec_sigint() -> dict:
    """A per-turn harness's turn, started by `podman exec` into the session's container and stopped by SIGINT to its process group inside it."""
    probe = Probe('codex')
    try:
        probe.start_proxy()
        probe.start_container()
        long = 'Run the shell command `sleep 120` and then reply DONE.'
        turn = subprocess.Popen(['podman', 'exec', probe.name, 'setsid', 'sh', '-c', 'echo $$ > /tmp/turn.pgid; exec node /opt/codex/bin/codex.js exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox "$0"', long], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.time() + 120
        while time.time() < deadline and 'sleep 120' not in run('podman', 'exec', probe.name, 'ps', '-eo', 'args', check=False).stdout:
            time.sleep(1)
        started = 'sleep 120' in run('podman', 'exec', probe.name, 'ps', '-eo', 'args', check=False).stdout
        group = run('podman', 'exec', probe.name, 'cat', '/tmp/turn.pgid').stdout.strip()
        sent = time.time()
        run('podman', 'exec', probe.name, 'kill', '-INT', '--', f'-{group}', check=False)
        try:
            turn.wait(timeout=30)
        except subprocess.TimeoutExpired:
            turn.send_signal(signal.SIGKILL)
        stopped = round((time.time() - sent) * 1000)
        kept = run('podman', 'inspect', '--format', '{{.State.Running}}', probe.name).stdout.strip() == 'true'
        return {'harness': 'codex', 'started': started, 'signal': 'SIGINT', 'stoppedWithinMs': stopped, 'containerKept': kept, 'turnExit': turn.returncode}
    finally:
        probe.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('harness', choices=['claude-code', 'codex', 'cursor', 'copilot', 'exec-sigint'])
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    capture = exec_sigint() if args.harness == 'exec-sigint' else probe(args.harness)
    Path(args.out).write_text(json.dumps(capture, indent=2) + '\n')


if __name__ == '__main__':
    main()
