# Computer setup: built terminal output

The trierarch's part of the [approved computer setup design](https://github.com/ThomasHendrickx/aeolus-fleet/blob/main/docs/design/computer-setup/README.md) (aeolus-fleet#1243): the wizard of `aeolus-trierarch init`, its four parts, `?` help at every question, the setup line's `--folder <name> <path>` (repeated), `--no-folders` and `--service yes|no` beside `--max-ships` and `--max-running`, and the stops that say the cause, the result and the next action. The approved screens are [after.md](https://github.com/ThomasHendrickx/aeolus-fleet/blob/main/docs/design/computer-setup/after.md); the captures below are the built binary's.

## How these were captured

`go build ./cmd/aeolus-trierarch`, then run on a pseudo-terminal that types each answer once its question waits, with `HOME` a throwaway folder holding `~/code/web` (a git repository), and stand-ins for `claude` and `codex` on `PATH` that answer installed and signed in. The fleet values are fabricated (`--secret FIXTURE_ONLY`). Every capture stops before registration, so no fleet, plugin or service was touched on the shared computer.

The screens past the service consent (plugin installation, joining, saving, starting the service, Ready, and the plugin, registration and service stops) need a fleet and a service. They are not run on the shared computer: `go/internal/cli/setupwizard_test.go` checks each against the approved copy, character for character, with in-memory fakes for the fleet, the plugins and the service.

## A1 to A3 and the declined service, fresh computer

The approved example's answers, then No at the service.

```text
Join this computer to your fleet

The trierarch runs agent sessions on this computer. Each session crews
one ship: an agent you can send work to through the fleet.
Sessions use the tools, files and permissions you allow here.

Setup has four parts:
  1. Agent tools and permissions
  2. Repositories and folders
  3. Ship and session limits
  4. Service and connection

Enter accepts the shown default. Type ? for help at a setup question.
Ctrl+C stops setup. Installed files may remain; see the closing status.

Part 1 of 4: Agent tools and permissions
An agent tool (a harness) runs the sessions. Pick at least one.
Claude Code: installed, signed in.
Use Claude Code? [y/N] y
Codex: installed, signed in.
Use Codex? [y/N] y
Copilot: not installed.
Use Copilot? [y/N] n

Claude Code normally uses its own permission controls.
Yes lets its sessions run tools without permission questions, with
this computer user's access. It also accepts Claude Code's bypass
warning for this user. Other Claude Code runs may see that acceptance.
No keeps normal permission controls; work may be refused or wait.
Run Claude Code without permission questions? [y/N] n

Codex normally uses its own approvals and sandbox.
Yes bypasses both for sessions started by this trierarch, with this
computer user's access. No keeps normal controls; work may be refused
or wait.
Run Codex without permission questions? [y/N] n

Part 2 of 4: Repositories and folders
For a repository, each ship gets its own git worktree.
A folder used as it is is shared: a session can change its existing files.
These choices select workspaces; they do not sandbox a session's access.

Add repositories from:
  1. Local repository paths or git URLs
  2. A folder containing git repositories (direct children only)
  3. Skip adding repositories
Choose [3]: 1
Git URLs are cloned to ~/repositories unless --clone-into sets another
folder. Local repositories stay where they are.
Local paths or git URLs (comma or semicolon separated): ~/code/web
Added repository web: ~/code/web

Add a folder used as it is? [y/N] ?
A session uses the folder directly, without making a git worktree.
Other sessions or people using it see changes to the same files.
Choose No if you only want the repositories above. Default: No.
Add a folder used as it is? [y/N] n

Part 3 of 4: Ship and session limits
The ship limit is how many ships this trierarch may keep on its list,
including ships whose sessions are not running. Fresh default: 4.
How many ships may it keep on its list? [4] 4

The session limit is how many sessions may run at the same time.
Other ships wait for a place. Fresh default: 2.
How many sessions may run at once? [2] 2

Part 4 of 4: Service and connection
The service runs the trierarch in the background and starts it again
at login. It can start sessions when the fleet assigns work here.
Yes installs and starts it. No stops before joining this computer;
this run will not register it or install or start its service.
Downloaded files and cloned repositories may remain.
Install and start the service? [Y/n] n
Stopped before joining: no registration or service change by this run.
Downloaded files and cloned repositories may remain.
Run your setup line again when you want to continue.
```

The approved A1 to A3 match this line for line. Its last lines are the approved A6 declined stop.

## A5: help and invalid input do not advance

```text
Part 3 of 4: Ship and session limits
The ship limit is how many ships this trierarch may keep on its list,
including ships whose sessions are not running. Fresh default: 4.
How many ships may it keep on its list? [4] 

The session limit is how many sessions may run at the same time.
Other ships wait for a place. Fresh default: 2.
How many sessions may run at once? [2] ?
This limits sessions running at the same time on this computer.
Other ships wait for a place. Enter keeps 2.
How many sessions may run at once? [2] many
Enter a whole number greater than zero, or ? for help.
How many sessions may run at once? [2] 2
```

## A6: a harness not signed in

`claude auth status` failing:

```text
Part 1 of 4: Agent tools and permissions
An agent tool (a harness) runs the sessions. Pick at least one.
Claude Code: installed, not signed in.
Use Claude Code? [y/N] y
Codex: installed, signed in.
Use Codex? [y/N] n
Copilot: not installed.
Use Copilot? [y/N] n
Claude Code is installed but not signed in.
Run: claude auth login
Then run your setup line again.
Not joined: setup stopped before registration.
```

## A6: a path that is not a git repository

```text
Choose [3]: 1
Git URLs are cloned to ~/repositories unless --clone-into sets another
folder. Local repositories stay where they are.
Local paths or git URLs (comma or semicolon separated): ~/code
~/code is not a git repository.
Enter a local git repository path or a git URL, or ? for help.
Local paths or git URLs (comma or semicolon separated): ~/code/web
Added repository web: ~/code/web
```

## A complete setup line asks nothing

`--harnesses claude-code,codex --unattended '' --repositories '~/code/web' --folder web-notes <home>/code --max-ships 4 --max-running 2 --service no`, no terminal opened: each value is shown under its part as `From the setup line`, the secret never.

```text
Part 1 of 4: Agent tools and permissions
An agent tool (a harness) runs the sessions. Pick at least one.
From the setup line: Claude Code, Codex.
From the setup line: Claude Code: normal permission controls.
From the setup line: Codex: normal approvals and sandbox.

Part 2 of 4: Repositories and folders
For a repository, each ship gets its own git worktree.
A folder used as it is is shared: a session can change its existing files.
These choices select workspaces; they do not sandbox a session's access.
From the setup line: repository web: ~/code/web.
From the setup line: folder web-notes: ~/code.

Part 3 of 4: Ship and session limits
The ship limit is how many ships this trierarch may keep on its list,
including ships whose sessions are not running. Fresh default: 4.
From the setup line: 4.

The session limit is how many sessions may run at the same time.
Other ships wait for a place. Fresh default: 2.
From the setup line: 2.

Part 4 of 4: Service and connection
The service runs the trierarch in the background and starts it again
at login. It can start sessions when the fleet assigns work here.
Yes installs and starts it. No stops before joining this computer;
this run will not register it or install or start its service.
Downloaded files and cloned repositories may remain.
From the setup line: do not install or start the service.
Stopped before joining: no registration or service change by this run.
Downloaded files and cloned repositories may remain.
Run your setup line again when you want to continue.
```
