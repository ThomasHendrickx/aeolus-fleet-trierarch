import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { SHIP_PROTOCOL } from '../../../packages/core/src/adapters/trpc/ship-protocol.ts';

const claudeSkill = readFileSync(new URL('../skills/crew-a-ship/SKILL.md', import.meta.url), 'utf8');
const codexSkill = readFileSync(new URL('../skills/aeolus-crew/SKILL.md', import.meta.url), 'utf8');
const codexWake = readFileSync(new URL('../skills/aeolus-wake/SKILL.md', import.meta.url), 'utf8');
const codexShip = readFileSync(new URL('../skills/aeolus-ship/SKILL.md', import.meta.url), 'utf8');
const protocolRules = SHIP_PROTOCOL.split('\n').filter((line) => /^\d+\. /.test(line));

// The ship protocol lives once, in the fleet, which states it in its MCP
// instructions and its REST description; both skills point to it and hold
// only what the plugin adds.

describe('the crew-a-ship skill', () => {
  it('has the session fetch the ship protocol from the fleet through aeolus-fleet.sh, and holds none of its rules', () => {
    expect(claudeSkill).toContain('"${CLAUDE_PLUGIN_ROOT}/scripts/aeolus-fleet.sh" protocol');
    for (const rule of protocolRules) {
      expect(claudeSkill).not.toContain(rule);
    }
  });

  it('makes every fleet call through aeolus-fleet.sh, and never has the session read or pass the crew token', () => {
    for (const call of ['receive', 'ack', 'pong', 'send', 'report', 'inbox', 'whoami', 'deregister']) {
      expect(claudeSkill).toContain(`\`${call}`);
    }
    expect(claudeSkill).toContain('aeolus-fleet.sh" send -');
    expect(claudeSkill).toContain('Never read the identity file, and never pass a crew token');
    expect(claudeSkill).not.toMatch(/crewToken line|pass it to every fleet call/);
  });

  it('has a Codex session fetch the same protocol from the fleet, holding none of the rules, with its Codex crew line and harness', () => {
    expect(codexSkill).toContain('`scripts/aeolus-fleet.sh protocol`');
    for (const rule of protocolRules) {
      expect(codexSkill).not.toContain(rule);
    }
    expect(codexSkill).toContain('$aeolus-crew');
    expect(codexSkill).toContain('harness `codex`');
    expect(codexSkill).not.toContain('Receive, pong each operator ping');
  });

  it('has a crewed session ask its questions over the fleet, to the sender of its task, never through an interactive question form, in both harnesses (#457)', () => {
    expect(claudeSkill).toContain('Ask your questions over the fleet: `send -` them to the sender of your task, never through AskUserQuestion or another interactive question form.');
    expect(codexSkill).toContain('Ask your questions over the fleet: `send -` them to the sender of your task, never through request_user_input or another interactive question form.');
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

  it('tells a squadron member to keep the check-in interval its role message gives, in both harnesses', () => {
    expect(claudeSkill).toContain('aeolus-identity.sh" check-in <interval>');
    expect(codexSkill).toContain('`scripts/aeolus-identity.sh check-in <interval>`');
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

  it('tells a session the trierarch wakes to start no watcher, in both harnesses', () => {
    expect(claudeSkill).toContain('When "${CLAUDE_PLUGIN_ROOT}/scripts/aeolus-identity.sh" show says `wakes: the trierarch`, start no watcher and end your turn: the trierarch wakes this session.');
    expect(codexSkill).toContain('When `scripts/aeolus-identity.sh show` says `wakes: the trierarch`, start no wake: the trierarch wakes this session.');
  });
});

// LEASE_ENDED for a crew token the identity file no longer holds says nothing
// about the folder's new crew: only the scripts, which know the token they
// used, may forget the ship. A session never deletes the identity file on it.
describe('LEASE_ENDED in the skills', () => {
  const leaseEndedLines = (skill: string) => skill.split('\n').filter((line) => line.includes('LEASE_ENDED'));

  it('has a Claude Code session stop calling the fleet, the plugin having forgotten the ship, and delete no identity file', () => {
    expect(leaseEndedLines(claudeSkill).join('\n')).toContain('the plugin already forgot the ship');
    for (const line of leaseEndedLines(claudeSkill)) {
      expect(line).not.toContain('delete');
    }
  });

  it('has a Codex session do the same in $aeolus-crew, $aeolus-wake and $aeolus-ship', () => {
    expect(leaseEndedLines(codexSkill).join('\n')).toContain('the plugin already forgot the ship');
    for (const line of [codexSkill, codexWake, codexShip].flatMap(leaseEndedLines)) {
      expect(line).not.toContain('delete');
    }
  });
});
