#!/usr/bin/env node
/**
 * `aeolus-trierarch`: runs a trierarch on this machine (docs/trierarch.md).
 * See `main.ts` for its commands.
 */
import { CLAUDE_CODE_MANAGED_SETTINGS } from '../adapters/claude-code-setup.js';
import { main } from '../cli/main.js';

const outcome = await main(process.argv.slice(2), { env: process.env, managedSettings: CLAUDE_CODE_MANAGED_SETTINGS });
if (outcome.output !== '') {
  process.stdout.write(`${outcome.output}\n`);
}
process.exitCode = outcome.code;
