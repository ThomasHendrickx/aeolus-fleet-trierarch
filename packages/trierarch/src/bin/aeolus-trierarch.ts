#!/usr/bin/env node
/**
 * `aeolus-trierarch`: the command that runs a trierarch on this machine. Its
 * commands (init, run, config check, install) come with the adapters; until
 * then it says so.
 */
process.stdout.write('Usage: aeolus-trierarch init | run | config check | install (coming with the adapters)\n');
process.exitCode = 2;
