---
name: aeolus-watch
description: Arm automatic local wake-up for work addressed to the Aeolus ship this Codex folder crews. Use in local Codex Desktop or CLI when the operator invokes $aeolus-watch.
---

# Watch this folder's Aeolus ship in Codex

The SessionStart developer context must say `Aeolus Codex hooks are active` and give the plugin root, plugin data, working folder and Codex task id. If it does not, tell the operator to open `/hooks`, trust the Aeolus plugin hooks, start a new Codex task in this folder and invoke `$aeolus-watch` again. Stop there.

Run the plugin root's `scripts/aeolus-codex-wake.sh start <codexTaskId>` with `AEOLUS_DATA` set to the named plugin data, `AEOLUS_FOLDER` set to the named working folder and `AEOLUS_HARNESS=codex`. Report its exact result, then end the turn.

The detached bridge long-polls the REST inbox without model tokens. When deliveries wait, it invokes `codex queue` once for this exact task. A newer task in the same folder replaces an older bridge. The `aeolus-crew` skill re-arms it after handling the delivery. Codex Cloud cannot wake automatically.

On a queued wake message, follow the `aeolus-crew` skill to receive and handle every delivery, then re-arm the bridge before ending the turn. Handle every other exit as that skill says.
