# E12: the site index, prototyped

A prototype for [`../typescript-plan.md`](../typescript-plan.md), taken
on 18 November 2026 for item 1 of its step T3, before any source
change. The scripts are in [`e12-site-index/`](e12-site-index/).

## The question

Section 3 of the plan puts one pass before the fold: an index of the
document's sites, which owns every fact about the document, and leaves
the fold what depends on the shape being built. Item 1 of T3 asks for
that to be prototyped first, and for six things to be shown:

1. the index gives the landing today's resolver gives for every site of
   Stripe, GitHub, apidef's definitions and the 600-document check set,
   except in the W1 to W3 shapes, each listed;
2. the typing rounds end, and give one answer when members are
   reordered;
3. the preset matches apidef's own resolver on the shapes of section 3's
   table;
4. `cycles: 'keep'` built on landings gives today's graph;
5. the `expr` change alone leaves `expr`'s own fixtures green;
6. how many references in the corpus need the lenient pointer rule,
   which is the evidence for Decision 27.

## What was built

- **The index**, `index.cjs`. One pass over a raw tree gives every site
  with its kind, type, base URI and dialect; the state, base and dialect
  of every map the object model types; the `$id` and anchor index; and
  for each site its landing, read on the document as written, with the
  sites the pointer passed. Where a step is missing at a site, the walk
  goes on in what that site names. A landing the model gives no state
  takes its site's type, and the region is searched again for sites and
  identifiers, in rounds, until a round finds nothing new. A landing
  whose type is not the one its reference expects is listed as a
  conflict.
- **The `expr` change**, `expr-written.diff`: `site.written(path)`, which
  folds a location as the document is written, where `site.at(path)`
  reads through the sites above it. It is 11 lines added and 6 removed in
  `ts/src/expr.ts`, against tabnas/expr at 72962b0 (0.6.3).
- **`resolve` on the index**, `resolver.cjs`. It is this checkout's own
  compiled resolver with seven replacements and nothing else, and it
  fails to load if one of them does not match the compiled text exactly
  once. `inherit` and `recognise` become look-ups in the index,
  `evaluate` folds the landing with `site.written`, and `cycles: 'keep'`
  walks the finished tree to the landing. Under `refs: 'pointer'` the
  index types nothing by reference and the reading stays today's, which
  is apidef's.

The prototype runs in three modes, so that a difference can be laid at
one change. With the **index alone**, the fold's facts come from the
index and nothing else changes: that must be today's resolver exactly.
With **landings**, a site is also read at its landing, which is what
repairs W1 and W2. With **landings and typing**, the regions the model
does not type are also typed by the references that land in them, which
is what repairs W3.

Two results are equal when their provenance, unresolved and cut rows
are the same rows in the same order, their connections and data-slot
counts are the same, and their trees are the same graphs: members,
member order, values, and which objects are shared.

## What was run

The build is this repository's `ts/` at a353a71, with `@tabnas/expr`
0.6.3, `@tabnas/parser` 0.12.20, `@tabnas/yaml` 0.5.33, `@tabnas/jsonic`
0.7.12 and `@tabnas/json` 0.5.20 as released, under Node 24. The
prototype's fold is the `expr` build of `expr-written.diff`.

1. `run.cjs`, then `report.cjs`: every description of the corpus that a
   sweep resolves, 5,168 documents with 1,139,457 sites, and apidef's
   own definitions, 43 descriptions of its `ts/test/def/` with this
   repository's petstore pair. Each document is parsed once and resolved
   by today's `resolve` and by the prototype in each mode, under the
   defaults and under `cycles: 'keep'`, and apidef's also under the
   preset.
2. `fixtures.cjs`: every row of `test/resolve/*.tsv` that parses, 118
   rows, under the row's own options.
3. `generated.cjs`: 6,000 documents made from a seed by the generator of
   `tools/apidef-preset/`, which holds the shapes the index changes far
   more often than real documents do, each under four sets of options.
4. `cases.cjs`: thirteen shapes, each through both resolvers, and six
   cases for the typing rounds, each under 502 orders of its members.
   `second-opinion.cjs`: the six references of the corpus that pass a
   site, and three of the shapes, through a widely used resolver.
5. `tools/apidef-preset.cjs` with `as-package.cjs` as the package: the
   prototype under the preset against apidef's own resolver, at apidef's
   commit 3b24341, over the tool's hand shapes, 6,000 generated
   documents, the corpus and both apidef fixtures.
6. `expr`'s own suite, before the change and after.

## The result

- **The index and the fold agree, everywhere.** With the index alone the
  prototype gives today's result for all 5,213 documents and their
  1,140,073 sites, for all 118 fixture rows, and for all 6,000 generated
  documents under each of four sets of options.
- **Eight documents of the corpus move, each in a shape the plan
  names.** Seven are codat.io's and hold W3. Two hold the W1 shape, one
  of them among the seven.
- **W3 is in the corpus.** The sweep could not see it. Seven
  descriptions, all OpenAPI 3.1.0, keep schemas under `definitions`,
  which 2020-12 does not have. Today the 196 references inside 170 such
  regions are not read as references. They come back as written, inside
  targets whose own sites are reported resolved.
- **No reference in the corpus needs the lenient pointer rule.** Of
  1,110,054 landings, none passes through a site that lacks the step as
  written. Six pass a site at all, and each finds its steps as written.
- **Those six land on an empty stub.** Read as written, each resolves to
  `{}`, a placeholder a converter left beside a `$ref`. This is what the
  W1 repair costs in the corpus, and it bears on Decision 27.
- **The rounds end, with one answer.** Five cases give one answer under
  502 orders of their members each. A sixth, two references of one round
  that give one target different types, gives two under the plan's rule
  and one when the sites of a round are taken in the order of their
  pointers.
- **The preset is unmoved.** Under the preset the prototype equals
  apidef's own resolver on all 15,177 documents the tool compares.
- **`keep` on landings gives today's graph** for 5,160 of the 5,168
  documents, and the eight are the same eight.
- **The `expr` change leaves its suite as it was**: 1,741 tests, 1,736
  passing and 5 skipped, before and after.

### What was compared

| Set | Documents | Sites | Index alone | Landings and typing | Under `keep` | Under the preset |
|---|---|---|---|---|---|---|
| Stripe | 3 | 13,062 | 3 equal | 3 equal | 3 equal | |
| GitHub | 4 | 42,969 | 4 equal | 4 equal | 4 equal | |
| apidef's definitions | 45 | 616 | 45 equal | 45 equal | 45 equal | 45 equal |
| The 600-document check set | 600 | 116,227 | 600 equal | 600 equal | 600 equal | |
| The whole corpus | 5,168 | 1,139,457 | 5,168 equal | 5,160 equal | 5,160 equal | |

The check set is the sample `tools/corpus/target-check.cjs` draws, by
its seed of 7, from the sweep of 18 November. The plan counted 54
definitions of apidef's, which was E9's set. The 45 here are what
apidef's `ts/test/def/` holds today with the petstore pair, and the
other descriptions E9 ran are in the corpus.

| Fixtures and generated documents | Compared | Index alone | With landings | With landings and typing |
|---|---|---|---|---|
| `test/resolve/*.tsv`, each row's own options | 118 | 118 equal | 118 equal | 118 equal |
| Generated, the defaults | 6,000 | 6,000 equal | 5,230 equal | 5,200 equal |
| Generated, `cycles: 'keep'` | 6,000 | 6,000 equal | 5,199 equal | 5,171 equal |
| Generated, `slots: 'all'`, `siblings: 'merge'`, `sharing: 'site'` | 6,000 | 6,000 equal | 5,054 equal | 5,033 equal |
| Generated, the preset | 6,000 | 6,000 equal | 6,000 equal | 6,000 equal |

No fixture row moves, so no row pins a W1 to W3 reading today. Every
generated document that moves holds a pointer that passes a site or a
region typed by a reference, or has the same rows in another order.

| Generated documents that move | The defaults | `cycles: 'keep'` | `slots: 'all'` and the rest |
|---|---|---|---|
| A pointer that passes a site | 520 | 776 | 640 |
| A pointer that passes a site, and a region typed by a reference | 43 | 35 | 52 |
| A region typed by a reference | 18 | 18 | 17 |
| The same rows in another order | 219 | 0 | 258 |
| Anything else | 0 | 0 | 0 |
| All that move | 800 | 829 | 967 |

### The eight documents

All are from APIs.guru's directory.

| Description | Version | Sites today | Laid at | References found by typing | Regions typed | Rounds | What else moves |
|---|---|---|---|---|---|---|---|
| `codat.io/accounting/2.1.0` | 3.1.0 | 873 | typing | 103 | 79 | 3 | one of the new references closes a cycle and is cut |
| `codat.io/assess/1.0` | 3.1.0 | 175 | typing | 44 | 36 | 5 | one new cut |
| `codat.io/commerce/2.1.0` | 3.1.0 | 147 | typing | 27 | 27 | 3 | |
| `codat.io/bank-feeds/2.1.0` | 3.1.0 | 53 | typing | 16 | 13 | 2 | one new cut |
| `codat.io/sync-for-commerce/1.1` | 3.1.0 | 102 | typing, landings | 4 | 6 | 3 | 3 references cut today resolve |
| `codat.io/sync-for-expenses/prealpha` | 3.1.0 | 76 | typing | 1 | 2 | 1 | |
| `codat.io/banking/2.1.0` | 3.1.0 | 75 | typing | 1 | 7 | 2 | |
| `dnd5eapi.co/0.1` | 3.0.1 | 265 | landings | 0 | 0 | 0 | 3 references cut today resolve |

With landings alone, the six that are laid at typing give today's
result exactly. The data-slot count falls by the references found: a
`$ref` map in a region typed by a reference is a site, not data.

In `codat.io/banking`, `Account` holds `identifiers: { $ref:
'#/components/schemas/Account/definitions/accountIdentifiers' }`. The
target is under `definitions`, a member the 2020-12 schema does not
have, so today it is data and whatever it references stays as written.
The index types it as a schema because a schema reference lands on it.

### The six references that pass a site

Both documents hold one shape. A schema under `paths` is a `$ref` to a
component with a stub beside it, and references inside the component
point back through that path.

```yaml
# dnd5eapi.co, under paths./api/monsters/{index}.get.responses.200.content.application/json
schema:
  $ref: '#/components/schemas/Monster'
  allOf:
    '3': { properties: { actions: { items: { properties: { damage: { items: {} } } } } } }
```

Inside `Monster`, a reference names `#/paths/…/schema/allOf/3/properties/actions/items/properties/damage/items`.
As written that location is the stub, `{}`. Read through the `$ref`, it
is the member of `Monster` the author's tool meant.

| Description | References | Today | Today, `keep` | The prototype | json-schema-ref-parser 16.0.8 |
|---|---|---|---|---|---|
| `dnd5eapi.co/0.1`, 3.0.1 | 3 | cut | the target's member | `{}` | `{}` |
| `codat.io/sync-for-commerce/1.1`, 3.1.0 | 3 | cut | `{}` | `{}` | the target's member |

Today cuts all six, because each pointer passes a site whose target is
still being folded. Under `keep` today reads the three in 3.0 through
the reference and finds the member, and reads the three in 3.1 in the
site's value, where the stub beside the `$ref` is a member. The last
column is a widely used resolver, run by `second-opinion.cjs` from a
scratch folder and not a dependency of anything here. It reads the W1
and W2 shapes below as the prototype does, and it is no more of one
mind about these six than today's resolver is.

### The shapes

`cases.cjs` prints each of these under both resolvers, with `keep` and
with the preset. Under the preset the prototype gives today's result
for all thirteen.

| Shape | Today | The prototype |
|---|---|---|
| W1. A pointer through a reference, to a member the reference has as written (3.0) | the target's member | the member as written |
| W1. The same, to a member only the target has | the target's member | the same, and the row says which site it passed through |
| W1. The same under 3.1, where the reference has other members beside it | not found | the target's member |
| W1. Through two references in turn | the target's member | the same |
| W1. Through a reference that names nothing | not found | not found |
| W2. A schema that references its own `$defs`, and a reference to it | both cut | both resolve |
| W2. A schema that references its own member (section 3, row 1) | cut | resolves |
| W2. A member of a reference whose own target is missing (section 3, row 2) | resolves | resolves |
| W2. A reference from inside a site to a member beside it | cut; under `keep`, not found | resolves |
| W3. A reference into an extension, with a reference inside the target | the inner reference as written | resolved, in round 1 |
| W3. A reference into `definitions` in a 3.1 schema | the inner reference as written | resolved, in round 1 |
| W3. A 3.0 component whose name the pattern refuses | the inner reference as written | resolved, in round 1 |
| A loop of pointers, each through the other | both cut; under `keep` one cut and one not found | both cut, under `keep` too |

### The rounds

Each case is run as written, with every map's members reversed, and
under 500 seeded shuffles of every map's members. A list keeps its
order, which is part of what it says.

| Case | Orders | Answers, sites in document order | Answers, sites in pointer order | Rounds | Regions typed | Conflicts |
|---|---|---|---|---|---|---|
| R1. Typing reveals a second reference to the same target, of the same type | 502 | 1 | 1 | 2 | 3 | 0 |
| R2. Typing reveals a second reference to the same target, of another type | 502 | 1 | 1 | 1 | 2 | 1 |
| R3. An `$id` inside a region typed only by reference | 502 | 1 | 1 | 1 | 1 | 0 |
| R4. A region that references itself | 502 | 1 | 1 | 2 | 2 | 0 |
| R5. A chain of 40 regions, each typed by a reference in the one before | 502 | 1 | 1 | 41 | 41 | 0 |
| R6. Two references of one round that give one target different types | 502 | 2 | 1 | 1 | 1 | 1 |

In R3 the two references by the region's `$id`, one to a member and one
to an anchor, name another document in round 0 and resolve once the
region is typed and its identifiers join the index. In R2 the reference
of the earlier round types the target and the later one is the
conflict, whatever the order of the members. In R6 both are of round 0,
so the first in the document types the target: 257 of the 502 orders
type it as a response and 245 as a schema.

In the corpus the rounds are short: 5,161 documents end in round 0, one
in round 1, two in round 2, three in round 3 and one in round 5.

### What the index found in the corpus

| | Sites | Documents |
|---|---|---|
| Sites, of 6,723,394 maps | 1,139,653 | 5,168 |
| Found in round 0 | 1,139,457 | |
| Found in rounds 1 to 4 | 167, 24, 3, 2 | 7 |
| Naming another document | 29,595 | |
| Landing found | 1,110,054 | 4,749 |
| Landing not found | 4 | 1 |
| A loop of pointers | 0 | 0 |
| Passing a site | 6 | 2 |
| Needing the lenient rule: through a site that lacks the step | 0 | 0 |
| Landing in data the model names | 0 | 0 |
| Landing on a type the reference does not expect | 8 | 4 |

The four landings not found are in one description of the OpenAPI
Initiative's own failing tests, which has no `components`. The eight
conflicts are what item 4 of T3 will report:

| Description | The reference expects | It lands on |
|---|---|---|
| `swaggerhub.com/1.0.66`, 2 references | a response | a schema, under `definitions` |
| `rumble.run/2.15.0`, 2 references | a schema | a response, under `components/responses` |
| `rev.ai/v1`, 3 references | a schema | a response |
| `enode.io/1.3.10`, 1 reference | a schema | a parameter |

### The preset

`tools/apidef-preset.cjs`, with the prototype in place of the package,
against apidef's own resolver at 3b24341:

| Set | Documents | Equal |
|---|---|---|
| The hand shapes | 167 | 167 |
| Generated | 6,000 | 6,000 |
| The corpus | 8,977, 13 of them not read by `parse` | 8,964 |
| `test/resolve/apidef.tsv` | 24 rows | 24 |
| `test/resolve/apidef-extra.tsv` | 22 rows | 22 |

That is no difference in 15,177 compared, which is what the tool gives
for the package itself. The rows of `apidef-extra.tsv` are the shapes of
section 3's table, each held to apidef's resolver.

### The cost

Over every document of the run, today's `resolve` takes 56.3 seconds
in sum. The prototype takes 66.0 with the index alone and 59.7 with
landings and typing, 6% to 17% more. Under `keep` it takes 68.0 where
today takes 54.7, 24% more. The parses take 272 seconds, so resolving is
the smaller part either way. The index is not written for speed: it
keys every fact by pointer text and surveys the whole document again in
each round.

## What it means for the rest of T3

- **Decision 27.** The corpus cannot tell the lenient reading from the
  strict one: no reference needs the lenient step. What it can tell is
  the reading as written from today's reading through a reference, in
  six references, and there it gives an empty schema where the author
  meant a member of the target. The plan's rule stands as the default
  here. Whether a pointer that lands inside a site should be reported is
  the maintainer's, and the index has the fact for each row.
- **Decision 28.** The rounds are as the plan has them. The one thing to
  settle is the order of the sites within a round. In document order,
  two references of one round that disagree about a target's type are
  decided by which is written first. In the order of their pointers they
  are decided the same way however the document is written.
- **A cut becomes not found.** Where a pointer passes a site that is in
  a cycle or still being folded, and names nothing there, it is cut
  today. On landings it is not found, since nothing is there to cut.
  Under `keep` a loop of pointers is two cuts, where today it is one cut
  and one not found. Rows of `unresolved` and `cuts` move for those
  shapes only.
- **The order of report rows.** The rows are in the order the fold first
  meets each site. Read as written, the fold no longer meets a site that
  a pointer only passes, so a few rows change places. Of the 6,000
  generated documents, 219 have the same rows in another order under the
  defaults. No document of the corpus is among them. Item 2 either keeps
  the order, by having the walk still recognise a site it passes, or
  pins the new one.
- **The sweep.** Item 2 makes the sweep count a site that is reported
  resolved and holds its map as written. The seven codat.io descriptions
  are where it will count them, 196 references in all.
- **`expr`.** The change is small, as the plan has it. `expr`'s own rules
  ask for it in its other implementations in the same change, which the
  size in section 7 should allow for.

## What it does not show

- The `connections` report still reads the resolved tree, and
  `sharing: 'inline-once'` still keys the first site by the target as
  named. Rebuilding both on landings is item 2's.
- W4 to W6 and W10, dialects, and several documents are not in the
  prototype.
- A duplicate `$id` or anchor is decided as today, by the last in the
  document. Under reordering that is two answers, and it is not a case
  the plan names.
- An `$id` on a region that is typed after a region inside it changes the
  base of references already located. No case here has that shape.
- The index keys its facts by pointer text, which is simple and not
  fast. The cost above is an upper bound on what item 2 need pay.

## To run it again

The prototype's resolver is made from the compiled resolver of the
commit it was measured at, a353a71. Since then `resolve` has been
rebuilt on the index, as item 2 of T3, so the seven replacements no
longer match this checkout's build, and `resolver.cjs` refuses to load
against it, as it is meant to. Build that commit, and name its `ts/dist`
with `OPENAPI_DIST_DIR` and its `ts/dist/openapi.js` with
`OPENAPI_DIST`.

```sh
# the expr build with site.written
git clone https://github.com/tabnas/expr && cd expr && git checkout 72962b0
git apply <this repository>/docs/design/prototype/e12-site-index/expr-written.diff
(cd ts && npm install && npm test)
export EXPR_DIST=$PWD/ts/dist/expr.js

# from this repository's root, after a sweep (tools/corpus/) and `npm run build` in ts/
cd docs/design/prototype/e12-site-index
node run.cjs --out <a scratch file> --apidef <apidef checkout>   # about three minutes with 4 workers
node report.cjs <that file>
node fixtures.cjs
node generated.cjs
node cases.cjs
REF_PARSER=<a folder with @apidevtools/json-schema-ref-parser installed> node second-opinion.cjs
cd ../../../.. && OPENAPI_DIST=$PWD/docs/design/prototype/e12-site-index/as-package.cjs \
  node tools/apidef-preset.cjs <apidef checkout> --ref 3b24341 --corpus .corpus/src \
  --rows test/resolve/apidef.tsv test/resolve/apidef-extra.tsv
```
