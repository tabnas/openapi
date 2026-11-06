# Implementation plan: `@tabnas/openapi`

A plan to take this repository from the ZON template it was copied from
to a published OpenAPI parser plugin for the tabnas family, in all three
runtimes, with a verbatim raw tree and a derived resolved tree, and to
move `voxgig/apidef` onto it. It is the companion to the design note
[`expr-for-meta-operations.md`](expr-for-meta-operations.md), whose
measured findings it builds on, and to the prototype under
[`prototype/`](prototype/), whose `resolve()` is the sketch of the
resolver this plan specifies.

Status: a proposal for the maintainer, 6 November 2026. Every point
marked **Decision** is one the maintainer makes; the plan names the
default it would take. Every dependency change is a decision, because
this repository's `CLAUDE.md` allows dependency changes only on explicit
instruction, and nothing below is such an instruction.

## 1. Goal and definition of done

The brief: a parser in the tabnas family for OpenAPI documents in JSON and
YAML, meeting the latest specification (3.2.x), returning either the raw
tree, with `$ref` and the other meta-operations verbatim, or a resolved
tree, with `$ref` resolved; replacing the custom OpenAPI handling in
`voxgig/apidef` with a consistent tabnas plugin configuration; and, as
the experimental part, using `@tabnas/expr` where it fits. The design
note settled the experimental part: `expr` reads the operator-shaped
skeleton of a runtime expression and a pointer fragment but misreads
ABNF-legal names, so the embedded languages get lexical readers; `$ref`
is not an operator the lexical `expr` can carry, and a structural
extension of `expr` is an option for later, not a precondition.

The plugin is done, at its first stable release, when all of the
following hold.

| | Outcome | Measured by |
|---|---|---|
| D1 | Any OpenAPI 3.0.x, 3.1.x or 3.2.x document, in JSON or YAML, parses to a raw tree equal, as JSON text, to the document; Swagger 2.0 documents parse the same way (see Decision 4) | shared fixtures; the conformance corpora of section 7 |
| D2 | Resolved mode follows the specification: every document of the description parsed before anything is judged unresolvable; base URIs from `$id`, `$self`, the retrieval URI; `$anchor` and JSON Pointer fragments; sibling rules by version and object kind; implicit connections resolved and reported; cycle and sharing policies; a provenance side table; an `unresolved` report; external documents only through a caller-supplied, bounded loader | shared fixtures with resolved output; the Stripe, GitHub and OAI example corpora |
| D3 | Runtime expressions, path templates and server URL templates are read into structures, cross-checked against the operation statically, and evaluable by a consumer that supplies a request and response | fixtures for the readers; apidef's flow-step tests |
| D4 | TypeScript canonical, Go and Rust ports, held together by shared `.tsv` fixtures; `tabnas.plugin.json` regenerated; the Diátaxis docs; CI green; released through `release.yml` | the family's standard gates |
| D5 | apidef's `ts/src/parse.ts` and `go/parse.go` resolvers are deleted and apidef's own `parse-resolve.tsv` passes against the plugin in both runtimes | apidef's suites |
| D6 | A conformance claim stated as the design note states its findings: which corpora, how many documents, how many agree, and every disagreement listed in a ledger | `test/` ledgers and `AGENTS.md` |

Non-goals: validating instances against schemas, generating code,
making HTTP requests, and evaluating `$dynamicRef`, which depends on a
validation-time dynamic scope the parser does not have.

## 2. What the plan rests on

Facts from the design note and its review that fix the shape of the work:

- The raw tree must stay verbatim, and in every runtime. The engine's
  `info` marker is a hidden property in TypeScript only; in Go and Rust it
  swaps the container type (`MapRef`, `ListRef`), so provenance cannot
  ride it without changing node types for Go consumers. Provenance goes in
  a side table keyed by JSON Pointer path.
- Resolution runs after the whole parse. The engine's post-process rule
  subscriber, `tn.sub({ ruleDone })`, fires grammar-neutrally after every
  pass in all three runtimes; filtered to the depth-0 close whose
  alternate neither pushes nor replaces, outside probes and recovery, it
  fires exactly once per parse, after yaml's `stream` rotations too, and
  `ctx.root().node` then holds the result (prototype E3, case 5). A
  plugin can therefore offer resolution inside `parse()` today; the engine
  hook of section 5 is a convenience, not a prerequisite. In Rust the
  subscriber observes and cannot replace the result, so the function form
  below is the primary API and the in-parse option is sugar.
- What `$ref` means depends on the document version and the object at
  the site: Swagger 2.0 is JSON Reference everywhere (siblings ignored);
  3.0.x makes a `$ref` map a Reference Object wherever it stands, Schema
  Objects included; 3.1 and later keep the Reference Object rule
  (`summary` and `description` override) and make a Schema Object's
  `$ref` a JSON Schema 2020-12 keyword whose siblings all apply. Under
  `x-` extensions, `example`, an Example Object's `value`, `const`,
  `enum` and a schema `default` a `$ref` key is data. In Stripe's
  description 492 of 4062 `$ref` maps sit in such slots.
- A resolved document is a graph. Stripe's description resolves in
  256 ms to a DAG with 125 cycle cuts, and `JSON.stringify` of that DAG
  fails after 90 s with "Invalid string length"; a 1.9 KB document whose
  schemas each refer twice to the next serialises to 7.4 MiB at depth 16.
  Shared targets inline exponentially. The resolved result is for
  in-memory consumers, and any serialised form needs a sharing policy.
- On JSON input the grammars cost two orders of magnitude more than
  `JSON.parse` (3.2 s and 3.8 s against 30 ms on 7.9 MiB) and give the
  same value. A fast path is worth having.
- `jsonic`+`yaml` reads JSON text identically to the strict `json`
  grammar and additionally reads YAML, including forms a strict JSON
  reader rejects. An unquoted `$ref: #/x` in YAML is a comment and reads
  as `null`; `swagger: 2.0` unquoted reads as the number 2.
- The family's rules bind every phase: TypeScript canonical, Go and Rust
  ports pinned by shared fixtures in `test/spec/*.tsv` (three columns:
  `input`, `expected`, `opts`); dependencies change only on instruction;
  every transient task reports progress; pull requests ready for review.

## 3. The shape being built

### 3.1 Packages and layering

```
@tabnas/parser  (engine)
  └── @tabnas/json → @tabnas/jsonic → @tabnas/yaml
                                         └── @tabnas/openapi   (this repository)
@tabnas/expr    (optional: the operator-shaped skeleton of a runtime expression)
```

`@tabnas/openapi` is a plugin on `jsonic`+`yaml`, as the ZON template is a
plugin on `jsonic`. A strict variant on `json` alone serves callers who
want a `.json` file held to RFC 8259. It has no runtime dependency on
`expr` (Decision 7).

### 3.2 Public surface

TypeScript, with Go and Rust mirroring it in their idiom:

```ts
import { OpenApi, make, parse, resolve, readExpression, readTemplate, evaluateExpression } from '@tabnas/openapi'

const tn = new Tabnas().use(jsonic).use(Yaml).use(OpenApi, {
  strict: false,          // true: YAML-only syntax in a document is an error
  fast: 'auto',           // JSON text through JSON.parse when the result is identical
})
const raw = tn.parse(text)                         // verbatim; the default
const out = resolve(raw, {                         // the derived tree, after the parse
  version: 'auto',                                 // '2.0' | '3.0' | '3.1' | '3.2'
  documents: { load, allow, maxDocuments, maxBytes },   // off unless `load` is given
  cycles: 'cut',                                   // 'cut' | 'keep'
  sharing: 'share',                                // 'share' | 'inline-once' | 'copy'
  siblings: 'spec',                                // 'spec' | 'merge' (apidef's rule)
  xref: false,                                     // write apidef's x-ref key beside each resolved site
  extensions: [],                                  // x- keys whose values ARE resolved (Stripe's x-expansionResources)
})
// out: { tree, version, unresolved, provenance, cuts, connections, documents }
```

`use(OpenApi, { resolve: {...} })` is sugar that runs `resolve` at end of
parse through the `ruleDone` subscriber and returns `out.tree` from
`parse()`, with the report delivered through an `onResolved` callback
(plugin options are deep-copied, so a mutable array passed in never
reaches the caller). The function form is primary because apidef mutates
the raw tree between parsing and resolving.

### 3.3 Output shapes

| `sharing` | `cycles` | In memory | Serialisable | For |
|---|---|---|---|---|
| `share` | `cut` | a DAG: one object per target, back edges as verbatim `{ $ref }`, each cut recorded in `cuts` | not in general (exponential) | in-memory consumers that follow object identity; apidef with `cuts` standing in for its `decycledChild` |
| `share` | `keep` | a cyclic graph | no | consumers that want object identity for recursion |
| `inline-once` | `cut` | a tree: the first site naming a target gets the value, later sites keep `{ $ref }` with provenance | yes, bounded by the document size | serialised output, diffs, fixtures |
| `copy` | `cut` | a tree with every site inlined | only within a size budget, which the call must set | the shape most tooling expects; refused above the budget |

### 3.4 Error codes

Declared in `options.error` with hints, pinned by `ERROR:<code>` fixture
rows, listed in the descriptor:

`openapi_root` (the document is not an object), `openapi_version`
(neither `openapi` nor `swagger`, or an unsupported value),
`openapi_stream` (a YAML stream of several documents), `openapi_ref_type`
(a `$ref` whose value is not a string, which is what an unquoted YAML
`#/...` produces), `openapi_pointer` (a fragment that is neither a JSON
Pointer nor a known anchor), `openapi_unresolved` (strict mode only: a
reference that names nothing), `openapi_load` (a document load refused or
over budget), `openapi_expression` (a runtime expression or template that
does not match the ABNF).

Unresolvable references are not errors by default: they stay verbatim and
appear in `unresolved`, as the specification's "MUST NOT treat as
unresolvable before parsing all documents" and apidef's behaviour both
want.

### 3.5 Fixtures

The family's three-column `.tsv`, unchanged, with the mode in `opts`:

```
input	expected	opts
{"openapi":"3.1.0","a":{"$ref":"#/b"},"b":{"x":1}}	{"tree":{...},"unresolved":[],"cuts":[]}	{"resolve":{"sharing":"inline-once"}}
```

A resolved fixture's `expected` is the whole report (`tree`, `unresolved`,
`cuts`, `connections`), serialised with `inline-once`, so a row is finite.
Raw fixtures and error rows use the two columns as every other plugin
does. The loaders in the three runtimes already read `opts`; what is new
is only the convention.

## 4. Work breakdown

Sizes are relative: S is a day or two of focused work in one runtime, M a
week, L several weeks. "Port" means Go and Rust each, after TypeScript,
with the shared fixtures as the contract.

### Phase 0: bootstrap the repository from the template (S)

The template guide (`TEMPLATE.md`) is the checklist; the repository is
still `@tabnas/zon` in every manifest.

1. Rename the packages: `ts/package.json` to `@tabnas/openapi`, `go/go.mod`
   to `github.com/tabnas/openapi/go`, `rs/Cargo.toml` to `tabnas-openapi`
   (library name `tabnas_openapi`); `ts/src/zon.ts` to `openapi.ts`,
   `go/zon.go` to `openapi.go`; the `VERSION` constants; the Makefile's
   `publish-go` sed target.
2. Remove what is ZON's: `zon-grammar.jsonic` and the embed step
   (`ts/embed-grammar.js` stays only if the plugin keeps an embedded
   grammar text, which it does not need), the `zonDot`/`zonMultiString`/
   `zonChar` matchers, `scripts/fetch-zigzon.sh`, `test/zigzon`,
   `test/strictness`, the `corpus` Makefile target and the `pretest`
   hook that runs it, `rs/src/lex.rs` and `rs/src/number.rs`, the ZON
   fixtures in `test/spec/`, and the ZON prose in the four Diátaxis pages
   and the READMEs.
3. **Decision 1 (dependencies).** `ts/package.json` adds `@tabnas/yaml` as
   a peer dependency (`>=0`) mirrored as a `*` dev dependency, beside the
   existing `@tabnas/jsonic` and `@tabnas/parser`; `go/go.mod` requires
   `github.com/tabnas/yaml/go` at its latest release; `rs/Cargo.toml`
   takes `tabnas-yaml = { path = "../../yaml/rs" }`. `.github/workflows/ci.yml`
   extends `deps:` to `"parser support debug json jsonic yaml"`. The port
   dependency register `tools/port-deps.json` is regenerated.
4. Rewrite `AGENTS.md` for this plugin, keeping the three standard
   sections (`Verify your work`, `Error codes`, `Untrusted input`);
   `CLAUDE.md` stays a pointer. Regenerate `tabnas.plugin.json` with the
   admin repository's `make ax-descriptor` once the error table exists
   (never hand-edit it); the descriptor's `base` becomes `@tabnas/yaml`.
5. Verification: `make build && make test` green in all three runtimes
   with an empty grammar extension (the plugin installs and parses the
   petstore YAML and JSON to the same raw tree as `jsonic`+`yaml` alone).

### Phase 1: raw mode (M, then port M)

1. The `OpenApi` plugin: installs after `yaml`; applies `info` only when
   asked (and after `use(jsonic)`, which resets it); rejects a stream of
   several documents (`openapi_stream`); detects the version from
   `openapi` or `swagger` (string or number); validates the root
   (`openapi_root`, `openapi_version`); records nothing on the tree.
2. `fast: 'auto'`: when the text is JSON (first non-space character `{`),
   `JSON.parse` it and fall back to the grammar on any syntax error, so
   diagnostics still come from the engine; `fast: false` always runs the
   grammar; the output is identical by construction (E0, bench).
   Containers from the grammar have a null prototype and those from
   `JSON.parse` do not: normalise to null-prototype objects in the fast
   path so `__proto__` keys stay data and both paths agree.
3. `strict: true`: the plugin installs on `json` alone (the `make` helper
   builds that instance) so YAML-only syntax in a `.json` file is an
   error.
4. Fixtures: `test/spec/raw-json.tsv`, `raw-yaml.tsv` (block and flow
   forms, `- $ref:` entries, quoted and unquoted keys, the unquoted `#/x`
   that reads as null), `raw-errors.tsv` (the codes above),
   `raw-versions.tsv` (2.0, 3.0.x, 3.1.x, 3.2.x detection).
5. Ports. The Go plugin on `github.com/tabnas/yaml/go`'s `MakeJsonic`
   instance; the Rust plugin on `tabnas_yaml`. The fast path in Go is
   `encoding/json` into `map[string]any` with key order kept through
   `OrderedMap` where the engine would keep it; in Rust `serde_json` into
   `Value`. Parity on key order is a fixture row.
6. Acceptance: every raw fixture green in three runtimes; the OAI
   examples corpus (section 7) parses without error; Stripe's description
   parses in under 100 ms on the fast path and under 5 s on the grammar.

### Phase 2: the resolver on one document (L, then port L)

The prototype's `resolve()` is the sketch; this phase makes it exact.

1. **The object model.** A table of every position in a document for each
   supported version, derived from the specification's own JSON Schema of
   the format (the OAI repository publishes schemas for 3.0, 3.1 and 3.2;
   Swagger 2.0 has one too), generated into source by a tool in `tools/`
   and committed, not hand-written regexes. For each position it says: is
   this slot a Reference Object, a Schema Object, a Path Item, data, or a
   named-connection site (security requirement key, `operationId`, tag,
   discriminator mapping)? An unknown position is data. **Decision 2:**
   which versions the table covers (default: 2.0, 3.0, 3.1, 3.2).
2. **Sibling rules** by version and kind, as in section 2; `siblings:
   'merge'` reproduces apidef's single rule for migration.
3. **Reference resolution**: RFC 3986 split; percent-decode the fragment,
   then split, then `~1`/`~0`; plain-name fragments through the anchor
   index; targets resolved before use (a reference to a reference); one
   result per target; cycle detection by node (a target still being
   walked) and by URI (a chain); `cuts` recorded with holder path, key and
   target path; non-object targets allowed (a boolean schema, a string
   under 2020-12) and reported.
4. **Output shapes** of section 3.3, with `copy` refusing above a byte
   budget rather than producing an unserialisable value.
5. **Provenance** as a side table `{ at, ref, kind, line, col }`. Line and
   column come from parse-time capture: a `ruleDone` subscriber records
   the opening token of every container by path while parsing, in all
   three runtimes, with no grammar-specific hook (the review measured it
   reaching yaml's block-sequence entry mappings). Positions are
   optional; without the subscriber the table carries `at` and `ref`
   only.
6. **Writes are defined, not assigned**, into null-prototype objects, so a
   `__proto__` key survives as data; a fixture pins it.
7. **Report**: `unresolved` (`at`, `ref`, `why`), `cuts`, `connections`
   (every implicit connection and whether its target exists, so a
   dangling security scheme name or `operationId` is visible), `version`.
8. Fixtures: `resolve-basic.tsv`, `resolve-siblings-<version>.tsv`,
   `resolve-cycles.tsv` (the three orders the review listed: reference
   first, target first, a two-schema ring), `resolve-sharing.tsv`,
   `resolve-data-slots.tsv`, `resolve-pointers.tsv` (`~1`, `~0`, `%2F`,
   `%7B`, empty fragment, trailing slash, array indices, non-object
   targets), `resolve-proto.tsv`, `resolve-connections.tsv`, each with
   `inline-once` serialisation.
9. Acceptance: fixtures green in three runtimes; Stripe and GitHub
   resolve with `unresolved` empty and the cut count stable; apidef's
   `parse-resolve.tsv` passes with `{ siblings: 'merge', xref: true,
   sharing: 'share' }` (the migration gate, exercised early).

### Phase 3: several documents and base URIs (M, then port M)

1. A documents table keyed by `$self`, falling back to the retrieval URI,
   each entry carrying its root kind (OpenAPI Object or Schema Object),
   base URI, and its `$id`/`$anchor`/`$dynamicAnchor` index; the entry
   document first.
2. The base URI of every node: nearest `$id`, else the document's
   `$self`, else its retrieval URI, computed in the same walk that builds
   the index (prototype E4's `inherit`).
3. The loader contract, **off by default**: `documents.load(uri)` returns
   `{ text, retrievalUri }`; only an absolute URI that passed resolution
   and matches `documents.allow` (a list of base URIs or a predicate)
   reaches it; `maxDocuments` and `maxBytes` bound the walk; a load cycle
   is detected by URI. A loaded document is parsed by the same instance
   and typed from the referring site's kind, per Appendix G of the
   specification. **Decision 3:** sync, async, or both. Default: a
   synchronous loader for `resolve()`, and an `async resolveAll()` that
   loads first and then calls the synchronous resolver, so Go and Rust
   need only the synchronous form.
4. Implicit connections across documents as the specification recommends:
   components and tags from the entry document, `operationId` from all
   parsed documents, security requirement keys by name first then as a
   URI (the specification makes the name precedence a MUST there),
   discriminator mapping by name first then URI, `./x` forcing the URI
   reading.
5. Fixtures: two-document sets under `test/spec/docs/<case>/` with a
   driver row naming the entry file, since a `.tsv` row holds one input;
   the Rust and Go loaders read the same directory.
6. Acceptance: the specification's own multi-document examples resolve;
   a reference to a URI outside `allow` is refused with `openapi_load`
   and leaves the site verbatim; the walk stops at the budgets.

### Phase 4: the embedded languages (M, then port S)

1. `readExpression(text)`: a lexical reader for the runtime-expression
   ABNF. `$url`, `$method`, `$statusCode`; `$request.` or `$response.`
   then `header.`, `query.`, `path.` with the rest of the string as the
   name (one token, dots and all), or `body` with an optional `#` and a
   JSON Pointer split by RFC 6901. Output: a small structure
   `{ source, kind, name, pointer }`, and its `simplify`-style array form
   for fixtures. **Decision 7:** whether `expr` reads the skeleton
   (`source ["#" pointer]`) at all; default no, since E1 showed the
   tokens must be lexical and the skeleton is three cases.
2. `readTemplate(text)`: a splitter for `{name}` templates, RFC 6570
   level 1 shape, for Path Item keys, Server `url` and Callback keys;
   literal runs and `{...}` pieces; `openapi_expression` on an unbalanced
   brace. For a Callback key each piece is a runtime expression.
3. Static checks in `resolve()`: every `$request.path.x` and
   `$request.query.x` in a Link names a declared parameter of the owning
   operation; every path template expression has a path parameter and
   vice versa; every server variable in a `url` is declared; results in
   `connections`.
4. `evaluateExpression(expr, { request, response })` for consumers: the
   value the expression names, with the type preserved, or `undefined`
   when it fails, as the specification says of Link parameters.
5. Fixtures: `expression-read.tsv` with the specification's examples and
   the adversarial names E1 measured; `template-read.tsv` with apidef's
   `/customers/{id}.json` and `/schedules/{id}:cancel` shapes;
   `expression-eval.tsv` with a request and response in `opts`.

### Phase 5: upstream enhancements (each its own PR, each a maintainer instruction)

None blocks the phases above; each removes a workaround or widens reuse.
Order by value.

| Repository | Change | Why | Size | Breaking |
|---|---|---|---|---|
| expr | export `opify` and `isOp` (TypeScript only; Go and Rust already export) | any sibling that builds or walks operator nodes needs them; the prototypes used `testing.opify` | S | no |
| expr | `evaluation()` descends into objects | the post-parse fold disagrees with the eager `evaluate` on every map, and the guide promises parse-once-evaluate-many; a consistency repair with a new post-parse fixture runner in three runtimes; Go must keep `OrderedMap` | M | yes, if default; no, as an option |
| expr | carry the occurrence token on the Go operator node | TypeScript and Rust give a resolver the token; Go gives none | S | no, on `ListRef.Meta` |
| expr | a structural operator kind and a tree fold (design note section 6) | lets `$ref`-like keyword operators share `expr`'s S-expression, `simplify` and fixtures with other `$`-keyword formats | L | no, additive |
| parser | a `parse.complete` hook (not `finish`, which `rule.finish` already uses): `(tabnas, ctx, meta) => result | void`, after the trailing-content check, before `result.fail`, never on a throw, `{ value, errors }` under recovery, insertion order in all three runtimes (and `prepare`'s Go sort repaired with it) | a declarative, grammar-level end of parse that can replace the result in Rust, which `ruleDone` cannot | M | no |
| parser | `MarshalJSON` for Go's `MapRef`/`ListRef` emitting the value | with `info` on, Go's raw tree is not verbatim as JSON today | S | no |
| yaml | `yamlElemMap` and the block-sequence builders attach the `info` marker (or use `@object$`/`@array$`) | the marker is absent on exactly the `- $ref:` shape until then | S | no |
| jsonic | `use(jsonic)` merges rather than resets `info` | the option set on the constructor is lost | S | no |

**Decision 6:** which of these to instruct, and when. The plan proceeds
without any of them.

### Phase 6: apidef migration (M in apidef, both runtimes)

Gated on D4: both the TypeScript and the Go ports shipping, with
`parse-resolve.tsv` green in both.

| apidef behaviour today (`ts/src/parse.ts`, `go/parse.go`) | After |
|---|---|
| `yamlParser(source)` on `Jsonic.make().use(Yaml)` | `@tabnas/openapi`'s instance; `strict: false`, `fast: 'auto'` |
| `wellFormed` (lone-surrogate repair) | kept in apidef, before `resolve()` (a text concern) |
| `normalizePathKeys`, `normalizeColonPathParams`, `dropIgnoredHeaders` | kept in apidef, before or after `resolve()` as today |
| `components` default | kept in apidef |
| `addXRefsAndResolve`, `resolveRefSite`, `resolvePointer`, `followAlias`, `refSiblings`, `replaceOwnKeys` | `resolve(raw, { siblings: 'merge', xref: true, sharing: 'share', cycles: 'cut' })` |
| `decycle`, `DECYCLED`, `decycledChild` (used by `refcount.ts`) | `out.cuts` gives holder, key and target; `decycledChild` reads it; `decycle`'s `[Circular *path]` strings become `{ $ref }` stubs, which `refcount.ts` already reads as labels |
| `swagger` acceptance | `version: 'auto'` (Decision 4) |
| `yamlalias.ts` expansion guard | kept in apidef until the yaml plugin offers the bound |
| Go `parse.go` twins of all of the above | the Go port, same options |

Acceptance: apidef's whole suite green in both runtimes with the resolver
code deleted; then, as a separate decision, `siblings: 'spec'` tried
against the fixtures to see what the correct semantics change.

### Phase 7: docs, tooling, release (S each)

1. The four Diátaxis pages per runtime, the READMEs, `doc/` for what is
   language-neutral (the object-model table's derivation, the output
   shapes), the prose gate green.
2. `tabnas.plugin.json` regenerated; the fleet roster
   (`ci/fleet/fleet.json` in the engine repository) gains the row; the
   `@tabnas/mcp` CLI and `tabnas/skills` learn the plugin's options.
3. Release through `release.yml` (`workflow_dispatch` on `main`, `go:
   true`) after `main` is green, as the engine's `AGENTS.md` describes;
   crates through `crates-release.yml`.
4. The conformance claim written up as section 7 specifies.

## 5. Cross-cutting rules

- **Untrusted input.** Parsed content is data. A `$ref` URI is derived from
  parsed content, so following it is a file read or a network request on
  the document's say-so: loading is off unless the caller supplies
  `load`, and then only URIs within `allow`, within `maxDocuments` and
  `maxBytes`. Resolution itself is bounded by the document: memoisation
  makes it linear in the number of nodes, and `copy` sharing is refused
  above its budget. Keys named `__proto__` are data.
- **Parity.** TypeScript is canonical; a Go or Rust difference is a
  fixture failure, or a `DIVERGENCE.md` entry with a register row. Known
  places to watch: Go's `OrderedMap` versus `map[string]any` on the fast
  path; the null prototype of engine containers in TypeScript; any
  S-expression exposed from `expr` is the simplified form (`simplify`
  in TypeScript and Rust, `SimplifyOrdered` in Go, never `Simplify`).
- **Progress.** Every corpus sweep and benchmark prints a line per
  document or per thirty seconds with a percentage.
- **No `file:` paths, no `replace`, no `go.work` committed.** Local
  wiring through the admin repository's `make link`.

## 6. Decisions for the maintainer

| | Decision | Default the plan takes |
|---|---|---|
| 1 | Dependencies: add `@tabnas/yaml` (ts peer and dev, go require, rs path), extend the CI `deps` string | yes, since the plugin layers on yaml |
| 2 | Versions covered by the object-model table | 2.0, 3.0, 3.1, 3.2 |
| 3 | Loader: sync, async or both | sync `resolve`, async `resolveAll` wrapper |
| 4 | Swagger 2.0: full position model, or raw plus local JSON Reference resolution only | full model, since apidef reads 2.0 today |
| 5 | Default `siblings` policy | `spec`; apidef migrates with `merge` and decides later |
| 6 | Which upstream enhancements to instruct, and when | `opify`/`isOp` and the Go token first; the object-walking fold as an expr repair; the rest when a consumer needs them |
| 7 | Whether `expr` reads the runtime-expression skeleton | no: lexical readers only; `expr` stays a dev dependency at most |
| 8 | Whether the resolved-mode option on `use()` ships in v1 or only `resolve()` | both, the option as sugar over `ruleDone` |
| 9 | Provenance positions: always captured by the `ruleDone` subscriber, or only when asked | only when asked (`positions: true`), since it costs a pass per rule |

## 7. Conformance and measurement

Corpora, each vendored or fetched by a pinned script as the family does
for its other suites, with a ledger of every disagreement:

- The OpenAPI Initiative's examples (3.0, 3.1, 3.2, including the
  multi-document ones) and the specification's own schemas: raw equality
  with `JSON.parse` of the JSON form; resolution without `unresolved`.
- Stripe and GitHub's published descriptions: parse time, resolve time,
  cut count, `unresolved` empty; a regression if any number moves.
- apidef's fixture corpus: 45 documents (32 at 3.0.0, 8 at 3.0.3, 2 at
  3.1.0, 3 Swagger 2.0): `parse-resolve.tsv` and the full suite.
- A real-world sweep (the APIs.guru directory, a few thousand documents):
  "parses, resolves, and the report is empty" counts, published with the
  version mix, not as a pass rate without a denominator.
- The JSON Schema 2020-12 test suite's `$id`, `$anchor` and `$ref` cases,
  for the resolver's base-URI handling.

## 8. Risks

| Risk | Mitigation |
|---|---|
| Serialising a resolved document is exponential or impossible | output shapes with `inline-once` default for anything serialised; `copy` bounded; documented in the API page |
| The loader is a server-side request forgery or file-read vector | off by default, allow-list, budgets; never a default loader that touches the network or disk |
| The object-model table drifts from the specification | generated from the OAI schemas by a committed tool, with the schema version pinned and a staleness test like `schema/error-codes.json` has |
| apidef's output changes on migration | `siblings: 'merge'` and `xref: true` reproduce today's rule; `parse-resolve.tsv` is the gate; the switch to `spec` is a separate, measured step |
| Go and Rust diverge on key order, prototypes or the fast path | fixture rows for each; the port-deps and version tests the template carries |
| Grammar parse cost on large JSON | the fast path; the grammar for YAML and diagnostics |
| YAML alias expansion | apidef's guard stays until yaml bounds it (an instruction to the yaml maintainer, Phase 5) |
| The engine or expr changes land in a different order than planned | nothing in Phases 0 to 4 depends on Phase 5 |

## 9. Sequence

```
Phase 0  bootstrap                      S        ─┐
Phase 1  raw mode (TS)                  M         │ one PR each, in order
Phase 2  resolver (TS)                  L         │
Phase 1+2 ports (Go, Rust)              L        ─┘ parity gate: shared fixtures
Phase 3  documents, base URIs           M + port M
Phase 4  embedded languages             M + port S
Phase 7  docs, descriptor, release      S          first release here: D1, D2, D3, D4, D6
Phase 6  apidef migration               M          D5, after the first release
Phase 5  upstream enhancements          as instructed, in parallel, never blocking
```

The first release can follow Phase 4; apidef migrates against the
published package, as the family's rule for downstream consumers
requires; Phase 5 proceeds on the maintainer's instruction, each change
its own release in its own repository.

## 10. Verification at each step

```sh
make build && make test                 # all three runtimes, locally
(cd ts && npm test)                     # TypeScript alone while iterating
(cd go && GOWORK=off go test ./...)     # Go against the published siblings
ci/rust/run.sh                          # Rust, --locked
make deps                               # committed dependency sources
node tools/corpus.mjs --only oai,apidef # the conformance sweep, with progress lines
```

A phase is complete when its fixtures are green in every runtime, its
acceptance line in section 4 holds, and its documentation page says what
the code does.
