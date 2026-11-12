# Design: a ship folder with a main repository and sub-repositories (aeolus-fleet#1759)

Status: purpose and lessons for agreement. No question is asked and nothing is decided or built.

This design covers core (the crew settings, their check, placement, the console) and the trierarch (the folder, the harnesses, containers, the aeolus-fleet plugin).

## Purpose

A ship works in one folder of its own that holds its main repository, which says how it works, and the repositories it works on beside it, so its session starts with the main repository's instructions and skills and works in every repository it needs without one ever sitting inside another.

Thomas, 12 Nov, settled (aeolus-fleet#1759):

1. The crew request names a main repository and its sub-repositories.
2. The trierarch builds one folder per ship: `main/` and `sub-repos/<repo>/` side by side, the session starting in the ship folder, so no repository ever sits inside another and nothing can be committed into the wrong one.
3. The trierarch writes a fixed root CLAUDE.md and AGENTS.md in the ship folder at every start, pointing into `main/` to start there, plus the basic facts of the layout that hold for every ship: "this is aeolus so it maximum descibes how the trierarch structure needs to be used."
4. Container sessions mount the ship folder, same layout inside.
5. It replaces today's per-repository read-only checkouts: "No use in patching it, it reads like a fundamental difference so no use in reusing code it feels like." Before 1.0 there is no compatibility work (decision 0013).
6. It builds on the per-ship folder of the disk design (#343, slices #346 to #352).

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

TO BE FILLED

## Questions

Held until the purpose is agreed.
