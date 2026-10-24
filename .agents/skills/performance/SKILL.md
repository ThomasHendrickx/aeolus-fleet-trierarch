---
name: performance
description: Use when designing or building an API, a query, a list or a page that reads data.
---

# Performance

Scale targets:
- Design against about 10,000,000 messages and 3,000 ships per fleet.
- State the scale a feature must hold before building it.
- Budget per read at those targets: p95 under 100 ms, p99 under 500 ms, errors under 1%.

API design:
- Tailor each call to one resource and one need. Split on resource and requirement, never on screen.
- Fetch only what the caller uses.
- Shared parts every page shows (navigation, layout, header) read counts only, never a list.
- Each call is cheap enough for a hot path.

Toolbelt:
- Paginate in the database query, with a cursor; never page in memory after reading every row.
- A client never fetches every page; it fetches the next page when the user asks for it.
- Filters, search, sort and counts run in the same database query, never in the client.
- A screen asks for a page that fits it: 20 rows.
- Lists default to active only; retired rows stay out of every read.
- Never keep a copy of a whole collection in the client to filter, count or look up. Look up referenced rows by id, in batches.
- Read a server-side rollup instead of recomputing from history.
- A cache states its staleness rule.
- Every list query has an index; no full scan on a request path.
- Run independent calls in parallel, so one slow part does not block the page.

Live updates:
- An event reloads only the rows it concerns and the counts it changes, never the whole list.
- A new or changed row outside the loaded pages shows first and highlighted while it matches the view's search and filters, until the next refresh.

Proof:
- A change that touches a read at scale is measured on demand with the staging performance run, reported in numbers.
- Server reads count too: a route or server action that reads every row is a page that reads every row. Measure server reads, not only what the browser asks.
- Measure once a piece of work is finished (all its PRs merged), not per PR.
- A read over budget once is rerun before it goes back to its builder.

UI states:
- Every call has loading, empty, error and partial states, as the `web-frontend` skill's interaction feedback rule says.
