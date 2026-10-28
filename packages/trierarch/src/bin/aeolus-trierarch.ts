#!/usr/bin/env node
/**
 * `aeolus-trierarch`: runs a trierarch on this machine (docs/trierarch.md).
 * See `main.ts` for its commands. A session's hold (`hold`) and the model
 * proxy (`proxy`) load only what they need: they run for as long as the
 * sessions do.
 */
const [command, ...words] = process.argv.slice(2);
if (command === 'hold') {
  const { holdCommand } = await import('../cli/hold.js');
  process.exitCode = await holdCommand(words, { env: process.env, platform: process.platform });
} else if (command === 'proxy') {
  const { proxyCommand } = await import('../cli/proxy.js');
  process.exitCode = await proxyCommand(words);
} else {
  const { CLAUDE_CODE_MANAGED_SETTINGS } = await import('../adapters/claude-code-setup.js');
  const { main } = await import('../cli/main.js');
  const outcome = await main(process.argv.slice(2), { env: process.env, managedSettings: CLAUDE_CODE_MANAGED_SETTINGS, platform: process.platform });
  if (outcome.output !== '') {
    process.stdout.write(`${outcome.output}\n`);
  }
  process.exitCode = outcome.code;
}
