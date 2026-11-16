/** ACP evidence comes from real CLI processes, never model self-reports. */
import { readFileSync, readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const record = z.object({
  process: z.string(),
  direction: z.enum(['sent', 'received']),
  message: z.object({
    id: z.number().optional(),
    method: z.string().optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    result: z.record(z.string(), z.unknown()).optional(),
  }),
});
const capture = () => readFileSync(new URL('./fixtures/cursor-acp/2026.11.13-eacade1/linux/model-isolation.jsonl', import.meta.url), 'utf8')
  .trim().split('\n').map((line) => record.parse(JSON.parse(line)));
const modelOption = z.object({ configOptions: z.array(z.object({ id: z.string(), currentValue: z.string() })) });

describe('Cursor ACP Linux: model isolation across live processes', () => {
  it('keeps the second live process on its model after changing the first process model', () => {
    const messages = capture();
    const state = (process: string, id: number) => modelOption.parse(messages.find((entry) => entry.process === process && entry.direction === 'received' && entry.message.id === id)?.message.result)
      .configOptions.find((option) => option.id === 'model')?.currentValue;

    expect(state('B', 4)).toBe('gpt-5.4-mini[reasoning=medium]');
    expect(state('A', 6)).toBe('composer-2.5[fast=true]');
    expect(state('B', 6)).toBe('gpt-5.4-mini[reasoning=medium]');
    expect(state('B', 8)).toBe('gpt-5.4-mini[reasoning=medium]');
    expect(messages.some((entry) => entry.process === 'A' && entry.message.method === 'session/set_model')).toBe(true);
  });
});

const scenarioMessages = (name: string) => readFileSync(new URL(`./fixtures/cursor-acp/2026.11.13-eacade1/linux/${name}.jsonl`, import.meta.url), 'utf8')
  .trim().split('\n').map((line) => z.object({ process: z.string(), direction: z.enum(['sent', 'received']), message: z.record(z.string(), z.unknown()) }).parse(JSON.parse(line)));

describe('Cursor ACP Linux: session failures and recovery', () => {
  it('returns an auth error with no machine login', () => {
    const messages = scenarioMessages('no-login');
    expect(messages.find((entry) => entry.direction === 'received' && entry.message.id === 2)?.message).toMatchObject({ error: { code: -32000 } });
  });

  it('refuses a missing session id rather than creating a session silently', () => {
    const messages = scenarioMessages('missing-session');
    expect(messages.find((entry) => entry.direction === 'received' && entry.message.id === 2)?.message).toHaveProperty('error');
  });

  it('records a killed prompt and loads the same session in a new process', () => {
    const messages = scenarioMessages('killed-turn');
    expect(messages.find((entry) => entry.process === 'restart' && entry.direction === 'sent' && entry.message.method === 'session/load')?.message).toMatchObject({ params: { sessionId: 'session-killed' } });
    expect(messages.find((entry) => entry.process === 'restart' && entry.direction === 'received' && entry.message.id === 2)?.message).toHaveProperty('result');
  });
});

describe('Cursor ACP Linux: captured configuration boundaries', () => {
  it('captures how session/new handles a supplied modelId', () => {
    const messages = scenarioMessages('new-model');
    expect(messages.find((entry) => entry.direction === 'sent' && entry.message.method === 'session/new')?.message).toMatchObject({ params: { modelId: 'gpt-5.4-mini[reasoning=medium]' } });
    expect(messages.find((entry) => entry.direction === 'received' && entry.message.id === 2)?.message).toHaveProperty('result.models.currentModelId');
  });

  it('records that invalid image bytes still end the turn successfully', () => {
    const messages = scenarioMessages('failed-turn');
    expect(messages.find((entry) => entry.direction === 'received' && entry.message.id === 3)?.message).toMatchObject({ result: { stopReason: 'end_turn' } });
  });

  it('records the exclusion blocker rather than treating this build as proven', () => {
    const evidence = z.object({ sentinelStarted: z.boolean(), loginSucceeded: z.boolean() }).parse(JSON.parse(readFileSync(new URL('./fixtures/cursor-acp/2026.11.13-eacade1/linux/mcp-trust.capture.json', import.meta.url), 'utf8')));
    expect(evidence).toEqual({ sentinelStarted: true, loginSucceeded: true });
    const sources = z.array(z.object({ source: z.string(), beforeInitialize: z.boolean(), afterInitialize: z.boolean(), afterNew: z.boolean(), sessionCreated: z.boolean() })).parse(JSON.parse(readFileSync(new URL('./fixtures/cursor-acp/2026.11.13-eacade1/linux/mcp-exclusion.capture.json', import.meta.url), 'utf8')));
    expect(sources).toEqual([
      { source: 'home', beforeInitialize: false, afterInitialize: false, afterNew: true, sessionCreated: true },
      { source: 'xdg', beforeInitialize: false, afterInitialize: false, afterNew: false, sessionCreated: true },
      { source: 'project', beforeInitialize: false, afterInitialize: false, afterNew: false, sessionCreated: true },
    ]);
    expect(scenarioMessages('mcp-trust').find((entry) => entry.direction === 'received' && entry.message.id === 3)?.message).toMatchObject({ result: { stopReason: 'end_turn' } });
  });
});

describe('Cursor ACP Linux: permissions and idle processes', () => {
  it('persists allow-always into user configuration and a subsequent process', () => {
    const evidence = z.object({ firstPermissions: z.number(), newProcessPermissions: z.number(), changedPaths: z.array(z.string()) }).parse(JSON.parse(readFileSync(new URL('./fixtures/cursor-acp/2026.11.13-eacade1/linux/permission-persistence.capture.json', import.meta.url), 'utf8')));
    expect(evidence.firstPermissions).toBe(1);
    expect(evidence.newProcessPermissions).toBe(0);
    expect(evidence.changedPaths).toContain('.config/cursor/cli-config.json');
  });

  it('measures both the idle process and its child processes', () => {
    const evidence = z.object({ rootRssKiB: z.number(), treeRssKiB: z.number(), processCount: z.number() }).parse(JSON.parse(readFileSync(new URL('./fixtures/cursor-acp/2026.11.13-eacade1/linux/idle-memory.capture.json', import.meta.url), 'utf8')));
    expect(evidence.rootRssKiB).toBeGreaterThan(0);
    expect(evidence.treeRssKiB).toBeGreaterThanOrEqual(evidence.rootRssKiB);
    expect(evidence.processCount).toBeGreaterThanOrEqual(1);
  });

  it('observes the shell completion marker separately from the prompt response', () => {
    const evidence = z.object({ markerAtPromptEnd: z.boolean(), markerObserved: z.boolean() }).parse(JSON.parse(readFileSync(new URL('./fixtures/cursor-acp/2026.11.13-eacade1/linux/background.capture.json', import.meta.url), 'utf8')));
    expect(evidence.markerAtPromptEnd).toBe(false);
    expect(evidence.markerObserved).toBe(true);
  });
});


describe('Cursor ACP captured fixture privacy', () => {
  it('stores valid JSON without private home paths, email addresses or credential fields', () => {
    const folder = new URL('./fixtures/cursor-acp/2026.11.13-eacade1/linux/', import.meta.url);
    const names = readdirSync(folder).filter((name) => /\.jsonl?$/.test(name));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const content = readFileSync(new URL(name, folder), 'utf8');
      for (const line of name.endsWith('.jsonl') ? content.trim().split('\n') : [content]) {
        expect(() => JSON.parse(line), name).not.toThrow();
      }
      expect(content, name).not.toMatch(/\/home\/(?!probe(?:\/|"))[^/"\s]+|\/Users\/(?!probe(?:\/|"))[^/"\s]+/);
      expect(content, name).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
      expect(content, name).not.toMatch(/"(?:accessToken|refreshToken|apiKey|authorization)"\s*:/i);
    }
  });
});
