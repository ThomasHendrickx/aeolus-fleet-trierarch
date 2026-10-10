import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { HarnessDetector } from '../core/ports.js';
import { createClaudeCodeDetector } from './claude-code-detector.js';
import { createCodexDetector } from './codex-detector.js';
import { runCommand } from './run-command.js';

/** The detector of each harness this trierarch has an adapter for (#365), running the real CLIs. */
export function createDetectors(at: { homeDirectory: string; env: Readonly<Record<string, string | undefined>> }): Record<string, HarnessDetector> {
  return {
    'claude-code': createClaudeCodeDetector({
      run: runCommand,
      // A new empty folder per detection: no project's hooks, settings or identity apply, so a probe is never a ship.
      neutralFolder: () => mkdtemp(join(tmpdir(), 'aeolus-trierarch-probe-')),
    }),
    codex: createCodexDetector({
      run: runCommand,
      // Codex's configuration where Codex keeps it: in CODEX_HOME when it is set (#521).
      readConfig: () => readFile(join(at.env.CODEX_HOME ?? join(at.homeDirectory, '.codex'), 'config.toml'), 'utf8').catch(() => undefined),
      // As for Claude Code: a new empty folder per detection, so a probe is never a ship.
      neutralFolder: () => mkdtemp(join(tmpdir(), 'aeolus-trierarch-probe-')),
    }),
  };
}
