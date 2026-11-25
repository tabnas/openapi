# Agents Guide — shared spec fixtures

`spec/*.tsv` holds the cross-runtime conformance fixtures. All three
runtimes auto-discover and run **every** file in this directory, so a
change here affects TypeScript, Go and Rust together — edit with that in
mind.

`resolve/` holds the resolver's fixtures: an input description, the
resolved tree, the references left as written (`at why`), the cut edges,
and `resolve` options, or `ERROR:<code>` for an error `resolve` raises.
Five columns are optional: `select`, a path whose value in the resolved
tree is held to `expected` in place of the whole tree; `connections`,
the connections report as one `kind at -> target` line per row (`!why`
for a target not found, then any flags, `from=` among them);
`provenance`, one `at status -> landing` line for each reference (`-`
for one that lands nowhere, then `through=`, `uri=`, `fragment=` and
`conflict=` where the row has them); `dialects`, one
`at dialect as name` line for each dialect the description declares
(then ` unknown` for one this package does not know); and `urls`, one
`at base value -> uri` line for each URL the description gives (`-`
for one with no absolute form). Report arrays are in walk order, so a row's order is part of what
it pins. `landings.tsv` holds the shapes the site index repaired, W1 to
W3 of the plan, with the depth code of W6 and the reports' order.
`dialects.tsv` holds the rules of each schema dialect, W4 of the plan,
and `uris.tsv` the comparison of URIs in their normal form, W5.
`reports.tsv` holds the three reports of T3's fourth item: the implicit
mapping of a discriminator, a reference that lands on a type it does
not expect, and the URLs. `versions.tsv` holds the version a
description is read by. `probes.tsv` holds the probes of the audit that
are about references, each under a `# Probe n.n.` comment with the
audit's own input, and before them one row with every member a
`provenance` row gained in T3.
`apidef.tsv` is rows 2 to 25 of @voxgig/apidef's `parse-resolve.tsv`,
under `compat: 'apidef'`, with apidef's own select paths and values;
keep it in step with apidef's file rather than editing its expected
values. `apidef-extra.tsv` is this repository's own: the shapes where
apidef's reading of a reference parts from the specification's, each
expected value being what apidef's own resolver gives. Before adding or
changing a row of either, run `node tools/apidef-preset.cjs <apidef
checkout> --ref 3b24341 --sets rows --rows <the file>`, which holds
every row to that resolver. Under `cycles: 'keep'`, which the preset
sets, the report arrays are in document order. They run in
`ts/test/resolve-spec.test.ts`.

Two more columns are optional there: `operations`, one line for each
operation of the view that the row's options ask for, and `ignored`,
one `what at name` line for each thing the specification says to
ignore. The runner's own comment has the format of each. Every value a
view gives is held to the resolved tree at its place, whatever the row
pins. `operations.tsv` holds the view and the `ignored` report, and
`templates.tsv` the rows of `connections` that read a template or a
runtime expression, which say the name after the place.

`expression/` holds the fixtures of the readers of runtime expressions
and templates, a file for each function: `expression-read.tsv` for
`readExpression`, `template-read.tsv` for `readTemplate`, with the kind
in a third column, and `expression-eval.tsv` for `evaluateExpression`,
with the exchange as JSON and `UNDEFINED` for no value. They run in
`ts/test/expression-spec.test.ts`, which fails when a file there has no
runner.

`model/` holds the object model's fixtures, `classify.tsv`: a version, an
RFC 6901 pointer and the state the classifier must reach. They run in
`ts/test/model.test.ts`, outside `spec/` because they test the model, not
a parse.

`pending/` holds parse fixtures in the format of `spec/`, for what only
the TypeScript package's `parse` gives yet: `parse-duplicates.tsv`, the
`duplicates` option; `parse-reading.tsv`, what `reading: 'spec'` gives
where it parts from the base reading; `parse-limits.tsv`, the alias
budget and the size limit; `parse-mark.tsv`, a byte-order mark under
`strict`; and `parse-probes.tsv`, the probes of the audit that are
about reading a text, each under a `# Probe n.n.` comment with the
audit's own input. A row there with no options pins a default that no
row of `spec/` pins. They run in `ts/test/pending.test.ts`, under the
same runner as `spec/`. "Where a new fixture goes", below, says why they
are not in `spec/`, and when they move there.

`ts/test/probes.test.ts` holds `pending/parse-probes.tsv` and
`resolve/probes.tsv` to the list of probes in section 3 of
[`../docs/design/prototype/e8-spec-probes.result.md`](../docs/design/prototype/e8-spec-probes.result.md):
every probe there has a row in one of the two files, and neither has a
row for a probe the audit lacks.

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
never edit either by hand. `ledger-spec.tsv` and `baseline-spec.json`
are the same record under `reading: 'spec'`, written by the sweep with
`--reading spec`. `accepted.tsv` is the one file there a person
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
| a parse only the TypeScript package gives: a new option, a new code, a default no `spec/` row pins | `pending/`, in the format of `spec/` | `ts/test/pending.test.ts` |
| what `resolve` gives | `resolve/` | `ts/test/resolve-spec.test.ts` |
| the object model | `model/` | `ts/test/model.test.ts` |
| a description in several files | `docs/<case>/` | `ts/test/documents-spec.test.ts` |
| what `readExpression`, `readTemplate` or `evaluateExpression` gives | `expression/` | `ts/test/expression-spec.test.ts` |
| what `bundle` writes of several documents | `bundle/<case>.json` | `ts/test/bundle-spec.test.ts` |
| a set of documents that a generator failed `bundle` on | `bundle-held/<what was wrong>.json` | `ts/test/bundle-spec.test.ts` |

A case of `docs/` is a folder: the documents as files, and `case.json`.
That file names the `entry` document and the `retrievalUri` it was
retrieved from, gives each other document in `documents` by the URI it
was retrieved from, and says what `resolve` makes of them: the entry's
resolved `tree`, the `unresolved` and `cuts` rows, and each site in
`sites` as its document, where it is, its target's document, its
target and its status, a document being `""` where it is the entry or
the site's own. `source` says where the case comes from, and `options`,
when present, is given to `resolve`. Every file of a folder must be one
the case names. The first five are the examples of OpenAPI 3.2.0's
Appendix F and Appendix G, written as the specification writes them.
`bundle` is what `bundle` writes of the same documents, in the form
that a case of `bundle/` has it.

A case of `bundle/` is one JSON file: a `note` that says what the case
shows, the `entry` document and its `retrievalUri`, each other
document in `documents` by its URI, the `options` if any, and what
`bundle` gives. That is the bundle's `tree`, and each row of its
reports as a list: an `embedded` row is its place, its document, its
place there and how it was brought in; a `left` row its place, its
text and why; a `dialects` row its place and the dialect. The runner
also holds each case to three things that no case writes down. The
bundle resolves to what the documents resolve to, which
[`tools/corpus/bundle-agree.cjs`](../tools/corpus/bundle-agree.cjs)
checks, and which the cases of `docs/` are held to as well. No
document is changed. And the bundle, bundled again, is itself. So read
the `tree` of a new case by hand for what it should be, and leave
whether it means the same to the runner. A rule of `bundle` that a
review found has a case here under a name of its own: `occupied`,
`hoped`, `seat`, `one-identifier`, `two-identifiers`, `type` and the
rest. `ts/test/bundle.test.ts` has what a case cannot carry: the sets
of documents that three generators write, and the bundles that the
check has to fail.

A file of `bundle-held/` is for one thing that was wrong: a `note`
that says what, the `retrievalUri` of the entry, and `sets`. Each set
is an `entry`, its `documents` and its `options` if any, as a
generator wrote it and cut down to what failed. No set says what
`bundle` gives. The runner holds each to what every bundle is held to:
it resolves to what the documents resolve to, no document is changed,
and it is its own bundle unless it lists a part under `type`. A set
that a generator fails on goes here once it is repaired, in the file
of its cause or a new one, so that a seed that is no longer run still
counts.

A folder is not made ahead of its contents, because a fixture folder
with nothing in it fails here, as an empty fixture does. When porting
starts, a file in `pending/` moves to `spec/` as it is, and every suite
runs it from then on.

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
