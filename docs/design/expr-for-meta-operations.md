# Using `@tabnas/expr` for OpenAPI meta-operations

A design investigation for `@tabnas/openapi`, written before any
implementation. It asks one question: OpenAPI's meta-operations (`$ref`
first of all) look like expression structures, and the family already has
an expression plugin, so how far does `@tabnas/expr` carry the OpenAPI
parser, and what would have to change in `expr`, in the engine, or in the
plan? It records what was measured with a prototype against the published
packages, what the OpenAPI 3.2.0 specification requires, and what
`voxgig/apidef` does today, and ends with recommendations. The
[implementation plan](implementation-plan.md) builds on it.

This is the sixth revision. The fifth followed the maintainer's direction
that `expr` is vital and central to this work, a forcing function to make
`expr` more general: the tree layer of section 6 was built in `expr`
itself (`tabnas/expr` pull request 100, TypeScript) and measured against
the OpenAPI requirements as experiment E6. The recommendations of 6.4 and
8.2 are superseded by that direction and marked where they stand; the
extension itself is recorded in
[`expr-tree-layer.md`](expr-tree-layer.md). The sixth revision follows a
five-lens review of the layer and of the fifth revision, which found,
among other things, that the Stripe figures compared E6 with a capture of
E3 taken before E3 was repaired; E5 was re-run, and E5 and E6 now give
today's numbers. The second revision was reviewed by three independent
readers and sixteen claim-by-claim verifiers, and a three-designer panel
with two judges took up the question of section 6; several statements did
not survive: an engine facility the note had missed, a wrong reason in one
experiment, an untested report, a missing version axis, an over-claim for
runtime expressions, and, in the third revision, a memoisation defect
that broke sharing and a Path Item test that never matched. Each
correction is marked where it lands, and the prototype was re-run after
each.

This is a working document, not a reader-facing page: it is outside the
prose gate's file list, and its prototype is not part of the build. The
prototype and its captured results are in [`prototype/`](prototype/).

## Summary

- **`expr` reads the operator-shaped skeleton of OpenAPI's embedded
  strings and nothing more; the strings are lexical.** A jsonic+expr
  instance with a five-entry operator table reads every runtime
  expression in the specification's tables into a clean S-expression,
  and every JSON Pointer fragment whose tokens are non-empty and hold no
  `.` or `,`. But the ABNF makes everything after `header.`, `query.` and
  `path.` one name, dots included, and a pointer token may hold `.` or
  `,`; a binding power is global, so the member operator that reads
  `$request.body` also splits `X.Y` and `user.name`. Five of seven
  ABNF-legal adversarial names misread. URIs, path templates
  and server URL templates are not operator-shaped at all. The embedded
  languages get lexical readers; `expr` is at most a convenience for the
  three-case skeleton.
- **`$ref` is a tree-level operation, and `expr`'s design for it is
  right while its machinery is not.** OpenAPI needs exactly `expr`'s two
  modes: parse to a structure that keeps the operator (the raw tree) or
  reduce it to a value (the resolved tree). But `expr`'s `evaluate` is
  eager and runs before the document is complete, so a forward reference
  cannot be resolved there, where the specification requires every
  document to be parsed first. Its post-parse `evaluation()` fold does not
  descend into objects, in any of the three runtimes. Its operator node is
  an array, which cannot stand in for the verbatim map the raw tree must
  contain, and whose JSON shape already diverges in Go. Resolution is a
  walk over a verbatim raw tree after the parse, which the engine's
  `ruleDone` subscriber can trigger grammar-neutrally today, and which the
  prototype's `resolve()` sketches. Experiment E4 shows what making `expr`
  carry `$ref` would mean: not a new kind of value, since terms may
  already be containers, but operators recognised by node shape and a fold
  that walks the tree carrying context down as well as values up. **That
  extension now exists in `expr`** (fifth revision): key operators
  declared `{ key: true, src: '$ref' }`, `fold(root, options)` with a
  site, an inherited bag, one result per location, a cycle rule, several
  documents, a host's say over what is a site, and a deferred mode
  through the engine's `ruleDone` event; experiment E6 runs the OpenAPI
  resolver as a vocabulary over it.
- **Recommendation: build `@tabnas/openapi` as a layer over `jsonic`+`yaml`
  with `parse()` returning the verbatim document and an exported
  `resolve(raw, options)` returning a report around a derived tree; type
  every site by the document's version and the object model's position;
  keep loading off by default; treat the resolved result as a graph and
  give any serialised form a sharing policy; read runtime expressions and
  templates lexically; and, by the maintainer's direction, build the
  resolver on `expr`'s tree layer, with `expr` a runtime dependency.**
  The layer is in `expr`'s TypeScript; the Go and Rust ports and the Go
  occurrence token are what remain upstream, and the plugin's Phase 2 is
  written against the checkout until the layer is published.

## 1. What OpenAPI needs

The current specification is OpenAPI 3.2.0, published 19 September 2025
(a 3.2.1 patch release exists; nothing below depends on the difference).
Its reference-like constructs fall into five classes.

| Class | Where | Syntax | Resolved against |
|---|---|---|---|
| URI references | Reference Object `$ref`; Path Item `$ref`; Schema Object `$ref`, `$dynamicRef`; Link `operationRef`; Discriminator `mapping` and `defaultMapping` (URI form); Security Requirement keys (URI form) | RFC 3986 URI reference; the fragment a JSON Pointer (a location) or a plain name declared by `$anchor` | the OpenAPI Description, every document of it, with the base URI from the nearest `$id`, else the document's `$self`, else its retrieval URI |
| Implicit connections | Link `operationId`; Security Requirement keys (name form); Operation `tags`; Tag `parent`; Discriminator `mapping` (name form); path parameter `name` | a bare name | `components` and `tags` of the entry document; every `operationId` of every parsed document; the path template |
| Runtime expressions | Link `parameters` and `requestBody` values, as bare expressions; Callback Object keys, embedded in a string with `{}` | the ABNF in section 4.20.3 of the specification | an HTTP request and response at run time, not the document |
| Templates | Path Item keys; Server `url`; Callback keys around their expressions | `{name}` inside a literal | path parameters and server variables |
| Specification extensions | every extensible object | `x-` prefixed keys, any value | nothing: passed through verbatim |

Two of those rows were corrected by the review. Security Requirement keys
are a name-or-URI pair like discriminator mapping values, and there the
name reading is mandatory: "property names that are identical to a
component name under the Components Object MUST be treated as a component
name", with `./foo` to force a URI (section 4.30). And multi-document
resolution of the implicit connections is "implementation-defined"
(section 4.1.2.3): it is RECOMMENDED that `operationId` be sought in "all
Operation Objects from all parsed documents" and that component and tag
names be resolved from the entry document.

Rules from the specification that shape the design:

- "Each document in an OAD MUST be fully parsed in order to locate
  possible reference targets" and "Implementations MUST NOT treat a
  reference as unresolvable before completely parsing all documents
  provided to the implementation as possible parts of the OAD" (section
  4.1.2.1). Resolution is a whole-description operation, after parsing.
- A Reference Object's siblings: `summary` and `description` "by default
  SHOULD override" the target's, and have no effect where the target type
  lacks the field; "any properties added SHALL be ignored". A Schema
  Object's `$ref` is a JSON Schema 2020-12 keyword, and its siblings all
  apply: "this restriction on additional properties is a difference
  between Reference Objects and Schema Objects that contain a `$ref`
  keyword" (section 4.23). A Path Item's `$ref` is a field of the Path
  Item, not a Reference Object: adjacent fields combine with the referenced
  Path Item, and only "in case a Path Item Object field appears both in
  the defined object and the referenced object, the behavior is undefined"
  (section 4.9.1), with the note that this "is likely to change in future
  versions". So siblings follow three rules by position: ignore, conjoin,
  merge.
- Reference targets "are defined by fields including the OpenAPI Object's
  `$self` field and the Schema Object's `$id`, `$anchor`, and
  `$dynamicAnchor` keywords", and "Schema Objects containing an `$id`, or
  that are under a schema containing an `$id`, MUST be referenced by the
  nearest such `$id`". A fragment "SHOULD be interpreted as a JSON
  Pointer" when it is a location; a plain name is an anchor.
- Runtime expressions "preserve the type of the referenced value" and are
  evaluated against a request or response, never against the document.
- A discriminator `mapping` or `defaultMapping` value "that is both a
  valid schema name and a valid relative URI reference is
  implementation-defined, but it is RECOMMENDED that it be treated as a
  schema name" (section 4.25.3).

### The version axis

The review's largest correction. The brief says "the latest OpenAPI
spec", and the first two revisions designed for 3.2.0 alone; the
migration target's corpus is almost all 3.0.x (apidef's fixtures: 32
documents at 3.0.0, 8 at 3.0.3, 2 at 3.1.0, 3 Swagger 2.0), and apidef
accepts `swagger` documents. What `$ref` means changes with the version:

| Version | `$ref` is | Siblings | Targets | `$id`, `$anchor` |
|---|---|---|---|---|
| Swagger 2.0 | JSON Reference, everywhere | ignored | `#/definitions/`, `#/parameters/`, `#/responses/`, `#/securityDefinitions/` | none |
| 3.0.x | a Reference Object wherever it stands, Schema Objects included ("any time a Schema Object can be used, a Reference Object can be used in its place"; the Schema Object is "an extended subset of JSON Schema Wright Draft 00") | ignored | `#/components/...` | none |
| 3.1.x and 3.2.x | a Reference Object, except in a Schema Object where it is the 2020-12 keyword (or the keyword of the dialect a resource's `$schema` or the document's `jsonSchemaDialect` names) | `summary`, `description` override at a Reference Object; all apply at a Schema Object; merge at a Path Item, undefined where a field is on both sides | `#/components/...`, `$id`, `$anchor`, `$dynamicAnchor`, `$self` | yes |

A Path Item's `$ref` is a Path Item field in every version, Swagger 2.0
included, so the Path Item column is the same three-way merge throughout.

So the version is the first input to site typing, before the path. The
prototype reads it from `openapi` or `swagger` at the root; note that an
unquoted `swagger: 2.0` reads as the number 2 through the YAML grammar.

### When each reference is resolved

The five classes are not resolved at the same time, or by the same party,
and the specification is explicit about it. That decides what a parser
may do with each.

| Construct | Resolved | Against | What a parser can do |
|---|---|---|---|
| `$ref`, Path Item `$ref`, `operationRef`, `mapping` URIs, and the implicit connections by name | statically, once every document of the description is parsed | the OpenAPI Description, with base URIs from `$id`, `$self` or the retrieval URI | resolve it, which is the resolved tree |
| JSON Schema `$dynamicRef` and `$dynamicAnchor` | at validation time | the dynamic scope: the chain of schema resources entered while validating an instance | check the syntax, and that some `$dynamicAnchor` of that name exists; otherwise leave it in place |
| Runtime expressions in Link values and Callback keys | at call time | one actual HTTP request and its response | check the syntax, parse it to a structure, cross-check it against the operation; never give it a value |
| Path templates and server URL templates | at call time | the parameter and variable values of one call | parse the template; check each expression names a declared parameter or variable |

Runtime expressions are the case the maintainer asked about, and they
are metadata handed to the calling code. The specification says a
Callback key "is a runtime expression that can be evaluated in the
context of a runtime HTTP request/response to identify the URL to be used
for the callback request", that expressions "preserve the type of the
referenced value", and, for Link parameters, that "when a runtime
expression fails to evaluate, no parameter value is passed to the target
operation". All three sentences presuppose a request in hand. A document
processor has none, and the specification never asks it to evaluate one.
It does ask for two static things: recognition, because "it is not
possible to provide a constant value to `parameters` that matches the
syntax of a runtime expression", so a reader must tell the two apart; and
a cross-check, because "request parameters MUST be declared in the
`parameters` section of the parent operation or they cannot be evaluated.
This includes request headers", so `$request.path.id` in a Link can be
held against the declared parameters of the operation that owns it.

For `@tabnas/openapi` this means: the raw tree keeps a runtime expression
as the string it is; the resolved report may add its parsed form and the
result of the static checks; and evaluation belongs to the consumer, with
the plugin exporting a reader and an evaluator that takes a request and
response pair. That is a different operation from resolving `$ref`, which
is why this note keeps the two apart.

## 2. What `expr` is, and is not

`@tabnas/expr` is a Pratt operator plugin layered on `jsonic`'s `val`
rule. It turns operator tokens in the token stream into S-expressions
(`[Op, ...terms]`, the head a rich operator description carrying the
source token), and offers two ways to reduce them: an `evaluate` option,
called when the outermost expression of a value closes and folding its
sub-expressions bottom-up, and an exported
`evaluation(rule, ctx, tree, evaluate)` fold for a tree parsed without
the option. `simplify` renders a tree with each operator as its source
text, which is the form the shared fixtures compare. Go and Rust ports
exist and are held to the TypeScript behaviour by fixtures.

Properties of the implementation that matter here, read from the source
and confirmed by the prototype and its review:

1. The operator marker is private, and no runtime offers a stable,
   documented constructor. `isOp` and `evaluation` test `node[0].OP_MARK`
   against a module-local object, and `testing.opify`, which the
   reference marks "not part of the stable API", is the only exported
   function that stamps it (a host can also copy `OP_MARK` off any parsed
   operator, a documented field of `Op`, which works and is unsupported).
   `simplify` tests no marker: it reads any array whose head carries a
   `src` text as an operation, as `DIVERGENCE.md` records, so the fixture
   form needs no constructor. The ports differ in kind rather than
   visibility: in Go the exported `*Op` type is itself the mark, so a
   hand-built `&Op{}` at the head of a slice is recognised with or without
   the exported `Opify`, which only fills `Terms` and is documented as a
   test mirror; in Rust the public `opify` returns an `Op`, not a node, and
   `OpRef::node` is what mints one `is_op` recognises. `isOp` is private
   in TypeScript and Go.
2. `evaluation()` folds operator nodes and plain arrays and returns
   everything else unchanged, in TypeScript (`evaluation`), Go
   (`evaluationStep`, whose `unwrapExpr` accepts only slices) and Rust
   (`evaluation`, with no `Value::Object` arm). The reference page says
   so ("maps pass through unchanged"); the guide promises the fold "walks
   the tree bottom-up and calls your resolver for each op", which is false
   for a tree containing a map. With the `evaluate` option `{a:1+2}`
   gives `{"a":3}`; the fold on the same parse leaves `["+",1,2]`.
3. The parsed operator node is an array. `DIVERGENCE.md` records that the
   Go port wraps it (`{Val, Child, Implicit, Meta}`) with Go field names,
   that Go's `Simplify` reads three things differently from the canonical
   (only `SimplifyOrdered` agrees), and that none of this is repaired,
   because repairing it breaks the Go API.
4. A missing operand is absent by contract: `test/spec/dangling-operator.tsv`
   pins `1+` to `["+",1]` and `-` to `["-"]` in all three runtimes. The
   source's TODO about erroring on an incomplete expression predates that
   fixture.
5. Two lexical facts about `$ref` as a token. In YAML an unquoted
   `$ref: #/components/schemas/Pet` has a `#` after whitespace, which
   starts a comment, so it reads as `{"$ref": null}` with no error. In
   JSON the key is the string token `"$ref"`, which no fixed token can
   match. Either way the key position belongs to the pair rule.

## 3. What `voxgig/apidef` does today

apidef reads the YAML or JSON with `@tabnas/yaml` on `@tabnas/jsonic`,
then runs a single in-place pass, `addXRefsAndResolve`, over the finished
tree (`ts/src/parse.ts`; the Go port's `go/parse.go` carries the same
resolver, and apidef's rule is that Go reproduces TypeScript exactly,
with `ts/test/parse-resolve.tsv` run by both):

- Only local pointers (`#/...`) resolve; anything else keeps its `$ref`
  and gains an `x-ref` key beside it.
- A site becomes a shallow copy of the target's members, with the site's
  own siblings winning, at every object kind alike, and the original
  pointer recorded as a visible `x-ref` key; two sites naming one target
  are distinct objects holding the same child references, and the target
  itself never gains an `x-ref`. A target that is not an object stays
  unresolved.
- The target's children are shared beneath every site, so the result is a
  graph through them; in TypeScript `decycle` cuts back edges to
  `[Circular *path]` strings and records every cut in a side table that
  `decycledChild` reads, which `refcount.ts` uses to walk pointers through
  the cuts. The Go port runs no `decycle`: a self-referencing schema comes
  back as a cyclic graph, walked by node identity in `refcount.go` and
  broken only at serialisation.
- Before resolving, `parse.ts` repairs lone surrogates, normalises quoted
  path keys, defaults `components`, and writes with `Object.defineProperty`
  so a key named `__proto__` stays data. `yamlalias.ts` estimates, from
  the text and before parsing, the size the source reaches once every
  alias is copied in, and refuses the document above the larger of 1 MB
  and ten times the source, because the yaml plugin deep-copies the
  anchored node for every alias.
- Swagger 2.0 documents are accepted and handled by the same pass.

The `x-ref` key is a provenance mechanism that changes the document and
sits in the `x-` namespace the specification reserves for extensions. The
single merge rule is right for 3.0.x and Swagger 2.0 and wrong for a 3.1
Schema Object. Both are what a consistent `@tabnas/openapi` plugin would
replace, and section 8.5 lists what else `parse.ts` does that the plugin
must keep, move or drop.

## 4. The experiments

Five scripts and a benchmark, run against the published packages
(`@tabnas/parser` 0.12.15, `jsonic` 0.7.10, `expr` 0.5.19, `yaml`
0.5.26, `json` 0.5.19), under Node 22, which the packages declare as too
old (they want 24) and run on anyway. Each script's captured output is
beside it in [`prototype/`](prototype/).

### E0: one instance for both serialisations

`new Tabnas().use(jsonic).use(Yaml)` reads the JSON form of a document
identically to the strict `json` grammar and to `JSON.parse`, as JSON
text, compact, two-space indented and tab indented alike, because JSON is
YAML 1.2 flow syntax. It also accepts YAML-only text a strict JSON parser
rejects (`{openapi: 3.2.0}`, a trailing comma, a multi-document stream,
which becomes an array). The YAML grammar's start rule is `stream`; the
JSON and jsonic grammars start at `val`. Equality is as JSON text: the
engine's containers have a null prototype, so `deepStrictEqual` against
`JSON.parse` fails and `obj.hasOwnProperty(k)` throws on them. The review
extended the measurement to apidef's 43 JSON fixtures, all equal, and
found one RFC 8259 text the yaml grammar refuses: a JSON text whose first
line is empty fails with `unexpected` in yaml 0.5.26, where jsonic alone,
the strict grammar and `JSON.parse` accept it.

### E1: `expr` as a sub-parser for the embedded string languages

A jsonic+expr instance with comments, pairs, the explicit container
tokens, jsonic's implicit containers (`rule.exclude: 'imp'`), the comma
token and the default operators switched off, and the lexer told not to
interpret numbers and keywords (so a pointer segment `1` is the string
`"1"`), reads each class of string with its own operator table. `expr`
adds its own implicit-list alternates when it is installed after that
exclusion has run, so a space-separated list still forms after an
expression; the two-element lists below are `expr`'s, not jsonic's.
Comment lexing has to be off: `DIVERGENCE.md` records that a `/`
operator next to a comment marker lexes differently in the three
runtimes, so a port of this sub-grammar has to switch it off in every
runtime.

Runtime expressions, with `.` (member, tightest), `/` (pointer segment,
prefix and infix), `#` (fragment) and a `{ }` paren. Every example in the
specification's tables (eighteen rows across the Link and Callback
sections and the ABNF), plus five constructed cases, read as the ABNF
says, bar the one that is a full URL around two embedded expressions,
which is the `{}` string template, not an expression. Then the review's
seven ABNF-legal adversarial names, and five misread: `$request.query.a.b`
splits a query parameter named `a.b`, `$request.header.X.Y` and
`$request.header.X#Y` split header names (`tchar` admits `.` and `#`),
`$request.body#/user.name` splits a pointer token, and `#/a//b` turns an
empty token into nested operators. `#/a,b` reads right once the comma
token is disabled, and `$request.query.` reads right as a one-term `.`,
since `name = *char` admits an empty name. The cause of the misreads is
structural: a binding power is global, so `.` cannot be an operator left
of `#` and inert right of it. The ABNF is lexical after the `source`
prefix, and so must the reader be; the one false acceptance `expr` would
add is `$request.header.`, where the header `token` must be non-empty.

`$ref` URIs: the fragment side is right (`#/components/schemas/Pet`,
`#/paths/~12.0~1repositories~1%7Busername%7D/get`, a bare `Pet.yaml`, a
`definitions.yaml#/Pet`, a bare `#`, which is the whole document and
legal), but three cases show the limit. A URL with a scheme reads
`https:` as a path segment and the authority as another. A raw space
inside a segment, illegal in a URI, becomes a two-element list built by
`expr`'s own implicit-list alternates rather than an error. A literal `{`
in a segment, which the specification requires percent-encoded, is
accepted without complaint. None is fixable
with binding powers: URI syntax is lexical, with context-dependent
delimiters and its own validity rules.

Path templates: `/pets/{petId}/photos/{photoId}` reads correctly, but a
literal glued to a template (`/users/{id}.json`, `/files/{path}:download`,
both shapes present seven times in apidef's own fixtures) comes out as a
two-element list at the top level, because Pratt parsing has no
juxtaposition operator and `expr`'s own implicit-list alternate stands in
for one. A server URL template with a scheme and port is unusable. These
are literal-plus-`{...}` sequences, defined by the specification's own
grammars (sections 4.8.2 and 4.6: any character but `{` and `}` inside the
braces, several expressions in one segment), and a splitter reads them
completely.

### E2: what `expr`'s eager `evaluate` sees

Corrected by the review. A prefix operator `@Pet` meaning "the schema
named Pet", evaluated with the `evaluate` option. `ctx.root()` is the
start rule, and its node is set only when that rule coalesces its child
at its own close, so it is undefined while the document's pairs are
parsing; a callback reading it resolves nothing, in either document order,
which is what the first draft measured and misattributed. The root map
itself is allocated when the `map` rule opens (`@object$`) and filled pair
by pair (`@setval$`), and it is reachable mid-parse as the outermost
container on the rule stack, which is exactly the walk the engine's own
recovery path uses. A callback reading it there resolves `@Pet` when
`components` precedes `paths`, and not when it follows: eager evaluation
sees what precedes the site and nothing after it. The specification's
layout puts `components` last, and its rule forbids judging a reference
unresolvable before the whole description is parsed, so eager evaluation
cannot be the resolver, whatever it reads.

Parsing without `evaluate` and folding afterwards resolves it, but
`evaluation()` applied to the root returns the root untouched (it does
not descend into the maps); applied to the operator node directly it
returns the schema.

### E3: `$ref` as an `expr` operator node, resolved by a post-parse fold

An `OpenApiMeta` plugin with three modes was layered on `jsonic`+`Yaml`
and on the strict `json` grammar, and its fold was also exported as
`resolve(raw, options)`:

- `raw`: no hook. The result equals `JSON.parse` of the JSON form, from
  either grammar; containers have a null prototype; a key named
  `__proto__` is an own key.
- `ops`: a `val` after-close hook rewrites every map carrying `$ref`,
  outside a data slot, into `[refOp, uri, siblings]`, with `refOp` minted
  through `testing.opify` and carrying the opening token. `expr`'s
  `simplify` then prints `["$ref", "#/components/responses/PetList",
  {"description": "..."}]`. Of the 13 reference sites in the test document
  (15 `$ref` maps, two of them data: an `x-` extension and an `example`),
  the hook caught 13 from JSON and 12 from YAML: a mapping that begins a
  sequence entry as a bare pair, `- $ref: x` in a block sequence or
  `[$ref: x]` and `[? $ref : x]` in a flow sequence, is built by yaml's own
  `yamlElemMap` and `yamlElemPair` rules and pushed into the list without
  passing through `val`; `- {$ref: x}` and every other map position do pass
  through it.
- `resolve`: at end of parse, lift any remaining `$ref` maps and walk the
  tree. End of parse is the engine's post-process rule subscriber,
  `tn.sub({ ruleDone })`, filtered to the depth-0 close pass whose
  alternate neither pushes nor replaces, outside probes and recovery; it
  fires once per parse that reaches its final close, and `ctx.root().node`
  then holds the result, which the subscriber replaces. It does not fire
  for an empty document (the parse returns undefined and the callback is
  never called) or for a parse that fails first, and on trailing content
  it fires, resolves, and the parse then still fails, which is one reason
  to prefer the function form. The first two drafts hooked the
  start rule's after-close instead, and the review showed that is wrong
  for YAML: `stream` is replaced on `%YAML`, `---` and `...`, a replaced
  rule is a new object, and `parse()` returns the original root rule's
  node, so a resolver there silently returned the raw document for any
  YAML file with a directive or terminator. Case 5 in the output runs
  those three inputs and the trigger fires once each. The report
  (`unresolved`, `cuts`, `provenance`, `version`) comes back through an
  `onResolved` callback, because `use()` deep-copies plugin options and a
  mutable array passed through them never reaches the caller; the second
  draft's `unresolved = []` in the captured output was that bug, not an
  empty list.

The resolver percent-decodes the fragment and then splits it (RFC 6901
section 6: an encoded `/` is a separator), locates the target (following
references met on the way, so a reference to a reference resolves), walks
the target first so references inside it resolve too, memoises on the
original operator node so one result serves every site and every pointer
that ends at it, detects a cycle met by node (a target still being
walked) or by URI (a chain) and cuts it to the verbatim `{ "$ref" }` with
the cut recorded, applies siblings by version and object kind (ignored
under Swagger 2.0 and 3.0.x; `summary` and `description` override at a
3.1 Reference Object; a conjunction, `allOf: [target, ...siblings' allOf]`,
at a 3.1 Schema Object; a merge at a Path Item, the site's fields over the
target's), leaves an external reference verbatim and lists it, writes
defined members into null-prototype objects so `__proto__` stays data,
and records provenance once per site, resolved, unresolved or cut, in a
side table keyed by path, with row and column for a site built at parse
time and none for a site lifted afterwards. The third revision's version
of this memoised on a fresh array built per call, so a target that was
itself a reference site was resolved again and recorded twice, and its
Path Item test could never match a key beginning with `/`; the review
caught both, and the Path Item case is now exercised.

Measured on the test document: the resolved trees from the YAML and the
JSON input are identical and serialise; the Reference Object override, the
chain, the `~1` pointer into `paths`, the Path Item merge, the top-down
recursion, the `%2F`-encoded separator, the site `allOf` joining the
target's, the extension and the example staying verbatim, and the
`__proto__` key all behave as designed; `unresolved` lists the one
external reference; `cuts` lists the two cycles; `provenance` has one
entry for each of the 13 sites; the same document read as 3.0.3 ignores
every sibling, and read as Swagger 2.0 ignores them too. Sharing holds
through pointers as well as references: `/pets` `200`'s content is
`PetList`'s content, and `/pets/{id}` `200`, a pointer that ends at the
`/pets` `200` reference site, is that site's one result. The YAML side of
the raw equality is checked against a hand-written expected value, since
the JSON form is the YAML grammar's own parse re-serialised. Under the
yaml grammar a recorded column is one too large per preceding `: ` on
the line (rows are exact, and the json grammar's columns are exact), a
yaml plugin defect the review measured.

What the experiment showed about `expr`'s share of that work:
`evaluation()` did the fold of one node at a time and nothing else,
because it does not walk objects; `simplify` was useful for a fixture
form; the operator head gave the resolver the token position for every
site built at parse time; and the raw document had to be kept verbatim
beside the operator tree, since the operator node's JSON is an array of
an operator description.

### E4: a structural-operator layer over `expr`

The question behind this experiment is the one section 6 answers: if
`expr` were extended to carry `$ref`, what would have to be true? Three
measurements, in `prototype/e4-expr-struct.js`.

(a) `$ref` as a lexical operator. With `$ref` declared as a prefix or
infix token operator on jsonic+expr, `{ $ref: '#/x' }` fails with
`unexpected`: the fixed token takes the key position, which the base
grammar's pair rule owns and expects a KEY token in. A bare `$ref '#/x'`
outside any map does parse as `["$ref", "#/x"]`, and a quoted `'$ref'`
key stays an ordinary map because a string token is not an operator. The
document shape OpenAPI uses is the one that cannot be reached lexically.

(b) A structural layer. About ninety lines written against `expr`'s
public surface (`testing.opify`, `evaluation`, `simplify`) do what an
extension inside `expr` would do: an operator definition
`{ struct: true, key: '$ref' }`; recognition at every `val` after-close
by the shape of the built node (a map holding that key), producing
`[op, value, siblings]` with the map's opening token on the op and a
`guard(path)` that leaves data slots alone; a tree fold at end of parse
(the `ruleDone` trigger of E3) that walks objects as well as arrays, hands
each operator node to `expr`'s own `evaluation`, memoises per source node,
detects a cycle met top-down or through a chain, and carries a site to
the resolver: the root, the path, the token, and an inherited
environment that an `inherit(node, env, path)` callback extends at each
object on the way down. The resolver supplied for the test, sixty lines
of OpenAPI and JSON Schema knowledge, uses the inherited environment for
the base URI: `$self` on the document and `$id` on a schema set it,
`$anchor` registers a plain-name fragment in it. The environment at a
path is computed from that path's own ancestors and memoised per prefix,
so a target reached early through a reference gets its ancestors' base,
not the referrer's: the design panel found the first draft passing the
referrer's environment into the target's walk, and the case that shows it
(a schema under `$id https://schemas.example.com/pet.json` referring to
`owner.json`, reached first from `paths`) resolved to
`https://api.example.com/owner.json` and nothing before the fix, and to
the right `$id` after it. On a document with a `$self`, three schemas
carrying absolute `$id`s, an `$anchor`, a `$self`-relative document
reference (`openapi.yaml#/components/responses/NotFound`), an absolute
`$id` reference, a reference relative to a schema's `$id` (`tag.json`), a
plain-name fragment (`#name`), a self-reference (`#`), the early-reached
nested target and a `$ref` inside an `x-` extension, every case resolved
as the specifications say, the cycle kept its back edge, the extension
stayed verbatim, and the output serialised. Parsing the same document without `evaluate` gives the
operator tree, which `expr`'s `simplify` prints as
`["$ref", "#/components/responses/PetList", {"description": "Overridden"}]`
exactly as it prints a token operator.

(c) `expr`'s own fold on that tree. `evaluation(null, null, tree, fn)`
over the root leaves every structural node where it is, inside its map;
applied to one node it reduces it. The one change (b) could not make from
outside `expr` is the one it most needs.

### E5: cost and size on a real description

`prototype/bench.js` on Stripe's published description (`spec3.json`,
7.9 MiB, OpenAPI 3.0.0, 431 paths, 1538 schemas, 4062 `$ref` maps), in
this container:

| Step | Time | Note |
|---|---|---|
| `JSON.parse` | 30 ms | |
| strict `json` grammar | 3215 ms | same value as JSON text |
| `jsonic`+`yaml` grammar | 3831 ms | same value as JSON text |
| `resolve`, cycles cut | 302 ms | 3673 sites resolved, 389 left as data by the slot rule, 0 unresolved, 125 cuts |
| `JSON.stringify` of that result | failed after 90 s | "Invalid string length" |
| `resolve`, cycles kept | 259 ms | `JSON.stringify` fails at once on the cycle |

And a synthetic diamond, N schemas each referring twice to the next: at
depth 16, 32 sites and 1.9 KB of source resolve to a DAG of 17 objects in
memory and 7.4 MiB of JSON. Shared targets inline exponentially under
serialisation. The resolved result is for in-memory consumers, as
apidef's is; anything written out needs a sharing policy (inline a
target once and keep `$ref` thereafter, or inline within a byte budget).
And the grammars cost two orders of magnitude more than `JSON.parse` on
JSON input for an identical value.

### E6: the OpenAPI resolver as a vocabulary over `expr`'s tree layer

Added in the fifth revision, revised in the sixth after the review of
the layer. `prototype/e6-expr-fold.js` is the resolver of E3 rewritten
with no generic machinery of its own: `$ref` and `$dynamicRef` declared as
key operators, `expr.fold` doing the walk, the memory, the cycle rule, the
documents, the report and the inherited bag, and about two hundred lines
of OpenAPI, JSON Schema and RFC 3986 around it (the version, what a
position holds, the identifier index, URI resolution, the sibling rule by
version, kind and target type, the reasons a reference is unresolved). It
needs the `expr` checkout that carries the layer; see the appendix.

On the YAML document beside it, a 3.2 description, every requirement the
earlier experiments had to add by hand holds through the layer: a
block-sequence entry resolves by shape; a Reference Object's `summary`
and `description` override a Response's, as 3.2 allows; a reference to a
reference reaches the final target; two sites share one object; a Path
Item merges its sibling, in 2.0 as in 3.x; a target under an `$id`,
reached first from outside its resource, resolves against its own `$id`;
`../` resolves with its dot segments removed; a Schema Object conjoins its
sibling; read as 3.0.3 the document has no `$id`, so a relative reference
resolves against the document's URI; `#name` resolves through the anchor
index; `#` from inside the schema is a cycle through it and is cut;
`$dynamicRef` is reported and left; another document is loaded once
through the fold's `load`; a property named `example` is a schema and one
named `$ref` a name; a `$ref` that is not a string, an unknown anchor and
a malformed fragment are reported with a reason; `%2F` decodes before the
split; `x-` and `example` data keep their `$ref`; `__proto__` survives;
the raw tree is unchanged and the result serialises.

On Stripe's `spec3.json`, folded from `JSON.parse` output with no grammar
involved (`node e6-expr-fold.js spec3.json`), 3673 sites resolve with 125
cycles and 389 `$ref` maps left as data, the same counts as E3, in about
150 to 350 ms against E3's 200 to 300 ms in place, in this container. The
fifth revision compared E6 with a capture of E3 taken before E3's memory
was repaired (3570 sites), and gave E6 at 658 ms, when the fold still
built a pointer string per node. The captured output is
`prototype/e6-expr-fold.result.txt`; the extension it exercises is
recorded in [`expr-tree-layer.md`](expr-tree-layer.md).

## 5. Findings

1. **The specification mandates post-parse resolution.** Everything must
   be parsed before a reference may be judged unresolvable. `expr`'s
   `evaluate` runs at expression close and sees only what precedes the
   site (E2); the fold form is the right shape, run after the parse.
2. **A raw tree must be verbatim, and an `expr` operator node is not.**
   The raw mode the maintainer asked for ("`$ref` etc. are provided
   verbatim") rules out replacing `{ "$ref": ... }` with
   `[Op, uri, siblings]`. The operator tree is an intermediate
   representation at best, and in Go it is a different JSON shape again.
   Verbatim holds in every runtime only with the engine's `info` option
   off: in Go and Rust the marker swaps the container type, and Go's
   `MapRef` has no `MarshalJSON`, so with `info` on the Go raw tree is
   verbatim neither as a value nor as JSON.
3. **`evaluation()` does not walk objects, in any runtime**, and this is
   an inconsistency inside `expr`, not only a gap for this plugin: the
   eager option reduces inside maps and the fold does not, and the guide
   and the reference disagree about which is the contract.
4. **End of parse exists in the engine already.** `tn.sub({ ruleDone })`
   fires after every rule pass in all three runtimes, grammar-neutrally,
   with the matched tokens on the rule; filtered to the final depth-0
   close it is a reliable end-of-parse trigger, and recording the opening
   token of every container as it closes gives a row for every site, the
   yaml sequence-entry mappings included (block `- k: v` and flow `[k: v]`
   alike, which `val` never sees); the column is reliable under json and
   jsonic until yaml's column drift is repaired. The first two drafts
   proposed an engine hook and an `info`-marker position without having
   found it, and the marker would not have reached those sites, since
   yaml builds them outside `@object$`. Its limits: in Rust the
   subscriber observes and cannot replace the result; in Go the result is
   read from a private rule that a replace moves, so a write must go to
   the rule the final event hands over; it fires before the
   trailing-content check and not at all for an empty document; it is per
   instance.
5. **The start rule's after-close is not an end-of-parse hook.** It fires
   once per depth-0 rule object, and a replaced start rule (yaml's
   `stream` on directives and markers) is a new object whose node
   `parse()` never returns. A resolver hooked there silently returns the
   raw document on those inputs.
6. **Site typing needs the version and the position, and decides what is
   a reference at all.** The same `{ "$ref": X, "description": D }` is
   ignored-siblings under 3.0 and Swagger 2.0, an override under a 3.1
   `responses` entry, a conjunction under a 3.1 `schemas` entry, and
   under `x-vendor`, `example` or `enum` it is data. Stripe's description
   has 389 of 4062 `$ref` maps in slots the prototype's rule treats as
   data; the review's wider slot list put about a quarter there.
7. **`expr` reads the skeleton of the embedded languages and misreads
   their tokens.** Runtime expressions are `source ["#" pointer]` around
   lexical names; a Pratt table reads the skeleton and splits the names
   (five of seven legal adversarial cases). Pointer fragments split
   correctly on `/` only when no token is empty or holds `.` or `,`; URIs
   and templates are not operator-shaped. Bare `#`, a one-term `/` and an
   empty query name are legal, and `expr`'s dangling-operator fixture is
   the right contract: the two "defects" the first draft reported were
   not defects.
8. **No runtime offers a stable, documented operator constructor.**
   TypeScript stamps a private marker through `testing.opify`, excluded
   from the stable API; Go exports `Opify` but documents it as a test
   mirror, and its `*Op` type is the mark; Rust's public `opify` returns an
   `Op`, not a node. Only `isOp` and `evaluation` need the marker;
   `simplify` reads any `src`-headed array. A sibling plugin needs one
   public constructor and predicate with the same contract in all three.
9. **One engine instance reads both serialisations**, at a cost: on JSON
   input the grammars take two orders of magnitude longer than
   `JSON.parse` for an identical value (E5), so a fast path is worth
   having, with the grammar for YAML and for diagnostics.
10. **A resolved document is a graph, and serialising it is the hard
    part.** Shared targets inline exponentially; Stripe's resolved
    description cannot be written as JSON at all. apidef's shape (shared
    objects, cycles cut, a side table of cuts) is the right default for
    an in-memory consumer, and any written form needs a sharing policy.
11. **`$ref` cannot be a lexical operator.** The key position of a map
    belongs to the base grammar's pair rule, in JSON and YAML alike, and a
    fixed token there breaks the parse (E4a); an unquoted YAML `#/x` is a
    comment and reads as null.
12. **A structural layer over `expr` carries `$ref`, and needs five
    things `expr` does not have.** Recognition of an operator by node
    shape; a fold that walks objects; a site with the root, path and token;
    an inherited environment flowing down the tree, which base-URI scoping
    needs; and memoisation with a cycle policy. None of the five is about
    values: `expr`'s terms and results may be containers today.
13. **Plugin options are copied.** `use()` deep-copies the options it hands
    a plugin, so a report cannot travel back through a mutable option;
    functions survive by reference, so a callback can.
14. **Following a `$ref` URI is deriving a URL or file path from parsed
    content.** The engine's own rule forbids that without independent
    validation; a loader that follows document-supplied URIs by default
    is a request-forgery and file-read vector and an unbounded fetch loop.
15. **apidef's provenance and merge rules are the two places a typed
    parser improves on it**, and its Go port, its pre-resolution repairs
    and its TypeScript-only cut table (the Go port leaves cycles in place
    and walks by identity) are what a migration must carry.

## 6. Should `expr` handle trees as well as values?

The maintainer's question, put precisely. The answer from E4 is: `expr`
already handles tree-shaped values, and that is not the gap. An operand of
`f(x)` may be a map, a list or another expression, and an `evaluate`
callback may return a container. What `$ref` needs is different in kind,
and it comes in three parts.

### 6.1 Operators recognised by shape

Every `expr` operator today is a token: the lexer emits it, a `val` or
`expr` alternate matches it, and Pratt binding powers decide where it
attaches. A structural operator is recognised after the base grammar has
built a node, by the node's shape: a map holding a keyword key such as
`$ref`, `$dynamicRef`, `$merge`, or, in other formats, a list whose head
is a keyword. It has no binding power, because it is never in competition
with a neighbour for an operand; its operands are fixed by the shape (the
key's value, and the remaining members). In `expr`'s terms it is a fifth
operator kind beside infix, prefix, suffix, ternary and paren, with its
own table (`structTM`, keyed by the keyword), recognised either in a `val`
after-close hook beside the alternates `expr` already adds to `val`, or
grammar-neutrally in a `ruleDone` subscriber, and producing the same node
`[Op, ...terms]` that `isOp`, `simplify`, the render parts and the
fixtures already understand. The `Op` gains a `struct` flag and a `key`;
`OpDef` gains `struct: true` and `key`.

Two things the prototype learned about that hook. The yaml grammar builds
a sequence entry's bare-pair mapping outside `val`, in block and flow
sequences alike, so a `val` hook misses those positions (E3), where
`ruleDone` reaches them; an interim hook on `yamlElemPair` must change
the mapping in place, since the sequence rules push `rule.child.node` and
a reassigned `r.node` there is lost. And whether a map
with the keyword IS an operator depends on the version and on where it is
(an `x-` extension, an example payload, an `enum` hold data), so the hook
needs the path, read off the rule stack from the pair rules' `u.key` or
propagated through the engine's `k` bag as the path plugin does, and a
guard the host supplies.

### 6.2 A fold that walks the tree

`expr`'s `evaluation` is a fold over operator nodes and arrays; the
resolved tree needs a fold over the whole document. Three properties,
each of which the prototype had to add from outside:

- **It runs at the end.** Structural operators resolve against the
  finished root, so `evaluate` gets a timing: `when: 'end'` folds once at
  end of parse (the `ruleDone` trigger today, an engine hook when one
  exists), where today's `evaluate` reduces at each expression's close.
  In Rust the subscriber cannot replace the result, which is one reason
  to prefer the function form for the plugin.
- **It carries a site, and context flows down.** The resolver needs the
  root, the path to the site and the operator's token, and it needs an
  environment inherited from the ancestors: the base URI set by the
  nearest `$id` or the document's `$self`, the anchors declared in that
  resource. The engine already draws this line for rule state, between
  the propagated `k` bag and the local `u` bag; the fold draws the same
  one, with an `inherit(node, env, path)` callback that may extend the
  environment at each object, and values returning upward as they do now.
  The Rust port's `EvalSite` carries the occurrence token and is the
  start of a site object; it carries no path, which only a fold that
  descends into objects can supply.
- **It memoises, and has a cycle policy.** One target is named by many
  sites; the fold caches one result per source node and shares it. A
  recursive schema reaches its own target, top-down before any reference
  or through a chain of references; the fold detects both and applies a
  policy the host chooses: cut the back edge to the verbatim reference, or
  keep the object graph cyclic.

Making `evaluation` walk objects is the smallest of these and the one
nothing outside `expr` can do; the prototype re-implemented the fold to
get it.

### 6.3 What stays out of `expr`

The resolver. URI resolution against a base, JSON Pointer decoding, which
OpenAPI object a path names in which version and what its siblings mean,
document loading, the choice between a name and a URI in a discriminator
mapping or a security requirement: all of that is OpenAPI and JSON Schema
knowledge, and it is the `evaluate` callback and the `inherit` callback
the host passes in. In the prototype it is sixty lines beside ninety of
generic machinery, and the two never mix. `expr` supplies the operator
model and the fold; the plugin supplies meaning, as it does for `+` today.

### 6.4 Where the extension lives

Three homes are possible, and the choice is the maintainer's:

- **Inside `expr`, as a second module** (`ts/src/tree.ts` beside
  `expr.ts`, mirrored in the Go and Rust crates), sharing `opify`,
  `isOp`, `simplify`, the S-expression contract and the fixture format.
  The Pratt ladder is untouched, since structural operators have no
  binding power. Cost: three runtimes, roughly the size of the prototype's
  generic layer each, plus fixtures and a post-parse fixture runner that
  does not exist today; and the Go port's wrapped operator node
  (`DIVERGENCE.md`) has to be settled for the new kind before a consumer
  depends on the operator tree, since the raw tree never carries one but
  the `ops` form does.
- **A sibling package on `expr`'s public surface**, which still needs
  `opify` and `isOp` made public and `evaluation` taught to walk objects,
  so `expr` changes anyway; it adds a package to the fleet for the sake of
  keeping Pratt and tree concerns in separate repositories.
- **Inside `@tabnas/openapi` alone**, which is what the prototype did and
  what a first release ships with; it forfeits reuse by JSON Schema,
  AsyncAPI and the other `$`-keyword formats, and keeps `expr` out of
  `$ref` entirely.

**Superseded in the fifth revision.** The maintainer's direction is the
first home, now: the layer lives inside `expr`, as part of `expr.ts`
rather than a second module, and is built (pull request 100). The
paragraph below and the panel's staging after it are kept as the record
of what was weighed. This note had recommended the third for the first
release and the first as the later step, in two moves: land `opify`, `isOp` and the object-walking
`evaluation` in `expr` when the maintainer instructs it, since every home
needs them, and build the structural kind and the fold as the second
module once the openapi plugin's resolver has settled what the site and
the environment must carry.

**The design panel's verdict.** Three designers took three angles (the
smallest change to `expr`; a tree layer inside `expr`; the skeptic, with
the fold in the plugin behind an `expr`-shaped interface) and two judges
scored them. The judges split on the winner, one for the tree layer and
one for the skeptic, and converged on one synthesis, which this note and
the plan adopt. First, the generic changes every home needs, each its own
instruction: a public constructor and predicate; `evaluation` over
objects as an opt-in, because a designer measured an unconditional walk
changing 180 of the 1136 rows in `test/spec/*.tsv` (those whose expected
value holds an operator node inside a map); the Go occurrence token.
Second, the fold's contract, written in `expr`'s vocabulary whichever
home it gets: operators declared as `{ key: true, src: '$ref' }` entries
with `dynamic: true` for keys recognised and reported but never evaluated
(`$dynamicRef`, which writes the static/dynamic distinction into the
types); recognition by node shape at fold time only, never by a parse
hook or a marker, because a marker misses the `JSON.parse` fast path,
dies on copies, and in Go forces `info` on, which makes every map a
`MapRef` that is neither ordered nor verbatim as JSON; `evaluate(site,
op, [value, siblings])` bottom-up; an inherited bag computed as a memoised
function of the path from each node's own ancestors (the E4 defect
above); memoisation by path string, not identity, since Rust values are
copy-on-write and yaml aliases are copies; an active set of every
container being folded plus the URI chain for cycles; and for the
deferred mode, `ruleDone` in TypeScript writing `ctx.root().node`, in Go
writing the final done rule's node (the result is read from a private
rule that a replace moves), and the function form only in Rust. Third,
the staging the skeptic argued: the plugin ships first with that fold in
its own `fold.ts`, importing nothing from its resolver, and the lift into
`expr` is a move when a second `$`-keyword format wants it or the
maintainer wants reuse up front. Two facts the panel added to the
record: `expr`'s default operator table must never be installed under the
document grammar, since its `/` breaks `/pets:` as a YAML key; and the
TypeScript `Evaluate` type is a rest parameter today where the fold passes
an array, which the first `expr` change should correct.

## 7. Alternatives considered

- **Two passes with `expr` unchanged.** Parse the raw tree, then parse
  the document again with an `expr` operator and an eager `evaluate` that
  reads the finished raw tree from the parse `meta` (`ctx.meta`). The
  review measured it working against the published `expr` with
  `components` after `paths`. It costs a second parse (3.5 s more on
  Stripe), gives the operator-tree shape finding 2 rejects for the raw
  tree, and still needs the version and path logic. Not chosen, but it
  shows that none of the `expr` enhancements is a precondition.
- **Lazy resolution.** Resolve on access through a proxy or accessor, so
  the output is bounded and cycles are never materialised. Right for a
  TypeScript-only consumer; hard to make identical in Go and Rust, and
  apidef walks the whole tree anyway. Not chosen for the plugin; a
  consumer can build it over `resolve()`'s report.
- **The graph as the only shape.** apidef's shape, and the default this
  note now recommends for in-memory use; a serialised form still needs a
  policy, so the plan offers shapes rather than one.
- **An off-the-shelf JSON Reference resolver.** None exists in three
  runtimes under one fixture contract, and adding one is a dependency the
  family's rule reserves to the maintainer. Not chosen.

## 8. Recommendations

### 8.1 Shape of `@tabnas/openapi`

- **Layer on `jsonic` and `yaml`**, as the template's ZON plugin layers
  on jsonic: `new Tabnas().use(jsonic).use(Yaml).use(OpenApi, options)`.
  One instance reads both serialisations, with a `JSON.parse` fast path
  for JSON text (identical value by E0 and E5) and the grammar for YAML
  and for diagnostics. Offer a strict instance on `json` alone for
  callers who want a `.json` file held to RFC 8259.
- **Raw mode is the default and is verbatim**, with the engine's `info`
  option off. `parse()` returns the document as written: `$ref`, `x-`
  extensions, runtime-expression strings and templates untouched;
  containers null-prototyped, `__proto__` keys as data.
- **Resolution is a function over the raw tree:**
  `resolve(raw, options)` returning `{ tree, version, unresolved,
  provenance, cuts, connections, documents }`. The in-parse option on
  `use()` is sugar over the `ruleDone` trigger with an `onResolved`
  callback, because apidef mutates the raw tree between parsing and
  resolving and because Rust's subscriber cannot replace the result.
- **Type every site by version and position.** The version from
  `openapi` or `swagger` (string or number); a table of every position in
  that version's object model, generated from the specification's own
  schemas rather than hand-written, naming each slot a Reference Object,
  a Schema Object, a Path Item, a named-connection site, or data; an
  unknown position is data. The table decides what is a reference,
  sibling semantics, discriminator `mapping` and Security Requirement
  name-or-URI, and which implicit connection a bare name is.
- **Resolve in the shape E3 and E4 prototyped:** load and parse every
  reachable document first; index `$self`, every `$id` against the
  nearest base, every `$anchor` and `$dynamicAnchor`; resolve each
  reference against the nearest `$id`, else `$self`, else the retrieval
  URI; a `/` fragment is a JSON Pointer within the resource
  (percent-decode, then split, then `~1`/`~0`), any other fragment an
  anchor; targets before use; one object per target; cycles by node and by
  URI, cut by default and recorded with holder, key and target, or kept;
  siblings by version and kind; non-object targets allowed; provenance in
  a side table keyed by path, with positions from a `ruleDone` subscriber
  when asked.
- **Output shapes with a sharing policy:** `share` (a DAG or, with cycles
  kept, a graph) for in-memory consumers; `inline-once` for anything
  serialised; `copy` only within a byte budget. Never a default that
  cannot be written out or that writes out exponentially.
- **Loading off by default.** `resolve` follows no URI unless the caller
  supplies `load`, and then only an absolute URI that passed resolution and
  matches an allow-list, within document-count and byte budgets; a loaded
  document is parsed by the same instance and typed from the referring
  site's kind. Unresolved references stay verbatim and are listed; a strict
  mode makes them errors.
- **Read the embedded languages lexically.** A runtime-expression reader
  for the ABNF (`$url`, `$method`, `$statusCode`, `$request.`/`$response.`
  then `header.`/`query.`/`path.` with the rest as one name, or `body`
  with an optional `#` and a JSON Pointer); a `{}` template splitter for
  Path Item keys, Server `url` and Callback keys; static cross-checks
  against the owning operation; an evaluator for consumers that supply a
  request and response. Expose any `expr`-shaped form only as the
  simplified array (`simplify` in TypeScript and Rust, `SimplifyOrdered`
  in Go), or expose strings and leave parsing to the client.
- **Do not use `expr`'s lexical operators for `$ref`** (finding 11), and
  never make the raw tree an operator tree (findings 1 and 2). If `$ref`
  is to be an `expr` operator at all, it is the structural kind of
  section 6.
- **Error codes** with hints, pinned by `ERROR:<code>` rows: a root that
  is not an object, a missing or unsupported version, a stream of several
  documents, a `$ref` whose value is not a string, a fragment that is
  neither a pointer nor a known anchor, a refused or over-budget load, a
  malformed expression or template, and, in strict mode only, an
  unresolvable reference.
- **Fixtures** in the family's three columns, mode in `opts`, a resolved
  row's `expected` the whole report serialised with `inline-once`.
- **Parity.** A resolved tree is plain data in every runtime, with the
  known watch points: key order on the fast path (Go's `OrderedMap`),
  null prototypes in TypeScript, and the Go info marker if it is ever
  turned on.

### 8.2 Enhancements to `@tabnas/expr`

**Revised in the fifth revision.** By the maintainer's direction the tree
layer is the foundation of the resolver, not a later option, and most of
this list has landed in `expr`'s TypeScript as pull request 100:
`opify` and `isOp` exported (item 1); `evaluation(..., { objects: true })`
as an opt-in (item 2, the option form, since the unconditional walk
changed 180 rows); and the structural kind and the fold (item 4), as
key operators and `fold`, with the deferred mode, `positions`, the
report and the `tokens` option, specified in
[`expr-tree-layer.md`](expr-tree-layer.md). What remains upstream is the
Go occurrence token (item 3) and the Go and Rust ports of the layer,
each on its own instruction, and then the `expr` release the plugin's
manifests can name. The list as it stood is kept below for the record.

1. **A documented operator constructor and predicate in all three
   runtimes**: export `opify` and `isOp` in TypeScript (the constructor
   taking a partial definition and filling defaults), `IsOp` in Go beside
   the existing `Opify`, and a node constructor in Rust beside `opify`,
   with one contract, so a sibling can mint and recognise operator nodes.
   Small; unit-tested, since API surface cannot be a `.tsv` row.
2. **`evaluation()` over objects**, as a consistency repair: the fold
   should agree with the eager option on `{a:1+2}`, the guide and the
   reference should agree with each other, Go must return the map type it
   was given (`OrderedMap`), and a post-parse fixture runner is needed in
   all three suites, since none exercises the standalone fold today.
   Default or option is the maintainer's call against the reference's
   statement.
3. **Carry the occurrence token on the Go operator node** (on the
   `ListRef` meta, non-breaking): TypeScript and Rust give a resolver the
   token, Go gives none.
4. **A structural operator kind and a tree fold** (section 6), additive,
   when a second `$`-keyword format wants them.

Dropped from the earlier revisions: a path on the evaluation site (low
value to this plugin, which walks the tree itself, and breaking for Go's
`Evaluate` type); a deferred `evaluate` (no consumer under 8.1, and
equal to parse-then-`evaluation()` once item 2 lands); an error on a
dangling operator (contradicts `dangling-operator.tsv` and rejects legal
inputs such as bare `#`); a juxtaposition operator (contradicts the
implicit-list fixtures, and templates do not need `expr`).

### 8.3 Enhancements to `@tabnas/parser`

1. **An end-of-parse hook**, named so as not to collide with the existing
   `rule.finish` option (`parse.complete`, say), with a contract the
   review asked for: `(tabnas, ctx, meta) => result | void`; runs after
   the trailing-content check and before `result.fail`; never on a throw;
   receives `{ value, errors }` under recovery; insertion order in every
   runtime, repairing `prepare`'s Go sort in the same change with a
   fixture; a mutable root accessor in Rust so it can replace the result.
   Wanted for what `ruleDone` cannot give, not needed to start.
2. **`MarshalJSON` on Go's `MapRef` and `ListRef`** emitting the value, so
   a tree parsed with `info` on is verbatim as JSON in Go as it is in
   TypeScript and Rust. Only if the plugin ever rides the marker.

The first two drafts proposed positions on the `info` marker; the review
showed the marker is written only by `@object$`/`@array$`, which yaml's
block builders do not use, so it would miss exactly the sites that
motivated it. `ruleDone` is the route.

### 8.4 Notes for `@tabnas/yaml` and `@tabnas/jsonic`

- yaml's `yamlElemMap` and block-sequence builders allocate their
  containers directly and attach no `info` marker; adopting
  `@object$`/`@array$`, or attaching the marker, would make the marker
  uniform. Not needed while provenance comes from `ruleDone`.
- jsonic's `use()` resets `info` to its defaults, so a constructor option
  is lost; merging instead of resetting would remove an ordering trap.
- The start rule is `stream` and a multi-document stream parses to an
  array; an unquoted `$ref: #/x` reads as null; an unquoted `swagger:
  2.0` reads as 2; a JSON text whose first line is empty fails with
  `unexpected`; a reported column is one too large per preceding `: ` on
  its line. The plugin's guide records all five, and the last two are yaml
  defects worth an instruction.
- apidef's alias-expansion bound (`yamlalias.ts`) describes a cost in the
  yaml plugin's alias copying that belongs with that plugin, as a
  documented limit or an option.

### 8.5 Migration from apidef

Gated on the TypeScript and Go ports both shipping, with apidef's
`parse-resolve.tsv` green in both. A `compat: 'apidef'` preset
reproduces apidef's resolver: `x-ref` beside every resolved and every
unresolved site, the site's siblings winning at every object kind, one
shallow copy per site with the target's children shared, cycles kept (so
apidef's own `decycle`, `DECYCLED` and `decycledChild` stay as they are,
a post-pass over any graph that imports nothing from the resolver, and
the Go port's cyclic graph stays as it is), a non-object target left
unresolved, a reference ring left verbatim, and aliases followed when a
pointer segment lands on one. What `parse.ts` does before resolving
(lone-surrogate repair, path-key normalisation, the `components` default,
`__proto__`-safe writes) stays in apidef or moves to the plugin as the
plan's table says; Swagger 2.0 is covered by the version table. The
switch from `merge` to the specification's sibling rules is a separate,
measured step against apidef's fixtures.

## 9. Risks

| Risk | What the note measured | Mitigation |
|---|---|---|
| Serialising a resolved document is exponential or impossible | Stripe: `JSON.stringify` fails after 90 s; a 1.9 KB diamond becomes 7.4 MiB | sharing policies; `inline-once` for anything written; `copy` bounded |
| A loader follows document-supplied URIs | the engine's untrusted-input rule | off by default; allow-list; budgets; same instance parses what is loaded |
| The sibling rule or slot table is wrong for a version | 40 of apidef's 45 fixtures are 3.0.x; a quarter of Stripe's `$ref` maps are data | version first, position second, table generated from the schemas, unknown is data |
| A `__proto__` key is lost or becomes a prototype | the second draft's walk dropped it | null-prototype objects, defined members, a fixture |
| An end-of-parse trigger misses YAML directives | the start-rule hook returned the raw document | `ruleDone`, measured on the three inputs |
| Grammar parse cost on large JSON | 3.2 s and 3.8 s against 30 ms | the fast path |
| A report passed through plugin options is lost | `unresolved = []` in the second draft | callbacks or the function form |

## 10. Open questions

- Should the resolved default for a 3.1 Schema Object with `$ref` and
  siblings be the conjunction (correct under 2020-12) or the merge (what
  apidef and most tooling do)? The prototype does the former behind a
  version check; the option is cheap either way.
- Should `$dynamicRef`/`$dynamicAnchor` be resolved in the resolved tree,
  or left verbatim as evaluation-time constructs? The specification treats
  them as JSON Schema keywords; resolving them statically is possible but
  depends on the dynamic scope.
- Where do runtime expressions live on the resolved report: as strings,
  as the reader's structure, or both?
- Loader: synchronous, asynchronous, or a synchronous `resolve` under an
  asynchronous `resolveAll` that loads first?
- Swagger 2.0: the full position model, or raw plus local JSON Reference
  resolution only?
- Does the resolved report validate implicit connections (dangling
  security scheme names, tags, `operationId`, discriminator names) beside
  `unresolved`? apidef's `operationFacts` would use it.
- The Go and Rust ports of the tree layer: in which order, and does
  `expr` release the TypeScript layer before both ports land, given the
  parity rule that shared fixtures run in every runtime (which is why
  `test/tree/` sits outside `test/spec/` for now)?
- What is the Go shape of a structural operator node, given the wrapped
  array `DIVERGENCE.md` records for token operators?

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
node e4-expr-struct.js
node bench.js <path to a large description, such as Stripe's spec3.json>
```

`e6-expr-fold.js` needs the tree layer, which is in `tabnas/expr` pull
request 100 and not yet in a published `@tabnas/expr`. Until it is, build
that branch's `ts/` and point the script at it:

```sh
cd <this-repo>/docs/design/prototype
export TABNAS_EXPR=<expr checkout>/ts
export NODE_PATH=<expr checkout>/ts/node_modules:/tmp/openapi-proto/node_modules
node e6-expr-fold.js                      # the document beside it, e6-doc.yaml
node e6-expr-fold.js <path to spec3.json> # a JSON description: the one summary line
```

It runs from its own directory, which holds `e6-doc.yaml`.

Each script's output as captured for this document is in the
`*.result.txt` file beside it; `bench.result.txt` names the document it
was run on, which is not committed here. The versions it was captured
against are in section 4.
