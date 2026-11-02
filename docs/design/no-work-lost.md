# Design: no work lost, no worktree outlives its use (trierarch#84)

Status: purpose and questions, for Thomas. No decisions yet.

## Purpose

Work a session does is safe only once a remote has it, and a worktree or branch on a machine is there only while a ship needs it. So:

- **Saved means pushed.** Work counts as saved only when a remote holds it, never because a local branch, tag or stash on the machine does.
- **The trierarch never deletes unsaved work.** No path, release, give back, orphan or clear, removes a worktree that holds work no remote has, without a human choosing that.
- **A worktree with no session goes.** Once no assigned crew request uses a worktree and its work is saved, it is removed; one with unsaved work is reported to argo until a human clears it, without anyone on the machine.
- **Branches end with their work.** A branch is deleted when its pull request merges, and a branch of a closed issue is removed once its work is saved or merged.

## Lessons to check against

From the investigation on #84 (holes in section 2 to 5, fixes A to I):

1. **Give back counts committed work as clean.** `finishWorkspace` checks only `git status`, so a worktree with commits no remote has is removed with `--force` and argo is told nothing (fix A).
2. **"Saved" counts local branches.** `unsaved` excludes commits reachable from `--branches`, so a commit on a local branch of the shared checkout counts as saved; that is the work a ship moved to another trierarch loses (fix B, docs/trierarch.md gap rules 1 and 2).
3. **Release removes whatever it holds** (#450, #475, row 7 and 11): argo is told what it discards, and the work is gone. Gap rule 4: a worktree with changes never holds up releasing the ship.
4. **An orphan or kept worktree with unsaved work stays forever.** It is warned about once; a clear request covers kept worktrees only (decision 0032), so only a person on the machine can remove an orphan, which decision 0032 says must never be needed. Kept worktrees have no age and no reminder (fix C).
5. **Folders the trierarch cannot see.** It lists only what `git worktree list` reports two levels under the root; plain clones, non-git folders and a worktree of one repository in another's folder are never reported (fix D).
6. **Worktrees outside the root are nobody's.** Sessions make their own beside the checkout or in scratch folders; gap rule 1 says the trierarch removes only what it made; nothing runs `git worktree prune`. One machine: 27 such worktrees with no ship, 10 holding 142 commits on no remote, 21 stale records (fix E).
7. **Stashes** live in the shared checkout: they survive a removal but are neither listed nor counted.
8. **Branches never end.** Automatic deletion of merged branches is on in 1 of 5 repositories checked; 1514 remote branches of merged or closed pull requests; local checkouts hold hundreds (fix H).
9. **The start is detached**, and nothing names the issue's branch (fix I). The session rule (push small and often, the issue's branch) goes to the shared software-development skill, part 1 of #84, not here.
10. **Paths stay on the machine** (decision 0032): a report and a clear request name a worktree by ship and repository, an orphan by repository and folder name.

## Questions

Each with its options and my pick.

**Q1. What counts as saved?**
1. Every commit is on some remote-tracking branch after a fetch, and no change is uncommitted; stashes are not counted.
2. As 1, and a stash made in the worktree counts as unsaved.
3. Every commit is on the issue's branch on the remote.

Pick 1: it is the rule a trierarch can check in any repository; 3 needs the issue, which the trierarch does not know (Q7), and stashes are not tied to a worktree.

**Q2. A release, or a release elsewhere, of a worktree with unsaved work.** Today it is removed, argo told (#450, #475).
1. Keep it as a kept worktree, argo told what it holds; a clear request removes it. The ship's next crew starts from a fresh worktree, so a kept one and a new one of the same ship must both fit under the root.
2. The trierarch pushes the unsaved commits to a branch on the remote, then removes it as today; uncommitted changes are still discarded and reported.
3. As today.

Pick 1: it is the one that deletes no unsaved work and keeps gap rule 4 (the lease ends first). It reverses the "whatever it holds" of #450 and #475, so it is Thomas's call. 2 pushes in a ship's name to a branch nobody asked for.

**Q3. A worktree with no session and unsaved work (kept or orphan).**
1. Reported to argo with what it holds, as a release is, and again after a stated age; a clear request may name an orphan too (core: `clearWorktree` scope), so argo or a human clears it from the console.
2. As 1, with no reminder after an age.
3. As today: an orphan stays until a person on the machine removes it.

Pick 1: decision 0032 says no one must need the machine; the age is Q4.

**Q4. The age after which argo is reminded of a kept worktree or orphan with unsaved work.**
1. 7 days, then every 7 days.
2. 1 day, then daily.
3. A setting in the machine's configuration, 7 days by default.

Pick 1: the investigation's leftovers were 7 to 11 days old; a setting is a new knob no one asked for.

**Q5. Which worktrees does the trierarch look after?**
1. Under its root only, as gap rule 1 says; it also runs `git worktree prune` on each configured repository, and reports, never removes, folders under the root it did not make (fix D) and live worktrees of a configured repository outside the root, by count and age (fix E).
2. As 1, and it removes a worktree outside the root whose work is saved and in which nothing runs.
3. Under its root only, as today, with no prune and no report.

Pick 1: removing what it did not make could take a person's own working copy; the skill rule (part 1) keeps sessions inside their worktree.

**Q6. Local branches in a configured repository's checkout.**
1. The trierarch deletes a local branch checked out in no worktree whose commits a remote has (Q1's rule): its work is saved, so nothing is lost.
2. As 1, only when its pull request merged or its issue closed (the trierarch reads GitHub).
3. Left alone.

Pick 1: it needs no GitHub, and a branch whose work is on a remote can be fetched again.

**Q7. Remote branches: delete on merge, and branches of closed issues.**
1. Turn on automatic deletion of merged branches in every repository the fleet works in (a step for Thomas per repository); a sweep of remote branches whose pull request merged or closed, or whose issue closed, is a scheduled ship's work outside the trierarch, designed on its own.
2. As 1, the sweep done by the trierarch.
3. Delete on merge only, no sweep.

Pick 1: the trierarch reaches core only through `/api/v1` and has no GitHub role; a remote sweep is one job per repository, not per machine.

**Q8. Is the trierarch to create the issue's branch at crew time (fix I)?**
1. No: the session rule in the software-development skill (part 1) covers it.
2. Yes: the crew request carries the issue, the trierarch creates or reuses its branch (core change).

Pick 1: it keeps core and the crew request as they are; 2 can follow if the skill rule is not enough.

**Q9. Does a give back follow the same rule?** Lesson 1.
1. Yes: a give back keeps a worktree with unsaved work (Q1's rule) and tells argo, as Q2 and Q3 do.
2. Fix only the check (fix A), with no report to argo.

Pick 1: one rule for every path is what "never delete unsaved work" means.

## Trains

- **Trierarch (this repository)**: Q1, Q2, Q3, Q5, Q6, Q9; docs/trierarch.md gap rules 1 and 2.
- **Core (aeolus-fleet)**: Q3's clear request naming an orphan, if picked.
- **Repository settings and a scheduled ship**: Q7.
- **Skills repository**: part 1 of #84.
