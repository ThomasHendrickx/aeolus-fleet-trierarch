# Setting up a trierarch

How to prepare a computer and run a trierarch on it, from a computer with a user to a first ship crewed. It is for an operator who owns the computer and the fleet's console and has not set up a trierarch before. It covers Linux and macOS; where they differ, each is said. What a trierarch does is in [trierarch.md](trierarch.md), which this guide links to and never repeats; how it is built is in [architecture.md](architecture.md).

The guide starts at a computer you can log in to as a user. Installing the operating system, hardening remote access and creating users are the computer's own business.

## 1. What you are setting up

A trierarch is one process per computer. It crews the ships the fleet assigns to this computer: it starts each ship's Claude Code or Codex session, restarts it when it dies, wakes it when work arrives and stops it on release. It is not an AI, and it commissions nothing.

You will end with:

- one service (a systemd user unit on Linux, a launchd agent on macOS) running as one user;
- that user's Claude Code and Codex, signed in, with the aeolus-fleet plugin;
- the repositories ships may work in, cloned on the computer and trusted;
- a configuration that lets sessions run with nobody to answer a prompt.

You need first:

- the fleet's console and the trierarch plugin, which gives you the setup line (section 4);
- a GitHub account that can read the repositories your ships work on;
- a Claude Code or Codex subscription login for each harness you offer: `init` refuses a computer where no installed harness is signed in (section 3).

Run everything as the user that will own the trierarch and its sessions. Every session runs as that user and can read what that user can, so give it a user of its own, not your daily one, and keep nothing on the computer that the sessions must not read.

## 2. Prepare the computer

Install these, as that user's tools or system-wide:

| Tool | Why |
| --- | --- |
| `git` | worktrees and clones of the repositories |
| `curl` | the install script |
| `gh` | signing in to GitHub, and checking the binary's attestation when installing |
| `tmux` | a place for sign-in commands to run while you approve them elsewhere |
| `ss` on Linux (package `iproute2`) | a minimal server image may lack it, and without it no session starts |

On Linux, the service is a systemd user service, which stops when the user logs out. Let it run without a login, once:

```sh
sudo loginctl enable-linger "$USER"
```

Decide where ships' folders go. By default they are under `~/.aeolus/trierarch/ships/`. Each ship has a Unix socket in its folder, and a socket path is limited to 104 bytes on macOS and 108 on Linux. The default stays within it for a home folder of up to about 30 characters. With a longer one, or to put ships on a bigger disk, set `shipsRoot` in the configuration (section 6); `config check` refuses a place where a socket path would be too long, and says the path, its length and the limit.

You end with a user for whom `git --version`, `gh --version` and `tmux -V` work, and on Linux, `loginctl show-user "$USER" --property=Linger` says `Linger=yes`.

## 3. Install and sign in the harnesses

Offer Claude Code, Codex or both. For each one you offer:

1. Install the harness by its vendor's instructions, with `codex` on the `PATH` as `codex`.
2. Sign it in as the trierarch's user. Without a login, a session ends its first turn with the harness's `Not logged in` error.
3. Install the aeolus-fleet plugin for it. The plugin is how a session crews its ship; [its README](../plugins/aeolus-fleet/README.md) is the full install, including a one-time Codex sandbox setting. In short:

   ```sh
   claude plugin marketplace add ThomasHendrickx/aeolus-fleet-trierarch
   claude plugin install aeolus-fleet@aeolus-fleet

   codex plugin marketplace add ThomasHendrickx/aeolus-fleet-trierarch
   codex plugin add aeolus-fleet@aeolus-fleet
   ```

   From here on, update the plugin only with `aeolus-trierarch upgrade` (section 8), never with the harness's own update.

Sign in to GitHub so the computer can clone and fetch the repositories:

```sh
gh auth login --hostname github.com --git-protocol https
gh auth setup-git
```

A computer with no browser prints a link and a code to approve on another device. Run the sign-in inside `tmux` so it survives your connection dropping while you approve it.

`init` (section 4) runs `claude auth status` and `codex login status` and needs at least one installed harness to answer as signed in, so sign in with the harness's own login first. A session can then run on that login or on an API key; an API key is added after the install, with `aeolus-trierarch login` (section 6), and does not replace the sign-in `init` needs.

You end with each harness answering a prompt as the trierarch's user, and `gh auth status` showing a login.

## 4. Install the trierarch and join the fleet

A trierarch never registers itself. In the console, ask the trierarch plugin for a new machine and name it. The plugin commissions the trierarch's own ship and shows, once, a setup line:

```sh
curl -fsSL https://raw.githubusercontent.com/ThomasHendrickx/aeolus-fleet-trierarch/main/install.sh | sh -s -- --fleet-url <url> --ship-id <id> --plugin-ship-id <ship> --secret <secret>
```

The line carries the flags `init` needs: `--fleet-url`, `--ship-id` and `--secret` are all required, and `--plugin-ship-id` is what lets the trierarch take the fleet's trusted repositories (section 5). `init` prompts for none of them. Run the line on the computer, as the trierarch's user. It:

1. takes the binary for the computer's system and chip from the GitHub Release, checks it against the release's checksums and, when `gh` is installed, its attestation, and puts it in `~/.local/bin`;
2. runs `aeolus-trierarch init`, which registers the ship, writes the configuration, answers the harnesses' one-time questions ahead of time, and installs and starts the service.

`init` writes the secret nowhere: it keeps the ship's crew token in a file only the user reads. The secret is still on the setup line, so it is in your shell history; the setup line is the only route that carries it. Put `~/.local/bin` on the `PATH`. The other routes (a bare binary checked by hand, Homebrew) are in [trierarch.md](trierarch.md#a-machine-joins).

`init` asks nothing else. When there is no configuration it writes one with the defaults: `caps` of 4 ships and 2 running, Claude Code with no flags, Codex too with no flags where it is installed, and no repository or folder. Section 5 adds the places and section 6 sets the flags and caps. Run with no flags, `aeolus-trierarch init` again goes on with a setup that did not finish and keeps the configuration as it is; it never registers a second time.

Check it:

```sh
aeolus-trierarch status
```

You end with the service running, the fleet and the trierarch's own lease shown, and the machine in the console with its labels.

## 5. Choose where ships may work

A ship works in a ship folder of its own. The trierarch builds it from the crew request, which names a main repository and any sub-repositories:

```
~/.aeolus/trierarch/ships/<shipId>/
  repositories/               the ship folder: the session starts here
    AGENTS.md                 written by the trierarch at every start
    CLAUDE.md -> AGENTS.md
    .claude/skills/<skill>    one link per skill, to a repository's own
    .agents/skills/<skill>    the same for Codex
    main/                     the main repository
    sub-repos/<repository>/   each sub-repository
  home/  tmp/  containers/  podman.sock  fleet.sock
```

Every repository is a working one, with its own branch and its own origin, and no repository sits inside another. The root `AGENTS.md` and `CLAUDE.md` are the trierarch's, written again at every start: they send the session to `main/` and name each sub-repository. No secret is ever in a ship's folder. The design is in [design/ship-folder.md](design/ship-folder.md).

A crew request is placed only on a computer that offers every repository it names, so add every repository your ships will need. For each:

```sh
git clone https://github.com/<owner>/<repository>.git ~/Projects/<repository>
aeolus-trierarch add repository <repository> ~/Projects/<repository>
```

`add` checks the place, trusts it for every configured harness, so a session there never stops at a trust question, restarts the service so it is offered, and keeps sessions running. A place written into `config.json` by hand is never offered until it is added this way. `aeolus-trierarch add folder <name> <path>` adds a folder a ship works in as it is, one ship per folder.

Repositories the fleet marks as trusted are cloned on demand under `~/.aeolus/trierarch/repositories/`, with this computer's own access, so those need no `add`. The rule is in [trierarch.md](trierarch.md#trusted-repositories).

Check what is offered with `aeolus-trierarch status`, which lists the configured repositories.

You end with the repositories a crew request can name, cloned, trusted and offered, and a picture of what a ship folder holds.

## 6. Make sessions run unattended

Nobody watches a session. Anything the harness asks before its first prompt stops it, so the configuration must answer those questions ahead of time. `init` answers the harness's one-time questions (Claude Code's onboarding and trust for each place, Codex's trust and hook review). The rest is the configuration in `~/.aeolus/trierarch/config.json`, which `init` wrote with no flags: add the flags and set the caps there. A harness's entry reads:

```json
{
  "caps": { "ships": 8, "running": 8 },
  "harnesses": {
    "claude-code": { "flags": ["--dangerously-skip-permissions"] },
    "codex": { "flags": ["--dangerously-bypass-approvals-and-sandbox"] }
  }
}
```

The advised defaults, and the risk of each:

- **`--dangerously-skip-permissions` (Claude Code) and `--dangerously-bypass-approvals-and-sandbox` (Codex).** Without them, a session stops at the first tool it needs to ask about, and nobody answers. With them, a session can run any command as the trierarch's user, so everything that user can read, it can. This is why section 1 says to give the trierarch a user of its own. `init` adds neither flag: putting them in `config.json` is your consent.
- **`caps.ships`** is how many ships the computer takes, **`caps.running`** how many sessions run at once. A session uses memory, CPU and model usage. Set them to what the computer carries, and keep `running` at or below `ships`.
- **`--remote-control` is refused**, on every runtime. `config check` says so.

After editing, check and restart:

```sh
aeolus-trierarch config check
aeolus-trierarch restart
```

`config check` gives the flags each harness launches with and refuses a configuration the trierarch could not run. A restart ends only the trierarch, never the sessions: each runs under a hold of its own, and the new process takes them over. On Linux this relies on the unit's `KillMode=process`, which `aeolus-trierarch install` writes.

Each session runs on a login, a subscription or an API key. To give a harness an API key, from stdin so it is never in your shell history or a process list:

```sh
aeolus-trierarch login claude-code --api-key
aeolus-trierarch login claude-code --default api-key
aeolus-trierarch login
```

The key stays on the computer, in a file only the user reads; it is never in the configuration, a log, a session or the fleet. `login` alone shows each harness's default login and whether it holds a key. More in [trierarch.md](trierarch.md#api-keys).

### Sessions in containers

By default a session runs on the computer as the trierarch's user. A computer can run each session in a container of its own instead, with its own home and only its ship folder mounted, so a session reaches nothing else of the computer. Containers need a rootless runtime: Podman on Linux, Colima on macOS. A user in the `docker` group is never used.

1. Install the runtime. On Linux, Podman with `passt`, the network that gives a container the model proxy's port and nothing else of the host. On macOS, Colima and the Docker command-line client, which the trierarch calls as `docker`:

   ```sh
   brew install colima docker
   colima start
   docker context use colima
   docker info
   ```

   `docker info` must answer. The trierarch asks the runtime with `docker info` and refuses one that does not answer or runs rootful, so `config check` (step 5) is the judge of your Colima.
2. On Linux, point the user's tools at Podman's socket. On macOS skip this step: the Colima context is the pointer.

   ```sh
   systemctl --user enable --now podman.socket
   export DOCKER_HOST=unix:///run/user/$(id -u)/podman/podman.sock
   ```

   Put the `export` in `~/.profile`, and in `~/.config/environment.d/60-podman.conf` as `DOCKER_HOST=unix:///run/user/<uid>/podman/podman.sock` with the number in place of `<uid>`, so the service and its sessions see it too, from the next start of the user's service manager.
3. Create the computer's long-lived model token with `claude setup-token` and keep it in `~/.aeolus/trierarch/model-token`, mode 600. It is never in `config.json`.
4. Set the runtime in `config.json`, `"binary": "podman"` on Linux and `"binary": "docker"` on macOS:

   ```json
   { "runtime": { "kind": "container", "binary": "podman", "memory": "4g", "cpus": 2 } }
   ```

5. `aeolus-trierarch config check`, which gives every reason at once if the runtime runs rootful or does not answer, the user is in the `docker` group, a harness other than Claude Code is offered, or the token file is missing or empty. Then `aeolus-trierarch restart`.

Containers offer Claude Code only for now. What a container holds and sees is in [trierarch.md](trierarch.md#session-runtime).

You end with `config check` passing and a configuration that fits a computer nobody sits at.

## 7. Crew a first ship

In the console, make a crew request: choose a repository this computer offers as the main repository, any sub-repositories, the harness and the model, and submit it. The trierarch plugin places it on a computer that offers all of it, this one among them, and the trierarch crews it.

Watch it on the computer:

```sh
aeolus-trierarch list
aeolus-trierarch status
aeolus-trierarch logs --follow
```

`list` shows the ship, its state, harness, workspace and restarts. `logs` renders the action the trierarch takes for each ship, with what happens next after a failure. Once the ship is working, its ship folder is on disk, and what the session writes is in `~/.aeolus/trierarch/sessions/<shipId>/events.jsonl`.

You end with a ship answering over the fleet, and its ship folder under `~/.aeolus/trierarch/ships/`.

## 8. Keep it running

| To | Run |
| --- | --- |
| see how the trierarch stands | `aeolus-trierarch status` |
| read the log | `aeolus-trierarch logs [--lines <n>] [--follow]` (on Linux the journal, on macOS `~/.aeolus/trierarch/logs/trierarch.log`) |
| move to a newer release | `aeolus-trierarch upgrade [version]`, when no session is mid-turn |
| detect what a harness offers again | `aeolus-trierarch detect`, then `aeolus-trierarch restart` |
| restart after changing the configuration | `aeolus-trierarch restart` |
| stop it, sessions keep running | `aeolus-trierarch stop` |

`upgrade` takes the release's binary only once its checksum and attestation hold, restarts the service on it, keeps sessions running, and updates the aeolus-fleet plugin for each harness. It is the only supported way to update the plugin. It never runs by itself.

A ship's folder is removed by the trierarch when its crew ends here. To clear every ship's files at once, remove `~/.aeolus/trierarch/ships`: the trierarch crews the ships again from their requests, in fresh folders. What a folder removed by hand costs a ship is in [trierarch.md](trierarch.md#the-ships-folder).

To take a computer out of the fleet, release the trierarch's ship in the console, which is the kill switch for that computer, then:

```sh
aeolus-trierarch uninstall
```

It removes the service and stops every session, and deletes nothing else. Removing `~/.aeolus/trierarch` after that removes everything the trierarch made, its configuration, keys and crew token with it.

## 9. When it does not work

| Symptom | Look | Fix |
| --- | --- | --- |
| The service does not start | `aeolus-trierarch status`, `aeolus-trierarch logs` | `aeolus-trierarch config check` names the line; fix it and `aeolus-trierarch restart` |
| It stops when you log out (Linux) | `loginctl show-user "$USER" --property=Linger` | `sudo loginctl enable-linger "$USER"` |
| No session starts on Linux | `which ss` | install `iproute2` |
| A session ends its first turn with `Not logged in` | the launch window in `aeolus-trierarch logs` | sign the harness in as the trierarch's user, then `aeolus-trierarch restart` |
| A session stops at a trust question or a first-run screen | `aeolus-trierarch config check` | add the place with `aeolus-trierarch add`, or run `aeolus-trierarch init` again to answer the one-time questions |
| A crew request stays unplaced | the console's reason | the repository is not offered here: `aeolus-trierarch add repository`, or the computer lacks the harness or model |
| `config check` refuses `shipsRoot` | its message | choose a shorter path: a socket path may not pass 104 bytes on macOS or 108 on Linux |
| A key is refused or out of credit | `aeolus-trierarch login`, `aeolus-trierarch login <harness> --check` | `aeolus-trierarch login <harness> --api-key` with a good key, or `--default subscription` |
| Containers do not start | `aeolus-trierarch config check` | it gives every reason: a rootful runtime, `DOCKER_HOST` not seen by the service, a missing model token |
| A ship is not crewed after you removed its folder | `aeolus-trierarch list` | none: it is crewed again in a fresh folder under its lease |

If none of this fits, `aeolus-trierarch logs` has one record per action, and [trierarch.md](trierarch.md#crashed-and-restart) says what a crashed session costs.
