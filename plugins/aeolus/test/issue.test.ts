import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

// A ship reports an issue (#229): the session writes a draft, the plugin
// strips it for the public repository, files it with gh when it can, and
// otherwise leaves the draft and a prefilled link.

const PLUGIN = fileURLToPath(new URL('..', import.meta.url));
const SCRIPTS = join(PLUGIN, 'scripts');
const CREW_TOKEN = 'aeolus_ct_v1_Zp3kQ9mW2xY7';
const SECRET = 'aeolus_sk_v1_uL8cVx2S8UI9oSNZH8';
const SHIP_ID = 'shp_01m3tbfspe96yf1rnr4ank9h1a';
const OTHER_SHIP_ID = 'shp_01m3tbbbhxep52f5yd1kd4vjrc';
const FLEET_URL = 'https://fleet.acme-internal.example';
const REPOSITORY = 'ThomasHendrickx/aeolus-fleet';

let data: string;
let folder: string;
let bin: string;
let ghCalls: string;

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'aeolus-issue-data-'));
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'aeolus-issue-folder-')));
  bin = join(data, 'bin');
  ghCalls = join(data, 'gh.calls');
  mkdirSync(bin);
  expect(run('aeolus-identity.sh', { args: ['write', FLEET_URL, SHIP_ID, 'l3lo', CREW_TOKEN] }).status).toBe(0);
});

afterEach(() => {
  rmSync(data, { recursive: true, force: true });
  rmSync(folder, { recursive: true, force: true });
});

/**
 * Runs a script with AEOLUS_GH naming this test's gh, which exists only once
 * aGh writes it: a gh installed on the machine is never called, so no test
 * files a real issue (#411).
 */
function run(script: string, options: { args?: string[]; env?: Record<string, string> } = {}) {
  const result = spawnSync('bash', [join(SCRIPTS, script), ...(options.args ?? [])], {
    encoding: 'utf8',
    env: { ...process.env, AEOLUS_FOLDER: folder, AEOLUS_DATA: data, AEOLUS_GH: join(bin, 'gh'), PATH: `${bin}:/usr/bin:/bin`, ...options.env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** This test's gh, as AEOLUS_GH names it: signed in or not; `issue create` answers with the new issue's URL. Every call and its body file are logged. */
function aGh(options: { isSignedIn: boolean }): void {
  const gh = join(bin, 'gh');
  writeFileSync(
    gh,
    [
      '#!/usr/bin/env bash',
      `printf '%s\\n' "$*" >> "${ghCalls}"`,
      `if [ "$1 $2" = "auth status" ]; then exit ${options.isSignedIn ? '0' : '1'}; fi`,
      'if [ "$1 $2" = "issue create" ]; then',
      '  while [ "$#" -gt 0 ]; do [ "$1" = --body-file ] && cat "$2" >> "' + ghCalls + '.body"; shift; done',
      `  echo "https://github.com/${REPOSITORY}/issues/240"`,
      'fi',
    ].join('\n'),
  );
  chmodSync(gh, 0o700);
}

/** A draft as the session writes it: a title line, then the report, carrying what a public issue must not. */
function aDraft(body = ''): string {
  const draft = run('aeolus-issue.sh', { args: ['draft'] }).stdout.trim();
  writeFileSync(
    draft,
    [
      '# The watcher woke l3lo four times with nothing to read',
      '',
      `l3lo (${SHIP_ID}) at ${FLEET_URL}/mcp, crewed from ${folder} under ${homedir()}/.claude.`,
      `curl -H "authorization: Bearer ${CREW_TOKEN}" ${FLEET_URL}/api/v1/ship/inbox`,
      `It registered with ${SECRET}. orchestrator-1 is ${OTHER_SHIP_ID}.`,
      body,
    ].join('\n'),
  );
  return draft;
}

describe('aeolus-issue redact', () => {
  it('strips crew tokens, secrets, bearer values, the fleet host, home and folder paths, and ship names and ids, keeping the rest', () => {
    const { status, stdout } = run('aeolus-issue.sh', { args: ['redact', aDraft()] });

    expect(status).toBe(0);
    expect(stdout).toContain('# The watcher woke [ship] four times with nothing to read');
    expect(stdout).toContain('[ship] ([ship id]) at https://[fleet]/mcp, crewed from [folder] under [home]/.claude.');
    expect(stdout).toContain('authorization: Bearer [token]');
    expect(stdout).toContain('It registered with [ship secret].');
    expect(stdout).toContain('orchestrator-1 is [ship id].');
    for (const kept of [CREW_TOKEN, SECRET, SHIP_ID, OTHER_SHIP_ID, 'acme-internal', folder, homedir(), 'l3lo']) {
      expect(stdout).not.toContain(kept);
    }
  });
});

describe('the sensitive-information filter', () => {
  /** Runs one line through redact. */
  function redacted(line: string): string {
    const file = join(data, 'line.md');
    writeFileSync(file, `${line}\n`);
    return run('aeolus-issue.sh', { args: ['redact', file] }).stdout.trimEnd();
  }

  it.each([
    { kind: 'an email address', line: 'mail thomas.h@example.org now', sensitive: 'thomas.h@example.org', placeholder: '[email]' },
    { kind: 'an international phone number', line: 'call +32 470 12 34 56 today', sensitive: '470 12 34 56', placeholder: '[phone]' },
    { kind: 'a national phone number', line: 'call 0470 12 34 56 today', sensitive: '0470 12 34 56', placeholder: '[phone]' },
    { kind: 'an IPv4 address', line: 'from 10.0.12.7.', sensitive: '10.0.12.7', placeholder: '[ip]' },
    { kind: 'an IPv6 address', line: 'from 2001:db8:85a3::8a2e:370:7334 on', sensitive: '2001:db8', placeholder: '[ip]' },
    { kind: 'a short IPv6 address', line: 'bound to fe80::1 here', sensitive: 'fe80::1', placeholder: '[ip]' },
    { kind: 'credentials in a URL', line: 'cloned https://bob:hunter2@git.example.org/x', sensitive: 'hunter2', placeholder: '[credentials]' },
    { kind: 'a token in a URL query', line: 'opened https://github.com/x?token=abc123def&page=2', sensitive: 'abc123def', placeholder: 'token=[token]&page=2' },
    { kind: 'a host other than github.com and aeolus-fleet.dev', line: 'see https://intranet.acme.example/wiki', sensitive: 'intranet.acme.example', placeholder: 'https://[host]/wiki' },
    { kind: 'the host behind URL credentials', line: 'cloned https://bob:hunter2@git.example.org/x', sensitive: 'git.example.org', placeholder: '[credentials]@[host]/x' },
    { kind: 'an Anthropic or OpenAI key', line: 'key sk-ant-api03-AbCdEf0123456789xyz in env', sensitive: 'sk-ant-api03', placeholder: '[api key]' },
    { kind: 'a GitHub token', line: 'token ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8 set', sensitive: 'ghp_a1B2', placeholder: '[api key]' },
    { kind: 'a GitHub fine-grained token', line: 'github_pat_11ABCDEFG0123456789_abcdefghijk set', sensitive: 'github_pat_', placeholder: '[api key]' },
    { kind: 'a Slack token', line: 'xoxb-1234567890-abcdefghij set', sensitive: 'xoxb-', placeholder: '[api key]' },
    { kind: 'an AWS access key', line: 'AKIAIOSFODNN7EXAMPLE set', sensitive: 'AKIAIOSFODNN7EXAMPLE', placeholder: '[api key]' },
    { kind: 'a JWT', line: 'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlMTIz sent', sensitive: 'eyJhbGciOiJIUzI1NiJ9', placeholder: '[jwt]' },
    { kind: 'a long high-entropy string', line: 'value Zx9Qw3Er7Ty1Ui5Op2As8Df4Gh6Jk0Lm here', sensitive: 'Zx9Qw3Er7Ty1Ui5Op2As8Df4Gh6Jk0Lm', placeholder: '[secret]' },
    { kind: 'a card number in groups', line: 'card 4111 1111 1111 1111 used', sensitive: '4111 1111 1111 1111', placeholder: '[card number]' },
    { kind: 'a card number with dashes', line: 'card 4111-1111-1111-1111 used', sensitive: '4111-1111-1111-1111', placeholder: '[card number]' },
    { kind: 'a card number after a date', line: 'on 2026-10-05 4111 1111 1111 1111 used', sensitive: '4111 1111 1111 1111', placeholder: '[card number]' },
    { kind: 'an IBAN in groups', line: 'iban BE68 5390 0754 7034 paid', sensitive: 'BE68 5390 0754 7034', placeholder: '[iban]' },
    { kind: 'an IBAN in one run', line: 'iban NL91ABNA0417164300 paid', sensitive: 'NL91ABNA0417164300', placeholder: '[iban]' },
  ])('replaces $kind', ({ line, sensitive, placeholder }) => {
    const text = redacted(line);

    expect(text).toContain(placeholder);
    expect(text).not.toContain(sensitive);
  });

  it('replaces a private key block, every line of it', () => {
    const text = redacted(['before', '-----BEGIN OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1rZXktdjEAAAAA', '-----END OPENSSH PRIVATE KEY-----', 'after'].join('\n'));

    expect(text).toBe('before\n[private key]\nafter');
  });

  it.each([
    ['a commit sha', 'commit 3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39'],
    ['a version', 'aeolus plugin 0.16.0'],
    ['a timestamp', 'sent 2026-10-05T15:31:17.614Z'],
    ['a time of day', 'the watcher exited 4 at 15:31:17'],
    ['a github.com URL', 'see https://github.com/ThomasHendrickx/aeolus-fleet/issues/228'],
    ['an aeolus-fleet.dev URL', 'see https://aeolus-fleet.dev/docs/plugin and https://docs.aeolus-fleet.dev/x'],
    ['a script name', 'scripts/aeolus-wait.sh exited 6'],
    ['a message id', 'inReplyTo msg_01m469rs4zbzn1mw1vw84vrnqz'],
    ['a digit run that is no card number', 'card 4111 1111 1111 1112 refused'],
    ['a CI run number', 'PR #231, run 37329449841'],
    ['an HTTP status and a duration', 'HTTP 404 after 25 seconds'],
    ['a path without secrets', 'plugins/aeolus/scripts/aeolus-issue.sh'],
  ])('keeps %s', (_kind, line) => {
    expect(redacted(line)).toBe(line);
  });
});

describe('aeolus-issue check', () => {
  it('refuses a text that still carries a crew token, naming what it carries', () => {
    const text = join(data, 'text.md');
    writeFileSync(text, `the token is ${CREW_TOKEN}\n`);

    const { status, stderr } = run('aeolus-issue.sh', { args: ['check', text] });

    expect(status).toBe(3);
    expect(stderr).toContain('a crew token');
    expect(stderr).not.toContain(CREW_TOKEN);
  });

  it('refuses a text that still carries the fleet host or the home path', () => {
    const text = join(data, 'text.md');
    writeFileSync(text, `see ${FLEET_URL.toUpperCase()} and ${homedir()}\n`);

    expect(run('aeolus-issue.sh', { args: ['check', text] }).status).toBe(3);
  });

  it('passes a text that carries none of them', () => {
    const text = join(data, 'text.md');
    writeFileSync(text, 'the watcher exited 4\n');

    expect(run('aeolus-issue.sh', { args: ['check', text] })).toMatchObject({ status: 0 });
  });
});

describe('aeolus-issue file', () => {
  it('files the stripped issue on the repository with gh when it is signed in, saying it was filed by an Aeolus ship', () => {
    aGh({ isSignedIn: true });

    const { status, stdout } = run('aeolus-issue.sh', { args: ['file', aDraft()] });

    expect(status).toBe(0);
    expect(stdout).toBe(
      `aeolus: issue filed: https://github.com/${REPOSITORY}/issues/240\naeolus: tell argo: Issue filed: https://github.com/${REPOSITORY}/issues/240\n`,
    );
    const calls = readFileSync(ghCalls, 'utf8');
    expect(calls).toContain(`issue create --repo ${REPOSITORY} --title The watcher woke [ship] four times with nothing to read --body-file`);
    const body = readFileSync(`${ghCalls}.body`, 'utf8');
    expect(body.match(/Filed by an Aeolus ship/g)).toHaveLength(1);
    expect(body).toMatch(/aeolus plugin \d+\.\d+\.\d+, harness claude-code, OS \w+/);
    expect(body).not.toContain(CREW_TOKEN);
    expect(body).not.toContain('l3lo');
  });

  it('keeps the draft and prints a prefilled new-issue link when gh is not signed in', () => {
    aGh({ isSignedIn: false });
    const draft = aDraft();

    const { status, stdout } = run('aeolus-issue.sh', { args: ['file', draft] });

    expect(status).toBe(0);
    const [draftLine, linkLine] = stdout.trim().split('\n');
    expect(draftLine).toBe(`aeolus: issue draft: ${draft}`);
    const link = new URL(z.string().parse(linkLine?.replace(/^aeolus: open: /, '')));
    expect(`${link.origin}${link.pathname}`).toBe(`https://github.com/${REPOSITORY}/issues/new`);
    expect(link.searchParams.get('title')).toBe('The watcher woke [ship] four times with nothing to read');
    expect(link.searchParams.get('body')).toContain('Filed by an Aeolus ship');
    expect(link.searchParams.get('body')).not.toContain(CREW_TOKEN);
    expect(readFileSync(ghCalls, 'utf8')).not.toContain('issue create');
  });

  it('gives the line to send argo, the draft path going through the same filter', () => {
    const dataUnderAnAddress = join(data, 'bob@example.org');
    mkdirSync(dataUnderAnAddress);
    run('aeolus-identity.sh', { args: ['write', FLEET_URL, SHIP_ID, 'l3lo', CREW_TOKEN], env: { AEOLUS_DATA: dataUnderAnAddress } });
    const draft = run('aeolus-issue.sh', { args: ['draft'], env: { AEOLUS_DATA: dataUnderAnAddress } }).stdout.trim();
    writeFileSync(draft, '# A title\n\nWhat happened\n');

    const lines = run('aeolus-issue.sh', { args: ['file', draft], env: { AEOLUS_DATA: dataUnderAnAddress } }).stdout.trim().split('\n');

    const link = z.string().parse(lines[1]).replace(/^aeolus: open: /, '');
    expect(lines[2]).toMatch(/^aeolus: tell argo: Issue draft: .*\[email\].*\.md, open: /);
    expect(lines[2]).toContain(`, open: ${link}`);
    expect(lines[2]).not.toContain('bob@example.org');
  });

  it('never calls a gh on PATH, signed in or not, but only the gh AEOLUS_GH names', () => {
    const elsewhere = join(data, 'path');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'gh'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${ghCalls}"\necho "https://github.com/${REPOSITORY}/issues/1"\n`);
    chmodSync(join(elsewhere, 'gh'), 0o700);

    const { stdout } = run('aeolus-issue.sh', { args: ['file', aDraft()], env: { PATH: `${elsewhere}:/usr/bin:/bin` } });

    expect(stdout).toContain('aeolus: open: https://github.com/');
    expect(existsSync(ghCalls)).toBe(false);
  });

  it('keeps the draft and prints the link when gh is not installed', () => {
    const { stdout } = run('aeolus-issue.sh', { args: ['file', aDraft()] });

    expect(stdout).toContain('aeolus: open: https://github.com/');
  });

  it('cuts a body too long for a link, saying to paste the rest from the stripped draft', () => {
    const { stdout } = run('aeolus-issue.sh', { args: ['file', aDraft('x'.repeat(9000))] });

    const link = new URL(z.string().parse(stdout.trim().split('\n')[1]?.replace(/^aeolus: open: /, '')));
    expect(link.toString().length).toBeLessThan(8192);
    expect(link.searchParams.get('body')).toContain('Cut to fit the link: paste the rest from the stripped draft.');
  });

  it('files nothing when the stripped text still carries something it must not', () => {
    aGh({ isSignedIn: true });
    const draft = aDraft(`and again ${CREW_TOKEN.toUpperCase()}`);

    const { status, stderr } = run('aeolus-issue.sh', { args: ['file', draft] });

    expect(status).toBe(3);
    expect(stderr).toContain('not filed');
    expect(existsSync(ghCalls) ? readFileSync(ghCalls, 'utf8') : '').not.toContain('issue create');
  });
});

describe('/aeolus:issue and $aeolus-issue', () => {
  /** The Claude Code command and the Codex skill. */
  const texts = () => ['commands/issue.md', 'skills/aeolus-issue/SKILL.md'].map((path) => readFileSync(join(PLUGIN, path), 'utf8'));

  it('investigates, writes the report into a draft, and files it through the plugin script, in both harnesses', () => {
    for (const text of texts()) {
      expect(text).toContain('aeolus-issue.sh');
      expect(text).toContain(' draft');
      expect(text).toContain(' file ');
      expect(text).toContain('What happened');
      expect(text).toContain('Expected');
      expect(text).toContain('Steps');
    }
  });

  it("keeps the report to Aeolus behaviour only: nothing of the user's own project or work, no people, no business details, logs summarised", () => {
    for (const text of texts()) {
      expect(text).toContain('Keep the report to Aeolus behaviour only.');
      expect(text).toContain("No code, file contents, data or names from the user's own project or work");
      expect(text).toContain("no people's names");
      expect(text).toContain('no customer or business details');
      expect(text).toContain("Summarise logs; paste only the plugin's own watcher or bridge lines.");
    }
  });

  it('sends argo the line the script gives for it, never the report itself', () => {
    for (const text of texts()) {
      expect(text).toContain('tell argo:');
    }
  });

  it('sends argo one short message pointing at the issue or the draft, never the report itself', () => {
    for (const text of texts()) {
      expect(text).toContain('`{ "kind": "ship", "name": "argo" }`');
      expect(text).toContain('Issue filed: <url>');
      expect(text).toContain('Issue draft: <path>, open: <link>');
      expect(text).toContain('never the report itself');
    }
  });
});
