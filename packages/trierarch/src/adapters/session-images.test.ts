import { describe, expect, it } from 'vitest';

import { createSessionImages } from './session-images.js';

const repository = 'ghcr.io/thomashendrickx/aeolus-session';

function runtime(at: { used?: readonly string[]; fails?: string; tags?: Readonly<Record<string, readonly string[]>> } = {}) {
  const removed: string[] = [];
  const tags = at.tags ?? { current: [`${repository}:1.0.0`], old: [`${repository}:0.9.0`], held: [`${repository}:0.8.0`] };
  const images = createSessionImages({ binary: 'podman', version: '1.0.0', run: async (_command, { args }) => {
    const [operation, action, id] = args;
    if (operation === at.fails) return { status: 1, stdout: '', stderr: 'unavailable' };
    if (operation === 'image' && action === 'ls') return { status: 0, stdout: Object.keys(tags).join('\n'), stderr: '' };
    if (operation === 'image' && action === 'inspect') return { status: 0, stdout: JSON.stringify(tags[id ?? '']), stderr: '' };
    if (operation === 'ps') {
      const ancestor = args.find((arg) => arg.startsWith('ancestor='))?.slice('ancestor='.length);
      return { status: 0, stdout: at.used?.includes(ancestor ?? '') === true ? 'container' : '', stderr: '' };
    }
    if (operation === 'rmi' && action !== undefined) removed.push(action);
    return { status: 0, stdout: '', stderr: '' };
  } });
  return { images, removed };
}

describe('unused session images', () => {
  it('removes old session images but keeps this version and every image a container uses', async () => {
    const { images, removed } = runtime({ used: ['held'] });
    await images.removeUnused();
    expect(removed).toEqual(['old']);
  });

  it('leaves images with a host tag or a different repository alone', async () => {
    const { images, removed } = runtime({ tags: { host: ['host:latest'], shared: [`${repository}:0.9.0`, 'host:shared'] } });
    await images.removeUnused();
    expect(removed).toEqual([]);
  });

  it('removes nothing when the runtime cannot tell which containers use an image', async () => {
    const { images, removed } = runtime({ fails: 'ps' });
    await expect(images.removeUnused()).rejects.toThrow('unavailable');
    expect(removed).toEqual([]);
  });

  it('reports a failed removal without forcing an image out from under a container', async () => {
    const { images } = runtime({ fails: 'rmi' });
    await expect(images.removeUnused()).rejects.toThrow('unavailable');
  });
});
