# Design: tools to check in on and debug the sessions a trierarch keeps (#271)

Status: stage 1, for Thomas: the purpose, the lessons to check against and the questions. No detailed decision is made and no screen is drawn before Thomas agrees the purpose. Nothing is built.

Thomas, verbatim (#271): "It would be handy if the trierarch process had tools that helped with debugging and checking in on sessions." And on 20 Nov: "fits the unit rework we did. Making one of our critical parts of aeolus more dev friendly". The unit rework is the ship folder: one `ships/<shipId>/` per ship, holding its ship folder with `main/` and `sub-repos/<repository>/` (aeolus-fleet#1759, [ship-folder.md](ship-folder.md)).

## Purpose

**For whom.** The person who runs a machine's trierarch, on that machine as the trierarch's user, and a ship that person sets to investigate for them.

**The job.** When a ship goes quiet, or its session keeps dying, they name the ship and see in one place what its session is doing now and why: whether it is in a turn and for how long, what it last did, what runs under it, what waits for it, and why its last session ended. They need not know where each harness keeps its files, nor which process belongs to which ship. The ship is the unit, as the ship folder made it: a ship's session is found by the ship, whatever its harness and whether it runs on the host or in a container.

**What it is not.**

- Not monitoring or alerting: noticing that a ship went quiet stays with the fleet's facts and the watch plugin ship (decision 0071).
- Not a view in the console or of the fleet: core stays content-blind, and a session's activity reaches the fleet as its kind and tool only, never content.
- Not a new way to steer a session: a forced message, **Restart** and **Edit…** already do that.
- Not for a ship crewed by hand: there the person already holds the session.
- Not a reader of messages: what a message says stays the ship's.

## Lessons to check against

### Seen on the machine

1. **What prompted it** (#271, 6 Nov): a Codex design ship was in one long step for over 30 minutes and did not take Thomas's messages. Finding out what it did took a `ps` pipeline grepping for the ship id and knowing where Codex writes its session log. The same night the trierarch's service itself was down, found only through `journalctl`.
2. **A long step keeps a ship deaf** (#270): Thomas decided a ship runs a long command in the background with a message to itself at its end, and ends its turn. A ship that ignores that rule is the case the tool must make visible.
3. **The evidence of a dead session goes too soon** (#471, #497, #482): restarts left no exit reason and the session's files were removed, so the cause "cannot be read afterwards"; #471 expects "the evidence of a crashed session is kept until it is read". Today each exit's status or signal reaches the log and the blocked report, then the hold's files are removed (#482).

### What the trierarch already shows and keeps

4. **`list`, `status` and `logs`** ([trierarch day to day](../guide/trierarch-day-to-day.md); #177, #183, #218): `list` shows each ship's state, harness, workspace, since when and its restarts; `status` counts the ships, the caps, whether the service runs and whether its last pass succeeded; `logs` follows what the trierarch does. These are where a person looks today.
5. **Where a ship's files live**: `ships/<shipId>/` holds its ship folder, its home and its fleet socket, with no secret; the hold's files are in `sessions/<shipId>/` beside it (`hold.pid`, `hold.sock`, `session-id`, `harness-sessions`, `events.jsonl`, and the mode 600 token files); the trierarch's log is in `~/.aeolus/trierarch/logs/` on macOS and the user journal on Linux ([architecture.md](../architecture.md)). Host Claude Code keeps its conversations in the ship's home (#538); Codex keeps the user's home (#538), so its session log is outside the ship's folders.
6. **The hold records every line the harness writes** to `events.jsonl`, for every harness (docs/trierarch.md, the hold): one record per ship of what its session did, whatever the harness.
7. **The facts exist already**: the turn marker, idle or busy with when (decision 0040; blueprint Turn); each running session's activity each pass, its latest event's kind and tool and when `events.jsonl` last changed (#165, docs/trierarch.md "What a trierarch writes of its sessions' activity"); the inbox with how many deliveries wait and how many are forced (blueprint, `inbox`).

### Decisions and principles

8. **Content-blind** (blueprint, principles): payloads are opaque. **Activity** is "the latest event's time and kind (text, tool, result, error), never content" (blueprint; decisions 0029, 0071). What a session wrote stays on the machine unless Thomas decides otherwise.
9. **No hidden behaviour**: "Hidden behaviour is a source of debugging nightmare." (blueprint, principles; 0034).
10. **A plain process, not an AI** (decision 0026): the trierarch starts, restarts, wakes and stops sessions, and never judges content.
11. **The crew token never reaches a ship's folder or a session** (decision 0026; architecture.md): the model token, the proxy token and the secret variables sit in mode 600 files beside `ships/`. Nothing the tool shows may print them.
12. **The hold's socket answers the trierarch alone** (docs/trierarch.md, the hold): a caller under any session's hold is refused, by its peer credentials. A ship on the same machine cannot reach a hold.
13. **Sessions run as the trierarch's user** ([keeping sessions running](../guide/keeping-sessions-running.md)): a session on the host can already read whatever that user can, another ship's files included; a session in a container sees only its own ship's parts (decision 0039).
14. **Declared state lives in the fleet** (decision 0026): Restart and Edit write the crew request again as a new settings version; a forced message stops a busy turn (decision 0040; "Force means act now"). Acting from the machine instead would be a path the fleet does not see.
15. **Monitoring is the watch plugin's** (decision 0071): core keeps the facts, the watch compares them with expectations and alerts.
16. **The trierarch reaches the plugin only through the plugin's own scripts** (CLAUDE.md): what the plugin keeps (its store, its turn marker) is read through them, never as a copy of how the plugin names its files.

### House rules

17. **The blueprint's language** (CLAUDE.md): ship, session, crew, lease, turn, activity, delivery, inbox, hold. No new term. "Check-in" is a squadrons term (a member's message to its flagship), so this design keeps Thomas's words "check in on" as a verb only.
18. **New rules, checks and process steps come only from Thomas** (CLAUDE.md): this design proposes; it adds none.

## Questions

Each with its options and this design's pick.

**Q1. Who uses it?**
1. The person on the machine only, through the `aeolus-trierarch` commands.
2. The person, and any session on the same machine that the person sets on it, through the same commands.
3. As 2, and also a ship on another machine, asking the machine's trierarch ship over the fleet.
4. As 3, and also the console.

Pick 2: the 6 Nov case had a ship investigate for Thomas, and a session on the host can already read what the trierarch's user reads (lesson 13), so the same commands add no reach and nothing leaves the machine (lesson 8). Option 3 would have the trierarch send what a session wrote over the fleet, a new behaviour for its own decision.

**Q2. What does it show of a ship?**
1. The facts the trierarch already has (lesson 7): state, turn and since when, the latest activity and how long ago, the processes under the session with how long each runs, deliveries waiting and forced, and where its files are.
2. As 1, and the last lines of what the session wrote, from the hold's `events.jsonl` (lesson 6), on the machine only.
3. As 2, and each harness's own session log, wherever the harness keeps it.

Pick 2: on 6 Nov the facts said "busy" but not what the step was; only what the session wrote said that. `events.jsonl` is the trierarch's own record for every harness, so no one needs to know where a harness keeps its log (lesson 5), and option 3 would bind the tool to each harness's file places.

**Q3. Does it act, or only show?**
1. Only shows.
2. Shows, and names the existing way to act where one fits: a forced message, **Restart**, **Edit…** in the console.
3. Acts itself on the machine: interrupts a turn, restarts a session.

Pick 2: acting goes through the fleet as today, so every change is an event (lessons 9, 14); naming the way saves the person looking it up.

**Q4. Is "why did its last session end" part of the job?**
1. No: the tool shows the running session; the exit reason stays in `logs` (#482).
2. Yes: what a dead session left (its exit reason and the last of what it wrote) stays readable for the ship until its next session starts or its folder goes.

Pick 2: #471 found the cause could not be read afterwards and expects the evidence "kept until it is read" (lesson 3); a crashed ship is the moment a person comes to look.

**Q5. How does it fit the unit rework?**
1. The tools take a ship, by its name or id, and find each of its places (lesson 5); the files stay where they are.
2. As 1, and the hold's files move from `sessions/<shipId>/` into `ships/<shipId>/`, so one folder holds all of a ship.

Pick 1: the ship is the unit the person names, which is what the rework gave; the hold's folder holds the token files that must stay out of `ships/<shipId>/` (lesson 11), so moving it is a change of its own with no gain for this job.

**Q6. Does it cover the trierarch itself, as on 6 Nov when its service was down?**
1. No: `status` already says whether the service runs and how its last pass went (lesson 4).
2. Yes, as far as a ship's view says when the trierarch's service does not run or its last pass fails, since then nothing it shows is current.

Pick 2: on 6 Nov the service was down and only `journalctl` said so; a view of a ship whose trierarch is down should say so first rather than show old facts as current.
