---
name: writing-for-agents
description: Use when creating or editing a skill, CLAUDE.md, AGENTS.md, or any doc agents reach through a pointer.
---

# Writing for agents

Always-loaded text (CLAUDE.md, skill descriptions) costs tokens on every turn; a skill costs them every time it loads. Write the fewest words that still change behaviour.

Pointers (a skill description, a CLAUDE.md line naming a doc):
- Lead with the trigger; one trigger per distinct case; cut synonyms and what the body already says.
- A must-follow doc behind a weak pointer is a bug: sharpen the pointer before inlining the doc.

Structure:
- Steps first, in order, each ending on a checkable completion criterion ("every changed file listed", not "understood").
- Reference that only some cases need goes to `references/`, behind a line saying when to read it.
- A concept's rule, reason and caveat sit under one heading.
- A skill: front matter with only `name` (the folder name) and `description` (when to use it); bullets; under about 40 lines; no harness-specific tool names or project paths. Repo-specific shape goes in a repo companion skill, loaded with the shared one.

Pruning:
- One source of truth per meaning; everything else points to it.
- The environment is a source of truth too: package scripts, lint rules, config, folder layout. Point at it; write down only what it cannot tell (the reason, the gotcha).
- Delete no-ops: a line the model already follows by default changes nothing. Delete the whole sentence.
- History (what changed, when, in which session or phase) lives in git and the pull request, never in the doc.
- Rules, checks and exceptions come from the owner: an agent proposes them, never adds them. Merge an exception into the rule it bends, or drop it.

Wording:
- State the target behaviour. Use a prohibition only as a hard guardrail, paired with what to do instead.
- Reach for a word the model already knows (_tracer bullet_, _red_, _tight_) over a sentence or a coined term; repeat the word, not the explanation.
- State rules, not personas: "you are a senior expert" adds nothing the rules don't.
