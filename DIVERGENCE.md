# Divergences

TypeScript in [`ts/`](ts/) is canonical; the Go port in [`go/`](go/) and
the Rust port in [`rs/`](rs/) track it. This file records where a runtime
produces a **different result for the same input** in this package, and
why that difference is allowed to stand.

## Where these are pinned

Each entry is measured, not inferred from the source, and each runtime's
side is pinned in that runtime's own suite: a shared fixture row pins
the TypeScript value, and `goDivergent` in `go/parity_test.go` holds Go
to its own value for the same row. A pin fails when its runtime starts
to give the fixture's value, so a repair upstream forces the entry's
deletion here, with its pin, in the same change.

The Rust column is filled in when the Rust port of raw mode lands.

## Two JSON maps on two lines

`{"a":1}` and `{"b":2}` on consecutive lines, `raw-fast.tsv`, all three
fast settings (the fast path refuses the text, so the grammar decides).

| Runtime | Result |
|---|---|
| TypeScript | `unexpected` at 2:1 |
| Go | `openapi_root` at 1:1: the Go yaml grammar reads the two maps as a list |

A YAML document has one root node, so the text is an error; TypeScript
gives the right code. **Repair: the Go yaml grammar** (tabnas/yaml, Go
port 0.5.27). Pinned: the row (TypeScript), `goDivergent` (Go).

## JSON text after a blank first line

`\n{"a":1}` with `{"fast":false}`, `raw-json.tsv`. On the default fast
path every runtime reads it.

| Runtime | Result |
|---|---|
| TypeScript | `unexpected` at 2:1 |
| Go | `{"a":1}` |

The text is valid JSON and valid YAML; Go is right. **Repair: the
TypeScript yaml grammar** (tabnas/yaml, 0.5.27). Pinned: the row, which
holds the defect so that its repair shows (TypeScript), and
`goDivergent` (Go).

## Values the fixtures cannot carry

These are measured, and asserted in each runtime's package tests, since
the fixtures' JSON round trip cannot hold them:

- A lone surrogate escape, `"\ud800"`: TypeScript keeps the lone
  surrogate; Go gives U+FFFD, on both paths and under strict, since a Go
  string cannot hold one. The engine's own divergence record covers it.
- `1e400` under strict: TypeScript gives `Infinity`; Go's strict json
  grammar refuses it as `unexpected`, deliberately, as the json
  repository records. Without strict, both give an infinity on both
  paths.
- Member order: TypeScript enumerates integer-like member names first,
  as every JavaScript object does; Go keeps document order. The fixtures
  compare without order.

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
