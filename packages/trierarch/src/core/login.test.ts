import { describe, expect, it } from 'vitest';

import { loginOf } from './login.js';

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
