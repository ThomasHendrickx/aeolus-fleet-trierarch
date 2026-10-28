# Sessions on an API key

Design for [#1085](https://github.com/ThomasHendrickx/aeolus-fleet/issues/1085), for Aeolus 0.33.0. Stage 1: purpose, lessons, questions. No detailed decisions until the purpose is agreed.

It builds on the headless design (aeolus-fleet `docs/design/headless/headless.md`, approved 25 Oct), whose H6, H7 and H15 to H17 already say where a key lives and how it reaches a session; its slice S5 builds them.

## 1. Purpose (to agree)

In Thomas's words: "The whole setup is to use api keys of anthropic. I would choose to either use the api key, or the use the subscription for a set of ships", and "it is not purely anthropic, codex as well since we support that".

So: a session the trierarch crews can run on an API key instead of its harness's subscription (Claude Code on an Anthropic key instead of the Claude subscription, Codex on an OpenAI key instead of the ChatGPT login), and the person who runs the trierarch chooses which ships run on the key and which on the subscription. The key stays on the machine; what the key spends shows per ship.

Not the purpose:
- Running out of a subscription window or a usage limit (#1284, #1286): their own issues.
- Spend limits, model governance or placement by cost: the trierarch plugin's (#375).
- Gateways and providers other than the harness's own vendor.

## 2. Lessons to check against

Where a key lives and never travels:
- **0027.** A crew request and the fleet carry no credential and no path; the machine's own access only. A ship's choice of login may travel (it is no secret); the key never.
- **0026.** A session holds no fleet credential; the trierarch keeps it. A key is kept the same way: by the trierarch, out of the session.
- **H6, H15.** A key file per harness, `~/.aeolus/trierarch/keys/<harness>`, mode 600, written by `aeolus-trierarch login <harness> --api-key` from stdin, removed by `--subscription`. One login per harness per machine. The report states `apiKey` or `subscription`, never the key. A choice per ship (Q1) reopens "one login per harness": Q2.
- **H7, H16, 0039's rejected credential proxy.** A model proxy on the machine holds the key; each session gets a random token of its own and the proxy's loopback address, forwarded only to Anthropic and only while that session runs. The key in the session's environment or an `apiKeyHelper` would put it where the session can read it.
- **H10, #881.** The hold builds the session's environment from nothing; the login is one named entry, never inherited.
- **#445.** A container gets its secret through an env file, never a command line, never in `config.json`.
- **`init`.** A secret is read without echo or from stdin, never a flag, never logged.

How the harnesses take a key versus a subscription (vendor docs as cited in the headless design; to check again before stage 2):
- Claude Code, subscription: the machine's `claude` login, or `CLAUDE_CODE_OAUTH_TOKEN` (today's `model-token` for containers). Billed to the plan, limited by its windows.
- Claude Code, key: `ANTHROPIC_API_KEY`, `apiKeyHelper`, or `ANTHROPIC_AUTH_TOKEN` with `ANTHROPIC_BASE_URL` (the proxy's route, H16). Billed per token to the Console account; rate limits and a credit balance, no windows.
- Claude Code precedence: an API key or auth token wins over the subscription login. So the choice is made by what the trierarch puts in the session's environment, per session, and a key left in reach silently moves a ship onto the bill.
- Codex, subscription: the ChatGPT login (`codex login`), with 5-hour and weekly windows. Key: `codex login --with-api-key`, the key in `codex exec`'s environment, or a provider of its own (`model_providers.<id>.base_url` with `env_key`), the proxy's route. Billed per token to the OpenAI project; rate limits and quota, no windows. `turn.completed` carries tokens, no cost. To prove before building: hooks, model probes and `codex exec resume` work alike on that provider, and the model catalog is the key's (#392).
- A key changes no hook, so the plugin's part (H5) holds; the subscription probe and the detection probes cost money on a key (H17).

Cost visibility:
- **H17.** On a key: no windows to read; tokens per model from the transcripts as today; cost from Claude Code's `total_cost_usd` or the configured `prices` (Codex: `prices` only).
- **#353.** `estimatedCostUsd` on a subscription is notional (list prices), on a key it is near the bill; the Console stays the bill.
- **0032.** The report carries numbers, never paths or content.

## 3. Questions

**Q1. Where the choice is made: per ship on a trierarch, a trierarch setting, or something else.**
Context: Thomas's question, the same for both harnesses. Today H6 makes it a machine setting per harness. Thomas wants it "for a set of ships". The key itself stays on the machine in every option.
Options:
1. A trierarch setting: every Claude Code session on that machine uses the key, or none does (H6 as is). A set of ships means a machine of their own.
2. Per ship on the trierarch: its configuration names the ships that run on the key; every other ship runs on the subscription.
3. Per ship in the fleet: a ship type or label says "API key"; placement sends it only to a trierarch that has a key for that harness; the trierarch reads it from the crew request. Needs core and the trierarch plugin.
4. A trierarch default plus per ship exceptions in its configuration (1 and 2 together).
Pick: 4. It answers "for a set of ships" with no core change and no credential near the fleet, and a machine that is all key or all subscription is the default with no list. Option 3 can follow when argo must place by login.

**Q2. Both logins on one machine at once.**
Context: Q1 options 2 to 4 need a machine to run some sessions on the key and some on the subscription at the same time, which H6 ("one login per harness") rules out. H6 is a recorded decision of the headless design, so this needs Thomas's word.
Options:
1. Lift H6: a machine may hold a key and a subscription login together; the choice per session decides which a session gets.
2. Keep H6: only Q1 option 1.
Pick: 1. It is what the purpose asks; a session gets one login, never both, so nothing falls back from one to the other unseen.

**Q3. When a change of choice takes effect.**
Context: a session's login is fixed when it starts. Moving a ship from subscription to key while it works means a new session.
Options:
1. At the ship's next session start; a running session keeps its login.
2. At once: the trierarch ends the session and starts it again on the new login.
Pick: 1. Ending a session mid-turn risks its work for a billing choice that can wait.

**Q4. Where a person sees which ships spend the key.**
Context: H15 puts the login per harness in the report details; with Q1 the login is per ship.
Options:
1. The report states each ship's login beside its `estimatedCostUsd`; the console shows it in the details only.
2. As 1, and the machine card and the ship show `API key` and the ship's cost, a slice in aeolus-fleet.
Pick: 2. The point of choosing per ship is to see what each one spends without opening details.

## 4. Next

Once the purpose and these answers are agreed: the detailed decisions, the full flow with its unhappy paths (no key on the machine for a ship that asks for one; a key refused or out of credit; a key removed while sessions run; the proxy down) and the slices.
