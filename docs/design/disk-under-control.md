# Design: a trierarch keeps the disk its ships use under control (trierarch#343)

Status: purpose proposed, not agreed. Questions are held until the purpose is agreed. Nothing is built.

## Purpose

A trierarch keeps every byte its ships' sessions write on its machine bounded and removes it by itself once no session uses it, so whoever installs one never cleans up after it.

Thomas, verbatim: "'Can this go' is not the right question 'How do we keep this under controll' is. Mostly if iy is produced by how trierarchs clean or not clean up after itself or after ships then it is an aeolus concern. If someone else installs a trierarch, they dont need to unclog the drain trierarch is filling."

## What a machine holds today

One Linux machine running one trierarch on the host session runtime, 468 GB disk, 353 GB used (80 %), measured read-only on 12 Nov.

| What | Size | Count and kind | Who wrote it | Removed today |
| --- | --- | --- | --- | --- |
| Worktrees under the trierarch's root | 20 GB | 67 folders, each with its own `node_modules` | The trierarch, for its ships | Yes: release, the orphan pass and a clear request (#84, #89 to #93) |
| Scratch in `/tmp` | 38 GB | About 5,900 entries of the trierarch's user: review and pull request checkouts and builds of other repositories (1 to 3 GB each, the bulk), folders test suites make and leave (`mkdtemp` style, hundreds, small), browser profiles and test artifacts, and drafts and logs sessions write (review, pull request and lint files) | Sessions and the tests they run | No |
| Container volumes | 64 GB | 24 anonymous volumes, unlabelled, the data folders of Postgres containers (`postgres:16-alpine`), 1 to 11 GB each, made 7 to 12 Nov | Testcontainers runs (`org.testcontainers.lang=node`) started by host sessions | No |
| Containers | 0.3 GB, holding the volumes | 24: 20 Testcontainers Postgres and 1 LocalStack container, still running two days after their run; 3 of this repository's own e2e containers (label `aeolus.trierarch`, image `aeolus-trierarch-test`) running for 13 days; 1 build container | Test runs of ship sessions; no Ryuk reaper runs (rootless Podman runs need `TESTCONTAINERS_RYUK_DISABLED=true`), so a run that is killed or times out leaves its containers running | No |
| Shared caches | 20 GB | npm 9.4 GB, Go build 7.9 GB, Go modules 1.1 GB, Playwright browsers 1.4 GB | Every session of the user | No, and unbounded |
| Worktrees outside the trierarch's root | about 30 GB (issue's count) | Older worktrees of configured repositories | Earlier crews and people | No: outside its root the trierarch removes nothing (#84, point 4) |

The volumes are not leftovers of finished containers: 21 of 24 are held by containers still running. They outlive the session because the test run that started them was stopped before it stopped them, and nothing stops them after.

## What a session can write outside its worktree

- **Host session runtime** (the default, and this machine's): everything its user can write. The user's home (the harness's files, the shared npm, Go and Playwright caches), `/tmp`, and the rootless container runtime of the user, whose containers and volumes outlive the session. The trierarch knows only its root.
- **Container session runtime** (decision 0039): a container started `run --rm -i`, which sees its clone, its ship's own home (`~/.aeolus/trierarch/homes/<shipId>/`), its ship's socket folder and its read-only checkouts, nothing else. Its `/tmp` is the container's own and goes when the container goes. Its caches and its nested rootless Podman's images, containers and volumes live in its ship's home (the image's `storage.conf` names no other place), so they go with the home on release, give back or a ship no longer assigned here, through the trash. While the ship is crewed they grow unbounded inside the home, and a crashed ship keeps its home.
- **Both runtimes**: older versions of the session image are never removed; the trierarch's code runs no `image`, `volume` or `network` command, only `kill` and `rm --force` of its ship's own container.

## How the open issues fit

| Issue | What it does | Its part of the disk |
| --- | --- | --- |
| #84 | The approved design [worktrees-end-with-their-session.md](worktrees-end-with-their-session.md): a worktree ends with its session, a branch with its work | Row 1 of the table, worktrees under the root |
| #89 | Every path removes the worktree whatever it holds (today give back and the orphan pass keep one with unsaved work) | Row 1: the kept worktrees |
| #90 | Every folder under the root that no crewed ship uses is removed | Row 1: strays, plain clones, folders git does not know |
| #91 | `git worktree prune` on each configured repository every pass | Records only, almost no bytes; row 6 stays |
| #92 | A local branch checked out nowhere whose remote branch is gone is deleted | Refs only, almost no bytes |
| #93 | The scheduled ship that sweeps remote branches | No disk on the machine |

Rows 2 to 6 (`/tmp`, containers and their volumes, shared caches, worktrees outside the root) and old session images are in none of them. #343 is the rest, and #89 to #92 stay its first slices for row 1.

## Lessons to check against

1. **What a machine holds is there only while a session uses it** (approved #84 design, Thomas 2 Nov: "When a session finishes and there is work left that work can be seen as not valuable"). Today it holds only for worktrees under the root; the purpose extends it to everything a session writes.
2. **The trierarch removes only what it made, and outside its root nothing** (trierarch.md, gap rule 1; #84 design, point 4). Rows 2 to 6 are all outside its root. Either the trierarch learns what its sessions made elsewhere, or its sessions write only where the trierarch keeps control.
3. **On the host every session runs as one user** (decision 0039, Why). The trierarch cannot tell which session wrote a `/tmp` folder or started a container, nor a session's from the person's own work on the same account. Removing by owner alone would reach a person's own files.
4. **The container runtime already holds a session to its own folder and home** (decision 0039): its `/tmp` goes with `--rm`, its nested Podman's containers and volumes go with its home. It is the machine's choice, host by default, and offers Claude Code only. What is left there is growth while a ship stays crewed.
5. **No protective rules without the operator asking** (core decision 0016). A cap or a quota on what a session may write is such a rule; keeping the disk under control has to come from the end of use, not from limits nobody asked for, unless Thomas asks for limits.
6. **The disk alert says "The trierarch stops no session for it": freeing disk is the operator's** (trierarch.md, "Machine load"; argo told once per drop below 5 % free, read at most once a minute). The purpose reverses the second half; the alert stays the signal that control failed.
7. **The leak is in how tests run, not only in what sessions keep.** Testcontainers on rootless Podman runs with Ryuk off, so a test run that is killed or times out leaves its containers running and their volumes held. This repository's own e2e containers (label `aeolus.trierarch`) leak the same way. Part of rows 3 and 4 is fixed where the tests are, not by the trierarch.
8. **Removal goes through the trash, emptied every pass, argo told after a day when one cannot go** (architecture.md, the trash; trierarch.md, "Session runtime"). A removal that can fail already has a shape to reuse; argo is told about a failure, never about what was discarded (#84 design, point 3).
9. **A crashed ship keeps its lease and its folder, and Restart, Edit and a machine restart keep them too** (#84 design, point 1). Whatever ends with a session has to follow the same moments, or a Restart finds its state gone.
10. **The `.trash` beside the clones sits under the root** (architecture.md). #90's "every folder under the root" would reach it; a design that removes by place has to name what under that place is the trierarch's own.
11. **A guarantee without a test does not exist** (CLAUDE.md). Each removal path, its restart and its failure needs its own test, as #89 to #92 have.

## Questions

Held until the purpose is agreed.
