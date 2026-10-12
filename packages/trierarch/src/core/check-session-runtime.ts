import type { TrierarchConfiguration } from '@aeolus-fleet/common';

import type { ContainerHostPort } from './ports.js';

/** Checks the configuration's session runtime against the machine: why it cannot run, one reason each, none when it can. */
export type CheckSessionRuntime = (configuration: TrierarchConfiguration) => Promise<readonly string[]>;

/** Container mode offers these harnesses only, until another is proven in a container (decision 0039). */
const CONTAINER_HARNESSES: readonly string[] = ['claude-code'];
const REMOTE_CONTROL = '--remote-control';
/** The group whose members drive a rootful docker daemon: root on the machine. */
const DOCKER_GROUP = 'docker';

/** Whether a flag is Remote Control's, with or without a name given with `=`. */
function isRemoteControl(flag: string): boolean {
  return flag === REMOTE_CONTROL || flag.startsWith(`${REMOTE_CONTROL}=`);
}

/**
 * Use case: the container runtime holds a session to its own ship only when
 * the runtime is rootless and the user is no docker group member, both root
 * on the machine otherwise (decision 0039). A container session has no
 * Remote Control and runs Claude Code only, with the machine's model token.
 * Sessions on the host need none of it, so nothing is asked of the machine.
 */
export function createCheckSessionRuntime(deps: { host: ContainerHostPort; modelTokenFile: string }): CheckSessionRuntime {
  return async (configuration) => {
    const { runtime } = configuration;
    if (runtime?.kind !== 'container') {
      return [];
    }
    const mode = await deps.host.runtimeMode(runtime.binary);
    const refusals: string[] = [];
    if (mode === 'rootful') {
      refusals.push(`${runtime.binary} runs rootful: the container runtime runs rootless only, as the user that runs the trierarch`);
    } else if (mode === 'missing') {
      refusals.push(`${runtime.binary} does not answer: install a rootless podman, or name the runtime binary in runtime.binary`);
    }
    if ((await deps.host.userGroups()).includes(DOCKER_GROUP)) {
      refusals.push('the user that runs the trierarch is in the docker group, which is root on the machine: take the user out of it');
    }
    for (const [harness, settings] of Object.entries(configuration.harnesses)) {
      if (!CONTAINER_HARNESSES.includes(harness)) {
        refusals.push(`${harness} does not run in a container yet: the container runtime offers ${CONTAINER_HARNESSES.join(', ')} only, so remove ${harness}`);
      }
      const launched = [...settings.flags, ...Object.values(settings.options).flatMap((option) => Object.values(option.values).flat())];
      if (launched.some(isRemoteControl)) {
        refusals.push(`${harness} launches with ${REMOTE_CONTROL}: a session in a container has no Remote Control, so remove it`);
      }
    }
    if (!(await deps.host.isModelTokenWritten())) {
      refusals.push(`the model token file ${deps.modelTokenFile} is missing or empty: write the token claude setup-token gives into it, readable by its owner only`);
    }
    return refusals;
  };
}
