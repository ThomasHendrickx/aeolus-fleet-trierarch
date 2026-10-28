/**
 * A stand-in for `codex exec --json`, run by Node as a program, as captured
 * from codex-cli 0.163.0 on 25 Oct: one turn per process. `codex exec ...
 * -- <prompt>` starts a thread, `codex exec resume <thread id> ... -- <prompt>`
 * resumes that one and `codex exec resume --last` the folder's last. Before
 * its turn it reads its stdin to the end, as Codex does when stdin is no
 * terminal. It writes `thread.started` with the thread id, `turn.started`,
 * the turn's items and `turn.completed`, then exits 0. A prompt that says
 * `slowly` runs until it is stopped: SIGINT ends it with exit 1 and no event
 * more.
 *
 * Its hooks as Codex runs them, written down rather than run:
 * SessionStart (startup or resume), UserPromptSubmit, then Stop when the turn
 * completes or Interrupt on SIGINT.
 *
 * What it was given and did goes into its working folder, for the test to
 * read: each start's arguments, environment and pid (`fake-starts.jsonl`),
 * each hook (`fake-hooks.jsonl`), each process's start and exit in order
 * (`fake-lives.jsonl`).
 *
 * Its own flags: `--refuse-model` fails the turn as Codex does for a model it
 * does not support, then exits 1; `--linger-ms <ms>` waits that long after its
 * turn completed before it exits, as Codex finishes its session files;
 * `--thread-id <id>` names that thread id in `thread.started` instead;
 * `--stray-thread-id <id>` names that thread id in `turn.started` too, an
 * event that names no thread.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const end = args.indexOf('--');
const prompt = end === -1 ? '' : (args[end + 1] ?? '');
const words = end === -1 ? args : args.slice(0, end);
const isResuming = words[1] === 'resume';
const LAST_THREAD = 'fake-last-thread';
const lingerAt = words.indexOf('--linger-ms');
const lingerMs = lingerAt === -1 ? 0 : Number(words[lingerAt + 1]);
const threadIdAt = words.indexOf('--thread-id');
const strayThreadIdAt = words.indexOf('--stray-thread-id');
const REFUSED = JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: "The 'gpt-nonexistent-9' model is not supported when using Codex with a ChatGPT account.", code: 'model_not_found' } });

function threadId(): string {
  if (!isResuming) {
    return `fake-thread-${String(process.pid)}`;
  }
  return words[2] === '--last' ? (existsSync(LAST_THREAD) ? readFileSync(LAST_THREAD, 'utf8') : 'no-last-thread') : (words[2] ?? '');
}

const emit = (event: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
};
const hook = (event: string, payload: Record<string, unknown> = {}): void => {
  appendFileSync('fake-hooks.jsonl', `${JSON.stringify({ event, ...payload })}\n`);
};
const life = (at: 'start' | 'exit'): void => {
  appendFileSync('fake-lives.jsonl', `${JSON.stringify({ pid: process.pid, at })}\n`);
};
const exit = (code: number): never => {
  life('exit');
  process.exit(code);
};

appendFileSync('fake-starts.jsonl', `${JSON.stringify({ args, env: process.env, pid: process.pid })}\n`);
life('start');

process.on('SIGINT', () => {
  hook('Interrupt');
  exit(1);
});

let stdin = '';
process.stdin.on('data', (chunk: Buffer) => {
  stdin += chunk.toString('utf8');
});
process.stdin.on('end', () => {
  const thread = threadIdAt === -1 ? threadId() : (words[threadIdAt + 1] ?? '');
  writeFileSync(LAST_THREAD, thread);
  emit({ type: 'thread.started', thread_id: thread });
  hook('SessionStart', { source: isResuming ? 'resume' : 'startup', thread });
  hook('UserPromptSubmit', { prompt: stdin === '' ? prompt : `${prompt}\n<stdin>${stdin}</stdin>`, thread });
  emit({ type: 'turn.started', ...(strayThreadIdAt !== -1 && { thread_id: words[strayThreadIdAt + 1] }) });
  if (words.includes('--refuse-model')) {
    emit({ type: 'error', message: REFUSED });
    emit({ type: 'turn.failed', error: { message: REFUSED } });
    exit(1);
  }
  emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: `on it: ${prompt}` } });
  if (prompt.includes('slowly')) {
    setInterval(() => undefined, 1000);
    return;
  }
  hook('Stop', { thread });
  emit({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 } });
  setTimeout(() => exit(0), lingerMs);
});
