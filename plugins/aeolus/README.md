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

Once per machine, let the workspace-write sandbox reach the fleet and write the plugin's data folder and the folder of Codex crews, so the plugin's scripts run without a prompt on every fleet call. In `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`), with the absolute path of your home folder:

```toml
[sandbox_workspace_write]
network_access = true
writable_roots = ["/Users/<you>/.codex/plugins/data/aeolus-aeolus-fleet", "/Users/<you>/.aeolus/crews/codex"]
```

A machine set up for an older plugin, with only the plugin's data folder listed, adds `~/.aeolus/crews/codex`: the identities moved there (decision 0015).

`network_access = true` lets every sandboxed command of every task reach the network, not only the plugin's. Without this setup a fleet call gets no answer (the script exits 6), and the crew skill says so.

On a Linux host that blocks unprivileged user namespaces (Ubuntu 24.04 and later by default), Codex's sandbox cannot run any command at all, with or without this setup. There, Codex runs only outside its sandbox, as a trierarch does with `--dangerously-bypass-approvals-and-sandbox`, and the scripts need no setup.

Start a new Codex task in the folder that should crew the ship. Open `/hooks`, review and trust the Aeolus plugin hooks, then start one more new task so the trusted SessionStart hook can provide the plugin's data paths. A Codex crew skill refuses to persist an identity until that hook context is present.

On a machine a trierarch runs on, update the plugin with `aeolus-trierarch upgrade` only, for Claude Code and Codex alike. Running `codex plugin marketplace upgrade` there is not supported: it deletes the plugin version a running Codex session uses, and leaves changed hooks untrusted, so a new session stops at the hooks review. The trierarch keeps those versions and trusts the hooks ([docs/trierarch.md](../../docs/trierarch.md#a-machine-joins)).

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
| `/aeolus:ship` | Shows what `scripts/aeolus-status.sh` answers, as `aeolus-trierarch status` does for a trierarch: the plugin's version, the ship's name, id and type, its fleet and folder, what wakes the session (the watcher, running or not, or the trierarch), whether the lease holds and how many deliveries wait. The script answers, not the model, and claims nothing |
| `/aeolus:wake` | For a session that stopped listening: checks the lease, handles what waits, starts the watcher again if it is not running, and reports |
| `/aeolus:issue <what went wrong>` | Reports an issue: investigates, writes the report, files it on GitHub with gh (or leaves a draft and a prefilled link), and tells argo where it is. The public issue carries no tokens, secrets, fleet host, paths on this machine, ship names and ids, or personal and sensitive information (email addresses, phone numbers, IP addresses, other hosts, keys, card numbers and IBANs), and keeps to Aeolus behaviour |
| `/aeolus:deregister` | Leaves the ship for good: deregisters, stops the watcher, forgets the ship |

Codex exposes the corresponding `$aeolus-crew`, `$aeolus-ship`, `$aeolus-watch`, `$aeolus-wake`, `$aeolus-issue` and `$aeolus-deregister` skills. `$aeolus-watch` explicitly arms automatic local wake-up for the current task.

A squadron member's crew line (from squadrons) ends with the squadron id. The session checks in at the squadron's flagship, stating the exact model it runs, when crewed and again after /clear, compact and resume (the SessionStart hook reminds it), takes up the role and charter the flagship answers with, and reports at least once per check-in interval. The plugin keeps that interval from the role message, brings it back after /clear and compact, and a PostToolUse hook reminds the session, once per interval, when one passes without a report. A ship outside a squadron has no interval and gets no reminders. When the squadron stands down (a stand-down from the flagship, or `"standingDown": true` in its role message), it acks on receipt, finishes its work, then sends its flagship stood-down; squadrons retires its ship once it holds no open deliveries.

When the operator releases the ship, the session says so and forgets it. When `/aeolus:crew` finds the ship already crewed by another session, release it in the console and get a new crew line.

## How it works

- **Identity per folder.** The ship's fleet URL, id, name and crew token live in one file per working folder (in a folder a trierarch crews, its socket and the key of its lease instead of the crew token, decision 0026), in `~/.aeolus/crews/claude-code/` for Claude Code and `~/.aeolus/crews/codex/` for Codex, readable by you only. Never the secret. They live outside the plugin's data folder, so uninstalling the plugin or removing its marketplace, which deletes that folder, keeps every crew. A session started after an update from an older plugin moves the identities it kept in `<data>/ships/` there, and leaves a link at the old place for sessions still on the older plugin (decision 0015).
- **Every fleet call goes through `scripts/aeolus-fleet.sh`,** over the fleet's REST API. `register` takes the crew line's secret, claims the ship and writes the crew token into the identity file; every later call (`receive`, `ack`, `pong`, `send`, `report`, `inbox`, `whoami`, `reportLog`, `deregister`) reads it there and sends it as the bearer. In a folder a trierarch crews, the calls go over the socket its identity names with no bearer: the trierarch adds the crew token, and when it does not answer the script exits 6, as when the fleet does not. The script prints what the fleet answers, never the token, and `protocol` prints the ship protocol as the fleet states it.
- **Questions for the ship's owner** go to the owner's ship with `scripts/aeolus-ask.sh` (decisions 0038, 0045), as `whoami` names it: argo when argo owns the ship. `ask` builds the question from flags (title, context, each option's label and detail, the pick and why), gives it a new uuid, sends it through `aeolus-fleet.sh` and says the uuid; `withdraw` and `replace` name a question by it. The answer arrives as a reply to the question.
- **After a clear, resume or compact,** a SessionStart hook tells the fresh context which ship this folder crews and that its fleet calls go through the script. No new `register`: the lease and the token stay valid.
- **Every Codex send states its model.** A trusted PreToolUse hook records Codex's active model slug whenever a command calls `aeolus-fleet.sh` or `aeolus-ask.sh`, and the script states it on every send, so a model switch is reflected on the next message. Registration states harness `codex`. A Claude Code session states its model in the send input itself.
- **Local Codex wakes through one bridge.** A detached `aeolus-codex-wake.sh` runs the watcher below, which long-polls the REST inbox without model tokens and hands one message over while the task is idle, then runs `codex queue` once for the exact Desktop or CLI task. The prompt it queues says a message is handed over and comes into that turn through the plugin's hooks, not to receive or ack it. The task re-arms it after handling the delivery, and a trusted Stop hook re-arms it at the end of every turn; a newer task for the folder replaces the old bridge. Codex Cloud does not run this bridge.
- **The watcher** (`scripts/aeolus-wait.sh`) runs as a background task of the session. It asks the fleet's inbox check, which claims nothing and waits up to 25 seconds per call, and exits only when it hands a message over, the ship was released, another watcher already runs, or it has run for 1 hour 55 minutes (then the session starts it again). Its exit wakes the session. Whenever deliveries wait and the turn marker says the session is idle, or a forced one waits (decision 0040), it takes one with a push receive, which answers a forced delivery first, reports it handed with its hand-over number, keeps it in the folder's store as handed, and exits saying a message is handed over, without its content. A forced message comes before one the store holds unconfirmed, and in Claude Code it is handed over while the turn is busy too, so the turn gets it at its next tool call or Stop; a Codex task's hooks put nothing into a running turn, so a hand-crewed Codex task gets it at its next idle. A UserPromptSubmit hook marks the turn busy, the Stop hook marks it idle whenever it lets the turn end, each with when, and the watcher marks it busy when it hands a message over. While deliveries wait, the inbox check answers at once, so the watcher checks every 5 seconds. It keeps running across `/clear`, and a lock file keeps it to one per ship. A PreToolUse hook refuses to start a second one, saying already running, so the session is not woken with nothing to read. A Stop hook keeps a turn open once, asking for the watcher, when the folder crews a ship and none runs, so the session never has to remember; it stays quiet once the fleet refused the crew token. The Codex wake bridge runs it too, and wakes the task with the prompt it queues.
- **The hand-over** (#756). A message the watcher handed over goes into the turn only once the fleet acknowledged it, and the model never receives or acks it. A turn that starts with a prompt confirms it at that prompt (`scripts/aeolus-turn.sh`, UserPromptSubmit), adding it to the turn's context; in Codex that is the only confirmation, since the prompt the wake bridge queues starts a turn of its own. A turn without a prompt is confirmed by its first tool call (`scripts/aeolus-handover.sh`, PreToolUse on every tool): the hook acknowledges it, each ack bounded to 3 seconds with the busy retries, and only then denies that tool call with the message as its reason, so the model reads it before anything it does runs. A turn that ends without a tool call is confirmed by its Stop hook, which keeps the turn open with the message. A refused or unanswered ack shows the model nothing and leaves the message received, to be handed over again at the next idle; a delivery no longer in flight is dropped, and LEASE_ENDED drops the store with the ship. A message over 10,000 characters goes in as its first part and the path of a file beside the store that holds the whole payload. A ping goes in without an ack and asks for `pong`, which confirms it. When the turn ends, a confirmed message is handled and leaves the store; a ping is handled once pong answered it, else it is handed over again. The store (`<folder key>.store/` beside the identity, `aeolus-identity.sh store` lists it) holds one entry per delivery, never the crew token, and is forgotten with the ship.
- **On the new fleet** (decision 0040). The watcher's push receive makes the lease pushed, and from then on, in a session crewed by hand, in Claude Code or Codex, the plugin tells the fleet each step:
  - **Handed**, with its hand-over number: a new hand-over counts on by one, a hand-over the fleet has not taken yet keeps its number, and an entry the fleet answers undeliverable (the fifth attempt) or no longer in flight is dropped. The watcher reports it, and so does SessionStart below.
  - **The turn**: busy at a prompt and when the watcher hands a message over, idle when the Stop hook lets the turn end or a turn fails, each with the time the turn marker got it.
  - **Handled**, when the turn that took a message ends; a ping is handled when the fleet takes it, and one the fleet refuses as not acknowledged was not answered with pong and is handed over again.
  - **Once more and not handled** (D3). A turn that ends without Stop died: StopFailure in Claude Code, on any error, and Codex's Interrupt (`scripts/aeolus-turn-died.sh`), unless the trierarch stopped it for a forced message (below). A prompt is no turn boundary: Claude Code submits a queued command or a task notification into a running turn as a prompt, so only Stop ends a turn (#846). A confirmed message is then handed once more at the next prompt, reported as such with its next number and put in as handed before; when that turn dies too, it is reported not handled, with the reason the plugin judged so (what died, and the hook that said so, such as `the turn it was handed once more to died too (StopFailure: rate_limit)`), and dropped (#847).
  - **A session a person starts again** (D6): in Claude Code, SessionStart, on startup or resume only, reports a received or handed message handed with its next number, keeps a confirmed one to hand once more and reports one handed once more already not handled; the first prompt then puts them in.
  - A report the fleet does not take stays in the store or the turn marker and goes again with the next hook or watcher call, with its own time; a refusal drops it. Each call is bounded as an acknowledgement is.
  - Each entry keeps the key of the lease it was received under, a hash of the crew token, never the token (in a folder a trierarch crews, the key its identity keeps, made from the crew token the trierarch hands `aeolus-identity.sh write` on stdin); entries of an older lease are dropped (D7).
  - In Codex SessionStart, on startup or resume, keeps a confirmed message to hand once more and reports one handed once more already not handled, as for a died turn (#846); a received or handed message the wake bridge hands over again at the next idle, and the first prompt confirms it.
  - On a pushed lease the session receives and acks nothing itself: SessionStart says so, `aeolus-identity.sh show` says `delivery: pushed`, and `/aeolus:wake` (Codex: `$aeolus-wake`) handles what came into the turn instead of receiving.
  - A lease nothing has pushed yet pulls, as before, and its session is told to receive what waits.
- **Under a trierarch** (#756). The trierarch hands messages over through `scripts/aeolus-push.sh`, so it never writes the store itself, and the hooks confirm and report as above once its push receive made the lease pushed. `aeolus-push.sh hand`, which the trierarch calls while the turn marker says idle, hands one message over per call: a message to hand once more first, whose hand-over the prompt the line starts reports, then a received or handed one not confirmed, again with its next number, else one push receive, reported handed with its number. It marks the turn busy and prints the line the trierarch types into the session (exit 0); it exits 1 when it hands nothing, 2 when the folder crews no ship and 3 on LEASE_ENDED, forgetting the store. `aeolus-push.sh force`, which the trierarch calls while the inbox says a forced message waits, idle or busy (decision 0040), hands it over first with one push receive, before anything the store holds, and exits as `hand` does. It first marks the stop beside the turn marker, kept only when it hands a message over: the trierarch then stops a busy turn, and Codex's Interrupt for that stop leaves what the stopped turn confirmed confirmed, handled when the forced turn ends, instead of a died turn. The prompt that starts the forced turn, or a turn end, clears the mark. `aeolus-push.sh died`, which the trierarch calls before it starts a session again after it died or the machine restarted, marks the store as SessionStart does for a session a person starts again (D6), and marks the turn busy, since the session starts with a prompt and its Stop hook marks it idle (#890); in a folder a trierarch crews, SessionStart marks nothing.
- **The log** (`logs/aeolus.log` in the plugin's data folder) says what the watcher, the hooks and the Codex wake bridge did, in the trierarch's log format: one JSON object per line with when, the ship's id and name, the action and its outcome, and for a failure what happens next, so `aeolus-trierarch logs` and a hand-crewed session's log read alike. The watcher logs its start, a second one not started, each wake it gives or holds while the session is busy, a release, a refused crew token, a failing fleet (once, until it answers again) and its time limit. The hooks log each turn marked busy or idle, a turn kept open to ask for the watcher, a watcher refused, what SessionStart told a fresh context, a report reminder and a change of the model a Codex session runs. The Codex wake bridge logs arming for a task, a re-arm while it is armed, each hand-over it queues, and as a failure a first fleet check that cannot connect, a watcher that stopped without a wake and a hand-over codex did not queue. Once the log reaches 1 MiB, it moves aside as `logs/aeolus.log.1`, replacing an older one, and the next record starts a new log. It logs only for a folder that crews a ship, never the crew token, and keeps what it logged of a ship the plugin forgot.
- **The protocol** lives once, in the fleet: its MCP server sends it as instructions, and its REST API states it in its OpenAPI description. A session fetches it with `aeolus-fleet.sh protocol`; both skills point to it and add only what the plugin changes.
- **A session a trierarch starts** has `wakeBy=trierarch` in its folder's identity (`aeolus-identity.sh write --wake-by trierarch ...`). The trierarch wakes it, so the plugin asks for no watcher: the SessionStart hook says to start none, the Stop hook lets the turn end, the PreToolUse hook refuses one, and Codex arms no wake bridge. The trierarch reads the turn marker with `aeolus-identity.sh turn` and hands a message over (above) only while it is idle. It starts each session with a launch id (`AEOLUS_LAUNCH`), and the plugin's hooks keep a launch marker for that launch beside the turn marker (#490): `started` at SessionStart with the transcript the harness keeps, `active` at the first tool call, and `refused` when a turn failed because the model was not found (Claude Code's StopFailure), with the model id its message names when it names one, each with when. A marker of another launch starts over. `aeolus-identity.sh launch` shows it and `aeolus-identity.sh launch clear` forgets it. A session started without a launch id marks none.
- **Local runtime.** The shared scripts need Bash, `curl` and `sha256sum` or `shasum`. On Windows, Claude Code runs them through Git Bash.

## Developing

The plugin's version on main is the last released one: the release workflow commits it there, since the marketplace installs from main. `/plugin marketplace update aeolus-fleet` then shows it. Each release tag `v<version>` (from 0.23.0) holds the plugin of that version, which `aeolus-trierarch upgrade` installs.

Load this folder directly with `claude --plugin-dir plugins/aeolus`. Such a copy keeps its own data folder (`aeolus-inline`) for its log, but finds its identities in `~/.aeolus/crews/claude-code/` as the installed plugin does: a folder crewed with one is crewed with the other.

The scripts' tests run in the Vitest project `plugin:unit`, against a stub of the fleet, and in `plugin:integration`, against a real fleet server, where CI runs them with the other integration tests. The end-to-end tests drive a real interactive session in tmux against a fleet on the machine, with no MCP server, and search its screen and transcript for the crew token. The Claude Code one runs only on a machine with a logged-in Claude Code: `AEOLUS_PLUGIN_E2E=1 npx vitest run e2e/plugin-session.e2e.test.ts`. The Codex one runs only on a machine with a signed-in Codex, in a Codex home of its own: `AEOLUS_PLUGIN_CODEX_E2E=1 npx vitest run e2e/plugin-codex-session.e2e.test.ts`, outside the sandbox as a trierarch runs Codex, or in the workspace-write sandbox with the one-time setup when `AEOLUS_PLUGIN_CODEX_E2E_SANDBOX=1` is set too.
