---
name: test-driven-development
description: Use for every code change. Red-green-refactor with commit evidence, test layers, and what makes a test worth keeping.
---

# Test-driven development

No production code without a failing test that demands it.
No code can be written before the test is clear and expected behaviour set. Strict red, green, refactor is the order of the work, not of the commits: a test written after the code is noted, not blocking; never rewrite git history to show the test first.

Loop per behaviour, one vertical slice at a time:
1. Red: one test at the public interface, run it, see it fail for the right reason. Commit `test(<scope>): <rule> (red)` with only the test.
2. Green: least code to pass, run it by name. Commit `feat(<scope>): <rule>` (or `fix`).
3. Refactor with tests green, in the green commit or as `refactor(<scope>): ...` right after it.
Push green heads only. One tiny rule may batch several tests.

Layers:
- Unit (beside the file): domain logic and use cases through their interface. Ports get hand-written in-memory fakes, no mocking library. Fake only system boundaries (database, network, clock, ids, vendors), never your own modules. Assert outcomes and stored state, not calls.
- Integration: every adapter that touches a database runs against a real database in a container.
- End to end (few, critical journeys): interact via `data-testid="{area}-{element}"`, assert via role or text.

Rules:
- Name tests as the rule, in domain language: `refuses a second claim while a lease is held`.
- One outcome per test; inputs from named factories (`aShip(...)`); inject clock and id generator.
- Expected values come from an independent source (a literal, a worked example, the spec), never recomputed the way the code computes them.
- A test that breaks on a refactor without a behaviour change is coupled to internals: rewrite it at the interface.
- Each rule: happy path, every failure, boundaries (exact limit and one over).
- Every invariant has a test that fails if the rule is removed. A guarantee without a test does not exist.
- Done: typecheck, lint and tests green; new tests appear by name in the output.
