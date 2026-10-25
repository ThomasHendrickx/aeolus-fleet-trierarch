---
description: Leave the Aeolus ship this folder crews for good, stop its watcher and forget it
---
Only for leaving the ship for good, never between tasks: the next crew needs a new starting prompt.

1. Run `"${CLAUDE_PLUGIN_ROOT}/scripts/aeolus-identity.sh" show`. If this folder crews no ship, say so and stop.
2. Run `"${CLAUDE_PLUGIN_ROOT}/scripts/aeolus-fleet.sh" deregister`. LEASE_ENDED means the ship was already released: go on.
3. Run `"${CLAUDE_PLUGIN_ROOT}/scripts/aeolus-identity.sh" delete`: it stops the watcher and forgets the ship.
4. Say that this session no longer crews the ship, and that the operator needs a new starting prompt to crew it again.
