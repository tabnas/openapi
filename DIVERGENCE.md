# Divergences

TypeScript in [`ts/`](ts/) is canonical; the Go port in [`go/`](go/) and
the Rust port in [`rs/`](rs/) track it. This file records where a runtime
produces a **different result for the same input** in this package, and
why that difference is allowed to stand.

## None known

The package adds no grammar of its own yet: each runtime reads a
description with jsonic and yaml, or with json under `strict`, and the
shared fixtures in [`test/spec/`](test/spec/) pass unchanged in all
three. No difference has been measured between the runtimes on them.

## What reaches this package from below

The base grammars record their own divergences in their own
repositories: [parser](https://github.com/tabnas/parser),
[json](https://github.com/tabnas/json),
[jsonic](https://github.com/tabnas/jsonic) and
[yaml](https://github.com/tabnas/yaml). Each reaches this package
unchanged wherever a description can contain the input that triggers it,
deep nesting and unpaired surrogate escapes among them.

Phase 1 of the plan measures which of those a description can meet,
through all three runtimes, and records each one found here: with its
measurement, the repository that owns the repair, and the test that pins
this package's side of it.

## Recording one

A divergence found in this package goes here in the same change that
finds it, measured through all three runtimes, never inferred from
reading the source. Where it can be written as an input and one value
per runtime, it also gets a row in an executable register under
`test/spec/` that asserts every runtime's column, so a repair fails as
loudly as a regression and forces the row's deletion. Repairing one means
deleting its entry and its test in the same change.
