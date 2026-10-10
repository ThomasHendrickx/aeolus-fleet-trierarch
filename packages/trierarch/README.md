# @aeolus-fleet/trierarch

Keeps the ships whose crew requests are assigned to it crewed on the machine it runs on: it starts, restarts, wakes and stops their sessions, and writes each request's status. It crews with `crew:run`, which reaches only the ships assigned to it; it never commissions, retires or picks them. The trierarch plugin assigns them. What a trierarch does is in [docs/trierarch.md](../../docs/trierarch.md); how this package is built is in [docs/architecture.md](../../docs/architecture.md#the-trierarch). Optional, like squadrons.

## Install

On the machine that will run the sessions (macOS or Linux), with Node 26, `git`, `tmux`, and Claude Code with the aeolus plugin for Claude Code, Codex with the aeolus plugin for Codex, or both, installed. Codex must be on the `PATH` as `codex`:

```sh
npm install --global @aeolus-fleet/trierarch
```

That gives the command `aeolus-trierarch`.

1. Join the machine through the trierarch plugin (`machines.join`): it commissions the trierarch's own ship, type `trierarch` with `crew:run`, and answers its starting prompt and a setup line, `npx @aeolus-fleet/trierarch init --fleet-url <url> --ship-id <id> --secret <secret>`, shown once.
2. Set up the machine with that line, or with `init` alone, which asks for what is missing:

   ```sh
   aeolus-trierarch init
   ```

   It asks for what it needs, in a short flow:
   - the fleet URL, the ship id and the secret. The secret is not shown as you type it, so it stays out of your shell history and any transcript. It registers the ship, keeps its crew token in `~/.aeolus/trierarch/crew-token` (readable by you only) and writes the secret nowhere;
   - whether Claude Code launches with `--dangerously-skip-permissions` and with `--remote-control` (both no unless you say yes);
   - where `codex` runs or Codex is configured already: whether to offer Codex, and whether it launches with `--dangerously-bypass-approvals-and-sandbox` (no unless you say yes). Every Codex session launches with `--no-daemon` whatever the flags, so stopping it stops its work;
   - the repositories it may make worktrees of, by name and path. It trusts each one, as both Claude Code and Codex ask about a worktree's repository;
   - the folders it may crew a ship in as they are, by name and path. It trusts each one, so a session there starts with no trust question;
   - the caps: how many ships it takes, how many sessions run at once.

   It writes `~/.aeolus/trierarch/config.json`, with `config.schema.json` beside it so an editor checks it. When the configuration offers Codex, it answers Codex's one-time questions ahead too, through `codex app-server` as Codex's own dialogs do: it trusts each configured repository and folder in `~/.codex/config.toml` (a repository covers its worktrees), and trusts the aeolus plugin's hooks, without which a Codex session marks no turn and is never woken. A plugin update changes the hooks: run `aeolus-trierarch init` again after updating the aeolus plugin for Codex. When the configuration offers Claude Code, it answers Claude Code's one-time questions ahead, so a session nobody watches never waits on one, and otherwise leaves Claude Code's files alone: it trusts the worktree root in `~/.claude.json`, each configured repository and each configured folder (on every run, so a place added since is trusted too), completes Claude Code's onboarding there without asking (each launch completes it again), and, when the sessions skip permissions, offers to accept bypass permissions mode in `~/.claude/settings.json`. Then it offers to install and start the service: a launchd agent on macOS (`~/Library/LaunchAgents/dev.aeolus-fleet.trierarch.plist`), a systemd user unit on Linux (`aeolus-trierarch.service`), started at login and again whenever it stops.

   Without a terminal, pass everything as flags and take every default with `--yes`: `aeolus-trierarch init --fleet-url https://fleet.example.com --ship-id shp_... --secret aeolus_sk_v1_... --yes`. Prefer the prompt: a secret in a flag lands in your shell history.

   Run `aeolus-trierarch init` again on a machine set up already to change the configuration. It says so and never registers again; to register another ship, remove `~/.aeolus/trierarch/crew-token` first.

## Use

| Command | What it does |
| --- | --- |
| `aeolus-trierarch status` | The installed version, and the one the service runs when it differs (then it says to restart), the aeolus plugin version each configured harness uses (or that it has none), the service (running, pid, since), the fleet and the trierarch's own lease, the caps in use, the entries by state, kept worktrees and orphans |
| `aeolus-trierarch list` | The ships it crews: ship, state, harness, workspace, since, restarts |
| `aeolus-trierarch logs [--lines <n>] [--follow]` | The last lines of `~/.aeolus/trierarch/logs/trierarch.log`, where the launchd agent writes on macOS, and with `--follow` each new one. On Linux the systemd user unit writes to the journal instead: `journalctl --user -u aeolus-trierarch`. The log holds one JSON record per line: each action the loop takes for a ship (crew, launch, wake, report, release, confirm, forget, leave, stop) as `{ time, shipId, shipName, action, outcome, next }`, where `next` says what happens after a failure, or a message as `{ time, level, message }`. `logs` renders them as text, and `--json` gives the records as they are (a line that is no record as `{ line }`). `run` in a terminal writes the text |
| `aeolus-trierarch add repository <name> <path>`, `aeolus-trierarch add folder <name> <path>` | Adds a repository to make worktrees of, or a folder to crew a ship in as it is, checked as init checks it, and trusts it for every configured harness in one step: adding a place is what trusts it. Then it restarts the service so the trierarch offers it, and waits until the new process says its version (at most 30 seconds); sessions keep running. A place written into `config.json` by hand is never offered and never crewed until it is added |
| `aeolus-trierarch config check` | Checks the configuration and gives the flags each harness launches with, and each option value's flags. Then the command each harness launches on a first start and on a restart, with each flag marked `(configuration)` or `(adapter)` when the adapter adds it itself (`--no-daemon` for Codex, `--continue` on a Claude Code restart, the remote-control session name) |
| `aeolus-trierarch detect` | Detects again what each configured harness offers (its models, and effort where its CLI has a flag for it) and keeps it in `~/.aeolus/trierarch/detected.json`, then gives per harness its version, each option's values and when its models were last confirmed. Restart the trierarch so it reads them ([docs/trierarch.md](../../docs/trierarch.md#detected-options)) |
| `aeolus-trierarch start`, `stop`, `restart` | The service. `stop` returns once the trierarch has exited; a stopped one starts again at the next login. `start` and `restart` return once the new process says its version (at most 30 seconds). Restart it after you change the configuration |
| `aeolus-trierarch upgrade [version]` | Installs the given version, or the latest on npm, globally and pinned to it. Then the version it installs rewrites the service's file as its `init` does, and it stops the old process and starts the new one, waits until the new one says its version (at most 30 seconds), and shows `status`. Sessions keep running: the new process takes them over. If the install fails, the old version keeps running. Where npm's global folder is not yours to write (a system Node install), it installs nothing and says what to run instead: `sudo npm install --global @aeolus-fleet/trierarch@<version>`, then `aeolus-trierarch install` when the service is installed. It never upgrades on its own |
| `aeolus-trierarch install [--no-load]` | Installs the service; over a running one it waits for the old process to exit, then loads it again, and returns once the new process says its version (at most 30 seconds). With `--no-load` it only writes its file |
| `aeolus-trierarch uninstall` | Removes the service and stops every session. It deletes nothing else: it lists the worktrees it leaves, and keeps its own files under `~/.aeolus/trierarch/` |
| `aeolus-trierarch run` | What the service runs: keeps the ships assigned to it crewed until stopped |
| `aeolus-trierarch --version`, `-v` | The installed version |

Every command takes `--json`, so a ship can read what it says, and `--config <path>`. `status`, `list` and `logs` read what is on the machine and send no message; `status` asks the fleet `whoami` once, for the lease.

To stop the trierarch: `aeolus-trierarch stop`, or `aeolus-trierarch uninstall` to keep it from starting at login. Each session runs in tmux on the trierarch's own server: attach to one with `tmux -L aeolus-trierarch attach -t trierarch-<ship id>`.

## Configure

`~/.aeolus/trierarch/config.json` (or the file `--config` or `AEOLUS_TRIERARCH_CONFIG` names):

```json
{
  "$schema": "./config.schema.json",
  "caps": { "ships": 4, "running": 2 },
  "repositories": { "aeolus-fleet": { "path": "/Users/thomas/Projects/aeolus-fleet" } },
  "folders": { "notes": { "path": "/Users/thomas/notes" } },
  "harnesses": {
    "claude-code": {
      "flags": ["--remote-control"],
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

- **caps**: how many ships it takes (the trierarch plugin assigns it no more), and how many sessions run at once.
- **repositories**: by name. A crew request for a worktree of one gets a git worktree under `~/.aeolus/trierarch/worktrees/<repository>/<ship>`, detached at the settings' ref or the repository's HEAD. It fetches the repository first, and a ref `origin` has a branch for checks out that remote branch (`origin/<ref>`), so a ship starts from current code; when the fetch fails it uses what the repository has. `worktreeRoot` moves that root.
- **folders**: by name, used as they are, one ship per folder, never removed.
- **harnesses**: `claude-code`, `codex` or both: the flags every launch gets, and named options. A crew request's settings pick option values by name; they never add a flag or carry a path. There is no policy on which flags: put `--dangerously-skip-permissions` in `flags` if you want it. The trierarch never adds a flag by itself. With `--remote-control` and no name after it, each session is named `[<repository or folder>] <ship>`, such as `[aeolus-fleet] trial-1`, so it is easy to find among your remote-control sessions. Claude Code's `--permission-mode plan`, in `flags` or an option, is ignored: a crewed session runs without plan mode's tools, so it could never leave plan mode (#465); `config check` shows the command without it. For the same reason, when Claude Code's settings make `plan` the default mode (`permissions.defaultMode` in `~/.claude/settings.json`, or the folder's `.claude/settings.json` or `.claude/settings.local.json`) and the flags name no permission mode, a launch adds `--permission-mode default` (#505).

`aeolus-trierarch init` writes caps, repositories, folders, and Claude Code's and Codex's flags, and detects each harness's models and effort levels into `detected.json` ([docs/trierarch.md](../../docs/trierarch.md#detected-options)). Options you write here replace the detected option of the same name whole, except `model`: model ids come from detection only, and a `model` here is ignored (#382). The example above narrows Claude Code's effort to two levels with a default, and takes the detected models as they are. Edit the file for options and `worktreeRoot`, then `aeolus-trierarch config check` and `aeolus-trierarch restart`.

The trierarch finds the aeolus plugin in each offered harness's plugin cache (the newest version): Claude Code's under `~/.claude/plugins`, Codex's under `~/.codex/plugins` (or `$CODEX_HOME/plugins`). Set `AEOLUS_PLUGIN_ROOT` and `AEOLUS_PLUGIN_DATA` (Claude Code), or `AEOLUS_CODEX_PLUGIN_ROOT` and `AEOLUS_CODEX_PLUGIN_DATA` (Codex), to point it elsewhere. `aeolus-trierarch install` carries these, `CODEX_HOME`, `AEOLUS_TRIERARCH_CONFIG` and `PATH` into the service as they are set where it runs.

## What is here

- **Core** (`src/core`), with no framework, adapter or clock of its own:
  - its entries, one per ship it crews, and the settings it rechecks before crewing;
  - a pure Reconciler, carried out by the run pass;
  - the restart policy: 5 s, 30 s, 2 min, then 10 min, with a budget of 5 restarts an hour;
  - the ports.
- **Adapters** (`src/adapters`):
  - the fleet over REST;
  - tmux, on its own server (`tmux -L aeolus-trierarch`, sessions named `trierarch-<ship id>` and kept on exit). Attach to one with `tmux -L aeolus-trierarch attach -t trierarch-<ship id>`;
  - git worktrees and folders;
  - Claude Code and Codex, through the aeolus plugin's `aeolus-identity.sh`. Each passes its prompt last, after `--`, so a prompt never reads as a flag. A Codex session starts with `codex ... -- <prompt>`, always with `--no-daemon`, comes back with `codex resume --last`, and is woken by typing `$aeolus-wake`;
  - the JSON state store.
- **The command** (`src/cli`): `init`, `status`, `list`, `logs`, `config check`, `detect`, `start`, `stop`, `restart`, `install`, `uninstall`, `run`.
- **Adapters for the setup**: the service (launchd or systemd), Claude Code's own files and Codex's app server for their one-time questions.
