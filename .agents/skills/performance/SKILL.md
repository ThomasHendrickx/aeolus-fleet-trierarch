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
- Paginate in the database query, with a cursor; never page in memory after reading every row.
- A client never fetches every page; it fetches the next page when the user asks for it.
- Filters, search, sort and counts run in the same database query, never in the client.
- A screen asks for a page that fits it: 20 rows.
- Read a snapshot or rollup instead of recomputing from history.
- A cache states its staleness rule.
- Every list query has an index; no full scan on a request path.
- Run independent calls in parallel, so one slow part does not block the page.

Proof:
- A change that touches a read at scale is measured on demand with the staging performance run, reported in numbers.

UI states:
- Every call has loading, empty, error and partial states, as the `web-frontend` skill's interaction feedback rule says.
