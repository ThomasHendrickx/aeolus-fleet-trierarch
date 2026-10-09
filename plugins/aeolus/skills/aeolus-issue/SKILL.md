---
name: aeolus-issue
description: Report an issue with Aeolus or the aeolus plugin from Codex. Investigates, writes the report, files it on GitHub stripped of secrets or leaves a prefilled link, and tells argo where it is. Use in Codex when the operator invokes $aeolus-issue.
---

# Report an Aeolus issue from Codex

The SessionStart developer context must say `Aeolus Codex hooks are active` and give the plugin root, plugin data and working folder. If it does not, tell the operator to open `/hooks`, trust the Aeolus plugin hooks, start a new Codex task in this folder and invoke `$aeolus-issue` again. Stop there.

Run every script below with `AEOLUS_DATA` set to the named plugin data, `AEOLUS_FOLDER` set to the named working folder and `AEOLUS_HARNESS=codex`. Do the steps in order. Look, but change nothing while you investigate.

Keep the report to Aeolus behaviour only. No code, file contents, data or names from the user's own project or work, no people's names, and no customer or business details, even when they were part of what you saw. Summarise logs; paste only the plugin's own watcher or bridge lines.

1. Run the plugin root's `scripts/aeolus-identity.sh show`. If this folder crews no ship, still write and file the report, and skip step 5.
2. Investigate: what you saw yourself in this task, the calls that failed and what they answered, and the wake bridge's log. Note what you expected instead and how it can be made to happen again.
3. Run `scripts/aeolus-issue.sh draft` for a new draft's path, and write the report there in Markdown: the first line is `# <title>`, then the sections What happened, Expected, Steps and Output (what the bridge or a call answered, as it was). Leave out crew tokens and secrets yourself; the plugin strips them, the fleet host, paths on this machine, ship names and ids, and personal or sensitive information by its shape too. The draft itself stays on this machine.
4. Run `scripts/aeolus-issue.sh file <draft path>`.
   - `issue filed: <url>`: it is filed on GitHub.
   - `issue draft: <path>` and `open: <link>`: gh is not signed in. Show the operator both: the link opens the new issue, prefilled.
   - Exit 3, `not filed`: the stripped report still carries what it names. Take that out of the draft and run it again.
5. Send argo, the operator's ship (selector `{ "kind": "ship", "name": "argo" }`), through `scripts/aeolus-fleet.sh send -` as the `aeolus-crew` skill says, one short message with a new idempotency key: exactly the text after `tell argo:` in the script's last line, which is `Issue filed: <url>`, or `Issue draft: <path>, open: <link>` with the path filtered. Only that, never the report itself.
6. Say what was filed, or where the draft is. Then end the turn.
