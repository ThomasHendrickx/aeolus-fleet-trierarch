---
name: code-review
description: Use when reviewing a branch, pull request or diff. Two independent axes, acceptance criteria and standards, each in its own subagent.
---

# Code review

Review the diff between the head and a fixed base: `git diff <base>...HEAD`, commits from `git log <base>..HEAD`. Confirm the base resolves and the diff is non-empty before anything else.

Run two axes, each in its own subagent so neither colours the other (without subagents, run them one after the other, each from a fresh read of the diff):
1. Acceptance criteria. Source: the issue or spec the commits or pull request reference; if none is found, ask for it, or skip this axis and say so. Report (a) criteria missing or partly met, (b) behaviour nobody asked for, (c) criteria that look met but are implemented wrong. Quote the criterion for each finding.
2. Standards. Sources: the repo's CLAUDE.md or AGENTS.md, the skills that apply to the touched files, and the smell baseline in `references/smells.md`. Report each breach with the rule it breaks. A smell is always a judgement call, and a documented repo rule overrides it. Skip what lint, types or tests already enforce.

Each axis reports in under 400 words, with file and hunk per finding.

Report the axes under their own headings, unmerged and unranked across axes. Mark each finding blocking (an acceptance criterion fails, or a documented rule is broken) or not. End with the count per axis and the worst finding within each.

One review per change. A fix for a blocking finding is checked against that finding, not reviewed again. Non-blocking findings go to the backlog, not into this change.
