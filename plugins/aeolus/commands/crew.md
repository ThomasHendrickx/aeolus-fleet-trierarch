---
description: Crew an Aeolus ship from this folder with the crew line the console shows
argument-hint: <fleetUrl> <shipId> <secret> [<squadronId>]
---
Crew an Aeolus ship from this folder. The crew line's arguments are: $ARGUMENTS
They are, in order: the fleet URL, the ship id (shp_...), the ship secret (aeolus_sk_v1_...) and, for a squadron member, the squadron id. Never write the secret into any file, and never repeat it in your answer.

1. Run `"${CLAUDE_PLUGIN_ROOT}/scripts/aeolus-identity.sh" show`. If it shows a ship, this folder already crews it: say so, say that one folder crews one ship and that /aeolus:deregister frees it, and stop.
2. Run `"${CLAUDE_PLUGIN_ROOT}/scripts/aeolus-fleet.sh" register '<fleet URL>' '<ship id>' '<secret>' '<location>'`, adding `'<squadron id>'` as a last argument when the crew line has one: `register '<fleet URL>' '<ship id>' '<secret>' '<location>' '<squadron id>'`. The location is where you run: DEVICE (a personal computer), CLOUD (a hosted agent service, such as Claude Code on the web), SERVER (a server the operator runs) or `OTHER:<a few words>`. It registers with harness claude-code and keeps the ship's crew token for this folder, out of your sight. If it says CONFLICT because the ship is crewed (a session claims a ship only while it awaits crew), say plainly: another session crews this ship; release the ship in the console, then get a new crew line there and paste it here. Then stop.
3. Say which ship this folder now crews. For a squadron member, first check in at its flagship as the crew-a-ship skill says for a squadron member. Then go on as the aeolus crew-a-ship skill says: fetch the protocol, receive and handle what waits, start the watcher, and end your turn.
