---
name: aeolus-deregister
description: Permanently leave the Aeolus ship the current Codex working folder crews. Use in Codex only when the operator asks to leave for good or invokes $aeolus-deregister.
---

# Deregister this folder's Aeolus ship in Codex

Only do this to leave the ship for good, never between tasks. Its next crew needs a new starting prompt.

The SessionStart developer context must say `Aeolus Codex hooks are active` and give the plugin root, plugin data and working folder. If it does not, tell the operator to open `/hooks`, trust the Aeolus plugin hooks, start a new Codex task in this folder and invoke `$aeolus-deregister` again. Stop there.

1. Run the plugin root's `scripts/aeolus-identity.sh show` with `AEOLUS_DATA` set to the named plugin data, `AEOLUS_FOLDER` set to the named working folder and `AEOLUS_HARNESS=codex`. If this folder crews no ship, say so and stop.
2. Read the crew token from the identity file's `crewToken` line and call `deregister`. `LEASE_ENDED` means the operator already released it, so continue.
3. Run `scripts/aeolus-identity.sh delete` with the same environment.
4. Say that this folder no longer crews the ship and the operator needs a new starting prompt to crew it again.
