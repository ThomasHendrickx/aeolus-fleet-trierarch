import { spawn } from 'node:child_process';

/** What a program printed and how it ended. */
export interface CommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs a program with its arguments and optional input, no shell, and answers
 * how it ended rather than throwing on a non-zero exit. One that runs past
 * `timeoutMs` is ended and answers as failed.
 */
export function runCommand(command: string, options: { args: readonly string[]; env?: Readonly<Record<string, string>>; cwd?: string; input?: string; timeoutMs?: number }): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const { input } = options;
    // Stdin only when there is input: a program that exits without reading it would otherwise race the write (EPIPE).
    const child = spawn(command, [...options.args], { env: { ...process.env, ...options.env }, cwd: options.cwd, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], ...(options.timeoutMs !== undefined && { timeout: options.timeoutMs }) });
    if (input !== undefined) {
      // A program may exit before it reads all its input; how it ended is the answer either way.
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(input);
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    // Ended at its time limit: answer now, as a child it forked may hold its output open long after.
    child.on('exit', (code, signal) => {
      if (signal !== null) {
        child.stdout?.destroy();
        child.stderr?.destroy();
        resolve({ status: code ?? 1, stdout, stderr });
      }
    });
    child.on('close', (code) => {
      resolve({ status: code ?? 1, stdout, stderr });
    });
  });
}
