# Design: a trierarch with no Node, one binary for VPSes (trierarch#95)

Status: approved by Thomas. Nothing is built.

## Purpose

Thomas, 3 Nov: "I just want an non node setup for VPS's it is including a potential attack vector. The vunrability of 2 weeks ago as example. For teams who would not use node and purely for trierarch process is allot of overkill and hard to maintain".

A machine runs a trierarch without Node or an npm dependency tree. Install is one download and `aeolus-trierarch init`.

## Lessons to check against

### What today's trierarch is

- `@aeolus-fleet/trierarch` is a Node command (`engines.node >= 26`), installed with `npm install --global`; the trierarch plugin's setup line is `npx @aeolus-fleet/trierarch init ...` (docs/trierarch.md, "A machine joins"). About 13,900 lines of TypeScript and 17,500 lines of tests.
- Its runtime dependencies are `@aeolus-fleet/common` and `zod`, which common needs too: the tree is small. What Node brings is the runtime itself, npm, the registry at every install and upgrade, and `npx` running the newest package at setup.
- It uses only Node's standard modules: `fs`, `path`, `child_process`, `net` and `http` (the socket per ship it crews, `hold.sock`, the model proxy), `https`, `readline`, `crypto`. Nothing in it needs a JavaScript engine except itself.
- It runs itself as Node: the service's `ProgramArguments` and `ExecStart` are `node <script> run`; the hold and the model proxy are started as `process.execPath` with the bin script (`runtime-adapters.ts`); the hold's guard is an inline script run with `node -e` (`hold.ts`); its version is read from its `package.json`.
- `upgrade` is built on npm: npm's latest version, `npm install --global <version>`, a global folder that is not the user's to write (the `sudo` route), and putting the old version back on failure. Its plugin step (the aeolus-fleet plugin from release tag `v<version>`, through each harness's own command) does not use npm.
- A hold of another version is replaced once its session's turn is idle (`otherVersionStep`), so the sessions of a Node trierarch can be taken over by a trierarch of any other build, as on any upgrade.
- The contract with core is `/api/v1` and `common`'s schemas: crew settings, the trierarch report details, the configuration (and `config.schema.json`, which `init` and `upgrade` write), with `MINIMUM_CORE_VERSION`. A trierarch in another language has no `common` to import: those shapes are written again or generated.
- docs/trierarch.md says "Anyone may write another: this file is what it must do". A trierarch with no Node is that other trierarch.
- The tests import the trierarch's own modules and an in-process core (`@aeolus-fleet/core/testing`). No test drives the trierarch from outside as a program, so none would carry over to another language as it is.

### What it touches outside itself

- The aeolus-fleet plugin: only through `aeolus-identity.sh` and `aeolus-push.sh` (`plugin-identity.ts`, `claude-code.ts`, `caller-check.ts`, `launch-marker.ts`). The plugin's scripts are bash and curl, with no Node; they stay as they are.
- Claude Code, Codex and Copilot: run as programs (`claude -p ...`, `codex exec --json`, `copilot`), with their files written by `init` (`.claude.json`, `settings.json`, Codex's `config.toml` through `codex app-server`). Nothing of this depends on the trierarch's language.
- git, the container runtime (Podman or Colima) and `systemd-run` and `journalctl`: run as programs.
- The service: a launchd agent on macOS (log in `~/.aeolus/trierarch/logs`, capped at 1 MiB), a systemd user unit on Linux (`KillMode=process`, the journal). Only the program line changes.
- The session image installs Node and Claude Code from npm inside the container. That is inside the container, not on the machine.

### What a harness brings

A trierarch with no Node removes Node from the machine only where its harnesses need none. Claude Code has a native installer. Codex ships native binaries beside its npm package. Copilot on the host runs a native process behind an npm launcher (architecture.md), so a machine offering Copilot keeps Node for Copilot.

### The worktree design (#84)

docs/design/worktrees-end-with-their-session.md is approved and its slices #89 to #92 are open. They change what the reconciler does on every path (a worktree removed whatever it holds, strays under the root removed, `git worktree prune`, local branches deleted). A second trierarch written while they land has to follow them twice, or start from them.

### What a binary removes from the attack surface

| Today on a VPS | With one binary |
| --- | --- |
| A Node runtime, from a distribution, NodeSource or a version manager, with its own security releases to follow | Gone (Go or Rust); inside the binary, patched only by a new release (a compiled single file of today's code) |
| npm and the registry at install, at every upgrade and at every `npx` setup line: a taken-over package, account or token reaches the machine | One file from a GitHub Release, checked against its checksum and provenance |
| Install scripts of every package in the tree | None |
| `sudo npm install --global` where npm's global folder is the system's | A file in the user's own folder |
| Transitive packages (today: common and zod) | What the binary links in, fixed at build time |

It does not remove the harnesses (and Copilot's Node), git, bash, curl, the container runtime or the trierarch's own code.

## Decisions

### The language is Go

Static binaries with no C library, cross-built for each operating system and chip; the standard library covers HTTP over Unix sockets, child processes with process groups, signals and JSON. Few or no outside modules. `common`'s schemas are written again in Go or generated from their JSON Schema. The fallback if the rewrite proves too large is a compiled single file of today's code.

### The install routes

- An install script (`curl -fsSL <url> | sh`) downloads the binary for the machine's system and chip from the GitHub Release, checks its checksum, puts it in `~/.local/bin` and runs `init`. The trierarch plugin's setup line is that script.
- The bare binary from the GitHub Release, by hand, with its checksum.
- `upgrade` fetches the release itself, checks its checksum and attestation, and replaces the file. It does not use npm.
- The npm package stays during the move, so today's machines upgrade as they do now.

### Signing on macOS

An ad hoc signature, which the Go linker writes. The install script and `curl` set no quarantine flag, so the binary runs; a binary downloaded with a browser is stopped by Gatekeeper until the user allows it.

### The CI

Each release is built and tested where it runs: `ubuntu-latest`, `ubuntu-24.04-arm`, `macos-latest` (arm64), and macOS amd64 cross-built or on an Intel runner while GitHub offers one. The launchd and systemd parts run where they live, as `trierarch-macos` does today. A release carries `SHA256SUMS` and a GitHub artifact attestation per binary, which the install script and `upgrade` check. There is no Windows build: the trierarch has no Windows service.

### The order of the move

1. A contract suite drives a trierarch as a program from outside (its CLI, its sockets, its files, an in-process core, the fake harnesses) and runs green against today's trierarch. The worktree slices (#89 to #92) land in today's trierarch first, so the suite holds them.
2. The Go trierarch is built beside the old one, part by part, against the suite: config and `init`, `run` and the reconciler with one harness, the hold, the model proxy, the other harnesses, `upgrade`.
3. Today's trierarch keeps its releases until the Go trierarch passes a walk on a VPS. Then the setup line moves to the install script and a machine moves by one upgrade, its holds taken over as another version's.

## Trains

- **Trierarch (this repository)**: the contract suite, the Go trierarch, its release and `upgrade`.
- **Trierarch plugin**: the setup line for the install script.
- **Core (aeolus-fleet)**: nothing, unless `common`'s JSON Schemas are to be published for a trierarch in another language.
