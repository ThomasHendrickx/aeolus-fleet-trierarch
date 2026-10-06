#!/usr/bin/env node
/**
 * `aeolus-trierarch`: runs a trierarch on this machine (docs/trierarch.md).
 * See `main.ts` for its commands.
 */
import { main } from '../cli/main.js';

const outcome = await main(process.argv.slice(2));
if (outcome.output !== '') {
  process.stdout.write(`${outcome.output}\n`);
}
process.exitCode = outcome.code;
