"""Capture real ACP messages using controlled prompts and sanitized identifiers.

Run from the repository root. Processes are private to this probe. Model defaults
are restored before exit; no login files or environment values are recorded.
"""
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import tempfile
import threading
import time

BUILD = '2026.11.13-eacade1'
ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / 'plugins/aeolus-fleet/test/fixtures/cursor-acp' / BUILD / 'linux'
OUTPUT.mkdir(parents=True, exist_ok=True)
MESSAGES = []
REPLACEMENTS = {}


def sanitize(value):
    if isinstance(value, dict):
        return {key: sanitize(item) for key, item in value.items()}
    if isinstance(value, list):
        return [sanitize(item) for item in value]
    if isinstance(value, str):
        for source, target in REPLACEMENTS.items():
            value = value.replace(source, target)
        value = value.replace(str(Path.home()), '/home/probe')
        return re.sub(r'\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b', '00000000-0000-4000-8000-000000000000', value)
    return value


class Client:
    def __init__(self, name, folder, home=None):
        self.name = name
        env = {key: os.environ[key] for key in ('PATH', 'HOME', 'USER', 'SHELL', 'LANG') if key in os.environ}
        if home:
            env['HOME'] = str(home)
            env['XDG_CONFIG_HOME'] = str(home / '.config')
        self.process = subprocess.Popen(['agent', 'acp'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=env, cwd=folder)
        self.messages = queue.Queue()
        self.pending = {}
        threading.Thread(target=self.read, daemon=True).start()

    def read(self):
        for line in self.process.stdout:
            message = json.loads(line)
            MESSAGES.append({'process': self.name, 'direction': 'received', 'message': message})
            self.messages.put(message)

    def send(self, message):
        MESSAGES.append({'process': self.name, 'direction': 'sent', 'message': message})
        self.process.stdin.write(json.dumps(message) + '\n')
        self.process.stdin.flush()

    def call(self, number, method, params, timeout=90):
        self.send({'jsonrpc': '2.0', 'id': number, 'method': method, 'params': params})
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            message = self.messages.get(timeout=max(0.1, end - time.monotonic()))
            if message.get('id') == number and 'method' not in message:
                return message
            if message.get('method') == 'session/request_permission':
                self.send({'jsonrpc': '2.0', 'id': message['id'], 'result': {'outcome': {'outcome': 'selected', 'optionId': 'reject-once'}}})
        raise TimeoutError(method)

    def initialize(self):
        return self.call(1, 'initialize', {'protocolVersion': 1, 'clientCapabilities': {}, 'clientInfo': {'name': 'aeolus-a1-probe', 'version': '1'}})

    def new(self, folder, **extra):
        response = self.call(2, 'session/new', {'cwd': str(folder), 'mcpServers': [], **extra})
        self.session = response['result']['sessionId']
        REPLACEMENTS[self.session] = f'session-{self.name}'
        return response

    def model(self, number, model):
        return self.call(number, 'session/set_model', {'sessionId': self.session, 'modelId': model})

    def state(self, number):
        return self.call(number, 'session/set_config_option', {'sessionId': self.session, 'configId': 'mode', 'value': 'ask'})

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
        self.process.wait(timeout=10)


def save(name, start=0):
    (OUTPUT / name).write_text(''.join(json.dumps(sanitize(message), separators=(',', ':')) + '\n' for message in MESSAGES[start:]))


def main():
    with tempfile.TemporaryDirectory(prefix='aeolus-acp-a1-') as folder:
        folder = Path(folder)
        REPLACEMENTS[str(folder)] = '/workspace/probe'
        clients = []
        original = None
        try:
            a = Client('A', folder); clients.append(a)
            b = Client('B', folder); clients.append(b)
            a.initialize(); b.initialize()
            original = a.new(folder)['result']['models']['currentModelId']
            b.new(folder)
            a.model(3, 'default[]')
            b.model(3, 'gpt-5.4-mini[reasoning=medium]')
            b.state(4)
            a.model(5, 'composer-2.5[fast=true]')
            a.state(6); b.state(6)
            b.call(7, 'session/prompt', {'sessionId': b.session, 'prompt': [{'type': 'text', 'text': 'Reply exactly ACP_A1_OK. Do not use tools.'}]})
            b.state(8)
            save('model-isolation.jsonl')
            print('model-isolation captured')
        finally:
            if original:
                a.model(99, original)
            for client in clients:
                client.close()


if __name__ == '__main__':
    main()
