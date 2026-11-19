import { describe, expect, it } from 'vitest';

import { createSessionImages } from './session-images.js';

const repository = 'ghcr.io/thomashendrickx/aeolus-session';

function runtime(at: { failsRemoving?: readonly string[]; hangs?: string; isMissing?: boolean; used?: readonly string[]; fails?: string; tags?: Readonly<Record<string, readonly string[]>> } = {}) {
  const removed: string[] = [];
  const tags = at.tags ?? { current: [`${repository}:1.0.0`], old: [`${repository}:0.9.0`], held: [`${repository}:0.8.0`] };
  const timeouts: (number | undefined)[] = [];
  const images = createSessionImages({ binary: 'podman', version: '1.0.0', run: (_command, { args, timeoutMs }) => {
    const [operation, action, id] = args;
    timeouts.push(timeoutMs);
    if (at.isMissing === true) return Promise.reject(Object.assign(new Error('spawn podman ENOENT'), { code: 'ENOENT' }));
    if (operation === at.hangs) return Promise.resolve({ status: 1, stdout: '', stderr: '', isTimedOut: true });
    if (operation === 'rmi' && at.failsRemoving?.includes(action ?? '') === true) return Promise.resolve({ status: 1, stdout: '', stderr: 'image has several tags' });
    if (operation === at.fails) return Promise.resolve({ status: 1, stdout: '', stderr: 'unavailable' });
    if (operation === 'image' && action === 'ls') return Promise.resolve({ status: 0, stdout: Object.keys(tags).join('\n'), stderr: '' });
    if (operation === 'image' && action === 'inspect') return Promise.resolve({ status: 0, stdout: JSON.stringify(tags[id ?? '']), stderr: '' });
    if (operation === 'ps') {
      const ancestor = args.find((arg) => arg.startsWith('ancestor='))?.slice('ancestor='.length);
      return Promise.resolve({ status: 0, stdout: at.used?.includes(ancestor ?? '') === true ? 'container' : '', stderr: '' });
    }
    if (operation === 'rmi' && action !== undefined) removed.push(action);
    return Promise.resolve({ status: 0, stdout: '', stderr: '' });
  } });
  return { images, removed, timeouts };
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

  it('removes the other images when one removal fails, then reports it', async () => {
    const { images, removed } = runtime({ tags: { first: [`${repository}:0.7.0`, `${repository}:0.7.1`], second: [`${repository}:0.9.0`] }, failsRemoving: ['first'] });
    await expect(images.removeUnused()).rejects.toThrow('image has several tags');
    expect(removed).toEqual(['second']);
  });

  it('gives every runtime command a time limit', async () => {
    const { images, timeouts } = runtime();
    await images.removeUnused();
    expect(timeouts.length).toBeGreaterThan(0);
    expect(timeouts.every((limit) => limit !== undefined && limit > 0)).toBe(true);
  });

  it('fails when a runtime command runs past its time limit', async () => {
    const { images } = runtime({ hangs: 'image' });
    await expect(images.removeUnused()).rejects.toThrow('timed out');
  });

  it('has nothing to remove, and no failure to retry, when the machine has no runtime', async () => {
    const { images } = runtime({ isMissing: true });
    await expect(images.removeUnused()).resolves.toBeUndefined();
  });
});
