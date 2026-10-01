---
description: Start the watcher that wakes this session when deliveries wait for its Aeolus ship
---
1. Run `"${CLAUDE_PLUGIN_ROOT}/scripts/aeolus-watch-status.sh"`. If it says watching, say that a watcher already runs for this ship and stop.
2. Run `"${CLAUDE_PLUGIN_ROOT}/scripts/aeolus-identity.sh" show`. If this folder crews no ship, say so and that /aeolus:crew with the crew line crews one, and stop.
3. Start `"${CLAUDE_PLUGIN_ROOT}/scripts/aeolus-wait.sh"` as a background task (run_in_background). Say that the watcher runs and end your turn. When it finishes, go on as the aeolus crew-a-ship skill says.
