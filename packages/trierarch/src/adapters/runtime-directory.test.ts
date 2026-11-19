import { chmodSync, realpathSync, rmSync } from 'node:fs';

import { expect, it } from 'vitest';

import { aShortHome } from '../../test/support/short-home.js';
import { runtimeDirectoryOf } from './paths.js';

it('uses the named XDG runtime directory when it is set', async () => {
  expect(await runtimeDirectoryOf({ xdg: '/custom/runtime', fallback: '/missing', uid: 123 })).toBe('/custom/runtime');
});

it('uses the user runtime directory when XDG is unset and it is private and owned', async () => {
  const fallback = realpathSync(aShortHome('runtime-root'));
  try {
    expect(await runtimeDirectoryOf({ fallback, uid: process.getuid?.() ?? -1 })).toBe(fallback);
  } finally {
    rmSync(fallback, { recursive: true, force: true });
  }
});

it('refuses the fallback runtime directory when missing, not private or not owned', async () => {
  const fallback = realpathSync(aShortHome('runtime-root'));
  try {
    const uid = process.getuid?.() ?? -1;
    expect(await runtimeDirectoryOf({ fallback: `${fallback}/missing`, uid })).toBeUndefined();
    expect(await runtimeDirectoryOf({ fallback, uid: uid + 1 })).toBeUndefined();
    chmodSync(fallback, 0o755);
    expect(await runtimeDirectoryOf({ fallback, uid })).toBeUndefined();
  } finally {
    rmSync(fallback, { recursive: true, force: true });
  }
});
