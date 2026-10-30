import { describe, expect, it } from 'vitest';

import { loginAt, loginOf } from './login.js';

describe("a ship's login (api keys K5)", () => {
  it('is its own exception first', () => {
    expect(loginOf({ logins: { default: { 'claude-code': 'apiKey' }, ships: { 'build-docs': 'subscription' } }, harness: 'claude-code', shipName: 'build-docs' })).toBe('subscription');
  });

  it("else its harness's default", () => {
    expect(loginOf({ logins: { default: { 'claude-code': 'apiKey' }, ships: { 'build-docs': 'subscription' } }, harness: 'claude-code', shipName: 'build-api' })).toBe('apiKey');
  });

  it('else the subscription, for a harness with no default', () => {
    expect(loginOf({ logins: { default: { 'claude-code': 'apiKey' } }, harness: 'codex', shipName: 'build-api' })).toBe('subscription');
  });

  it('is the subscription with no logins configured', () => {
    expect(loginOf({ harness: 'claude-code', shipName: 'build-api' })).toBe('subscription');
  });
});

describe('the login a session wrote at a time on (api keys K8)', () => {
  const EARLIER = { login: 'apiKey' as const, earlierLogins: [{ login: 'subscription' as const, until: '2026-10-28T10:00:00.000Z' }, { login: 'apiKey' as const, until: '2026-10-28T12:00:00.000Z' }] };

  it('is the login of the earlier session that ran then', () => {
    expect(loginAt(EARLIER, new Date('2026-10-28T09:59:59.999Z'))).toBe('subscription');
    expect(loginAt(EARLIER, new Date('2026-10-28T11:00:00.000Z'))).toBe('apiKey');
  });

  it('is the next session\'s from the moment it started', () => {
    expect(loginAt({ login: 'subscription', earlierLogins: [{ login: 'apiKey', until: '2026-10-28T10:00:00.000Z' }] }, new Date('2026-10-28T10:00:00.000Z'))).toBe('subscription');
  });

  it('is the login of its running or last session after the last change, and with no earlier login', () => {
    expect(loginAt(EARLIER, new Date('2026-10-28T12:00:00.000Z'))).toBe('apiKey');
    expect(loginAt({ login: 'subscription' }, new Date('2026-10-01T00:00:00.000Z'))).toBe('subscription');
  });
});
