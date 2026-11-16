/** Real ACP wire evidence, including failures that prevent offering this build. */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/cursor-acp/2026.11.13-eacade1/macos/${name}`, import.meta.url), 'utf8');
const recordSchema = z.object({
  direction: z.enum(['sent', 'received', 'observation']),
  process: z.string(),
  elapsedMs: z.number().nonnegative(),
  message: z.record(z.string(), z.unknown()),
});
const trace = (name: string) => fixture(`${name}.jsonl`).trim().split('\n').map((line) => recordSchema.parse(JSON.parse(line)));
const configSchema = z.object({ result: z.object({ configOptions: z.array(z.object({ id: z.string(), currentValue: z.string() })) }) });
const updateSchema = z.object({ params: z.object({ update: z.record(z.string(), z.unknown()) }) });
const updates = (name: string, process: string) => trace(name)
  .filter((entry) => entry.process === process && entry.message.method === 'session/update')
  .map((entry) => updateSchema.parse(entry.message).params.update);
const observations = (name: string) => trace(name).filter((entry) => entry.direction === 'observation').map((entry) => entry.message);

describe('Cursor CLI 2026.11.13-eacade1 ACP on macOS', () => {
  it('captures load-session capability and the machine login method', () => {
    expect(trace('lifecycle')).toContainEqual(expect.objectContaining({ direction: 'received', message: expect.objectContaining({ result: expect.objectContaining({ protocolVersion: 1, agentCapabilities: expect.objectContaining({ loadSession: true }), authMethods: expect.arrayContaining([expect.objectContaining({ id: 'cursor_login' })]) }) }) }));
  });

  it('keeps the second live process model before and after the first changes model and the second completes a prompt', () => {
    const entries = trace('model-isolation');
    const models = (process: string) => entries.filter((entry) => entry.process === process && entry.direction === 'sent' && entry.message.method === 'session/set_config_option')
      .map((request) => configSchema.parse(entries.find((entry) => entry.process === process && entry.direction === 'received' && entry.message.id === request.message.id)?.message).result.configOptions.find((option) => option.id === 'model')?.currentValue);

    expect(models('B')).toEqual(['gpt-5.4-mini[reasoning=medium]', 'gpt-5.4-mini[reasoning=medium]', 'gpt-5.4-mini[reasoning=medium]']);
    expect(models('A')).toEqual(['composer-2.5[fast=true]']);
    expect(entries).toContainEqual(expect.objectContaining({ process: 'B', direction: 'received', message: expect.objectContaining({ result: { stopReason: 'end_turn' } }) }));
  });

  it('keeps a permission request open for thirty minutes and completes after the delayed denial', () => {
    const entries = trace('permission-hold');
    const requested = entries.find((entry) => entry.direction === 'received' && entry.message.method === 'session/request_permission');
    const answered = entries.find((entry) => entry.direction === 'sent' && entry.message.result !== undefined);
    expect(requested).toBeDefined();
    expect(answered?.message.id).toBe(requested?.message.id);
    expect(answered?.message.result).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } });
    expect((answered?.elapsedMs ?? 0) - (requested?.elapsedMs ?? 0)).toBeGreaterThanOrEqual(1_800_000);
    expect(entries).toContainEqual(expect.objectContaining({ direction: 'received', message: expect.objectContaining({ result: { stopReason: 'end_turn' } }) }));
  });

  it('ignores modelId in session/new and requires explicit model selection', () => {
    expect(observations('lifecycle')).toContainEqual({ event: 'session-new-model', requested: 'gpt-5.4-mini[reasoning=medium]', actual: 'composer-2.5[fast=true]' });
    expect(trace('lifecycle')).toContainEqual(expect.objectContaining({ direction: 'sent', message: expect.objectContaining({ method: 'session/set_model', params: expect.objectContaining({ modelId: 'composer-2.5[fast=true]' }) }) }));
  });

  it('returns end_turn after a failed shell command rather than treating a tool exit as a failed turn', () => {
    expect(updates('lifecycle', 'A')).toContainEqual(expect.objectContaining({ sessionUpdate: 'tool_call_update', status: 'completed', rawOutput: { exitCode: 7, stdout: 'ACP_MAC_TOOL_FAILED\n', stderr: '' } }));
    expect(trace('lifecycle').filter((entry) => entry.process === 'A' && entry.direction === 'received' && entry.message.result !== undefined)).toContainEqual(expect.objectContaining({ message: expect.objectContaining({ id: 6, result: { stopReason: 'end_turn' } }) }));
  });

  it('captures distinct errors for loading a missing session and prompting one', () => {
    const messages = trace('lifecycle').map((entry) => entry.message);
    expect(messages).toContainEqual(expect.objectContaining({ error: expect.objectContaining({ code: -32602, message: 'Invalid params' }) }));
    expect(messages).toContainEqual(expect.objectContaining({ error: expect.objectContaining({ code: -32603, message: 'Internal error' }) }));
  });

  it('replays history and resumes a session after killing its owning process mid-turn', () => {
    expect(observations('lifecycle')).toContainEqual(expect.objectContaining({ event: 'signal', signal: 'SIGKILL', target: 'owned agent acp PID', while: 'session/prompt open and permission pending' }));
    expect(updates('lifecycle', 'A-resumed').length).toBeGreaterThan(0);
    expect(trace('lifecycle')).toContainEqual(expect.objectContaining({ process: 'after-kill', direction: 'received', message: expect.objectContaining({ result: { stopReason: 'end_turn' } }) }));
  });

  it.each(['missing-login', 'synthetic-expired-login'])('refuses a session with %s in an isolated credential store', (process) => {
    expect(trace('configuration')).toContainEqual(expect.objectContaining({ process, direction: 'received', message: expect.objectContaining({ error: expect.objectContaining({ code: -32000, message: 'Authentication required' }) }) }));
  });

  it('records the default-home user MCP server starting despite an empty session server list', () => {
    const entries = trace('configuration').filter((entry) => entry.process === 'MCP-home');
    expect(entries).toContainEqual(expect.objectContaining({ direction: 'sent', message: expect.objectContaining({ method: 'session/new', params: expect.objectContaining({ mcpServers: [] }) }) }));
    expect(entries).toContainEqual(expect.objectContaining({ direction: 'observation', message: { event: 'mcp-default-home', stage: 'after-initialize', homeStarted: false, xdgStarted: false, projectStarted: false } }));
    expect(entries).toContainEqual(expect.objectContaining({ direction: 'observation', message: { event: 'mcp-default-home', stage: 'after-session-new', homeStarted: true, xdgStarted: false, projectStarted: false } }));
    expect(observations('configuration')).toContainEqual(expect.objectContaining({ event: 'mcp-exclusion', explicitStarted: true, userStarted: false, projectStarted: false }));
  });

  it('persists allow-always in the command allowlist beyond the session and process', () => {
    const seen = observations('configuration');
    expect(seen).toContainEqual({ event: 'allow-always-permissions', stage: 'first-prompt', permissionCount: 1 });
    for (const stage of ['same-session', 'new-session-same-process', 'new-process']) {
      expect(seen).toContainEqual({ event: 'allow-always-permissions', stage, permissionCount: 0 });
    }
    expect(seen).toContainEqual(expect.objectContaining({ event: 'allow-always-files', files: expect.arrayContaining([{ path: 'cli-config.json', settings: { permissions: { allow: ['Shell(ls)', 'Shell(python3)'], deny: [] } } }]) }));
    expect(trace('configuration')).toContainEqual(expect.objectContaining({ direction: 'sent', message: expect.objectContaining({ result: { outcome: { outcome: 'selected', optionId: 'allow-always' } } }) }));
  });

  it('reads a fresh workspace without a separate trust exchange', () => {
    expect(updates('configuration', 'workspace-trust')).toContainEqual(expect.objectContaining({ sessionUpdate: 'tool_call_update', status: 'completed', rawOutput: { content: 'ACP_MAC_TRUST_MARKER\n' } }));
    expect(trace('configuration').filter((entry) => entry.process === 'workspace-trust' && entry.direction === 'received' && entry.message.id !== undefined && entry.message.method !== undefined)).toEqual([]);
  });

  it('finishes background shell work before returning end_turn', () => {
    const entries = trace('configuration').filter((entry) => entry.process === 'background-shell');
    const completion = entries.findIndex((entry) => JSON.stringify(entry.message).includes('ACP_MAC_BACKGROUND_END\\n\\n---\\nexit_code: 0'));
    const ended = entries.findIndex((entry) => JSON.stringify(entry.message.result) === JSON.stringify({ stopReason: 'end_turn' }));
    expect(completion).toBeGreaterThan(0);
    expect(ended).toBeGreaterThan(completion);
  });

  it('records whether a background shell remains running when the prompt ends', () => {
    expect(observations('background-early')).toContainEqual(expect.objectContaining({ event: 'background-at-end-turn', markerAtEndTurn: false, markerLater: true }));
  });

  it('records idle memory and keeps genuine expiry and initialized-turn failures explicitly unproven', () => {
    expect(observations('lifecycle')).toContainEqual(expect.objectContaining({ event: 'idle-rss', kilobytes: 105952, scope: 'agent acp PID, excludes children' }));
    const manifest = z.object({ eligible: z.boolean(), unproven: z.array(z.string()) }).parse(JSON.parse(fixture('capture.json')));
    expect(manifest.eligible).toBe(false);
    expect(manifest.unproven).toEqual(['genuine-expired-login', 'initialized-backend-failed-turn']);
  });

  it('keeps personal paths, profile fields and credentials out of every captured trace', () => {
    for (const name of ['lifecycle', 'model-isolation', 'permission-hold', 'configuration', 'background-early']) {
      const content = fixture(`${name}.jsonl`);
      expect(content).not.toMatch(/\/Users\/[^/\s"']+|Users-[a-z0-9]+-|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|Bearer\s+[A-Za-z0-9._-]+|sk-[A-Za-z0-9_-]{12,}|google-oauth2\||"authInfo"|"userId"/i);
      expect(trace(name).length).toBeGreaterThan(0);
    }
  });
});
