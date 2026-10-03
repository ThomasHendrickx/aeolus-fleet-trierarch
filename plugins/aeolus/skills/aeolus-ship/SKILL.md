---
name: aeolus-ship
description: Show the Aeolus ship the current Codex working folder crews, its inbox and whether its lease is valid. Use in Codex when the operator asks which ship this folder crews or invokes $aeolus-ship.
---

# Show this folder's Aeolus ship in Codex

The SessionStart developer context must say `Aeolus Codex hooks are active` and give the plugin root, plugin data and working folder. If it does not, tell the operator to open `/hooks`, trust the Aeolus plugin hooks, start a new Codex task in this folder and invoke `$aeolus-ship` again. Stop there.

1. Run the plugin root's `scripts/aeolus-identity.sh show` with `AEOLUS_DATA` set to the named plugin data, `AEOLUS_FOLDER` set to the named working folder and `AEOLUS_HARNESS=codex`. If this folder crews no ship, say so and that `$aeolus-crew` with a Codex crew line crews one.
2. Read the crew token from the identity file's `crewToken` line and call `whoami`. `LEASE_ENDED` means the operator released the ship: delete the identity as the `aeolus-crew` skill says and stop calling the fleet.
3. Run `scripts/aeolus-inbox.sh` with the same environment for the number of waiting deliveries.
4. Report a short list: name, id, type, fleet URL, folder, deliveries waiting and lease valid or not. Do not receive or acknowledge a delivery.
