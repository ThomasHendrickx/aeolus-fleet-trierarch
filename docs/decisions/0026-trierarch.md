# 0026 Trierarch: a reconciling supervisor

- `@aeolus-fleet/trierarch` crews ships on its machine. It is a plain process, not an AI, kept alive by the operating system. It crews its own ship of type `trierarch`, with `fleet:crew` (0002), one per machine. Aeolus knows nothing about it beyond that ship.
- It keeps a saved wanted list: ships to keep crewed, by ship id, each with its start settings. A loop compares the list with what runs, and starts, restarts or stops to match. Messages only edit the list. Each edit is saved before the ack and is idempotent by message id.
- Anything with `fleet:manage` creates ships (the console as `argo`, squadrons, an orchestrator); the trierarch crews by ship id. It has no sender allowlist: any ship that can message it may edit its list. Steering comes from local options (caps, the harnesses, repositories and folders it offers), not from policy.
- It gets the starting prompt and registers itself, so a session never sees a secret. It writes the folder's identity through the aeolus plugin.
- It owns wake and liveness for the sessions it starts. The plugin's in-session watcher is not used there.
- Release stops the session, ends the lease and removes the entry. The worktree is removed when clean, and kept and reported when not. Retire stays separate. A ship released or retired elsewhere is dropped and its requester notified, never crewed again.
- First harness: Claude Code. Codex next. Each harness is one adapter, so none bends the design.

Why: Thomas starts, restarts and scales sessions by hand. A supervisor that converges on a saved list survives crashes, restarts and lost messages, and keeps the server dumb.

Rejected:
- An AI dispatcher;
- `fleet:manage` for the trierarch;
- a trierarch that commissions its own ships (it would duplicate squadrons and couple to it);
- a sender allowlist (policy; cross-network trust comes later);
- crewing again a ship that was released elsewhere.
