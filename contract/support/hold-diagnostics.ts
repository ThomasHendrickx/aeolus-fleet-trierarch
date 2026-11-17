/** Hold lifecycle diagnostics for failed-start contract failures, loaded by Node before the trierarch. */
import { ChildProcess } from 'node:child_process';
import { subscribe } from 'node:diagnostics_channel';
import { errorMonitor } from 'node:events';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

// Neither command words nor environment belong in a failure log: they can contain crew secrets.
if (process.argv.includes('hold')) {
  const at = process.argv.indexOf('--sessions');
  const sessions = process.argv[at + 1];
  const shipId = process.argv[process.argv.indexOf('hold') + 1];
  if (at !== -1 && sessions !== undefined && shipId !== undefined) {
    const file = join(sessions, '..', 'hold-diagnostics.jsonl');
    const record = (event: Readonly<Record<string, unknown>>): void => {
      appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, shipId, ...event })}\n`, { mode: 0o600 });
    };
    record({ event: 'hold-start' });
    process.on('exit', (code) => { record({ event: 'hold-exit', code }); });
    process.on('uncaughtExceptionMonitor', (error) => { record({ event: 'hold-uncaught', name: error.name, message: error.message }); });
    subscribe('child_process', (message) => {
      if (typeof message !== 'object' || message === null) return;
      const child: unknown = Reflect.get(message, 'process');
      if (!(child instanceof ChildProcess)) return;
      child.once('spawn', () => { record({ event: 'child-start', child: child.pid }); });
      child.on('exit', (code, signal) => { record({ event: 'child-exit', child: child.pid, code, signal }); });
      child.on(errorMonitor, (error: unknown) => {
        record({ event: 'child-error', child: child.pid, ...(error instanceof Error && { name: error.name, message: error.message }) });
      });
    });
  }
}
