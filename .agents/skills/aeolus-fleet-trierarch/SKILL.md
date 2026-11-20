---
name: aeolus-fleet-trierarch
description: Mandatory with test-driven-development for every code change in this repository. Layout of the trierarch and the aeolus-fleet plugin, the fleet door, testing and what lint and CI enforce.
---

# The trierarch and the aeolus-fleet plugin

Load with `test-driven-development`; with `domain-modelling` for domain logic and adapters; with `typescript` for every `.ts`.

Layout:
- `image`: the session image, built from the repository root with `.containerignore`, smoke-tested by `image/test/smoke-test.sh`.
- `go/`: the Go trierarch; `cmd/aeolus-trierarch` is the entry and `internal/` holds its parts. It embeds `internal/config/config.schema.json`. The contract suite builds and runs it by default; `AEOLUS_TRIERARCH_UNDER_TEST` can name a built binary.
- `plugins/aeolus-fleet`: bash scripts, hooks, commands and the user skills it ships (product, not skills for working here). Its version is set by the release, never by hand.

The doors:
- Core only over `/api/v1`, with `@aeolus-fleet/common` for the shapes. Only the calls aeolus-fleet's `docs/compatibility.md` lists for the trierarch and the aeolus-fleet plugin.
- A call core added later raises `MINIMUM_CORE_VERSION` in the fleet adapter in the same PR.
- The trierarch uses the plugin only through its scripts (`aeolus-identity.sh`, `aeolus-push.sh`); `aeolus-issue.sh` files issues to ThomasHendrickx/aeolus-fleet.

Testing (decision 0014, strict):
- A `test(<context>): <rule> (red)` commit with only tests, then the `feat` or `fix` that makes it pass.
- Unit: Go tests beside each package, and `plugin:unit` for plugin scripts against `plugins/aeolus-fleet/test/stub-fleet.ts` with every foreign harness variable set.
- Integration (`*.integration.test.ts`): against a real core in process through `@aeolus-fleet/core/testing`, on Testcontainers Postgres from core's global setup.
- Contract (`contract/`, `contract:integration`): a trierarch run as a program on a stand-in machine (its harnesses and systemd stand-ins on PATH), against core in process; it imports none of the trierarch's modules. `AEOLUS_TRIERARCH_UNDER_TEST` names another trierarch's command; without it the suite builds and runs today's. Linux only.
- End-to-end (`e2e/`): a real Claude Code, Codex or Copilot session in tmux, only with `AEOLUS_PLUGIN_E2E=1`, `AEOLUS_PLUGIN_CODEX_E2E=1` or `AEOLUS_PLUGIN_COPILOT_E2E=1`, never in CI.

Enforced by lint/CI (`eslint.config.js`, `scripts/`): a `feat` or `fix` commit touching `go/` comes right after a `(red)` commit with only tests (every other commit type passes), every test in a Vitest project, npm only, no em dash; no `vi.mock` anywhere, casts, exhaustive switches, parameter count, boolean names, default exports, file names. CI also builds and smoke-tests the session image, and runs the unit layers on macOS on pushes.
