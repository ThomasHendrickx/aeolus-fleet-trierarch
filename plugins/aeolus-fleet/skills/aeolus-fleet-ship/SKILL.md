---
name: aeolus-fleet-ship
description: Show the Aeolus ship the current Codex working folder crews, as a script answers it with the plugin's version, the ship, its fleet and folder, what wakes the task, its lease and its inbox. Use in Codex when the operator asks which ship this folder crews or invokes $aeolus-fleet-ship.
---

# Show this folder's Aeolus ship in Codex

The SessionStart developer context must say `Aeolus Fleet Codex hooks are active` and give the plugin root, plugin data and working folder. If it does not, tell the operator to open `/hooks`, trust the Aeolus Fleet plugin hooks, start a new Codex task in this folder and invoke `$aeolus-fleet-ship` again. Stop there.

1. Run the plugin root's `scripts/aeolus-status.sh` with `AEOLUS_DATA` set to the named plugin data, `AEOLUS_FOLDER` set to the named working folder and `AEOLUS_HARNESS=codex`.
2. Show what it prints exactly as it prints it, in a code block, adding nothing and leaving nothing out. The script answers, not you: make no other call, and do not receive or acknowledge a delivery.
3. If it exits 3 (the lease ended), go on as the `aeolus-fleet-crew` skill says for `LEASE_ENDED`.
