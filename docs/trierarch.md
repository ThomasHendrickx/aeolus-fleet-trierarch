# Trierarch: crewing ships on machines

Model and decisions: 0026 (the trierarch on a machine), 0027 (crew settings), 0029 (the crew request and its scopes) and 0030 (the trierarch plugin). The fleet holds the crew request; everything else here is read only by the trierarch plugin, the trierarchs it manages and the console. `@aeolus-fleet/trierarch-plugin` and `@aeolus-fleet/trierarch` are one implementation, optional, like squadrons; their build is in [architecture.md](architecture.md#the-trierarch). Anyone may write another: this file is what it must do.

Two parts, each its own process and package:

- **The trierarch plugin** (`@aeolus-fleet/trierarch-plugin`), the plugin on the server side, one per installation, beside squadrons: a ship of each fleet it serves. It brings machines into the fleet and picks which machine crews each crew request.
- **A trierarch**, one per machine: a plain process, not an AI, crewing its own ship of type `trierarch`. It crews the ships whose requests are assigned to it, and starts, restarts, wakes and stops their sessions. It never commissions, retires or picks.

Plugins never know each other: a requester (the console, squadrons, an orchestrator ship) only touches ships and their crew requests. Without the trierarch plugin a crew request is the operator's to-do list, crewed by hand.

## The crew request

Declared state on the ship, in the fleet core (decision 0029): "keep this ship crewed, with these settings". At most one per ship, standing (level, not edge). Its parts, each with one writer:

| Part | Holds | Written by | Scope |
| --- | --- | --- | --- |
| Request | The settings (below) | A requester | `fleet:manage` |
| Assignment | The trierarch ship that crews it; set only while unassigned | The trierarch plugin | `crew:assign` |
| Reason | Why no trierarch can take it, while unassigned; shown in the operator's needs-crew to-do | The trierarch plugin | `crew:assign` |
| Status | crewing, running, restarting, crashed, releasing, with the restart attempt (0 on the first start) and when the session started; and who crewed it, the trierarch or argo | The assigned trierarch | `crew:run` |

The server stores the settings without meaning and checks only their size. The settings have a fixed core (decision 0027), whose schema lives in `common`:

- the harness;
- the workspace: a new git worktree of a repository (`{ kind: worktree, repository, ref? }`) or a folder (`{ kind: folder, name }`), each named in the trierarch's local configuration;
- optionally the squadron the ship is a member of, so it checks in at its flagship as a crew line's squadron id does. With a squadron, the session starts with that squadron's crew line and template, as squadrons crews a new member, instead of a plain first prompt;
- an optional first prompt, at most 8 KB and never starting with `-` (it would read as a flag), given on the first start only;
- options, checked against the JSON Schema the trierarch reports for that harness.

Settings never carry paths or command-line flags: a workspace names a repository or folder, and options pick named settings.

```json crew request settings
{
  "harness": "claude-code",
  "workspace": { "kind": "worktree", "repository": "aeolus-fleet", "ref": "main" },
  "squadron": "hemma-feature-a1b2c3",
  "firstPrompt": "Review the open pull requests.",
  "options": { "model": "opus" }
}
```

A trierarch's ships are a query, the requests assigned to it, never a list kept on its ship.

The request is the desired state. A ship released elsewhere while its request stands is crewed again by its trierarch. Retiring the ship removes its request (decision 0029).

## Following the fleet

The trierarch plugin follows the fleet's changes: new, changed and removed requests, and reports. Every check-in, of the trierarch plugin and of each trierarch, returns the latest full state (for a trierarch, the requests assigned to it), so a missed event never leaves either stale. The trierarch plugin keeps a small database of its own, the same shape as squadrons': per fleet only the connection (its ship and kept crew token) and the switch, set through installation procedures as squadrons' are (decision 0021). Everything else (requests, statuses, machines) lives in the fleet.

## A machine joins

A trierarch never registers or labels itself.

1. The operator asks the trierarch plugin for a new machine, naming it. The trierarch plugin commissions a ship of that name, of type `trierarch` with `crew:run` beside the send and receive every agent has, nothing more, and answers its starting prompt (decision 0019) and one setup line for the machine, built from the fleet's URL, the ship's id and its secret: `npx @aeolus-fleet/trierarch init --fleet-url <url> --ship-id <id> --secret <secret>`. Both are shown once; the trierarch plugin never logs the secret.
2. On the machine, the setup line runs `aeolus-trierarch init`, which takes the fleet URL, ship id and secret as flags (it never parses a prompt), registers, writes the configuration and installs the service.
3. The trierarch reports what it can do in its report's details (below).
4. The trierarch plugin labels the machine from that report (labels, #102). Until it does, placement reads the report itself.

A trierarch's ship stays a normal ship: it receives messages, such as pings, and sends its crash reports to argo. Releasing it is the kill switch for that machine.

### What a trierarch reports

Its report, sent on start and again whenever it changes: its state (`working` while a session runs, `idle` with none), a one-line note such as "4 of 6 running, 1 crashed" (the sessions that run of `caps.ships`, and the crashed ones when there are any), and `details`, read from its local configuration and what runs. Each harness's `flags` are the flags its configuration gives it, and its `riskyFlags` those of them its adapter calls risky, so a reader needs no harness knowledge: `--dangerously-skip-permissions` for Claude Code and `--dangerously-bypass-approvals-and-sandbox` for Codex. The console marks them:

```json trierarch report details
{
  "harnesses": [
    {
      "harness": "claude-code",
      "options": { "type": "object", "properties": { "model": { "enum": ["opus", "sonnet"], "default": "opus" } }, "additionalProperties": false },
      "flags": ["--remote-control", "--dangerously-skip-permissions"],
      "riskyFlags": ["--dangerously-skip-permissions"]
    }
  ],
  "workspaces": { "repositories": ["aeolus-fleet"], "folders": ["notes"] },
  "caps": { "ships": 8, "running": 4 },
  "kept": [{ "shipId": "shp_01m473j7hp3x6gha0gzs1mnf88", "path": "/Users/thomas/.aeolus/trierarch/worktrees/aeolus-fleet/scout" }],
  "orphans": [{ "path": "/Users/thomas/.aeolus/trierarch/worktrees/aeolus-fleet/lookout" }],
  "version": "0.18.0"
}
```

Its shape lives in `common`, as the type `trierarch`'s report details. It holds no entry per ship: each request carries its own status.

## Assignment

The trierarch plugin serves unassigned requests oldest first and assigns each to one trierarch:

1. It considers trierarchs that fit: their report offers the request's repository (or folder), harness and model (its options schema for that harness takes the request's options), and they have room (`caps.ships` above the number of requests assigned to it).
2. Of those, it picks the one with the most room as a percentage of its `caps.ships`, then the oldest: the first commissioned. A trierarch that has not reported details yet takes nothing.
3. It assigns by optimistic claim: the fleet sets the assignment only if the request is still unassigned. A lost claim is no error; the trierarch plugin reads again.
4. It never assigns a request whose ship is crewed already: crewing by hand fulfils a request.
5. When no trierarch can take a request (none offers its harness, workspace or options, or none has room), the trierarch plugin writes the reason on the request. It shows in the operator's needs-crew to-do.

Strategies to change this order come later. The operator does not pick the machine.

A machine is silent when its trierarch's last seen is older than a threshold: 5 minutes, which the trierarch plugin's configuration may change. A trierarch no session crews has no last seen and is never silent. A silent trierarch gets no new requests; the ones it holds stay assigned to it, nothing moves. The flag shows on the machines page and in needs attention.

## Crewing a ship

A trierarch reconciles from the requests assigned to it. Its loop crews each one:

1. It saves the entry as crewing and writes status `crewing`.
2. It gets a starting prompt with `crew:run` and registers with the secret, so the session never sees the secret.
3. It writes the folder's identity through the aeolus plugin, with the squadron when the settings name one, saying the trierarch wakes it.
4. It starts the harness in the folder, with `/aeolus:wake` (Codex: `$aeolus-wake`) as the first prompt, and writes status `running`.

From then on the trierarch watches the ship's inbox while the session runs. It wakes the session when deliveries wait and the session is idle, and restarts a session that dies.

Before it crews, the trierarch checks the settings again against its own configuration (decision 0027): the harness, the repository or folder, and each option's value. Settings it cannot crew are not crewed and get no status; it tells argo once per settings version, as plain text naming the ship and the field at fault.

A ship crewed by hand before its trierarch crews it counts as crewed: the trierarch leaves it, writes no status, and the status shows it was crewed by argo. Once the ship awaits crew again, the trierarch crews it.

The trierarch's own ship takes no work by message: a ping gets pong, and any other delivery is acknowledged and logged as not handled. Only the crew requests assigned to it start or stop a session on the machine.

### Crashed and Restart

A session that dies is restarted by the trierarch on its own. When its restart budget is spent, the trierarch writes status `crashed` and sends argo a plain-text report naming the ship and how often its session crashed: a human decides. The operator's Restart writes the request again as an exact copy, and Edit writes it with new settings: either is a new settings version. The trierarch treats a new version of its crew record as the signal: it stops the running session and crews the ship again with that version, in the same worktree, and a crashed request starts again with a fresh restart budget. It is no release: the worktree stays.

## Lifecycles

The ship, its crew request, its session and its worktree live and end together:

| # | Event | Ship (fleet) | Crew request | Session | Worktree |
| --- | --- | --- | --- | --- | --- |
| 1 | requested | must exist and await crew | unassigned | none yet | none yet |
| 2 | assigned | awaiting crew | assigned to a trierarch | none yet | none yet |
| 3 | first crew | crewed (the trierarch registers) | crewing, then running | started | created, identity written |
| 4 | session dies | crewed, lease held | restarting | started again in the same folder, same crew token | kept |
| 5 | restart budget spent | crewed, lease held | crashed, a report sent to argo | stopped | kept |
| 6 | the machine restarts | crewed, lease held | unchanged | started again by the loop | kept |
| 7 | request removed | awaiting crew, lease ended | releasing, then gone once the trierarch confirms | stopped | removed if clean; kept and reported if not |
| 8 | the trierarch stops mid-crew (a lost `register` reply among them) | perhaps crewed, by its own lost token | crewing, saved locally before it registered | none, or a stray | perhaps half made |
| 9 | the trierarch is uninstalled | crewed | still assigned to it | stopped first | uninstall lists kept worktrees and deletes nothing |
| 10 | the machine goes silent | as it was | still assigned to it, the machine flagged | unknown | unknown |
| 11 | released elsewhere | awaiting crew, then crewed again by the trierarch | unchanged, crewing, then running | stopped, then started | kept |
| 12 | Restart or Edit: the request written again, a new settings version | crewed, released and crewed again by the trierarch | the new version: crewing, then running | stopped, then started with a fresh restart budget | kept |

The rules that close the gaps:

1. The trierarch removes only what it made: worktrees under its own worktree root, never a configured folder and never a worktree with changes. A kept worktree is reported in its details until a human clears it.
2. Every pass of the loop also looks for strays. A session of the trierarch with no assigned request is stopped. A worktree under its root with no assigned request is reported as an orphan, never deleted. A request that is no longer assigned to it without being removed (its ship retired) has its session stopped and its identity removed; its worktree is then an orphan.
3. After a stop mid-crew, the loop resumes from its assigned requests and its saved state. An entry still crewing whose ship is crewed was lost between register and its reply: the trierarch releases the ship (`crew:run`) and crews it again. A half-made worktree of an assigned ship is used; one of a ship no longer assigned is an orphan (rule 2).
4. A worktree with changes never holds up releasing the ship: the lease ends either way, so the ship can be crewed elsewhere.
5. The trierarch watches a ship's inbox only while its session runs, so "last seen" still means the session is alive. It reports on the ship's behalf when its session crashes or restarts ("blocked: session crashed, restarting").

```mermaid
stateDiagram-v2
  [*] --> Unassigned: requested
  Unassigned --> Assigned: claimed by the trierarch plugin
  Assigned --> Crewing: saved as crewing
  Crewing --> Running: register, create worktree, start session
  Crewing --> Crewing: resumed with the ship crewed, release and register again
  Running --> Restarting: session dies
  Restarting --> Running: start again, same folder and crew token
  Restarting --> Crashed: restart budget spent, report to argo
  Running --> Releasing: request removed
  Crashed --> Releasing: request removed
  Running --> Crewing: a new settings version, the session stopped
  Crashed --> Crewing: a new settings version, a fresh restart budget
  Releasing --> [*]: trierarch confirms, request gone
```

## Release

Removing a crew request is the one way to stop a ship's crew through a trierarch. The request is marked releasing; the assigned trierarch stops the session, ends the lease, removes the worktree when clean, and confirms; only then does the request disappear (a finalizer). A restart of the machine is no release. Retire stays separate, for whoever holds `fleet:manage`.

Stopping a session must stop its work, or a release and a restarted crash would leave work running with no one watching it. So a harness adapter starts each session as a process that owns its work. Codex by default runs a session's turns in its shared app-server daemon, which keeps a turn running after the session's pane is gone: the codex adapter always adds `--no-daemon`, as mechanism, the way the Claude Code adapter adds `--continue` on a restart. Neither is the operator's flag.
