/**
 * A stand-in for `copilot -p --output-format=json`, run by Node as a program,
 * as captured from Copilot CLI 1.0.105 on 29 Oct: one turn per process. As
 * Copilot's npm launcher does, it runs the "native" Copilot as a child of its
 * own with spawnSync and stdio inherited, and exits with its status; a SIGINT
 * to the launcher alone ends the launcher at once and leaves the native
 * process running its turn to its end. The native process (this file run with
 * `--native`) writes the turn's events as JSON lines and, last, a `result`
 * naming the session, its id the one `--resume=<id>` gives or a new one. Its
 * prompt is the value of `--prompt=`.
 *
 * A prompt that says `slowly` runs until SIGINT, which aborts the turn as
 * Copilot does: `abort`, the turn's end, the SessionEnd hook with reason
 * complete, then, a moment later, the result with exit code 0.
 *
 * Its hooks as Copilot runs them, written down rather than run: SessionStart
 * (new or resume), Stop when the turn completes, SessionEnd with its reason.
 *
 * What it was given and did goes into its working folder, for the test to
 * read: each native start's arguments, environment and pid
 * (`fake-starts.jsonl`), each hook (`fake-hooks.jsonl`), and each native
 * process's start and exit in order (`fake-lives.jsonl`).
 *
 * Its own flags, as Copilot fails before its first turn or in it:
 * `--refuse-model` writes on stderr that the model is not available and exits
 * 1, with no event and no hook; `--fail-model-call` writes `session.error`, a
 * result with exit code 1 and SessionEnd with reason error, then exits 1;
 * `--resume=gone` writes on stderr that no session matched and exits 1.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);

if (!args.includes('--native')) {
  const native = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--native', ...args], { stdio: 'inherit' });
  process.exit(native.status ?? 1);
}

const valueOf = (prefix: string): string | undefined => args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
const prompt = valueOf('--prompt=') ?? '';
const resumed = valueOf('--resume=');
const ABORT_MS = 300;

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

appendFileSync('fake-starts.jsonl', `${JSON.stringify({ args: args.filter((arg) => arg !== '--native'), env: process.env, pid: process.pid })}\n`);
life('start');

if (args.includes('--refuse-model')) {
  process.stderr.write('Error: Model "no-such-model" from --model flag is not available.\n');
  exit(1);
}
if (resumed === 'gone') {
  process.stderr.write("Error: No session, task, or name matched 'gone'.\n\nTo resume by session or task ID:  copilot --resume=<id>\n");
  exit(1);
}

const sessionId = resumed ?? `fake-session-${String(process.pid)}`;
hook('SessionStart', { source: resumed === undefined ? 'new' : 'resume', sessionId });
emit({ type: 'user.message', data: { content: prompt } });
emit({ type: 'assistant.turn_start', data: { turnId: '0' } });

if (args.includes('--fail-model-call')) {
  emit({ type: 'assistant.turn_end', data: { turnId: '0' } });
  emit({ type: 'session.error', data: { errorType: 'query', message: 'Execution failed: Failed to get response from the AI model' } });
  hook('SessionEnd', { reason: 'error', sessionId });
  emit({ type: 'result', sessionId, exitCode: 1 });
  exit(1);
}

emit({ type: 'assistant.message', data: { content: `on it: ${prompt}` } });

if (prompt.includes('slowly')) {
  process.on('SIGINT', () => {
    emit({ type: 'abort', data: { reason: 'user_initiated' } });
    emit({ type: 'assistant.turn_end', data: { turnId: '0' } });
    hook('SessionEnd', { reason: 'complete', sessionId });
    setTimeout(() => {
      emit({ type: 'result', sessionId, exitCode: 0 });
      exit(0);
    }, ABORT_MS);
  });
  setInterval(() => undefined, 1000);
} else {
  emit({ type: 'assistant.turn_end', data: { turnId: '0' } });
  hook('Stop', { sessionId });
  hook('SessionEnd', { reason: 'complete', sessionId });
  emit({ type: 'result', sessionId, exitCode: 0 });
  exit(0);
}
