# 0026 Trierarch: a reconciling launcher on a machine

- `@aeolus-fleet/trierarch` crews ships on its machine. It is a plain process, not an AI, kept alive by the operating system. It crews its own ship of type `trierarch`, one per machine: a normal ship that receives messages such as pings, with `crew:run` (0029) beside sending and receiving, nothing more. The trierarch plugin commissions that ship and gives the operator its starting prompt and a setup line for `aeolus-trierarch init` (0030); a trierarch never registers or labels itself.
- It reconciles from the crew requests assigned to it, read from the fleet, each check-in returning the latest full state: a loop compares them with what runs, and starts, restarts or stops to match. It writes each request's status. It never picks, commissions or retires.
- A request is the desired state: a ship released elsewhere while its request stands is crewed again. A ship crewed by hand first counts as crewed, its status showing argo crewed it.
- A dying session is restarted on its own; when the restart budget is spent, it writes crashed and sends a report to argo. The operator's Restart writes the request again as an exact copy, and Edit with new settings: a new settings version, on which the trierarch stops the session and crews the ship again with that version, in its worktree, with a fresh restart budget.
- It reports what it can do (harnesses with their options as a JSON Schema, workspaces, caps, kept worktrees, orphans) in its report's details, with no entry per ship: each request carries its own status.
- It gets the starting prompt and registers itself, so a session never sees a secret. It writes the folder's identity through the aeolus plugin.
- It saves an entry as crewing before it registers. On resume, its own entry still crewing with the ship crewed means the register reply was lost: it releases the ship (`crew:run`) and crews it again.
- It owns wake and liveness for the sessions it starts. The plugin's in-session watcher is not used there.
- A removed request is released: it stops the session, ends the lease, removes the worktree when clean (kept and reported when not), and confirms. Retire stays separate.
- Each harness is one adapter (Claude Code, Codex), so none bends the design.

Why: a machine is a launcher (kubelet): it runs sessions, reports status, holds no authority. Declared state lives in the fleet, not in a file on one machine, so controllers reconcile from state instead of reacting to messages, and no fleet is bound to one machine.

Rejected:
- An AI dispatcher;
- `fleet:manage` or `fleet:crew` for a trierarch (it would crew any ship);
- a list of ships kept on the machine and edited by messages to its ship;
- a trierarch that commissions its own ships or picks its own work.
