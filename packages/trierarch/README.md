# @aeolus-fleet/trierarch

Keeps the ships whose crew requests are assigned to it crewed on the machine it runs on: it starts, restarts, wakes and stops their sessions, and writes each request's status. It crews with `crew:run`, which reaches only the ships assigned to it; it never commissions, retires or picks them. The trierarch plugin assigns them. What a trierarch does is in [docs/trierarch.md](../../docs/trierarch.md); how this package is built is in [docs/architecture.md](../../docs/architecture.md#the-trierarch). Optional, like squadrons.

## Install

On the machine that will run the sessions (macOS or Linux), with Node 26, `git`, `tmux`, and Claude Code with the aeolus-fleet plugin for Claude Code, Codex with the aeolus-fleet plugin for Codex, or both, installed. Codex must be on the `PATH` as `codex`:

```sh
npm install --global @aeolus-fleet/trierarch
```

That gives the command `aeolus-trierarch`.

1. Join the machine through the trierarch plugin (`machines.join`): it commissions the trierarch's own ship, type `trierarch` with `crew:run`, and answers its starting prompt and a setup line, `npx @aeolus-fleet/trierarch init --fleet-url <url> --ship-id <id> --plugin-ship-id <its own ship> --secret <secret>`, shown once. The machine then takes the trusted repositories from that ship alone (docs/trierarch.md, "Trusted repositories"); on a machine set up before, run `aeolus-trierarch init --plugin-ship-id <id>` once to take them.
2. Set up the machine with that line (it needs Node 26 and Claude Code or Codex installed and signed in; init stops before registering, saying what to install, when either is missing), or with `init` alone, which asks for what is missing:

   ```sh
   aeolus-trierarch init
   ```

   It asks for what it needs, in a short flow:
   - the fleet URL, the ship id and the secret. The secret is not shown as you type it, so it stays out of your shell history and any transcript. It registers the ship, keeps its crew token in `~/.aeolus/trierarch/crew-token` (readable by you only) and writes the secret nowhere;
   - whether Claude Code launches with `--dangerously-skip-permissions` (no unless you say yes);
   - where `codex` runs or Codex is configured already: whether to offer Codex, and whether it launches with `--dangerously-bypass-approvals-and-sandbox` (no unless you say yes). Every Codex turn runs as a `codex exec` process of its own, so stopping the session stops its work;
   - the repositories it may make worktrees of, by name and path. It trusts each one, as both Claude Code and Codex ask about a worktree's repository;
   - the folders it may crew a ship in as they are, by name and path. It trusts each one, so a session there starts with no trust question;
   - the caps: how many ships it takes, how many sessions run at once.

   It writes `~/.aeolus/trierarch/config.json`, with `config.schema.json` beside it so an editor checks it. When the configuration offers Codex, it answers Codex's one-time questions ahead too, through `codex app-server` as Codex's own dialogs do: it trusts each configured repository and folder in `~/.codex/config.toml` (a repository covers its worktrees), and trusts the aeolus-fleet plugin's hooks, without which a Codex session marks no turn and is never woken. A plugin update can change the hooks: `aeolus-trierarch upgrade` trusts the new or changed ones, and the trierarch trusts them again before every Codex launch. When the configuration offers Claude Code, it answers Claude Code's one-time questions ahead, so a session nobody watches never waits on one, and otherwise leaves Claude Code's files alone: it trusts the worktree root in `~/.claude.json`, each configured repository and each configured folder (on every run, so a place added since is trusted too), completes Claude Code's onboarding there without asking (each launch completes it again), and, when the sessions skip permissions, offers to accept bypass permissions mode in `~/.claude/settings.json`. Then it offers to install and start the service: a launchd agent on macOS (`~/Library/LaunchAgents/dev.aeolus-fleet.trierarch.plist`), a systemd user unit on Linux (`aeolus-trierarch.service`), started at login and again whenever it stops.

   Without a terminal, pass everything as flags and take every default with `--yes`: `aeolus-trierarch init --fleet-url https://fleet.example.com --ship-id shp_... --secret aeolus_sk_v1_... --yes`. Prefer the prompt: a secret in a flag lands in your shell history.

   Run `aeolus-trierarch init` again on a machine set up already to change the configuration. It says so and never registers again; to register another ship, remove `~/.aeolus/trierarch/crew-token` first. A setup that stopped partway goes on when you run its setup line again; once its ship was released, the setup line with the new secret registers it again.

## Use

| Command | What it does |
| --- | --- |
| `aeolus-trierarch status` | The installed version, and the one the service runs when it differs (then it says to restart), the aeolus-fleet plugin version each configured harness uses (or that it has none), the configured repositories by name, the service (running, pid, since), the fleet and the trierarch's own lease, the caps in use, the last pass (succeeded, or failing since when and why), the entries by state, kept worktrees and orphans |
| `aeolus-trierarch list` | The ships it crews: ship, state, harness, workspace, since, restarts |
| `aeolus-trierarch logs [--lines <n>] [--follow]` | The last lines of the log, and with `--follow` each new one: on macOS `~/.aeolus/trierarch/logs/trierarch.log`, where the launchd agent writes, with the log before it in `trierarch.log.1` (docs/trierarch.md says when it moves aside); on Linux the journal the systemd user unit writes to, read through `journalctl --user --unit aeolus-trierarch.service`. The log holds one JSON record per line: each action the loop takes for a ship (crew, launch, wake, report, release, confirm, forget, leave, stop) as `{ time, shipId, shipName, action, outcome, next }`, where `next` says what happens after a failure, or a message as `{ time, level, message }`. `logs` renders them as text, and `--json` gives the records as they are (a line that is no record as `{ line }`). `run` in a terminal writes the text |
| `aeolus-trierarch add repository <name> <path>`, `aeolus-trierarch add folder <name> <path>` | Adds a repository to make worktrees of, or a folder to crew a ship in as it is, checked as init checks it, and trusts it for every configured harness in one step: adding a place is what trusts it. Then it restarts the service so the trierarch offers it, and waits until the new process says its version (at most 30 seconds); sessions keep running. A place written into `config.json` by hand is never offered and never crewed until it is added |
| `aeolus-trierarch config check` | Checks the configuration and gives the flags each harness launches with, and each option value's flags. Then the command each harness launches on a first start and on a restart, with each flag marked `(configuration)` or `(adapter)` when the adapter adds it itself (`--json` for Codex, `--continue` on a Claude Code restart, `--permission-mode manual` (or `default`) where Claude Code's settings make plan the default mode, with when it applies where the folder's settings decide) |
| `aeolus-trierarch detect` | Detects again what each configured harness offers (its models, and effort where its CLI has a flag for it) and keeps it in `~/.aeolus/trierarch/detected.json`, then gives per harness its version, each option's values and when its models were last confirmed. Restart the trierarch so it reads them ([docs/trierarch.md](../../docs/trierarch.md#detected-options)) |
| `aeolus-trierarch start`, `stop`, `restart` | The service. `stop` returns once the trierarch has exited; a stopped one starts again at the next login. `start` and `restart` return once the new process says its version (at most 30 seconds). Restart it after you change the configuration |
| `aeolus-trierarch upgrade [version]` | Installs the given version, or the latest on npm, globally and pinned to it. Then the version it installs rewrites the service's file as its `init` does, and it stops the old process and starts the new one, waits until the new one says its version (at most 30 seconds), and shows `status`. Sessions keep running: the new process takes them over, and a session whose hold is of the older version is started again at its next idle turn, continuing its conversation. It also takes `--remote-control` out of the configuration and says so. If the install fails, the old version keeps running. Where npm's global folder is not yours to write (a system Node install), it installs nothing and says what to run instead: `sudo npm install --global @aeolus-fleet/trierarch@<version>`, then `aeolus-trierarch upgrade <version>` when the configuration offers a harness, which updates the aeolus-fleet plugin, then `aeolus-trierarch install` when the service is installed. It also updates the aeolus-fleet plugin for each harness the configuration offers to the plugin of the version it upgrades to, from that release's tag (from main for releases up to 0.22.0), even when the trierarch is on its version already, before the restart. After the install, the version it installed runs that step, as its own `upgrade <version>`, so one run ends with the plugin step of the version it upgrades to: Codex's version folders that running Codex sessions use stay beside the new one, and those none uses any more are removed, and the plugin's new or changed Codex hooks are trusted. A plugin that could not be updated is said, and upgrade exits 1. On a trierarch machine this is the only supported way to update the plugin: not `codex plugin marketplace upgrade`, nor Claude Code's own update. A trierarch up to 0.22.0 has no plugin step: upgrading from it, run upgrade once more with the new version. It never upgrades on its own |
| `aeolus-trierarch install [--no-load]` | Installs the service; over a running one it waits for the old process to exit, then loads it again, and returns once the new process says its version (at most 30 seconds). With `--no-load` it only writes its file |
| `aeolus-trierarch uninstall` | Removes the service and stops every session. It deletes nothing else: it lists the worktrees it leaves, and keeps its own files under `~/.aeolus/trierarch/` |
| `aeolus-trierarch run` | What the service runs: keeps the ships assigned to it crewed until stopped |
| `aeolus-trierarch --version`, `-v` | The installed version |

Every command takes `--json`, so a ship can read what it says, and `--config <path>`. `status`, `list` and `logs` read what is on the machine and send no message; `status` asks the fleet `whoami` once, for the lease.

To stop the trierarch: `aeolus-trierarch stop`, or `aeolus-trierarch uninstall` to keep it from starting at login. On the host, each session runs under a hold of its own and has no terminal to attach to: what it writes is in `~/.aeolus/trierarch/sessions/<ship id>/events.jsonl`. A container session runs tmux inside its container.

## Configure

`~/.aeolus/trierarch/config.json` (or the file `--config` or `AEOLUS_TRIERARCH_CONFIG` names):

```json
{
  "$schema": "./config.schema.json",
  "caps": { "ships": 4, "running": 2 },
  "repositories": { "aeolus-fleet": { "path": "/path/to/aeolus-fleet" } },
  "folders": { "notes": { "path": "/path/to/notes" } },
  "harnesses": {
    "claude-code": {
      "flags": ["--dangerously-skip-permissions"],
      "options": {
        "effort": { "values": { "high": ["--effort", "high"], "max": ["--effort", "max"] }, "default": "high" }
      }
    },
    "codex": {
      "flags": ["--dangerously-bypass-approvals-and-sandbox"],
      "options": {
      }
    }
  }
}
```

- **runtime** (optional): where the sessions run, on the host when left out, or each in a container of its own: `{ "kind": "container", "binary": "podman", "memory": "4g", "cpus": 2 }`, with the model token in `~/.aeolus/trierarch/model-token`. What a container holds and what `config check` refuses with it: [docs/trierarch.md](../../docs/trierarch.md#session-runtime).
- **caps**: how many ships it takes (the trierarch plugin assigns it no more), and how many sessions run at once.
- **repositories**: by name. A crew request for a worktree of one gets a git worktree under `~/.aeolus/trierarch/worktrees/<repository>/<ship>`, detached at the settings' ref or the repository's HEAD. It fetches the repository first, and a ref `origin` has a branch for checks out that remote branch (`origin/<ref>`), so a ship starts from current code; when the fetch fails it uses what the repository has. `worktreeRoot` moves that root. A repository may name other configured repositories as its `checkouts`: a session in it gets each read-only, at the latest main, beside its folder, and can refresh them ([docs/trierarch.md](../../docs/trierarch.md#read-only-checkouts)).
- **folders**: by name, used as they are, one ship per folder, never removed.
- **harnesses**: `claude-code`, `codex` or both: the flags every launch gets, and named options. A crew request's settings pick option values by name; they never add a flag or carry a path. There is no policy on which flags: put `--dangerously-skip-permissions` in `flags` if you want it. The trierarch never adds a flag by itself. `--remote-control` is refused on every runtime; `aeolus-trierarch upgrade` takes it out of a configuration that has it. Claude Code's `--permission-mode plan`, in `flags` or an option, is ignored: a crewed session runs without plan mode's tools, so it could never leave plan mode (#465); `config check` shows the command without it. For the same reason, when Claude Code's settings make `plan` the default mode and the flags name no permission mode, a launch adds `--permission-mode manual`, or `default` where the detected Claude Code's `--help` lists no `manual` mode (#505, #507, #517). It reads `permissions.defaultMode` where Claude Code does, the first that names one winning: the managed settings files (`managed-settings.json`, then `managed-settings.d/*.json`, in `/Library/Application Support/ClaudeCode` or `/etc/claude-code`), `--settings` in the flags (JSON, or a file, relative to the folder), then of the sources `--setting-sources` loads (none with `--restricted`) the folder's `.claude/settings.local.json`, its `.claude/settings.json` and the user's `settings.json` (in `CLAUDE_CONFIG_DIR` when set, else `~/.claude`). A plan default mode from server-managed settings or a macOS configuration profile is not overridden: those are an admin's deliberate policy, and are not read. `config check` shows the override as the launch adds it, and where the folder's settings decide, with when it applies.

- **prices** (optional): the price per model, in US dollars per million tokens of each kind, that the cost of a ship's tokens is estimated by in its report: `{ "claude-opus-5-5": { "input": 4, "output": 20, "cacheRead": 0.2, "cacheWrite": 8 } }`. It replaces a model's list price, which the trierarch carries for the current Claude and OpenAI models, or prices one it does not carry ([docs/trierarch.md](../../docs/trierarch.md#what-a-trierarch-reports)).

`aeolus-trierarch init` writes caps, repositories, folders, and Claude Code's and Codex's flags, and detects each harness's models and effort levels into `detected.json` ([docs/trierarch.md](../../docs/trierarch.md#detected-options)). Options you write here replace the detected option of the same name whole, except `model`: model ids come from detection only, and a `model` here is ignored (#382). The example above narrows Claude Code's effort to two levels with a default, and takes the detected models as they are. Edit the file for options and `worktreeRoot`, then `aeolus-trierarch config check` and `aeolus-trierarch restart`.

The trierarch finds the aeolus-fleet plugin in each offered harness's plugin cache (the newest version, looked up again at each use, so a plugin upgrade needs no service restart): Claude Code's under `~/.claude/plugins` (or `$CLAUDE_CONFIG_DIR/plugins`), Codex's under `~/.codex/plugins` (or `$CODEX_HOME/plugins`). Claude Code's settings and `.claude.json` follow `CLAUDE_CONFIG_DIR` the same way, as Claude Code's own do, and Codex's `config.toml` follows `CODEX_HOME`; init's summary names the files it wrote. Set `AEOLUS_PLUGIN_ROOT` and `AEOLUS_PLUGIN_DATA` (Claude Code), or `AEOLUS_CODEX_PLUGIN_ROOT` and `AEOLUS_CODEX_PLUGIN_DATA` (Codex), to point it elsewhere. `aeolus-trierarch install` carries these, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `AEOLUS_TRIERARCH_CONFIG` and `PATH` into the service as they are set where it runs.

## What is here

- **Core** (`src/core`), with no framework, adapter or clock of its own:
  - its entries, one per ship it crews, and the settings it rechecks before crewing;
  - a pure Reconciler, carried out by the run pass;
  - the restart policy: 5 s, 30 s, 2 min, then 10 min, with a budget of 5 restarts an hour;
  - the ports.
- **Adapters** (`src/adapters`):
  - the fleet over REST;
  - the hold (`aeolus-trierarch hold <ship id>`), one per host session, which runs the harness, keeps its input and output and writes its events to `~/.aeolus/trierarch/sessions/<ship id>/events.jsonl`; tmux, which a container session runs inside and which lists and stops the sessions an older trierarch left in tmux;
  - git worktrees and folders;
  - Claude Code and Codex, through the aeolus-fleet plugin's `aeolus-identity.sh`. Each passes its prompt last, after `--`, so a prompt never reads as a flag. A Claude Code session on the host is `claude -p` with streamed JSON, handed each line on its stdin. A Codex session on the host is one `codex exec --json ... -- <prompt>` per turn: it starts with the first prompt, comes back with `codex exec resume --last`, and takes each later line as `codex exec resume <thread id>`;
  - the JSON state store.
- **The command** (`src/cli`): `init`, `status`, `list`, `logs`, `config check`, `detect`, `hold`, `start`, `stop`, `restart`, `install`, `uninstall`, `run`.
- **Adapters for the setup**: the service (launchd or systemd), Claude Code's own files and Codex's app server for their one-time questions.
