import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { SHIP_PROTOCOL } from '../../../packages/server/src/adapters/trpc/ship-protocol.ts';

const claudeSkill = readFileSync(new URL('../skills/crew-a-ship/SKILL.md', import.meta.url), 'utf8');
const codexSkill = readFileSync(new URL('../skills/aeolus-crew/SKILL.md', import.meta.url), 'utf8');
const protocolRules = SHIP_PROTOCOL.split('\n').filter((line) => /^\d+\. /.test(line));

// The ship protocol lives once, in the fleet, which sends it as its MCP
// instructions; both skills point to it and hold only what the plugin adds.

describe('the crew-a-ship skill', () => {
  it("points to the fleet's MCP instructions for the ship protocol, and holds none of its rules", () => {
    expect(claudeSkill).toContain("The fleet's MCP server states the ship protocol in its instructions");
    for (const rule of protocolRules) {
      expect(claudeSkill).not.toContain(rule);
    }
  });

  it("points the Codex skill to the same MCP instructions, holding none of the rules, with its Codex crew line and harness", () => {
    expect(codexSkill).toContain('The Aeolus MCP server states the ship protocol in its instructions');
    for (const rule of protocolRules) {
      expect(codexSkill).not.toContain(rule);
    }
    expect(codexSkill).toContain('$aeolus-crew');
    expect(codexSkill).toContain('harness `codex`');
    expect(codexSkill).not.toContain('Receive, pong each operator ping');
  });

  it('tells a squadron member how to check in, take up its role, report and stand down', () => {
    const skill = claudeSkill;

    expect(skill).toContain('## A squadron member');
    expect(skill).toContain('application/vnd.aeolus.squadron.check-in+json');
    expect(skill).toContain('application/vnd.aeolus.squadron.role+json');
    expect(skill).toContain('application/vnd.aeolus.squadron.on-station+json');
    expect(skill).toContain('application/vnd.aeolus.squadron.stand-down+json');
    expect(skill).toContain('report at least once per check-in interval');
  });

  it('tells a standing-down member to ack the stand-down on receipt, finish its work, then send stood-down to its flagship', () => {
    const skill = claudeSkill;

    expect(skill).toContain('ack it on receipt');
    expect(skill).toContain(
      'send the flagship a message with contentType `application/vnd.aeolus.squadron.stood-down+json`, payload `{"squadron":"<squadron>"}` and inReplyTo the stand-down',
    );
  });

  it('tells a member whose role message says standingDown to stand down too, inReplyTo the role message', () => {
    expect(claudeSkill).toContain('If the role message says `"standingDown": true`, the squadron already stands down');
  });

  it('tells a squadron member to state the exact model it runs at check-in', () => {
    expect(claudeSkill).toContain('payload `{"squadron":"<squadron>","model":"<model>"}`, where <model> is the exact model id this session runs');
  });

  it('tells the session to start the watcher again when it exits 6 at its 2-hour limit', () => {
    expect(claudeSkill).toContain('"for almost 2 hours" (exit 6): start the watcher again, as in step 3. That is all.');
  });
});
