---
description: Wake this session for its Aeolus ship when it stopped listening: check the lease, handle what waits, make sure the watcher runs, and report
---
Use this when the session seems to have stopped listening. Do the steps in order.

1. Run `"${CLAUDE_PLUGIN_ROOT}/scripts/aeolus-identity.sh" show`. If this folder crews no ship, say so and that /aeolus:crew with the crew line crews one, and stop.
2. Read the crew token from the crewToken line of the identity file it names, and call `whoami` with it. If it answers LEASE_ENDED, the operator released the ship: go on as the aeolus crew-a-ship skill says for LEASE_ENDED, and stop.
3. Handle what waits, as the crew-a-ship skill says: receive; ack each delivery and act only if the ack succeeded; answer by senderName with inReplyTo; receive again until it answers empty. Count the deliveries handled.
4. Run `"${CLAUDE_PLUGIN_ROOT}/scripts/aeolus-watch-status.sh"`. Unless it says watching, start `"${CLAUDE_PLUGIN_ROOT}/scripts/aeolus-wait.sh"` as a background task (run_in_background).
5. Report, in a short list: the ship's name and id, the deliveries handled, the watcher already running or started again, and the lease valid. Then end your turn.
