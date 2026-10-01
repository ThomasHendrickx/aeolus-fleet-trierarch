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

  it('says plainly what to do when register refuses because the ship is already crewed', () => {
    expect(command('crew')).toContain(
      'release the ship in the console, then get a new crew line there and paste it here',
    );
  });
});
