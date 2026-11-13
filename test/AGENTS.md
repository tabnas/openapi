# Agents Guide — shared spec fixtures

`spec/*.tsv` holds the cross-runtime conformance fixtures. All three
runtimes auto-discover and run **every** file in this directory, so a
change here affects TypeScript, Go and Rust together — edit with that in
mind.

`resolve/` holds the resolver's fixtures: an input description, the
resolved tree, the references left as written (`at why`), the cut edges,
and `resolve` options, or `ERROR:<code>` for an error `resolve` raises.
Two columns are optional: `select`, a path whose value in the resolved
tree is held to `expected` in place of the whole tree, and
`connections`, the connections report as one `kind at -> target` line
per row (`!why` for a target not found, then any flags). Report arrays
are in walk order, so a row's order is part of what it pins.
`apidef.tsv` is rows 2 to 25 of @voxgig/apidef's `parse-resolve.tsv`,
under `compat: 'apidef'`, with apidef's own select paths and values;
keep it in step with apidef's file rather than editing its expected
values. They run in `ts/test/resolve-spec.test.ts`.

`model/` holds the object model's fixtures, `classify.tsv`: a version, an
RFC 6901 pointer and the state the classifier must reach. They run in
`ts/test/model.test.ts`, outside `spec/` because they test the model, not
a parse.

`petstore/` holds one OpenAPI 3.1 description twice: `petstore.yaml` as
written, and `petstore.json`, the same document as JSON. Every runtime's
own suite reads both and holds each parse to the standard JSON reading of
`petstore.json`, so the two files must stay the same document. Regenerate
the JSON from the YAML with a YAML 1.2 reader if you change it, and keep
plain scalars free of commas: the comparison is the point of the pair.

`corpus/` is a record, not a set of fixtures. It holds what the corpus
sweep found over real documents: `ledger.tsv`, one row per way a document
fails, and `baseline.json`, the sweep's headline figures.
`node tools/corpus/sweep.cjs --write` writes both from a finished run, so
never edit either by hand. `accepted.tsv` is the one file there a person
writes: the ledger rows that are not this package's defect, each with its
reason. The documents themselves are fetched, not committed, and the
sweep is run by hand. `npm test` runs `ts/test/corpus-tool.test.ts`,
which holds the tool's own code on small inline documents, and the
committed files to their format and to each other.
[`tools/corpus/README.md`](../tools/corpus/README.md) says how to run the
sweep and how to read a row that moved.

## Where a new fixture goes

`spec/` is the one folder every suite reads, so it holds only what every
suite agrees on. Until porting starts, the TypeScript package moves ahead
of the others, and what it gains is pinned outside `spec/`. The rule is
section 5 of
[`../docs/design/typescript-plan.md`](../docs/design/typescript-plan.md):

| The fixture pins | Where it goes | What runs it |
|---|---|---|
| a parse that every suite gives today | `spec/` | every runner |
| a parse only the TypeScript package gives: a new option, a new code | `pending/`, in the format of `spec/` | a TypeScript runner |
| what `resolve` gives | `resolve/` | `ts/test/resolve-spec.test.ts` |
| the object model | `model/` | `ts/test/model.test.ts` |
| a description in several files | `docs/<case>/` | a TypeScript runner |

Two of those folders are not on disk yet. `pending/` arrives with its
first fixture and `docs/` with the first case of several files, and each
brings its runner in the same change. Neither is made ahead of its
contents, because a fixture folder with nothing in it fails here, as an
empty fixture does. When porting starts, a file in `pending/` moves to
`spec/` as it is, and every suite runs it from then on.

Two things hold until then:

- **No row is added to `spec/` for behaviour only the TypeScript package
  has.** The other suites would run it and fail.
- **No default that a `spec/` row pins changes.** A new reading arrives
  as an option that is off by default. Its change to the default is one
  coordinated change to the shared rows, made when porting starts.

A base grammar's repair that turns a `spec/` row red is the exception
the rules below already cover: the row is updated, and every suite moves
to the release that carries the repair, in one pull request.

## Format

Tab-separated, one case per line, with a header row naming the columns.
Blank lines are skipped, and so are comment lines — a line starting with
`#` that contains no tab. (A data row always has at least one tab, so a
`#`-leading source still works.)

| Column | Meaning |
|---|---|
| `input` | The description text. Escapes `\n` `\r` `\t` `\\` are decoded; any other backslash passes through, so `\u12` reaches the parser as written. |
| `expected` | A JSON value (the parse result), or `ERROR` / `ERROR:<code>` for inputs that must fail. The code is compared **exactly**: it is the error's code, not a substring of its message. |
| `opts` | Optional JSON object of `parse` options: `{"strict":true}` for the strict reader, `{"fast":false}` to keep JSON text off the fast path. Empty means the defaults. |

`expected` and `opts` are **not** escape-decoded: they are raw JSON, so
JSON's own escape rules apply. Results are compared after a JSON round
trip, so key order and the `OrderedMap` / null-prototype representations
do not affect the comparison.

## The files

| File | What it pins |
|---|---|
| `raw-json.tsv` | JSON text under both readers, and what only the strict reader refuses |
| `raw-yaml.tsv` | YAML under the default reader, its refusal under strict, and the YAML typing rules an OpenAPI author meets |
| `raw-errors.tsv` | the engine's codes the reference pages name, and the plugin's `openapi_root`, `openapi_stream` and `openapi_duplicate_key` |
| `raw-versions.tsv` | version detection: lenient by default, `openapi_version` under strict |
| `raw-fast.tsv` | JSON text the fast path and the grammar must read to one tree; every runner runs it three times, with the row's options and with `fast` forced on and off |
| `raw-yaml-scalars.tsv` | what the published yaml grammar makes of plain scalars, YAML 1.1 forms included |

Every row runs through each runtime's `parse` wrapper, never the
engine's own parse, since only the wrapper raises the plugin's codes.

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
- A row pins behaviour every runtime agrees on. Where that behaviour is a
  base grammar's defect or a YAML 1.1 rule a description can meet, the
  row says so in a comment above it and stays: its repair upstream then
  turns the row red here, which is how this repository finds out. Report
  the defect upstream as well.
- A value JSON cannot carry (an infinity, `NaN`) or that the runtimes
  give differently (a lone surrogate) cannot be a row. Pin it in each
  runtime's own tests, and record a difference in `DIVERGENCE.md`.
- TypeScript is canonical. If the runtimes disagree, the TypeScript value
  is the expected one, unless another port has exposed a TypeScript
  defect, in which case fix TypeScript first and pin the corrected value.
- A new row must pass in ALL THREE runtimes: `npm test` (from `ts/`),
  `go test ./...` (from `go/`) and `cargo test --all-targets` (from
  `rs/`) before it is done.
