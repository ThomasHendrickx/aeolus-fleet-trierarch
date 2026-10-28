#!/usr/bin/env node
/**
 * `aeolus-trierarch`: runs a trierarch on this machine (docs/trierarch.md).
 * See `main.ts` for its commands. A session's hold (`hold`) loads only what it
 * needs: one runs per session, for as long as the session.
 */
const [command, ...words] = process.argv.slice(2);
if (command === 'hold') {
  const { holdCommand } = await import('../cli/hold.js');
  process.exitCode = await holdCommand(words, { env: process.env, platform: process.platform });
} else {
  const { CLAUDE_CODE_MANAGED_SETTINGS } = await import('../adapters/claude-code-setup.js');
  const { main } = await import('../cli/main.js');
  const outcome = await main(process.argv.slice(2), { env: process.env, managedSettings: CLAUDE_CODE_MANAGED_SETTINGS, platform: process.platform });
  if (outcome.output !== '') {
    process.stdout.write(`${outcome.output}\n`);
  }
  process.exitCode = outcome.code;
}
