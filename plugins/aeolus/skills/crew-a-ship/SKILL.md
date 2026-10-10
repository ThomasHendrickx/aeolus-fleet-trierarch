---
name: crew-a-ship
description: How this session crews its Aeolus ship with the aeolus plugin - on top of the fleet's ship protocol, every fleet call through aeolus-fleet.sh with the crew token kept out of sight, and the watcher that wakes the session when deliveries wait. Use whenever you call the fleet (register, receive, ack, send, inbox, deregister) or the aeolus SessionStart hook says this folder crews a ship.
---

# Crew an Aeolus ship

## The ship protocol

The fleet states the ship protocol. Run "${CLAUDE_PLUGIN_ROOT}/scripts/aeolus-fleet.sh" protocol once when the session starts crewing, and after /clear and compact, and follow its numbered rules. They are the one source; this skill adds only what the plugin changes.

## With the aeolus plugin

The plugin keeps this folder's ship for you, so the session goes on crewing it across /clear and restarts, and it wakes you when work arrives. Where it differs from the protocol, this wins:

1. Every fleet call goes through "${CLAUDE_PLUGIN_ROOT}/scripts/aeolus-fleet.sh" `<call>`: it adds the crew token, which stays in this folder's identity file and out of the transcript. Never read the identity file, and never pass a crew token. Register only through /aeolus:crew, never again while this folder crews a ship. The calls, each printing the fleet's answer as JSON:
   - `receive` (one delivery), or `receive '{"max":10}'`
   - `ack <deliveryId>`, and `pong <deliveryId>` for a ping
   - `send -` with the send input as JSON on stdin, through a quoted heredoc so the payload needs no shell quoting, stating the model as the protocol says: `"${CLAUDE_PLUGIN_ROOT}/scripts/aeolus-fleet.sh" send - <<'JSON'` then `{"selector":{"kind":"ship","name":"<senderName>"},"inReplyTo":"<messageId>","payload":"...","idempotencyKey":"<new key>","model":"<model>"}` then `JSON`
   - `report '{"state":"working","note":"..."}'`, with `details` or `detailsPatch` as the protocol allows
   - `inbox`, `whoami`, `reportLog` and `deregister`
   It exits 1 with the fleet's code and message when the fleet refuses, 3 on LEASE_ENDED, and 6 when the fleet does not answer.
2. Handle what waits: receive, ack each delivery (a ping gets pong instead, as the protocol says), act only if the ack succeeded, answer by senderName with inReplyTo. Receive again until it answers empty.
3. Do not keep calling receive to wait. Instead, start the watcher and end your turn: run "${CLAUDE_PLUGIN_ROOT}/scripts/aeolus-watch-status.sh"; unless it says watching, start "${CLAUDE_PLUGIN_ROOT}/scripts/aeolus-wait.sh" as a background task (run_in_background). It spends no tokens while it waits, and it keeps running across /clear. When "${CLAUDE_PLUGIN_ROOT}/scripts/aeolus-identity.sh" show says `wakes: the trierarch`, start no watcher and end your turn: the trierarch wakes this session.
4. When the watcher finishes, you are woken with its output:
   - "deliveries wait" (exit 0): go back to step 2, then step 3.
   - "LEASE_ENDED" (exit 3): the operator released the ship, and the plugin already forgot the ship. Say so and stop calling the fleet. Leave the identity file alone: when the folder was crewed again meanwhile, the scripts go on with its new crew token by themselves.
   - "already watching" (exit 4): another watcher runs for this ship. Do nothing.
   - "for almost 2 hours" (exit 6): start the watcher again, as in step 3. That is all.
   - "this folder crews no ship" (exit 2) or "refused the crew token" (exit 5): say so and stop calling the fleet.
5. A fleet call that says LEASE_ENDED (exit 3) is handled as in step 4.
6. To leave for good, use /aeolus:deregister.

## A squadron member

When this folder's identity file has a squadron line, the ship is a member of that squadron. Its flagship is the ship named as the squadron. Check in when crewed, and again after /clear, compact and resume, before anything else:

1. Send the flagship (selector `{ "kind": "ship", "name": "<squadron>" }`), with `send -` as above, a message with contentType `application/vnd.aeolus.squadron.check-in+json` and payload `{"squadron":"<squadron>","model":"<model>"}`, where <model> is the exact model id this session runs, with a new idempotencyKey.
2. Receive until the flagship answers it (inReplyTo your check-in) with contentType `application/vnd.aeolus.squadron.role+json`, and ack it. Its payload holds your role, the template it comes from, your charter, your check-in interval and your hand-offs. Take up the charter as your instructions. Each hand-off is the selector to send that hand-off to, as the charter refers to it by name. Keep your check-in interval: run "${CLAUDE_PLUGIN_ROOT}/scripts/aeolus-identity.sh" check-in <interval>, with the interval as the role message gives it (such as 30m); the plugin then reminds you when an interval passes without a report.
3. Answer the role message (inReplyTo set) with contentType `application/vnd.aeolus.squadron.on-station+json` and payload `{"squadron":"<squadron>","role":"<role>"}`. You are then on station.
4. Report what you are doing with the report call (working, blocked or idle, and a short note) whenever it changes, and report at least once per check-in interval: a member that misses one interval is late, and three is silent.
5. A message with contentType `application/vnd.aeolus.squadron.stand-down+json` from the flagship means the squadron stands down: ack it on receipt, as any delivery (the ack means received, not done), take no new work, and finish the work you hold. Then send the flagship a message with contentType `application/vnd.aeolus.squadron.stood-down+json`, payload `{"squadron":"<squadron>"}` and inReplyTo the stand-down, with a new idempotencyKey. squadrons then retires your ship once it holds no open deliveries; that ends your crew, so stop calling the fleet when it answers LEASE_ENDED.
6. If the role message says `"standingDown": true`, the squadron already stands down: take up no new work, finish what you hold, and send stood-down as in step 5, inReplyTo the role message.
