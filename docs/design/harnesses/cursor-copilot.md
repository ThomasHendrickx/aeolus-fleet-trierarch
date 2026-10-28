# Cursor and GitHub Copilot crew a ship

Design for Thomas's "Cursor and copilot are indeed the gap to fill" (28 Oct). Stage 1: purpose, lessons, questions. No detailed decisions until the purpose is agreed.

It builds on the headless design (aeolus-fleet `docs/design/headless/headless.md`, approved 25 Oct), whose H5, H10, H11 and H13 say what a harness must do before the trierarch offers it, and on the api keys design (`docs/design/api-keys/api-keys.md`) for logins.

## 1. Purpose (to agree)

A session of Cursor or GitHub Copilot crews a ship as a Claude Code or Codex session does: crewed by hand with a crew line, or crewed by a trierarch from a crew request that names the harness, woken when a delivery arrives, confirming each delivery in its turn, and restarted when it dies.

For whom: agencies and product teams whose developers work in Cursor or Copilot and who ask "does it work with what we use?"; the person who runs a trierarch on a machine where only Cursor or Copilot is licensed; argo, who places crew requests and wants a ship's harness to be one more choice, not a different product.

The outcomes:
1. A person crews a ship from a Cursor or Copilot session on their machine with one crew line, as with Claude Code and Codex today, and the session wakes by itself when a delivery arrives.
2. A trierarch offers Cursor or Copilot as a harness in its report, crews a crew request naming it, hands deliveries over, reads its launch window and restarts it, as for Claude Code and Codex.
3. The crew token never reaches the model, its transcript or its screen (decision 0015), in either harness.
4. Every send states the exact model the session runs (decision 0018).
5. Where a harness cannot do what the delivery protocol needs, it is not offered, and the report says why (headless H5, `notOffered`).

Not the purpose:
- Cursor's Cloud Agents and the Copilot coding agent (GitHub's cloud sessions). They run on the vendor's machines, where no trierarch runs (Q8).
- The editors themselves: Cursor's editor and VS Code agent mode. Neither can be driven headless; only the CLIs can (Q4).
- Reaching the fleet over MCP from a Cursor or Copilot chat. That works today with the starting prompt for a chat, and the gateway (blueprint, "Reach the fleet from any client") serves it.
- Other harnesses (Gemini CLI, Windsurf, Amp, Aider). The questions here are written so they would apply, but no adapter is built for them.
- Model governance, placement by harness cost or a login per ship.

## 2. What is true today

The trierarch and the plugin (this repository):
- **Two harnesses.** `packages/trierarch/src/adapters/harnesses.ts` holds one adapter per harness: `claude-code` and `codex`, each with its flags, risky flags, command lines, setup (`claude-code-setup.ts`, `codex-setup.ts`), detector and usage reader behind `HarnessPort` and `HarnessDetector` (`core/ports.ts`).
- **Claude Code headless** (`trierarch.md`, Session runtime): one long-lived `claude -p --input-format stream-json --output-format stream-json`, a hand-over is one user line on stdin, events in `events.jsonl`.
- **Codex headless:** one `codex exec --json` per turn, each later turn `codex exec resume <thread id>`, no process between turns. It shows a harness without a long-lived input still fits the hold.
- **The plugin** (`plugins/aeolus-fleet`): one set of Bash scripts for both harnesses, a manifest per harness (`.claude-plugin`, `.codex-plugin`) and one `hooks/hooks.json`. Identities per harness in `~/.aeolus/crews/<harness>/`.
- **The hooks the delivery protocol needs** (plugin README, decision 0040): SessionStart (start context, launch marker `started`), UserPromptSubmit (turn busy; confirms a hand-over at the prompt by adding it to the turn's context), PreToolUse (confirms a hand-over at the first tool call by denying it with the message as reason; launch marker `active`; the Codex model), Stop (turn idle; keeps the turn open with an unconfirmed message), StopFailure and Interrupt (a died turn; a refused model), PostToolUse (the report reminder).
- **Codex's gaps** already shape the plugin: no hook for a failed turn, so the trierarch reads the refusal from Codex's events; a Codex task's hooks put nothing into a running turn, so force is best effort there.
- **Hand crew wakes** through the watcher (Claude Code) or the wake bridge with `codex queue` (Codex). Codex Cloud runs no command hooks and cannot wake.
- **Core knows two crew lines** (decision 0019): the starting prompt answers one per harness, Claude Code and Codex. The harness is free text with known values (0018): `claude-code`, `claude-chat`, `codex`.

What the vendors offer (vendor docs, read 28 Oct; to prove on the CLI builds before stage 2):

Cursor CLI (`agent`, formerly `cursor-agent`):
- **Headless:** `agent -p` with `--output-format stream-json` (events `system`, `assistant`, `tool_call`, `result`); edits only with `--force`; `--trust` skips the workspace trust question, headless only. (cursor.com/docs/cli/headless, cli/reference/parameters)
- **Resume:** `--resume <chatId>`, `--continue`, `create-chat`. A Codex-like turn per process fits. (cli/reference/parameters)
- **A long-lived channel:** `agent acp`, an Agent Client Protocol server over stdio, hidden from help. (cli/reference/parameters)
- **Hooks:** `hooks.json` (user, project, team, enterprise, plugin), events `sessionStart`, `beforeSubmitPrompt`, `preToolUse`, `postToolUse`, `postToolUseFailure`, `stop` (status completed, aborted or error), `sessionEnd` and more. `sessionStart` and `postToolUse` add context; `stop` returns `followup_message`, submitted as the next prompt (loop limit 5 by default); `beforeSubmitPrompt` can only block, never add context; `preToolUse` can deny. (cursor.com/docs/hooks)
- **Hooks in the CLI are uncertain:** the docs promise only `workspaceOpen` there; a forum update says `sessionStart`, `postToolUse` and `stop` run in the CLI; an older comment says `stop` never runs; reports of hooks not firing on Linux CLI builds (Aug 2026). (forum.cursor.com/t/cursor-cli-hooks/148511, /168407)
- **Plugins:** `.cursor-plugin/plugin.json` (or the open Agent Plugins `plugin.json`) bundling rules, skills, commands, MCP servers and hooks; the CLI takes `--plugin-dir`. Whether the CLI loads installed plugins is unconfirmed. (cursor.com/docs/plugins)
- **MCP:** `mcp.json`, shared with the editor; `--approve-mcps` in print mode. (cli/mcp)
- **Sign-in:** `agent login` (browser, or the URL printed with `NO_OPEN_BROWSER=1`), or a user API key as `CURSOR_API_KEY`. (cli/reference/authentication)
- **Plans:** Free to Ultra and Teams; which plans include the CLI is not stated; models beyond the allowance at API prices. (cursor.com/pricing)
- **Cloud Agents API** (beta): create an agent, follow-up runs (409 while one runs), `delivery: "steer"` into a running agent, SSE stream. (cursor.com/docs/cloud-agent/api/overview)

GitHub Copilot CLI (`copilot`):
- **Headless:** `copilot -p` with `--allow-all-tools` (required) and `--no-ask-user`; `--output-format json` gives JSONL. (docs.github.com, copilot-cli-reference/cli-programmatic-reference)
- **Resume:** `--continue` (the folder's latest session), `--resume`; sessions in `~/.copilot/session-state/<id>`; `COPILOT_HOME` moves the config folder. (cli-command-reference, cli-config-dir-reference)
- **A long-lived channel:** ACP, and the Copilot SDK, which drives a CLI server over JSON-RPC and can `send` into the current turn. (about-copilot-cli, copilot-sdk)
- **Hooks:** events `sessionStart`, `userPromptSubmitted`, `preToolUse`, `permissionRequest`, `postToolUse`, `postToolUseFailure`, `agentStop`, `errorOccurred`, `sessionEnd` and more. `sessionStart` and `postToolUse` add context; `agentStop` with `decision: "block"` and a reason runs another turn with the reason as its prompt (at most 8 in a row); `preToolUse` denies with exit 2; `userPromptSubmitted` from a config file can neither block nor add context. (hooks-reference)
- **Where hooks load:** `.github/hooks/*.json`, `~/.copilot/hooks/`, `settings.json`, a plugin's `hooks.json`, and Claude Code's `.claude/settings.json`. (hooks-configuration)
- **Plugins and skills:** `copilot plugin` with marketplaces, `~/.copilot/skills/<name>/SKILL.md`, `~/.copilot/installed-plugins/`. (cli-command-reference)
- **MCP:** `~/.copilot/mcp-config.json`, `--additional-mcp-config`; organisation MCP policies do not apply to the CLI. (about-copilot-cli)
- **Sign-in:** `copilot login --device-code` or `--with-token` on stdin; or `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`: a fine-grained PAT with the Copilot Requests permission, never a classic PAT. Without a credential store the token lies in a plain file under `~/.copilot`. (cli-command-reference)
- **Plans:** a paid Copilot plan, which an organisation can turn off; each prompt costs a premium request times the model's multiplier, tool calls free. (copilot/concepts/billing/copilot-requests)
- **Remote control:** `copilot --remote` lets github.com steer a local session. (copilot-cli/steer-remotely)
- **Coding agent** (cloud): one branch and PR per task, in a cloud sandbox or GitHub Actions (59 minute limit), only `.github/hooks/*.json`. (coding-agent/about-coding-agent)
- **VS Code agent mode:** hooks in preview, no headless driving found. (code.visualstudio.com/docs/copilot/customization/hooks)

## 3. Lessons to check against

The fleet's rules (decisions index):
- **0015.** The plugin keeps the crew token per folder and makes every fleet call through its scripts; only a chat with no shell passes it on `/mcp`, an accepted risk. Both CLIs have a shell, so they crew through the plugin.
- **0040, 0001.** The promise ends at the agent's confirmation: a hook acks when the message comes into the turn. A harness that cannot put a message into its turn from a hook cannot confirm (Q3).
- **0018.** Every send states the exact model; the harness is free text with known values. `cursor` and `copilot` become known values; Cursor's `auto` model names no exact model (Q9).
- **0019.** A crew line per harness, answered by core: a new hand crew line is a core change, with `MINIMUM_CORE_VERSION` raised in the same PR (Q7).
- **0026.** A session holds no fleet credential; one adapter per harness behind the ports.
- **0027.** A crew request names the harness and options, never a flag, path or credential.
- **0039.** Container mode offers Claude Code only until another harness is proven in a container.
- **0048, 0056.** Outside agents and clients reach the fleet through the gateway, not as crewed sessions (Q8).
- **0016.** No policy: `--force`, `--allow-all-tools` and `--yolo` are the operator's risk, as `--dangerously-skip-permissions` is.

The trierarch's own:
- **H5.** A harness whose hooks do not run headless is not offered until they do. Cursor's CLI hooks are in doubt.
- **H10.** The hold builds the environment from nothing; a login is one named entry, never inherited.
- **H11, Codex.** A turn per process with resume fits the hold; a long-lived stdin is not required.
- **H13, #490, #888.** Documented signals, never the screen: the launch window reads hook markers and the harness's error events, each captured and tested.
- **#381, #403 (Trust, Unattended).** A session must ask nothing before its first prompt: Cursor's `--trust`, Copilot's `--allow-all-tools` and `--no-ask-user`, and any first-run question, answered by init or refused by `config check`.
- **#1085, K rules.** An API key never enters a session's environment; only the model proxy reads it. A Cursor API key or a GitHub token is an account credential, not a model key, and the proxy does not fit it (Q6).
- **#1212.** A harness without its plugin is not offered, named in `notOffered`.
- **Codex Cloud, plugin README.** A cloud session without command hooks cannot wake; the same holds for vendor cloud agents.

## 4. Questions

**Q1. Which harness first.**
Context: both CLIs run headless with JSON events and resume. Copilot's hooks are documented for the CLI and its `agentStop` block mirrors Claude Code's Stop; it even loads `.claude/settings.json` hooks and a plugin's `hooks.json`. Cursor's CLI hooks are documented only for `workspaceOpen`, with reports that `stop` never runs and hooks not firing on Linux.
Options:
1. Copilot first, Cursor after its CLI hooks are proven on a captured build.
2. Cursor first: more asked for by agencies.
3. Both in one slice.
Pick: 1. Copilot meets H5 on paper today; Cursor first means building on hooks its own docs do not promise. Cursor's demand is real, so a spike proving its CLI hooks runs beside the Copilot slices.

**Q2. Joining as a crewed session, or over MCP only.**
Context: both CLIs speak MCP, so a person can crew a ship today with the starting prompt for a chat, the crew token in the transcript (0015's accepted risk) and no wake: the session must be told to receive. A crewed session needs the plugin for that harness and a trierarch adapter.
Options:
1. MCP only: a guide for Cursor and Copilot, no build.
2. Crewed session only: the plugin and the adapter per harness.
3. Both: the MCP guide now as the answer to "does it work with what we use?", stating its limits (no wake, token in the transcript), then the crewed session as the purpose.
Pick: 3. The guide costs a page and answers prospects this week; it is not the purpose, since a ship that does not wake is not crewed as Claude Code and Codex crew one.

**Q3. What is lost where a harness has no hook, and what the trierarch does then.**
Context: neither CLI has a prompt hook that adds context (Cursor's `beforeSubmitPrompt` only blocks, Copilot's `userPromptSubmitted` drops its output), so a hand-over cannot be confirmed at the prompt. Both can confirm at the first tool call (a deny with a reason, to prove it reaches the model) or at Stop (`followup_message`, `agentStop` block). A turn marker needs a busy and an idle signal; a died turn needs Cursor's `stop` status error or Copilot's `errorOccurred`. 0040 says the promise ends at the agent's confirmation, and H5 says such a harness is not offered.
Options:
1. H5 holds: offered only when every role (start context, busy and idle, confirmation at a tool call or Stop, died turn, launch markers) has a hook proven headless; a missing one keeps the harness in `notOffered` naming it.
2. Fill a missing hook from the process: busy at start, idle at exit, as a turn per process allows; the confirmation still only by hook.
3. Let the trierarch ack for a harness without hooks.
Pick: 1, with 2 allowed for the turn marker only once proven. 3 reopens 0040 and is out. What is lost: confirmation at the prompt, so a turn that answers without any tool call is confirmed only at Stop; force in a busy turn stays best effort, as in Codex.

**Q4. The headless shape.**
Context: Codex proved a turn per process with resume (H11). Both CLIs also offer ACP, one long-lived JSON-RPC session over stdio, and Copilot an SDK; whether hooks run under ACP is unknown.
Options:
1. A turn per process: `agent -p --resume <chatId>`, `copilot -p --resume <id>`, as Codex.
2. ACP for both: one adapter shape, a long-lived session like Claude Code.
3. 1 now, ACP studied as a later change.
Pick: 3. 1 reuses the hold as Codex runs it and hooks are documented for print mode; ACP is hidden in Cursor's help and its hook behaviour unproven.

**Q5. The plugin for the new harnesses.**
Context: the plugin's scripts are harness-neutral Bash; each harness has its own manifest. Copilot loads a plugin's `hooks.json` and Claude Code's hook settings; Cursor has its own plugin manifest and hook names. Identities live per harness in `~/.aeolus/crews/<harness>/` (0015).
Options:
1. The same plugin and scripts, one manifest and hooks file per harness, mapping each harness's events onto the same scripts; marketplaces for each.
2. A separate plugin per harness.
Pick: 1. One set of scripts keeps one behaviour, as for Claude Code and Codex; the trierarch reaches each through the same `aeolus-identity.sh` and `aeolus-push.sh`.

**Q6. Sign-in.**
Context: a trierarch session uses the machine's login for its harness; a key goes only to the model proxy (#1085). Cursor takes a user API key or a browser login; Copilot a fine-grained PAT or a device-code login, kept in plain text without a credential store. Both are account credentials: the proxy cannot stand in for them, so a key would reach the session's environment.
Options:
1. The harness's own login on the machine (`agent login`, `copilot login --device-code`), done by the person who runs the trierarch, as Claude Code's subscription; the trierarch keeps nothing and the launch window names a missing login.
2. `aeolus-trierarch login <harness> --api-key` keeps the token and gives it in the session's environment, an exception to the K rules.
Pick: 1. It needs no exception to a rule Thomas set; 2 waits until a team needs a machine without a person's login.

**Q7. Core's part.**
Context: hand crew needs a crew line per harness from core (0019) and the known harness values (0018); trierarch crew needs neither, since the harness is free text in a crew request and the trierarch reports what it offers.
Options:
1. Trierarch crew first, no core change; crew lines in core once a harness is proven, with `MINIMUM_CORE_VERSION` raised.
2. Both at once.
Pick: 1. Core changes only for a harness that works; the trierarch proves it first.

**Q8. Vendor cloud agents.**
Context: Cursor's Cloud Agents API takes follow-ups and steering by REST; the Copilot coding agent runs in Actions or a sandbox with only `.github/hooks`. Neither runs a trierarch nor the plugin's watcher, as Codex Cloud cannot wake.
Options:
1. Out of this design; a later gateway design (0048, 0056) where the gateway hands a delivery to the vendor's API.
2. In: a cloud agent crews a ship over MCP with the starting prompt.
Pick: 1. They have no machine of ours to crew them; the gateway already owns outside agents.

**Q9. The model a session states.**
Context: 0018 wants the exact model on every send, and model governance (0063) compares exact ids. Cursor's default is `auto`, which names none; both harnesses name models in their own ids, not the vendors'.
Options:
1. The session states the model id the harness names; `auto` is not offered as an option, so a crew request picks a model.
2. State `auto` as given.
Pick: 1. A send with no exact model breaks 0018; whether a harness's ids map to the vendors' ids for 0063 is for stage 2.
