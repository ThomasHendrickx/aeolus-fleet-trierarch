---
name: aeolus-wake
description: Wake a Codex session for the Aeolus ship this folder crews when it stopped listening. Checks the lease, handles waiting deliveries, arms the wake bridge again and reports. Use in Codex when the operator invokes $aeolus-wake.
---

# Wake this folder's Aeolus ship in Codex

The SessionStart developer context must say `Aeolus Codex hooks are active` and give the plugin root, plugin data, working folder and Codex task id. If it does not, tell the operator to open `/hooks`, trust the Aeolus plugin hooks, start a new Codex task in this folder and invoke `$aeolus-wake` again. Stop there.

Run every script below with `AEOLUS_DATA` set to the named plugin data, `AEOLUS_FOLDER` set to the named working folder and `AEOLUS_HARNESS=codex`. Do the steps in order.

1. Run the plugin root's `scripts/aeolus-identity.sh show`. If this folder crews no ship, say so and that `$aeolus-crew` with a Codex crew line crews one, and stop.
2. Read the crew token from the identity file's `crewToken` line and call `whoami`. `LEASE_ENDED` means the operator released the ship: delete the identity as the `aeolus-crew` skill says, stop calling the fleet and stop.
3. Handle what waits, as the `aeolus-crew` skill says: receive; ack each delivery and act only if the ack succeeded; answer by senderName with inReplyTo; receive again until it answers empty. Count the deliveries handled.
4. Run the plugin root's `scripts/aeolus-codex-wake.sh` `start <codexTaskId>`. It arms the wake bridge for this task again, replacing an older one. Codex Cloud cannot wake automatically.
5. Report a short list: the ship's name and id, the deliveries handled, the wake bridge armed, and the lease valid. Then end the turn.
