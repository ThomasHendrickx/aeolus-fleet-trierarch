import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { createClaudeCodeSetup } from '../adapters/claude-code-setup.js';
import { TrierarchFileError } from '../adapters/files.js';
import { trierarchPaths } from '../adapters/paths.js';
import { createRestFleet } from '../adapters/rest-fleet.js';
import { runCommand } from '../adapters/run-command.js';
import { createService, serviceEnvironment } from '../adapters/service.js';
import { configCheck } from './config-check.js';
import { initTrierarch } from './init.js';
import { createTerminalPrompter } from './prompter.js';
import { runTrierarch } from './run.js';

export const USAGE = [
  'Usage: aeolus-trierarch <command> [--config <path>]',
  '  init <fleetUrl> <shipId> <secret>   register the trierarch\'s own ship (commissioned with fleet:crew) and write a configuration',
  '  config check                       check the configuration and print the effective flags per harness',
  '  run                                keep the wanted ships crewed until stopped',
  '  install [--no-load]                run it under launchd (macOS) or systemd (Linux)',
].join('\n');

/** The command's own words: its output and its exit code. */
export interface Outcome {
  readonly output: string;
  readonly code: number;
}

/** Runs one command line of `aeolus-trierarch`. */
export async function main(argv: readonly string[], env: Readonly<Record<string, string | undefined>> = process.env): Promise<Outcome> {
  const args = [...argv];
  const configAt = args.indexOf('--config');
  const config = configAt === -1 ? env.AEOLUS_TRIERARCH_CONFIG : args.splice(configAt, 2)[1];
  const homeDirectory = env.HOME ?? homedir();
  const paths = trierarchPaths({ homeDirectory, ...(config !== undefined && { config }) });
  const [command = '', ...rest] = args;
  const serviceAt = () =>
    createService({
      platform: process.platform,
      homeDirectory,
      paths,
      run: { node: process.execPath, script: fileURLToPath(new URL('../bin/aeolus-trierarch.js', import.meta.url)) },
      environment: serviceEnvironment(env),
      uid: process.getuid?.() ?? 0,
      exec: (program, args) => runCommand(program, { args }),
      now: () => new Date(),
    });
  try {
    switch (command) {
      case 'init': {
        const valueOf = (name: string): string | undefined => {
          const at = rest.indexOf(name);
          return at === -1 ? undefined : rest[at + 1];
        };
        const prompter = createTerminalPrompter({ input: process.stdin, output: process.stdout });
        try {
          const report = await initTrierarch({
            homeDirectory,
            paths,
            flags: {
              ...(valueOf('--fleet-url') !== undefined && { fleetUrl: valueOf('--fleet-url') }),
              ...(valueOf('--ship-id') !== undefined && { shipId: valueOf('--ship-id') }),
              ...(valueOf('--secret') !== undefined && { secret: valueOf('--secret') }),
              isYes: rest.includes('--yes'),
            },
            prompter,
            fleetAt: (url) => createRestFleet({ fleetUrl: url, crewToken: '' }),
            claudeCode: createClaudeCodeSetup({ homeDirectory }),
            service: serviceAt(),
          });
          return { output: report.said.join('\n'), code: 0 };
        } finally {
          prompter.close();
        }
      }
      case 'config':
        return rest[0] === 'check' ? { output: await configCheck(paths), code: 0 } : { output: USAGE, code: 2 };
      case 'install': {
        const service = serviceAt();
        await (rest.includes('--no-load') ? service.write() : service.install());
        return { output: `Installed ${(await service.status()).file}. Logs: ${paths.logs}`, code: 0 };
      }
      case 'run': {
        const stopping = new AbortController();
        process.once('SIGINT', () => {
          stopping.abort();
        });
        process.once('SIGTERM', () => {
          stopping.abort();
        });
        const logger = {
          info: (message: string) => process.stdout.write(`${new Date().toISOString()} ${message}\n`),
          warn: (message: string) => process.stderr.write(`${new Date().toISOString()} ${message}\n`),
        };
        await runTrierarch({ paths, homeDirectory, env, signal: stopping.signal, logger });
        return { output: 'aeolus-trierarch stopped.', code: 0 };
      }
      default:
        return { output: USAGE, code: 2 };
    }
  } catch (error) {
    if (error instanceof TrierarchFileError) {
      return { output: error.message, code: 1 };
    }
    throw error;
  }
}
