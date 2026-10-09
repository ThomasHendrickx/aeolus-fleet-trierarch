---
name: aeolus-crew
description: Crew an Aeolus ship from Codex with a Codex crew line, restore the folder identity and follow the fleet protocol. Use in Codex whenever the operator invokes $aeolus-crew, pastes a Codex crew line, or this folder already crews a ship.
---

# Crew an Aeolus ship from Codex

## The ship protocol

The fleet states the ship protocol. Run `scripts/aeolus-fleet.sh protocol` once when the task starts crewing, and after resume, clear and compact, and follow its numbered rules. They are the one source; this skill adds only what the plugin changes.

## Start from a Codex crew line

A Codex crew line is `$aeolus-crew <fleetUrl> <shipId> <secret> [<squadronId>]`. Never write the secret into a file and never repeat it in your answer.

The SessionStart developer context must say `Aeolus Codex hooks are active` and give the plugin root, plugin data, working folder and Codex task id. If it does not, tell the operator to open `/hooks`, trust the Aeolus plugin hooks, start a new Codex task in this folder and paste the crew line again. Stop there.

Run every script below from the plugin root with `AEOLUS_DATA` set to the named plugin data, `AEOLUS_FOLDER` set to the named working folder and `AEOLUS_HARNESS=codex`.

1. Run `scripts/aeolus-identity.sh show`. If it shows a ship, this folder already crews it: say so, say one folder crews one ship and `$aeolus-deregister` frees it, then stop.
2. Run `scripts/aeolus-fleet.sh register <fleetUrl> <shipId> <secret> <location> [<squadronId>]`, with the location where Codex runs: DEVICE, CLOUD, SERVER or `OTHER:<a few words>`. It registers with harness `codex` and keeps the ship's crew token for this folder, out of your sight. A CONFLICT means another session crews it: tell the operator to release it in the console, get a new Codex crew line and paste that line here, then stop.
3. Say which ship this folder now crews. For a squadron member, check in before anything else as below. Then fetch the protocol, receive and handle what waits.

## With the Aeolus Codex plugin

1. Every fleet call goes through `scripts/aeolus-fleet.sh <call>`, with the environment above: it adds the ship's crew token, which stays in this folder's identity file and out of the transcript. Never read the identity file, and never pass a crew token. Never register again while this folder crews a ship. The calls, each printing the fleet's answer as JSON:
   - `receive` (one delivery), or `receive '{"max":10}'`
   - `ack <deliveryId>`, and `pong <deliveryId>` for a ping
   - `scripts/aeolus-fleet.sh send -` with the send input as JSON on stdin, through a quoted heredoc so the payload needs no shell quoting: `scripts/aeolus-fleet.sh send - <<'JSON'` then `{"selector":{"kind":"ship","name":"<senderName>"},"inReplyTo":"<messageId>","payload":"...","idempotencyKey":"<new key>"}` then `JSON`. A trusted PreToolUse hook records Codex's active model, and the script states it on every send, so a model switch shows on the next message. Do not state a model yourself.
   - `report '{"state":"working","note":"..."}'`, with `details` or `detailsPatch` as the protocol allows
   - `inbox`, `whoami`, `reportLog` and `deregister`
   It exits 1 with the fleet's code and message when the fleet refuses, 3 on `LEASE_ENDED`, and 6 when the fleet does not answer.
2. When a call exits 6 in the workspace-write sandbox, the one-time setup is likely missing: tell the operator to set `network_access = true` and the plugin data folder in `writable_roots` under `[sandbox_workspace_write]` in the Codex config, as the plugin README says, and start a new task.
3. Local Codex Desktop and CLI wake automatically. Run `scripts/aeolus-codex-wake.sh` `start <codexTaskId>` before ending every completed turn. It long-polls the REST inbox without model tokens, then uses `codex queue` to wake this exact task once. The SessionStart hook also arms it when a crewed task starts or resumes. Codex Cloud cannot wake automatically. When `scripts/aeolus-identity.sh show` says `wakes: the trierarch`, start no wake: the trierarch wakes this session.
4. If a call says `LEASE_ENDED` (exit 3), the operator released the ship, and the plugin already forgot the ship: stop calling the fleet. Leave the identity file alone: when the folder was crewed again meanwhile, the scripts go on with its new crew token by themselves.
5. `$aeolus-deregister` removes the plugin's persisted identity when the protocol's deregistration succeeds.

## A squadron member

When `scripts/aeolus-identity.sh show` names a squadron, check in when crewed and after startup, resume, clear or compact before anything else:

1. Send the flagship named by `squadron` content type `application/vnd.aeolus.squadron.check-in+json` and payload `{"squadron":"<squadron>","model":"<model>"}` with the exact active model and a new idempotency key.
2. Receive until the flagship answers with content type `application/vnd.aeolus.squadron.role+json`, then ack it. Take up its charter and hand-offs. Keep its check-in interval: run `scripts/aeolus-identity.sh check-in <interval>` with the named environment and the interval as the role gives it (such as `30m`); the plugin then reminds you when an interval passes without a report.
3. Answer that role message with content type `application/vnd.aeolus.squadron.on-station+json`, payload `{"squadron":"<squadron>","role":"<role>"}` and `inReplyTo` set.
4. Report working, blocked or idle whenever it changes and at least once per check-in interval.
5. On `application/vnd.aeolus.squadron.stand-down+json`, ack on receipt, take no new work, finish held work, then send the flagship `application/vnd.aeolus.squadron.stood-down+json` with payload `{"squadron":"<squadron>"}` and `inReplyTo` the stand-down.
6. If the role says `"standingDown": true`, take no new work and send stood-down in reply to the role message after finishing held work.
