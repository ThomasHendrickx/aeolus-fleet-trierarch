---
name: software-development
description: Use for every code change.
---

# Software development

- Commit as you go: one small logical step per commit, never one catch-up commit at the end. A reviewer and a revert can then follow each step.
- Local can vanish: work only on this machine has no guarantee. Push after every commit.
- Work for a GitHub issue lives on that issue's remote branch: reuse it if it exists, else create it and push it at once. Remove the branches of a closed issue, locally and remotely.
- Kill a process only by the exact PID of one you started; never by name or pattern (pkill, killall).
- Pick the model for each job, yours and every sub-agent's, from three tiers, and pass it when starting the sub-agent. Either vendor fits a tier; take the one with the most subscription budget left (its weekly window first, then its 5-hour window).
  - Large (claude-opus-5-5, gpt-6.1-sol): designs (purpose, lessons, questions, flows), slices in the core domain (delivery, scopes and network rules, encryption, concurrency, migrations), the first slice in a new area, diagnosing a bug whose cause is not clear, and all UI work (screen designs, mockups and their iterations, building screens).
  - Medium (claude-sonnet-5-5, gpt-5.6-terra), the default: walks, deploys and rollbacks, mechanical slices, documentation passes, investigations with a clear question, reviews, small fixes.
  - Small (claude-haiku-5-5, gpt-5.6-luna): sub-agents doing lookups (Explore).
  - UI work is never medium: its design is not good enough.
