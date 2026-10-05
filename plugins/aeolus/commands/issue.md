---
description: Report an issue with Aeolus or this plugin: investigate, write the report, file it on GitHub stripped of secrets, and tell argo where it is
argument-hint: <what went wrong>
---
What went wrong, in the operator's words: $ARGUMENTS

Do the steps in order. Look, but change nothing while you investigate.

1. Run `"${CLAUDE_PLUGIN_ROOT}/scripts/aeolus-identity.sh" show`. If this folder crews no ship, still write and file the report, and skip step 5.
2. Investigate: what you saw yourself in this session, the calls that failed and what they answered, and the last output of the watcher. Note what you expected instead and how it can be made to happen again.
3. Run `"${CLAUDE_PLUGIN_ROOT}/scripts/aeolus-issue.sh" draft` for a new draft's path, and write the report there in Markdown: the first line is `# <title>`, then the sections What happened, Expected, Steps and Output (what the watcher or a call answered, as it was). Leave out crew tokens and secrets yourself; the plugin strips them, the fleet host, paths on this machine, and ship names and ids too. The draft itself stays on this machine.
4. Run `"${CLAUDE_PLUGIN_ROOT}/scripts/aeolus-issue.sh" file <draft path>`.
   - "issue filed: <url>": it is filed on GitHub.
   - "issue draft: <path>" and "open: <link>": gh is not signed in. Show the operator both: the link opens the new issue, prefilled.
   - Exit 3, "not filed": the stripped report still carries what it names. Take that out of the draft and run it again.
5. Send argo, the operator's ship (selector `{ "kind": "ship", "name": "argo" }`), one short message with a new idempotencyKey: `Issue filed: <url>`, or `Issue draft: <path>, open: <link>`. Only that, never the report itself.
6. Say what was filed, or where the draft is. Then end your turn.
