import { spawn } from 'node:child_process';

/** What a program printed and how it ended. */
export interface CommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a program with its arguments and optional input, no shell, and answers how it ended rather than throwing on a non-zero exit. */
export function runCommand(command: string, options: { args: readonly string[]; env?: Readonly<Record<string, string>>; cwd?: string; input?: string }): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...options.args], { env: { ...process.env, ...options.env }, cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end(options.input ?? '');
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ status: code ?? 1, stdout, stderr });
    });
  });
}
