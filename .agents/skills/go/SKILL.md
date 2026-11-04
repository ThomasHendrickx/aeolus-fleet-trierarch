---
name: go
description: Use for every .go change. Errors, interfaces, packages, concurrency, tests, naming.
---

# Go

- `gofmt`, `go vet` and `staticcheck` clean; the standard library before a dependency.
- Errors are values: return them, never panic for expected failures. `panic` only for programmer bugs and impossible states, never across a package boundary.
- Wrap with context: `fmt.Errorf("load ship %s: %w", id, err)`. Callers test with `errors.Is`/`errors.As`, never by string. Messages are lowercase, unpunctuated. Handle an error once: log or return, not both.
- Business outcomes are sentinel or typed errors (`var ErrNotFound`), part of the package API. The API adapter maps them to responses in one place.
- Ports: the consuming package declares the interface, one to three methods; adapters satisfy it implicitly and never export an interface for the caller to use. Accept interfaces, return concrete types. Don't define an interface before a consumer needs it.
- Packages by purpose, named for what they provide (`ship`, `lease`), not `util`/`common`/`models`. Adapters in their own packages; private code under `internal/`. Names are lowercase, singular, no underscores.
- `context.Context` first parameter on anything that blocks or does I/O; never store it in a struct. Propagate it, don't replace with `Background` mid-call.
- Every goroutine has an owner and a way to stop (context, closed channel, `errgroup`); know when it exits. The sender closes the channel. Guard shared state with a mutex or own it in one goroutine.
- Zero values useful; return early, keep the happy path unindented. Pass small structs by value, pointers for mutation or size. Prefer `var s []T` over `[]T{}`.
- Names: `MixedCaps`, initialisms uniform (`ID`, `URL`, `HTTP`), no `Get` prefix, no stutter (`ship.Ship`, not `ship.ShipModel`). Short names in short scopes; a one-method interface is `Method`+`er`. Receivers are one or two letters, same on every method.
- Doc comments are full sentences starting with the name, on every exported identifier; comments say why.
- Tests are table-driven with `t.Run` and run with `-race`. Failure messages say input, got, want: `f(%v) = %v, want %v`. Fake ports in-package; mark helpers with `t.Helper()`. Keep `t.Fatal` to the test goroutine.
