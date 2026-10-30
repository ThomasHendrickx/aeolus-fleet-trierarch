# Sessions on an API key

Design for [#1085](https://github.com/ThomasHendrickx/aeolus-fleet/issues/1085), for Aeolus 0.33.0. The purpose and Thomas's answers as current state, the detailed decisions and the flow.

It builds on the headless design (aeolus-fleet `docs/design/headless/headless.md`, approved 25 Oct): its hold (H8), clean environment (H10), launch window from events (H13), key file (H15), model proxy (H16) and usage with a key (H17). Its H6 and H15 now say what K2 says; this design is the detail behind them, and its slice S5 builds both.

## 1. Purpose (agreed by Thomas)

In Thomas's words: "The whole setup is to use api keys of anthropic. I would choose to either use the api key, or the use the subscription for a set of ships", and "it is not purely anthropic, codex as well since we support that".

So: a session the trierarch crews runs on an API key or on its harness's subscription (Claude Code on an Anthropic key or the Claude subscription, Codex on an OpenAI key or the ChatGPT login), and the person who runs the trierarch chooses which ships run on which. The key stays on the computer; what the key spends shows per ship.

Not the purpose:
- Running out of a subscription window or a usage limit (#1284, #1286): their own issues.
- Spend limits, model governance or placement by cost: the trierarch plugin's (#375).
- Gateways and providers other than the harness's own vendor.

## 2. Thomas's answers

| # | Rule |
| --- | --- |
| K1 | **A trierarch default plus per-ship exceptions.** The trierarch's configuration gives each harness a default login, and names the ships that run on the other one |
| K2 | **Key and subscription on one computer at once.** Each session uses exactly one login and never falls back to the other. This replaces the headless design's "one login per harness per computer" (H6, H15) |
| K3 | **A change takes effect at the ship's next session start.** A running session keeps the login it started with |
| K4 | **The console's computer card and ship page show "API key" and the ship's cost,** a slice in aeolus-fleet, its mockup to Thomas first |
| A5 | **A ship whose key is not ready before its crew is final gives its crew request back with the cause,** so it can be crewed on another computer. Once the crew is final, it waits here (K9) |
| A6 | **What wakes a session whose turn failed on the key is #1286's design,** the same for keys and subscriptions; until then the next delivery wakes it |

## 3. Lessons checked against

- **0027.** No credential and no path in a crew request or the fleet: the login is chosen on the computer (K5), the key never leaves it (K7). A ship's login is no secret and travels in the report (K8).
- **0026.** A session holds no fleet credential; the trierarch keeps it. The key is kept the same way, by the model proxy, out of the session (K7).
- **H10, #881.** The hold builds the session's environment from nothing; the login is one named entry. Claude Code and Codex also read their own settings files, so a key there would reach a subscription session: K6 checks them.
- **H13, #852.** A refused login names its cause; the cause comes from the vendor's answer (K9).
- **H16.** The proxy forwards only to the harness's vendor and knows each request's ship, so it sees every answer the vendor gives the key (K9).
- **#353, H17.** `estimatedCostUsd` on a subscription is notional; on a key it is near the bill. The vendor's console stays the bill.
- **0032.** The report carries numbers and states, never paths, keys or content (K8).
- **#445, `init`.** A secret goes in through stdin or without echo, never a flag, a command line or `config.json`, and is never logged (K5).
- **Vendor docs, 28 Oct.** Claude Code picks one credential in order: `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `apiKeyHelper`, `CLAUDE_CODE_OAUTH_TOKEN`, then the `/login` subscription ([iam](https://code.claude.com/docs/en/iam)). Anthropic answers a bad key with 401 `authentication_error` and a billing problem with 402 `billing_error`; a spend limit with 400 or 429 ([errors](https://platform.claude.com/docs/en/api/errors)). OpenAI answers a bad key with 401 and no credit with 429 `credit_balance_exhausted`, type `insufficient_quota`; spend limits with 429 `organization_spend_limit_exceeded` or `project_spend_limit_exceeded` ([error codes](https://developers.openai.com/api/docs/guides/error-codes)). Codex takes a provider of its own with `base_url` and `env_key` (the variable's name, not the key), in user config or `-c`, never a project's `.codex/config.toml` ([config reference](https://learn.chatgpt.com/docs/config-file/config-reference)).

## 4. Decisions

| # | Rule |
| --- | --- |
| K5 | **Where the choice is set and kept.** `config.json` holds `logins`: `default`, a login per harness, and `ships`, a login per ship name. A harness not in `default` runs on its subscription. A ship's login is its entry in `ships`, else its harness's default. Values are `apiKey` or `subscription`; no key, no path. The operator sets them with `aeolus-trierarch login` (below) or by hand; `config check` checks them. The key itself is the headless design's key file, `~/.aeolus/trierarch/keys/<harness>`, mode 600 |
| K6 | **One login per session.** At every start of a session (first, restart, a new hold after an upgrade) the trierarch resolves the ship's login (K5) and keeps it in the ship's state with that session. The hold's environment gets that login only. On a key: the proxy's address and the session's own proxy token (H16), and with the container runtime no model token. On the subscription: no proxy route, and the host's own login or the model token. Before a subscription start, the trierarch checks that nothing the harness reads itself puts a key in reach: Claude Code's settings (the sources it reads for the permission mode) set no `apiKeyHelper` and no `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or cloud provider variable in `env`; Codex's login is a ChatGPT login, not an API key (`codex login status`). If one does, the ship is not started, with that cause (K9) |
| K7 | **The key stays on the computer.** Only `aeolus-trierarch login` writes the key file and only the proxy reads it. It is never in `config.json`, a crew request, the report, a log line, a session's environment, a container or the fleet. The proxy swaps a session's token for the key only on a request to that harness's vendor (`api.anthropic.com`, `api.openai.com`) over TLS |
| K8 | **What the report carries.** Per harness, `login`: its `default` and its key's `key` state, `none`, `ready`, `refused` or `outOfCredit`, with `keyStateAt`. Per ship it crews, `logins`: the ship id, the login of its running or last session, and `next` when its next start would use the other one (K3). `usage.ships[].models[]` gain `login`, so the tokens and `estimatedCostUsd` split per login: each transcript message counts to the login of the session that wrote it. The ship's cost on the key is the sum of its `apiKey` entries. All optional in `common`'s report details, so an older console reads a newer report |
| K9 | **A key that is not ready.** The trierarch starts no session on a key that is not `ready`, and hands nothing to a running session on it: deliveries wait in the inbox, nothing is lost and nothing moves to the subscription (K2). The proxy reads every vendor answer to the key: 401 makes it `refused`; Anthropic's 402 `billing_error` and spend limit, OpenAI's `insufficient_quota` and spend limits make it `outOfCredit`; a rate limit changes nothing (the harness waits and retries). argo is told once per harness and state, naming the computer, the harness, the state and the ships that wait |
| K10 | **Back to ready.** `none` and `refused`: only a new key through `aeolus-trierarch login <harness> --api-key`. `outOfCredit`: the proxy checks the key every 15 minutes with the smallest request the vendor bills (one output token on the harness's cheapest model), and at once on `aeolus-trierarch login <harness> --check`. Once `ready`, waiting ships start, without a restart counted, and hand-overs go on |
| K11 | **The commands.** `aeolus-trierarch login <harness> --api-key` reads a key from stdin (without echo at a terminal), checks it with one free call (the vendor's model list), and writes it only when the vendor takes it. `login <harness> --remove-key` removes it. `login <harness> --default api-key\|subscription` sets the harness's default. `login --ship <name> api-key\|subscription\|default` sets or clears a ship's exception. `login` alone prints each harness's default, key state and the exceptions. Every change restarts the service, as `add repository` does; sessions outlive it and keep their login (K3) |
| K12 | **The console** (aeolus-fleet slice, [mockup](https://claude.ai/artifact/CLGkPAQ8mwoAW5dgiCXFxM) to Thomas first). Each new part is a label, a value and a state, with at most one short line for a problem; what the words mean lives here and in a tooltip, not on the screen. The computer card's harness block gains a login line: `login`, the default (`API key` or `Subscription`), the count on the other login (`2 on Subscription`), and what its ships spent on the key (`$41.20 on key`). Under it, when the key is not ready while a ship needs it: a chip (`Out of credit`, `Refused`, `No key`) and `3 ships wait`. The ship page's crew request card gains the ship's login after the computer (`API key`; `Subscription, next: API key` when K3 holds it back), a `Spent on key $12.50` line when it spent any, and when its key is not ready one note in the attention tone: `API key out of credit since 14:02. Deliveries wait.` Tooltips: the spend says it is at list prices and the vendor's console has the bill; the chip says since when and that the key is checked every 15 minutes (K10); `next` says from its next start. What each part reads: the login line `harnesses[].login.default`, the count of `logins[]` on the other login, the sum of `usage.ships[].models[]` with `login: apiKey`; the chip `harnesses[].login.key` and `keyStateAt`; the ship's login its `logins[]` entry and `next`; its spend its `usage.ships[]` entries with `login: apiKey`. Nothing else on either changes |

## 5. Flow

```mermaid
flowchart TD
  pass([Crew loop: a ship needs a session start]) --> resolve["Resolve its login: ships exception, else harness default, else subscription (K5)"]
  resolve -->|subscription| reach{"A key in reach of the harness? settings env, apiKeyHelper, Codex API-key login (K6)"}
  reach -->|no| startS["Start the hold: subscription login only, no proxy route (K6)"]
  reach -->|yes| notStarted["Not started: cause names the key in reach"]
  resolve -->|apiKey| keystate{"Key state for the harness (K8)"}
  keystate -->|ready| startK["Start the hold: proxy address and its own proxy token, no model token (K6, H16)"]
  keystate -->|none, refused, outOfCredit| notStarted2["Not started: cause names the key's state (K9)"]
  notStarted --> final{Crew final?}
  notStarted2 --> final
  final -->|no| giveback["Give back with the cause (A5)"]
  final -->|yes| wait["Ship waits, restarting, no attempt counted; argo told once (K9)"]
  wait -->|key ready again (K10) or settings fixed| resolve
  startS --> window
  startK --> window{"Launch window (H13)"}
  window -->|active| run["Running; the report states its login (K8)"]
  window -->|vendor error event| cause["Start failed with the vendor's cause, counted"]
  run --> hand{"Each pass: idle turn and key ready?"}
  hand -->|yes| handover["Hand over as the headless design says"] --> run
  hand -->|key not ready| hold["Hand nothing; deliveries wait in the inbox (K9)"] --> hand
  run --> proxy{"Proxy: vendor's answer to a key request"}
  proxy -->|2xx or rate limit| run
  proxy -->|401| refused["Key refused: state refused, argo told"] --> hold
  proxy -->|402, insufficient_quota, spend limit| credit["Key out of credit: state outOfCredit, argo told"] --> hold
  credit --> check["Proxy checks every 15 min, or login --check (K10)"]
  check -->|still out| credit
  check -->|takes it| ready["State ready"] --> hand
  run -->|config changed| next["Report next login; this session keeps its own (K3)"] --> run
```

Unhappy paths the diagram does not show:
- **The key is removed while sessions run** (`login --remove-key`). The state is `none`; the proxy refuses their tokens; they get no hand-over and stay on the key until a new key is written. They never move to the subscription. To move one now: change its login (K11) and release it; it is crewed again on the new login.
- **The configuration moves a ship while its key is not ready.** Its running session keeps the key and waits (K3, K9); its report shows `next`. Released or restarted, it starts on the new login.
- **The proxy is down.** Model requests fail and the harness retries; the trierarch starts the proxy again within a pass, as the headless design says. The key's state does not change: a missing proxy is not the vendor's answer.
- **The turn that met the failure.** Its delivery was confirmed by the hook before the vendor refused (0040), and its text is in the session's conversation. Once the key is ready again, the next delivery wakes the session (A6).
- **A checked key is refused on the check.** `login --api-key` writes nothing and says the vendor's cause; the state stays as it was.
- **Two harnesses, one bad key.** States are per harness: an Anthropic key out of credit holds back Claude Code ships on the key only; Codex ships and every subscription ship go on.
- **Probes.** The model probes and the subscription window probe (trierarch.md, Detected options, usage) run on the harness's default login; the window probe runs only when some ship of that harness runs on the subscription. On a key each probe costs a turn (H17).

## 6. Slices

- **S5 (trierarch, the headless design's slice, now with this design):** K5 to K11. The proxy, the key file, `login`, the per-session login, the key states and their waits, the report fields. Tests: a computer with one ship on the key and one on the subscription runs both, each session's environment holds only its own login; a subscription start with an `apiKeyHelper` in Claude Code's settings is not started, with its cause; a key session's environment and container hold no key; a token of a stopped session is refused; a 401 makes the state `refused` and hands nothing; a 402 makes it `outOfCredit`, the check every 15 minutes brings it back and the ships start without a restart counted; removing a key moves no session to the subscription; a change of login reaches only the next start; the report states the login per ship, `next`, and the cost per login, never the key.
- **`common` (aeolus-fleet):** the optional report fields of K8.
- **Console (aeolus-fleet):** K12, after Thomas approves the mockup.
