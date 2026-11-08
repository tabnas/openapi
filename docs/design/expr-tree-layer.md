# The `expr` tree layer: key operators and `fold`

The extension of `@tabnas/expr` that carries OpenAPI's meta-operations,
designed and built in answer to the maintainer's direction of 6 November
2026: `expr` is vital and central to this work, which is a forcing
function to make `expr` more general and of greater functionality, and
the limitations the design note identified are to be met by extending
`expr` rather than worked around beside it. This document records the
extension: each limitation and what meets it, the contract the layer
keeps, what was measured against the OpenAPI requirements, what each port
must settle, and what is still open. The code is in `tabnas/expr` pull
request 100 (TypeScript, the canonical runtime); the design note
[`expr-for-meta-operations.md`](expr-for-meta-operations.md) holds the
investigation that led here, and the
[implementation plan](implementation-plan.md) now builds on the layer.

This is the second revision. The first was reviewed through five lenses
(an `expr` maintainer, the Go and Rust ports, an OpenAPI resolver author,
untrusted input, and the documents' own consistency), with three
refuters per finding; 51 findings were raised and every one reproduced.
The layer was revised in response (`tabnas/expr` commit 6ae48c3), and so
were this document, the prototype E6 and the plan. Section 8 lists what
changed.

It is a working document, outside the prose gate's file list.

## 1. From "where does the fold live" to "how does `expr` grow"

The design note's section 6 answered the maintainer's question, whether
`expr` should handle trees as well as values, with a design in three
parts: operators recognised by shape, a fold that walks the tree with
context flowing down, and the resolver kept outside. Its section 6.4 then
weighed three homes for that design and recommended the smallest first
step, a fold inside the plugin behind an `expr`-shaped interface, with the
lift into `expr` as a later move. The maintainer's direction reverses
that order and changes the question. `expr` had one kind of operator, the
token, and one time of evaluation, the close of an expression. A `$ref`
is neither: it is a shape, and it is complete only when the document is.
Making `expr` carry it means giving `expr` a second kind of operator and a
second time of evaluation, as general facilities, of which OpenAPI is the
first consumer. That is what was built.

## 2. The limitations, and what meets each

The note's findings, numbered as there, and the extension that answers
each. Every row names the symbol in `ts/src/expr.ts` and the test that
pins it, by its name in `ts/test/tree.test.ts` or by fixture file.

| Limitation (note) | Extension | Symbol | Pinned by |
|---|---|---|---|
| Every `expr` operator is a token; `$ref` cannot be lexical, since the pair rule owns the key position (findings 2, 11) | A **key operator**: declared `{ key: true, src: '$ref' }`, recognised after the base grammar has built a map, by the map's owning the member `src`; no binding power, since the shape fixes the operands | `OpDef.key`, `makeKeyMap`, `keyOpOf` | `key-basic.tsv`; "a map that owns two key members: static first, then by code point" |
| Shape alone does not decide: a property named `$ref`, or a `$ref` in example data, is data (finding 6) | **`recognise(site, op)`** refuses a site; the map folds as a plain map. **`site.plain()`** gives the plain fold to a resolver that finds no operation | `siteOpOf`, `plainOf` | "recognise and plain: a map that owns $ref need not be a site" |
| `evaluate` is eager and runs before the document is complete; the specification requires the whole document first (findings 1, 3) | A second time of evaluation: **`fold(root, options)`** over the finished tree, bottom-up; and a **deferred mode**, `ExprOptions.fold`, that runs the same fold on the finished root before `parse` returns, and never on a parse that fails | `fold`, `foldTree`, the `ruleDone` subscriber | `at-pointer.tsv`, run as a function and deferred; "a parse that fails is not folded, and a resolver error is not masked" |
| `evaluation()` does not descend into objects, in any runtime (finding 3) | `fold` walks every plain map and list; and `evaluation(..., { objects: true })` descends into maps, opt-in because an unconditional walk changes 180 of the 1136 rows in `test/spec/*.tsv` (the rows whose expected value holds an operator node inside a map) | `evaluation` | `tokens.tsv`; the `evaluation over objects` tests |
| The raw tree must be verbatim and an operator node is an array (finding 2) | A key operator never rewrites the parsed tree. The document comes out as written; `fold` returns a new tree and never changes its input | `walk` builds through `newRecord` | "leaves the raw tree as it was and returns a new one" |
| The resolver needs a site: root, path, token, and context from the ancestors; Rust's `EvalSite` has the token only (finding 12) | **`Site`**: `{ root, doc, path, node, k, token?, at, locate, plain }` | `siteOf` | `inherit.tsv` |
| Context must come from the target's own ancestors, never the referrer's; the E4 prototype got this wrong once | **`inherit(site, node, k)`**, applied from the root down to and including the site's own map, each map's bag kept, so a target reached early through a reference sees its own ancestors' bag | `kOf` | "the inherited bag comes from the target's own ancestors"; "the bag at a site includes its own map, and inherit must return one" |
| One target is named by many sites, and identity cannot key a memory where values are copy-on-write (Rust) or copies (yaml aliases) | **One result per location**, kept in a trie of locations per document: constant cost per container however deep | `PNode`, `kid` | "one target, one folded object, shared by every site" |
| A recursive schema reaches its own target, top-down or through a chain; a two-schema ring; a reference into a ring (finding 12) | An **active stack** that records how each frame was entered. A loop of references alone, and references into it, are cycles; a cycle through a container is cut once. `cycle: 'error'` throws `fold_cycle` | `cycleTo`, `at` | "cycles are reported and kept verbatim, or thrown"; "a cycle through a container is cut once, in either member order"; `errors.tsv` |
| Several documents: a reference names another document, and cycles cross documents | **`doc`** and **`load(key, site)`**, `site.at(path, doc)`; memory, cycles and sharing span documents; report rows carry `doc` and `targetDoc` | `docOf` | "several documents: loaded once, shared targets, cycles across them" |
| No runtime offers a stable operator constructor or predicate (finding 8) | **`opify`** and **`isOp`** exported, with `keyOpOf` and `makeKeyMap` | the export list | "a hand-built operator node is recognised by isOp and evaluation" |
| A resolver needs the site's position in the source | **`positions`**: a function from a container to its opening token, built by **`recordPositions(tn)`**, or `true` in deferred mode | `recordPositions` | "positions: a lookup in the function form, true only when deferred" |
| `$dynamicRef` has a meaning a parser cannot compute (note section 1) | **`dynamic: true`**: recognised and reported, never evaluated; the map still folds as a plain map. A host that wants to look at such a site declares it an ordinary key operator and returns `site.plain()` | `Op.dynamic`, `report.dynamic` | "a dynamic key is reported and folded as a plain map" |
| A document may carry both `+` and `$ref` | **`tokens: true`** (default) reduces token operator arrays met in the walk through the same `evaluate`, each term folded at its own path; with `tokens: false` an operator node stays one | `walk` | `tokens.tsv`; "tokens off keeps an operator node an operator node" |
| The TypeScript `Evaluate` type was a rest parameter where every call passes one array (panel) | `Evaluate` and `FoldEvaluate` both take `terms: any[]` | the types | compile |
| A report passed through plugin options is lost to the option deep copy (finding 13) | `report` is a callback | `FoldOptions.report` | "a target that names nothing is reported and the site kept" |
| A document from outside can be deep, or a chain of references long, or a JavaScript object cyclic | **`maxDepth`** (default 1000) and a coded **`FoldError`** (`fold_depth`), never a `RangeError` | `walk`, `foldTree` | "depth: a deep chain or nesting raises fold_depth, never a RangeError"; `errors.tsv` |

## 3. The contract

Written in the reference as the layer's documentation; the rules behind
the types, which a port reproduces:

1. **Recognition by shape, at fold time, then by the host.** A map is a
   candidate occurrence of a key operator when it owns the member named
   by `src`. Nothing at parse time marks it: a marker would miss a tree
   that was not parsed by the grammar (the `JSON.parse` fast path), die
   on a copy, and in Go force the `info` option on, which turns every map
   into a `MapRef`. The host's `recognise` then decides, once per map. A
   map that owns two key members is an occurrence of the static operator
   before a dynamic one, then of the member name first by code point; two
   operators on one member name are refused (`fold_key`).
2. **What is walked.** Plain records (prototype `null` or
   `Object.prototype`) and arrays, members in their own order. Any other
   object is a leaf kept by identity.
3. **Bottom-up, with `[value, siblings]`.** The key's value and the other
   members are folded first; the resolver gets the folded value and a new
   map of the folded siblings, of the same prototype as the site, and
   returns what stands at the site. `site.node` is the verbatim map;
   `site.plain()` is the map folded member by member. What the resolver
   returns is placed as it is, so a raw value it returns is shared with
   the input.
4. **Values up, context down.** `inherit` is called once for every map on
   a path the fold needs, from the root down, with the bag the parent
   passes on, and returns the bag for that map and everything below it.
   It is a function of the path, worked out from the map's own ancestors
   and kept, so the order in which sites are reached does not change what
   any site sees. A site's own bag includes its own map's contribution.
   Every document's root starts from `options.k`. An `inherit` that
   returns no object, or folds below its own map, throws `fold_inherit`.
5. **One result per location.** Kept per document in a trie of
   locations, never by object identity. Array indices are RFC 6901.
6. **`at(path, doc?)`** folds the location named, through any static site
   met on the way (a pointer may pass through a `$ref` to reach a member
   of its target), and returns `{ found, cycle, value }`, with `value`
   only when found and not a cycle. A map that is not a static site
   (dynamic, or refused by `recognise`) does not change the path below
   it. **`locate(path, doc?)`** reads raw and follows nothing.
7. **Cycles.** A site whose target is on the active stack closes a cycle.
   When every frame after the target was entered through a reference,
   the loop is made of references alone: all its members are cycles, and
   so is every later reference into it. Otherwise the cycle passes
   through a container and is cut once, at that site; a later reference
   to the cut site gets its folded value, and a path through it is a
   cycle. Which site holds a cut follows the walk, from the root in
   member order: stable for a document, movable by reordering members.
   In general no rule can make the set of cuts independent of member
   order, since choosing a smallest set of edges to cut is the minimum
   feedback arc set problem.
8. **Several documents.** `options.doc` keys the document folded, and
   `options.load(key, site)` returns another's raw root, once per key, or
   `undefined`. Memory, the active stack and sharing span documents.
9. **The input is never changed.** Every map or list on the way out is a
   new object of the same prototype as the one it replaces, members
   defined rather than assigned, so a `__proto__` key stays a key.
10. **Dynamic keys** are reported at their location and left alone; their
    maps fold as plain maps.
11. **Deferred mode** runs the fold on the engine's post-process rule
    event, filtered to the last pass of a parse: a depth-0 close whose
    alternate is null or neither pushes, replaces nor failed, outside
    probes and recovery-forced closes. The fold writes the node `parse`
    returns: `ctx.root().node` in TypeScript, and in Go the node of the
    rule the final event handed over (section 5). A parse that fails is
    never folded; under the engine's recovery the recovered value is
    folded once. A resolver that throws surfaces its error from `parse`
    and the instance keeps working.
12. **The report** lists `cycles` and `unresolved` as `{ doc, at,
    targetDoc, target }` and `dynamic` as `{ doc, at, src }`, pointers by
    RFC 6901, each row once, through a callback.
13. **Errors** are `FoldError`s with a `code` (`fold_cycle`,
    `fold_depth`, `fold_inherit`, `fold_key`, `fold_option`) and the
    location as fields; member names in a message are JSON-escaped and cut
    short. `maxDepth` (default 1000) bounds nesting and reference hops
    together, and a stack overflow becomes `fold_depth`.

What the layer does not know: what a key means, which URI scheme its
value uses, what the siblings do, how another document is fetched. Those
are the resolver's, and in OpenAPI's case the plugin's.

## 4. What stays in the host: the OpenAPI vocabulary

Experiment E6 (`prototype/e6-expr-fold.js`) is the OpenAPI resolver
written as a vocabulary over the layer, with nothing generic in it. Its
parts, which the plugin's Phase 2 turns into exact code:

| Part | What it knows |
|---|---|
| the operator table | `$ref` is a key operator; `$dynamicRef` is dynamic |
| `docVersion` | Swagger 2.0, 3.0, 3.1, 3.2, from the root; JSON Schema identifiers (`$id`, `$anchor`, `$dynamicAnchor`) only from 3.1, `$self` only from 3.2 |
| `classify(path, version)` | what a position holds, segment by segment: a Schema Object, another OpenAPI object and its type, a map of author-chosen names, or data (`x-`, `example`, a schema's `examples`, `const`, `enum` and `default`, an Example's `value`, a Server Variable's `default` and `enum`, a Link's `parameters`); a name under `properties` is never read as a keyword; the plan's object model replaces this sketch |
| `indexIds` | the `$id`, `$anchor` and `$dynamicAnchor` targets of a document, in schema positions only, with each resource's base from its nearest `$id` |
| `resolveUri`, `pointerParts` | RFC 3986 section 5.2 resolution, dot segments removed; percent-decoding the whole fragment, then splitting, then `~1` and `~0` |
| `inherit` | sets `base` from the document's URI and a schema's `$id`, and `kind` and `type` from the position |
| `recognise` | a `$ref` in data, or a name in a map of names, is not a site |
| `combine` | the sibling rule: a Path Item merges in every version; 2.0 and 3.0 ignore a Reference Object's siblings; from 3.1 a Schema Object conjoins through `allOf` and a Reference Object's `summary` and `description` override only where the target's type has the field |
| `evaluate` | a non-string `$ref` is reported and the map kept as `site.plain()`; an unknown anchor and a malformed fragment are reported; the target is reached through `site.at`, in another document through `load`; provenance recorded once per site, with a position |

About two hundred lines, each one OpenAPI, JSON Schema or RFC 3986. The
generic machinery the earlier prototypes (E3, E4) carried, about ninety
lines each, is not in the host.

### What E6 showed

On the YAML document `prototype/e6-doc.yaml` (a 3.2 description with a
`$self`, three `$id` resources, an `$anchor`, a block-sequence parameter
entry, a Reference Object whose `summary` and `description` override a
Response's, a reference to a reference, a Path Item `$ref` with a
sibling, a relative reference with `..`, a property named `example`, a
`$dynamicRef`, a reference to another document and one to a document that
cannot be had, a percent-encoded pointer, a map of names holding a
property named `$ref`, a `$ref` that is not a string, an unknown anchor, a
malformed fragment, data under `x-` and under `example`, a recursive
schema and a `__proto__` key), parsed by `jsonic`+`yaml` and folded
through the layer, captured in `prototype/e6-expr-fold.result.txt`:

- the raw tree is unchanged by the fold, and the result serialises;
- a block-sequence entry resolves, by shape, where E3's `val` hook missed
  it;
- the Reference Object's `summary` and `description` override the 3.2
  Response's; the reference to a reference resolves to the final target;
  two sites naming one response share one object;
- the Path Item merges its sibling `summary`, and so does a Swagger 2.0
  Path Item;
- a target under an `$id`, reached first through a reference from
  outside its resource, resolves its own relative reference against its
  own `$id`; `../v1/owner.json` loses its dot segments;
- a Schema Object with a sibling `description` becomes the `allOf`
  conjunction; read as 3.0.3, the same document has no `$id`, so
  `tag.json` resolves against the document's own URI and is unresolved;
- a property named `example` resolves as a schema; a property named
  `$ref` stays a name; the `x-` and `example` data keep their `$ref`;
- `#name` resolves through the anchor index; `#` from inside the schema
  is a cycle through the schema and is cut; `$dynamicRef` is reported and
  left alone; `%2F` decodes before the split;
- the other document is loaded once through `load`; the one that cannot
  be had is reported unresolved with both document keys;
- the `$ref` that is not a string, the unknown anchor and the malformed
  fragment are each reported with a reason;
- `__proto__` survives as a key;
- every one of the 18 provenance entries carries a row and column, from
  `recordPositions` in the function form.

On Stripe's `spec3.json` (7.9 MiB, 3.0.0), the fold runs on the output of
`JSON.parse`, with no grammar involved, which is the fast path the plan
needs; `node e6-expr-fold.js spec3.json` prints the line captured at the
end of the result file. Three runs of each in one container, on the same
input:

| Measure | E6 over `expr.fold` | E3's in-place resolver, today |
|---|---|---|
| time | about 150 to 350 ms (the first run of a process is the slowest) | about 200 to 225 ms |
| sites resolved | 3673 | 3673 |
| `$ref` maps left as data | 389 | 389 |
| cycles | 125 | 125 cuts |
| unresolved | 0 | 0 |

The two resolvers agree on every count. The first revision of this table
paired E6 with a capture of E3 taken before E3's memory and provenance
were repaired (3570 sites, from which the note's "492 left as data" was
derived), and gave E6 at 658 ms; the fold then built a pointer string per
node. With the trie it costs about what the in-place resolver does.

## 5. What each port must settle

The layer is TypeScript-only at this writing. The contract is in
`expr`'s `AGENTS.md` under "The tree layer", with these port notes, from
the review's port lens, which read the Go and Rust code against it:

**Go.**
- `Key` and `Dynamic` on `OpDef` and `Op`; `Fold(root, opts) (any,
  error)`, `FoldEvaluate func(site *Site, op *Op, terms []any) (any,
  error)`, `Inherit` and `Recognise` beside the four-argument `Evaluate`.
  In deferred mode a failure is panicked as a `*TabnasError` carrying the
  fold code, since the engine relabels any other panic `internal`.
- Recognition over `*OrderedMap`, whose member order is defined, and over
  `map[string]any` and `MapRef`, whose `Val` is a plain Go map with no
  order (it varies between runs): sort their member names by code point,
  or document the result as unordered, and run the fixtures on
  `*OrderedMap`. Siblings are a new `*OrderedMap`. The precedence rule
  and the RFC 6901 index rule port as they are; Go compares strings by
  byte, which is code-point order for UTF-8.
- The deferred filter needs `RuleDone.Probe`, which the parser Go module
  added after v0.12.11, the version `go/go.mod` requires; moving to the
  latest parser release is the standing instruction. Go's `Parse` returns
  the private `resultRule`'s node, which a start-rule replace moves, so
  the fold writes the node of the rule the final event handed over; the
  filter is to be measured to match one pass per parse, with and without
  a replace, as the review's probe did for jsonic.
- No weak map: the positions table lives in `ctx.U` for one parse, keyed
  by the `*OrderedMap` pointer (a `MapRef` is a struct value and cannot
  be a map key; key it by `reflect.ValueOf(mr.Val).Pointer()`), and the
  fold takes it as a lookup. The occurrence token on the Go operator node
  (`ListRef.Meta`) is still missing.

**Rust.**
- Every public parse realizes operator nodes into plain arrays headed by
  an operator description, which `is_op` and `evaluation` no longer
  recognise, so `tokens` cannot be mirrored over the parse result as it
  stands: fold inside `parse_scope`, on the arena-live value, or
  recognise the realized form and rebuild the `Op`. Decide before
  porting `tokens.tsv`.
- `fold` returns `Result<Value, TabnasError>`, and `FoldEvaluate` returns
  a `Result` too.
- The function form only: the rule subscriber observes and cannot replace
  the result.
- Positions are open. A container's `Arc` at its open pass need not be
  the one in the returned tree, since `Arc::make_mut` copies a shared
  container (reasoned from the type, not measured), so record at the
  close pass, or by path, and measure it; until then `site.token` is
  `None` for a key site.

**Shape pins.** Adding `key` and `dynamic` to `Op` does not fail the
`DIVERGENCE.md` pins, which test for particular keys rather than the
whole set; update the record's prose, and add the two keys to Rust's
`Op::to_value` so its realized description matches the TypeScript JSON.

**Fixtures.** `test/tree/*.tsv` runs in TypeScript alone, from
`ts/test/tree-spec.test.ts`, with the header `input` and `expected`;
`errors.tsv` pins the fold's codes as `ERROR:<code>` rows. Each port adds
a runner, and the files move into `test/spec/` when both have landed,
under the parity rule.

**Codes.** The `FoldError` codes are the layer's own, not engine codes:
no runtime declares them in `options.error` and the plugin descriptor
lists none, because a descriptor code must be declared in every runtime.
They join the catalogue and the descriptor with the ports.

**Size.** The TypeScript layer is now 813 lines added and 11 removed in
`ts/src/expr.ts` since `main`; the first commit was 423 added and 7
removed, against the third revision of the plan's estimate of about 220.
The plan's 380 Go and 450 Rust lines are therefore low, likely by the
same factor of three to four once the second review's additions
(`recognise`, documents, the trie, errors) are counted.

## 6. What the layer changes for `@tabnas/openapi`

- `@tabnas/expr` becomes a runtime dependency of the plugin in all
  three runtimes, on the maintainer's instruction, once the layer is
  published; until then the plugin's Phase 2 is written against the
  checkout and no manifest moves.
- The plugin's `resolve(raw, options)` is `expr.fold` under OpenAPI
  callbacks: `inherit` for bases and kinds, `recognise` for data and
  names, `evaluate` for the sibling rules and the URI machinery, `load`
  for the documents table of Phase 3, with the object model, the `$id`
  index and the report's OpenAPI fields (`provenance`, `connections`,
  `cuts`, `documents`) around it. The fold's own report feeds the
  plugin's.
- The in-parse option (`use(OpenApi, { resolve: true })`) is
  `ExprOptions.fold` with the same callbacks, in TypeScript and Go; Rust
  has the function form. Positions in the function form come from
  `recordPositions` on the plugin's instance.
- A `cycles: 'keep'` policy, a graph with the cycle closed, is the
  plugin's post-pass: each cycle row names the cut site and its target,
  both folded, so the plugin can put the target's value at the site.
- The raw tree is untouched by any of it, which was the first
  requirement.
- The plugin never installs `expr`'s default operator table under the
  document grammar: its `/` breaks `/pets:` as a YAML key. The instance
  the plugin owns declares the key operators and no token operators, and
  `fold` is called with that same table.

## 7. Open items

- The Go and Rust ports, and their order; the expr release that carries
  the layer; the openapi dependency instruction that follows it.
- The Go occurrence token, which `positions` in Go needs, and Rust
  positions.
- Anchors and `$id` resources inside a loaded document: E6 indexes the
  entry document only; the plugin indexes each document as it loads it.
- Whether `simplify` should render a key-operator site in its
  S-expression form (today that view is a fold output through a
  recording resolver), and whether the deferred mode should hand the
  report to the caller through `parse`'s meta rather than a callback.
- Whether a key operator should also be declared by a predicate on the
  map, for formats whose operation is a shape without a single keyword
  (a list whose head is a keyword), which the note's section 6.1
  anticipated and the layer does not yet offer.

## 8. What the second review changed

In the layer: a parse that fails is no longer folded, and a start rule
with no close alternates is; only plain records are walked; array
indices follow RFC 6901; `inherit` mistakes throw `fold_inherit`; the
cycle rule cuts a container cycle once and treats a path through a cut
as a cycle; key precedence no longer depends on declaration order;
`recognise`, `site.plain()`, several documents, `recordPositions`,
`FoldError`, `maxDepth` and deduplicated report rows were added, and
`site.fold` removed; the memory became a trie, which took a document of
10,000 nodes 1,000 deep from 844 ms and 311 MB to 5 ms and 6 MB.

In E6: the Swagger 2.0 Path Item merge, version-gated identifiers, RFC
3986 resolution, a classifier that reads names as names and joins no
segments, anchors indexed outside data only and `$dynamicAnchor` with
them, overrides only where the target's type has the field, reasons for
every miss, and a command that produces the Stripe line.

In this document: the Stripe comparison against today's E3, the test
names the table cites, the fixture row count, the size, and the port
notes.
