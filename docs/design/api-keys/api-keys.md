# Sessions on an API key

Design for [#1085](https://github.com/ThomasHendrickx/aeolus-fleet/issues/1085), built in [#265](https://github.com/ThomasHendrickx/aeolus-fleet-trierarch/issues/265). The purpose, decisions and flow describe the shipped behaviour.

It builds on the headless design (aeolus-fleet `docs/design/headless/headless.md`, approved 25 Oct): its hold (H8), clean environment (H10), launch window from events (H13), key file (H15), model proxy (H16) and usage with a key (H17). K2 supersedes H6 and H15 on the choice of login; the implementation builds on the headless design.

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
| A5 | **A ship whose key is not ready before its crew is final gives its crew request back with the cause,** so it can be crewed on another computer. Once the crew is final, it waits here |
| A6 | **A confirmed delivery is not handed again when its turn fails on the key.** Once the key is ready, the next delivery wakes the session. A delivery still held when a turn dies is handed again |

## 3. Why

- **0027, 0026.** Credentials stay on the computer and out of crew requests, the fleet and sessions. The model proxy holds the key.
- **H10, #881.** A clean session environment and checks on harness settings keep the chosen login separate from the other login.
- **H13, #852.** A refused login names its cause.
- **#353, H17.** Cost on a key is near the bill; the vendor's console remains the bill.
- **0032, #445.** Reports carry states and numbers, never keys or paths; secrets enter without echo and are never logged.

## 4. Console

| # | Rule |
| --- | --- |
| K12 | **The console** (aeolus-fleet slice, [mockup](https://claude.ai/artifact/CLGkPAQ8mwoAW5dgiCXFxM) to Thomas first). The computer card already shows the harness login line. The computer card and ship page show the login and cost on the key, and show when a key is not ready and ships wait. Explain list-price estimates and the vendor's bill in a tooltip. |

For the shipped behaviour, including configuration, commands, key states, proxy routing and reports, see the [trierarch's API keys section](https://github.com/ThomasHendrickx/aeolus-fleet-trierarch/blob/main/docs/trierarch.md#api-keys).
