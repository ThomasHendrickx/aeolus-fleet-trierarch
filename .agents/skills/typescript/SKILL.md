---
name: typescript
description: Use for every .ts or .tsx change. Types, errors, validation, naming.
---

# TypeScript

- No `any`, casts, `!` or `@ts-ignore`. `@ts-expect-error` only when a library forces it, with the reason.
- Ids: branded types per entity (`ShipId`), never `string`. Parse them at the edge.
- Closed sets: literal unions; switches exhaustive.
- Readonly inputs; return new values, never mutate.
- Business outcomes are values: `Result<T, E>`, `E` a union of `{ kind: '...' }`. Throw only for system failures. The API adapter maps kinds to API errors in one place.
- Outside data (HTTP, env, DB rows, tool args) is `unknown` until a shared schema parses it at the edge. Trust types after.
- Names from the domain language, no synonyms. No abbreviations beyond `id url api db`. Named constants, no magic numbers. Booleans read as questions (`isHeld`).
- Comments say why. Top-of-file doc comment for non-trivial files. No commented-out code.
- One primary export per file, named; a default export only where the framework requires one (pages, stories).
