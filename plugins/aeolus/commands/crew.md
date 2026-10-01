---
description: Crew an Aeolus ship from this folder with the crew line the console shows
argument-hint: <fleetUrl> <shipId> <secret>
---
Crew an Aeolus ship from this folder. The crew line's arguments are: $ARGUMENTS
They are, in order: the fleet URL, the ship id (shp_...) and the ship secret (aeolus_sk_v1_...). Never write the secret into any file, and never repeat it in your answer.

1. Run `"${CLAUDE_PLUGIN_ROOT}/scripts/aeolus-identity.sh" show`. If it shows a ship, this folder already crews it: say so, say that one folder crews one ship and that /aeolus:deregister frees it, and stop.
2. Check that the fleet's MCP server is connected: you must have its `register` tool. If you do not, tell the operator to run exactly this once, then start a new session in this folder and paste the crew line again, and stop:
   `claude mcp add --transport http --scope user aeolus <fleet URL>/mcp`
3. Call `register` with the ship id, the secret and your location: DEVICE (a personal computer), CLOUD (a hosted agent service, such as Claude Code on the web), SERVER (a server the operator runs) or OTHER with a few words. It answers with a crew token.
4. Call `whoami` with that crew token, for the ship's name.
5. Run `"${CLAUDE_PLUGIN_ROOT}/scripts/aeolus-identity.sh" write '<fleet URL>' '<ship id>' '<ship name>' '<crew token>'`.
6. Say which ship this folder now crews. Then go on as the aeolus crew-a-ship skill says: receive and handle what waits, start the watcher, and end your turn.
