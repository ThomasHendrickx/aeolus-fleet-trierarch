---
name: aeolus-crew
description: Crew an Aeolus ship from Codex with a Codex crew line, restore the folder identity and follow the fleet protocol. Use in Codex whenever the operator invokes $aeolus-crew, pastes a Codex crew line, or this folder already crews a ship.
---

# Crew an Aeolus ship from Codex

## The ship protocol

The Aeolus MCP server states the ship protocol in its instructions, which this session already has once the fleet tools are connected: follow those numbered rules. They are the one source; this skill adds only what the plugin changes.

## Start from a Codex crew line

A Codex crew line is `$aeolus-crew <fleetUrl> <shipId> <secret> [<squadronId>]`. Never write the secret into a file and never repeat it in your answer.

The SessionStart developer context must say `Aeolus Codex hooks are active` and give the plugin root, plugin data, working folder and Codex task id. If it does not, tell the operator to open `/hooks`, trust the Aeolus plugin hooks, start a new Codex task in this folder and paste the crew line again. Stop there.

1. Run the plugin root's `scripts/aeolus-identity.sh show` with `AEOLUS_DATA` set to the named plugin data, `AEOLUS_FOLDER` set to the named working folder and `AEOLUS_HARNESS=codex`. If it shows a ship, this folder already crews it: say so, say one folder crews one ship and `$aeolus-deregister` frees it, then stop.
2. Check that the fleet tools include `register`. If not, run `scripts/aeolus-mcp-hint.sh <fleetUrl>` with the same environment, show its exact answer and stop.
3. Call `register` with the ship id, secret, the location where Codex runs and harness `codex`. A CONFLICT means another session crews it: tell the operator to release it in the console, get a new Codex crew line and paste that line here, then stop.
4. Call `whoami` with the crew token. Run `scripts/aeolus-identity.sh write <fleetUrl> <shipId> <shipName> <crewToken> [<squadronId>]` with the same environment. Never pass the secret.
5. Say which ship this folder now crews. For a squadron member, check in before anything else as below. Then receive and handle what waits.

## With the Aeolus Codex plugin

1. The crew token is the `crewToken` line of the identity file the SessionStart context names. Read it there and pass it to fleet calls. Never register again while the file exists.
2. The trusted Codex PreToolUse hook replaces every Aeolus `send` input with the same input plus `model`, using the active model slug from Codex. Do not invent an alias. A send without the active model is refused.
3. Local Codex Desktop and CLI wake automatically. Run the plugin root's `scripts/aeolus-codex-wake.sh` `start <codexTaskId>` with the named `AEOLUS_DATA` and `AEOLUS_FOLDER` before ending every completed turn. It long-polls the REST inbox without model tokens, then uses `codex queue` to wake this exact task once. The SessionStart hook also arms it when a crewed task starts or resumes. Codex Cloud cannot wake automatically.
4. If the fleet protocol reports `LEASE_ENDED`, run `scripts/aeolus-identity.sh delete` with the named environment so the plugin forgets the released ship.
5. `$aeolus-deregister` removes the plugin's persisted identity when the protocol's deregistration succeeds.

## A squadron member

When the identity file has a `squadron` line, check in when crewed and after startup, resume, clear or compact before anything else:

1. Send the flagship named by `squadron` content type `application/vnd.aeolus.squadron.check-in+json` and payload `{"squadron":"<squadron>","model":"<model>"}` with the exact active model and a new idempotency key.
2. Receive until the flagship answers with content type `application/vnd.aeolus.squadron.role+json`, then ack it. Take up its charter and hand-offs. Keep its check-in interval: run `scripts/aeolus-identity.sh check-in <interval>` with the named environment and the interval as the role gives it (such as `30m`); the plugin then reminds you when an interval passes without a report.
3. Answer that role message with content type `application/vnd.aeolus.squadron.on-station+json`, payload `{"squadron":"<squadron>","role":"<role>"}` and `inReplyTo` set.
4. Report working, blocked or idle whenever it changes and at least once per check-in interval.
5. On `application/vnd.aeolus.squadron.stand-down+json`, ack on receipt, take no new work, finish held work, then send the flagship `application/vnd.aeolus.squadron.stood-down+json` with payload `{"squadron":"<squadron>"}` and `inReplyTo` the stand-down.
6. If the role says `"standingDown": true`, take no new work and send stood-down in reply to the role message after finishing held work.
