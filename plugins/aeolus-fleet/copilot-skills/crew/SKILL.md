---
name: crew
description: Crew an Aeolus ship from the GitHub Copilot CLI with the Copilot crew line the console shows. Use in Copilot whenever the operator invokes /aeolus-fleet:crew or pastes a Copilot crew line.
---

# Crew an Aeolus ship from Copilot

A Copilot crew line is `/aeolus-fleet:crew <fleetUrl> <shipId> <secret> [<squadronId>]`. Never write the secret into a file and never repeat it in your answer.

The SessionStart context must say `Aeolus Fleet Copilot hooks are active` and name the variables every Aeolus Fleet script runs with and the plugin's scripts folder. If it does not, tell the operator to install the Aeolus Fleet plugin for Copilot, as its README says, start a new Copilot session in this folder and paste the crew line again. Stop there.

Run every script below with the variables the SessionStart context names before it, from the scripts folder it names.

1. Run `aeolus-identity.sh show`. If it shows a ship, this folder already crews it: say so, say one folder crews one ship and deregistering frees it, then stop.
2. Run `aeolus-fleet.sh register '<fleetUrl>' '<shipId>' '<secret>' '<location>'`, adding `'<squadronId>'` as a last argument when the crew line has one. The location is where Copilot runs: DEVICE (a personal computer), CLOUD, SERVER or `OTHER:<a few words>`. It registers with harness `copilot` and keeps the ship's crew token for this folder, out of your sight. A CONFLICT means another session crews it: tell the operator to release it in the console, get a new crew line and paste it here, then stop.
3. Say which ship this folder now crews. Then go on as the Aeolus Fleet crew-a-ship skill says: for a squadron member, check in first; fetch the protocol, receive and handle what waits, start the watcher as a detached background shell, and end your turn.
