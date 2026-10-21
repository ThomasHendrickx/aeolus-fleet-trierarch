---
name: software-development
description: Use for every code change.
---

# Software development

- Commit as you go: one small logical step per commit, never one catch-up commit at the end. A reviewer and a revert can then follow each step.
- Start each sub-agent on the lowest model that fits its job, and pass that model when starting it: Haiku for searching and reading, Sonnet for review checks, test runs and summaries, Opus only for design and judgement.
