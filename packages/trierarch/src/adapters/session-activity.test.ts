import { describe, expect, it } from 'vitest';

import { claudeCodeActivityIn, codexActivityIn, copilotActivityIn } from './session-activity.js';

/** One event line as a harness writes it. */
const line = (event: unknown): string => JSON.stringify(event);

describe('the activity of a Claude Code session, from its latest event', () => {
  const assistant = (...content: unknown[]) => line({ type: 'assistant', message: { role: 'assistant', content } });

  it('is a tool call, with the tool, when the latest event asks for one', () => {
    expect(claudeCodeActivityIn([assistant({ type: 'text', text: 'Running it.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } })])).toEqual({ kind: 'tool', tool: 'Bash' });
  });

  it('is text when the latest event is the assistant speaking', () => {
    expect(claudeCodeActivityIn([assistant({ type: 'text', text: 'Done.' })])).toEqual({ kind: 'text' });
  });

  it('is a result when the latest event is a tool result coming back', () => {
    expect(claudeCodeActivityIn([line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } })])).toEqual({ kind: 'result' });
  });

  it('is a result when the turn ended well, and an error when it ended in one', () => {
    expect(claudeCodeActivityIn([line({ type: 'result', subtype: 'success', is_error: false, result: 'Done.' })])).toEqual({ kind: 'result' });
    expect(claudeCodeActivityIn([line({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Not logged in' })])).toEqual({ kind: 'error' });
  });

  it('skips events that are no activity, and a line that is no JSON', () => {
    expect(claudeCodeActivityIn([assistant({ type: 'text', text: 'Hi' }), line({ type: 'system', subtype: 'init' }), 'not json', line({ type: 'control_response' })])).toEqual({ kind: 'text' });
  });

  it('is none for events that show no activity yet', () => {
    expect(claudeCodeActivityIn([line({ type: 'system', subtype: 'init' })])).toBeUndefined();
    expect(claudeCodeActivityIn([])).toBeUndefined();
  });

  it('carries no content of the event, only its kind and tool', () => {
    expect(claudeCodeActivityIn([assistant({ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cat secrets' } })])).toStrictEqual({ kind: 'tool', tool: 'Bash' });
  });
});

describe('the activity of a Codex session, from its latest event', () => {
  it('is text when the latest event is an agent message', () => {
    expect(codexActivityIn([line({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'done' } })])).toEqual({ kind: 'text' });
  });

  it('is a tool call, named by the item type, when an item other than a message starts or completes', () => {
    expect(codexActivityIn([line({ type: 'item.started', item: { id: 'item_2', type: 'command_execution', command: 'ls' } })])).toEqual({ kind: 'tool', tool: 'command_execution' });
    expect(codexActivityIn([line({ type: 'item.completed', item: { id: 'item_2', type: 'command_execution', command: 'ls' } })])).toEqual({ kind: 'tool', tool: 'command_execution' });
  });

  it('is a result when the turn completed, and an error when it failed or an error event came', () => {
    expect(codexActivityIn([line({ type: 'turn.completed', usage: {} })])).toEqual({ kind: 'result' });
    expect(codexActivityIn([line({ type: 'turn.failed', error: { message: 'x' } })])).toEqual({ kind: 'error' });
    expect(codexActivityIn([line({ type: 'error', message: 'x' })])).toEqual({ kind: 'error' });
    expect(codexActivityIn([line({ type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'x' } })])).toEqual({ kind: 'error' });
  });

  it('is none for events that show no activity yet', () => {
    expect(codexActivityIn([line({ type: 'thread.started', thread_id: 'x' }), line({ type: 'turn.started' })])).toBeUndefined();
  });
});

describe('the activity of a Copilot session, from its latest event', () => {
  it('is a tool call, with the tool, when a tool execution starts', () => {
    expect(copilotActivityIn([line({ type: 'tool.execution_start', data: { toolName: 'bash', arguments: { command: 'sleep 40' } } })])).toEqual({ kind: 'tool', tool: 'bash' });
  });

  it('is a result when a tool execution completed or the session ended in its result', () => {
    expect(copilotActivityIn([line({ type: 'tool.execution_complete', data: { toolName: 'bash' } })])).toEqual({ kind: 'result' });
    expect(copilotActivityIn([line({ type: 'result', exitCode: 0 })])).toEqual({ kind: 'result' });
  });

  it('is text when the assistant said something, and none for one that only asked for tools', () => {
    expect(copilotActivityIn([line({ type: 'assistant.message', data: { content: 'OK' } })])).toEqual({ kind: 'text' });
    expect(copilotActivityIn([line({ type: 'session.mcp_server_status_changed', data: {} }), line({ type: 'assistant.message', data: { content: '' } })])).toBeUndefined();
  });

  it('is an error on a session error', () => {
    expect(copilotActivityIn([line({ type: 'session.error', data: { message: 'x' } })])).toEqual({ kind: 'error' });
  });
});
