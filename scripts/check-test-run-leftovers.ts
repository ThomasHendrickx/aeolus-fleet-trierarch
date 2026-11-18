/** Checks a clean CI runner after a test job, allowing its sweeper time to finish. */
import { execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

import { z } from 'zod';

const LABELS = ['aeolus-fleet.test-run', 'aeolus.trierarch.test-run'];
const exec = promisify(execFile);
interface Container { Id: string; Image: string; State: string; Labels: Record<string, string> }
interface Runtime {
  listContainers: (options: { filters: { label: string[] } }) => Promise<Container[]>;
  listVolumes: (options: { filters: { dangling: string[] } }) => Promise<{ Volumes: { Name: string }[] }>;
}

/** Lists both kinds of test container and unused volumes on a clean CI runner. */
export async function testRunLeftovers(runtime: Runtime): Promise<string[]> {
  const containers = await Promise.all(LABELS.map(async (label) => ({ label, items: await runtime.listContainers({ filters: { label: [label] } }) })));
  const { Volumes: volumes } = await runtime.listVolumes({ filters: { dangling: ['true'] } });
  return [
    ...containers.flatMap(({ label, items }) => items.map((container) => `container ${container.Id} (${container.Image}, ${container.State}) of test run ${container.Labels[label] ?? ''}`)),
    ...volumes.map((volume) => `volume ${volume.Name}, used by no container`),
  ];
}

/** Uses the named runtime's own CLI, including rootless Podman's separate store. */
function runtimeOf(binary: string): Runtime {
  return {
    async listContainers({ filters }) {
      const { stdout } = await exec(binary, ['ps', '--all', '--filter', `label=${filters.label[0] ?? ''}`, '--format', '{{.ID}}']);
      const ids = stdout.trim().split('\n').filter(Boolean);
      if (ids.length === 0) return [];
      const inspected = await exec(binary, ['inspect', ...ids]);
      const inspectSchema = z.array(z.object({ Id: z.string(), Config: z.object({ Image: z.string(), Labels: z.record(z.string(), z.string()).nullable() }), State: z.object({ Status: z.string() }) }));
      return inspectSchema.parse(JSON.parse(inspected.stdout)).map((item) => ({ Id: item.Id, Image: item.Config.Image, State: item.State.Status, Labels: item.Config.Labels ?? {} }));
    },
    async listVolumes() {
      const { stdout } = await exec(binary, ['volume', 'ls', '--filter', 'dangling=true', '--format', '{{.Name}}']);
      return { Volumes: stdout.trim().split('\n').filter(Boolean).map((Name) => ({ Name })) };
    },
  };
}

if (import.meta.main) {
  const runtime = runtimeOf(process.argv[2] ?? 'docker');
  const deadline = Date.now() + 30_000;
  let leftovers = await testRunLeftovers(runtime);
  while (leftovers.length > 0 && Date.now() < deadline) {
    await sleep(1_000);
    leftovers = await testRunLeftovers(runtime);
  }
  if (leftovers.length === 0) {
    console.log('The test run left no container and no volume behind.');
  } else {
    console.error(`The test run left ${String(leftovers.length)} behind:\n${leftovers.map((item) => `- ${item}`).join('\n')}`);
    process.exitCode = 1;
  }
}
