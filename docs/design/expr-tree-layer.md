# The `expr` tree layer: key operators and `fold`

The extension of `@tabnas/expr` that carries OpenAPI's meta-operations,
designed and built in answer to the maintainer's direction of 6 November
2026: `expr` is vital and central to this work, which is a forcing
function to make `expr` more general and of greater functionality, and
the limitations the design note identified are to be met by extending
`expr` rather than worked around beside it. This document records the
extension: each limitation and what meets it, the contract the layer
keeps, what was measured against the OpenAPI requirements, what each port
must mirror, and what is still open. The code is in `tabnas/expr` pull
request 100 (TypeScript, the canonical runtime); the design note
[`expr-for-meta-operations.md`](expr-for-meta-operations.md) holds the
investigation that led here, and the
[implementation plan](implementation-plan.md) now builds on the layer.

It is a working document, outside the prose gate's file list.

## 1. From "where does the fold live" to "how does `expr` grow"

The design note's section 6 answered the maintainer's question, whether
`expr` should handle trees as well as values, with a design in three
parts: operators recognised by shape, a fold that walks the tree with
context flowing down, and the resolver kept outside. Its section 6.4 then
weighed three homes for that design and recommended the smallest first
step, a fold inside the plugin behind an `expr`-shaped interface, with the
lift into `expr` as a later move. The maintainer's direction reverses
that order and changes the question. `expr` today has one kind of
operator, the token, and one time of evaluation, the close of an
expression. A `$ref` is neither: it is a shape, and it is complete only
when the document is. Making `expr` carry it means giving `expr` a second
kind of operator and a second time of evaluation, as general facilities,
of which OpenAPI is the first consumer. That is what was built.

## 2. The limitations, and what meets each

The note's findings, numbered as there, and the extension that answers
each. Every row names the symbol in `ts/src/expr.ts` and the test that
pins it.

| Limitation (note) | Extension | Symbol | Pinned by |
|---|---|---|---|
| Every `expr` operator is a token; `$ref` cannot be lexical, since the pair rule owns the key position (findings 2, 11) | A **key operator**: declared `{ key: true, src: '$ref' }`, recognised after the base grammar has built a map, by the map's owning the member `src`; no binding power, since the shape fixes the operands | `OpDef.key`, `Op.key`, `makeKeyMap`, `keyOpOf` | `test/tree/key-basic.tsv` |
| `evaluate` is eager and runs before the document is complete; the specification requires the whole document first (findings 1, 3) | A second time of evaluation: **`fold(root, options)`** over the finished tree, bottom-up; and a **deferred mode**, `ExprOptions.fold`, that runs the same fold on the finished root before `parse` returns | `fold`, `foldTree`, the `ruleDone` subscriber | `at-pointer.tsv` (run twice, as a function and deferred); "deferred mode" in `tree.test.ts` |
| `evaluation()` does not descend into objects, in any runtime (finding 3) | `fold` walks every map and list; and `evaluation(..., { objects: true })` descends into maps, opt-in because an unconditional walk changes 180 of 1061 existing fixture rows | `evaluation` | `tokens.tsv`; the `evaluation` cases in `tree.test.ts` |
| The raw tree must be verbatim and an operator node is an array (finding 2) | A key operator never rewrites the parsed tree. The document comes out as written; `fold` returns a new tree and never changes its input | `walk` builds through `newRecord` | "raw tree untouched" |
| The resolver needs a site: root, path, token, and context from the ancestors; Rust's `EvalSite` has the token only (finding 12) | **`Site`**: `{ root, path, node, k, token?, at, locate, fold }` | `siteFor` | `inherit.tsv` |
| Context must come from the target's own ancestors, never the referrer's; the E4 prototype got this wrong once | **`inherit(site, node, k)`** computed per path from each map's own ancestors and memoised, so a target reached early through a reference sees its ancestors' bag | `kAt` | `inherit.tsv`: `seen` is `['b/c=y']` |
| One target is named by many sites, and identity cannot key a memo where values are copy-on-write (Rust) or copies (yaml aliases) | Memo **by RFC 6901 pointer string**: one result per path, shared by every site that names it | `pointer`, `memo` in `foldRoot` | "one object per target" |
| A recursive schema reaches its own target, top-down or through a chain; a two-schema ring; a reference into a ring (finding 12) | An **active set** of every container being folded, plus a **cyclic set**: a target still being folded is a cycle, and so is a target whose own resolution met one. `cycle: 'verbatim'` (default) hands the site back to the resolver; `cycle: 'error'` throws | `at`, `active`, `cyclic` | the cycle list `['/a>/a', '/b/c>/b', '/r>', '/x>/y', '/y>/x']` |
| No runtime offers a stable operator constructor or predicate (finding 8) | **`opify`** and **`isOp`** exported, with `keyOpOf` and `makeKeyMap` | the export list | "opify and isOp" |
| A resolver needs the site's position in the source | **`positions: true`** in deferred mode records every container's opening token while parsing, by node, and hands it over as `site.token` | `tokensByNode` | `['a@2:6']` |
| `$dynamicRef` has a meaning a parser cannot compute (note section 1) | **`dynamic: true`**: recognised and reported, never evaluated; the map still folds as a plain map | `Op.dynamic`, `report.dynamic` | "dynamic reported" |
| A document may carry both `+` and `$ref` | **`tokens: true`** (default) reduces token operator arrays met in the walk through the same `evaluate`; `op.key` tells the two apart | `walk` | `tokens.tsv` |
| The TypeScript `Evaluate` type is a rest parameter where a fold passes an array (panel) | `FoldEvaluate` is `(site, op, terms: any[]) => any` | the type | compile |
| A report passed through plugin options is lost to the option deep copy (finding 13) | `report` is a callback, and the function form returns through the resolver's own closure | `FoldOptions.report` | "cycles reported", "unresolved reported" |

## 3. The contract

Written in the reference as the layer's documentation; the rules behind
the types, which a port reproduces:

1. **Recognition by shape, at fold time.** A map is an occurrence of a key
   operator when it owns the member named by `src`. Nothing at parse time
   marks it: a marker would miss a tree that was not parsed by the
   grammar (the `JSON.parse` fast path), die on a copy, and in Go force
   the `info` option on, which turns every map into a `MapRef`. A map
   that owns two declared keys is an occurrence of the one declared
   first.
2. **Bottom-up, with `[value, siblings]`.** The key's value and the other
   members are folded first; the resolver gets the folded value and a new
   map of the folded siblings, of the same prototype as the site, and
   returns what stands at the site. Returning `site.node` keeps the
   verbatim map.
3. **Values up, context down.** `inherit` is called for every map on the
   way from the root, with the bag its parent's subtree sees, and returns
   the bag for this map's subtree; it is a function of the path, computed
   from the map's own ancestors and memoised per path, so the order in
   which sites are reached does not change what any site sees. The root's
   starting bag is `options.k`.
4. **One result per path.** Memo by RFC 6901 pointer, never by identity.
   Every container being folded is on the active set for the duration of
   its fold.
5. **`at(path)`** folds the location named, through any key-operator sites
   met on the way (a pointer may pass through a `$ref` to reach a member
   of its target), and returns `{ found, cycle, value }`. A target on the
   active set, or on the cyclic set, is a cycle; a target that names
   nothing is `found: false`; both are recorded in the report, and a site
   whose target was a cycle joins the cyclic set, so a reference into a
   ring is a cycle too. **`locate(path)`** reads the raw tree and follows
   nothing.
6. **The input is never changed.** Every map or list on the way out is a
   new object of the same prototype as the one it replaces, members
   defined rather than assigned, so a `__proto__` key stays a key.
7. **Dynamic keys** are reported at their path and left alone; their maps
   fold as plain maps.
8. **Deferred mode** runs the fold on the engine's post-process rule
   event, filtered to the last pass of a parse: a depth-0 close whose
   alternate neither pushes nor replaces, outside probes and recovery.
   `ctx.root().node` then holds the result and is overwritten with the
   fold. This is grammar-neutral: yaml replaces its `stream` rule on
   directives and markers, and the start rule's after-close is therefore
   not that event. A resolver that throws surfaces its error from `parse`
   and the instance keeps working.
9. **The report** lists `cycles`, `unresolved` and `dynamic`, each entry
   by RFC 6901 pointer, through a callback.

What the layer does not know: what a key means, which URI scheme its
value uses, what the siblings do, how another document is loaded. Those
are the resolver's, and in OpenAPI's case the plugin's.

## 4. What stays in the host: the OpenAPI vocabulary

Experiment E6 (`prototype/e6-expr-fold.js`) is the OpenAPI resolver
written as a vocabulary over the layer, with nothing generic in it. Its
parts, which the plugin's Phase 2 turns into exact code:

| Part | What it knows |
|---|---|
| the operator table | `$ref` is a key operator; `$dynamicRef` is dynamic |
| `docVersion` | Swagger 2.0, 3.0.x, 3.1 and later, from the root |
| `kindAt(path)` | which kind of object a position holds: a Reference Object, a Schema Object, a Path Item, or data (`x-`, `example`, `const`, `enum`, a schema `default`, an Example `value`); the plan's object model replaces this sketch |
| `indexIds` | `$self`, `$id` and `$anchor` targets, indexed once over the raw tree, with each resource's base from its nearest `$id` |
| `resolveUri`, `pointerParts` | RFC 3986 joining; percent-decoding the whole fragment, then splitting, then `~1` and `~0` |
| `inherit` | sets `base` from `$id` or `$self`, and `kind` from the path, in the bag each subtree sees |
| `combine` | the sibling rule by version and kind: Reference Object `summary` and `description` override in 3.1 and later, nothing in 3.0, nothing in 2.0; a Path Item merges; a 3.1 Schema Object conjoins through `allOf` |
| `evaluate` | data slots left verbatim; the URI resolved against `site.k.base`; an external document recorded for the loader; the target reached through `site.at`; provenance recorded once per site; the cycle and the miss handed back as the verbatim site |

About a hundred and twenty lines, each one OpenAPI or JSON Schema. The
generic machinery the earlier prototypes (E3, E4) carried, about ninety
lines each, is gone from the host.

### What E6 showed

On the YAML document `prototype/e6-doc.yaml` (a 3.1 description with a
`$self`, two `$id` resources, an `$anchor`, a block-sequence parameter
entry, a Reference Object with an override, a reference to a reference, a
Path Item `$ref` with a sibling, a `$dynamicRef`, an external reference,
a percent-encoded pointer, a data slot under `x-` and under `example`, a
recursive schema, and a `__proto__` key), parsed by `jsonic`+`yaml` and
folded through the layer, captured in `prototype/e6-expr-fold.result.txt`:

- the raw tree is unchanged by the fold, and the result serialises;
- a block-sequence entry resolves, by shape, where E3's `val` hook missed
  it;
- the Reference Object's `description` overrides the target's; the
  reference to a reference resolves to the final target; two sites naming
  one response share one object;
- the Path Item merges its sibling `summary`;
- a target under an `$id`, reached first through a reference from
  outside its resource, resolves its own relative reference against its
  own `$id`, not the referrer's base;
- a 3.1 Schema Object with a sibling `description` becomes the `allOf`
  conjunction; the same document read as 3.0.3 drops the sibling;
- `#name` resolves through the anchor index; `#` from inside the schema
  is a cycle and stays verbatim; `$dynamicRef` is reported and left
  alone; the external reference is recorded for the loader and left
  alone; `%2F` decodes before the split;
- the `x-` and `example` sites keep their `$ref` as data;
- `__proto__` survives as a key;
- the report lists the one cycle and the one dynamic site, and nothing
  unresolved.

On Stripe's `spec3.json` (7.9 MiB, 3.0.0), the fold runs on the output
of `JSON.parse`, with no grammar involved, which is the fast path the plan
needs:

| Measure | E6 over `expr.fold` | E3's in-place resolver |
|---|---|---|
| time | 658 ms | 256 ms |
| sites resolved | 3673 | 3570 |
| cycles | 125 | 125 cuts |
| unresolved | 0 | 0 |

The site counts differ because E6's `kindAt` is a sketch of the data-slot
rule, not the plan's object model, and types 389 of the 4062 `$ref` maps
as data where E3's rule typed 492; the object model decides. The time
differs because the fold builds a new tree with a pointer string per
container and an inherited bag per map, where E3 copied each site
shallowly in place. Against a 3.2 s grammar parse of the same text it is
a fifth; against the 30 ms `JSON.parse` it is the cost of resolution, and
the first candidate for optimisation is building the pointer and the bag
lazily.

## 5. What each port must mirror

The layer is TypeScript-only at this writing. The contract is in
`expr`'s `AGENTS.md` under "The tree layer"; the port-specific points:

**Go.** `Key` and `Dynamic` on `OpDef` and `Op`; `Fold(root any, opts
FoldOptions) any` with a `FoldEvaluate func(site *Site, op *Op, terms
[]any) any` beside the four-argument `Evaluate`, and `Inherit func(site
*Site, node any, k map[string]any) map[string]any`; shape recognition
over every map the engine can hand back (`*OrderedMap`, `map[string]any`,
`MapRef`), siblings as a new `*OrderedMap`; memo and the active and
cyclic sets by pointer string; the deferred mode through `Sub(RuleDone)`
writing the final done rule's node, since `parse` returns the private
`resultRule`'s node and a replace moves it, measured on a yaml stream
with directives before it is trusted. The occurrence token on the Go
operator node (`ListRef.Meta`) is the one upstream item of the earlier
list that is still outstanding, and `positions` needs it. The recorded Go
shape of `Op` in `DIVERGENCE.md` gains two fields, which stales its pins.

**Rust.** `key` and `dynamic` on `OpDef` and `Op`; `fold(root: &Value,
opts: &FoldOptions) -> Result<Value, TabnasError>` with `FoldEvaluate`
over `(&Site, &Op, Vec<Value>)`, extending `EvalSite`; values are
copy-on-write, which is why the memo is by path; shape recognition over
`Value::Object` and `Value::MapRef`; the function form only, since the
subscriber cannot replace the result (the engine's `parse.complete` hook,
in the plan's upstream list, would change that).

**Fixtures.** `test/tree/*.tsv` runs in TypeScript alone, from
`ts/test/tree-spec.test.ts`, with the header `input` and `expected`, so
each port adds a runner and the files move into `test/spec/` when both
have landed; the parity rule then applies to them as to every other
shared fixture.

**Size.** About 430 lines of TypeScript landed; the plan's estimates of
380 Go and 450 Rust lines plus the runners stand.

## 6. What the layer changes for `@tabnas/openapi`

- `@tabnas/expr` becomes a runtime dependency of the plugin in all
  three runtimes, on the maintainer's instruction, once the layer is
  published; until then the plugin's Phase 2 is written against the
  checkout and no manifest moves.
- The plugin's `resolve(raw, options)` is `expr.fold` under an OpenAPI
  `evaluate` and `inherit`, with the object model, the sibling rules, the
  URI machinery, the `$id` index, the loader hand-off and the report's
  OpenAPI fields (`provenance`, `connections`, `cuts`, `documents`)
  around it. The fold's own report (`cycles`, `unresolved`, `dynamic`)
  feeds the plugin's.
- The in-parse option (`use(OpenApi, { resolve: true })`) is
  `ExprOptions.fold` with the same callbacks, in TypeScript and Go; Rust
  has the function form.
- The raw tree is untouched by any of it, which was the first
  requirement.
- The plugin never installs `expr`'s default operator table under the
  document grammar: its `/` breaks `/pets:` as a YAML key. The instance
  the plugin owns declares the key operators and no token operators, and
  `fold` is called with that same table.

## 7. Open items

- The Go and Rust ports, and their order; the expr release that carries
  the layer; the openapi dependency instruction that follows it.
- The Go occurrence token, which `positions` in Go needs.
- Fold cost on large documents (658 ms on Stripe against 256 ms in
  place); lazy pointer and bag construction.
- Cross-document folds: `site.fold(doc, k)` runs the same options over a
  loaded document with its own memo, and cross-document cycles are the
  host's to detect by URI chain; whether the layer should carry a
  document key in its memo instead is a question for Phase 3.
- Whether `simplify` should render a key-operator site in its
  S-expression form (today that view is a fold output through a
  recording resolver), and whether the deferred mode should hand the
  report to the caller through `parse`'s meta rather than a callback.
- Whether a key operator should also be declared by a predicate on the
  map, for formats whose operation is a shape without a single keyword
  (a list whose head is a keyword), which the note's section 6.1
  anticipated and the layer does not yet offer.
