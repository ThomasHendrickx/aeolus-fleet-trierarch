import type { TrierarchConfiguration } from '@aeolus-fleet/common';

import type { ContainerHostPort } from './ports.js';
import { isRemoteControl, REMOTE_CONTROL } from './remote-control.js';

/** Checks the configuration's session runtime against the machine: why it cannot run, one reason each, none when it can. */
export type CheckSessionRuntime = (configuration: TrierarchConfiguration) => Promise<readonly string[]>;

/** Container mode offers these harnesses only, until another is proven in a container (decision 0039). */
const CONTAINER_HARNESSES: readonly string[] = ['claude-code'];
/** Harnesses the configuration may hold in container mode, which the trierarch then names as not offered rather than refusing it (CC10). */
const NOT_OFFERED_IN_CONTAINERS: readonly string[] = ['copilot'];
/** The group whose members drive a rootful docker daemon: root on the machine. */
const DOCKER_GROUP = 'docker';

/**
 * Use case: the container runtime holds a session to its own ship only when
 * the runtime is rootless and the user is no docker group member, both root
 * on the machine otherwise (decision 0039). A container session runs
 * Claude Code only, with the machine's model token. Sessions on the host need
 * none of it, so nothing is asked of the machine. No session the trierarch
 * runs has a terminal, so none has Remote Control, on any runtime (headless
 * H20).
 */
export function createCheckSessionRuntime(deps: { host: ContainerHostPort; modelTokenFile: string }): CheckSessionRuntime {
  return async (configuration) => {
    const { runtime } = configuration;
    const remoteControl = Object.entries(configuration.harnesses).flatMap(([harness, settings]) => {
      const launched = [...settings.flags, ...Object.values(settings.options).flatMap((option) => Object.values(option.values).flat())];
      return launched.some(isRemoteControl) ? [`${harness} launches with ${REMOTE_CONTROL}: a session the trierarch runs has no terminal and no Remote Control, so remove it`] : [];
    });
    if (runtime?.kind !== 'container') {
      return remoteControl;
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
    for (const harness of Object.keys(configuration.harnesses)) {
      if (!CONTAINER_HARNESSES.includes(harness) && !NOT_OFFERED_IN_CONTAINERS.includes(harness)) {
        refusals.push(`${harness} does not run in a container yet: the container runtime offers ${CONTAINER_HARNESSES.join(', ')} only, so remove ${harness}`);
      }
    }
    refusals.push(...remoteControl);
    if (!(await deps.host.isModelTokenWritten())) {
      refusals.push(`the model token file ${deps.modelTokenFile} is missing or empty: write the token claude setup-token gives into it, readable by its owner only`);
    }
    return refusals;
  };
}
