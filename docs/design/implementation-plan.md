# Implementation plan: `@tabnas/openapi`

A plan to take this repository from the ZON template it was copied from
to a published OpenAPI parser plugin for the tabnas family, in all three
runtimes, with a verbatim raw tree and a derived resolved tree, and to
move `voxgig/apidef` onto it. It is the companion to the design note
[`expr-for-meta-operations.md`](expr-for-meta-operations.md), whose
measured findings it builds on, and to the prototype under
[`prototype/`](prototype/), whose `resolve()` is the sketch of the
resolver this plan specifies.

The order of the remaining work, and what finished means for the
TypeScript package, are now in [`typescript-plan.md`](typescript-plan.md),
a proposal of 12 November 2026. This document stays the record of the
design through Phase 2.

Status: a proposal for the maintainer, 6 November 2026, fourth revision.
This revision follows the maintainer's direction that `expr` is vital and
central: the tree layer is built in `expr` first (`tabnas/expr` pull
request 100, TypeScript), the resolver is an OpenAPI vocabulary over
`expr.fold`, and `expr` becomes a runtime dependency; Phase E below is
the prerequisite that was Phase 5's tree-layer row, and Decisions 6 and 7 are
re-taken. The extension is recorded in
[`expr-tree-layer.md`](expr-tree-layer.md). The first revision was reviewed by three independent readers (a fleet maintainer,
an apidef maintainer, a specification reader), a completeness critic, and
a design panel on the `expr` question; their corrections are folded in and
marked where they change a decision. Every point marked **Decision** is one the maintainer
makes; the plan names the default it would take. Every dependency change
is a decision, because this repository's `CLAUDE.md` allows dependency
changes only on explicit instruction, and nothing below is such an
instruction.

## 1. Goal and definition of done

The brief: a parser in the tabnas family for OpenAPI documents in JSON and
YAML, meeting the latest specification (3.2.x), returning either the raw
tree, with `$ref` and the other meta-operations verbatim, or a resolved
tree, with `$ref` resolved; replacing the custom OpenAPI handling in
`voxgig/apidef` with a consistent tabnas plugin configuration; and, as
the experimental part, using `@tabnas/expr` where it fits. The design
note settled the experimental part: `expr` reads the operator-shaped
skeleton of a runtime expression and misreads the ABNF-legal names inside
it, so the embedded languages get lexical readers; `$ref` is not an
operator the lexical `expr` can carry. The maintainer then directed that
`expr` is central and is to be extended to carry it: `expr` now has key
operators recognised by shape and a `fold` over the finished tree, with
a site, an inherited bag, one result per location, a cycle rule, several
documents and a report (Phase E), and the resolver here is the OpenAPI vocabulary over that fold
(Phase 2).

The plugin is done, at its first stable release, when all of the
following hold.

| | Outcome | Measured by |
|---|---|---|
| D1 | Any OpenAPI 3.0.x, 3.1.x or 3.2.x document, in JSON or YAML, parses to a raw tree that is, for JSON text, equal as JSON text to `JSON.parse` of the document under the duplicate-key policy (Decision 11), and for YAML equal to a named reference YAML 1.2 parser's reading less the yaml plugin's registered divergences; the engine's and jsonic's own registered divergences (a lone surrogate folding to U+FFFD in Go and Rust, nesting past the Rust depth bound, an exponent past the host integer) are carved out in a `divergent.tsv` register, re-measured through this plugin; Swagger 2.0 documents parse the same way (Decision 4) | shared fixtures; the conformance corpora of section 7 |
| D2 | Resolved mode follows the specification: every document of the description parsed before anything is judged unresolvable; the base URI of every node from the nearest `$id`, else `$self`, else the retrieval URI; `$anchor`, `$dynamicAnchor` and JSON Pointer fragments; the schema dialect per resource; sibling rules by version and object kind; implicit connections resolved and reported; cycle and sharing policies; a provenance side table; an `unresolved` report; external documents only through a caller-supplied, bounded loader | shared fixtures with resolved output; the Stripe, GitHub and OAI example corpora |
| D3 | Runtime expressions, path templates and server URL templates are read into structures by the specification's own grammars, cross-checked against the operation statically, and evaluable by a consumer that supplies a request and response | fixtures for the readers; apidef's flow-step tests |
| D4 | TypeScript canonical, Go and Rust ports, held together by shared `.tsv` fixtures; `tabnas.plugin.json` regenerated; the Diátaxis docs; CI green; the first publish bootstrapped and later releases through `release.yml` | the family's standard gates |
| D5 | apidef's `$ref` resolution code (`addXRefsAndResolve`, `resolveRefSite`, `resolvePointer`, `followAlias`, `refSiblings`, `replaceOwnKeys` and their Go twins) is deleted, apidef keeps its `decycle` post-pass, and apidef's own suites pass against the plugin in both runtimes | apidef's suites, `parse-resolve.tsv` and `parse.test.ts` included |
| D6 | A conformance claim stated as the design note states its findings: which corpora, how many documents, how many agree, and every disagreement listed in a ledger | `test/` ledgers and `AGENTS.md` |

Non-goals: validating instances against schemas, validating the
description itself against the OAS schema (the error codes and the
`connections` report are the only structural checks in v1; a validator is
a possible later package over the same object-model table), generating
code, making HTTP requests, and evaluating `$dynamicRef` dynamically,
which depends on a validation-time scope the parser does not have (its
static initial resolution is in scope, Phase 2).

## 2. What the plan rests on

Facts from the design note and its reviews that fix the shape of the
work:

- The raw tree must stay verbatim, in every runtime. The engine's `info`
  marker is a hidden property in TypeScript only; in Go and Rust it swaps
  the container type (`MapRef`, `ListRef`), Go's `MapRef` has no
  `MarshalJSON`, and yaml's block builders attach no marker at all. So
  provenance goes in a side table keyed by JSON Pointer path, and the
  plugin never turns `info` on.
- Resolution runs after the whole parse. The engine's post-process rule
  subscriber, `tn.sub({ ruleDone })`, fires grammar-neutrally after every
  pass in all three runtimes; filtered to the depth-0 close whose
  alternate neither pushes nor replaces, outside probes and recovery, it
  fires once per completed parse, after yaml's `stream` rotations too, and
  `ctx.root().node` then holds the result (prototype E3, case 5). It does
  not fire for an empty document or a parse that fails first, and on
  trailing content it fires and the parse then still fails. In Rust the
  subscriber observes and cannot replace the result; in Go `parse` returns
  the private `resultRule`'s node, so an in-parse write must go to the
  rule the final `ruleDone` handed over, not `ctx.Root`. The function form
  below is therefore the primary API in all three runtimes and the
  in-parse option is sugar in TypeScript and Go only.
- The generic half of resolution is `expr`'s. `expr`'s tree layer
  (`tabnas/expr` pull request 100) declares a key operator by `{ key:
  true, src: '$ref' }`, recognises it by a map's shape at fold time, and
  reduces it bottom-up with `evaluate(site, op, [value, siblings])`,
  where the site carries the document's root and key, the path, the
  verbatim node, a bag `inherit` built from the root down to and
  including the site's own map, the opening token when `positions` gives
  one, `at(path, doc?)`, which folds another location, in this document
  or another the host's `load` supplies, through any sites on the way,
  and `plain()`, the map folded as a plain map. The host's `recognise`
  refuses a site where the keyword is data. One result per location, a
  cycle rule that cuts a container cycle once, a report whose rows name
  both documents, coded `FoldError`s and a depth bound complete it. Its
  deferred mode (`ExprOptions.fold`) runs on the `ruleDone` event above,
  and never on a parse that fails. Prototype E6 runs the OpenAPI resolver
  over it on the YAML document beside it and on Stripe's description
  (3673 sites, 125 cycles, 389 `$ref` maps left as data, about 150 to
  350 ms from `JSON.parse` output in this container, against 200 to
  300 ms for E3's in-place resolver). The layer is TypeScript only until
  its ports land, which fixes the order of the work below.
- What `$ref` means depends on the document version, the schema dialect
  and the object at the site: Swagger 2.0 is JSON Reference everywhere
  (siblings ignored); 3.0.x makes a `$ref` map a Reference Object wherever
  it stands, Schema Objects included; 3.1 and later keep the Reference
  Object rule (`summary` and `description` "by default SHOULD override",
  and only where the target kind has the field) and make a Schema
  Object's `$ref` a JSON Schema keyword whose siblings all apply under the
  2020-12 and OAS dialects, while a resource declaring another `$schema`
  follows that dialect. A Path Item's `$ref` is a field of the Path Item
  in every version, never a Reference Object: adjacent fields merge, and a
  field present on both sides is "undefined" (3.2.0 section 4.9.1). Under
  `x-` extensions, `example`, the 2020-12 `examples` array, an Example
  Object's `value`, `dataValue` and `serializedValue`, `const`, `enum`, a
  schema `default`, Link `parameters` values and `requestBody`, and Server
  Variable `default` and `enum`, a `$ref` key is data; so is a property
  named `$ref` under `properties`, `patternProperties`, `$defs` or
  `mapping`. In Stripe's description 389 of 4062 `$ref` maps sit in data
  slots.
- A resolved document is a graph. Stripe's description resolves in
  about 300 ms to a DAG with 125 cycle cuts, and `JSON.stringify` of that DAG
  fails after 90 s with "Invalid string length"; a 1.9 KB document whose
  schemas each refer twice to the next serialises to 7.4 MiB at depth 16.
  Shared targets inline exponentially. The resolved result is for
  in-memory consumers, and any serialised form needs a sharing policy.
- On JSON input the grammars cost two orders of magnitude more than
  `JSON.parse` (3.2 s and 3.8 s against 30 ms on 7.9 MiB) and give the
  same value for documents with unique member names. They disagree on
  duplicate names: `jsonic`+`yaml` deep-merges a repeated key
  (`{"a":{"b":1},"a":{"c":2}}` reads as `{a:{b:1,c:2}}`) where `JSON.parse`,
  the strict `json` grammar, Go's `encoding/json` and Rust's `serde_json`
  keep the last. apidef relies on the merge for keys its surrogate repair
  makes equal.
- `jsonic`+`yaml` reads JSON text identically to the strict `json`
  grammar on every document tried (the three `JSON.stringify` forms and
  apidef's 43 JSON fixtures), and additionally reads YAML, including forms
  a strict JSON reader rejects. Known yaml 0.5.26 behaviours the plugin
  meets: a JSON text whose first line is empty fails with `unexpected`; an
  unquoted `$ref: #/x` is a comment and reads as `null`; `swagger: 2.0`
  unquoted reads as the number 2; a reported column drifts by one per
  preceding `: ` on the line (rows are exact); block sequences and their
  bare-pair entry mappings are built outside `@object$`/`@array$`.
- Never install `expr`'s default operator table under the document
  grammar: its `/` operator breaks `/pets:` as a YAML key (measured by the
  design panel). Any `expr` instance the plugin owns is a separate one
  with its own table and comment lexing off in every runtime.
- A plugin cannot short-circuit `tn.parse()`, fail a parse from a
  `ruleDone` subscriber in Go or Rust, or run anything on a `JSON.parse`
  fast path, where no rule runs. So the fast path, the root and stream
  checks, position capture and the in-parse resolve all live in the
  plugin's own exported `parse(text, options)` wrapper (Go `Parse`, Rust
  `parse`), which calls the engine when it must; `tn.parse()` on the
  instance always runs the grammar and the plugin raises nothing there.
- The published `@tabnas/yaml` reads `yes`, `no`, `on` and `off` in every
  casing as booleans from a built-in table, YAML 1.1 behaviour where OAS
  3.2.0 requires YAML 1.2 (RFC 9512), and `.inf` becomes null through
  JSON; an unquoted `openapi: 3.1` reads as the number 3.1.
- The family's rules bind every phase: TypeScript canonical, Go and Rust
  ports pinned by shared fixtures in `test/spec/*.tsv` (three columns:
  `input`, `expected`, `opts`, compared after a JSON round-trip, so key
  order is not pinned there); dependencies change only on instruction;
  every transient task reports progress; pull requests ready for review.

## 3. The shape being built

### 3.1 Packages and layering

```
@tabnas/parser  (engine)
  ├── @tabnas/json → @tabnas/jsonic → @tabnas/yaml ─┐
  └── @tabnas/expr  (key operators and fold)        ├── @tabnas/openapi   (this repository)
                                                    ┘
```

`@tabnas/openapi` is a plugin on `jsonic`+`yaml`, as the ZON template is a
plugin on `jsonic`. A strict variant on `json` alone serves callers who
want a `.json` file held to RFC 8259; it makes `json` a runtime dependency
in all three ports (Decision 1). `expr` is a runtime dependency for the
tree layer, in all three ports, once the layer is published (Decision 7);
the plugin's own instance of `expr` declares the key operators and no
token operators, since `expr`'s default table breaks `/pets:` under the
document grammar.

### 3.2 Public surface

TypeScript, with Go and Rust mirroring it in their idiom:

```ts
import { OpenApi, make, parse, resolve, resolveAll, readExpression, readTemplate, evaluateExpression } from '@tabnas/openapi'

const tn = make({ strict: false })                 // jsonic+yaml, or json alone with strict: true
const raw = parse(text, { instance: tn, fast: 'auto', positions: false })   // verbatim; the default
const out = resolve(raw, {                         // the derived tree, after the parse
  version: 'auto',                                 // '2.0' | '3.0' | '3.1' | '3.2'
  retrievalUri: 'https://example.com/openapi.yaml',// the entry document's base when it has no $self
  documents: { load, allow, maxDocuments: 64, maxBytes: 64 << 20, root: 'any' },   // loading is off unless `load` is given
  cycles: 'cut',                                   // 'cut' | 'keep'
  sharing: 'share',                                // 'share' | 'site' | 'inline-once' | 'copy'; copy needs `budget`
  siblings: 'spec',                                // 'spec' | 'merge'
  slots: 'spec',                                   // 'spec' | 'all': whether data slots are resolved
  targets: 'any',                                  // 'any' | 'object': whether a non-object target resolves
  xref: false,                                     // apidef's x-ref key beside every $ref site, resolved or not
  extensions: [],                                  // x- keys whose values ARE resolved (Stripe's x-expansionResources)
  positions: false,                                // row and column per site, from a ruleDone subscriber
  strict: false,                                   // unresolved and non-string $ref become errors
})
// out: { tree, version, unresolved, provenance, cuts, connections, documents }
```

`compat: 'apidef'` is a named preset (Phase 6) equal to `{ siblings:
'merge', xref: true, sharing: 'share', cycles: 'keep', slots: 'all',
targets: 'object', chains: 'unresolvable', followAliases: true }`.

`make({ strict })` chooses the base; `strict` is not a plugin option,
since a plugin cannot change the grammar it was installed on, and `use()`
throws if given it. The exported `parse(text, options)` is the single
entry that carries `fast`, the root, version and stream checks, position
capture and, with `resolve` in its options, the in-parse resolution; it
runs the grammar through the instance when the fast path does not apply,
and `positions: true` or `strict` force the grammar path, since no rule
runs on `JSON.parse` and only the grammar can report a row and column or
a syntax position. The engine's own `tn.parse()` always runs the grammar
and returns the verbatim tree with nothing raised by the plugin; the three
fixture runners call the wrapper. In TypeScript and Go the wrapper's
in-parse resolve is `expr`'s deferred mode (`ExprOptions.fold` with the
plugin's callbacks), which runs on the `ruleDone` subscriber, in Go
writing the final done rule's node; in Rust the wrapper calls `resolve`
on the returned tree. Reports travel through the return value or an
`onResolved` callback, never through plugin options, which `use()`
deep-copies. `resolveAll(text, options)` is the asynchronous wrapper that
loads every reachable document first and then calls the synchronous
`resolve` (Decision 3). The function form is primary because apidef
mutates the raw tree between parsing and resolving. Defaults when
loading is on: 64 documents, 64 MiB; `copy` without a `budget` is an
error.

### 3.3 Output shapes

| `sharing` | `cycles` | In memory | Serialisable | For |
|---|---|---|---|---|
| `share` | `cut` | a DAG: one object per target, shared by every site that names it, back edges as verbatim `{ $ref }`, each cut recorded in `cuts` (holder and target as object references in memory, as RFC 6901 pointers in the serialised report) | not in general (exponential) | in-memory consumers that follow object identity |
| `site` | `keep` | one shallow copy per site with the target's children shared, the shape apidef builds; implied by `xref: true`, which writes `x-ref` on the site copy and never on a target | no | apidef, which runs its own `decycle` post-pass over it |
| `share` | `keep` | a cyclic graph | no | consumers that want object identity for recursion |
| `inline-once` | `cut` | a tree: the first site naming a target gets the value, later sites keep `{ $ref }` with provenance | yes, bounded by the document size | serialised output, diffs, fixtures |
| `copy` | `cut` | a tree with every site inlined | only within a byte budget the call must set | the shape most tooling expects; refused above the budget |

The per-site copy of `site` sharing is made in a post-pass over the
finished graph, so a target still under construction when a site meets it
is handled. The walk order is a contract, because it decides which edge of
a cycle is cut, which site `inline-once` inlines, and the order of every
report array: pre-order from the root, object members in document order
(`OrderedMap` in Go, `preserve_order` in Rust), array elements by index, a
target entered at its first reference. A ring fixture whose cut set
differs under alphabetical order pins it. Every path in a report is an
RFC 6901 pointer (`/paths/~1pets/get/parameters/0`), since a path key
holds `/`, with a document URI beside it from Phase 3 on.

### 3.4 Error codes and the report

Declared in `options.error` with hints, pinned by `ERROR:<code>` fixture
rows, listed in the descriptor. Parse-time codes, always on: `openapi_root`
(the entry document is not an object), `openapi_stream` (a YAML stream of
several documents, told from a sequence root by the yaml `meta` option or
the `stream` rule seen in the `ruleDone` subscriber). Version detection is
lenient: an unknown or missing `openapi`/`swagger` value gives
`version: 'unknown'` in the report, and `openapi_version` is raised only
under `strict`, since apidef accepts any truthy value today. Resolve-time
codes, under `strict` only: `openapi_unresolved` (a reference names
nothing), `openapi_ref_type` (a `$ref` whose value is not a string, at a
position the object model types as a reference site; elsewhere the key is
data and the children are walked), `openapi_pointer` (a fragment that is
syntactically invalid: a `~` not followed by `0` or `1`, bad
percent-encoding, neither empty nor `/...` nor a 2020-12 plain name),
`openapi_duplicate_key` (Decision 11). Always-on resolve-time codes:
`openapi_load` (a document load refused or over budget), `openapi_budget`
(`copy` without a budget, or over it), `openapi_expression` (a runtime
expression or template that does not match its ABNF).

Everything else is a report entry, as the specification's "MUST NOT treat
as unresolvable before parsing all documents" and apidef's behaviour both
want: `unresolved` (`at`, `ref`, `why`, one of `not-found`, `no-anchor`,
`external`, `non-object-target`, `bad-fragment`, `not-a-string`,
`unsupported-dialect`, `load-refused`, `over-budget`, `no-base-uri`),
`cuts`,
`provenance` (one entry per site, resolved, unresolved and cut alike, with
`at`, `ref`, `kind`, and row and column when `positions` is on),
`connections` (every implicit connection with its target found or not:
`operationId`, security requirement keys, tags with `declared: false` for
an undeclared tag, Tag `parent` with a cycle check, discriminator
`mapping`, `defaultMapping` and the implicit mapping, `$dynamicRef`'s
initial resolution and whether a matching `$dynamicAnchor` exists, an
`operationId` reachable through more than one path), `documents` (each
document's base, root kind and whether that kind was inferred).

### 3.5 Fixtures

Raw and error rows use the family's three-column `.tsv` under
`test/spec/`, auto-discovered and run by the existing parity runners,
which compare `parse(input)` to `expected` after a JSON round-trip. Those
runners cannot run resolution: they pass `opts` to `use()`, and in Rust
`parse()` cannot return a resolved tree. So resolve fixtures live outside
the auto-discovered directory, in `test/resolve/*.tsv` and `test/docs/`
for multi-document sets, with a dedicated runner per runtime that calls
`resolve(parse(input), opts)` and compares the `inline-once` serialisation
of the whole report. Key order is pinned by in-language tests, since the
shared comparison ignores it. Fast-path equivalence is a fixture file run
twice, with `fast: true` and `fast: false`, rather than asserted. apidef's
`parse-resolve.tsv` has four columns (`name`, `spec`, `select`,
`expected`) and runners only in apidef, so its pointer rows (2 to 25) are
translated into this repository's three-column `test/resolve/apidef.tsv`
under the `compat: 'apidef'` preset, reading the `select` path, and the
whole file stays apidef's own gate, run through apidef's `parse()` in
Phase 6. Multi-document cases live under `test/docs/` with their own small
loader per runtime, after confirming that `@tabnas/support`'s directory
runner ignores non-`.tsv` files under `test/spec`.

## 4. Work breakdown

Sizes are relative: S is a day or two of focused work in one runtime, M a
week, L several weeks. "Port" means Go and Rust each, after TypeScript,
with the shared fixtures as the contract.

### Phase 0: bootstrap the repository from the template (M)

The template guide (`TEMPLATE.md`) is the checklist; the fleet review
found the first draft of this phase short, and the repository is still
`@tabnas/zon` in about ninety tracked files. Build the file list from
`grep -ril zon` over the tracked tree and work it down.

1. Rename the packages and the version sites: `ts/package.json` (`name`,
   `main`, `types`, `browser`, `repository`, `homepage`, `keywords`, the
   `corpus` and `test-watch` scripts), `go/go.mod` to
   `github.com/tabnas/openapi/go` and the Go package name `tabnaszon`,
   `rs/Cargo.toml` (`name`, `repository`, `description`) and the root entry
   of `rs/Cargo.lock`, which is one of this repository's version sites
   (`cargo update --workspace`); `ts/src/zon.ts`, `go/zon.go`, the
   `VERSION` constants and the Makefile's `publish-go` target. Choose the
   starting version (Decision 12).
2. Remove or rewrite what is ZON's, with a table of every template file
   and its fate (rename, restamp through admin, remove, rewrite):
   `zon-grammar.jsonic` and `ts/embed-grammar.js`, the
   `zonDot`/`zonMultiString`/`zonChar` matchers, `rs/src/lex.rs` and
   `rs/src/number.rs`, `scripts/fetch-zigzon.sh`, `test/zigzon`,
   `test/strictness`, the three zigzon test files, the `corpus` Makefile
   target and the `pretest` hook that runs it, the `.gitignore` corpus
   lines, the ZON fixtures in `test/spec/`, `ts/doc/grammar.svg` and
   `grammar.txt`, the path filters in `rust.yml` and `docs.yml` that name
   the ZON files (a filter that never matches lets a pull request through
   green without running), the `.vale.ini` and `ts/scripts/gated-docs.cjs`
   file lists, the perf tests, the `@tabnas/debug` composition tests
   (`ts/test/debug-model.test.ts`, `rs/tests/debug_model_test.rs`), which
   assert ZON's rule set and are a fleet standard, so they are rewritten
   for yaml's rule set rather than removed, `renovate.json`, and the ZON
   prose in the Diátaxis pages, the READMEs, `SECURITY.md`,
   `test/AGENTS.md`, `rs/AGENTS.md`, `ci/README.md` and `CONTRIBUTING.md`.
   `DIVERGENCE.md` is kept and re-measured: its rows that are the
   engine's and jsonic's (the lone surrogate, the Rust depth bound, the
   exponent) carry over, so they are re-run through the new plugin and
   registered in a `test/spec/divergent.tsv` as the engine does (ADR-14),
   with the tests that assert them kept.
3. **Decision 10 (translation parts).** The template carries the fleet's
   translation subsystem (admin ADR-27): `alchemy/render.alc`,
   `alchemy/transduce.alc`, `ts/src/translate.ts`, `ts/embed-translate.js`
   (run on every build, and it throws when the descriptor has no
   `translate` object), `go/translate.go`, `go/translate/`,
   `rs/translate/`, `test/spec/render.tsv`, the three translate tests, and
   the descriptor's `translate` section. Default: drop it, since yaml and
   json already write both serialisations, removing `embed-translate.js`
   from the `embed` script and letting the descriptor omit `translate`.
4. **Decision 1 (dependencies).** `ts/package.json` adds `@tabnas/yaml` and
   `@tabnas/json` as peer dependencies (`>=0`) mirrored as `*` dev
   dependencies, beside `@tabnas/jsonic` and `@tabnas/parser`; `go/go.mod`
   requires `github.com/tabnas/yaml/go` and imports
   `github.com/tabnas/json/go` directly (today indirect), and moves its
   existing requires to their latest releases under the standing
   instruction (`jsonic/go` v0.7.9 and `parser/go` v0.12.12 today;
   `go.sum` and the indirect lines move with them); `rs/Cargo.toml` takes
   `tabnas-yaml = { path = "../../yaml/rs" }` and
   `tabnas-json = { path = "../../json/rs" }`, which brings yaml's
   transitive crates (`regex`) into the build. `.github/workflows/ci.yml`
   extends `deps:` to `"parser support debug json jsonic yaml"`;
   `.github/workflows/rust.yml` adds `yaml` to its clone list and rewrites
   its path filters for the renamed files; `ci/rust/run.sh` adds `yaml` to
   its sibling list and to the crates its lock comparison exempts. Run
   `node tools/port-deps.cjs`; no register entry is expected, since all
   three ports gain the same dependencies. `@tabnas/expr` enters the same
   manifests on the same instruction once the release carrying the tree
   layer exists (Decision 7, Phase E); until then Phase 2 is written
   against the checkout through the admin repository's local wiring, and
   no manifest names it.
5. **Admin-stamped files (a maintainer instruction to the admin
   repository).** `go/clib/` and `.github/workflows/clib.yml` and
   `clib-release.yml` carry `tabnas-clib-template` markers and hardcode
   `libtabnaszon`, `github.com/tabnas/zon/go`, `plug.MakeJsonic()` and
   `optsDefined = false`; `release.yml`, `crates-release.yml`,
   `deps-gate.yml`, `notify-status.yml` and `scorecard.yml` are headed
   `Target: tabnas/zon`, and `release.yml` names `@tabnas/zon` twice. They
   are applied from the admin rollout, never edited here: the maintainer
   adds the `openapi` row to admin's `tasks/clib-rollout.tsv` (library
   `libtabnasopenapi`, the `make` constructor, and `optsDefined` now that
   the plugin has options), retargets the five workflows, and restamps
   into a reviewed PR here. `clib` CI and the release's clib step stay red
   until then.
6. Rewrite `AGENTS.md` for this plugin, keeping the three standard
   sections (`Verify your work`, `Error codes`, `Untrusted input`);
   `CLAUDE.md` stays a pointer. Regenerate `tabnas.plugin.json` with the
   admin repository's `make ax-descriptor` once the error table exists
   (never hand-edit it), after the clib restamp so `clib.library` and
   `errorCodes` agree; the descriptor's `base` becomes `@tabnas/yaml`.
   Adopt the admin dependency gate (`make deps`) that this repository
   lacks.
7. The descriptor fields for a grammar-free plugin (**Decision 15**):
   `extensions` is `[]` with a documented rule that the plugin is detected
   by the `openapi` or `swagger` root key, since OpenAPI has no exclusive
   file extension and the MCP `list_plugins` routes by extension;
   `languageId` `openapi`; whether admin's generator accepts a plugin with
   no grammar file, or a minimal `openapi-grammar.jsonic` is kept for it,
   is confirmed with the admin maintainer.
8. Verification: `make build && make test` green in all three runtimes
   with an empty grammar extension (the plugin installs and parses the
   petstore YAML and JSON to the same raw tree as `jsonic`+`yaml` alone);
   `rust.yml` and `docs.yml` trigger on the renamed files; the debug
   composition test asserts yaml's rule set.

### Phase 1: raw mode (M, then port M)

1. The `OpenApi` plugin and the `parse` wrapper. The plugin installs
   after `yaml`, never turns `info` on, and records nothing on the tree.
   The wrapper carries the checks the engine cannot: it rejects a stream
   of several documents (`openapi_stream`, told from a sequence root by
   the yaml `meta` option or the `stream` rule seen in the `ruleDone`
   subscriber); detects the version from `openapi` or `swagger` (string or
   number) leniently; validates the root (`openapi_root`). `make({ strict
   })` builds the instance: `jsonic`+`yaml`, or `json` alone under
   `strict`.
2. `fast: 'auto'` in the wrapper: when the text is JSON (first non-space
   character `{`), `JSON.parse` it and fall back to the grammar on any
   syntax error, so diagnostics still come from the engine; `positions` or
   `strict` force the grammar. **Decision 11 (duplicate member names):**
   the grammar as configured merges a repeated key, `JSON.parse`, Go's
   `encoding/json` and Rust's `serde_json` keep the last, and YAML 1.2
   says keys MUST be unique. Default: set the engine's `map.merge` option
   to last-wins in the plugin in all three runtimes, so both paths and all
   runtimes agree with `JSON.parse`; `openapi_duplicate_key` under
   `strict`; the `compat: 'apidef'` preset restores the merge apidef's
   fixtures expect; a repeated-key count in the conformance ledger.
   Normalise the fast path's containers to null-prototype objects so
   `__proto__` keys stay data and both paths agree. In Go the fast path
   builds `*tabnas.OrderedMap` (its `UnmarshalJSON` exists; a
   `json.Decoder` token walk if the duplicate policy needs it) so the raw
   tree is the same family on both paths, which apidef's Go port reads
   before it plainifies; in Rust `serde_json` with `preserve_order`, which
   the template already enables, into the engine's `Value`.
3. Fixtures: `test/spec/raw-json.tsv`, `raw-yaml.tsv` (block and flow
   forms, `- $ref:` and `[$ref: x]` entries, quoted and unquoted keys, the
   unquoted `#/x` that reads as null, the leading-newline JSON text that
   fails under yaml), `raw-errors.tsv` (`openapi_root`, `openapi_stream`),
   `raw-versions.tsv` (2.0 and 3.1 as strings and as numbers, 3.0.x,
   3.2.x, unknown), `raw-yaml-scalars.tsv` pinning what the published yaml
   does with `yes`, `no`, `on`, `off` and `.inf` until Phase 5 gives it a
   1.2 scalar option, and `raw-fast.tsv` run with `fast: true` and `fast:
   false`
   (duplicate keys, BOM, control characters, trailing comma, `__proto__`,
   `-0`, `1E400`, large integers, lone surrogates). Key order is pinned by
   in-language tests in each runtime.
4. Ports. The Go plugin on `github.com/tabnas/yaml/go`'s `MakeJsonic`
   instance; the Rust plugin on `tabnas_yaml`.
5. Acceptance: every raw fixture green in three runtimes; the OAI
   examples corpus (section 7) parses without error; Stripe's description
   parses in under 100 ms on the fast path and under 5 s on the grammar.

### Phase E: the `expr` tree layer (L; TypeScript landed, then port L each)

The prerequisite of Phase 2 in every runtime, in `tabnas/expr`, on the
maintainer's direction. Its contract and port notes are in
[`expr-tree-layer.md`](expr-tree-layer.md) and in `expr`'s `AGENTS.md`.

1. **TypeScript** (landed, pull request 100, revised after a five-lens
   review): `OpDef.key` and `dynamic`; `fold(root, options)` with `Site`,
   `inherit`, `recognise`, `site.plain()`, several documents (`doc`,
   `load`), one result per location in a trie, the cycle rule (a loop of
   references alone, a container cycle cut once), `cycle: 'verbatim' |
   'error'`, `tokens`, `positions` as a lookup and `recordPositions`,
   `maxDepth`, `report` with document keys; `FoldError` with codes;
   `ExprOptions.fold` through `ruleDone`, never on a failing parse;
   `evaluation(..., { objects: true })`; `opify`, `isOp`, `keyOpOf`,
   `makeKeyMap` exported; fixtures in `test/tree/` (an `ERROR:<code>`
   file among them) and `tree.test.ts`; the reference, concepts, guide
   and agents guide.
2. **Go port** (port notes in `expr-tree-layer.md` section 5): `Key` and
   `Dynamic`; `Fold` and `FoldEvaluate` with an error return, a deferred
   failure panicked as a `*TabnasError` carrying the fold code;
   recognition over `*OrderedMap`, and over `map[string]any` and `MapRef`
   with their member names sorted; siblings a new `*OrderedMap`; the
   parser requirement moved to the latest release, which carries
   `RuleDone.Probe`; the deferred mode writing the final done rule's node,
   measured to match one pass per parse with and without a start-rule
   replace; the positions table in `ctx.U`; the occurrence token on
   `ListRef.Meta`; `DIVERGENCE.md`'s prose for the two new `Op` fields; a
   `test/tree/` runner.
3. **Rust port**: `key` and `dynamic`; first, whether the fold runs on
   the arena-live value inside `parse_scope` or recognises the realized
   operator form, since every public parse realizes operator nodes;
   `fold` and `FoldEvaluate` returning `Result`; recognition over
   `Value::Object` and `Value::MapRef`; the function form only;
   positions, recorded at a container's close pass or by path, measured;
   `key` and `dynamic` in `Op::to_value`; a runner.
4. **Fixtures move** from `test/tree/` into `test/spec/` once both ports
   run them, under the parity rule.
5. **Release** `expr` with the layer, through its own `release.yml`,
   after `main` is green; then the dependency instruction here
   (Decision 7).
6. Acceptance: the three suites green on the tree fixtures; E6 green
   against the published package rather than the checkout.

### Phase 2: the resolver on one document (L, then port L)

The prototype's `resolve()` is the sketch; this phase makes it exact. The
specification reader moved the base-URI machinery here from Phase 3: a
single 3.1 document with `$id`s already needs it (Appendix F.1: a
fragment under an `$id` resolves within that resource, not the document).

1. **The fold is `expr`'s** (Phase E), and this repository writes no
   generic walk: `resolve(raw, options)` is `expr.fold(raw, { op, doc,
   evaluate, inherit, recognise, load, k, cycle, positions, maxDepth,
   report })` with the OpenAPI vocabulary in the callbacks, as prototype
   E6 shows. The operator table declares `$ref` as `{ key: true, src:
   '$ref' }` and `$dynamicRef` as `dynamic: true`; `inherit` sets the base
   URI, the schema dialect and the kind and type of object at the path in
   the bag each map passes down; `recognise` refuses a `$ref` in a data
   slot or as a name in a map of names; `evaluate` resolves the URI
   against `site.k.base`, reaches the target through `site.at` (in another
   document through `load`, Phase 3), applies the sibling rule by version,
   kind and target type, records provenance once per site, hands a cycle
   or a miss back as the verbatim site, and returns `site.plain()` for a
   `$ref` that is not a string; the fold's report (`cycles`,
   `unresolved`, `dynamic`) feeds the plugin's. The layer keeps one
   result per path, so sharing is a property of the fold, and never
   changes the raw tree. `__proto__` survives as a key because the layer
   defines members rather than assigning them; the plugin's own tables are
   null-prototype objects for the same reason.
2. **The object model** (M on its own; the first thing this phase needs).
   A generated classifier of every position in a document for each
   supported version, saying whether the slot is a Reference Object, a
   Schema Object, a Path Item, a locator (a URI that is resolved and
   checked but never substituted: Link `operationRef`, discriminator
   `mapping` and `defaultMapping` URI values, Security Requirement URI
   keys), a named-connection site (security requirement name keys,
   `operationId`, tag, Tag `parent`, mapping names), or data; an unknown
   position is data. It is a tree automaton over the schemas'
   `patternProperties` (`^/` path keys, `^x-`, component names, response
   codes), not a flat table, and its inputs are three, named because the
   OAI validation schemas alone cannot yield it (3.1 and 3.2 describe
   themselves as "without Schema Object validation", define the Schema
   Object as `{ $dynamicAnchor: meta, type: [object, boolean] }` with no
   keyword list, and type the string-valued reference fields as plain
   strings; 3.0's schema is draft-04 with an enumerated keyword set;
   Swagger 2.0's is another draft-04 shape): (a) the dated validation
   schema per version, vendored and pinned by URL and date; (b) a
   hand-written, fixture-pinned applicator list per schema dialect
   (2020-12 for 3.1 and 3.2, Wright-00 for 3.0, draft-04 for 2.0) saying
   which positions inside a Schema Object are themselves schemas; (c) a
   committed, reasoned overlay (`tools/object-model-overlay.json`) listing
   the string-valued reference, locator and connection sites and the data
   slots, gated like the port-deps register (an entry without a reason or
   without a matching position fails). The tool handles `if/then/else`,
   `oneOf/anyOf/allOf`, `additionalProperties` and `patternProperties`.
   Acceptance: the classifier types every `$ref` map in Stripe, GitHub and
   the OAI examples, with the data-slot count a pinned census (Stripe: 389
   of 4062). **Decision 2:** which versions (default 2.0, 3.0, 3.1, 3.2).
3. **Bases and dialects.** Per node: the base URI from the nearest `$id`,
   else the document's `$self`, else its retrieval URI (`retrievalUri` is
   an input to `resolve`; absent, a fixed application default base,
   `urn:uuid:` as Appendix F.4 suggests, so fragment-only references
   still work); a relative `$self` or `$id` resolved against the next
   source. Per schema resource: the dialect from `$schema` at the resource
   root, else `jsonSchemaDialect`, else the OAS dialect id for the version;
   2020-12 rules for the OAS and 2020-12 ids; any other dialect leaves
   `$ref` sites verbatim with `unresolved.why: 'unsupported dialect'`
   (**Decision 13:** support the sibling-ignoring semantics of draft-07, draft-06 and draft-04
   later). An index of `$id`, `$anchor` and `$dynamicAnchor` per resource,
   built in the same walk.
4. **Sibling rules** by version, dialect and kind, as in section 2; the
   Reference Object override applied only where the target kind has the
   field; the Path Item merge reported in `connections` where a field is
   on both sides; `siblings: 'merge'` reproduces apidef's single rule.
5. **Reference resolution**: RFC 3986 split; percent-decode the fragment,
   then split, then `~1`/`~0`; a plain-name fragment through the anchor
   index (an unknown anchor is `unresolved`, a malformed fragment is
   `openapi_pointer`); array indices by RFC 6901 (`0 | [1-9][0-9]*`, in
   range); a pointer segment that lands on a reference site is followed
   (`followAliases`, on in both modes); targets resolved before use; one
   result per source path; cycle detection by node and by URI, cut by
   default and recorded, or kept; non-object targets allowed under `spec`
   and left unresolved under `targets: 'object'`; a `$ref` whose value is
   not a string recorded in `unresolved` and its children walked;
   `$dynamicRef`'s initial resolution recorded in `connections` and the
   site left verbatim; a locator resolved to its target path and reported
   in `connections` with the target's existence and kind checked, never
   substituted, and a Security Requirement key that is both a component
   name and a URI reported as a warning (the specification's section 6.3
   names that ambiguity as exploitable).
6. **Output shapes** of section 3.3, with `copy` refusing above a byte
   budget rather than producing an unserialisable value, and the
   per-site shallow copy for `xref` made in a post-pass.
7. **Provenance** as a side table, one entry per site; row and column
   when `positions` is on, from a `ruleDone` subscriber that records the
   opening token of every container by path while parsing, in all three
   runtimes (the review measured it reaching yaml's block-sequence entry);
   rows are exact in every grammar, columns only under json and jsonic
   until the yaml column drift is repaired.
8. **Report**: as section 3.4.
9. Fixtures, in `test/resolve/` with the dedicated runner: `basic`,
   `siblings-2.0`, `siblings-3.0`, `siblings-3.1`, `siblings-pathitem`,
   `dialects`, `cycles` (reference first, target first, a two-schema ring,
   a site whose target is in its own subtree), `sharing`, `data-slots`,
   `pointers` (`~1`, `~0`, `%2F`, `%7B`, empty fragment, trailing slash,
   indices, non-object targets, a non-string `$ref`, and report paths whose
   keys contain `/` and `~`, so the RFC 6901 encoding of `at`, holder and
   target is pinned in three runtimes), `locators`, `base-uri` (a `#/`
   fragment under an `$id` resolved in that resource and reported
   unresolved when it names nothing there; a relative `bar` against a
   sibling `$id`, Appendix F.1), `anchors` (including `$dynamicAnchor` as a
   plain-name target and the specification's `generic-array` example),
   `proto`, `connections`, and `apidef` (rows 2 to 25 of apidef's
   `parse-resolve.tsv` under `compat: 'apidef'`).
10. Acceptance: fixtures green in three runtimes; Stripe and GitHub
    resolve with `unresolved` empty and the cut count stable; the `apidef`
    fixture green in all three.

### Phase 3: several documents (M, then port M)

1. A documents table keyed by `$self`, falling back to the retrieval URI,
   behind the fold's `load` (Phase E): the fold asks for each document key
   once, keeps one result per location across documents, detects a cycle
   that crosses documents, and names both documents in every report row;
   each entry carries its root kind (OpenAPI Object or Schema Object),
   base URI and index; the entry document first. Root kind detection: a
   root `openapi` field means an OpenAPI Object; otherwise a Schema
   Object; otherwise, by the referring site's kind, marked `inferred` in
   `documents`, which Appendix G lists as implementation-defined. A
   loaded document is parsed by the same instance with
   `documents.root: 'any'`, so a Schema-root document does not trip the
   entry-document checks.
2. The loader contract, **off by default**: `documents.load(uri)` returns
   `{ text, retrievalUri }`; only an absolute URI that passed resolution
   and matches `documents.allow` (a list of base URIs or a predicate)
   reaches it; `maxDocuments` (default 64) and `maxBytes` (default 64
   MiB) bound the walk; a load cycle is detected by URI; a relative
   external reference with no base (no `$self`, no `retrievalUri`) is
   `unresolved` with `why: 'no-base-uri'`. **Decision 3:** a synchronous
   `resolve` and an
   asynchronous `resolveAll` that loads first, so Go and Rust need only
   the synchronous form; apidef's `parse` is `async` but resolves inline,
   so `resolve` drops in.
3. Implicit connections across documents as the specification recommends:
   components and tags from the entry document, `operationId` from all
   parsed documents, security requirement keys by name first then as a
   URI (name precedence is a MUST there), discriminator `mapping` and
   `defaultMapping` by name first then URI, `./x` forcing the URI reading.
4. Fixtures: multi-document sets under `test/docs/<case>/` with a driver
   row naming the entry file and the retrieval URI, read by the dedicated
   runner in every runtime, including a Schema-root target document and a
   reference refused by `allow`.
5. Acceptance: the specification's own multi-document examples resolve;
   a reference to a URI outside `allow` is refused with `openapi_load` and
   leaves the site verbatim; the walk stops at the budgets.

### Phase 4: the embedded languages (M, then port S)

1. `readExpression(text)`: a lexical reader for the runtime-expression
   ABNF with its three token classes: `$url`, `$method`, `$statusCode`;
   `$request.` or `$response.` then `header.` with an RFC 9110 token
   (non-empty, restricted characters, case-insensitive), `query.` or
   `path.` with a `name` (any characters, may be empty, case-sensitive),
   or `body` with an optional `#` and an RFC 6901 pointer that is not
   percent-decoded. Output: `{ source, kind, name, pointer }`, and its
   array form for fixtures. **Decision 7:** `expr` does not read the
   skeleton; the three cases are not worth an instance.
2. `readTemplate(text)`: the specification's own grammars (sections 4.8.2
   and 4.6, wider than RFC 6570: any character but `{` and `}` inside
   braces, several expressions in one segment, the server `literals`
   class), for Path Item keys, Server `url` and Callback keys, whose
   pieces are runtime expressions; `openapi_expression` on an unbalanced
   brace.
3. Static checks in `resolve()`, into `connections`: every
   `$request.path.x`, `$request.query.x` and `$request.header.x` in a Link
   names a parameter of the owning operation's effective set (Path Item
   plus Operation, after reference resolution), and Link `parameters` keys
   are validated against the target operation preferring the qualified
   `path.id` reading; a template expression appears at most once in a path
   and a server variable at most once in a `url`; each path expression has
   a path parameter and vice versa except for an empty Path Item; a path
   key begins with `/`; a server `url` has no query or fragment; every
   server variable is declared.
4. `evaluateExpression(expr, { request, response })` for consumers, over
   a defined record shape `{ method, url, statusCode, headers, query, path,
   body }` with header names case-folded (lookup is case-insensitive;
   `Content-Type` and `content-type` are one fixture row) and `body` the
   parsed body; the value the expression names, with the type preserved,
   or `undefined` when it fails.
5. Fixtures: `expression-read.tsv` with every example in the
   specification's tables, the adversarial names E1 measured,
   `$request.header.` (error), `$request.query.` (legal, empty name),
   `$request.body#/a%2Fb` (literal `%2F`), `$request.body.x` (error);
   `template-read.tsv` with apidef's `/customers/{id}.json` and
   `/schedules/{id}:cancel` shapes, `{user-id}`, `/a/{x}{y}`, a repeated
   `{id}` (error), unbalanced braces (error); `expression-eval.tsv` with a
   request and response in `opts`.

### Phase 5: upstream enhancements (each its own PR, each a maintainer instruction)

None blocks the phases above; each removes a workaround or widens reuse.
The `expr` rows that were here, the operator constructor and predicate,
the opt-in object fold and the tree layer, have landed in TypeScript and
moved to Phase E as the prerequisite of Phase 2, by the maintainer's
direction (Decision 6); the Go occurrence token is now part of the Go
port there. The rows below are the ones that remain.

| Repository | Change | Why | Size | Breaking |
|---|---|---|---|---|
| expr | a key operator declared by a predicate on the map as well as by a member name, for formats whose operation is a shape without one keyword | the note's section 6.1 anticipated a list whose head is a keyword; the layer offers `src` only | S | no |
| parser | a `parse.complete` hook (not `finish`, which `rule.finish` already uses): `(tabnas, ctx, meta) => result | void`, after the trailing-content check, before `result.fail`, never on a throw, `{ value, errors }` under recovery, insertion order in all three runtimes (repairing `prepare`'s Go sort with it), a mutable root in Rust | a declarative, grammar-level end of parse that can replace the result in Rust, which `ruleDone` cannot | M | no |
| parser | `MarshalJSON` for Go's `MapRef`/`ListRef` emitting the value | with `info` on, Go's raw tree is not verbatim as JSON | S | no |
| yaml | the block-sequence builders attach the `info` marker or build through `@object$`/`@array$`; the column drift; the leading-newline JSON text; a plain-scalar schema option (YAML 1.2 core or JSON schema) | the marker is absent on the `- $ref:` shape; columns are off by one per `: `; a legal JSON text fails; `yes`/`no`/`on`/`off` read as booleans and `.inf` as null where OAS requires YAML 1.2 | S each | the scalar option no, as an option |
| jsonic | `use(jsonic)` merges rather than resets `info` | the option set on the constructor is lost | S | no |

### Phase 6: apidef migration (M in apidef, both runtimes)

Gated on D4: both the TypeScript and the Go ports shipping, with the
`apidef` fixture green in both. The apidef reviewer's correction stands
at the centre: apidef resolves a cyclic site in place and cuts the back
edge one level deeper with `decycle`, Go never decycles and walks the
cyclic graph by identity, and `refcount.ts` reads through the cuts; so
apidef migrates with `cycles: 'keep'` and keeps `decycle`, `DECYCLED` and
`decycledChild` unchanged, since they are a post-pass over any object
graph and import nothing from the resolver.

| apidef behaviour today (`ts/src/parse.ts`, `go/parse.go`) | After |
|---|---|
| `yamlParser(source)` on `Jsonic.make().use(Yaml)` | `@tabnas/openapi`'s instance; `fast: false` until `raw-fast.tsv` pins the duplicate-key policy apidef relies on |
| `wellFormed` (lone-surrogate repair) | kept in apidef, before `resolve()` |
| `normalizePathKeys`, `normalizeColonPathParams`, `dropIgnoredHeaders`, the `components` default | kept in apidef, in today's order (unquote before `resolve`, colon rename after) |
| `addXRefsAndResolve`, `resolveRefSite`, `resolvePointer`, `followAlias`, `refSiblings`, `replaceOwnKeys` | `resolve(raw, { compat: 'apidef' })`, with `x-ref` beside every `$ref` site, resolved or not |
| `decycle`, `DECYCLED`, `decycledChild` | kept; `[Circular *path]` strings stay, so `ref-count.tsv`, `merged-properties.tsv`, `parse.test.ts` and `utility.test.ts` need no change |
| `swagger` acceptance | `version: 'auto'` (Decision 4) |
| `yamlalias.ts` expansion guard | kept until the yaml plugin offers the bound |
| apidef's `parse()` error wrapping | recognises `openapi_*` codes as syntax errors beside `jsonic*` |
| Go `parse.go`: `declaredSchemeOrder`, `annotateExamplesOrder` read from `*tabnas.OrderedMap`, then `Plainify`, then resolution on `map[string]any` | the Go plugin's raw tree is `*tabnas.OrderedMap` on both paths; `Resolve(tree any, opts)` accepts `*tabnas.OrderedMap` or `map[string]any` and returns the input's family; order stays parse, annotate, plainify, resolve, and never the reverse: `tabnas.Plainify` tracks no identity, so run after resolution it copies a shared DAG exponentially and never ends on a kept cycle; a Go test resolves Stripe from a plain-map tree within the Phase 2 budget |
| TypeScript cuts cycles in `decycle`, Go keeps them | both ports migrate with `cycles: 'keep'` and keep their own post-passes, so neither port's output changes |

**Decision 14 (apidef manifests).** `@tabnas/openapi` joins apidef's peer
dependencies and `github.com/tabnas/openapi/go` its `go.mod`;
`@tabnas/jsonic` stays (its `deep` is used in `wellFormed`); whether
`@tabnas/parser` and `@tabnas/yaml` stay direct is the maintainer's.

Acceptance: apidef's whole suite green in both runtimes with the listed
code deleted, `parse.test.ts`, the refcount and guide suites (which read
`x-ref` in thirty places and would not be caught by the pointer fixture
alone) and Go's `TestParseRefChains` included;
then, as separate measured steps, `slots: 'spec'` and `siblings: 'spec'`
tried against the fixtures to see what the specification's semantics
change (apidef's 45 documents contain no `$ref` in a data slot, so the
first changes nothing there; Stripe's 389 would).

### Phase 7: docs, tooling, first release (S each, plus the bootstrap)

1. The four Diátaxis pages per runtime, the READMEs, `doc/` for what is
   language-neutral (the object-model table's derivation, the output
   shapes), the prose gate green.
2. Maintainer instructions in the owning repositories: the descriptor and
   the clib rollout row in admin (first, since they gate admin's `make
   verify`), the fleet roster row in the engine repository's
   `ci/fleet/fleet.json`, the plugin's options in `@tabnas/mcp` and
   `tabnas/skills`.
3. **Maintainer prerequisites before the first dispatch**, each with its
   check. `@tabnas/openapi` is not on npm and `tabnas-openapi` is not on
   crates.io; `release.yml` publishes over an OIDC trusted publisher
   configured per package, and `crates-release.yml` fails closed on a
   crate that does not exist yet.

   | Prerequisite | Who | Check |
   |---|---|---|
   | the repository at `github.com/tabnas/openapi`, so `go/v*` tags serve `github.com/tabnas/openapi/go` | maintainer | `git ls-remote https://github.com/tabnas/openapi` |
   | `tabnas-yaml` present on crates.io, for `crates-release.yml`'s path rewrite | yaml maintainer | `cargo search tabnas-yaml` |
   | a first 0.x publish of `@tabnas/openapi` by token | maintainer | `npm view @tabnas/openapi version` |
   | a first 0.x publish of `tabnas-openapi` from a path-rewritten manifest | maintainer | `cargo search tabnas-openapi` |
   | npm and crates.io trusted publishers naming `release.yml`, used within npm's two-day window | maintainer | the first `release.yml` dispatch |
   | the admin fleet roster and `make link` graph rows; the clib rollout row (Phase 0) | admin maintainer | admin `make verify` |

   From then on this repository's `AGENTS.md` "Releasing" governs (here
   crates publish is a job of `release.yml`; the five version sites include
   `rs/Cargo.lock`; the GitHub Release with the clib manifest is the
   completion signal).
4. The conformance claim written up as section 7 specifies.

## 5. Cross-cutting rules

- **Untrusted input.** Parsed content is data. A `$ref` URI is derived from
  parsed content, so following it is a file read or a network request on
  the document's say-so: loading is off unless the caller supplies
  `load`, and then only URIs within `allow`, within `maxDocuments` and
  `maxBytes`. Resolution itself is bounded by the document: memoisation
  makes it linear in the number of nodes, the fold's recursion depth is
  the document depth plus the reference-chain length (bounded by the
  engine's budget in Rust), and `copy` sharing is refused above its
  budget. Keys named `__proto__` are data.
- **Parity.** TypeScript is canonical; a Go or Rust difference is a
  fixture failure, or a `DIVERGENCE.md` entry with a register row. Known
  places to watch: `OrderedMap` on both Go paths; the null prototype of
  engine containers in TypeScript; the in-parse resolve option existing in
  TypeScript and Go only (a porting note, not a divergence); any
  S-expression exposed from `expr` is the simplified form (`simplify` in
  TypeScript and Rust, `SimplifyOrdered` in Go, never `Simplify`).
- **Progress.** Every corpus sweep and benchmark prints a line per
  document or per thirty seconds with a percentage.
- **No `file:` paths, no `replace`, no `go.work` committed.** Local
  wiring through the admin repository's `make link`.

## 6. Decisions for the maintainer

| | Decision | Default the plan takes |
|---|---|---|
| 1 | Dependencies: add `@tabnas/yaml` and `@tabnas/json` (ts peer and dev, go require and direct import, rs path), move the Go requires to their latest releases, extend the CI `deps` string and the Rust CI sibling lists | yes, since the plugin layers on yaml and the strict variant on json |
| 2 | Versions covered by the object-model table | 2.0, 3.0, 3.1, 3.2 |
| 3 | Loader: sync, async or both | sync `resolve`, async `resolveAll` wrapper |
| 4 | Swagger 2.0: full position model, or raw plus local JSON Reference resolution only | full model, since apidef reads 2.0 today |
| 5 | Default `siblings` and `slots` policy | `spec`; apidef migrates with the `compat: 'apidef'` preset and decides later |
| 6 | Taken by the maintainer's direction: the tree layer lands in `expr` first, as the prerequisite of the resolver (Phase E). Still to decide: the order of the Go and Rust ports, and whether `expr` releases the TypeScript layer before both ports run the tree fixtures | ports in the order Go then Rust, as the family's other layers went; release after both, so the fixtures are shared from the first release that carries them |
| 7 | `expr` as a runtime dependency, and what it reads | yes, for the tree layer, in all three manifests on the instruction that follows the `expr` release; the runtime-expression skeleton stays with the lexical readers, since the misreads of the note's E1 are a property of global binding power and do not change with the layer |
| 8 | Whether the in-parse resolve option on `use()` ships in v1 | yes, in TypeScript and Go, as sugar over `ruleDone`; Rust has the function form |
| 9 | Provenance positions always, or only when asked | only when asked (`positions: true`), since it costs a subscriber call per rule |
| 10 | Keep or drop the translation parts the template carries | drop |
| 11 | Duplicate member names: merge (the grammar as configured), last wins (`JSON.parse`, Go, Rust), or an error | last wins through the engine's `map.merge` in all three runtimes; `openapi_duplicate_key` under `strict`; merge restored by the `compat: 'apidef'` preset |
| 12 | The starting version of the new package | the maintainer names it |
| 13 | Schema dialects other than 2020-12 and the OAS dialect | leave verbatim and report, until instructed |
| 14 | apidef's manifest changes for the migration | as Phase 6 states |
| 15 | The descriptor of a grammar-free plugin: no extensions, detection by root key, with or without a minimal grammar file for admin's generator | no extensions, confirm with the admin maintainer |

## 7. Conformance and measurement

Corpora, each vendored or fetched by a pinned script as the family does
for its other suites, with a ledger of every disagreement:

Which corpora run inside the three suites and which are manual sweeps is
decided here, as the template's own conformance standard requires
(auto-built in every runtime, never skipped, a census pinned in all three
runners and held to the docs by a test):

- Inside `npm test`, `go test` and `cargo test`, vendored with a
  `THIRD_PARTY_NOTICES.md` (the template lacks one; yaml has the model):
  the OpenAPI Initiative's examples (3.0, 3.1, 3.2, including the
  multi-document ones) and the specification's own schemas, with raw
  equality against `JSON.parse` of the JSON form and resolution without
  `unresolved`; and the JSON Schema 2020-12 test suite's `$id`, `$anchor`,
  `$dynamicAnchor` and `$ref` cases. A census pinned in all three runners
  and a docs-census test.
- Manual sweeps, fetched by a SHA-pinned script with progress lines, their
  ledgers committed under `test/`: Stripe and GitHub's published
  descriptions (parse time, resolve time, cut count, `unresolved` empty,
  the data-slot census; a regression if any number moves), and the
  APIs.guru directory (a few thousand documents, around a gigabyte, tens
  of minutes).
- apidef's fixture corpus: 45 documents (32 at 3.0.0, 8 at 3.0.3, 2 at
  3.1.0, 3 Swagger 2.0): the `apidef` fixture here, and apidef's full
  suite there.
- The APIs.guru sweep reports "parses, resolves, and the report is empty"
  counts with the version mix and the repeated-key count, not a pass rate
  without a denominator.
- For D1's YAML half, a named reference YAML 1.2 parser's JSON of each
  YAML corpus document, compared less the yaml plugin's registered
  divergences.

## 8. Risks

| Risk | Mitigation |
|---|---|
| Serialising a resolved document is exponential or impossible | output shapes with `inline-once` for anything serialised; `copy` bounded; documented in the API page |
| The loader is a server-side request forgery or file-read vector | off by default, allow-list, budgets; never a default loader that touches the network or disk |
| The object-model table drifts from the specification, or its overlay excuses too much | generated from pinned, dated schemas by a committed tool; the overlay gated like the port-deps register; a staleness test like `schema/error-codes.json` has |
| apidef's output changes on migration | the `compat: 'apidef'` preset and the `apidef` fixture; `decycle` kept; the switch to `spec` a separate, measured step |
| The fast path and the grammar disagree | the duplicate-key policy; `raw-fast.tsv` run on both paths; apidef on `fast: false` until it is pinned |
| Go and Rust diverge on key order, prototypes or the fast path | `OrderedMap` on both Go paths; in-language order tests; the port-deps and version tests the template carries |
| Grammar parse cost on large JSON | the fast path; the grammar for YAML and diagnostics |
| YAML alias expansion | apidef's guard stays until yaml bounds it (an instruction to the yaml maintainer, Phase 5) |
| The first release stalls on registries that do not know the package | the prerequisites checklist in Phase 7, done before any dispatch |
| The yaml plugin's YAML 1.1 scalars and inherited engine divergences make D1 false on real documents | pinned in `raw-yaml-scalars.tsv` and the `divergent.tsv` register, counted in the ledger, repaired upstream in Phase 5 |
| Admin-stamped files keep building ZON's library | the clib rollout row and restamp in Phase 0, before the first release |
| The engine changes land in a different order than planned | nothing in Phases 0 to 4 depends on Phase 5 |
| The `expr` ports lag the TypeScript layer | Phase 2 in Go and Rust waits on Phase E; the TypeScript resolver proceeds against the checkout, and the parity gate for the resolve fixtures runs when the ports land |

## 9. Sequence

```
Phase E  expr tree layer (TS)                   L  landed  ─┐ in tabnas/expr
Phase 0  bootstrap (incl. admin rollout row)   M        ─┐  │
Phase 1  raw mode (TS)                          M         │  │ one PR each, in order
Phase 2  resolver over expr.fold (TS)           L         │  │ against the expr checkout
Phase E  expr ports (Go, Rust), release         L + L    ─┼──┘ then the dependency instruction
Phase 1+2 ports (Go, Rust)                      L        ─┘ parity gate: shared and resolve fixtures
Phase 3  documents and loader                   M + port M
Phase 4  embedded languages                     M + port S
Phase 7  docs, descriptor, bootstrap, release   S + the manual first publish   first release: D1, D2, D3, D4, D6
Phase 6  apidef migration                       M          D5, after the first release
Phase 5  upstream enhancements                  as instructed, in parallel, never blocking
```

The first release follows Phase 4 and the manual bootstrap; apidef
migrates against the published package, as the family's rule for
downstream consumers requires; Phase 5 proceeds on the maintainer's
instruction, each change its own release in its own repository.

## 10. Verification at each step

```sh
make build && make test                 # all three runtimes, locally
(cd ts && npm test)                     # TypeScript alone while iterating
(cd go && GOWORK=off go test ./...)     # Go against the published siblings
ci/rust/run.sh                          # Rust, --locked
make deps                               # once the admin dependency gate is adopted (Phase 0)
node tools/corpus.mjs --only oai,apidef # the conformance sweep, with progress lines
```

A phase is complete when its fixtures are green in every runtime, its
acceptance line in section 4 holds, and its documentation page says what
the code does.
