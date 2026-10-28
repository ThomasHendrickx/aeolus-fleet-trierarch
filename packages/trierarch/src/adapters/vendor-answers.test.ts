import { describe, expect, it } from 'vitest';

import { keyStateOfAnswer } from './vendor-answers.js';

const anthropic = (status: number, error: { type: string; message?: string }) => keyStateOfAnswer({ harness: 'claude-code', status, body: JSON.stringify({ type: 'error', error: { message: '', ...error } }) });
const openai = (status: number, error: { code: string | null; type?: string }) => keyStateOfAnswer({ harness: 'codex', status, body: JSON.stringify({ error: { message: 'm', type: 'invalid_request_error', ...error } }) });

describe("what a vendor's answer to a key says of it (api keys K9)", () => {
  it('a success: the key works', () => {
    expect(keyStateOfAnswer({ harness: 'claude-code', status: 200, body: '' })).toBe('ready');
  });

  it("Anthropic's 401 authentication_error: refused", () => {
    expect(anthropic(401, { type: 'authentication_error' })).toBe('refused');
  });

  it("Anthropic's 402 billing_error: out of credit", () => {
    expect(anthropic(402, { type: 'billing_error' })).toBe('outOfCredit');
  });

  it("Anthropic's credit balance too low: out of credit", () => {
    expect(anthropic(400, { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' })).toBe('outOfCredit');
  });

  it("Anthropic's spend limit: out of credit", () => {
    expect(anthropic(429, { type: 'rate_limit_error', message: 'You have reached your specified workspace API usage limits.' })).toBe('outOfCredit');
  });

  it("Anthropic's rate limit: says nothing of the key", () => {
    expect(anthropic(429, { type: 'rate_limit_error', message: 'Number of request tokens has exceeded your per-minute rate limit' })).toBeUndefined();
  });

  it("OpenAI's 401: refused", () => {
    expect(openai(401, { code: 'invalid_api_key' })).toBe('refused');
  });

  it("OpenAI's insufficient_quota and spend limits: out of credit", () => {
    expect(openai(429, { code: 'insufficient_quota', type: 'insufficient_quota' })).toBe('outOfCredit');
    expect(openai(429, { code: 'credit_balance_exhausted', type: 'insufficient_quota' })).toBe('outOfCredit');
    expect(openai(429, { code: 'organization_spend_limit_exceeded' })).toBe('outOfCredit');
    expect(openai(429, { code: 'project_spend_limit_exceeded' })).toBe('outOfCredit');
  });

  it("OpenAI's rate limit: says nothing of the key", () => {
    expect(openai(429, { code: 'rate_limit_exceeded', type: 'requests' })).toBeUndefined();
  });

  it("a server error, or a body that is no JSON: says nothing of the key", () => {
    expect(keyStateOfAnswer({ harness: 'codex', status: 500, body: '<html>' })).toBeUndefined();
    expect(keyStateOfAnswer({ harness: 'claude-code', status: 529, body: '' })).toBeUndefined();
  });
});
