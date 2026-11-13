import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONFIGURATION, inRepositories, newId } from '../../test/support/in-memory.js';
import { createCloneWorkspace } from './clone-workspace.js';
import { createGitWorkspace } from './git-workspace.js';
import { runCommand } from './run-command.js';
import { rootInstructionsOf } from './ship-folder.js';

// Against the real git, in a temporary folder: the ship folder a host's worktrees and a container's clones make.

let folder: string;
let root: string;
let shipFolder: string;
let repositories: Record<string, { path: string }>;
/** A folder a test made unreadable, readable again before the temporary folder goes. */
let unreadable: string | undefined;

async function git(args: string[]): Promise<string> {
  const result = await runCommand('git', { args, env: { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' } });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function aRepository(name: string): Promise<string> {
  const path = join(folder, name);
  await git(['init', '-q', '-b', 'main', path]);
  writeFileSync(join(path, `${name}.md`), `${name}\n`);
  await git(['-C', path, 'add', '.']);
  await git(['-C', path, 'commit', '-q', '-m', 'init']);
  return path;
}

const workspace = () => createGitWorkspace({ configuration: { ...CONFIGURATION, repositories, folders: {} }, root });
const clones = () => createCloneWorkspace({ configuration: { ...CONFIGURATION, repositories, folders: {} }, root });

const crew = (main: string, subRepositories: readonly string[] = []) => ({ shipId: newId('ship'), shipName: 'scout', workspace: inRepositories(main, { subRepositories }), shipFolder });

/** The repository a worktree is of: its checkout's git folder. */
const commonGitFolderOf = (worktree: string): Promise<string> => git(['-C', worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir']);

beforeEach(async () => {
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'trierarch-ship-folder-')));
  root = join(folder, 'ships');
  shipFolder = join(root, newId('ship'));
  repositories = { 'aeolus-fleet': { path: await aRepository('aeolus-fleet') }, tools: { path: await aRepository('tools') }, skills: { path: await aRepository('skills') } };
});

afterEach(() => {
  if (unreadable !== undefined) {
    chmodSync(unreadable, 0o700);
    unreadable = undefined;
  }
  rmSync(folder, { recursive: true, force: true });
});

describe('a ship folder on the host', () => {
  it("is repositories/ in the ship's folder, its main repository in main/ and each sub-repository in sub-repos/<repository>/, each a worktree of its repository", async () => {
    const { folder: made } = await workspace().prepare(crew('aeolus-fleet', ['tools', 'skills']));

    expect(made).toBe(join(shipFolder, 'repositories'));
    await expect(commonGitFolderOf(join(made, 'main'))).resolves.toBe(join(folder, 'aeolus-fleet', '.git'));
    await expect(commonGitFolderOf(join(made, 'sub-repos', 'tools'))).resolves.toBe(join(folder, 'tools', '.git'));
    await expect(commonGitFolderOf(join(made, 'sub-repos', 'skills'))).resolves.toBe(join(folder, 'skills', '.git'));
    expect(existsSync(join(made, '.git'))).toBe(false);
  });

  it('has each repository at its ref', async () => {
    await git(['-C', repositories.tools?.path ?? '', 'tag', 'v1']);
    writeFileSync(join(repositories.tools?.path ?? '', 'later.md'), 'later\n');
    await git(['-C', repositories.tools?.path ?? '', 'add', '.']);
    await git(['-C', repositories.tools?.path ?? '', 'commit', '-q', '-m', 'later']);

    const { folder: made } = await workspace().prepare({ ...crew('aeolus-fleet'), workspace: { kind: 'repositories', main: { repository: 'aeolus-fleet' }, subRepositories: [{ repository: 'tools', ref: 'v1' }] } });

    expect(existsSync(join(made, 'sub-repos', 'tools', 'later.md'))).toBe(false);
  });

  it("keeps each repository a new settings version still names as it is, makes each it newly names, and moves each it no longer names into the trash beside the ships' folders", async () => {
    const { folder: made } = await workspace().prepare(crew('aeolus-fleet', ['tools']));
    writeFileSync(join(made, 'main', 'kept.txt'), 'kept\n');
    writeFileSync(join(made, 'sub-repos', 'tools', 'unsaved.txt'), 'unsaved\n');

    await workspace().prepare({ ...crew('aeolus-fleet', ['skills']), madeMain: 'aeolus-fleet' });

    expect(readFileSync(join(made, 'main', 'kept.txt'), 'utf8')).toBe('kept\n');
    expect(readdirSync(join(made, 'sub-repos'))).toEqual(['skills']);
    expect(readdirSync(join(root, '.trash')).map((name) => name.startsWith('tools.'))).toEqual([true]);
  });

  it('replaces main/ when a new settings version names another main repository', async () => {
    const { folder: made } = await workspace().prepare(crew('aeolus-fleet'));

    await workspace().prepare({ ...crew('tools'), madeMain: 'aeolus-fleet' });

    await expect(commonGitFolderOf(join(made, 'main'))).resolves.toBe(join(folder, 'tools', '.git'));
  });

  it("fails with git's message for a repository git cannot make, keeping those made for the next try", async () => {
    await git(['-C', repositories.tools?.path ?? '', 'update-ref', '-d', 'refs/heads/main']);

    await expect(workspace().prepare(crew('aeolus-fleet', ['tools']))).rejects.toThrow('git worktree add failed: fatal: invalid reference: HEAD');

    expect(existsSync(join(shipFolder, 'repositories', 'main', 'aeolus-fleet.md'))).toBe(true);
    expect(existsSync(join(shipFolder, 'repositories', 'sub-repos', 'tools'))).toBe(false);
  });

  it('tells the main repository it made before a sub-repository git cannot make fails it, so the next try keeps it', async () => {
    await workspace().prepare(crew('aeolus-fleet'));
    await git(['-C', repositories.skills?.path ?? '', 'update-ref', '-d', 'refs/heads/main']);
    const made: string[] = [];

    await expect(
      workspace().prepare({
        ...crew('tools', ['skills']),
        madeMain: 'aeolus-fleet',
        onMainMade: (repository) => {
          made.push(repository);
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow('git worktree add failed');

    expect(made).toEqual(['tools']);
  });

  it('fails to say what removing it would discard when a folder in it cannot be read, rather than leaving a repository out', async () => {
    const { folder: made } = await workspace().prepare(crew('aeolus-fleet', ['tools']));
    unreadable = join(made, 'sub-repos');
    chmodSync(unreadable, 0o000);

    await expect(workspace().unsavedInShipFolder(made)).rejects.toThrow('EACCES');
  });

  it('says nothing would be discarded from a ship folder that is gone', async () => {
    await expect(workspace().unsavedInShipFolder(join(shipFolder, 'repositories'))).resolves.toEqual([]);
  });

  it('says what removing each repository it holds would discard, by its folder', async () => {
    const { folder: made } = await workspace().prepare(crew('aeolus-fleet', ['tools']));
    writeFileSync(join(made, 'sub-repos', 'tools', 'draft.md'), 'draft\n');
    writeFileSync(join(made, 'notes.md'), 'at the root, in no repository\n');

    await expect(workspace().unsavedInShipFolder(made)).resolves.toEqual([
      { folder: join(made, 'main'), unsaved: [] },
      { folder: join(made, 'sub-repos', 'tools'), unsaved: ['?? draft.md'] },
    ]);
  });
});

describe('the root files of a ship folder', () => {
  it('are an AGENTS.md naming each sub-repository and the layout, and CLAUDE.md a link to it', async () => {
    const at = crew('aeolus-fleet', ['tools']);
    const { folder: made } = await workspace().prepare(at);

    await workspace().writeRootFiles({ folder: made, workspace: at.workspace });

    expect(readFileSync(join(made, 'AGENTS.md'), 'utf8')).toBe(
      [
        '# This ship folder',
        '',
        'This folder holds the repositories this ship works in. Work from `main/`, the main repository: read `main/AGENTS.md` first, or `main/CLAUDE.md` where it has none, and follow it.',
        '',
        '## Sub-repositories',
        '',
        '- `sub-repos/tools/`: read its AGENTS.md, or its CLAUDE.md where it has none, before working in it.',
        '',
        '## The layout',
        '',
        '- Each repository commits, branches and pushes on its own: run git inside the one you work in.',
        '- This folder holds no repository of its own: nothing outside a repository is committed, so keep your work in one.',
        "- The files and links at this folder's root, this AGENTS.md and CLAUDE.md a link to it, are the trierarch's, written again at every start: change nothing here.",
        '',
      ].join('\n'),
    );
    expect([lstatSync(join(made, 'CLAUDE.md')).isSymbolicLink(), readlinkSync(join(made, 'CLAUDE.md'))]).toEqual([true, 'AGENTS.md']);
  });

  it('say so when the ship has no sub-repository', () => {
    expect(rootInstructionsOf({ kind: 'repositories', main: { repository: 'aeolus-fleet' }, subRepositories: [] })).toContain('## Sub-repositories\n\nNone: this ship works in its main repository alone.\n');
  });

  it('are written again over whatever the session left there', async () => {
    const at = crew('aeolus-fleet');
    const { folder: made } = await workspace().prepare(at);
    mkdirSync(join(made, 'AGENTS.md'));
    writeFileSync(join(made, 'CLAUDE.md'), 'changed by the session\n');

    await workspace().writeRootFiles({ folder: made, workspace: at.workspace });

    expect([statSync(join(made, 'AGENTS.md')).isFile(), readlinkSync(join(made, 'CLAUDE.md'))]).toEqual([true, 'AGENTS.md']);
  });

  it('are none in a configured folder', async () => {
    const notes = join(folder, 'notes');
    mkdirSync(notes);

    await workspace().writeRootFiles({ folder: notes, workspace: { kind: 'folder', name: 'notes' } });

    expect(readdirSync(notes)).toEqual([]);
  });
});

/** Commits a skill to a repository: `<harnessFolder>/<skill>/SKILL.md` holding the content. */
async function aSkill(of: { repository: string; at: `${'.claude' | '.agents'}/skills/${string}` }, content: string): Promise<void> {
  const { repository, at } = of;
  const path = repositories[repository]?.path ?? '';
  mkdirSync(join(path, at), { recursive: true });
  writeFileSync(join(path, at, 'SKILL.md'), content);
  await git(['-C', path, 'add', '.']);
  await git(['-C', path, 'commit', '-q', '-m', `skill ${at}`]);
}

async function rootFilesOf(main: string, subRepositories: readonly string[] = []): Promise<string> {
  const at = crew(main, subRepositories);
  const { folder: made } = await workspace().prepare(at);
  await workspace().writeRootFiles({ folder: made, workspace: at.workspace });
  return made;
}

describe('the skills at the root of a ship folder', () => {
  it('are one link per skill of main/ and of every sub-repository, under .claude/skills and .agents/skills, each to the skill in its repository', async () => {
    await aSkill({ repository: 'aeolus-fleet', at: '.claude/skills/build' }, 'build\n');
    await aSkill({ repository: 'aeolus-fleet', at: '.agents/skills/build' }, 'build\n');
    await aSkill({ repository: 'tools', at: '.claude/skills/lint' }, 'lint\n');
    await aSkill({ repository: 'skills', at: '.agents/skills/review' }, 'review\n');

    const made = await rootFilesOf('aeolus-fleet', ['tools', 'skills']);

    expect(readlinkSync(join(made, '.claude', 'skills', 'build'))).toBe('../../main/.claude/skills/build');
    expect(readlinkSync(join(made, '.agents', 'skills', 'build'))).toBe('../../main/.agents/skills/build');
    expect(readlinkSync(join(made, '.claude', 'skills', 'lint'))).toBe('../../sub-repos/tools/.claude/skills/lint');
    expect(readlinkSync(join(made, '.agents', 'skills', 'review'))).toBe('../../sub-repos/skills/.agents/skills/review');
    expect(readFileSync(join(made, '.claude', 'skills', 'lint', 'SKILL.md'), 'utf8')).toBe('lint\n');
    expect(readdirSync(join(made, '.claude', 'skills')).sort()).toEqual(['build', 'lint']);
    expect(readdirSync(join(made, '.agents', 'skills')).sort()).toEqual(['build', 'review']);
  });

  it('are one link, and nothing said, for a skill name two repositories share with the same content', async () => {
    await aSkill({ repository: 'aeolus-fleet', at: '.claude/skills/review' }, 'review\n');
    await aSkill({ repository: 'tools', at: '.claude/skills/review' }, 'review\n');

    const made = await rootFilesOf('aeolus-fleet', ['tools']);

    expect(readlinkSync(join(made, '.claude', 'skills', 'review'))).toBe('../../main/.claude/skills/review');
    expect(readFileSync(join(made, 'AGENTS.md'), 'utf8')).toBe(rootInstructionsOf({ kind: 'repositories', main: { repository: 'aeolus-fleet' }, subRepositories: [{ repository: 'tools' }] }));
  });

  it('are no link for a skill name two repositories share with different content, and the root AGENTS.md names both and where they are and says to ask the ship\'s owner before using either', async () => {
    await aSkill({ repository: 'aeolus-fleet', at: '.claude/skills/review' }, 'one way\n');
    await aSkill({ repository: 'tools', at: '.claude/skills/review' }, 'another way\n');
    await aSkill({ repository: 'tools', at: '.claude/skills/lint' }, 'lint\n');

    const made = await rootFilesOf('aeolus-fleet', ['tools']);

    expect(readdirSync(join(made, '.claude', 'skills'))).toEqual(['lint']);
    const agents = readFileSync(join(made, 'AGENTS.md'), 'utf8');
    expect(agents).toContain(
      [
        '## Skills the repositories disagree on',
        '',
        "- `review`: `main/.claude/skills/review` and `sub-repos/tools/.claude/skills/review` differ. Ask the ship's owner for guidance before using either.",
        '',
      ].join('\n'),
    );
    expect(agents).not.toContain('`lint`');
  });

  it('name every repository of a clash among three, and link none of them', async () => {
    await aSkill({ repository: 'aeolus-fleet', at: '.agents/skills/review' }, 'same\n');
    await aSkill({ repository: 'tools', at: '.agents/skills/review' }, 'same\n');
    await aSkill({ repository: 'skills', at: '.agents/skills/review' }, 'different\n');

    const made = await rootFilesOf('aeolus-fleet', ['tools', 'skills']);

    expect(existsSync(join(made, '.agents', 'skills', 'review'))).toBe(false);
    expect(readFileSync(join(made, 'AGENTS.md'), 'utf8')).toContain(
      "- `review`: `main/.agents/skills/review`, `sub-repos/tools/.agents/skills/review` and `sub-repos/skills/.agents/skills/review` differ. Ask the ship's owner for guidance before using any of them.",
    );
  });

  it('judge a skill name by each harness folder alone, so a clash under .claude/skills leaves .agents/skills linked', async () => {
    await aSkill({ repository: 'aeolus-fleet', at: '.claude/skills/review' }, 'one way\n');
    await aSkill({ repository: 'tools', at: '.claude/skills/review' }, 'another way\n');
    await aSkill({ repository: 'tools', at: '.agents/skills/review' }, 'only here\n');

    const made = await rootFilesOf('aeolus-fleet', ['tools']);

    expect(existsSync(join(made, '.claude', 'skills', 'review'))).toBe(false);
    expect(readlinkSync(join(made, '.agents', 'skills', 'review'))).toBe('../../sub-repos/tools/.agents/skills/review');
  });

  it('judge the content of a skill by every file in it, not its SKILL.md alone', async () => {
    await aSkill({ repository: 'aeolus-fleet', at: '.claude/skills/review' }, 'same\n');
    await aSkill({ repository: 'tools', at: '.claude/skills/review' }, 'same\n');
    writeFileSync(join(repositories.tools?.path ?? '', '.claude', 'skills', 'review', 'checklist.md'), 'extra\n');
    await git(['-C', repositories.tools?.path ?? '', 'add', '.']);
    await git(['-C', repositories.tools?.path ?? '', 'commit', '-q', '-m', 'checklist']);

    const made = await rootFilesOf('aeolus-fleet', ['tools']);

    expect(existsSync(join(made, '.claude', 'skills', 'review'))).toBe(false);
    expect(readFileSync(join(made, 'AGENTS.md'), 'utf8')).toContain('Skills the repositories disagree on');
  });

  it('are one link, and nothing said, for a skill name two repositories share when one holds an extra empty folder', async () => {
    await aSkill({ repository: 'aeolus-fleet', at: '.claude/skills/review' }, 'review\n');
    await aSkill({ repository: 'tools', at: '.claude/skills/review' }, 'review\n');
    const at = crew('aeolus-fleet', ['tools']);
    const { folder: made } = await workspace().prepare(at);
    mkdirSync(join(made, 'sub-repos', 'tools', '.claude', 'skills', 'review', 'drafts'));
    await workspace().writeRootFiles({ folder: made, workspace: at.workspace });

    expect(readlinkSync(join(made, '.claude', 'skills', 'review'))).toBe('../../main/.claude/skills/review');
    expect(readFileSync(join(made, 'AGENTS.md'), 'utf8')).not.toContain('disagree');
  });

  it('are linked again without deleting anything in a repository when the session left the root .claude as a link into one', async () => {
    await aSkill({ repository: 'aeolus-fleet', at: '.claude/skills/build' }, 'build\n');
    const at = crew('aeolus-fleet');
    const { folder: made } = await workspace().prepare(at);
    await workspace().writeRootFiles({ folder: made, workspace: at.workspace });
    rmSync(join(made, '.claude'), { recursive: true });
    symlinkSync('main/.claude', join(made, '.claude'));

    await workspace().writeRootFiles({ folder: made, workspace: at.workspace });

    expect(readFileSync(join(made, 'main', '.claude', 'skills', 'build', 'SKILL.md'), 'utf8')).toBe('build\n');
    expect(lstatSync(join(made, '.claude')).isSymbolicLink()).toBe(false);
    expect(readlinkSync(join(made, '.claude', 'skills', 'build'))).toBe('../../main/.claude/skills/build');
  });

  it('are linked again at every start, over what the session left and for the repositories as they are now', async () => {
    await aSkill({ repository: 'aeolus-fleet', at: '.claude/skills/build' }, 'build\n');
    const at = crew('aeolus-fleet');
    const { folder: made } = await workspace().prepare(at);
    await workspace().writeRootFiles({ folder: made, workspace: at.workspace });
    rmSync(join(made, 'main', '.claude', 'skills', 'build'), { recursive: true });
    mkdirSync(join(made, '.agents', 'skills'), { recursive: true });
    writeFileSync(join(made, '.agents', 'skills', 'mine'), 'left by the session\n');

    await workspace().writeRootFiles({ folder: made, workspace: at.workspace });

    expect(existsSync(join(made, '.claude'))).toBe(false);
    expect(existsSync(join(made, '.agents'))).toBe(false);
  });

  it('are none, with no .claude or .agents folder, for repositories that hold no skill', async () => {
    const made = await rootFilesOf('aeolus-fleet', ['tools']);

    expect(readdirSync(made).sort()).toEqual(['AGENTS.md', 'CLAUDE.md', 'main', 'sub-repos']);
  });

  it('follow a skill that is itself a link in its repository', async () => {
    await aSkill({ repository: 'aeolus-fleet', at: '.agents/skills/build' }, 'build\n');
    mkdirSync(join(repositories['aeolus-fleet']?.path ?? '', '.claude', 'skills'), { recursive: true });
    symlinkSync('../../.agents/skills/build', join(repositories['aeolus-fleet']?.path ?? '', '.claude', 'skills', 'build'));
    await git(['-C', repositories['aeolus-fleet']?.path ?? '', 'add', '.']);
    await git(['-C', repositories['aeolus-fleet']?.path ?? '', 'commit', '-q', '-m', 'linked skill']);

    const made = await rootFilesOf('aeolus-fleet');

    expect(readFileSync(join(made, '.claude', 'skills', 'build', 'SKILL.md'), 'utf8')).toBe('build\n');
  });
});

describe('a ship folder in a container', () => {
  it('has each sub-repository a clone of its own with a .git of its own, beside the main repository', async () => {
    const { folder: made } = await clones().prepare(crew('aeolus-fleet', ['tools']));

    expect([statSync(join(made, 'main', '.git')).isDirectory(), statSync(join(made, 'sub-repos', 'tools', '.git')).isDirectory()]).toEqual([true, true]);
    await expect(git(['-C', join(made, 'sub-repos', 'tools'), 'rev-parse', 'HEAD'])).resolves.toBe(await git(['-C', repositories.tools?.path ?? '', 'rev-parse', 'HEAD']));
  });

  it('trashes a sub-repository a new settings version no longer names', async () => {
    const { folder: made } = await clones().prepare(crew('aeolus-fleet', ['tools']));

    await clones().prepare({ ...crew('aeolus-fleet'), madeMain: 'aeolus-fleet' });

    expect(readdirSync(join(made, 'sub-repos'))).toEqual([]);
  });
});
