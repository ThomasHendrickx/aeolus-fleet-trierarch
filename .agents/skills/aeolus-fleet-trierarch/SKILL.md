---
name: aeolus-fleet-trierarch
description: Mandatory with test-driven-development for every code change in this repository. Layout of the trierarch and the aeolus-fleet plugin, the fleet door, testing and what lint and CI enforce.
---

# The trierarch and the aeolus-fleet plugin

Load with `test-driven-development`; with `domain-modelling` for `packages/trierarch/src/core` and `src/adapters`; with `typescript` for every `.ts`.

Layout:
- `packages/trierarch/src/core`: pure domain, use cases and ports (`ports.ts`); the reconciler and the restart policy decide. A use case is a file in `core` that exports a factory named `create<Name>` (like `createRunPass`).
- `packages/trierarch/src/adapters`: the fleet over REST (`rest-fleet.ts`), the ship sockets, tmux and the container session runtime, git workspaces, the Claude Code and Codex harnesses, the service; `cli/` holds the commands, `bin/` the entry.
- `packages/trierarch/image`: the session image, built from the repository root with `.containerignore`, smoke-tested by `image/test/smoke-test.sh`.
- `plugins/aeolus-fleet`: bash scripts, hooks, commands and the user skills it ships (product, not skills for working here). Its version is set by the release, never by hand.

The doors:
- Core only over `/api/v1`, with `@aeolus-fleet/common` for the shapes. Only the calls aeolus-fleet's `docs/compatibility.md` lists for the trierarch and the aeolus-fleet plugin.
- A call core added later raises `MINIMUM_CORE_VERSION` (`adapters/core-version.ts`) in the same PR.
- The trierarch uses the plugin only through its scripts (`aeolus-identity.sh`, `aeolus-push.sh`); `aeolus-issue.sh` files issues to ThomasHendrickx/aeolus-fleet.

Testing (decision 0014, strict):
- A `test(<context>): <rule> (red)` commit with only tests, then the `feat` or `fix` that makes it pass.
- Unit (`trierarch:unit`, `plugin:unit`): beside the file, with hand-written in-memory fakes of the ports (`packages/trierarch/test/support`); the plugin's scripts against `plugins/aeolus-fleet/test/stub-fleet.ts`, every harness variable foreign (`foreign-harness.setup.ts`). tmux and rootless Podman are real where the machine has them; the systemd unit test runs only with `AEOLUS_TEST_USER_SYSTEMD=1`, as CI sets it.
- Integration (`*.integration.test.ts`): against a real core in process through `@aeolus-fleet/core/testing`, on Testcontainers Postgres from core's global setup.
- End-to-end (`e2e/`): a real Claude Code, Codex or Copilot session in tmux, only with `AEOLUS_PLUGIN_E2E=1`, `AEOLUS_PLUGIN_CODEX_E2E=1` or `AEOLUS_PLUGIN_COPILOT_E2E=1`, never in CI.

Enforced by lint/CI (`eslint.config.js`, `scripts/`): a `feat` or `fix` commit touching `packages/trierarch/src` comes right after a `(red)` commit with only tests (every other commit type passes), a test beside every use case, every test in a Vitest project, npm only, no em dash; in `src/core` no Prisma, pg, Fastify, tRPC, adapter or `@aeolus-fleet/core` import, no clock, crypto, `Math.random` or `throw`; no `vi.mock` anywhere, no `vi.fn` or `vi.spyOn` in `src/core`; casts, exhaustive switches, parameter count, boolean names, default exports, file names. CI also builds and smoke-tests the session image, and runs the unit layers on macOS on pushes.
