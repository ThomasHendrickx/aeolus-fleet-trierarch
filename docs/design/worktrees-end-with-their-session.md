# Design: a worktree ends with its session, a branch with its work (trierarch#84)

Status: purpose and questions, for Thomas. No decisions yet.

## Purpose

Thomas, on the first draft: "A work tree with non saved work can be deleted. When a session finishes and there is work left that work can be seen as not valuable".

Saving is the session's job, and what a machine holds is there only while a session uses it. So:

- **Saving is the session's job.** A session commits and pushes small and often to its issue's branch (the skill rule, part 1 of #84). Work it leaves unpushed when it finishes is not valuable.
- **A worktree ends with its session.** Once no session uses a worktree, the trierarch removes it, whatever it holds, on every path: release, release elsewhere, give back, retire, a ship moved to another trierarch. No worktree waits for a human.
- **Branches end with their work.** A branch is deleted when its pull request merges, and a branch of a closed issue goes too.

## Lessons to check against

From the investigation on #84 (holes in sections 2 to 5, fixes A to I):

1. **Nothing tells a session to push.** The plugin's start context carries the fleet protocol only, and "push only a green head" pushes the other way. The purpose rests on the skill rule (part 1 of #84, fix F); until it reaches sessions, removal discards work they meant to keep.
2. **The removal paths disagree.** A release removes the worktree whatever it holds (#450, #475, docs/trierarch.md rows 7 and 11); a give back keeps one with changes; an orphan with unsaved work stays until a person on the machine removes it; a clear request covers kept worktrees only (gap rules 1 and 2). The checks that decide it (`isClean` for a give back, `unsaved` for a release and an orphan, fixes A and B) stop deciding anything.
3. **A session still uses its worktree while its lease is held**: a crash, a spent restart budget, a machine restart, Restart or Edit (rows 4, 5, 6, 12) keep it in place, and so they stay.
4. **The lease ends first** (gap rule 4): a worktree never holds up releasing the ship.
5. **A release's usage goes first** (gap rule 1): the trierarch sends a released ship's last usage before its folder goes, on every path that removes a worktree.
6. **Kept worktrees and the clear request** (decision 0032): with nothing kept, a clear request finds nothing to clear; the console's Delete on a kept worktree and `confirmWorktreeCleared` with `not-kept` already exist.
7. **Folders the trierarch cannot see.** It lists only what `git worktree list` reports two levels under its root; plain clones, non-git folders and a worktree of one repository in another's folder are never reported (fix D). Gap rule 1: it removes only what it made.
8. **Worktrees outside the root are nobody's.** Sessions make their own beside the checkout or in scratch folders; nothing runs `git worktree prune`. One machine: 27 such worktrees with no ship, 21 stale records (fix E).
9. **Branches never end.** Automatic deletion of merged branches is on in 1 of 5 repositories checked; 1514 remote branches of merged or closed pull requests; local checkouts hold hundreds, the core checkout 495 (fix H).
10. **The start is detached**, and nothing names the issue's branch (fix I); the skill rule (part 1) is to cover it.
11. **Paths stay on the machine** (decision 0032): a report names a worktree by ship and repository, an orphan by repository and folder name.

## Questions

Each with its options and my pick.

**Q1. Is argo told what a removed worktree held?** Today a release and a release elsewhere tell argo how many changes and unpushed commits it discards (#450, #475); an orphan with unsaved work is reported once.
1. No: the trierarch removes it and logs what it held; argo is told nothing, on any path.
2. Yes, on every path, as a release does today.
3. As today: a release and a release elsewhere tell argo, the other paths log only.

Pick 1: work left is not valuable, so a message about it is one argo cannot act on; the log keeps it for anyone checking whether sessions push.

**Q2. When does no session use a worktree?**
1. When no crew request assigned to this trierarch names it: on a release, a release elsewhere, a give back, a retire, or a ship moved to another trierarch, removed on that pass (after the usage send, lesson 5).
2. As 1, and also when its session is crashed with the restart budget spent (row 5).

Pick 1: a crashed ship keeps its lease and its owner can Restart it in the console into the same folder; removing it there would change row 5, which the note does not reach.

**Q3. What becomes of the clear request (decision 0032)?**
1. It stays as it is in core and the console; the trierarch keeps no worktree, so it confirms `not-kept`. The trierarch's docs drop "kept worktree".
2. A new decision retires it from core and the console, superseding that part of 0032.

Pick 1: it changes nothing in core, and the console's Delete simply finds none to show; retiring it can follow once nothing is kept on any machine.

**Q4. Which folders does the trierarch remove?**
1. Under its root: every folder no crewed ship uses, whether it made it or not (a session's own clone, a non-git leftover), after stopping what runs in it. Outside its root: none, but it runs `git worktree prune` on each configured repository so stale records go.
2. As 1, and outside its root, every worktree of a configured repository that no crewed ship uses.
3. Only worktrees it made, as gap rule 1 says today, plus prune; other folders under the root are reported once.

Pick 1: the root is the trierarch's, so anything left there is a session's leftover; outside it may be a person's own working copy, which the note does not cover, and the skill rule keeps sessions inside their worktree.

**Q5. Local branches in a configured repository's checkout.**
1. The trierarch deletes a local branch checked out in no worktree whose remote branch is gone (deleted on merge or by the sweep, Q6).
2. The trierarch deletes every local branch checked out in no worktree: its work is not valuable once no session uses it.
3. Left alone.

Pick 1: it ends a branch with its work without touching a branch a person keeps in the shared checkout; 2 reaches a person's own branches.

**Q6. Remote branches: delete on merge, and branches of closed issues.**
1. Turn on automatic deletion of merged branches in every repository the fleet works in (a step for Thomas per repository); a sweep of remote branches whose pull request merged or closed, or whose issue closed, is a scheduled ship's work outside the trierarch, designed on its own.
2. As 1, the sweep done by the trierarch.
3. Delete on merge only, no sweep.

Pick 1: the trierarch reaches core only through `/api/v1` and has no GitHub role; a remote sweep is one job per repository, not per machine.

**Q7. Is the trierarch to create the issue's branch at crew time (fix I)?**
1. No: the session rule in the software-development skill (part 1) covers it.
2. Yes: the crew request carries the issue, the trierarch creates or reuses its branch (core change).

Pick 1: it keeps core and the crew request as they are; 2 can follow if the skill rule is not enough.

## Trains

- **Trierarch (this repository)**: Q1 to Q5; docs/trierarch.md lifecycle rows 7 and 11 and gap rules 1 and 2.
- **Core (aeolus-fleet)**: Q3, only if 2 is picked.
- **Repository settings and a scheduled ship**: Q6.
- **Skills repository**: part 1 of #84.
