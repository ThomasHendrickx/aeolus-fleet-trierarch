#!/usr/bin/env python3
"""The C1 login proxy: the trierarch's side of the proxy road, as a probe.

It listens on the host's loopback, where pasta forwards the container's
loopback port to it alone. It takes a request only with the session's own
token, drops that token, injects the host login's current access, read from
the host harness's own login file at every request, and forwards to that
harness's vendor alone. Nothing it reads is written anywhere: its log holds
the route, method, path with ids replaced, status and whether it injected or
refused, never a header value.

    login-proxy.py --port-file F --socket S --log L --token-file T [--refuse]

It answers on a loopback TCP port, which pasta forwards, and on a Unix
socket, which a container without any network reaches through a forwarder of
its own: the probe's proof that a turn needs no other way out.

--refuse injects a login the vendor refuses, as a host login that could not
be renewed would be.
"""

import argparse
import http.client
import json
import os
import re
import secrets
import ssl
import string
import socketserver
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOME = Path.home()
DROPPED = {'authorization', 'x-api-key', 'host', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'transfer-encoding', 'upgrade', 'content-length', 'chatgpt-account-id', 'x-cursor-checksum-ignored'}
REFUSED = 'aeolus-probe-refused-login'


def refused_login(route: str) -> str:
    """A login of the shape the vendor reads, which it refuses: the Copilot API answers 400, not 401, to a token not shaped as GitHub's."""
    if route == 'copilot':
        return 'gho_' + ''.join(secrets.choice(string.ascii_letters + string.digits) for _ in range(36))
    return REFUSED
ID = re.compile(r'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}')
LONG = re.compile(r'[A-Za-z0-9_-]{24,}')


def read_json(path: Path) -> dict:
    text = path.read_text()
    return json.loads('\n'.join(line for line in text.splitlines() if not line.strip().startswith('//')))


def claude_login() -> dict:
    """The model token where the trierarch keeps one; else the host's own Claude Code subscription access, the same kind of OAuth bearer."""
    model_token = HOME / '.aeolus/trierarch/model-token'
    access = model_token.read_text().strip() if model_token.exists() else read_json(HOME / '.claude/.credentials.json')['claudeAiOauth']['accessToken']
    return {'authorization': f'Bearer {access}'}


def codex_login() -> dict:
    tokens = read_json(HOME / os.environ.get('CODEX_HOME_ON_HOST', '.codex') / 'auth.json')['tokens']
    return {'authorization': f"Bearer {tokens['access_token']}", 'chatgpt-account-id': tokens['account_id']}


def cursor_login() -> dict:
    return {'authorization': f"Bearer {read_json(HOME / '.config/cursor/auth.json')['accessToken']}"}


def copilot_login() -> dict:
    tokens = read_json(HOME / '.copilot/config.json')['authTokens']
    token = next(iter(next(iter(tokens.values())).values()))
    return {'authorization': f'Bearer {token}'}


# route: (upstream host, path prefix there, login, headers the vendor needs on that login)
ROUTES = {
    'anthropic': ('api.anthropic.com', '', claude_login, {'anthropic-beta': 'oauth-2025-04-20'}),
    'chatgpt': ('chatgpt.com', '/backend-api/codex', codex_login, {}),
    'copilot': (os.environ.get('COPILOT_API_HOST', 'api.githubcopilot.com'), '', copilot_login, {'copilot-integration-id': 'copilot-developer-cli'}),
    'cursor': ('api2.cursor.sh', '', cursor_login, {}),
}


def scrubbed(path: str) -> str:
    path = path.split('?', 1)[0]
    return LONG.sub('<id>', ID.sub('<id>', path))


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'aeolus-login-proxy'

    def log_message(self, *args):  # noqa: D102 - the proxy's own log is the capture
        pass

    def record(self, route: str, status: int, credential: str) -> None:
        line = {'route': route, 'method': self.command, 'path': scrubbed(self.path.split('/', 2)[-1] if self.path.count('/') > 1 else '/'), 'status': status, 'credential': credential}
        line['path'] = '/' + line['path'].lstrip('/')
        with self.server.lock:
            with open(self.server.log, 'a') as log:
                log.write(json.dumps(line) + '\n')

    def refuse(self, route: str) -> None:
        body = b'{"type":"error","error":{"type":"authentication_error","message":"aeolus login proxy: not the session\'s token"}}'
        self.send_response(401)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        self.record(route, 401, 'refused by the proxy')

    def session_token(self) -> str:
        auth = self.headers.get('authorization', '')
        if auth.lower().startswith('bearer '):
            return auth[7:].strip()
        return self.headers.get('x-api-key', '')

    def forward(self) -> None:
        _, route, *rest = self.path.split('/', 2)
        if route not in ROUTES:
            self.refuse(route)
            return
        if self.session_token() != self.server.token:
            self.refuse(route)
            return
        host, prefix, login, extra = ROUTES[route]
        headers = {name: value for name, value in self.headers.items() if name.lower() not in DROPPED}
        injected = login()
        if self.server.refuse:
            refused = refused_login(route)
            injected = {name: (f'Bearer {refused}' if name == 'authorization' else value) for name, value in injected.items()}
        for name, value in extra.items():
            present = headers.pop(name, None) or headers.pop(name.title(), None)
            headers[name] = value if present is None or value in present else f'{present},{value}'
        headers.update(injected)
        length = int(self.headers.get('content-length') or 0)
        body = self.rfile.read(length) if length else None
        if body is None and self.headers.get('transfer-encoding', '').lower() == 'chunked':
            body = self.read_chunked()
        upstream = http.client.HTTPSConnection(host, context=ssl.create_default_context(), timeout=600)
        upstream.request(self.command, prefix + '/' + (rest[0] if rest else ''), body=body, headers=headers)
        answer = upstream.getresponse()
        self.send_response(answer.status)
        for name, value in answer.getheaders():
            if name.lower() not in ('connection', 'transfer-encoding', 'content-length', 'keep-alive'):
                self.send_header(name, value)
        self.send_header('transfer-encoding', 'chunked')
        self.end_headers()
        while chunk := answer.read1(65536):
            self.wfile.write(f'{len(chunk):x}\r\n'.encode() + chunk + b'\r\n')
            self.wfile.flush()
        self.wfile.write(b'0\r\n\r\n')
        upstream.close()
        self.record(route, answer.status, 'injected by the proxy')

    def read_chunked(self) -> bytes:
        data = b''
        while True:
            size = int(self.rfile.readline().split(b';')[0], 16)
            if size == 0:
                self.rfile.readline()
                return data
            data += self.rfile.read(size)
            self.rfile.readline()

    do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = forward


class UnixServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

    def get_request(self):
        request, _ = super().get_request()
        return request, ('unix', 0)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--port-file', required=True)
    parser.add_argument('--socket', required=True)
    parser.add_argument('--log', required=True)
    parser.add_argument('--token-file', required=True)
    parser.add_argument('--refuse', action='store_true')
    args = parser.parse_args()
    lock = threading.Lock()
    token = Path(args.token_file).read_text().strip()
    servers = [ThreadingHTTPServer(('127.0.0.1', 0), Handler), UnixServer(args.socket, Handler)]
    for server in servers:
        server.token, server.log, server.refuse, server.lock = token, args.log, args.refuse, lock
    threading.Thread(target=servers[1].serve_forever, daemon=True).start()
    Path(args.port_file).write_text(str(servers[0].server_address[1]))
    servers[0].serve_forever()


if __name__ == '__main__':
    main()
