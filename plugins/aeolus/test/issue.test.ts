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

function run(script: string, options: { args?: string[]; env?: Record<string, string> } = {}) {
  const result = spawnSync('bash', [join(SCRIPTS, script), ...(options.args ?? [])], {
    encoding: 'utf8',
    env: { ...process.env, AEOLUS_FOLDER: folder, AEOLUS_DATA: data, PATH: `${bin}:/usr/bin:/bin`, ...options.env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A gh on PATH: signed in or not; `issue create` answers with the new issue's URL. Every call and its body file are logged. */
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
    expect(stdout).toBe(`aeolus: issue filed: https://github.com/${REPOSITORY}/issues/240\n`);
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

  it('sends argo one short message pointing at the issue or the draft, never the report itself', () => {
    for (const text of texts()) {
      expect(text).toContain('`{ "kind": "ship", "name": "argo" }`');
      expect(text).toContain('Issue filed: <url>');
      expect(text).toContain('Issue draft: <path>, open: <link>');
      expect(text).toContain('never the report itself');
    }
  });
});
