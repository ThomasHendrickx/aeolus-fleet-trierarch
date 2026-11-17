import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

/**
 * Slice C1 of docs/design/containers-by-default.md: the login roads, proven on
 * Linux with rootless Podman and the session image before anything is built on
 * them. Each harness's capture is what its probe in
 * container-logins-probe recorded, scrubbed: the turns, every request
 * the trierarch's login proxy forwarded, and what the container held.
 */

const FIXTURES = new URL('./fixtures/container-logins/', import.meta.url);
const PLATFORM = 'linux-amd64';
const HARNESSES = ['claude-code', 'codex', 'cursor', 'copilot'] as const;
/** What a container never holds (design 4.2, "What stays out of every container"), each checked by the probe. */
const CREDENTIALS = ['access token', 'refresh token', 'model token', 'api key', 'crew token', 'harness home'] as const;
const PLACES = ['environment', 'files', 'processes'] as const;

const turnSchema = z.object({ name: z.string(), completed: z.boolean(), answer: z.string() });
const requestSchema = z.object({ route: z.string(), method: z.string(), path: z.string(), status: z.number().int(), credential: z.enum(['injected by the proxy', 'refused by the proxy']) });
const captureSchema = z.object({
  harness: z.enum(HARNESSES),
  harnessVersion: z.string().min(1),
  image: z.string().min(1),
  runtime: z.string().min(1),
  road: z.enum(['proxy', 'access file']),
  /** Why the proxy road is impossible, with its evidence; only on the access-file road. */
  proxyImpossible: z.string().optional(),
  turns: z.array(turnSchema),
  requests: z.array(requestSchema),
  container: z.object({ checked: z.array(z.enum(PLACES)), searchedFor: z.array(z.enum(CREDENTIALS)), found: z.array(z.string()) }),
  /** How the host login stays valid, with what proves it. */
  hostLogin: z.object({ renewal: z.enum(['by its harness on the host', 'long-lived, nothing to renew', 'only by signing in again']), evidence: z.string().min(1) }),
  /** The host's login renewed between two turns, where its harness renews it. */
  renewal: z.object({ command: z.string(), accessChanged: z.boolean(), turnsAfter: z.array(turnSchema) }).optional(),
  /** A host login that cannot be renewed: the proxy forwards a refused one, and the turn ends with the harness's own login error. */
  refused: z.object({ turn: turnSchema, vendorStatus: z.number().int() }),
  /** Claude Code on the trierarch's model token (`claude setup-token`): each model alias and the subscription's usage windows, as a print-mode turn streams them. */
  modelToken: z
    .object({
      login: z.literal('model token'),
      aliases: z.array(z.object({ alias: z.string(), completed: z.boolean(), model: z.string() })),
      /** The windows the vendor's answers name (its `anthropic-ratelimit-unified-<window>-status` headers), read at the proxy; and whether Claude Code streamed its rate limit event. */
      usageLimits: z.object({ vendorWindows: z.array(z.string()), vendorStatus: z.enum(['allowed', 'allowed_warning', 'rejected']), rateLimitEventStreamed: z.boolean() }),
    })
    .optional(),
});

type Capture = z.infer<typeof captureSchema>;

function captureOf(harness: (typeof HARNESSES)[number]): Capture {
  return captureSchema.parse(JSON.parse(readFileSync(new URL(`${PLATFORM}/${harness}.json`, FIXTURES), 'utf8')));
}

describe.each(HARNESSES)('%s in a container on Linux', (harness) => {
  it('completes its turns in the session image on the proxy road, the login injected by the trierarch', () => {
    const capture = captureOf(harness);
    expect(capture.road).toBe('proxy');
    expect(capture.image).toMatch(/^aeolus-session:\d/u);
    expect(capture.runtime).toMatch(/rootless/u);
    expect(capture.turns.length).toBeGreaterThan(0);
    expect(capture.turns.every((turn) => turn.completed)).toBe(true);
  });

  it('sends every vendor call through the proxy, which answers it with the host login', () => {
    const { requests } = captureOf(harness);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.filter((request) => request.credential === 'injected by the proxy').length).toBeGreaterThan(0);
    expect(requests.filter((request) => request.credential === 'injected by the proxy' && request.status >= 200 && request.status < 300).length).toBeGreaterThan(0);
  });

  it('holds no refresh token, access, model token, API key, crew token or harness home in its environment, files or processes', () => {
    const { container } = captureOf(harness);
    expect([...container.checked].sort()).toEqual([...PLACES].sort());
    expect([...container.searchedFor].sort()).toEqual([...CREDENTIALS].sort());
    expect(container.found).toEqual([]);
  });

  it('ends a turn with the harness\'s own login error when the host login is refused', () => {
    const { refused } = captureOf(harness);
    expect(refused.vendorStatus).toBe(401);
    expect(refused.turn.completed).toBe(false);
  });
});

describe('a host login over the proxy road', () => {
  it.each([
    ['claude-code', 'long-lived, nothing to renew'],
    ['codex', 'by its harness on the host'],
    ['cursor', 'only by signing in again'],
    ['copilot', 'long-lived, nothing to renew'],
  ] as const)('%s: stays valid %s', (harness, renewal) => {
    expect(captureOf(harness).hostLogin.renewal).toBe(renewal);
  });

  it('completes Codex turns before and after the host renews its ChatGPT login, nobody asked to sign in', () => {
    const capture = captureOf('codex');
    expect(capture.turns.every((turn) => turn.completed)).toBe(true);
    expect(capture.renewal?.accessChanged).toBe(true);
    expect(capture.renewal?.turnsAfter.length).toBeGreaterThan(0);
    expect(capture.renewal?.turnsAfter.every((turn) => turn.completed)).toBe(true);
  });
});

describe('Claude Code on the model token through the proxy', () => {
  it('runs on the trierarch\'s model token, injected by the proxy', () => {
    expect(captureOf('claude-code').modelToken?.login).toBe('model token');
  });

  it.each(['opus', 'sonnet', 'haiku'])('completes a turn on the model alias %s, answered by that model', (alias) => {
    const answered = captureOf('claude-code').modelToken?.aliases.find((turn) => turn.alias === alias);
    expect(answered?.completed).toBe(true);
    expect(answered?.model).toMatch(new RegExp(`^claude-${alias}-`, 'u'));
  });

  it('is answered under the subscription\'s usage windows, which the proxy reads from the vendor\'s answers', () => {
    const limits = captureOf('claude-code').modelToken?.usageLimits;
    expect(limits?.vendorWindows).toContain('seven_day');
    expect(limits?.vendorStatus).toMatch(/^allowed/u);
  });

  it('streams no rate limit event: Claude Code takes the proxy token for an API key, so the subscription\'s windows are read at the proxy', () => {
    expect(captureOf('claude-code').modelToken?.usageLimits.rateLimitEventStreamed).toBe(false);
  });
});

describe('a per-turn harness in a container', () => {
  const execSchema = z.object({ harness: z.literal('codex'), started: z.boolean(), signal: z.literal('SIGINT'), stoppedWithinMs: z.number(), containerKept: z.boolean() });

  it('stops an exec turn by SIGINT to its process group inside the container, the container kept', () => {
    const capture = execSchema.parse(JSON.parse(readFileSync(new URL(`${PLATFORM}/exec-sigint.json`, FIXTURES), 'utf8')));
    expect(capture.started).toBe(true);
    expect(capture.stoppedWithinMs).toBeLessThan(10_000);
    expect(capture.containerKept).toBe(true);
  });
});

describe('container login captures', () => {
  it('hold no credential, account, person, computer or skill list', () => {
    const files = readdirSync(FIXTURES, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const name = `${file.parentPath}/${file.name}`;
      const content = readFileSync(name, 'utf8');
      // A token's shape: Anthropic's, a JWT, GitHub's, Cursor's and OpenAI's.
      expect(content, name).not.toMatch(/sk-ant-|eyJ[\w-]{10,}|\bgh[opsu]_\w{10,}|\bsk-(?:proj-)?\w{16,}|\brt_\w{10,}/u);
      expect(content, name).not.toMatch(/thomas|hendrickx|@[\w-]+\.(?:com|dev|io)\b|\/home\/(?!ubuntu\b)\w+/iu);
      expect(content, name).not.toMatch(/mac[ -]?mini|macbook|\bimac\b|[\w-]+\.local\b(?!\/)|agent-host-\d/iu);
      // An account or session id: a uuid stays out, named by a placeholder.
      expect(content, name).not.toMatch(/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/iu);
      expect(content, name).not.toMatch(/availableCommands|"skills"\s*:\s*\[\s*"/u);
    }
  });
});
