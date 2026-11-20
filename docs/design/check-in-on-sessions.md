# Design: tools to check in on and debug the sessions a trierarch keeps (#271)

Status: stage 1. The purpose is approved by Thomas on 20 Nov (card 563c69d7, option 1), with the scope below. The questions are for Thomas, in the order they should be decided. No detailed decision is made and no screen is drawn: the mockups come after the questions. Nothing is built.

Thomas, verbatim (#271): "It would be handy if the trierarch process had tools that helped with debugging and checking in on sessions." And on 20 Nov: "fits the unit rework we did. Making one of our critical parts of aeolus more dev friendly". The unit rework is the ship folder: one `ships/<shipId>/` per ship, holding its ship folder with `main/` and `sub-repos/<repository>/` (aeolus-fleet#1759, [ship-folder.md](ship-folder.md)).

## Purpose (approved)

Approved by Thomas on 20 Nov (card 563c69d7, option 1), with his note, verbatim: "Including the TUI scope we discussed in chat".

**For whom.** The person who runs a machine's trierarch, on that machine as the trierarch's user, and a ship that person sets to investigate for them.

**The job.** When a ship goes quiet, or its session keeps dying, they name the ship and see in one place what its session is doing now and why: whether it is in a turn and for how long, what it last did, what runs under it, what waits for it, and why its last session ended. They need not know where each harness keeps its files, nor which process belongs to which ship. The ship is the unit, as the ship folder made it: a ship's session is found by the ship, whatever its harness and whether it runs on the host or in a container.

**The scope.** Besides the existing commands (`list`, `status`, `logs`), the trierarch gets a full-screen live mode in its Go binary (for example `aeolus-trierarch tui`), for the same person and the same data:

- it shows the ship list, one ship opened, and why that ship's last session ended;
- it shows a banner when the trierarch's service is down, since then nothing it shows is current;
- it only shows, and names the existing way to act (a forced message, **Restart**, **Edit…** in the console);
- it works over SSH, without the fleet;
- no secret is ever on screen;
- nothing a session wrote leaves the computer.

The trierarch is one Go binary with no Node (the TypeScript package is being removed), so the live mode is Go.

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

### The Go binary

19. **The commands read the trierarch's files, not the service** (`go/internal/cli`): `list` reads the state file; `status` asks the service manager whether the service runs, reads the last pass's failure, and asks the fleet only whether the trierarch's lease holds, saying "unreachable" when it cannot. Neither calls the running service, so a reader of the same files works while the service is down, and without the fleet.
20. **The state file holds a secret**: each entry keeps its crew token in the state (decision 0026), beside the ship's name, state, exits and folders. Whatever reads the state for a screen reads past that field.
21. **The inbox is seen each pass but kept nowhere on the machine**: deliveries waiting and forced are read from the fleet each pass and acted on, not written to a file a command can read. The turn is the plugin's marker, read through the plugin's scripts (lesson 16).
22. **The binary has few outside modules, and `upgrade` checks each release's checksum and attestation** (`go/go.mod`; [trierarch-binary.md](trierarch-binary.md)): it argues its own command line, colours with `internal/style`, and already has `golang.org/x/term`. Every library added is code in the binary every machine runs.

## Questions

Each is one decision, with its options and this design's pick. They are in the order they should be decided: what is shown first, then where it comes from, then how it is opened, then how it is built. The approved purpose already answers who uses it (the person and a ship they set on it, on the machine), whether it acts (it shows and names the way to act), whether a dead session's end is part of it (yes) and whether it covers the trierarch itself (a banner when the service is down).

**Q1. How much of what a session did does it show?**
1. The facts only (lesson 7): state, turn and since when, the latest activity's kind and tool and how long ago, the processes under the session with how long each runs, and where its files are.
2. As 1, and the last lines of what the session wrote, from the hold's `events.jsonl` (lesson 6).
3. As 2, and each harness's own session log, wherever the harness keeps it.

Pick 2: on 6 Nov the facts said "busy" but not what the step was; only what the session wrote said that. `events.jsonl` is the trierarch's own record for every harness, so nobody needs to know where a harness keeps its log (lesson 5); option 3 would bind the tool to each harness's file places. It stays on the machine's screen, so nothing leaves the computer.

**Q2. How does it keep secrets off the screen?**
1. It shows no line a session wrote, only kinds and tools, so there is nothing to mask (this undoes the pick of Q1).
2. It never reads the trierarch's secret fields (the crew token in the state, the token files beside `ships/`; lessons 11 and 20), and in what a session wrote it masks each of those secrets by its value before showing a line.
3. As 2, and it also masks anything shaped like a token (long random strings, known key prefixes).

Pick 2: the trierarch knows every secret it holds, so it can mask exactly those, which is no hidden behaviour (lesson 9). Option 3 guesses at content, hides lines the person came to read, and still cannot promise to catch a secret a session found elsewhere; option 1 gives up the 6 Nov case.

**Q3. How long is what a dead session left kept?**
1. Until the ship's next session starts.
2. Until the ship's next session ends or its folder goes: a new session's start keeps the last end's reason and lines beside it.
3. Until the person has read it in the tool, as #471 words it.

Pick 2: a crashed ship is the moment a person comes to look, and a ship that keeps restarting needs the last end still readable while the next session runs. Option 3 makes reading change state, which a tool that only shows should not do, and keeps files with no bound.

**Q4. Where does it find a ship's places?**
1. It takes a ship, by its name or id, and finds each of its places (lesson 5); the files stay where they are.
2. As 1, and the hold's files move from `sessions/<shipId>/` into `ships/<shipId>/`, so one folder holds all of a ship.

Pick 1: the ship is the unit the person names, which is what the rework gave; the hold's folder holds the token files that must stay out of `ships/<shipId>/` (lesson 11), so moving it is a change of its own with no gain for this job.

**Q5. Where do the inbox's facts come from, without the fleet?**
1. It shows none: deliveries waiting and forced are left out.
2. The trierarch writes what each pass saw of each inbox to a file beside the state, with when it saw it, and the tool shows that with its age; the tool calls no fleet.
3. The tool asks the fleet when it can, and shows nothing of the inbox when it cannot.

Pick 2: "what waits for it" is part of the job, and over SSH without the fleet the last pass's view, with its age, is still true to say (lesson 21). Option 3 makes the tool a fleet client holding the trierarch's crew token, which a tool that only shows does not need.

**Q6. When does the banner say the trierarch's service is down?**
1. When the service manager says it does not run, as `status` reads it (lesson 4).
2. As 1, and also when it runs but its last pass failed or is older than a few pass intervals, since then too nothing shown is current.

Pick 2: on 6 Nov the service was down, but a service that runs and passes nothing leaves the same old facts on screen; `status` already reads the last pass's failure (lesson 19), so both come from what the trierarch keeps.

**Q7. How is the live mode opened?**
1. A command of its own, `aeolus-trierarch tui`.
2. A flag on an existing command, such as `aeolus-trierarch list --live`.
3. `aeolus-trierarch` with no command, on a terminal.

Pick 1: it is a different way of using the binary, with its own keys and its own exit, and a command of its own says so in `--help`. A flag would make `list` mean two things, and option 3 takes the help away from a bare `aeolus-trierarch`.

**Q8. How does a session, or a pipe, read the same view of one ship?**
1. Only through the live mode; a session reads the files itself.
2. A plain command for one ship, such as `aeolus-trierarch status <ship>`, with `--json`, saying the same facts as the live mode's opened ship, from the same code.
3. The live mode, which prints one screen and exits when it has no terminal.

Pick 2: a ship set to investigate has no terminal to drive a full-screen view, and the purpose gives it the same data; one reader behind both keeps them from telling different things. Option 3 makes one command behave two ways by where it runs, which is hidden behaviour (lesson 9).

**Q9. Which library draws it?**
1. Bubble Tea (charmbracelet), with Lip Gloss for layout.
2. tview, on tcell.
3. None: drawn on `golang.org/x/term`, which the binary already has (lesson 22).

Pick 1: its model, update and view are plain functions of messages, so each screen is tested as data, test first, without a terminal; it is the usual Go choice, MIT licensed and maintained, and runs over SSH as any terminal program does. tview is built of stateful widgets that are harder to test; option 3 means writing and keeping a terminal library of our own for a view that only shows.

**Q10. How does it stay current?**
1. It reads the files again on a fixed interval, of the order of the pass interval.
2. It watches the files (fsnotify) and reads again when one changes.
3. The running service sends it what changed over a socket.

Pick 1: the facts change once per pass anyway, reading a few small files is cheap, and it needs no new module. Option 2 adds a module and behaves differently on macOS and Linux; option 3 shows nothing when the service is down, the very case the banner is for.
