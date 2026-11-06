# Using `@tabnas/expr` for OpenAPI meta-operations

A design investigation for `@tabnas/openapi`, written before any
implementation. It asks one question: OpenAPI's meta-operations (`$ref`
first of all) look like expression structures, and the family already has
an expression plugin, so how far does `@tabnas/expr` carry the OpenAPI
parser, and what would have to change in `expr`, in the engine, or in the
plan? It records what was measured with a prototype against the published
packages, what the OpenAPI 3.2.0 specification requires, and what
`voxgig/apidef` does today, and ends with recommendations.

This is a working document, not a reader-facing page: it is outside the
prose gate's file list, and its prototype is not part of the build. The
prototype and its captured results are in [`prototype/`](prototype/).

## Summary

- **`expr` is the right tool for the small languages OpenAPI embeds in
  strings, and the wrong tool for `$ref` itself.** Runtime expressions
  (`$request.body#/user/uuid`), JSON Pointer fragments
  (`/components/schemas/Pet`) and path templates (`/pets/{petId}`) are
  operator grammars, and a jsonic+expr instance with a five-line operator
  table reads every example in the specification's own tables into a clean
  S-expression. URIs are not an operator grammar: scheme, authority and
  query come out wrong or fail, so the URI must be split by an RFC 3986
  splitter and only its fragment handed to `expr`.
- **`$ref` is a tree-level operation, and `expr`'s design for it is
  right while its machinery is not.** The two things OpenAPI needs are
  exactly `expr`'s two modes: parse to a structure that keeps the operator
  (the raw tree) or reduce it to a value (the resolved tree). But `expr`'s
  `evaluate` option is eager and runs before the document exists, where
  the specification requires every document to be fully parsed before a
  reference may be judged unresolvable. Its post-parse `evaluation()`
  fold does not descend into objects, in any of the three runtimes. Its
  operator node is an array, which cannot stand in for the verbatim map
  the raw tree must contain, and whose JSON shape already diverges between
  the TypeScript and Go ports. Resolution therefore has to be a post-parse
  walk over a verbatim raw tree, which `expr` as published cannot supply.
- **Recommendation: build `@tabnas/openapi` as a layer over
  `jsonic`+`yaml`, keep the raw tree verbatim, derive the resolved tree in
  a post-parse pass, and use `expr` for the embedded string languages.**
  Borrow `expr`'s shape for the resolution pass (an operator head, terms,
  a bottom-up fold, a `simplify` form for fixtures) without making the
  raw tree an `expr` tree. Four `expr` enhancements and two engine
  enhancements, listed in section 6, would make that borrowing direct
  rather than copied; none is a precondition for starting.

## 1. What OpenAPI needs

The current specification is OpenAPI 3.2.0, published 19 September 2025
(a 3.2.1 patch release exists; nothing below depends on the difference).
Its reference-like constructs fall into five classes.

| Class | Where | Syntax | Resolved against |
|---|---|---|---|
| URI references | Reference Object `$ref`; Path Item `$ref`; Schema Object `$ref`, `$dynamicRef`; Link `operationRef`; Discriminator `mapping` and `defaultMapping` (URI form) | RFC 3986 URI reference, fragment an RFC 6901 JSON Pointer | the OpenAPI Description (every document of it), with base URI from `$self`, `$id`, or the retrieval URI |
| Implicit connections | Link `operationId`; Security Requirement keys; Operation `tags`; Tag `parent`; Discriminator `mapping` (name form); path parameter `name` | a bare name | a named collection in the entry document (`components.securitySchemes`, top-level `tags`, every `operationId`, the path template) |
| Runtime expressions | Link `parameters` and `requestBody` values; Callback Object keys | the ABNF in section 4.20.3 of the specification, embedded in strings with `{}` | an HTTP request and response at run time, not the document |
| Templates | Path Item keys; Server `url` | `{name}` inside a literal | path parameters and server variables |
| Specification extensions | every extensible object | `x-` prefixed keys, any value | nothing: passed through verbatim |

Rules from the specification that shape the design:

- "Each document in an OAD MUST be fully parsed in order to locate
  possible reference targets" and "Implementations MUST NOT treat a
  reference as unresolvable before completely parsing all documents
  provided to the implementation". Resolution is a whole-description
  operation, after parsing.
- A Reference Object's siblings: `summary` and `description` override the
  target's; "any properties added SHALL be ignored". A Schema Object's
  `$ref` is a JSON Schema 2020-12 keyword, and its siblings all apply:
  the specification notes that "this restriction on additional properties
  is a difference between Reference Objects and Schema Objects". A Path
  Item `$ref` with adjacent fields is "undefined". So what `$ref` means
  depends on which object holds it, which is a positional property of the
  document.
- A reference may name a target in another document, relative to a base
  URI that the document may declare (`$self`, `$id`) or that the loader
  supplies (the retrieval URI). Fragments are JSON Pointers, with `~1`,
  `~0` and percent-encoding to decode.
- Runtime expressions "preserve the type of the referenced value" and are
  evaluated against a request or response, never against the document.
  The `{expression}` embedding is a string template around them.
- A discriminator `mapping` value "that is both a valid schema name and a
  valid relative URI reference is implementation-defined, but it is
  RECOMMENDED that it be treated as a schema name".

## 2. What `expr` is, and is not

`@tabnas/expr` is a Pratt operator plugin layered on `jsonic`'s `val`
rule. It turns operator tokens in the token stream into S-expressions
(`[Op, ...terms]`, the head a rich operator description carrying the
source token), and offers two ways to reduce them: an `evaluate` option,
called bottom-up as each expression closes, and an exported
`evaluation(rule, ctx, tree, evaluate)` fold for a tree parsed without
the option. `simplify` renders a tree with each operator as its source
text, which is the form the shared fixtures compare. Go and Rust ports
exist and are held to the TypeScript behaviour by fixtures.

Three properties of the implementation matter here, all read from the
source and confirmed by the prototype:

1. The operator marker is private. `isOp` tests `node[0].OP_MARK` against
   a module-local object; the only way a host can mint an operator is
   `testing.opify`, which the reference marks "not part of the stable
   API". The Go port exports `Opify` and the Rust port `opify`
   publicly.
2. `evaluation()` folds operator nodes and plain arrays and returns
   everything else unchanged. It does not descend into objects, in
   TypeScript (`evaluation` in `ts/src/expr.ts`), Go (`evaluationStep`
   in `go/expr.go`) or Rust (`evaluation` in `rs/src/lib.rs`). With the
   `evaluate` option, values inside maps are reduced because each
   expression reduces itself at close; the standalone fold has no such
   path.
3. The parsed operator node is an array. `DIVERGENCE.md` records that the
   Go port wraps it (`{Val, Child, Implicit, Meta}`) where TypeScript and
   Rust yield the array, and that Go's JSON field names differ. The
   divergence is recorded, pinned, and not repaired, because repairing it
   is a breaking change to the Go API.

## 3. What `voxgig/apidef` does today

`ts/src/parse.ts` in apidef reads the YAML or JSON with `@tabnas/yaml`
and `@tabnas/jsonic`, then runs a single in-place pass,
`addXRefsAndResolve`, over the finished tree:

- Only local pointers (`#/...`) resolve; anything else keeps its `$ref`.
- A site is replaced by the target's members, with the site's own
  siblings winning, and the original pointer recorded as a visible
  `x-ref` key. The specification's Reference Object rule (ignore
  siblings other than `summary` and `description`) and Schema Object rule
  (siblings are a conjunction) are both approximated by this one merge.
- Targets are shared, so the result is a graph; `decycle` then cuts back
  edges to `[Circular *path]` strings so the model can be serialised.
- `yamlalias.ts` bounds YAML alias expansion before parsing, because the
  YAML plugin copies an anchored node for every alias.

The `x-ref` key is a provenance mechanism that changes the document and
sits in the `x-` namespace the specification reserves for extensions. The
single merge rule is the point where a typed OpenAPI parser can do better.
Both are what a consistent `@tabnas/openapi` plugin would replace.

## 4. The experiments

Four scripts, run against the published packages (`@tabnas/parser`
0.12.15, `jsonic` 0.7.10, `expr` 0.5.19, `yaml` 0.5.26, `json` 0.5.19),
under Node 22. Each script's captured output is beside it in
[`prototype/`](prototype/).

### E0: one instance for both serialisations

`new Tabnas().use(jsonic).use(Yaml)` reads the JSON form of a document
identically to the strict `json` grammar and to `JSON.parse`, compact,
two-space indented and tab indented alike, because JSON is YAML 1.2 flow
syntax. It also accepts YAML-only text a strict JSON parser rejects
(`{openapi: 3.2.0}`, a trailing comma, a multi-document stream, which
becomes an array). The YAML grammar's start rule is `stream`; the JSON
and jsonic grammars start at `val`.

### E1: `expr` as a sub-parser for the embedded string languages

A jsonic+expr instance with comments, pairs, containers and the default
operators switched off, and the lexer told not to interpret numbers and
keywords (so a pointer segment `1` is the string `"1"`), reads each class
of string with its own operator table.

Runtime expressions, with `.` (member, tightest), `/` (pointer segment,
prefix and infix), `#` (fragment) and a `{ }` paren: 13 of 14 cases read
as the ABNF says, including every example in the specification's tables.
`$request.body#/user/uuid` reads as
`["#", [".", "$request", "body"], ["/", ["/", "user"], "uuid"]]`;
`{$request.body#/callbackUrl}/data` reads as a template paren followed by
a segment; `$response.header.X-Rate-Limit` keeps the hyphenated token
because subtraction is off. The fourteenth, a full URL with a query
string and two embedded expressions, fails, as expected: that is the `{}`
string template around expressions, not an expression.

`$ref` URIs: the fragment side is right (`#/components/schemas/Pet`,
`#/paths/~12.0~1repositories~1%7Busername%7D/get`, a bare `Pet.yaml`, a
`definitions.yaml#/Pet`), but four cases show the limit. A URL with a
scheme reads `https:` as a path segment and the authority as another. A
space inside a segment becomes a two-element implicit list. A segment
holding a literal `{`, which the specification requires to be
percent-encoded, is accepted without complaint. A bare `#` is accepted as
a one-term operator with no operand (`expr` has a standing TODO to error
on an incomplete expression). None of these is fixable with binding
powers: URI syntax is lexical, with context-dependent delimiters and its
own validity rules, not an operator precedence structure.

Path templates: `/pets/{petId}/photos/{photoId}` reads correctly, but a
literal glued to a template (`/users/{id}.json`, `/files/{path}:download`)
comes out as an implicit list, because Pratt parsing has no juxtaposition
operator and jsonic's implicit list stands in for one. A server URL
template with a scheme and port is unusable.

### E2: `expr`'s `evaluate` is eager and sees no document

A prefix operator `@Pet` meaning "the schema named Pet", evaluated with
the `evaluate` option, cannot resolve whether `components` comes after
`paths` or before it: at the moment the expression closes `ctx.root().node`
is undefined, since the root map is assembled only when its rule closes.
Parsing without `evaluate` and folding afterwards resolves it, but
`evaluation()` applied to the root returns the root untouched (it does
not descend into the maps); applied to the operator node directly it
returns the schema.

### E3: `$ref` as an `expr` operator node, resolved by a post-parse fold

An `OpenApiMeta` plugin with three modes was layered on `jsonic`+`Yaml`
and on the strict `json` grammar:

- `raw`: no hook. The result equals `JSON.parse` of the JSON form, from
  either grammar.
- `ops`: a `val` after-close hook rewrites every map carrying `$ref` into
  `[refOp, uri, siblings]`, with `refOp` minted through `testing.opify`
  and carrying the opening token. `expr`'s `simplify` then prints
  `["$ref", "#/components/responses/PetList", {"description": "..."}]`.
  Of the 9 reference sites in the test document, the hook caught 9 from
  JSON and 8 from YAML: a mapping that starts a block-sequence entry
  (`- $ref: x`) is built by yaml's own `yamlElemMap` and `yamlElemPair`
  rules and pushed into the list without passing through `val`.
- `resolve`: the start rule's after-close (there is no engine end-of-parse
  hook; `rule.start` is read at install time, so the mode depends on
  install order) lifts any remaining `$ref` maps, then walks the tree.
  Each operator node is handed to `expr`'s `evaluation()` with a resolver
  that decodes the fragment, locates the target (following references met
  on the way, so a reference to a reference resolves), walks the target
  first so references inside it resolve too, shares one result per
  target, keeps a cyclic back edge as the verbatim `{ "$ref" }`, applies
  siblings by object kind (override for a Reference Object, `allOf`
  conjunction for a Schema Object), leaves an external reference verbatim
  and reports it, and records provenance on the engine's hidden
  `__info__` marker instead of a visible key.

The resolved trees from the YAML and the JSON input are identical, every
case behaves as designed, and the output serialises. What the experiment
showed about `expr`'s share of that work: `evaluation()` did the fold of
one node at a time and nothing else, because it does not walk objects;
`simplify` was useful for a fixture form; the operator head gave the
resolver the token position for every site built at parse time and none
for the site lifted afterwards; and the raw document had to be kept
verbatim beside the operator tree, since the operator node's JSON is an
array of an operator description.

## 5. Findings

1. **The specification mandates post-parse resolution.** Everything must
   be parsed before a reference may be judged unresolvable. `expr`'s
   `evaluate` runs at expression close and has no view of the document;
   `expr`'s fold form is the right shape, run after the parse.
2. **A raw tree must be verbatim, and an `expr` operator node is not.**
   The raw mode the maintainer asked for ("`$ref` etc. are provided
   verbatim") rules out replacing `{ "$ref": ... }` with
   `[Op, uri, siblings]`. The operator tree is an intermediate
   representation at best, and in Go it is a different JSON shape again.
3. **`evaluation()` does not walk objects, in any runtime.** An OpenAPI
   document is maps nearly all the way down, so the fold cannot be
   applied to it as published. Making it descend is a parity change in
   three runtimes, fixture-pinned.
4. **Parse-time rewriting depends on the base grammar's rule topology.**
   `val` is where every value coalesces in `json` and `jsonic`, but yaml
   builds block-sequence mappings elsewhere. Capturing a site's source
   position at parse time therefore needs either grammar-specific hooks or
   an engine facility; a post-parse walk is grammar-neutral but loses
   positions unless the engine records them.
5. **There is no engine end-of-parse hook.** `parse.prepare` callbacks
   exist; a `finish` counterpart does not. The start rule's after-close
   works, but which rule starts is the grammar's choice (`stream` in
   yaml), so a plugin has to read `rule.start` at install time.
6. **Sibling semantics need positional typing.** The same
   `{ "$ref": X, "description": D }` is an override under `responses`
   and a conjunction under `schemas`. A resolver needs the path to the
   site, or the OpenAPI object kind at the site. `expr`'s post-parse fold
   passes `rule` and `ctx` (null after the parse) and no path; the Rust
   port's `EvalSite` already carries the occurrence token, which is the
   right direction.
7. **`expr` reads the embedded languages well.** Runtime expressions and
   JSON Pointer fragments are operator grammars and read cleanly with a
   small table once scalar interpretation is off. URI syntax and
   literal-plus-template juxtaposition are not, and two defects were
   surfaced along the way: a dangling operator is accepted, and a segment
   containing a space becomes a list.
8. **The operator-minting API is unstable in the canonical port only.**
   Go and Rust export `Opify`/`opify`; TypeScript hides it under
   `testing`. Any sibling plugin building operator nodes needs it public.
9. **One engine instance reads both serialisations.** `jsonic`+`yaml`
   reads JSON text identically to the strict grammar on every form
   tested, and additionally reads YAML. Whether `@tabnas/openapi` should
   accept YAML-only syntax in a `.json` file is a policy choice: the
   strict `json` grammar is available for a strict mode.
10. **apidef's provenance and merge rules are the two places a typed
    parser improves on it.** `x-ref` changes the document and occupies
    the extension namespace; a single merge rule cannot express both
    Reference Object and Schema Object semantics. Its alias-expansion
    guard is a yaml concern worth noting there.

## 6. Recommendations

### 6.1 Shape of `@tabnas/openapi`

- **Layer on `jsonic` and `yaml`**, as the template's ZON plugin layers
  on jsonic: `new Tabnas().use(jsonic).use(Yaml).use(OpenApi, opts)`. One
  instance reads both serialisations. Offer a strict JSON instance
  (`json` + `OpenApi`) for callers that want a `.json` file held to
  RFC 8259; the plugin hooks the same `val` rule in both.
- **Raw mode is the default and is verbatim.** `parse()` returns the
  document as written, `$ref`, `x-` extensions, runtime-expression
  strings and templates untouched. The only additions are hidden: the
  engine's `info` marker on containers, carrying what resolution needs.
- **Resolved mode is a derived tree, produced after the parse.**
  Implement it as a walk over the raw tree, in the shape E3 prototyped:
  decode the URI (RFC 3986 split, percent-decoding, `~1`/`~0`), locate
  through references, resolve targets first, one result per target, back
  edges kept as verbatim `$ref` by default (a tree) with an option to
  share references (a graph, apidef's shape), siblings applied by object
  kind, externals through a `load(uri)` callback with `$self` and the
  retrieval URI as base, unresolved references left verbatim and listed.
  Record provenance on the `info` marker (`{ ref, kind, at }`), with an
  `xref: true` option that also writes apidef's `x-ref` key during
  migration.
- **Type sites by position.** The plugin knows the OpenAPI object model,
  so it can tell a Reference Object slot from a Schema Object slot by the
  path to the site. That is what decides sibling semantics, discriminator
  `mapping` name-or-URI, and which implicit connection a bare name is.
- **Use `expr` for the embedded string languages**, through a second
  small instance owned by the plugin: a runtime-expression grammar
  (`.`, `/`, `#`, `{ }`), a pointer-fragment grammar (`/`), and a
  path-template grammar (`/`, `{ }`) that treats a segment with a literal
  glued to a template as a segment, not a list. Expose the resulting
  S-expressions on the resolved tree (or through a `parseExpression`
  helper) so a client such as apidef can evaluate links and callbacks
  against a request. Keep URI splitting outside `expr`.
- **Do not use `expr` for `$ref` in the document grammar**, as a prefix
  operator on the `$ref` key or as the raw tree's node shape, for the
  reasons in findings 1 to 3.
- **Parity.** A resolved tree is plain data in every runtime, so Go and
  Rust ports carry no `expr` divergence. Pin the raw/resolved pair in
  shared `test/spec` fixtures: raw input, resolved output, and a column
  for unresolved references.

### 6.2 Enhancements to `@tabnas/expr`

In order of value to this plugin. Each is a three-runtime change under
the fixture contract.

1. **A public operator constructor.** Promote `testing.opify` to an
   exported `opify` (Go and Rust already export it) so a sibling plugin
   can mint operator nodes `simplify` and `evaluation` recognise. Small,
   and it removes the only unstable API the prototype had to use.
2. **`evaluation()` over objects.** An option (`evaluation(rule, ctx,
   tree, evaluate, { objects: true })`, or a sibling function) that
   descends into plain objects as it already descends into plain arrays.
   Without it the fold cannot be applied to a document; with it the
   resolved pass in 6.1 is `evaluation` plus a resolver.
3. **Site context for the resolver.** Pass the path (or parent chain)
   to the site alongside `rule` and `ctx`, which are null after a parse.
   The Rust `EvalSite` is the model. Finding 6 needs this for sibling
   semantics; it also lets a resolver report where an unresolved
   reference sits.
4. **A deferred `evaluate`.** `evaluate: { fn, when: 'end' }` that
   collects operator nodes and folds them when the parse completes,
   against the finished root. This depends on the engine `finish` hook
   below, and would make "evaluate against the document" a supported
   `expr` mode rather than a pattern each plugin repeats.
5. **Error on a dangling operator.** The existing TODO; `#` alone and
   `$request.body#` with no pointer should be distinguishable from each
   other by the grammar, and `1+` should fail. The `$ref` sub-parse made
   the silence visible.
6. **Juxtaposition inside a segment**, optionally: a way to say that two
   adjacent terms concatenate rather than form an implicit list, for
   template grammars. Low priority; the path-template grammar can be a
   dedicated lex matcher instead.

### 6.3 Enhancements to `@tabnas/parser`

1. **A `parse.finish` hook**, symmetrical to `parse.prepare`, called with
   the context and the root node once the parse completes and before the
   result is returned. Plugins that post-process a document (this one,
   and `expr`'s deferred mode) would use it instead of hooking whichever
   rule happens to start the grammar.
2. **Source position on the `info` marker.** `@object$` and `@array$`
   attach `{ implicit, meta }` when `info.map`/`info.list` are on; adding
   the opening token's `sI`, `rI`, `cI` would give every post-parse walk
   the provenance E3 could only get from parse-time rewriting, in all
   three runtimes, without a grammar-specific hook.

### 6.4 Notes for `@tabnas/yaml`

Nothing is required. Two facts to record in the openapi plugin's guide:
the start rule is `stream` and a multi-document stream parses to an array
(an OpenAPI Description is one document; the plugin should reject or
select); block-sequence entry mappings bypass `val`. apidef's
alias-expansion bound (`yamlalias.ts`) describes a cost in the yaml
plugin's alias copying that belongs with that plugin, as a documented
limit or an option.

### 6.5 Migration from apidef

The resolved mode replaces `addXRefsAndResolve`, `resolvePointer`,
`followAlias` and `decycle` in apidef's `parse.ts`. The compatibility
points are: `x-ref` (offer the `xref: true` option), shared targets (offer
the graph option), unresolvable pointers left in place (the default here
too), and the single merge rule, which apidef's downstream heuristics may
depend on for Schema Objects; measure that against apidef's fixtures
before switching the default to the `allOf` form.

## 7. Open questions

- Should the resolved tree's default for a Schema Object with `$ref` and
  siblings be the `allOf` conjunction (correct under 2020-12) or the merge
  (what apidef and most tooling do)? The prototype does the former; the
  option is cheap either way.
- Should `$dynamicRef`/`$dynamicAnchor` be resolved in the resolved tree,
  or left verbatim as evaluation-time constructs? The specification treats
  them as JSON Schema keywords; resolving them statically is possible but
  depends on the dynamic scope.
- Where do runtime expressions live on the resolved tree: as strings (raw
  and resolved alike), as S-expressions, or both?
- Does the plugin own a document loader for external references, or only
  the `load(uri)` callback, with the loader in `@tabnas/mcp` or the
  client?

## Appendix: running the prototype

The scripts in [`prototype/`](prototype/) need the five published packages
and nothing from this repository. Install them in a scratch directory
outside any checkout, so no manifest here changes:

```sh
mkdir -p /tmp/openapi-proto && cd /tmp/openapi-proto
npm init -y >/dev/null
npm install @tabnas/parser @tabnas/jsonic @tabnas/expr @tabnas/yaml @tabnas/json
cp <this-repo>/docs/design/prototype/*.js .
node e0-input-formats.js
node e1-ref-syntax.js
node e2-eager.js
node e3-ref-op.js
```

Each script's output as captured for this document is in the
`*.result.txt` file beside it. The versions it was captured against are in
section 4.
