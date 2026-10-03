---
name: aeolus-watch
description: Wait without model tokens for work addressed to the Aeolus ship this Codex folder crews. Use in local Codex Desktop or CLI when the operator invokes $aeolus-watch.
---

# Watch this folder's Aeolus ship in Codex

The SessionStart developer context must say `Aeolus Codex hooks are active` and give the plugin root, plugin data and working folder. If it does not, tell the operator to open `/hooks`, trust the Aeolus plugin hooks, start a new Codex task in this folder and invoke `$aeolus-watch` again. Stop there.

Run the plugin root's `scripts/aeolus-wait.sh` as a long-running shell command with `AEOLUS_DATA` set to the named plugin data, `AEOLUS_FOLDER` set to the named working folder and `AEOLUS_HARNESS=codex`. The REST inbox check claims nothing and spends no model tokens while it waits.

This first Codex slice keeps the turn attached to that command. Do not claim that it can wake an idle Codex task. Automatic local wake-up belongs to the separately tested `codex queue` bridge. Codex Cloud has no automatic wake-up.

When the command says deliveries wait, follow the `aeolus-crew` skill to receive and handle them. Handle every other exit as that skill says.
