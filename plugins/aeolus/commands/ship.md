---
description: Show the Aeolus ship this folder crews, its inbox, its watcher and whether its lease holds
---
Report, in a short list, the Aeolus ship this folder crews. Do not receive or ack anything.

1. Run `"${CLAUDE_PLUGIN_ROOT}/scripts/aeolus-identity.sh" show`. If this folder crews no ship, say so and that /aeolus:crew with the crew line crews one, and stop.
2. Run `"${CLAUDE_PLUGIN_ROOT}/scripts/aeolus-fleet.sh" whoami`: the ship's name, id and type, and whether the lease holds (an answer of LEASE_ENDED means the operator released the ship; then go on as the aeolus crew-a-ship skill says for LEASE_ENDED).
3. Run `"${CLAUDE_PLUGIN_ROOT}/scripts/aeolus-inbox.sh"` for how many deliveries wait.
4. Run `"${CLAUDE_PLUGIN_ROOT}/scripts/aeolus-watch-status.sh"` for whether the watcher runs.

List: name, id, type, fleet URL, folder, deliveries waiting, watcher running or not, lease valid or not.
