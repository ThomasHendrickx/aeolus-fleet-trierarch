import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

// What a real Claude Code and a real Codex load, started headless in a ship
// folder (docs/design/ship-folder.md, Q6, Q8 and point 8): a folder that is no
// git repository, with a root AGENTS.md, CLAUDE.md a symlink to it, and one
// link per skill under `.claude/skills/` and `.agents/skills/` to a skill in
// `main/` and in `sub-repos/product/`, both git repositories. Each harness
// reports what it was given at start: the root file's marker word in the
// model's answer, and the linked skills in the harness's own record (Claude
// Code's init event, Codex's session file). A failure names the harness and
// every link it did not follow. It needs a signed-in Claude Code
// (AEOLUS_PLUGIN_E2E=1) or a signed-in Codex (AEOLUS_PLUGIN_CODEX_E2E=1), so
// it never runs in CI.

const isClaudeCodeEnabled = process.env.AEOLUS_PLUGIN_E2E === '1';
const isCodexEnabled = process.env.AEOLUS_PLUGIN_CODEX_E2E === '1';
const SIGNED_IN_CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), '.codex');
/** A headless turn starts the harness, thinks and answers once. */
const HARNESS_TIMEOUT_MS = 240_000;
const QUESTION =
  'Run no command, call no tool and read no file: answer only from what you were given at start. ' +
  'What is the marker word of the project instructions of this folder, and which skills do you have, each with its description? ' +
  'Answer on one line.';

/** A skill a repository in the ship folder holds, and the root link to it, per harness. */
interface LinkedSkill { name: string; repository: string; marker: string }
/** What a harness loaded at start: the root file's marker, and per root link whether its skill loaded. */
interface Loaded { hasRootMarker: boolean; links: Record<string, boolean> }

let shipFolder: string;
let rootMarker: string;
let skills: LinkedSkill[];

/** A marker word no harness can know but from the file that holds it. */
function aMarker(what: string): string {
  return `${what}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

/** Every variable a session of the machine's own harness exports (AEOLUS_FOLDER and the like) is left out. */
function harnessEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(AEOLUS_|CLAUDE|CODEX_)/.test(name)));
  return { ...environment, ...extra };
}

/** `<root>/<folder>/<name>`, a link to the same skill in its repository. */
function linkName(folder: string, skill: LinkedSkill): string {
  return `${folder}/${skill.name} -> ${skill.repository}/${folder}/${skill.name}`;
}

function linkSkills(folder: string): void {
  mkdirSync(join(shipFolder, folder), { recursive: true });
  for (const skill of skills) {
    const depth = folder.split('/').map(() => '..').join('/');
    symlinkSync(join(depth, skill.repository, folder, skill.name), join(shipFolder, folder, skill.name));
  }
}

function writeSkill(skill: LinkedSkill, folder: string): void {
  const directory = join(shipFolder, skill.repository, folder, skill.name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'SKILL.md'), ['---', `name: ${skill.name}`, `description: A test skill of the ship folder, marker ${skill.marker}.`, '---', '', 'Say its marker when asked.', ''].join('\n'));
}

function makeShipFolder(): void {
  shipFolder = realpathSync(mkdtempSync(join(tmpdir(), 'aeolus-ship-folder-e2e-')));
  rootMarker = aMarker('ROOT');
  skills = [
    { name: 'ship-folder-main-skill', repository: 'main', marker: aMarker('MAIN') },
    { name: 'ship-folder-product-skill', repository: 'sub-repos/product', marker: aMarker('PRODUCT') },
  ];
  for (const repository of ['main', 'sub-repos/product']) {
    mkdirSync(join(shipFolder, repository), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: join(shipFolder, repository) });
  }
  for (const skill of skills) {
    writeSkill(skill, '.claude/skills');
    writeSkill(skill, '.agents/skills');
  }
  writeFileSync(join(shipFolder, 'AGENTS.md'), `# Ship folder\n\nThe marker word of this folder is ${rootMarker}.\n`);
  symlinkSync('AGENTS.md', join(shipFolder, 'CLAUDE.md'));
  linkSkills('.claude/skills');
  linkSkills('.agents/skills');
}

beforeAll(() => {
  makeShipFolder();
});

afterAll(() => {
  rmSync(shipFolder, { recursive: true, force: true });
});

const claudeCodeInit = z.object({ type: z.literal('system'), subtype: z.literal('init'), skills: z.array(z.string()) });
const claudeCodeResult = z.object({ type: z.literal('result'), result: z.string() });
const codexAgentMessage = z.object({ type: z.literal('item.completed'), item: z.object({ type: z.literal('agent_message'), text: z.string() }) });

describe.skipIf(!isClaudeCodeEnabled)('Claude Code started headless in a ship folder', () => {
  afterAll(() => {
    // Claude Code keeps the turn's transcript per project folder, named by its path.
    rmSync(join(homedir(), '.claude', 'projects', shipFolder.replace(/[^a-zA-Z0-9]/g, '-')), { recursive: true, force: true });
  });

  it('loads the root CLAUDE.md through its link to AGENTS.md and every skill linked from main/ and sub-repos/', () => {
    const output = execFileSync(
      'claude',
      // Project settings only: the machine's own CLAUDE.md, skills and plugins stay out.
      ['--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', 'Skill', '--output-format', 'stream-json', '--verbose', '-p', QUESTION],
      { cwd: shipFolder, encoding: 'utf8', env: harnessEnvironment(), input: '', timeout: HARNESS_TIMEOUT_MS },
    );
    const events: unknown[] = output.split('\n').filter((line) => line.startsWith('{')).map((line): unknown => JSON.parse(line));
    const init = events.map((event) => claudeCodeInit.safeParse(event)).find((parsed) => parsed.success)?.data;
    const answer = events.map((event) => claudeCodeResult.safeParse(event)).find((parsed) => parsed.success)?.data.result ?? '';

    const loaded: Loaded = {
      hasRootMarker: answer.includes(rootMarker),
      links: Object.fromEntries(skills.map((skill) => [linkName('.claude/skills', skill), init?.skills.includes(skill.name) === true])),
    };
    expect(loaded, `Claude Code, which answered: ${answer}`).toEqual({
      hasRootMarker: true,
      links: Object.fromEntries(skills.map((skill) => [linkName('.claude/skills', skill), true])),
    });
  }, HARNESS_TIMEOUT_MS);
});

describe.skipIf(!isCodexEnabled)('Codex started headless in a ship folder', () => {
  let codexHome: string;

  beforeAll(() => {
    // A Codex home of its own, with the signed-in Codex's auth.json, so the machine's skills and settings stay out.
    codexHome = mkdtempSync(join(tmpdir(), 'aeolus-ship-folder-codex-home-'));
    copyFileSync(join(SIGNED_IN_CODEX_HOME, 'auth.json'), join(codexHome, 'auth.json'));
    writeFileSync(join(codexHome, 'config.toml'), [`[projects.${JSON.stringify(shipFolder)}]`, 'trust_level = "trusted"', ''].join('\n'));
  });

  afterAll(() => {
    rmSync(codexHome, { recursive: true, force: true });
  });

  /** What Codex gave the model at start, as its session file records it. */
  function sessionFile(): string {
    const sessions = join(codexHome, 'sessions');
    return readdirSync(sessions, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.jsonl'))
      .map((file) => readFileSync(join(sessions, file), 'utf8'))
      .join('\n');
  }

  it('loads the root AGENTS.md and every skill linked from main/ and sub-repos/', () => {
    const output = execFileSync('codex', ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', QUESTION], {
      cwd: shipFolder,
      encoding: 'utf8',
      env: harnessEnvironment({ CODEX_HOME: codexHome }),
      input: '',
      timeout: HARNESS_TIMEOUT_MS,
    });
    const items: unknown[] = output.split('\n').filter((line) => line.startsWith('{')).map((line): unknown => JSON.parse(line));
    const answer = items
      .map((item) => codexAgentMessage.safeParse(item))
      .flatMap((parsed) => (parsed.success ? [parsed.data.item.text] : []))
      .join('\n');
    const given = sessionFile();

    const loaded: Loaded = {
      hasRootMarker: answer.includes(rootMarker),
      // Codex lists each skill it loaded to the model as `<name>: <description>`.
      links: Object.fromEntries(skills.map((skill) => [linkName('.agents/skills', skill), given.includes(`${skill.name}: A test skill of the ship folder, marker ${skill.marker}.`)])),
    };
    expect(loaded, `Codex, which answered: ${answer}`).toEqual({
      hasRootMarker: true,
      links: Object.fromEntries(skills.map((skill) => [linkName('.agents/skills', skill), true])),
    });
  }, HARNESS_TIMEOUT_MS);
});
