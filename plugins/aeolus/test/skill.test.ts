import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { SHIP_PROTOCOL } from '../../../packages/server/src/adapters/trpc/ship-protocol.ts';
import { CODEX_PLUGIN_SKILL_PATH, codexPluginSkill, PLUGIN_SKILL_PATH, pluginSkill } from '../../../scripts/generate-plugin-skill.ts';

// The plugin and the fleet state the ship protocol in one text: the skill is
// generated from the constant the fleet sends, and kept in step by this test.

describe('the crew-a-ship skill', () => {
  it('is what the generator writes from the fleet\'s ship protocol: run npm run generate:plugin-skill when it differs', () => {
    expect(readFileSync(PLUGIN_SKILL_PATH, 'utf8')).toBe(pluginSkill());
  });

  it("holds the fleet's ship protocol word for word", () => {
    expect(readFileSync(PLUGIN_SKILL_PATH, 'utf8')).toContain(SHIP_PROTOCOL);
  });

  it("generates the Codex skill from the same fleet protocol", () => {
    expect(readFileSync(CODEX_PLUGIN_SKILL_PATH, 'utf8')).toBe(codexPluginSkill());
    expect(codexPluginSkill()).toContain(SHIP_PROTOCOL);
    expect(codexPluginSkill()).toContain('$aeolus-crew');
    expect(codexPluginSkill()).toContain('harness `codex`');
  });

  it('tells a squadron member how to check in, take up its role, report and stand down', () => {
    const skill = pluginSkill();

    expect(skill).toContain('## A squadron member');
    expect(skill).toContain('application/vnd.aeolus.squadron.check-in+json');
    expect(skill).toContain('application/vnd.aeolus.squadron.role+json');
    expect(skill).toContain('application/vnd.aeolus.squadron.on-station+json');
    expect(skill).toContain('application/vnd.aeolus.squadron.stand-down+json');
    expect(skill).toContain('report at least once per check-in interval');
  });

  it('tells a standing-down member to ack the stand-down on receipt, finish its work, then send stood-down to its flagship', () => {
    const skill = pluginSkill();

    expect(skill).toContain('ack it on receipt');
    expect(skill).toContain(
      'send the flagship a message with contentType `application/vnd.aeolus.squadron.stood-down+json`, payload `{"squadron":"<squadron>"}` and inReplyTo the stand-down',
    );
  });

  it('tells a member whose role message says standingDown to stand down too, inReplyTo the role message', () => {
    expect(pluginSkill()).toContain('If the role message says `"standingDown": true`, the squadron already stands down');
  });

  it('tells a squadron member to state the exact model it runs at check-in', () => {
    expect(pluginSkill()).toContain('payload `{"squadron":"<squadron>","model":"<model>"}`, where <model> is the exact model id this session runs');
  });

  it('tells the session to start the watcher again when it exits 6 at its 2-hour limit', () => {
    expect(pluginSkill()).toContain('"for almost 2 hours" (exit 6): start the watcher again, as in step 3. That is all.');
  });
});
