# Plan: finishing `@tabnas/openapi` in TypeScript

A plan to take the TypeScript package from where Phase 2 of the earlier
plan left it to finished, against three goals the maintainer set on 12
November 2026:

1. it fully parses and handles every valid OpenAPI description;
2. it fully replaces the custom parsing in `voxgig/apidef`;
3. it meets the needs of the `rjrodger/aless` viewer, so that a user can
   expand and collapse a referenced section, such as a component schema.

Status: a proposal for the maintainer, 12 November 2026, second
revision. The first was reviewed by an independent reader who was asked
to break it; section 11 lists what that changed. This plan replaces the
order of work in [`implementation-plan.md`](implementation-plan.md)
(its Phases 3 to 7 and its section 9) and three of its decisions (11,
13, and the release coming last); that document stays the record of the
design through Phase 2. Porting is deferred until the TypeScript version
is finished, by the maintainer's direction, and is outside this plan.

The plan rests on four measurements taken for it, each filed under
[`prototype/`](prototype/) with its scripts and its report as written: a
sweep of 8,986 real documents (E7), an audit against the specification
texts with probes (E8), apidef's own suite run against this package
(E9), and a reading of aless's source for what its viewer needs (E10).
Every point marked **Decision** is the maintainer's; the plan names the
default it would take. Every dependency change is a decision, as this
repository's `CLAUDE.md` requires, and nothing below is an instruction
to make one.

## In brief

- **Reading is where real documents fail.** Of 5,182 real descriptions,
  19 valid ones are refused and about 231 parse to a tree that differs
  from a reference parser's. Nearly all of it is in `@tabnas/yaml`.
- **Resolving within one document is sound on real documents**, and
  silently wrong in a handful of shapes the specification allows. 789
  descriptions (15%) name other documents, which nothing resolves yet.
- **apidef's resolver can be deleted today**: with this package in its
  place, 2,473 of its 2,475 tests pass and its models are byte-identical.
  What stops it is packaging, not code.
- **aless needs a table, not a resolved tree**: where each reference
  lands in the document as written. That table is also what `resolve`
  itself should be built on, so section 3 proposes one.
- **Two of the three goals cannot be reached in full by TypeScript
  alone**, and section 1 says how far this plan takes each.

## Terms

| Term | Meaning here |
|---|---|
| site | a map that holds a `$ref` where the description's version reads it as a reference |
| landing | the location, in the document as written, that a reference names |
| chain | a reference whose landing is itself a site |
| cut | a reference left as written because following it would close a cycle |
| the fold | `fold` from `@tabnas/expr`, the walk `resolve` is built on |
| the preset | `resolve(raw, { compat: 'apidef' })`, the options that reproduce apidef's resolver |
| base grammars | `@tabnas/json`, `@tabnas/jsonic` and `@tabnas/yaml`, which this package configures and adds no grammar to |
| fast path | `JSON.parse` for JSON text; the grammar path is the base grammars reading the same text |
| core schema | YAML 1.2's rules for which plain scalars are booleans, numbers and null |
| the ledger | the committed list of corpus documents that fail, each with its class |

## 1. What finished means

| | Goal | Finished, in this plan, when | Measured by |
|---|---|---|---|
| G1 | Every valid description is read and handled | (a) Every valid document in the corpus parses to the tree the reference parsers give. (b) Every reference is resolved to what the specification says it names, or reported with a reason. (c) A description in several documents resolves, given its documents or a loader. (d) Input built to exhaust the reader ends in a coded refusal. (e) The reading rules the specification states for an operation are applied, to the scope of Decision 19 | the corpus sweep as a gate; a fixture for each defect of section 2.2; the multi-document corpora |
| G2 | apidef's TypeScript package has no parsing of its own | `ts/src/parse.ts` in apidef holds only apidef's policy; apidef's suite is green against the published package; its models are byte-identical on its 43 definitions, the 11 OpenAPI Initiative examples and the GitHub description; the definition it hands to other tools is unchanged | apidef's suite (2,475 tests) and the model comparison of E9 |
| G3 | The reader can serve a viewer that opens references in place | The reference map of section 3 gives every item of section 2.4, each pinned by a fixture; a viewer-shaped script opens and closes every reference of a large description from the map alone; the cost is measured | `test/resolve/map-*.tsv`; the viewer check of T3 |

Two limits follow from the direction that TypeScript comes first, and
the maintainer should read them as gaps against the goals as worded:

- **G2 stops at apidef's TypeScript package.** apidef has a second
  implementation of its parser, and its own rules hold the two to the
  same fixtures. That one cannot move until this package is ported. So
  until then every apidef step taken here must leave apidef's output
  exactly as it is, and "fully replaces" is complete only afterwards.
- **G3 stops at the reader.** aless cannot load a TypeScript package, so
  no user opens a reference in aless under this plan. What the plan can
  do is build what the viewer needs, prove it with a script that behaves
  as a viewer would, and pin it with fixtures that porting then carries.
  The needs themselves were read from aless's source, not from running
  it, so they should be confirmed from aless's side (Decision 16).

In (a), the ledger may keep two kinds of row only: a document where the
reference parser is the one in error, and a reading the maintainer has
decided. Every class in section 2.1 reaches zero.

Non-goals, unchanged from the earlier plan: validating an instance
against a schema, validating a description against the OpenAPI schema,
generating code, making HTTP requests, and evaluating `$dynamicRef`
dynamically. One is added: writing a description back as YAML with its
comments, anchors and layout (Decision 19).

## 2. Where it stands

### 2.1 The corpus baseline (E7)

8,986 distinct documents, 924 MB: the whole APIs.guru directory (4,138
descriptions), the OpenAPI Initiative's test and example documents, the
multi-file sources of DigitalOcean (3,636 files) and Redocly's starter,
GitHub's and Stripe's descriptions, and a sample of Azure's (929 files).
5,182 declare a version this package knows; the rest are fragments of
multi-file descriptions and a few drafts. The reference parsers
(`JSON.parse`, and the npm `yaml` package under the core schema) accept
every one. The sweep ran under Node 22 with a 4 GB limit per document;
`engines` names Node 24.

| Measure | Result |
|---|---|
| Descriptions that parse | 5,162 of 5,182 |
| Refused though valid | 19 |
| Out of memory | 1 under the sweep's 4 GB limit; under Node's default limit both Microsoft Graph descriptions (26 MB and 58 MB) |
| JSON documents equal to `JSON.parse` | 907 of 907 |
| YAML documents whose tree differs from the reference | 233, of which 2 are the reference parser's error |
| A repeated member name | none in any document |
| `resolve` errors thrown | 0 in 5,162 descriptions |
| Reference sites | 1,190,999: 1,159,428 resolved, 1,972 cut, 29,599 left as written |
| Left as written | 29,595 name another document (789 descriptions, 15%); 4 name nothing, correctly |
| Wrong landings | 0 in a check of 122,423 references across 600 documents |

Reading is where real documents fail, and nearly all of it is in
`@tabnas/yaml` or in jsonic defaults it leaves on. The classes overlap,
so the counts below do not sum:

| Class | Documents | What happens |
|---|---|---|
| YAML 1.1 words (`on`, `off`, `yes`, `no`) | 166 | read as booleans; almost all are `enum` entries, so a string enum becomes a boolean one |
| Numbers outside the core schema (`1_000`, `01009_01`) | 45 | read as other numbers |
| `//` and `/* */` inside a plain scalar | 44 | 32 documents lose the value to `null` (`url: //api.example.com`); 12 are refused |
| Four layout defects: compact nested lists (6), a list at its key's indent with an empty entry (2), a scalar on the line after its key (6), `>+` with a trailing blank line (1) | 15 | a wrong tree; GitHub's own YAML description is one |
| Three refusals: an indented root mapping (3), a digit-led key with colons and a block value (3), `.042 mg/L` (1) | 7 | refused; three are official OpenAPI Initiative examples |

192 distinct documents have a YAML 1.1 word or such a number. Above
100 KB the package parses YAML in about 0.83 of the reference parser's
time, at 85 to 160 bytes of memory per byte of YAML, where the reference
parser needed about 36 on the largest document.

Resolution within one document is sound on real documents. Its limits
are the 789 descriptions that name other documents, and sources such as
DigitalOcean's that put a `$ref` where the specification allows none:
917 of them, which `resolve` reads as references only under its
`slots: 'all'` option.

### 2.2 Defects the audit found (E8)

The object model has every fixed field of 2.0, 3.0.4, 3.1.2 and 3.2.0,
the 3.2 additions included. The audit's probes found the defects below.
`prototype/e8-spec-probes/verify.cjs` re-runs W1 to W4 and W8, and the
review re-ran W5 and W6 and added the recursive alias of W9; W7 and the
rest of W9 stand on the audit's probes alone.

| | Defect | Effect |
|---|---|---|
| W1 | A reference whose pointer passes through another reference reads that reference's resolved value, where RFC 6901 reads the document | the wrong member, silently |
| W2 | A schema that references its own `$defs`, the usual shape of a bundled schema | cut as a cycle, with every reference to it |
| W3 | A target is typed by its own position only. A reference into an extension, into `definitions`, `dependencies`, `additionalItems` or array-form `items` in a 3.1 schema, or into a 3.0 component whose name the pattern refuses | the target comes back with the references inside it as written, reported as resolved |
| W4 | A schema that declares draft-07, 2019-09, `…/2020-12/schema#` or a custom dialect | every reference under it is left as written |
| W5 | URIs that differ in the case of scheme or host, a default port, or a percent-encoded letter | a same-document reference read as another document |
| W6 | Nesting and reference hops past 1,000 | raised as `expr`'s `fold_depth`, not one of this package's codes |
| W7 | YAML aliases are copied without limit | 408 bytes take 268 MB; 467 bytes kill the process |
| W8 | Integers past 2^53, such as int64 limits | lose precision, on both paths |
| W9 | CR-only line breaks; JSON text after a blank line on the grammar path; a recursive alias (`a: &x {b: *x}` reads `b` as `null`) | a valid document refused, or read wrongly |

Missing rather than wrong: resolution across documents; the implicit
discriminator mapping; a check that a target has the type its reference
expects; `$recursiveRef`; bundling; and the reading rules for an
operation (inherited parameters, servers and security). Two refusals
are choices, not defects, and Decision 30 takes them: a trailing empty
YAML document, and a byte-order mark under `strict`.

### 2.3 What apidef needs (E9)

With apidef's resolver deleted and the preset in its place, 2,473 of
apidef's 2,475 tests pass, one is skipped as before, and one fails: a
path written twice, which apidef's base grammar merges and this package
reads as its last value. apidef's guide and model are byte-identical on
all 54 definitions and on the GitHub description. Stripe's description
fails in apidef before and after, in a later stage, so it measures
nothing here.

Each remaining hand-written step needs something before it can go:

| apidef step | Needs |
|---|---|
| the repeated-key merge | a `parse` option (Decision 22) |
| `validateSource` | `openapi_root` to say `empty` for white space and comments alone, as it does for no text |
| `validateAliases` and `yamlalias.ts` | an alias budget; without the guard apidef's suite runs out of memory |
| `wellFormed`, which reads a lone surrogate as U+FFFD | the same as a function here (Decision 35) |
| `normalizePathKeys` | a yaml repair: an explicit key with a lone-surrogate escape keeps its quotes |
| `dropIgnoredHeaders` | a report of the header parameters the specification says to ignore |
| its cycle markers | nothing here: `cycles: 'cut'` replaces them, but that changes apidef's output, so it waits (section 1) |

Four things stand in the way that are not code in this repository:

- `@tabnas/openapi` is not on npm.
- It declares `@tabnas/expr` as `>=0`, where `fold` first shipped in
  0.5.20.
- apidef's install takes `@tabnas/expr` 0.5.10, `@tabnas/parser` 0.12.2
  and `@tabnas/jsonic` 0.7.1 from aontu, whose latest release (0.76.3)
  pins them exactly. `resolve` fails on that `expr`, and an attempt to
  move `@tabnas/parser` forward in apidef failed on a peer conflict.
- This repository's release workflows are stamped by admin and still
  name the template it was made from; `AGENTS.md` says not to dispatch
  one.

apidef's later stages write on the parsed tree and compare objects by
identity, so the per-site copies of `sharing: 'site'` and the `x-ref`
member are a contract. apidef also hands the parsed definition to other
tools, so its shape is a contract beyond apidef's own suite.

### 2.4 What aless needs (E10)

aless builds one tree per file, eagerly, and keys folds, search, copied
paths and reloads by a node's path in that tree. E10's reading is that
it is best served by a table that points back into the tree as written,
so that an opened reference shows the target's own nodes. The package's
`provenance` report is most of that table. Missing:

| | Need | Today |
|---|---|---|
| A1 | the landing of a reference, and the end of a chain | `target` is the pointer as written, which may not exist in the tree |
| A2 | what each member beside `$ref` does: ignored, overrides, applied beside the target, merged | visible only through the combined value |
| A3 | for a reference into another document: the resolved URI, the fragment, and whether it is a local file | `external`, nothing more |
| A4 | whether opening a reference leads back to it, whatever order the document is walked in | `cut` marks one edge, in walk order |
| A5 | which references land on a location | derivable, wrong where a pointer passes through a reference |
| A6 | the table alone, with no resolved tree built | `resolve` builds the tree: about 0.4 s and 30 MB more on the GitHub description, where a bare walk is about 0.1 s |
| A7 | how large a target is when written out in full, so that "unfold everything" can refuse | not available; 5.5 times the document on GitHub |
| A8 | the same answers on a tree aless parsed itself | true for `resolve`; `parse` differs from the base grammars on a repeated key and on a stream |

One cost is this repository's to remove: `parse` keeps one parser for
every call, and after a grammar parse of the GitHub description that
parser holds about 840 MB until it is dropped.

## 3. The design change: one reference map

Today `resolve` works out what a reference names while it builds the
resolved tree, inside the fold. Three consumers need that answer without
the tree, or before it: a viewer, which shows the document as written
and opens a reference in place; the loader of T4, which must know which
other documents a description names before anything is resolved; and
anything that counts references. Three of the defects above (W1, W2,
W3) come from deciding inside the fold.

So the plan adds one pass before the fold. `references(tree, options)`
is a working name:

```ts
const map = references(tree, { version: 'auto', retrievalUri, slots: 'spec' })
// map.sites: one row per site, in document order
// {
//   at,              // RFC 6901 pointer of the site, in the tree as written
//   ref,             // the reference as written
//   kind, type,      // as `provenance` has them today
//   uri, fragment,   // the reference resolved against its base; `local` for a file
//   landing,         // the location it names in the tree as written, or null
//   via,             // the sites its pointer passed through to get there
//   final,           // the landing at the end of a chain
//   why,             // why it has no landing: not-found, external, and so on
//   siblings,        // [{ name, role }]: ignored | overrides | applied | merged | conflict
//   cyclic, loop,    // opening it leads back to it; a loop of references alone
//   size,            // values in the target written out in full; null when cyclic
// }
// map.uses(location)        the sites that land on a location, chains included
// map.land(fragment, type)  where a reference from another document lands here
```

The map takes a tree, not text, so it holds for a tree a viewer parsed
itself. It builds no resolved value, and its rows are plain data.

**What the map owns, and what stays the fold's.** The map owns
everything that is a fact about the document: which maps are sites,
their types and base URIs, the identifier index, each landing, each
sibling's role, and whether a site is on a cycle. `resolve`'s
`recognise` and `inherit` callbacks become look-ups in it, so there is
one statement of each fact. The fold keeps what depends on the shape
being built: the values, the sharing, and which edge of a cycle is cut,
which follows the walk. So `provenance`, `unresolved` and `cuts` stay
the fold's reports, in walk order as `test/AGENTS.md` pins them, and a
test ties the two together: every cut site is `cyclic` in the map, and
every site with no landing is `unresolved`.

**Pointers** (Decision 23). A pointer is read on the document as
written. Where a step is missing at a site, the walk goes on in what
that site names, and the row's `via` says so. This repairs W1 and W2.
It is more lenient than RFC 6901, which would find nothing there, and
E8 recommended the strict reading; the lenient one keeps what resolves
today.

**The preset** (Decision 29). apidef reads a pointer differently: it
follows a reference at every step before reading the next member, and
gives up when a reference on the way names nothing. The review found
the shapes below, where that reading and the rule above part; in one
of them the preset already resolves what apidef leaves as written.
Since apidef's output must not move (section 1), the preset takes
apidef's reading exactly. That also ends three things it resolves today and apidef does
not: anchors, a pointer under an `$id`, and a percent-encoded pointer.

| Shape | apidef | The preset today | Under the rule above |
|---|---|---|---|
| a schema that references its own member: `A: { $ref: '#/…/A/properties/p', properties: { p } }` | as written | as written | resolves |
| a member of a reference whose own target is missing, or in another document | as written | resolves | resolves |
| a bundled schema that references its own `$defs`, and a reference to it | as written | as written | resolves |

`prototype/e9-apidef-swap/preset-shapes.cjs` runs these against apidef's
own resolver.

**Typing an untyped target** (Decision 24). Appendix G of the
specification leaves it to the implementation what a reference means
when its target sits where no object is defined. The plan chooses:

1. Round 0 finds the sites the object model types by position, in
   document order.
2. Each round takes the landings of its sites, in the order of those
   sites. A landing the model gives no state at all (inside an
   extension, or a member it does not know) takes its site's type. A
   landing the model does type, as data or as another object, keeps it,
   and a mismatch is reported as a conflict. Nothing is typed twice.
3. Newly typed regions are searched for sites and for `$id` and anchor
   declarations, which join the index; those sites form the next round.

The rounds end when one finds nothing new. Across documents the entry
document comes first, then the others in the order they were first
named.

**What changes outside the map.** `expr` gains a way to fold a
location as written, without reading through the sites above it; that
is a small change, and without it W1 and W2 cannot be repaired.
`cycles: 'keep'` and the `connections` report both read through the
resolved tree today and are rebuilt on landings. `size` is exact for a
target that is on no cycle, and `null` for one that is.

## 4. Work, in order

Sizes are relative, as in the earlier plan: S is a day or two of focused
work, M a week, L several weeks. Each phase is one or more pull
requests, each ready for review.

### T0: gates (S to M)

Nothing below can be called done without these.

1. **The corpus sweep as a tool.** `tools/corpus/`, from the E7 scripts:
   sources pinned by repository and commit, one process per document, a
   progress line every 15 seconds, results as resumable JSON lines, the
   comparison with the reference parsers, the analysis. It runs by hand
   under the Node version `engines` names, not in `npm test`: it needs
   the network and about 26 minutes. **Decision 28:** the reference YAML
   parser as a development dependency of that tool.
2. **The ledger.** `test/corpus/ledger.tsv`: one row per document that
   fails, with its class. Today it holds the rows of section 2.1. A
   number that moves is a repair or a regression, and the ledger moves
   in the same commit.
3. **The consumer gate.** A script that applies E9's first diff to a
   checkout of apidef at the commit E9 used (3058271), runs apidef's
   suite and model comparison against this working tree, and prints
   progress as the sweep does. When apidef moves, the diff is refreshed;
   once apidef has taken the swap, the gate runs apidef as it is.
4. **Fixture homes.** `test/spec/` is read by every suite in the
   repository. Behaviour only the TypeScript package has goes in
   `test/resolve/`, `test/model/`, `test/docs/` and a new
   `test/pending/`, each with a TypeScript runner; section 5 has the
   rule.

Acceptance: the sweep reproduces section 2.1 from a clean checkout
under Node 24; the consumer gate reports 2,473 passing.

### T1: the first release, and apidef's swap (S here, M in apidef)

The swap works today, so it does not wait for the phases below.

1. **Here:** `duplicates: 'last' | 'merge'` on `parse`, so that the one
   failing apidef test passes; the peer ranges state what the package
   calls (Decision 27); the preset takes apidef's pointer reading
   (section 3), pinned by new rows in `test/resolve/apidef-extra.tsv`,
   each checked against apidef's own resolver; the three passages that
   describe the preset say what it does, and `AGENTS.md`'s dependency
   passage, which still calls `expr`'s tree layer unreleased, is brought
   up to date with the peer ranges.
2. **The first npm release** (Decisions 17 and 34). The earlier plan already
   needs the maintainer to make the first publish by hand, since the
   registry does not know the package. Taking that step now, from `main`
   after item 1, is enough for apidef; the workflow releases wait for
   admin's restamp as `AGENTS.md` says.
3. **In apidef** (its maintainer's changes; this plan lists them):
   repair the two faults in its error wrapping that E9 found; then swap
   `parse` and `resolve` in, keeping every other step and its cycle
   markers, so that its output does not move. It needs `@tabnas/expr`
   0.5.20 or later where `resolve` can find it, which today means a
   change to how aontu's pins reach its install.

Acceptance: apidef's suite fully green on the published package with
its resolver deleted; models byte-identical; the consumer gate switched
to run apidef as it is.

### T2: reading (M here, M to L in `@tabnas/yaml`)

Every valid text gives the right tree, and a hostile one gives a code.

1. **In `@tabnas/yaml`** (section 7 lists each, and Decision 18 says
   how they are asked for). Repairs: comment syntax inside YAML; the
   four layout defects and three refusals of section 2.1; the explicit
   key that keeps its quotes; CR-only line breaks; JSON after a blank
   line; a recursive alias; tab indentation refused. Options: plain
   scalars and numbers by the core schema; a budget on alias expansion
   with a coded error. Then memory per byte of input.
2. **Here, options and codes on `parse`:**
   - `scalars: 'core'`, passed to yaml (Decision 20);
   - `aliasBudget`, default the larger of 1 MB and ten times the input,
     raising `openapi_alias_budget` (Decision 32);
   - `openapi_root` reports `empty` for white space and comments alone;
   - `wellFormed(tree)`, a function applied after `parse`, since raw
     mode never rewrites a value the grammar returned (Decision 35);
   - bytes as input, decoded by their byte-order mark, which the loader
     of T4 needs;
   - the leniencies of Decision 30.
3. **Numbers past 2^53** (Decision 21): the tree stays plain, and a
   `lossy` report lists each such number with its source text.
4. **Memory.** Release what the shared parser holds after a parse.
   Then, with yaml and the engine, the target: both Microsoft Graph
   descriptions parse in Node's default heap. Until they do, a document
   past a stated size is refused with a code before the process dies,
   and the ledger carries both as a limit, not as a pass.

Acceptance: in the sweep, no valid description refused and no tree
difference outside the two kinds section 1 allows; the 467-byte alias
document is refused with a code in under a second; apidef can drop
`validateSource`, `validateAliases`, `wellFormed` and
`normalizePathKeys` with its suite green.

### T3: the reference map, and `resolve` on it (L)

1. **Prototype E11 first**, with its recorded result, before any source
   changes. It must show:
   - the map gives the landing today's resolver gives for every site of
     Stripe, GitHub, apidef's 54 definitions and the 600-document check
     set, except in the W1 to W3 shapes, each listed;
   - the typing rounds end, and give one answer when members are
     reordered, on a case where typing reveals a second reference to the
     same target and on an `$id` inside a region typed only by
     reference;
   - the preset matches apidef's own resolver on the shapes of section
     3's table;
   - every one of Stripe's 125 cuts is `cyclic` in the map;
   - `cycles: 'keep'` built on landings gives today's graph;
   - the map and its sizes for the GitHub description cost under a
     quarter of a second from a parsed tree;
   - the `expr` change alone leaves `expr`'s own fixtures green;
   - how many references in the corpus need the lenient pointer rule,
     which is the evidence for Decision 23.
2. **The map** of section 3, with a step budget so that a caller can
   bound or cancel it.
3. **`resolve` on the map.** W1 to W6 repaired; `fold_depth` surfaced
   as `openapi_depth`. Dialects by Decision 25: draft-04, draft-06,
   draft-07 and 2019-09 read by their own rules (`id`, `definitions`,
   `$recursiveRef`), identifiers normalised, an unknown dialect read as
   2020-12 and reported. URIs normalised before comparison. The object
   model follows the texts of Decision 33.
4. **Reports the audit found missing**: the implicit discriminator
   mapping; a target whose type is not the one its reference expects;
   the URL-valued fields (`externalValue`, `externalDocs.url` and the
   like) as absolute URIs, never loaded. `provenance` rows gain the
   sibling roles.
5. **The viewer check.** A script that plays a viewer: from the tree as
   written and the map alone, never `resolve`, it opens every reference
   of the GitHub and Stripe descriptions level by level, closes them,
   opens everything under a bound, and confirms that every landing
   exists, that the walk ends where `cyclic` says it must, and that what
   it wrote out equals `size`. This is the nearest thing to aless that
   TypeScript can run.
6. **Fixtures**: `test/resolve/map-*.tsv` for every item of section
   2.4; a row for every probe of E8; a reload fixture (a member inserted
   above a site moves the table by location only).

Acceptance: every fixture green; the consumer gate unchanged; the
Stripe and GitHub censuses in `AGENTS.md` unchanged, or each change
explained; the viewer check passes; in the sweep, no reference
`not-found` whose target exists.

### T4: several documents (L)

1. **Documents given up front, or loaded.** `documents`, a table from
   URI to text, bytes or tree, and an optional `load`. Every document
   provided is parsed and indexed before any reference is judged, as
   the specification requires. One index of `$self`, `$id` and anchors
   spans them, so a reference to an identifier is met by whichever
   document declares it. URIs are normalised, so one document reached
   by two spellings is one document.
2. **The map across documents.** A landing may be in another document.
   Discovery is the map's own output: the documents a map names are
   loaded, mapped, and so on, within the budgets. `resolveAll` is the
   asynchronous form; `resolve` stays synchronous, given the table.
3. **Fragment documents.** A file whose root is neither a description
   nor a schema, such as a map of schemas, is typed by the reference
   that reaches into it (section 3). A schema document with no `$schema`
   takes the OpenAPI dialect. A document of another version than the
   entry is read by its own version.
4. **Loaders** (Decision 26). None by default. Offered, each opt-in: a
   file loader confined to a root directory, symbolic links included,
   and an HTTP loader with an allow-list of schemes and hosts that is
   checked again after a redirect, refuses private addresses, and takes
   a byte cap, a timeout, a cancel signal and a cache. Credentials never
   cross an origin. A loaded document's format comes from its media type
   or its name, and its YAML is under the alias budget.
5. **Implicit connections across documents**, as the specification
   recommends: components and tags from the entry document,
   `operationId` from all, security names before URIs.
6. **Fixtures** in `test/docs/<case>/`, each a small set of files with
   an entry and a retrieval URI.

Acceptance: the specification's multi-document examples resolve; the
Azure sample and Redocly's starter resolve from their roots with nothing
left as written that exists on disk, and DigitalOcean's source does
under `slots: 'all'`; a reference outside the allow-list is refused
with `openapi_load`; the walk stops at its budgets.

### T5: beyond references (M each, to the scope of Decision 19)

1. **The operation as the specification reads it.** An opt-in view of
   each operation: its parameters after the Path Item's are inherited
   and overridden by name and location; its servers and security after
   inheritance; for 2.0, its `consumes`, `produces` and `schemes`. With
   it, the `ignored` report: the header parameters named `Accept`,
   `Content-Type` and `Authorization`, which the specification says to
   ignore. apidef can then drop `dropIgnoredHeaders`. Path templates
   that differ only in a parameter's name are reported.
2. **The embedded languages**, the earlier plan's Phase 4 unchanged:
   `readExpression`, `readTemplate`, their static checks in
   `connections`, and `evaluateExpression`.
3. **Bundling.** Several documents written as one: outside references
   rewritten to components or `$defs`, names kept apart, `$id`
   resources kept. JSON out.

### T6: finish (S to M)

1. The four documentation pages cover everything above, and the prose
   gate is green.
2. The descriptor and the release workflows are restamped by admin, and
   releases move to the workflow.
3. The conformance statement: which corpora, how many documents, how
   many agree, and the ledger.
4. The hand-off: every behaviour of T1 to T5 is pinned by a fixture
   that carries no TypeScript in it, and the options of section 5 are
   listed with the default each should become. That list is the brief
   for porting.

## 5. Keeping the repository consistent meanwhile

Continuous integration here runs every suite the repository holds, and
`test/spec/` holds what all of them agree on. Three rules keep that
true while the TypeScript package moves ahead. Together they are
Decision 31.

- **New behaviour is an option or a new function**, pinned in the
  TypeScript-only folders of T0. No row is added to `test/spec/`.
- **No default changes where a `test/spec/` row pins it.** Two readings
  this plan wants would change such rows: plain scalars by the core
  schema, and a trailing empty document accepted. Both are options
  until porting starts. One name, `reading: 'spec'`, turns on every
  option that gives the specification's reading, so that the later
  change of defaults is one line here and one coordinated change to the
  shared rows.
- **An upstream repair follows the rule `test/AGENTS.md` already has.**
  A shared row that pins a base-grammar defect turns red when the repair
  arrives. The pull request that answers it here updates the row and
  moves every suite to the release that carries the repair.

The other course is to change the TypeScript defaults now and record
each difference in `DIVERGENCE.md`, which needs each one measured in
every suite and the other suites' tests touched. The plan does not take
it.

## 6. Decisions for the maintainer

Numbered from 16, after the earlier plan's fifteen.

| | Decision | Default the plan takes | Needed by |
|---|---|---|---|
| 16 | G2 and G3 end, in this plan, where section 1 says. aless's needs are confirmed from aless's side, and its own choices recorded there | accept; E10 lists ten choices for aless with a recommendation each, and the reader needs two settled: an opened reference shows its target as written, with roles, never a merged value; nothing loads another file unless the user asks | now |
| 17 | The first npm publish, by hand, before porting. It replaces the earlier plan's release coming last, and `AGENTS.md`'s release section changes to say so | yes, once T1's first item is in | T1 |
| 18 | Which changes to ask of `@tabnas/yaml`, `@tabnas/expr` and the engine, and in what order. Those repositories' own rules govern how each lands | the rows of section 7, in that order, each its own instruction | T2, T3 |
| 19 | What "handle" covers beyond references | the operation view, the embedded languages and bundling to JSON are in; writing YAML back with its layout is out | T5 |
| 20 | Plain scalars in YAML. 3.2 recommends YAML 1.2 and names no schema; 3.0 and 3.1 point at YAML's JSON schema for tags | `scalars: 'core'` as an option now, the default when porting starts; merge keys stay | T2 |
| 21 | Integers past 2^53 | the tree unchanged and a `lossy` report with the source text; no BigInt in the tree | T2 |
| 22 | A repeated member name. No document of the corpus has one; one apidef test does | `duplicates: 'merge'` added and used by apidef; last wins stays the default. This replaces the earlier Decision 11, which put the merge in the preset | T1 |
| 23 | A pointer that passes through a reference | lenient: the document first, then through the reference, reported in `via`; `strict` raises it. E8 recommended the strict reading; E11 counts what each would cost | T3 |
| 24 | A target the object model does not type | the rounds of section 3; a conflict reported | T3 |
| 25 | Schema dialects. This replaces the earlier Decision 13 | draft-04, 06, 07 and 2019-09 read; an unknown dialect read as 2020-12 and reported | T3 |
| 26 | Loaders | a confined file loader and an allow-listed HTTP loader, both opt-in; nothing loads by default | T4 |
| 27 | Peer ranges of this package, as a standing rule | each floor at the first release that has what the package calls: `@tabnas/expr` 0.5.20 for `fold`, and so on as T2 and T3 use new upstream features | T1 |
| 28 | A reference YAML parser for the corpus tool | the npm `yaml` package, declared as this repository's other third-party development dependencies are | T0 |
| 29 | The apidef preset | exact: it reads pointers as apidef does and resolves nothing apidef leaves as written. The other course keeps what it resolves today and documents each difference from apidef | T1 |
| 30 | Leniency: a trailing empty YAML document, a byte-order mark under `strict`, a 3.0 component name outside the pattern, a version this package does not know read as the latest, the specification's text over its schema where they differ | accept each, and report where a report exists | T2, T3 |
| 31 | The rules of section 5 | as written: options now, defaults when porting starts | T0 |
| 32 | YAML aliases | copies, as today, since apidef writes on the nodes; a budget of the larger of 1 MB and ten times the input, as apidef has it, settable by the caller | T2 |
| 33 | The texts the object model follows | 3.1.2 and 3.2.1, the latest published, with the vendored schemas refreshed to match | T3 |
| 34 | Versions before 1.0 | a changed default is a minor version with a note; the preset's results change only with apidef's agreement; the consumer gate runs before every release | T1 |
| 35 | A lone surrogate read as U+FFFD | a function here, `wellFormed(tree)`, which apidef calls; raw mode itself rewrites nothing | T2 |

## 7. Work in other repositories

Each yaml change passes that repository's own suites, its YAML Test
Suite census and its ledger of deviations from the core schema, in every
implementation there. The sizes allow for that.

| Repository | Change | Needed by | Size |
|---|---|---|---|
| yaml | `//` and `/* */` are not comments in YAML | T2; 44 documents | S to M |
| yaml | an option for the core schema: the 1.1 words, `_` in numbers, binary, signed hexadecimal, `Infinity` | T2; 192 documents | M |
| yaml | an indented root mapping; a digit-led key with colons and a block value; `.5 x` | T2; 7 documents | S to M each |
| yaml | compact nested lists; a list at its key's indent with an empty entry; a scalar on the line after its key; `>+` with a trailing blank line | T2; 15 documents | S to M each |
| yaml | a budget on alias expansion, with a coded error; a recursive alias | T2 | M |
| yaml | an explicit key with a lone-surrogate escape keeps its quotes | T2 | S |
| yaml | CR-only line breaks; JSON text after a blank first line; tab indentation refused | T2 | S each |
| yaml, parser | memory per byte of YAML | T2 | M, after measurement |
| expr | fold a location as written, not through the sites above it | T3 | S |
| expr | a step budget | T3 | S |
| aontu | a release whose pins let `@tabnas/expr` 0.5.20 reach apidef, or apidef overrides them | T1 | S |
| apidef | the steps of T1, then one per phase as each need is met | G2 | M |
| aless | its decision record; adoption after porting | G3 | outside this plan |
| admin | the release workflows and the descriptor restamped | T6 | S |

Changes to apidef need that repository attached to a session, or the
maintainer; the consumer gate needs only a checkout.

## 8. Risks

| Risk | Mitigation |
|---|---|
| The map and the fold disagree about a reference | the fold's callbacks read the map; a test ties the fold's reports to it; E11 runs both over Stripe and GitHub before the source changes |
| The rebuilt `resolve` moves apidef's output | the preset is exact and pinned against apidef's own resolver; the consumer gate on every pull request; byte-identical models as the measure |
| The yaml changes take longer than this plan allows | they are independent of each other and of T3; the ledger shows progress row by row; T1 and T3 do not wait for them |
| apidef's install cannot take a current `@tabnas/expr` | named in section 7; T1's third item is where it is found out, early |
| The package is published ahead of the rest of the repository | Decision 17 is explicit; section 5 keeps every suite green; the hand-off lists the options and their intended defaults |
| aless's needs turn out different when it adopts the package | Decision 16 asks for them to be confirmed now; the viewer check exercises the map as a viewer would |
| Memory on very large YAML cannot be brought under the default heap | a coded refusal before the limit, and the figure in the reference page |
| T5 grows without bound | Decision 19 fixes its scope; each item is opt-in and separate |
| The loader is a file-read or request-forgery vector | nothing loads by default; the offered loaders are confined, allow-listed and budgeted |

## 9. Sequence

```
T0  gates                                  S-M   first
T1  the first release, apidef's swap       S+M   after T0                         -> G2, its first step
T2  reading (+ yaml)                       M     alongside T1 and T3              -> G1 (a), (d); G2, four more steps
T3  the reference map, resolve on it       L     alongside T2, after T1's preset  -> G1 (b), (d); G3
T4  several documents                      L     after T3                         -> G1 (c)
T5  beyond references                      M ea. first item after T3, third after T4 -> G1 (e); G2, the last step
T6  finish                                 S-M   last                             -> the brief for porting
```

T1's change to the preset comes before T3, so that the map is built on
the preset's final meaning and apidef sees `resolve` change once.

## 10. Verification at each step

```sh
(cd ts && npm test)                       # the TypeScript suite, shared and TypeScript-only fixtures
make test                                 # every suite in the repository stays green
node tools/corpus/sweep.cjs               # the corpus, with progress lines; then the ledger diff
node tools/consumer-gate.cjs              # apidef's suite and models against this tree
```

A phase is complete when its fixtures are green, its acceptance line
holds, the ledger says what changed, and its documentation page says
what the code does.

## 11. What the review changed

The first revision was given to an independent reader with the
measurements and asked to break it. The findings that changed the plan:

- G2 and G3 were stated as reachable. Section 1 now says where each
  stops, and Decision 16 puts it to the maintainer.
- The first release was tied to T2 for no reason and its blockers were
  missed: the stamped release workflows, and aontu's pins in apidef's
  install. T1 is now the release and the swap, and section 7 names both.
- The map was said to make `cuts` a view of itself. Which edge is cut
  follows the walk, so the fold keeps that, and a test ties the two.
- The pointer rule was said to keep the preset equal to apidef. The
  shapes in section 3's table show otherwise, so the preset takes
  apidef's reading exactly.
- "The first reference in document order" was circular, since typing
  reveals references. Section 3 defines the rounds.
- The fixture rule would have moved shared rows against this
  repository's own rules. Section 5 keeps them and makes the two
  affected readings options.
- The class counts were summed though they overlap, the memory failure
  was understated, and two refusals called defects are choices. Section
  2 is corrected.
- Dropped from the research and restored: the downstream tools that
  read apidef's definition, `$recursiveRef`, the published 3.1.2 and
  3.2.1 texts, the alias policy, the loader's hardening, and a recursive
  alias that reads as `null`.
