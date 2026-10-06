# @aeolus-fleet/trierarch

Keeps the ships on its wanted list crewed on the machine it runs on: it starts, restarts, wakes and stops their sessions. It crews ships with `fleet:crew`; it never commissions or retires them. What a trierarch does is in [docs/trierarch.md](../../docs/trierarch.md); how this package is built is in [docs/architecture.md](../../docs/architecture.md#the-trierarch). Optional, like squadrons.

## Install

On the machine that will run the sessions (macOS or Linux), with Node 26, `git`, `tmux`, and Claude Code with the aeolus plugin for Claude Code, Codex with the aeolus plugin for Codex, or both, installed. Codex must be on the `PATH` as `codex`:

```sh
npm install --global @aeolus-fleet/trierarch
```

That gives the command `aeolus-trierarch`.

1. In the console, commission the trierarch's own ship: type `trierarch`, with **Crew ships** (`fleet:crew`). Keep its starting prompt open: it shows the ship id and the secret.
2. Set up the machine:

   ```sh
   aeolus-trierarch init
   ```

   It asks for what it needs, in a short flow:
   - the fleet URL, the ship id and the secret. The secret is not shown as you type it, so it stays out of your shell history and any transcript. It registers the ship, keeps its crew token in `~/.aeolus/trierarch/crew-token` (readable by you only) and writes the secret nowhere;
   - whether Claude Code launches with `--dangerously-skip-permissions` and with `--remote-control` (both no unless you say yes);
   - where `codex` runs or Codex is configured already: whether to offer Codex, and whether it launches with `--dangerously-bypass-approvals-and-sandbox` (no unless you say yes). Every Codex session launches with `--no-daemon` whatever the flags, so stopping it stops its work;
   - the repositories it may make worktrees of, by name and path;
   - the caps: how many ships on its list, how many sessions at once.

   It writes `~/.aeolus/trierarch/config.json`, with `config.schema.json` beside it so an editor checks it. When the configuration offers Codex, it answers Codex's one-time questions ahead too, through `codex app-server` as Codex's own dialogs do: it trusts each configured repository and folder in `~/.codex/config.toml` (a repository covers its worktrees), and trusts the aeolus plugin's hooks, without which a Codex session marks no turn and is never woken. A plugin update changes the hooks: run `aeolus-trierarch init` again after updating the aeolus plugin for Codex. It answers Claude Code's one-time questions ahead, so a session nobody watches never waits on one: it trusts the worktree root in `~/.claude.json`, which covers every worktree under it, and each configured folder (on every run, so a folder added since is trusted too), and, when the sessions skip permissions, offers to accept bypass permissions mode in `~/.claude/settings.json`. Then it offers to install and start the service: a launchd agent on macOS (`~/Library/LaunchAgents/dev.aeolus-fleet.trierarch.plist`), a systemd user unit on Linux (`aeolus-trierarch.service`), started at login and again whenever it stops.

   Without a terminal, pass everything as flags and take every default with `--yes`: `aeolus-trierarch init --fleet-url https://fleet.example.com --ship-id shp_... --secret aeolus_sk_v1_... --yes`. Prefer the prompt: a secret in a flag lands in your shell history.

   Run `aeolus-trierarch init` again on a machine set up already to change the configuration. It says so and never registers again; to register another ship, remove `~/.aeolus/trierarch/crew-token` first.

## Use

| Command | What it does |
| --- | --- |
| `aeolus-trierarch status` | The installed version, and the one the service runs when it differs (then it says to restart), the service (running, pid, since), the fleet and the trierarch's own lease, the caps in use, the entries by state, kept worktrees and orphans |
| `aeolus-trierarch list` | The wanted entries: ship, state, harness, workspace, since, restarts |
| `aeolus-trierarch logs [--lines <n>] [--follow]` | The last lines of `~/.aeolus/trierarch/logs/trierarch.log`, and with `--follow` each new one. The log holds one JSON record per line: each action the loop takes for a ship (crew, launch, wake, report, release, drop, stop) as `{ time, shipId, shipName, action, outcome, next }`, where `next` says what happens after a failure, or a message as `{ time, level, message }`. `logs` renders them as text, and `--json` gives the records as they are (a line that is no record as `{ line }`). `run` in a terminal writes the text |
| `aeolus-trierarch config check` | Checks the configuration and gives the flags each harness launches with, and each option value's flags. Then the command each harness launches on a first start and on a restart, with each flag marked `(configuration)` or `(adapter)` when the adapter adds it itself (`--no-daemon` for Codex, `--continue` on a Claude Code restart, the remote-control session name) |
| `aeolus-trierarch start`, `stop`, `restart` | The service. `stop` returns once the trierarch has exited; a stopped one starts again at the next login. Restart it after you change the configuration |
| `aeolus-trierarch upgrade [version]` | Installs the given version, or the latest on npm, globally and pinned to it. Then it stops the old process and starts the new one, and shows `status`. Sessions keep running: the new process takes them over. If the install fails, the old version keeps running. It never upgrades on its own |
| `aeolus-trierarch install [--no-load]` | Installs the service; over a running one it waits for the old process to exit, then loads it again. With `--no-load` it only writes its file |
| `aeolus-trierarch uninstall` | Removes the service and stops every session. It deletes nothing else: it lists the worktrees it leaves, and keeps its own files under `~/.aeolus/trierarch/` |
| `aeolus-trierarch run` | What the service runs: keeps the wanted ships crewed until stopped |
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
        "model": { "values": { "opus": ["--model", "claude-opus-5-5"], "sonnet": ["--model", "claude-sonnet-5-5"] }, "default": "opus" }
      }
    },
    "codex": {
      "flags": ["--dangerously-bypass-approvals-and-sandbox"],
      "options": {
        "model": { "values": { "sol": ["-m", "gpt-5.6-sol"] }, "default": "sol" }
      }
    }
  }
}
```

- **caps**: how many ships it keeps on its list, and how many sessions run at once.
- **repositories**: by name. A want for a worktree of one gets a git worktree under `~/.aeolus/trierarch/worktrees/<repository>/<ship>`, detached at the want's ref or the repository's HEAD. It fetches the repository first, and a ref `origin` has a branch for checks out that remote branch (`origin/<ref>`), so a ship starts from current code; when the fetch fails it uses what the repository has. `worktreeRoot` moves that root.
- **folders**: by name, used as they are, one ship per folder, never removed.
- **harnesses**: `claude-code`, `codex` or both: the flags every launch gets, and named options. A want picks option values by name; it never adds a flag, and messages never carry paths or flags. There is no policy on which flags: put `--dangerously-skip-permissions` in `flags` if you want it. The trierarch never adds a flag by itself. With `--remote-control` and no name after it, each session is named `[<repository or folder>] <ship>`, such as `[aeolus-fleet] trial-1`, so it is easy to find among your remote-control sessions.

`aeolus-trierarch init` writes caps, repositories, and Claude Code's and Codex's flags; edit the file for folders, options and `worktreeRoot`, then `aeolus-trierarch config check` and `aeolus-trierarch restart`.

The trierarch finds the aeolus plugin in each offered harness's plugin cache (the newest version): Claude Code's under `~/.claude/plugins`, Codex's under `~/.codex/plugins` (or `$CODEX_HOME/plugins`). Set `AEOLUS_PLUGIN_ROOT` and `AEOLUS_PLUGIN_DATA` (Claude Code), or `AEOLUS_CODEX_PLUGIN_ROOT` and `AEOLUS_CODEX_PLUGIN_DATA` (Codex), to point it elsewhere. `aeolus-trierarch install` carries these, `CODEX_HOME`, `AEOLUS_TRIERARCH_CONFIG` and `PATH` into the service as they are set where it runs.

## What is here

- **Core** (`src/core`), with no framework, adapter or clock of its own:
  - the wanted list;
  - a pure Reconciler, carried out by the run pass;
  - the restart policy: 5 s, 30 s, 2 min, then 10 min, with a budget of 5 restarts an hour;
  - the ports.
- **Adapters** (`src/adapters`):
  - the fleet over REST;
  - tmux, on its own server (`tmux -L aeolus-trierarch`, sessions named `trierarch-<ship id>` and kept on exit). Attach to one with `tmux -L aeolus-trierarch attach -t trierarch-<ship id>`;
  - git worktrees and folders;
  - Claude Code and Codex, through the aeolus plugin's `aeolus-identity.sh`. A Codex session starts with `codex <prompt>`, always with `--no-daemon`, comes back with `codex resume --last`, and is woken by typing `$aeolus-wake`;
  - the JSON state store.
- **The command** (`src/cli`): `init`, `status`, `list`, `logs`, `config check`, `start`, `stop`, `restart`, `install`, `uninstall`, `run`.
- **Adapters for the setup**: the service (launchd or systemd), Claude Code's own files and Codex's app server for their one-time questions.
