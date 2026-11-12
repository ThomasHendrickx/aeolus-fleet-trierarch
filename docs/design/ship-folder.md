# Design: a ship folder with a main repository and sub-repositories (aeolus-fleet#1759)

Status: purpose agreed by Thomas on 12 Nov; questions open. Nothing is built.

This design covers core (the crew settings, their check, placement, the console) and the trierarch (the folder, the harnesses, containers, the aeolus-fleet plugin).

## Purpose

A ship works in one folder of its own that holds its main repository, which says how it works, and the repositories it works on beside it, so its session, whatever its harness, is told the same at its start to work from the main repository, and works in every repository it needs without one ever sitting inside another.

Thomas, 12 Nov, settled (aeolus-fleet#1759):

1. The crew request names a main repository and its sub-repositories.
2. The trierarch builds one folder per ship: `main/` and `sub-repos/<repo>/` side by side, the session starting in the ship folder, so no repository ever sits inside another and nothing can be committed into the wrong one.
3. The trierarch writes a fixed root CLAUDE.md and AGENTS.md in the ship folder at every start, pointing into `main/` to start there, plus the basic facts of the layout that hold for every ship: "this is aeolus so it maximum descibes how the trierarch structure needs to be used."
4. Container sessions mount the ship folder, same layout inside.
5. It replaces today's per-repository read-only checkouts: "No use in patching it, it reads like a fundamental difference so no use in reusing code it feels like." Before 1.0 there is no compatibility work (decision 0013).
6. It builds on the per-ship folder of the disk design (#343, slices #346 to #352).

Thomas, 12 Nov, on the lessons below:

7. On the harnesses (lesson 15): "AGENTS.md and a sim linked CLAUDE.md (points to AGENTS.md) both are written in root. Behaviour is the same across all session types. No difference. CLAUDE.md is simlinked to have minimal differences." The root holds one AGENTS.md and CLAUDE.md as a symlink to it, for every harness; no harness gets an import or a file of its own.
8. On placement (lesson 3): "indeed all need to be available or it is refused." A crew request naming a repository a machine lacks is refused there.
9. Lessons 12 (two levels) and 7 (a container gets clones, decision 0039): agreed.

## Lessons to check against

### The crew request in core

1. **Settings never carry paths or command-line flags** (decision 0027): a workspace names a repository or folder from the trierarch's configuration. Today the workspace is one of `{ kind: worktree, repository, ref? }` or `{ kind: folder, name }` (`packages/common/src/trierarch/crew-settings.ts`), each name a `trierarchNameSchema` (lowercase, no slash). There is no field for a second repository. The settings are at most 16 KB.
2. **Core checks the settings' shape and never acts on them; what fits a trierarch stays placement's to explain** (decision 0029). `requestCrew` checks size, shape and machine labels, never a repository name against a machine.
3. **Placement matches the workspace against what each machine offers**: the report's `workspaces: { repositories, folders }` (`packages/common/src/trierarch/report-details.ts`), read by the trierarch plugin. A refusal reads `no trierarch offering claude-code has repository aeolus-fleet`. The company worktrees design (31 Oct) found the gap of today's checkouts: "Placement never reads checkouts", so a machine without them still crewed a company ship. Every repository a request names has to be one placement can match.
4. **Three writers build crew settings**: the console's crew settings fields and commission dialog (`crew-settings-fields.tsx`, `commission-ship.tsx`), squadrons (`crewRequest` is on its row of docs/compatibility.md) and any requester through `POST /api/v1/fleet/crewRequest`. The trierarch only reads them, through `fleet.assignedCrewRequests`. A changed shape reaches each writer, and the Go trierarch, which has no `common` to import and writes the shapes again.
5. **No compatibility path before 1.0** (decision 0013), and `MINIMUM_CORE_VERSION` is raised in the same PR that needs the newer core (CLAUDE.md).

### The trierarch today

6. **A ship's workspace is one folder, and that folder is the ship** (core decision 0015: "One ship per folder; a worktree is its own folder"). The session starts there; the aeolus-fleet plugin's identity file lives there; the launch and turn markers, the trust check, the folder's processes and the Claude Code conversation (`--continue` reads the conversation of that folder) are all keyed by it.
7. **On the host the workspace is a git worktree** under `worktrees/<repository>/<ship>`, fetched first and detached at `origin/<ref>` or origin's default branch (`go/internal/workspace/workspace.go`). **In a container it is a per-ship clone**, `--reference` with `--dissociate`, never a worktree: a worktree points into the configured repository's `.git`, its hooks and every other ship's worktree data, so mounting it would let a session plant a hook that runs on the host (decision 0039). A container sees its workspace, its home, its socket folder, its read-only checkouts and nothing else of the host.
8. **Read-only checkouts** (#1182, docs/trierarch.md "Read-only checkouts") are the machine's: a configured repository names other configured repositories as `checkouts` in `config.json`, and a crew request never names them, so placement never reads them. Each is a clone with no remote and no write bits under `checkouts/<shipId>/<repository>`, outside the workspace; Claude Code gets `--add-dir` for each; a container mounts each `:ro`; the identity carries `--checkout <repository>=<path>` and the plugin's SessionStart hook names them; `aeolus-checkouts.sh refresh` calls `POST /trierarch/checkouts/refresh` on the ship's socket. All of it is what point 5 of the purpose replaces, in the trierarch and in the aeolus-fleet plugin.
9. **Why the company wanted read-only copies on `main`** (company worktrees design, 31 Oct; aeolus-fleet#1449, superseded by #1759): its bootstrap checks that the company worktree and the skills worktree are on `main` with no local change, and refreshes both before every new assignment. Whatever replaces checkouts either meets those checks or the company's bootstrap changes with it.
10. **Trust before every launch** (#381): a harness never starts a session in a place it does not trust, since its trust question has no one to answer it. Adding a place trusts it for every configured harness (Claude Code in `~/.claude.json`, Codex in `config.toml`; for a worktree both ask about the repository's own checkout). A place is offered only while every configured harness trusts it. A trusted repository (aeolus-fleet#384) is cloned on demand and trusted before it exists.
11. **A worktree ends with its session, whatever it holds** (#84 design, #89): removal on every path discards what it holds, logs it, tells argo nothing; a crashed ship keeps its folder for Restart. Saving is the session's job. The clear request names a worktree by ship and repository (core decision 0032) and is answered `not-kept`.

### The disk design (#343)

12. **Every file a ship's session writes lives in `ships/<shipId>/`**: `worktree/` (its worktree or clone), `home/`, `tmp/`, `containers/`, `podman.sock`, `fleet.sock` (slice #346 onward; none built yet). The session starts in `worktree/`, not in `ships/<shipId>/`, so its home, scratch and socket are not in its start folder. Thomas's "ship folder" of #1759 and the disk design's `ships/<shipId>/` are two different folders at two levels; the layout has to say which one `main/` and `sub-repos/` sit in.
13. **The ship's folder goes as one, through the trash** (disk design point 6); removal of everything under it, worktrees and clones alike, follows the same moments. Removing a worktree also needs its record in the configured repository gone (`git worktree prune` each pass, #91).
14. **A container mounts the ship's parts at known places** (disk design, "How a session is pointed at its folder"): `home/` as its home, `tmp/` as `/tmp`, `containers/` as Podman's storage. The ship folder of #1759 is one more such mount, the same layout inside.

### The harnesses

15. **What Claude Code and Codex load from a start folder that holds several repositories**: see the section below. The root CLAUDE.md and AGENTS.md of point 3 of the purpose only work as far as each harness loads them, and the skills of `main/` load only as far as each harness looks for them.
16. **Container mode offers Claude Code only** (decision 0039), until Codex is proven in a container; Codex runs on the host.

### The house rules

17. **Ubiquitous language**: ship, crew, crew request, workspace, worktree, release. "Main repository" and "sub-repository" are Thomas's words in #1759; this design invents no other.
18. **The trierarch reaches the plugin only through the plugin's own scripts** (CLAUDE.md): what the plugin's SessionStart hook says of the layout changes in the plugin, not as a copy in the trierarch.

## What Claude Code and Codex load

Verified on 12 Nov with Claude Code 2.1.312 and Codex 0.163.0: a test folder holding a CLAUDE.md, an AGENTS.md and a skill each at its root, in `main/` and in `sub-repos/foo/` (both git repositories, the root not one, then one), each with its own marker word; each harness run headless from each level and asked for the markers and skills it holds without reading a file; then checked against the harness docs, quoted below. Each cell is one run and the model's own report of what it holds.

| Started in the ship folder (no git repository), it loads | Claude Code | Codex |
| --- | --- | --- |
| The root CLAUDE.md | At start | Never: it reads no CLAUDE.md |
| The root AGENTS.md | Never while a CLAUDE.md is there ("Your CLAUDE.md files only") | At start: "If Codex cannot find a project root, it only checks the current directory" |
| The root's skills | `.claude/skills` at start; never `.agents/skills` | `.agents/skills` at start; never `.claude/skills` |
| `main/CLAUDE.md`, `main/AGENTS.md` | `main/CLAUDE.md` once the session reads or writes a file in `main/`, not at start ("Files in subdirectories load on demand") | Never: "Codex stops searching once it reaches your current directory" |
| `main/`'s skills | `.claude/skills` once the session reads a file in `main/` ("Skills in a `.claude/skills/` directory below where you started don't load at startup") | Never |
| An import in the root file | `@main/CLAUDE.md` loads it at start, up to four hops | None: no import syntax, `@main/AGENTS.md` is plain text |

Started in `main/` instead (a git repository in a folder that is none), Claude Code loads `main/CLAUDE.md` and the root CLAUDE.md above it, and `main/`'s skills but not the root's; Codex loads `main/AGENTS.md` and `main/`'s skills only, its walk stopping at `main/`'s git root. Claude Code's `--add-dir <folder>` loads that folder's skills, and its CLAUDE.md only with `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`; Codex has no such flag (not tested).

Not verified: whether Codex loads a sub-folder's AGENTS.md once the session reads a file there; where Claude Code's skill climb ends above a start folder that is no git repository.

Sources: https://code.claude.com/docs/en/memory, https://code.claude.com/docs/en/skills, https://developers.openai.com/codex/guides/agents-md, https://developers.openai.com/codex/skills.

So with one root AGENTS.md and CLAUDE.md a symlink to it (Thomas, point 7), both harnesses load the same root file at start, and what it says is all either is given at start: neither loads `main/`'s own instruction file at start, and Codex never loads `main/`'s skills.

## Questions

Each for Thomas, the pick being this design's recommendation.

**Q1. Which folder is the ship folder?** The disk design (#343) gives each ship `ships/<shipId>/`, holding its `worktree/` (where the session starts today), its harness `home/`, `tmp/`, `containers/` and its sockets. The ship folder of #1759 (root AGENTS.md and CLAUDE.md, `main/`, `sub-repos/<repo>/`) has to sit at one of these two levels.
1. The ship folder takes the place of `worktree/` inside `ships/<shipId>/`: the session starts there and sees only the root files, `main/` and `sub-repos/`; its home, scratch, container storage and sockets stay beside it, out of its start folder, as the disk design has them. The whole of `ships/<shipId>/` still goes as one.
2. `ships/<shipId>/` itself is the ship folder: the session starts there, and its home, `tmp/`, `containers/` and sockets sit beside `main/` and `sub-repos/` in its start folder.
3. None of these.
Pick 1: the session's start folder holds only its repositories and the root files, and the disk design's removal stays as approved.

**Q2. How does a crew request name its repositories?** Today `workspace` is `{ kind: worktree, repository, ref? }` or `{ kind: folder, name }`, names only (decision 0027).
1. The worktree workspace becomes `{ kind: repositories, main: { repository, ref? }, subRepositories: [{ repository, ref? }] }`: each a name with an optional ref, as today's worktree has; no repository named twice, `main` never among the sub-repositories, at most a fixed number of sub-repositories; core refuses anything else (decision 0029).
2. `workspace` stays as it is, naming the main repository, and a new optional setting `subRepositories: [names]` sits beside it, each at its origin's default branch, no ref.
3. One list of repositories, the first being the main one.
4. None of these.
Pick 1: one place says everything the ship folder holds, every repository can start at a branch, and nothing of the old shape stays (decision 0013).

**Q3. What happens to the folder workspace?** Today `{ kind: folder, name }` uses a configured folder as it is, shared by every ship in it, with no worktree.
1. It stays as it is, outside the ship folder: no sub-repositories, no root files, no change.
2. It goes: every ship gets a ship folder of repositories.
3. A configured folder can be the main of a ship folder, beside sub-repositories.
4. None of these.
Pick 1: a shared folder cannot be one folder per ship, and nothing in #1759 asks to change it; keeping it is the smallest design.

**Q4. Can a session change, commit and push in its sub-repositories?** Today's read-only checkouts (#1182) have no remote and no write bits, and the company bootstrap checks its copies are on `main` with no local change (#1449). #1759 says "nothing can be committed into the wrong one", and calls them the repositories the ship works on.
1. Every repository in the ship folder, main and sub-repositories alike, is a working one: on the host its own worktree, in a container its own clone (decision 0039), each with its origin, so the session branches, commits and pushes in each. Staying on `main` is the main repository's own rule where it wants that, as the company's bootstrap is.
2. Sub-repositories are read-only, as checkouts are today; only `main/` is a working one.
3. The crew request says per sub-repository whether it is read-only.
4. None of these.
Pick 1: they are the repositories the ship works on, and one kind of repository keeps the build to one path.

**Q5. What replaces the checkouts' refresh?** Today `aeolus-checkouts.sh refresh` brings each read-only checkout to the latest main over the ship's socket.
1. It goes with the checkouts: each repository has its origin, and the session fetches and moves on with git itself. The script, the socket call and the plugin's start-context lines about checkouts go too.
2. A refresh stays, bringing each repository the session has not changed to the latest default branch.
3. None of these.
Pick 1, if Q4 is 1: with an origin in each repository, the trierarch adds nothing git does not.

**Q6. How do the main repository's skills reach the session?** Verified: started in the ship folder, Claude Code loads `main/.claude/skills` only once the session reads a file in `main/`, and Codex never loads `main/.agents/skills`. The root AGENTS.md (CLAUDE.md a symlink to it) is the same for both harnesses.
1. The trierarch links the root's `.claude/skills` and `.agents/skills` to `main/`'s own, as it links CLAUDE.md to AGENTS.md, so both harnesses load the main repository's skills at start. That both harnesses follow a linked skills folder is not verified yet: the first slice proves it with a test of each harness, and falls back to option 2 if one does not.
2. The root AGENTS.md says where the main repository's skills are, and the session reads them as files when it needs one.
3. None of these.
Pick 1: the same skills at start for every harness, the purpose's "told the same", with no copy that can go stale.

**Q7. A machine's configuration that still names `checkouts`.**
1. Refused at start and by `config check`, saying the line to remove and that sub-repositories now come from the crew request (decision 0013, no compatibility).
2. Accepted and ignored, with a warning in the log.
3. None of these.
Pick 1: a setting that does nothing should not look as if it does.
