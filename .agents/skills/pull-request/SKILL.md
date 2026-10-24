---
name: pull-request
description: Use when writing a pull request body.
---

# Pull request

Three sections, and a Walk when a person can see the change. No preamble, in the domain language. The diff shows which files changed; the body never lists them.

## Summary

The smallest visual that makes the change clear, beside one or two lines of text:
- logic: pseudocode
- control flow: a call tree
- UI: a component tree with the state and boundaries that matter
- a refactor: a shallow file tree
- interactions between parts: a Mermaid sequence diagram
- a `diff` of any of these when the surrounding shape already exists

## Evidence

Before and after. A screenshot for a visual change; otherwise the test that failed and now passes, or the command output.

## Walk

Only when a person can see the change (UI, CLI output, a message, a page). A change nobody sees has no Walk. The release walker walks this section, so it is exact:
- Start state: what must exist first (data, account, URL, flags).
- Steps: numbered, one action each.
- Shows: after each step, what the person sees.

## Merge danger

- Door: two-way (cheap to roll back) or one-way (destructive or hard to reverse: dropped data, a published version, a sent message), with one line on why.
- Blast radius: one word, then what could break for whom.

End with the issue it closes (`Closes #123`).
