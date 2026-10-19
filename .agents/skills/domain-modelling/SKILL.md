---
name: domain-modelling
description: Use for server domain logic, use cases, ports and adapters, and data models. Where each piece of server logic belongs.
---

# Domain modelling

Ports and adapters. The domain holds the model, use cases and ports, with no framework, ORM, driver or API imports. The repo's companion skill names the code shape and folders.

- Everything named in the domain language; one concept per file, test beside it.
- Value objects: immutable, built only by a validating function. Trusted afterwards.
- Every invariant lives in the domain model. Database constraints are backup only.
- Use cases: load, call the model, store, record events, one unit of work. A business rule found in a use case belongs in the model.
- Events: past tense, named from the domain's event list (add one there first). Written in the same unit of work as the state change.
- Ports: interfaces in the domain, named for the need (`ShipRepository`), never for a vendor; vendor types stay out of domain signatures. Every method takes the tenant scope.
- Deep modules: a small interface over a lot of behaviour. Deletion test: if deleting a module only moves its complexity into its callers, it earns its place; if the complexity vanishes, it was a pass-through.
- Adapters translate only. API adapter: parse with the shared schema, resolve caller, check scope, call one use case, map the result.
- Caller and tenant come from auth, never from the request body.
- Bounded contexts talk only through a published port, never through each other's model or repositories.
- Derive what other persisted data computes; a stored copy is a second source of truth. A relationship that carries its own data (an amount, a status) is a record of its own.
