import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PLUGIN_DATA_FOLDER } from './plugin.js';
import { runCommand } from './run-command.js';

/**
 * Whether Codex keeps the aeolus plugin's data folder, which holds its log
 * and the crew identities not yet moved to ~/.aeolus/crews (decision 0015),
 * when its aeolus-fleet marketplace is removed (#660).
 * Trierarch upgrade removes that marketplace to point it elsewhere, so it asks
 * first: the Codex given installs an aeolus plugin of its own from a local
 * aeolus-fleet marketplace in a throwaway CODEX_HOME, a mark goes in the
 * plugin's data folder, and the marketplace is removed. The real Codex home
 * is never touched. Throws, saying what Codex said, when Codex cannot run it.
 */
export async function codexKeepsPluginData(codex: string): Promise<boolean> {
  const folder = await mkdtemp(join(tmpdir(), 'aeolus-codex-plugin-data-'));
  try {
    const marketplace = join(folder, 'marketplace');
    const codexHome = join(folder, 'codex-home');
    await mkdir(join(marketplace, '.agents', 'plugins'), { recursive: true });
    await mkdir(join(marketplace, 'plugins', 'aeolus', '.codex-plugin'), { recursive: true });
    await mkdir(codexHome);
    await writeFile(
      join(marketplace, '.agents', 'plugins', 'marketplace.json'),
      JSON.stringify({ name: 'aeolus-fleet', plugins: [{ name: 'aeolus', source: { source: 'local', path: './plugins/aeolus' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } }] }),
    );
    await writeFile(join(marketplace, 'plugins', 'aeolus', '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'aeolus', version: '0.0.0', description: 'The aeolus plugin data proof of aeolus-trierarch.' }));

    const run = async (args: readonly string[]): Promise<void> => {
      const result = await runCommand(codex, { args, env: { CODEX_HOME: codexHome } });
      if (result.status !== 0) {
        throw new Error(`codex ${args.join(' ')} failed: ${`${result.stdout}${result.stderr}`.trim()}`);
      }
    };
    await run(['plugin', 'marketplace', 'add', marketplace]);
    await run(['plugin', 'add', 'aeolus@aeolus-fleet']);
    const data = join(codexHome, 'plugins', 'data', PLUGIN_DATA_FOLDER);
    await mkdir(data, { recursive: true });
    await writeFile(join(data, 'mark'), 'kept\n');
    await run(['plugin', 'marketplace', 'remove', 'aeolus-fleet']);
    return (await readFile(join(data, 'mark'), 'utf8').catch(() => undefined)) === 'kept\n';
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
