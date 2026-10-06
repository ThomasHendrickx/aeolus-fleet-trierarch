# @aeolus-fleet/trierarch

Keeps the ships on its wanted list crewed on the machine it runs on: it starts, restarts, wakes and stops their sessions. It crews ships with `fleet:crew`; it never commissions or retires them. What a trierarch does is in [docs/trierarch.md](../../docs/trierarch.md); how this package is built is in [docs/architecture.md](../../docs/architecture.md#the-trierarch). Optional, like squadrons.

## Install

On the machine that will run the sessions (macOS or Linux), with Node 26, `git`, `tmux`, Claude Code and the aeolus plugin for Claude Code installed:

```sh
npm install --global @aeolus-fleet/trierarch
```

1. In the console, commission the trierarch's own ship: type `trierarch`, with **Crew ships** (`fleet:crew`). Copy its ship id and secret from the starting prompt.
2. Register it and write a configuration:

   ```sh
   aeolus-trierarch init https://fleet.example.com shp_... aeolus_sk_v1_...
   ```

   This keeps the trierarch's own crew token in `~/.aeolus/trierarch/crew-token`, readable by you only, and never writes the secret. It writes `~/.aeolus/trierarch/config.json` when there is none yet, with `config.schema.json` beside it so an editor checks it.
3. Edit the configuration (below), then check it:

   ```sh
   aeolus-trierarch config check
   ```

   It prints the flags each harness launches with, and each option value's flags.
4. Keep it running:

   ```sh
   aeolus-trierarch install
   ```

   On macOS this loads a launchd agent (`~/Library/LaunchAgents/dev.aeolus-fleet.trierarch.plist`) that starts the trierarch at login and again whenever it stops. On Linux it enables a systemd user unit (`aeolus-trierarch.service`). With `--no-load` it only writes the file. Logs go to `~/.aeolus/trierarch/logs/`. To run it in the foreground instead: `aeolus-trierarch run`.

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
    }
  }
}
```

- **caps**: how many ships it keeps on its list, and how many sessions run at once.
- **repositories**: by name. A want for a worktree of one gets a git worktree under `~/.aeolus/trierarch/worktrees/<repository>/<ship>`, detached at the want's ref or the repository's HEAD. `worktreeRoot` moves that root.
- **folders**: by name, used as they are, one ship per folder, never removed.
- **harnesses**: the flags every launch gets, and named options. A want picks option values by name; it never adds a flag, and messages never carry paths or flags. There is no policy on which flags: put `--dangerously-skip-permissions` in `flags` if you want it. The trierarch never adds a flag by itself.

The trierarch finds the aeolus plugin in Claude Code's plugin cache (the newest version). Set `AEOLUS_PLUGIN_ROOT` and `AEOLUS_PLUGIN_DATA` to point it elsewhere. `aeolus-trierarch install` carries these, `AEOLUS_TRIERARCH_CONFIG` and `PATH` into the service as they are set where it runs.

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
  - Claude Code, through the aeolus plugin's `aeolus-identity.sh`;
  - the JSON state store.
- **The command** (`src/cli`): `init`, `config check`, `run`, `install`.
