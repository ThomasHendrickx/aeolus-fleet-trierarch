import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

const PLUGIN = fileURLToPath(new URL('..', import.meta.url));
const REPOSITORY = fileURLToPath(new URL('../../..', import.meta.url));
const SCRIPTS = join(PLUGIN, 'scripts');

let data: string;
let folder: string;

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'aeolus-codex-data-'));
  folder = mkdtempSync(join(tmpdir(), 'aeolus codex folder-'));
});

afterEach(() => {
  rmSync(data, { recursive: true, force: true });
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
  return spawnSync(script.endsWith('.py') ? 'python3' : 'bash', [join(SCRIPTS, script), ...args], {
    cwd: folder,
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      AEOLUS_DATA: '',
      AEOLUS_FOLDER: '',
      CLAUDE_PLUGIN_DATA: '',
      CLAUDE_PROJECT_DIR: '',
      PLUGIN_DATA: data,
      PLUGIN_ROOT: PLUGIN,
      ...env,
    },
  });
}

describe('the Codex plugin package', () => {
  it('publishes the existing aeolus plugin through a Codex manifest and the repository marketplace', () => {
    const claude = z.object({ version: z.string() }).parse(json(join(PLUGIN, '.claude-plugin/plugin.json')));
    const manifest = z
      .object({
        name: z.literal('aeolus'),
        version: z.string(),
        skills: z.literal('./skills/'),
        interface: z.object({ displayName: z.literal('Aeolus'), capabilities: z.array(z.string()) }),
      })
      .parse(json(join(PLUGIN, '.codex-plugin/plugin.json')));
    const marketplace = z
      .object({
        name: z.literal('aeolus-fleet'),
        plugins: z.array(
          z.object({
            name: z.literal('aeolus'),
            source: z.object({ source: z.literal('local'), path: z.literal('./plugins/aeolus') }),
            policy: z.object({ installation: z.literal('AVAILABLE'), authentication: z.literal('ON_INSTALL') }),
          }),
        ),
      })
      .parse(json(join(REPOSITORY, '.agents/plugins/marketplace.json')));

    expect(manifest.version).toBe(claude.version);
    expect(manifest.interface.capabilities).toContain('Crew an Aeolus ship');
    expect(marketplace.plugins).toHaveLength(1);
  });

  it('offers Codex skills for crewing, inspecting, watching and deregistering a ship', () => {
    const skills = ['aeolus-crew', 'aeolus-ship', 'aeolus-watch', 'aeolus-deregister'];

    for (const skill of skills) {
      const text = readFileSync(join(PLUGIN, 'skills', skill, 'SKILL.md'), 'utf8');
      expect(text).toContain(`name: ${skill}`);
      expect(text).toContain('Codex');
    }

    expect(readFileSync(join(PLUGIN, 'skills/aeolus-crew/SKILL.md'), 'utf8')).toContain('harness `codex`');
  });
});

describe('Codex plugin state', () => {
  it('keeps one identity per working folder in the Codex plugin data directory', () => {
    const written = runScript('aeolus-identity.sh', {
      args: ['write', 'https://fleet.example.com', 'shp_01m3tbfspe96yf1rnr4ank9h1a', 'scout', 'aeolus_ct_v1_crew'],
    });

    expect(written.status).toBe(0);
    expect(runScript('aeolus-identity.sh', { args: ['show'] }).stdout).toContain(`folder: ${realpathSync(folder)}`);
    expect(runScript('aeolus-identity.sh', { args: ['path'] }).stdout).toContain(data);
  });

  it('adds the plugin paths and restored ship to Codex context at session start without exposing its token', () => {
    expect(
      runScript('aeolus-identity.sh', {
        args: ['write', 'https://fleet.example.com', 'shp_01m3tbfspe96yf1rnr4ank9h1a', 'scout', 'aeolus_ct_v1_crew'],
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

    expect(output).toContain('Aeolus Codex hooks are active.');
    expect(output).toContain(`plugin root is ${PLUGIN}`);
    expect(output).toContain(`plugin data is ${data}`);
    expect(output).toContain('crews the Aeolus ship scout');
    expect(output).toContain('The active model is gpt-6-astra.');
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

    expect(hook.stdout).toContain('Aeolus Codex hooks are active.');
    expect(hook.stdout).toContain('This folder crews no Aeolus ship.');
  });
});

describe('Codex fleet calls', () => {
  it('adds the active Codex model to every aeolus send without changing its other arguments', () => {
    const toolInput = {
      crewToken: 'aeolus_ct_v1_crew',
      selector: { kind: 'ship', name: 'orchestrator-1' },
      payload: 'A payload with "quotes" and a newline\ninside.',
      contentType: 'text/plain',
      idempotencyKey: 'send-1',
    };
    const hook = runScript('aeolus-codex-send-model.py', {
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__aeolus__send',
        model: 'gpt-6-astra',
        tool_input: toolInput,
      }),
    });
    const output = z
      .object({
        hookSpecificOutput: z.object({
          hookEventName: z.literal('PreToolUse'),
          permissionDecision: z.literal('allow'),
          updatedInput: z.record(z.string(), z.unknown()),
        }),
      })
      .parse(JSON.parse(hook.stdout));

    expect(output.hookSpecificOutput.updatedInput).toEqual({ ...toolInput, model: 'gpt-6-astra' });
  });

  it('shows the Codex MCP command when a Codex session has no fleet tools', () => {
    const hinted = runScript('aeolus-mcp-hint.sh', {
      args: ['https://fleet.example.com/'],
      env: { AEOLUS_HARNESS: 'codex' },
    });

    expect(hinted.stdout).toContain('codex mcp add aeolus --url https://fleet.example.com/mcp');
    expect(hinted.stdout).toContain('start a new Codex task');
    expect(hinted.stdout).not.toContain('claude mcp add');
  });
});
