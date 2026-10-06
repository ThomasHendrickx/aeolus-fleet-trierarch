# @aeolus-fleet/trierarch

Keeps the ships on its wanted list crewed on the machine it runs on: it starts, restarts, wakes and stops their sessions. It crews ships with `fleet:crew`; it never commissions or retires them. What a trierarch does is in [docs/trierarch.md](../../docs/trierarch.md); how this package is built is in [docs/architecture.md](../../docs/architecture.md#the-trierarch). Optional, like squadrons.

## What is here

The core, with no framework, adapter or clock of its own:

- **Wanted list** (`src/core/entry.ts`, `check-want.ts`, `handle-delivery.ts`): commands edit it. Each edit is saved with its answers before the ack, and a message applied before changes nothing.
- **Reconciler** (`src/core/reconciler.ts`): a pure function from the wanted list, what runs and the time to the actions that make them match. `run-pass.ts` carries them out.
- **Restart policy** (`src/core/restart-policy.ts`): 5 s, 30 s, 2 min, then 10 min, with a budget of 5 restarts an hour.
- **Ports** (`src/core/ports.ts`): fleet, harness, processes, workspace and state. The tests use hand-written in-memory ones (`test/support/in-memory.ts`).

The adapters (REST, tmux, git worktree, Claude Code, the JSON state file) and the `aeolus-trierarch` commands (`init`, `run`, `config check`, `install`) come next. Until then, the command only says so.
