# Agents Guide — shared spec fixtures

`spec/*.tsv` holds the cross-runtime conformance fixtures. All three
runtimes auto-discover and run **every** file in this directory, so a
change here affects TypeScript, Go and Rust together — edit with that in
mind.

`petstore/` holds one OpenAPI 3.1 description twice: `petstore.yaml` as
written, and `petstore.json`, the same document as JSON. Every runtime's
own suite reads both and holds each parse to the standard JSON reading of
`petstore.json`, so the two files must stay the same document. Regenerate
the JSON from the YAML with a YAML 1.2 reader if you change it, and keep
plain scalars free of commas: the comparison is the point of the pair.

## Format

Tab-separated, one case per line, with a header row naming the columns.
Blank lines are skipped, and so are comment lines — a line starting with
`#` that contains no tab. (A data row always has at least one tab, so a
`#`-leading source still works.)

| Column | Meaning |
|---|---|
| `input` | The description text. Escapes `\n` `\r` `\t` `\\` are decoded; any other backslash passes through, so `\u12` reaches the parser as written. |
| `expected` | A JSON value (the parse result), or `ERROR` / `ERROR:<code>` for inputs that must fail. The code is compared **exactly**: it is the error's code, not a substring of its message. |
| `opts` | Optional JSON object of `make` options, `{"strict":true}` for the strict reader. Empty means the default reader. |

`expected` and `opts` are **not** escape-decoded: they are raw JSON, so
JSON's own escape rules apply. Results are compared after a JSON round
trip, so key order and the `OrderedMap` / null-prototype representations
do not affect the comparison.

## The files

| File | What it pins |
|---|---|
| `raw-json.tsv` | JSON text under both readers, and what only the strict reader refuses |
| `raw-yaml.tsv` | YAML under the default reader, its refusal under strict, and the YAML typing rules an OpenAPI author meets |
| `raw-errors.tsv` | the error codes the reference pages name |

Phase 1 of the plan adds raw mode's own files: its root, stream and
version checks, the YAML scalar rules it decides to pin, and the fast
path for JSON text.

## Who runs what

- TypeScript: `ts/test/parity.test.ts` — `makeRunner(...).dir(...)`.
- Go: `go/parity_test.go` — `support.Runner{...}.Dir(t, dir)`.
- Rust: `rs/tests/parity_test.rs` — `tabnas_support::Runner::new_with_row(...).dir(...)`.

Each holds only what is specific to this package: how to build the parser
for a row's `opts`. Everything else (finding `test/spec`, reading the
file, decoding escapes, the `ERROR:` contract, the comparison, the
`<file>:<line>` in a failure message) comes from
[`@tabnas/support`](https://github.com/tabnas/support) and its Go and Rust
halves, so the loaders cannot drift from each other either.

An empty fixture, and a spec directory with no fixtures in it, both
**fail**: a runner that reports green having run nothing is
indistinguishable from coverage that was never there.

## Rules

- Prefer a fixture here over a one-off in-language assertion whenever a
  case is expressible as input to output. That is what keeps the
  runtimes honest against each other.
- A row pins behaviour every runtime agrees on and the project means to
  keep. A base-grammar defect is not pinned as expected behaviour; it is
  recorded in `AGENTS.md` and reported upstream, and raw mode decides
  what to do with it.
- TypeScript is canonical. If the runtimes disagree, the TypeScript value
  is the expected one, unless another port has exposed a TypeScript
  defect, in which case fix TypeScript first and pin the corrected value.
- A new row must pass in ALL THREE runtimes: `npm test` (from `ts/`),
  `go test ./...` (from `go/`) and `cargo test --all-targets` (from
  `rs/`) before it is done.
