import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONFIGURATION } from '../../test/support/in-memory.js';
import { main, USAGE } from './main.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'trierarch-main-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('aeolus-trierarch', () => {
  it('prints its usage, exiting 2, for no command or an unknown one', async () => {
    await expect(main([], { HOME: home })).resolves.toEqual({ output: USAGE, code: 2 });
    await expect(main(['sail'], { HOME: home })).resolves.toEqual({ output: USAGE, code: 2 });
  });

  it('config check prints the effective flags per harness, reading the configuration --config names', async () => {
    const config = join(home, 'elsewhere.json');
    writeFileSync(config, JSON.stringify(CONFIGURATION));

    const { output, code } = await main(['config', 'check', '--config', config], { HOME: home });

    expect(code).toBe(0);
    expect(output).toContain(`The configuration at ${config} fits.`);
    expect(output).toContain('claude-code: --remote-control --model claude-opus-5-5');
  });

  it('reads the configuration AEOLUS_TRIERARCH_CONFIG names', async () => {
    const config = join(home, 'env.json');
    writeFileSync(config, JSON.stringify(CONFIGURATION));

    await expect(main(['config', 'check'], { HOME: home, AEOLUS_TRIERARCH_CONFIG: config })).resolves.toMatchObject({ code: 0 });
  });

  it('says to run init, exiting 1, when there is no configuration yet', async () => {
    const { output, code } = await main(['config', 'check'], { HOME: home });

    expect(code).toBe(1);
    expect(output).toBe(`No configuration at ${join(home, '.aeolus', 'trierarch', 'config.json')}: run aeolus-trierarch init first`);
  });
});
