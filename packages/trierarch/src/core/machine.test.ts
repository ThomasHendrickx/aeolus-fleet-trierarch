import { describe, expect, it } from 'vitest';

import { machineOf } from './machine.js';

describe('the machine a trierarch reports (#102, docs/trierarch.md, Machine labels)', () => {
  it.each([
    ['darwin', 'arm64', { os: 'macos', arch: 'arm64' }],
    ['linux', 'x64', { os: 'linux', arch: 'amd64' }],
    ['win32', 'x64', { os: 'windows', arch: 'amd64' }],
  ] as const)('names %s on %s by the os and arch the trierarch plugin labels it with', (platform, arch, machine) => {
    expect(machineOf({ platform, arch })).toEqual(machine);
  });

  it('leaves out an os or arch outside the known ones', () => {
    expect([machineOf({ platform: 'freebsd', arch: 'x64' }), machineOf({ platform: 'linux', arch: 'ppc64' })]).toEqual([{ arch: 'amd64' }, { os: 'linux' }]);
  });
});
