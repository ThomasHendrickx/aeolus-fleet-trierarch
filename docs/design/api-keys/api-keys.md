# Sessions on an API key, and sessions that run out

Design for [#1085](https://github.com/ThomasHendrickx/aeolus-fleet/issues/1085) (a session works with an API key instead of a subscription), with [#1284](https://github.com/ThomasHendrickx/aeolus-fleet/issues/1284) (a harness whose subscription window is used up is still offered) and [#1286](https://github.com/ThomasHendrickx/aeolus-fleet/issues/1286) (a Codex session cut off by its usage limit does not go on), for Aeolus 0.33.0. Stage 1: purpose, lessons, questions. No detailed decisions until the purpose is agreed.

It builds on the headless design (aeolus-fleet `docs/design/headless/headless.md`, approved 25 Oct), whose H6, H7 and H15 to H17 already decide where a key lives and how it reaches a session, and its slice S5 builds them. Sessions run headless from 0.33.0: #25 (Claude Code under a hold) and #26 (Codex, one `codex exec` per turn).

## 1. Purpose (to agree)

A session the trierarch crews runs on the login its machine has for that harness, a subscription or an API key, and when that login runs out (a used-up subscription window, a key out of credit or refused) the machine stops taking work for that harness, says why and until when, and the ships it already crews go on by themselves once the login works again.

For whom: the person who runs a trierarch, who picks per machine whether a harness spends a subscription or a key and needs to see what the key spends; argo, who places crew requests and must not wait a minute per try on a machine that cannot work; and every ship the trierarch crews, whose deliveries must not be lost or dropped because a login ran out mid-turn.

The outcomes:
1. A harness signs in with an API key (Anthropic Console for Claude Code, OpenAI for Codex), set on the machine by the person who runs it; the key never travels through the fleet, a crew request or the report, and no session sees it (headless H6, H7).
2. A harness whose login cannot work now is not offered for placement until it can, and the reason names the cause and, for a window, when it resets (#1284).
3. A session stopped by a usage limit goes on once the limit clears, or its ship is reported with the reason, never crewed and idle with no word (#1286).
4. A delivery whose turn a usage limit cut off is not dropped for it.
5. What a session on a key spends shows in the report, per ship and model, and the login each harness uses is stated, never the key.

Not the purpose:
- Spend limits, model governance or placement by cost: the trierarch plugin's (#375).
- A key per fleet, per crew request or per ship: a crew request carries no credential (decision 0027).
- Gateways or other model providers than the harness's own vendor.
- Changing how a person crews a ship by hand with the plugin's watcher.

## 2. What is true today

- **Logins.** A host session uses the machine's own login; a container gets the one long-lived Claude token from `~/.aeolus/trierarch/model-token` as `CLAUDE_CODE_OAUTH_TOKEN` through an env file (#445). No API-key path exists. Under a hold (#25, H10) the harness gets only `HOME`, `PATH` and `AEOLUS_LAUNCH`, so a key in the trierarch's environment would not reach it.
- **Usage** (`trierarch.md`, What a trierarch reports): `usage.subscriptions` per harness and window (`usedPercent`, `resetsAt`), read at start and then at most every 30 minutes after work; Claude Code's by a probe turn of its own, Codex's from its newest session log. `usage.ships` holds tokens per model from the transcripts and `estimatedCostUsd` at list prices or the configuration's `prices`. Placement does not read either.
- **Placement stops** only after 3 different ships' starts failed in a row (#853): the report then leaves out every harness, names them in `notOffered`, and probes again after 10 minutes. A used-up window does not count until it makes 3 starts fail, each after a full launch window.
- **#1284 as seen.** Codex's 5-hour window at 100 %: each Codex start did nothing and was given back with `no activity within a minute of its start`; the real cause never shown.
- **#1286 as seen.** Two Codex ships working when the window reached 100 % stayed crewed and seen for over an hour after the reset and did nothing on new deliveries. The cause is not proven. Headless Codex (#26) ends a failed turn with `turn.failed`, exit 1 and no Stop hook; the hand-over marked the turn busy and only Stop marks it idle, so the trierarch may hand that ship nothing again. To prove first.
- **A died turn** (plugin README, D3): Claude Code's StopFailure, on any error a rate limit included, and Codex's Interrupt mark the turn died; its confirmed delivery is handed once more, and when that turn dies too it is reported not handled and dropped (#847), the reason naming `StopFailure: rate_limit`. Two turns cut by one window lose the delivery.
- **Launch window** (H13): a start with no activity names the harness's last error event as its cause, so a limit or a refused key at start would be named, but still only after the minute.

What the vendors offer (vendor docs, as cited in the headless design, 25 Oct; to check again before stage 2):
- **Claude Code** takes its credential by precedence: `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `apiKeyHelper`, `CLAUDE_CODE_OAUTH_TOKEN`, then the login. `ANTHROPIC_BASE_URL` points it at another address, which still needs a credential of its own. Each `result` event carries `total_cost_usd`. A key has no subscription window; it has rate limits (429 with a retry time, retried by Claude Code itself) and a credit balance (refused once spent).
- **Codex** signs in with ChatGPT or an API key (`codex login --with-api-key`, or the key in its environment for `codex exec`). A provider is set by `model_providers.<id>.base_url` with `env_key` naming the variable that holds its credential. `turn.completed` carries token usage, no cost. A ChatGPT login has 5-hour and weekly windows; a key has rate limits and its project's quota (`insufficient_quota`).

## 3. Lessons to check against

Where keys live and never travel:
- **0027, `trierarch.md` Cloned on demand.** No credential and no path in a crew request or the fleet; the machine's own access only.
- **0026.** A session holds no fleet credential; the trierarch keeps it and adds it on the ship's socket. A key is kept the same way: by the trierarch, out of the session.
- **H6, H15.** A key file per harness beside the model token, `~/.aeolus/trierarch/keys/<harness>`, mode 600, written by `aeolus-trierarch login <harness> --api-key` from stdin and removed by `--subscription`. One login per harness. The report states `apiKey` or `subscription`, never the key.
- **H7, H16, and 0039's rejected credential proxy.** A model proxy on the machine holds the key; each session gets a random token of its own and the proxy's loopback address, which forwards only to that harness's vendor and only for running sessions. Rejected for subscription logins in 0039, it is the route for keys. `apiKeyHelper` and the key in the environment are what it avoids: either puts the key where the session can read it.
- **H10, #881.** The hold builds the environment from nothing, so the login is one named entry of that list, never inherited.
- **#445, `model-token`.** A secret goes to a container through an env file, never a command line, and is never in `config.json`.
- **`init` and the setup line.** A secret is asked without echo or read from stdin, never a flag that lands in shell history, and the trierarch never logs it.

How the harnesses take a key:
- Claude Code through the proxy as `ANTHROPIC_BASE_URL` plus `ANTHROPIC_AUTH_TOKEN` (H16); a key changes no hook, so H5 holds.
- Codex through a provider of its own, `model_providers.aeolus`; to prove before building: that the hooks, the model probes (`codex exec -m <slug>`) and `codex exec resume` work alike on that provider, and that Codex's catalog of models is the key's, not the ChatGPT login's (#392).
- The detection probes (`trierarch.md`, Detected options) and Claude Code's subscription probe each cost a turn: on a key they spend money, and a key has no window to read (H17).

Cost visibility:
- **H17.** On a key, no subscription windows; tokens per model from the transcripts as today; cost from Claude Code's `total_cost_usd` or the configured `prices`.
- **#353, `trierarch.md`.** `estimatedCostUsd` on a subscription is what the tokens would cost at list prices, not what is paid. The vendor's console stays the bill.
- **0032.** Paths and content stay on the machine; the report carries numbers only.

Running out:
- **#853.** A machine that cannot start sessions stops offering itself in its own report, with no core change; argo is told once. The same shape fits a harness that ran out.
- **0030.** A request given back is not placed on that trierarch again; a give-back for a window that resets in an hour would keep that machine from the request for good.
- **0040, #847.** A died turn's delivery is handed once more, then dropped. A recorded decision: any change for a usage limit is raised as a question (Q5), not made here.
- **#852.** A refused login must say why (H13); what the trierarch then does was left open there and is Q6 here.
- **#490, #888.** Documented signals, never the screen: the limit is read from the harness's error event or the usage read, never matched in text that has no stated format, or, where only text exists, matched in one place and tested on captured events.

## 4. Questions

**Q1. One design for the three issues, and its order.**
Context: #1284 and #1286 are about a subscription that runs out and need no key; #1085 is S5 of the headless design. They meet at one point: what the trierarch does when a harness's login cannot work now.
Options:
1. One design, slices in 0.33.0: running out first (Q2 to Q6, no key needed), then keys (S5 with Q7 to Q9).
2. Two designs: #1284 and #1286 now as fixes, keys as S5 alone.
3. One design, keys first.
Pick: 1. Running out is live pain on today's machines and its rules hold for a key that runs out too, so S5 builds on them instead of beside them.

**Q2. Where a used-up login stops placement (#1284).**
Context: the trierarch knows its windows; placement is the trierarch plugin's and reads no usage today. #853 stops a whole machine in its own report.
Options:
1. The trierarch leaves that harness out of its report, named in `notOffered` with the reason (`codex: 5-hour window used up, resets 14:00`), until the reset, then offers it again. No core change.
2. The trierarch plugin's placement reads `usage.subscriptions` and skips that harness.
3. Both.
Pick: 1. The machine sees the limit first (a session's error event, Q3) and #853 already proves the shape; argo sees it on the machine card through `notOffered` as for any harness not offered.

**Q3. What counts as used up.**
Context: the usage read is at most every 30 minutes and only after work, so it can be stale; a session hitting the limit says so at once in its error event (StopFailure `rate_limit`, Codex's `turn.failed` or `error`).
Options:
1. The read only, at 100 % of any window.
2. A session's limit error only, until the reset its error or the read names.
3. Either, until the reset; and a start that hits the limit in its launch window gives the request back at once with that reason, not after the minute.
Pick: 3. The error is fresh, the read covers a machine with no session running; a give-back at once ends the minute per try #1284 saw.

**Q4. A ship whose session a usage limit stopped (#1286).**
Context: the ship stays crewed; its session's turn ended without Stop. Today the ship looks crewed and idle while it can do nothing.
Options:
1. The trierarch keeps the session, marks its turn as ended by the limit, reports the ship (its request status) as waiting on the limit until the reset, hands nothing until then, and then hands what waits.
2. As 1, and at the reset hands the session a line that the limit cleared, so the cut-off work goes on even when no delivery waits.
3. Stop the session and give the request back with the reason, so argo recrews it elsewhere.
Pick: 2. The ship was mid-task: without a line it stays idle until someone sends it something, which is what #1286 saw. The line is the trierarch's, as the hand-over line is, and names no delivery.

**Q5. The delivery a usage limit cut off.**
Context: 0040 and #847: a died turn's delivery is handed once more, and a second death drops it as not handled. A window used up mid-task cuts the turn and, after a quick retry, the once-more turn too.
Options:
1. As today: a limit is a died turn.
2. A limit is no death: the delivery stays confirmed and is handed once more after the reset, its count unchanged. The plugin learns the cause from the hook (Claude Code) or the trierarch tells the store (Codex, which has no hook for it).
3. Reported not handled at once, naming the limit and its reset, so the sender decides.
Pick: 2. The work was not wrong, only early. This touches 0040, so it needs Thomas's word before stage 2.

**Q6. A key that cannot work.**
Context: a key out of credit or refused stays so until a person acts; a rate limit clears by itself within minutes and the harnesses retry it themselves.
Options:
1. Out of credit or refused: that harness is not offered (as Q2), argo told once with the vendor's reason, until the key file changes. Rate limits: left to the harness's own retries; a turn they end is handled as Q4 and Q5 with the retry time as the reset.
2. Every vendor error is a failed start, under #853's 3 in a row.
3. Fall back to the subscription login.
Pick: 1. Option 3 changes what a session spends without a person choosing it (Q7).

**Q7. Both a key and a subscription on one harness.**
Context: H6 decided one login per harness. A key as overflow when the window is used up would keep work going and spend money while nobody watches.
Options:
1. Keep H6: one login per harness, a subscription or a key.
2. A key as overflow, opted into per harness: used only while the subscription window is used up.
3. Key first, subscription as overflow.
Pick: 1. Raised only because #1284 meets it: overflow would answer #1284 with money, and that is the operator's choice to make on purpose, later and in its own design.

**Q8. What the report says a key spent.**
Context: `estimatedCostUsd` is list prices on a subscription; on a key it is near what is billed, but still an estimate (Claude Code's `total_cost_usd` is computed by the CLI; Codex gives tokens only). The proxy (H16) sees each response's usage per ship.
Options:
1. As H17: one `estimatedCostUsd` per ship and model, the harness's `login` beside it says whether it is spent or notional.
2. A separate spent figure for keyed harnesses, counted by the proxy from the vendor's responses.
3. As 1, plus the machine's total on each key since the day began.
Pick: 1. One number with its login is enough to see what a key spends; the vendor's console stays the bill, and spend limits stay #375's.

**Q9. Where a person sees the login.**
Context: H15 states the login in the report details; the console's machine card shows harnesses, versions and what is not offered.
Options:
1. Details only in 0.33.0.
2. The machine card shows each harness's login (`Claude Code · API key`) and the ship's estimated cost on a key, a slice in aeolus-fleet.
Pick: 2. A person must see at a glance which machines spend money; the data is in the details already.

## 5. Next

Once the purpose and these answers are agreed: the detailed decisions, the full flow with its unhappy paths (a window used up mid-turn, at start, at reset with no delivery; a key refused, out of credit, removed while sessions run; the proxy down), the proofs to run first (Q3's error events captured from both harnesses at a real limit; #1286's cause under #26; Codex on a provider of its own) and the slices.
