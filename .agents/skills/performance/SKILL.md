---
name: performance
description: Use when designing or building an API, a query, a list or a page that reads data.
---

# Performance

Scale targets:
- Design against about 10,000,000 messages and 3,000 ships per fleet.
- State the scale a feature must hold before building it.

API design:
- Tailor each call to one resource and one need. Split on resource and requirement, never on screen.
- Fetch only what the caller uses.
- Each call is cheap enough for a hot path.

Toolbelt:
- Paginate by default, with a cursor.
- Read a snapshot or rollup instead of recomputing from history.
- A cache states its staleness rule.
- Every list query has an index; no full scan on a request path.
- Run independent calls in parallel, so one slow part does not block the page.

Proof:
- Before release, a performance test at the target scale passes on acceptance, reported in numbers.

UI states:
- Every call has loading, empty, error and partial states, as the `web-frontend` skill's interaction feedback rule says.
