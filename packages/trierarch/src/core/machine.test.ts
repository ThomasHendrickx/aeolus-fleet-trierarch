import { describe, expect, it } from 'vitest';

import { machineOf } from './machine.js';

describe('the machine a trierarch reports (#102, docs/trierarch.md, Machine labels)', () => {
  it.each([
    { platform: 'darwin', arch: 'arm64', machine: { os: 'macos', arch: 'arm64' } },
    { platform: 'linux', arch: 'x64', machine: { os: 'linux', arch: 'amd64' } },
    { platform: 'win32', arch: 'x64', machine: { os: 'windows', arch: 'amd64' } },
  ])('names $platform on $arch by the os and arch the trierarch plugin labels it with', ({ platform, arch, machine }) => {
    expect(machineOf({ platform, arch })).toEqual(machine);
  });

  it('leaves out an os or arch outside the known ones', () => {
    expect([machineOf({ platform: 'freebsd', arch: 'x64' }), machineOf({ platform: 'linux', arch: 'ppc64' })]).toEqual([{ arch: 'amd64' }, { os: 'linux' }]);
  });
});
