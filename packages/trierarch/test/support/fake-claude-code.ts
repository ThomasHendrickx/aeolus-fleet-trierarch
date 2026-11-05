/**
 * A stand-in for Claude Code in print mode with streamed JSON (`claude -p
 * --input-format stream-json --output-format stream-json --verbose`), run by
 * Node as a program, as captured from Claude Code 2.1.306 on 25 Oct: one user
 * message per stdin line, `system/init` with its session id before the first
 * turn, one `result` per turn. A turn whose text says `slowly` runs until it
 * is interrupted; any other ends at once. The interrupt control request ends
 * the running turn with `error_during_execution` and the process stays; SIGINT
 * ends the turn, then the process (exit 0).
 *
 * What it was given goes into its working folder, for the test to read: each
 * start's arguments, environment and pid (`fake-starts.jsonl`) and each stdin line
 * (`fake-received.jsonl`).
 *
 * With FAKE_CLAUDE_REFUSES_MODEL set to a model id, the first turn fails as
 * Claude Code's does when the model is not found: the plugin's StopFailure
 * hook is told, and the session makes no tool call.
 *
 * Its flags: `--refuse-interrupt` answers the control request with an error;
 * `--fail-login` answers its first turn as Claude Code does without a login,
 * then exits 1; `--plugin <root> <data>` runs the aeolus-fleet plugin's hooks from
 * that root as Claude Code runs them: SessionStart, UserPromptSubmit (its
 * output added to the turn), a first tool call, Stop.
 *
 * A turn whose text or context holds `socket call: <base64url of JSON>`, the
 * JSON `{ socket, method, path, body }`, makes that call over the socket as a
 * session's curl does, the path as it is, and writes down the answer's status
 * and body (`fake-socket-calls.jsonl`).
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const isRefusingInterrupt = args.includes('--refuse-interrupt');
const isFailingLogin = args.includes('--fail-login');
const pluginAt = args.indexOf('--plugin');
const plugin = pluginAt === -1 ? undefined : { root: args[pluginAt + 1] ?? '', data: args[pluginAt + 2] ?? '' };
const resumeAt = args.indexOf('--resume');
const sessionId = resumeAt === -1 ? `fake-${String(process.pid)}` : (args[resumeAt + 1] ?? '');
const refusedModel = process.env.FAKE_CLAUDE_REFUSES_MODEL;
const NOT_LOGGED_IN = 'Not logged in · Please run /login';

appendFileSync('fake-starts.jsonl', `${JSON.stringify({ args, env: process.env, pid: process.pid })}\n`);

const emit = (event: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify({ ...event, session_id: sessionId })}\n`);
};

/** Runs a plugin hook as Claude Code does, answering what it printed. */
function hook(script: string, payload: Record<string, unknown>): string {
  if (plugin === undefined) {
    return '';
  }
  const ran = spawnSync('bash', [`${plugin.root}/scripts/${script}`], {
    input: JSON.stringify({ session_id: sessionId, cwd: process.cwd(), ...payload }),
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: plugin.root, CLAUDE_PLUGIN_DATA: plugin.data, CLAUDE_PROJECT_DIR: process.cwd() },
    encoding: 'utf8',
  });
  return ran.stdout;
}

const SOCKET_CALL = /socket call: ([A-Za-z0-9_-]+)/g;

/** Makes each socket call the text names, as `curl --unix-socket` does, and writes down what it answered. */
function callSockets(text: string): void {
  for (const [, encoded = ''] of text.matchAll(SOCKET_CALL)) {
    const call: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    const field = (name: string): string => {
      const value: unknown = typeof call === 'object' && call !== null ? Reflect.get(call, name) : undefined;
      return typeof value === 'string' ? value : '';
    };
    const ran = spawnSync('curl', ['-sS', '--path-as-is', '-w', '\n%{http_code}', '-X', field('method'), '--unix-socket', field('socket'), '-H', 'content-type: application/json', '--data-binary', field('body'), `http://trierarch${field('path')}`], { encoding: 'utf8' });
    const lines = ran.stdout.split('\n');
    const status = Number(lines.pop());
    appendFileSync('fake-socket-calls.jsonl', `${JSON.stringify({ path: field('path'), status, body: lines.join('\n') })}\n`);
  }
}

let hasStarted = false;
let isBusy = false;
let hasMadeToolCall = false;

function endTurn(subtype: 'success' | 'error_during_execution', result?: string): void {
  isBusy = false;
  if (subtype === 'success') {
    hook('aeolus-stop.sh', { hook_event_name: 'Stop', stop_hook_active: false });
  }
  emit({ type: 'result', subtype, is_error: subtype !== 'success', ...(result !== undefined && { result }), stop_reason: subtype === 'success' ? 'end_turn' : null });
}

process.on('SIGINT', () => {
  if (isBusy) {
    endTurn('error_during_execution');
  }
  process.exit(0);
});

function onUser(content: string): void {
  if (!hasStarted) {
    hasStarted = true;
    hook('aeolus-launch.sh', { hook_event_name: 'SessionStart', source: resumeAt === -1 ? 'startup' : 'resume' });
  }
  emit({ type: 'system', subtype: 'init', cwd: process.cwd() });
  if (isFailingLogin) {
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: NOT_LOGGED_IN }] }, error: 'authentication_failed' });
    emit({ type: 'result', subtype: 'success', is_error: true, result: NOT_LOGGED_IN });
    process.exit(1);
  }
  if (refusedModel !== undefined && refusedModel !== '') {
    const message = `There's an issue with the selected model (${refusedModel}). It may not exist or you may not have access to it.`;
    hook('aeolus-launch.sh', { hook_event_name: 'StopFailure', error: 'model_not_found', last_assistant_message: message });
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: message }] }, error: 'model_not_found' });
    emit({ type: 'result', subtype: 'success', is_error: true, result: message });
    return;
  }
  isBusy = true;
  const context = hook('aeolus-turn.sh', { hook_event_name: 'UserPromptSubmit', prompt: content });
  appendFileSync('fake-turns.jsonl', `${JSON.stringify({ prompt: content, context })}\n`);
  callSockets(`${content}\n${context}`);
  if (!hasMadeToolCall) {
    hasMadeToolCall = true;
    hook('aeolus-launch.sh', { hook_event_name: 'PreToolUse', tool_name: 'Bash' });
  }
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: `on it: ${content}` }] } });
  if (!content.includes('slowly')) {
    endTurn('success', `got ${content}`);
  }
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  appendFileSync('fake-received.jsonl', `${line}\n`);
  const event: unknown = JSON.parse(line);
  if (typeof event !== 'object' || event === null) {
    return;
  }
  const type: unknown = Reflect.get(event, 'type');
  if (type === 'user') {
    const message: unknown = Reflect.get(event, 'message');
    const content: unknown = typeof message === 'object' && message !== null ? Reflect.get(message, 'content') : undefined;
    onUser(typeof content === 'string' ? content : JSON.stringify(content));
    return;
  }
  if (type === 'control_request') {
    const requestId: unknown = Reflect.get(event, 'request_id');
    if (isRefusingInterrupt) {
      emit({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: 'interrupt is not supported' } });
      return;
    }
    emit({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { still_queued: [] } } });
    if (isBusy) {
      endTurn('error_during_execution');
    }
  }
});
lines.on('close', () => {
  process.exit(0);
});
