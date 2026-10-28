import { fileURLToPath } from 'node:url';

/** The trierarch program from source, as a test runs it: Node with the source loader, then the bin, so `[...TRIERARCH_PROGRAM, 'hold', ...]` starts a hold. */
export const TRIERARCH_PROGRAM: readonly string[] = [process.execPath, '--import', fileURLToPath(new URL('./source-loader.ts', import.meta.url)), fileURLToPath(new URL('../../src/bin/aeolus-trierarch.ts', import.meta.url))];

/** The stand-in for Claude Code in print mode with streamed JSON, as a command: add its flags after. */
export const FAKE_CLAUDE_CODE: readonly string[] = [process.execPath, fileURLToPath(new URL('./fake-claude-code.ts', import.meta.url))];

/** The stand-in for `codex exec --json`, as a command: `exec`, its flags, then `--` and the prompt after. */
export const FAKE_CODEX: readonly string[] = [process.execPath, fileURLToPath(new URL('./fake-codex.ts', import.meta.url))];
