import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

// What the plugin's commands tell the session, where a script cannot decide it.

function command(name: string): string {
  return readFileSync(new URL(`../commands/${name}.md`, import.meta.url), 'utf8');
}

describe('/aeolus:crew', () => {
  it('asks aeolus-mcp-hint for how to connect the fleet MCP server, which differs in a claude.ai cloud session', () => {
    expect(command('crew')).toContain('run `"${CLAUDE_PLUGIN_ROOT}/scripts/aeolus-mcp-hint.sh" \'<fleet URL>\'`');
  });

  it('takes the squadron id of a member ship as an optional fourth argument, keeps it, and checks in', () => {
    expect(command('crew')).toContain('argument-hint: <fleetUrl> <shipId> <secret> [<squadronId>]');
    expect(command('crew')).toContain("write '<fleet URL>' '<ship id>' '<ship name>' '<crew token>' '<squadron id>'");
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
    expect(command('wake')).toContain('call `whoami`');
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
