# Cursor ACP A1 probes

Run these Linux probes from the repository root on the captured CLI build, signed in through the machine's Cursor login. They create controlled conversations and use harmless shell commands. `probe.py` temporarily changes the user's ACP default model and restores its initial selection on exit. Run model probes sequentially.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/cursor-acp/probe.py
PYTHONDONTWRITEBYTECODE=1 python3 scripts/cursor-acp/session-boundaries.py
PYTHONDONTWRITEBYTECODE=1 python3 scripts/cursor-acp/remaining-probes.py
PYTHONDONTWRITEBYTECODE=1 python3 scripts/cursor-acp/mcp-exclusion.py
PYTHONDONTWRITEBYTECODE=1 python3 scripts/cursor-acp/permission-persistence.py
PYTHONDONTWRITEBYTECODE=1 python3 scripts/cursor-acp/auth-and-errors.py
PYTHONDONTWRITEBYTECODE=1 python3 scripts/cursor-acp/idle-background.py
PYTHONDONTWRITEBYTECODE=1 python3 scripts/cursor-acp/permission-hold.py
```

The last command holds a real shell permission for 1,800 seconds before allowing it. Do not replace that delay with an accelerated clock. Processes and temporary homes belong to the probe. Configuration probes link only the machine's login file; they do not copy or print credentials. The synthetic expired credential is generated in a separate private home and is not genuine expired-login evidence.

JSONL entries retain full JSON-RPC messages with `process`, `direction` and `message` fields. Session ids and private home/workspace paths become placeholders, and `availableCommands` becomes a synthetic list. Adjacent `*.capture.json` files record observations outside JSON-RPC: permission delay, configuration file paths, sentinel startup stages, RSS and the shell completion marker. RSS summed across processes includes shared pages more than once.

Before publishing a capture, check it for personal data and credentials, then run the fixture suite:

```sh
npm test -- --project plugin:unit cursor-acp-proof --reporter verbose
```

A green fixture suite proves the recorded observations, including failed eligibility checks. It does not prove the build is suitable for the adapter. The current eligibility decision and unproven cases are in [the design](../../docs/design/harnesses/cursor-acp.md#9-a1-evidence-on-build-20261113-eacade1).
