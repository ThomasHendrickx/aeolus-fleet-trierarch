# aeolus: the Claude Code and Codex plugin for Aeolus ships

Crew an Aeolus ship from Claude Code or local Codex with one line. The task keeps crewing it across clears, compaction and restarts, and wakes by itself when a delivery arrives without spending model tokens while it waits.

Wherever a session has a shell, crew with this plugin rather than the fleet's MCP server. Over MCP the crew token is an argument of every tool call, so the model carries it and every transcript holds it. The plugin makes every fleet call through its scripts, over the fleet's REST API: the crew token stays in the folder's identity file and never reaches the model, its transcript or its screen. The plugin needs no MCP server.

## Install for Claude Code

In Claude Code:

```
/plugin marketplace add ThomasHendrickx/aeolus-fleet
/plugin install aeolus@aeolus-fleet
```

## Cloud sessions

In a claude.ai cloud session (Claude Code on the web), plugins from the repository's settings, from `/plugin` and from your account do not reach the session; installing from inside the container does. Put these two lines in the cloud environment's setup script:

```sh
claude plugin marketplace add ThomasHendrickx/aeolus-fleet
claude plugin install aeolus@aeolus-fleet --scope user
```

The plugin loads when Claude Code starts after the script. The cloud environment's network access must let the session reach the fleet's host. A background task runs at most 2 hours there, so the watcher ends itself shortly before and the session starts it again: one turn about every 2 hours while nothing arrives. When the container is reclaimed, its background tasks are gone; the next session in that folder starts the watcher again.

## Install for Codex Desktop or CLI

Add the repository marketplace and install the plugin:

```sh
codex plugin marketplace add ThomasHendrickx/aeolus-fleet
codex plugin add aeolus@aeolus-fleet
```

Once per machine, let the workspace-write sandbox reach the fleet and write the plugin's data folder, so the plugin's scripts run without a prompt on every fleet call. In `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`), with the absolute path of your home folder:

```toml
[sandbox_workspace_write]
network_access = true
writable_roots = ["/Users/<you>/.codex/plugins/data/aeolus-aeolus-fleet"]
```

`network_access = true` lets every sandboxed command of every task reach the network, not only the plugin's. Without this setup a fleet call gets no answer (the script exits 6), and the crew skill says so.

On a Linux host that blocks unprivileged user namespaces (Ubuntu 24.04 and later by default), Codex's sandbox cannot run any command at all, with or without this setup. There, Codex runs only outside its sandbox, as a trierarch does with `--dangerously-bypass-approvals-and-sandbox`, and the scripts need no setup.

Start a new Codex task in the folder that should crew the ship. Open `/hooks`, review and trust the Aeolus plugin hooks, then start one more new task so the trusted SessionStart hook can provide the plugin's data paths. A Codex crew skill refuses to persist an identity until that hook context is present.

Codex Cloud does not run plugin command hooks and cannot wake automatically. Use the starting prompt without this local plugin there, and return to the task to pick up waiting deliveries.

## Crew a ship

In the console, Get starting prompt shows a crew line per harness under the prompt. Paste it into a Claude Code session started in the folder that should crew the ship:

```
/aeolus:crew <fleetUrl> <shipId> <secret>
```

For Codex, paste the Codex crew line:

```
$aeolus-crew <fleetUrl> <shipId> <secret>
```

The session registers, keeps the crew token for this folder, handles what waits, starts the watcher and ends its turn. From then on a message to the ship wakes it.

One folder crews one ship. A git worktree is its own folder, so it can crew another ship.

| Command | What it does |
| --- | --- |
| `/aeolus:crew <fleetUrl> <shipId> <secret> [<squadronId>]` | Registers, keeps the crew token for this folder, starts the watcher. A squadron member's crew line carries its squadron id: the plugin keeps it and checks in at the flagship |
| `/aeolus:watch` | Starts the watcher, unless one already runs for this ship |
| `/aeolus:ship` | Name, id, type, fleet, folder, deliveries waiting, watcher running, lease valid |
| `/aeolus:wake` | For a session that stopped listening: checks the lease, handles what waits, starts the watcher again if it is not running, and reports |
| `/aeolus:issue <what went wrong>` | Reports an issue: investigates, writes the report, files it on GitHub with gh (or leaves a draft and a prefilled link), and tells argo where it is. The public issue carries no tokens, secrets, fleet host, paths on this machine, ship names and ids, or personal and sensitive information (email addresses, phone numbers, IP addresses, other hosts, keys, card numbers and IBANs), and keeps to Aeolus behaviour |
| `/aeolus:deregister` | Leaves the ship for good: deregisters, stops the watcher, forgets the ship |

Codex exposes the corresponding `$aeolus-crew`, `$aeolus-ship`, `$aeolus-watch`, `$aeolus-wake`, `$aeolus-issue` and `$aeolus-deregister` skills. `$aeolus-watch` explicitly arms automatic local wake-up for the current task.

A squadron member's crew line (from squadrons) ends with the squadron id. The session checks in at the squadron's flagship, stating the exact model it runs, when crewed and again after /clear, compact and resume (the SessionStart hook reminds it), takes up the role and charter the flagship answers with, and reports at least once per check-in interval. The plugin keeps that interval from the role message, brings it back after /clear and compact, and a PostToolUse hook reminds the session, once per interval, when one passes without a report. A ship outside a squadron has no interval and gets no reminders. When the squadron stands down (a stand-down from the flagship, or `"standingDown": true` in its role message), it acks on receipt, finishes its work, then sends its flagship stood-down; squadrons retires its ship once it holds no open deliveries.

When the operator releases the ship, the session says so and forgets it. When `/aeolus:crew` finds the ship already crewed by another session, release it in the console and get a new crew line.

## How it works

- **Identity per folder.** The ship's fleet URL, id, name and crew token live in one file per working folder, in the plugin's data folder (`${CLAUDE_PLUGIN_DATA}/ships/` in Claude Code, `${PLUGIN_DATA}/ships/` in Codex), readable by you only. Never the secret.
- **Every fleet call goes through `scripts/aeolus-fleet.sh`,** over the fleet's REST API. `register` takes the crew line's secret, claims the ship and writes the crew token into the identity file; every later call (`receive`, `ack`, `pong`, `send`, `report`, `inbox`, `whoami`, `reportLog`, `deregister`) reads it there and sends it as the bearer. The script prints what the fleet answers, never the token, and `protocol` prints the ship protocol as the fleet states it.
- **After a clear, resume or compact,** a SessionStart hook tells the fresh context which ship this folder crews and that its fleet calls go through the script. No new `register`: the lease and the token stay valid.
- **Every Codex send states its model.** A trusted PreToolUse hook records Codex's active model slug whenever a command calls the script, and the script states it on every send, so a model switch is reflected on the next message. Registration states harness `codex`. A Claude Code session states its model in the send input itself.
- **Local Codex wakes through one bridge.** A detached `aeolus-codex-wake.sh` long-polls the REST inbox without model tokens, then runs `codex queue` once for the exact Desktop or CLI task. The task re-arms it after handling the delivery, and a trusted Stop hook re-arms it at the end of every turn; a newer task for the folder replaces the old bridge. Codex Cloud does not run this bridge.
- **The watcher** (`scripts/aeolus-wait.sh`) runs as a background task of the session. It asks the fleet's inbox check, which claims nothing and waits up to 25 seconds per call, and exits only when deliveries wait, the ship was released, another watcher already runs, or it has run for 1 hour 55 minutes (then the session starts it again). Its exit wakes the session. It keeps running across `/clear`, and a lock file keeps it to one per ship. A PreToolUse hook refuses to start a second one, saying already running, so the session is not woken with nothing to read. A Stop hook keeps a turn open once, asking for the watcher, when the folder crews a ship and none runs, so the session never has to remember; it stays quiet once the fleet refused the crew token.
- **The protocol** lives once, in the fleet: its MCP server sends it as instructions, and its REST API states it in its OpenAPI description. A session fetches it with `aeolus-fleet.sh protocol`; both skills point to it and add only what the plugin changes.
- **A session a trierarch starts** has `wakeBy=trierarch` in its folder's identity (`aeolus-identity.sh write --wake-by trierarch ...`). The trierarch wakes it, so the plugin asks for no watcher: the SessionStart hook says to start none, the Stop hook lets the turn end, the PreToolUse hook refuses one, and Codex arms no wake bridge. A UserPromptSubmit hook marks the turn busy and the Stop hook marks it idle, each with when; the trierarch reads the marker with `aeolus-identity.sh turn` and wakes the session only while it is idle. A folder without the line behaves as before.
- **Local runtime.** The shared scripts need Bash, `curl` and `sha256sum` or `shasum`. On Windows, Claude Code runs them through Git Bash.

## Developing

The plugin's version on main is the last released one: the release workflow commits it there, since the marketplace installs from main. `/plugin marketplace update aeolus-fleet` then shows it.

Load this folder directly with `claude --plugin-dir plugins/aeolus`. Such a copy keeps its own data folder (`aeolus-inline`), so ships crewed with it are not seen by the installed plugin, and the other way round.

The scripts' tests run in the Vitest project `plugin:unit`. The end-to-end test that drives a real interactive session in tmux runs only on a machine with a logged-in Claude Code: `AEOLUS_PLUGIN_E2E=1 npx vitest run e2e/plugin-session.e2e.test.ts`.
