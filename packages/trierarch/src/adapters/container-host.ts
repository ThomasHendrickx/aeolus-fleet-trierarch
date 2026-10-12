import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import type { ContainerHostPort, RuntimeMode } from '../core/ports.js';
import { runCommand, type CommandResult } from './run-command.js';

type Run = (command: string, options: { args: readonly string[] }) => Promise<CommandResult>;

/** What Podman's info says of how it runs. */
const podmanInfoSchema = z.object({ host: z.object({ security: z.object({ rootless: z.boolean() }) }) });
/** What docker's info says of how its daemon runs: `name=rootless` among its security options when rootless. */
const dockerInfoSchema = z.object({ SecurityOptions: z.array(z.string()) });
const DOCKER_ROOTLESS = 'name=rootless';

function modeOfInfo(stdout: string): RuntimeMode {
  let body: unknown;
  try {
    body = JSON.parse(stdout);
  } catch {
    return 'missing';
  }
  const podman = podmanInfoSchema.safeParse(body);
  if (podman.success) {
    return podman.data.host.security.rootless ? 'rootless' : 'rootful';
  }
  const docker = dockerInfoSchema.safeParse(body);
  if (docker.success) {
    return docker.data.SecurityOptions.includes(DOCKER_ROOTLESS) ? 'rootless' : 'rootful';
  }
  return 'missing';
}

/**
 * The machine as the container runtime's checks read it (decision 0039): how
 * the runtime runs, from the info Podman and docker both give as JSON; the
 * user's groups, from `id`; and whether the model token file holds a token.
 */
export function createContainerHost(options: { modelTokenFile: string; run?: Run }): ContainerHostPort {
  const run = options.run ?? runCommand;
  return {
    runtimeMode: async (binary) => {
      const answered = await run(binary, { args: ['info', '--format', 'json'] }).catch(() => undefined);
      return answered?.status === 0 ? modeOfInfo(answered.stdout) : 'missing';
    },
    userGroups: async () => {
      const answered = await run('id', { args: ['-Gn'] });
      if (answered.status !== 0) {
        throw new Error(`id -Gn failed: ${answered.stderr.trim()}`);
      }
      return answered.stdout.split(/\s+/).filter((group) => group !== '');
    },
    isModelTokenWritten: async () => {
      const content = await readFile(options.modelTokenFile, 'utf8').catch(() => '');
      return content.trim() !== '';
    },
  };
}
