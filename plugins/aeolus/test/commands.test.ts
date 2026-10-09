import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

// What the plugin's commands tell the session, where a script cannot decide it.

function command(name: string): string {
  return readFileSync(new URL(`../commands/${name}.md`, import.meta.url), 'utf8');
}

const COMMANDS = ['crew', 'deregister', 'issue', 'ship', 'wake', 'watch'];

describe('every command', () => {
  it('leaves the crew token to the scripts: none has the session read or pass it', () => {
    for (const name of COMMANDS) {
      expect(command(name)).not.toMatch(/crewToken|the crew token/);
    }
  });
});

describe('/aeolus:crew', () => {
  it('registers through aeolus-fleet.sh, which keeps the crew token, so it needs no fleet MCP server', () => {
    expect(command('crew')).toContain(`"\${CLAUDE_PLUGIN_ROOT}/scripts/aeolus-fleet.sh" register '<fleet URL>' '<ship id>' '<secret>' '<location>'`);
    expect(command('crew')).not.toContain('aeolus-mcp-hint');
    expect(command('crew')).not.toContain('aeolus-identity.sh" write');
  });

  it('takes the squadron id of a member ship as an optional fourth argument, keeps it, and checks in', () => {
    expect(command('crew')).toContain('argument-hint: <fleetUrl> <shipId> <secret> [<squadronId>]');
    expect(command('crew')).toContain("register '<fleet URL>' '<ship id>' '<secret>' '<location>' '<squadron id>'");
    expect(command('crew')).toContain('check in at its flagship as the crew-a-ship skill says for a squadron member');
  });

  it('says plainly what to do when register refuses because the ship is already crewed', () => {
    expect(command('crew')).toContain(
      'release the ship in the console, then get a new crew line there and paste it here',
    );
  });
});

describe('/aeolus:wake', () => {
  it('checks the identity and the lease first, and stops on LEASE_ENDED as the crew-a-ship skill says', () => {
    expect(command('wake')).toContain('"${CLAUDE_PLUGIN_ROOT}/scripts/aeolus-identity.sh" show');
    expect(command('wake')).toContain('"${CLAUDE_PLUGIN_ROOT}/scripts/aeolus-fleet.sh" whoami');
    expect(command('wake')).toContain('LEASE_ENDED');
  });

  it('receives and handles every waiting delivery: ack each, act only if the ack succeeded, receive again until empty', () => {
    expect(command('wake')).toContain('receive');
    expect(command('wake')).toContain('act only if the ack succeeded');
    expect(command('wake')).toContain('until it answers empty');
  });

  it('makes sure the watcher runs, starting it again unless it says watching', () => {
    expect(command('wake')).toContain('"${CLAUDE_PLUGIN_ROOT}/scripts/aeolus-watch-status.sh"');
    expect(command('wake')).toContain('"${CLAUDE_PLUGIN_ROOT}/scripts/aeolus-wait.sh"');
    expect(command('wake')).toContain('run_in_background');
  });

  it("reports the ship's status: name, id, deliveries handled, watcher and lease", () => {
    expect(command('wake')).toContain('deliveries handled');
    expect(command('wake')).toContain('watcher already running or started again');
  });
});

describe('/aeolus:ship and /aeolus:deregister', () => {
  it('ask whoami and deregister through aeolus-fleet.sh', () => {
    expect(command('ship')).toContain('"${CLAUDE_PLUGIN_ROOT}/scripts/aeolus-fleet.sh" whoami');
    expect(command('deregister')).toContain('"${CLAUDE_PLUGIN_ROOT}/scripts/aeolus-fleet.sh" deregister');
  });
});
