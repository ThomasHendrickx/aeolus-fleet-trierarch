import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { scriptEnvironment } from './script-environment.js';

const PLUGIN = fileURLToPath(new URL('..', import.meta.url));
const REPOSITORY = fileURLToPath(new URL('../../..', import.meta.url));
const SCRIPTS = join(PLUGIN, 'scripts');

let data: string;
let folder: string;
/** A throwaway home: the identities live under it, never in the real one. */
let home: string;

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'aeolus-codex-data-'));
  home = mkdtempSync(join(tmpdir(), 'aeolus-codex-home-'));
  folder = mkdtempSync(join(tmpdir(), 'aeolus codex folder-'));
});

afterEach(() => {
  rmSync(data, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(folder, { recursive: true, force: true });
});

function json(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

interface ScriptOptions {
  args?: string[];
  input?: string;
  env?: Record<string, string>;
}

function runScript(script: string, options: ScriptOptions = {}) {
  const { args = [], input = '', env = {} } = options;
  return spawnSync('bash', [join(SCRIPTS, script), ...args], {
    cwd: folder,
    input,
    encoding: 'utf8',
    env: scriptEnvironment({
      HOME: home,
      AEOLUS_DATA: '',
      AEOLUS_FOLDER: '',
      AEOLUS_CODEX_WAKE_DISABLED: '1',
      CLAUDE_PLUGIN_DATA: '',
      CLAUDE_PROJECT_DIR: '',
      PLUGIN_DATA: data,
      PLUGIN_ROOT: PLUGIN,
      ...env,
    }),
  });
}

describe('the Codex plugin package', () => {
  it('publishes the existing aeolus-fleet plugin through a Codex manifest and the repository marketplace', () => {
    const claude = z.object({ version: z.string() }).parse(json(join(PLUGIN, '.claude-plugin/plugin.json')));
    const manifest = z
      .object({
        name: z.literal('aeolus-fleet'),
        version: z.string(),
        skills: z.literal('./skills/'),
        interface: z.object({ displayName: z.literal('Aeolus Fleet'), capabilities: z.array(z.string()) }),
      })
      .parse(json(join(PLUGIN, '.codex-plugin/plugin.json')));
    const marketplace = z
      .object({
        name: z.literal('aeolus-fleet'),
        plugins: z.array(
          z.object({
            name: z.literal('aeolus-fleet'),
            source: z.object({ source: z.literal('local'), path: z.literal('./plugins/aeolus-fleet') }),
            policy: z.object({ installation: z.literal('AVAILABLE'), authentication: z.literal('ON_INSTALL') }),
          }),
        ),
      })
      .parse(json(join(REPOSITORY, '.agents/plugins/marketplace.json')));

    expect(manifest.version).toBe(claude.version);
    expect(manifest.interface.capabilities).toContain('Crew an Aeolus ship');
    expect(marketplace.plugins).toHaveLength(1);
  });

  it('offers Codex skills for crewing, inspecting, watching, waking and deregistering a ship', () => {
    const skills = ['aeolus-fleet-crew', 'aeolus-fleet-ship', 'aeolus-fleet-watch', 'aeolus-fleet-wake', 'aeolus-fleet-deregister'];

    for (const skill of skills) {
      const text = readFileSync(join(PLUGIN, 'skills', skill, 'SKILL.md'), 'utf8');
      expect(text).toContain(`name: ${skill}`);
      expect(text).toContain('Codex');
    }

    expect(readFileSync(join(PLUGIN, 'skills/aeolus-fleet-crew/SKILL.md'), 'utf8')).toContain('harness `codex`');
  });

  it('leaves the crew token to the scripts: no Codex skill has the session read or pass it', () => {
    for (const skill of ['aeolus-fleet-crew', 'aeolus-fleet-ship', 'aeolus-fleet-watch', 'aeolus-fleet-wake', 'aeolus-fleet-deregister', 'aeolus-fleet-issue']) {
      expect(readFileSync(join(PLUGIN, 'skills', skill, 'SKILL.md'), 'utf8')).not.toMatch(/crewToken|the crew token/);
    }
  });

  it('crews through aeolus-fleet.sh with harness codex, needing no fleet MCP server, and fetches the protocol from the fleet', () => {
    const crew = readFileSync(join(PLUGIN, 'skills/aeolus-fleet-crew/SKILL.md'), 'utf8');

    expect(crew).toContain("`scripts/aeolus-fleet.sh register <fleetUrl> <shipId> <secret> <location> [<squadronId>]`");
    expect(crew).toContain('`scripts/aeolus-fleet.sh protocol`');
    expect(crew).toContain('`scripts/aeolus-fleet.sh send -`');
    expect(crew).not.toContain('aeolus-mcp-hint');
  });

  it('tells a session whose fleet calls get no answer about the one-time sandbox setup', () => {
    const crew = readFileSync(join(PLUGIN, 'skills/aeolus-fleet-crew/SKILL.md'), 'utf8');

    expect(crew).toContain('exits 6');
    expect(crew).toContain('sandbox_workspace_write');
  });

  it('shows the ship as /aeolus-fleet:ship does: answered by aeolus-status.sh, shown as it prints it', () => {
    const ship = readFileSync(join(PLUGIN, 'skills/aeolus-fleet-ship/SKILL.md'), 'utf8');

    expect(ship).toContain('`scripts/aeolus-status.sh`');
    expect(ship).toContain('exactly as it prints it');
    expect(ship).not.toContain('aeolus-fleet.sh');
  });

  it('wakes a session as /aeolus-fleet:wake does: identity and lease, waiting deliveries, the wake bridge armed again, and a status report', () => {
    const wake = readFileSync(join(PLUGIN, 'skills/aeolus-fleet-wake/SKILL.md'), 'utf8');

    expect(wake).toContain('scripts/aeolus-identity.sh show');
    expect(wake).toContain('`scripts/aeolus-fleet.sh whoami`');
    expect(wake).toContain('LEASE_ENDED');
    expect(wake).toContain('act only if the ack succeeded');
    expect(wake).toContain('until it answers empty');
    expect(wake).toContain('aeolus-codex-wake.sh` `start <codexTaskId>`');
    expect(wake).toContain('deliveries handled');
  });

  it("has $aeolus-fleet-wake receive and ack nothing on a pushed lease: the message comes into the turn through the plugin's hooks (#756)", () => {
    expect(readFileSync(join(PLUGIN, 'skills/aeolus-fleet-wake/SKILL.md'), 'utf8')).toContain(
      "If step 1 said `delivery: pushed`, receive and ack nothing: the wake bridge or the trierarch hands each message over, and it comes into the turn through the plugin's hooks. Handle what came in, and answer by senderName with inReplyTo. Otherwise, as the `aeolus-fleet-crew` skill says:",
    );
  });

  it('has a queued hand-over handled as it came into the turn, never received (#756)', () => {
    expect(readFileSync(join(PLUGIN, 'skills/aeolus-fleet-watch/SKILL.md'), 'utf8')).toContain(
      'When the bridge queues a hand-over, the message comes into that turn through the plugin\'s hooks: handle it as the `aeolus-fleet-crew` skill says, without receiving or acking it, then re-arm the bridge before ending the turn.',
    );
  });

  it('documents automatic local wake-up and re-arms it at the end of every completed turn', () => {
    const crew = readFileSync(join(PLUGIN, 'skills/aeolus-fleet-crew/SKILL.md'), 'utf8');
    const watch = readFileSync(join(PLUGIN, 'skills/aeolus-fleet-watch/SKILL.md'), 'utf8');
    const manifest = JSON.stringify(json(join(PLUGIN, '.codex-plugin/plugin.json')));

    expect(crew).toContain('aeolus-codex-wake.sh` `start <codexTaskId>`');
    expect(crew).toContain('before ending every completed turn');
    expect(watch).toContain('automatic local wake-up');
    expect(manifest).toContain('Automatic local wake-up');
    expect(`${crew}\n${watch}\n${manifest}`).toContain('Codex Cloud cannot wake automatically');
  });

  it("documents Codex's one-time sandbox setup, and the Linux hosts where its sandbox cannot run", () => {
    const readme = readFileSync(join(PLUGIN, 'README.md'), 'utf8');

    expect(readme).toContain('network_access = true');
    expect(readme).toContain('writable_roots');
    expect(readme).toContain('"/Users/<you>/.aeolus/crews/codex"');
    expect(readme).toContain('unprivileged user namespaces');
  });

  it('launches shared hooks from the root variable each harness provides', () => {
    const hooks = JSON.stringify(json(join(PLUGIN, 'hooks/hooks.json')));

    expect(hooks).toContain('${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/aeolus-session-start.sh');
    expect(hooks).not.toContain('mcp__aeolus__send');
    expect(hooks).toContain('commandWindows');
    expect(hooks).toContain('%PLUGIN_ROOT%\\\\scripts\\\\aeolus-session-start.sh');
  });

  it('guards the watcher on every Bash call, re-arms it at the end of every turn and checks the report interval after every call, in both harnesses', () => {
    const hook = z.object({ type: z.string(), command: z.string(), commandWindows: z.string() });
    const hooks = z
      .object({ hooks: z.record(z.string(), z.array(z.object({ matcher: z.string().optional(), hooks: z.array(hook) }))) })
      .parse(json(join(PLUGIN, 'hooks/hooks.json'))).hooks;

    expect(hooks.PreToolUse).toContainEqual({
      matcher: '^Bash$',
      hooks: [
        {
          type: 'command',
          command: 'bash "${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/aeolus-watch-guard.sh"',
          commandWindows: 'bash "%PLUGIN_ROOT%\\scripts\\aeolus-watch-guard.sh"',
        },
      ],
    });
    expect(hooks.PreToolUse).toContainEqual({
      matcher: '^Bash$',
      hooks: [
        {
          type: 'command',
          command: 'bash "${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/aeolus-model.sh"',
          commandWindows: 'bash "%PLUGIN_ROOT%\\scripts\\aeolus-model.sh"',
        },
      ],
    });
    expect(hooks.PostToolUse).toEqual([
      {
        hooks: [
          {
            type: 'command',
            command: 'bash "${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/aeolus-report-due.sh"',
            commandWindows: 'bash "%PLUGIN_ROOT%\\scripts\\aeolus-report-due.sh"',
          },
        ],
      },
    ]);
    expect(hooks.UserPromptSubmit).toEqual([
      {
        hooks: [
          {
            type: 'command',
            command: 'bash "${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/aeolus-turn.sh"',
            commandWindows: 'bash "%PLUGIN_ROOT%\\scripts\\aeolus-turn.sh"',
          },
        ],
      },
    ]);
    expect(hooks.Stop).toEqual([
      {
        hooks: [
          {
            type: 'command',
            command: 'bash "${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/aeolus-stop.sh"',
            commandWindows: 'bash "%PLUGIN_ROOT%\\scripts\\aeolus-stop.sh"',
          },
        ],
      },
    ]);
  });

  it('marks the launch at the start, at every tool call and at a failed turn, in both harnesses (#490)', () => {
    const hook = z.object({ type: z.string(), command: z.string(), commandWindows: z.string() });
    const hooks = z
      .object({ hooks: z.record(z.string(), z.array(z.object({ matcher: z.string().optional(), hooks: z.array(hook) }))) })
      .parse(json(join(PLUGIN, 'hooks/hooks.json'))).hooks;
    const launchHook = {
      type: 'command',
      command: 'bash "${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/aeolus-launch.sh"',
      commandWindows: 'bash "%PLUGIN_ROOT%\\scripts\\aeolus-launch.sh"',
    };

    expect(hooks.SessionStart).toContainEqual({ matcher: 'startup|resume', hooks: [launchHook] });
    expect(hooks.PreToolUse).toContainEqual({ hooks: [launchHook] });
    expect(hooks.StopFailure).toContainEqual({ matcher: 'model_not_found', hooks: [launchHook] });
  });

  it('tells a died turn apart at every failed turn, whatever the error (#756, D3)', () => {
    const hook = z.object({ type: z.string(), command: z.string(), commandWindows: z.string() });
    const hooks = z
      .object({ hooks: z.record(z.string(), z.array(z.object({ matcher: z.string().optional(), hooks: z.array(hook) }))) })
      .parse(json(join(PLUGIN, 'hooks/hooks.json'))).hooks;

    expect(hooks.StopFailure).toContainEqual({
      hooks: [
        {
          type: 'command',
          command: 'bash "${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/aeolus-turn-died.sh"',
          commandWindows: 'bash "%PLUGIN_ROOT%\\scripts\\aeolus-turn-died.sh"',
        },
      ],
    });
  });
});

describe('Codex hooks on the new fleet (#756)', () => {
  it('tells an interrupted turn apart as a died turn (3.7, D3)', () => {
    const hook = z.object({ type: z.string(), command: z.string(), commandWindows: z.string() });
    const hooks = z
      .object({ hooks: z.record(z.string(), z.array(z.object({ matcher: z.string().optional(), hooks: z.array(hook) }))) })
      .parse(json(join(PLUGIN, 'hooks/hooks.json'))).hooks;

    expect(hooks.Interrupt).toEqual([
      {
        hooks: [
          {
            type: 'command',
            command: 'bash "${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/aeolus-turn-died.sh"',
            commandWindows: 'bash "%PLUGIN_ROOT%\\scripts\\aeolus-turn-died.sh"',
          },
        ],
      },
    ]);
  });
});

describe('Codex plugin state', () => {
  it('keeps one identity per working folder in ~/.aeolus/crews/codex, outside the plugin data directory (#658)', () => {
    const written = runScript('aeolus-identity.sh', {
      args: ['write', 'https://fleet.example.com', 'shp_01m3tbfspe96yf1rnr4ank9h1a', 'scout'], input: 'aeolus_ct_v1_crew',
    });

    expect(written.status).toBe(0);
    expect(runScript('aeolus-identity.sh', { args: ['show'] }).stdout).toContain(`folder: ${realpathSync(folder)}`);
    expect(runScript('aeolus-identity.sh', { args: ['path'] }).stdout).toContain(join(home, '.aeolus', 'crews', 'codex'));
  });

  it("finds the same identity from a Codex skill's command, run with AEOLUS_DATA, AEOLUS_FOLDER and AEOLUS_HARNESS=codex (#658)", () => {
    runScript('aeolus-identity.sh', { args: ['write', 'https://fleet.example.com', 'shp_01m3tbfspe96yf1rnr4ank9h1a', 'scout'], input: 'aeolus_ct_v1_crew' });

    const shown = runScript('aeolus-identity.sh', { args: ['show'], env: { PLUGIN_DATA: '', PLUGIN_ROOT: '', AEOLUS_DATA: data, AEOLUS_FOLDER: folder, AEOLUS_HARNESS: 'codex' } });

    expect(shown.stdout).toContain('ship: scout');
  });

  it("finds the same identity from a Codex skill's command run without AEOLUS_HARNESS (#687)", () => {
    runScript('aeolus-identity.sh', { args: ['write', 'https://fleet.example.com', 'shp_01m3tbfspe96yf1rnr4ank9h1a', 'scout'], input: 'aeolus_ct_v1_crew' });

    const shown = runScript('aeolus-identity.sh', { args: ['show'], env: { PLUGIN_DATA: '', PLUGIN_ROOT: '', AEOLUS_DATA: data, AEOLUS_FOLDER: folder } });

    expect(shown.stdout).toContain('ship: scout');
  });

  it('finds the Claude Code identity first from a command run without AEOLUS_HARNESS, when both harnesses crew the folder (#687)', () => {
    runScript('aeolus-identity.sh', { args: ['write', 'https://fleet.example.com', 'shp_01m3tbfspe96yf1rnr4ank9h1a', 'scout'], input: 'aeolus_ct_v1_crew' });
    runScript('aeolus-identity.sh', {
      args: ['write', 'https://fleet.example.com', 'shp_01m3tbfspe96yf1rnr4ank9h1b', 'lookout'], input: 'aeolus_ct_v1_other',
      env: { PLUGIN_ROOT: '', AEOLUS_HARNESS: 'claude-code' },
    });

    const shown = runScript('aeolus-identity.sh', { args: ['show'], env: { PLUGIN_DATA: '', PLUGIN_ROOT: '', AEOLUS_DATA: data, AEOLUS_FOLDER: folder } });

    expect(shown.stdout).toContain('ship: lookout');
  });

  it('moves the identity of a Codex session on the old layout to ~/.aeolus/crews/codex at the next session start, leaving a link (#658)', () => {
    const name = `${createHash('sha256').update(realpathSync(folder)).digest('hex').slice(0, 32)}.identity`;
    mkdirSync(join(data, 'ships'), { mode: 0o700 });
    writeFileSync(join(data, 'ships', name), 'fleetUrl=https://fleet.example.com\nshipId=shp_01m3tbfspe96yf1rnr4ank9h1a\nshipName=scout\ncrewToken=aeolus_ct_v1_crew\n', { mode: 0o600 });

    runScript('aeolus-session-start.sh', { input: JSON.stringify({ cwd: folder, hook_event_name: 'SessionStart', source: 'startup' }) });

    expect(readFileSync(join(home, '.aeolus', 'crews', 'codex', name), 'utf8')).toContain('crewToken=aeolus_ct_v1_crew\n');
    expect(lstatSync(join(data, 'ships')).isSymbolicLink()).toBe(true);
  });

  it("never moves a Codex session's old identities into Claude Code's crews folder, from a command run without AEOLUS_HARNESS (#679)", () => {
    const name = `${createHash('sha256').update(realpathSync(folder)).digest('hex').slice(0, 32)}.identity`;
    mkdirSync(join(data, 'ships'), { mode: 0o700 });
    writeFileSync(join(data, 'ships', name), 'fleetUrl=https://fleet.example.com\nshipId=shp_01m3tbfspe96yf1rnr4ank9h1a\nshipName=scout\ncrewToken=aeolus_ct_v1_crew\n', { mode: 0o600 });

    runScript('aeolus-identity.sh', { args: ['show'], env: { PLUGIN_DATA: '', PLUGIN_ROOT: '', AEOLUS_DATA: data, AEOLUS_FOLDER: folder } });

    expect(existsSync(join(home, '.aeolus', 'crews', 'claude-code', name))).toBe(false);
    expect(readFileSync(join(data, 'ships', name), 'utf8')).toContain('crewToken=aeolus_ct_v1_crew\n');
    expect(lstatSync(join(data, 'ships')).isSymbolicLink()).toBe(false);
  });

  it('adds the plugin paths and restored ship to Codex context at session start without exposing its token', () => {
    expect(
      runScript('aeolus-identity.sh', {
        args: ['write', 'https://fleet.example.com', 'shp_01m3tbfspe96yf1rnr4ank9h1a', 'scout'], input: 'aeolus_ct_v1_crew',
        env: { AEOLUS_FOLDER: folder },
      }).status,
    ).toBe(0);

    const hook = runScript('aeolus-session-start.sh', {
      input: JSON.stringify({
        session_id: '01a10348-c3ff-7951-9962-349fca3538e8',
        cwd: folder,
        hook_event_name: 'SessionStart',
        source: 'resume',
        model: 'gpt-6-astra',
      }),
    });
    const output = z
      .object({ hookSpecificOutput: z.object({ additionalContext: z.string() }) })
      .parse(JSON.parse(hook.stdout)).hookSpecificOutput.additionalContext;

    expect(output).toContain('Aeolus Fleet Codex hooks are active.');
    expect(output).toContain(`plugin root is ${PLUGIN}`);
    expect(output).toContain(`plugin data is ${data}`);
    expect(output).toContain('crews the Aeolus ship scout');
    expect(output).toContain('The active model is gpt-6-astra.');
    expect(output).toContain(`Every fleet call goes through ${PLUGIN}/scripts/aeolus-fleet.sh`);
    expect(output).not.toContain('crewToken');
    expect(output).not.toContain('aeolus_ct_v1_crew');
  });

  it('tells an uncrewed Codex session that its trusted hook is active', () => {
    const hook = runScript('aeolus-session-start.sh', {
      input: JSON.stringify({
        session_id: '01a10348-c3ff-7951-9962-349fca3538e8',
        cwd: folder,
        hook_event_name: 'SessionStart',
        source: 'startup',
        model: 'gpt-6-astra',
      }),
    });

    expect(hook.stdout).toContain('Aeolus Fleet Codex hooks are active.');
    expect(hook.stdout).toContain('This folder crews no Aeolus ship.');
  });

  it("tells an uncrewed Codex session to pass AEOLUS_HARNESS=codex to an Aeolus skill's scripts, with AEOLUS_DATA and AEOLUS_FOLDER (#679)", () => {
    const hook = runScript('aeolus-session-start.sh', {
      input: JSON.stringify({ session_id: '01a10348-c3ff-7951-9962-349fca3538e8', cwd: folder, hook_event_name: 'SessionStart', source: 'startup' }),
    });

    expect(hook.stdout).toContain('pass AEOLUS_DATA and AEOLUS_FOLDER with the values above, and AEOLUS_HARNESS=codex, to its scripts.');
  });

  it('surfaces a wake bridge startup failure in the restored session context', () => {
    expect(
      runScript('aeolus-identity.sh', {
        args: ['write', 'http://127.0.0.1:1', 'shp_01m3tbfspe96yf1rnr4ank9h1a', 'scout'], input: 'aeolus_ct_v1_crew',
        env: { AEOLUS_FOLDER: folder },
      }).status,
    ).toBe(0);
    const bin = join(data, 'bin');
    const codex = join(bin, 'codex');
    mkdirSync(bin);
    writeFileSync(codex, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(codex, 0o700);

    const hook = runScript('aeolus-session-start.sh', {
      input: JSON.stringify({ session_id: '01a10348-c3ff-7951-9962-349fca3538e8', cwd: folder, hook_event_name: 'SessionStart', source: 'resume' }),
      env: { AEOLUS_CODEX_WAKE_DISABLED: '', PATH: `${bin}:${process.env.PATH ?? ''}` },
    });
    const output = z.object({ hookSpecificOutput: z.object({ additionalContext: z.string() }) }).parse(JSON.parse(hook.stdout)).hookSpecificOutput.additionalContext;

    expect(output).toContain('Automatic local wake-up failed:');
    expect(output).toContain('cannot reach the fleet');
    expect(output).not.toContain('Automatic local wake-up targets this Codex task');
  });
});

describe('Codex in a folder a trierarch crews (wakeBy=trierarch)', () => {
  it('arms no wake bridge: the trierarch wakes the session, so a wake skill asking for one starts nothing', () => {
    expect(
      runScript('aeolus-identity.sh', {
        args: ['write', '--wake-by', 'trierarch', 'http://127.0.0.1:1', 'shp_01m3tbfspe96yf1rnr4ank9h1a', 'scout'], input: 'aeolus_ct_v1_crew',
        env: { AEOLUS_FOLDER: folder },
      }).status,
    ).toBe(0);
    const bin = join(data, 'bin');
    const codex = join(bin, 'codex');
    mkdirSync(bin);
    writeFileSync(codex, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(codex, 0o700);

    const started = runScript('aeolus-codex-wake.sh', {
      args: ['start', '01a10348-c3ff-7951-9962-349fca3538e8'],
      env: { AEOLUS_FOLDER: folder, AEOLUS_CODEX_WAKE_DISABLED: '', PATH: `${bin}:${process.env.PATH ?? ''}` },
    });

    expect(started.status).toBe(0);
    expect(started.stdout).toContain('the trierarch wakes this session');
    expect(readdirSync(join(data, 'ships')).filter((name) => name.endsWith('.wake.pid'))).toEqual([]);
  });
});

describe('Codex fleet calls', () => {
  const crewed = () => {
    expect(runScript('aeolus-identity.sh', { args: ['write', 'https://fleet.example.com', 'shp_01m3tbfspe96yf1rnr4ank9h1a', 'scout'], input: 'aeolus_ct_v1_crew', env: { AEOLUS_FOLDER: folder } }).status).toBe(0);
    return runScript('aeolus-identity.sh', { args: ['path'], env: { AEOLUS_FOLDER: folder } }).stdout.trim().replace(/\.identity$/, '.model');
  };
  const bashCall = (command: string) =>
    JSON.stringify({ hook_event_name: 'PreToolUse', cwd: folder, model: 'gpt-6-astra', tool_name: 'Bash', tool_input: { command } });

  it('records the active Codex model when a command calls aeolus-fleet.sh, for its sends to state', () => {
    const modelFile = crewed();

    const hook = runScript('aeolus-model.sh', { input: bashCall(`AEOLUS_HARNESS=codex ${SCRIPTS}/aeolus-fleet.sh send - <<'JSON'\n{"model":"not-this-one"}\nJSON`) });

    expect(hook.status).toBe(0);
    expect(hook.stdout).toBe('');
    expect(readFileSync(modelFile, 'utf8')).toBe('gpt-6-astra\n');
  });

  it('records nothing for a command that makes no fleet call', () => {
    const modelFile = crewed();

    runScript('aeolus-model.sh', { input: bashCall('npm test') });

    expect(readdirSync(data, { recursive: true })).not.toContain(modelFile.slice(data.length + 1));
  });
});
