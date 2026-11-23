# Plan: finishing `@tabnas/openapi` in TypeScript

A plan to take the TypeScript package from where Phase 2 of the earlier
plan left it to finished, against the two goals the maintainer holds it
to:

1. it fully parses and handles every valid OpenAPI description;
2. it fully replaces the custom parsing in `voxgig/apidef`.

Status: accepted by the maintainer on 12 November 2026, in its third
revision, with Decisions 16 to 19 taken as section 6 records. Section 11
says what each revision changed. Four directions from the maintainer
shape it:

- Porting is deferred until the TypeScript version is finished, and is
  outside this plan.
- The work is in this repository first. Nothing is published until the
  package is finished.
- apidef is the proving ground, and it is validated locally: a clone
  that can be pushed to, linked to this checkout by a symbolic link.
- The aless viewer, a third goal in the earlier revisions, is set aside
  until a port exists.

The plan replaces the order of work in
[`implementation-plan.md`](implementation-plan.md) (its Phases 3 to 7
and its section 9) and two of its decisions (11 and 13). That document
stays the record of the design through Phase 2.

It rests on measurements taken for it, each filed under
[`prototype/`](prototype/) with its scripts and result: a sweep of 8,986
real documents (E7), an audit against the specification texts with
probes (E8), apidef's own suite run against this package (E9), and
apidef's own reader and models on the documents the sweep flagged
(E11). E10, a reading of what aless needs, is kept as a record and not
used here. Every point marked **Decision** is the maintainer's; the plan
names the default it would take. Every dependency change is a decision,
as this repository's `CLAUDE.md` requires, and nothing below is an
instruction to make one.

## In brief

- **Real descriptions mostly read correctly, and where they do not,
  apidef has the same trouble.** Of 5,182 real descriptions, 19 valid
  ones are refused and 39 lose or mangle a value through a defect.
  apidef's own reader refuses and misreads the same documents. In four
  of five that parse, the difference never reaches apidef's output,
  which is why it is not known there; where it does, it is mostly a
  lost server URL or an example value.
- **A further 185 differ from YAML 1.2 only by design.** The base
  grammars read `yes`, `no`, `on` and `off` as booleans and allow `_` in
  numbers, on purpose. Whether OpenAPI should be read that way is a
  decision, not a defect.
- **Much of the reading work is in this repository.** The comment and
  number readings can be switched off from this package's own
  configuration. Only the rest needs `@tabnas/yaml`.
- **Resolving within one document is sound on real documents**, and
  silently wrong in a handful of shapes the specification allows. 789
  descriptions (15%) name other documents, which nothing resolves yet.
- **apidef's resolver can be deleted today**: with this package in its
  place, 2,473 of its 2,475 tests pass and its models are
  byte-identical.

## Terms

| Term | Meaning here |
|---|---|
| site | a map that holds a `$ref` where the description's version reads it as a reference |
| landing | the location, in the document as written, that a reference names |
| cut | a reference left as written because following it would close a cycle |
| the fold | `fold` from `@tabnas/expr`, the walk `resolve` is built on |
| the preset | `resolve(raw, { compat: 'apidef' })`, the options that reproduce apidef's resolver |
| base grammars | `@tabnas/json`, `@tabnas/jsonic` and `@tabnas/yaml`, which this package configures and adds no grammar to |
| fast path | `JSON.parse` for JSON text; the grammar path is the base grammars reading the same text |
| core schema | YAML 1.2's rules for which plain scalars are booleans, numbers and null |
| the ledger | the committed list of corpus documents that fail, each with its class |
| the apidef gate | apidef's own suite and model comparison, run from a clone of apidef linked to this checkout |

## 1. What finished means

| | Goal | Finished, in this plan, when | Measured by |
|---|---|---|---|
| G1 | Every valid description is read and handled | (a) Every valid document in the corpus parses to the tree the reference parsers give, under the reading of Decision 21. (b) Every reference is resolved to what the specification says it names, or reported with a reason. (c) A description in several documents resolves, given its documents or a loader. (d) Input built to exhaust the reader ends in a coded refusal. (e) The reading rules the specification states for an operation are applied, to the scope of Decision 32 | the corpus sweep as a gate; a fixture for each defect of section 2.3; the multi-document corpora |
| G2 | apidef's TypeScript package has no parsing of its own | `ts/src/parse.ts` in apidef holds only apidef's policy; apidef's suite is green against this package; its models are byte-identical on its 43 definitions, the 11 OpenAPI Initiative examples and the GitHub description; the definition it hands to other tools is unchanged | the apidef gate |

In (a), the ledger may keep three kinds of row only: a document where
the reference parser is the one in error, a reading the maintainer has
decided, and the correct refusal of a document that is not a
description. `test/corpus/accepted.tsv` names each such row with its
reason. Every other row is open, and every defect class in section 2.1
reaches zero.

G2 has two limits, both of which follow from the directions above:

- **It stops at apidef's TypeScript package.** apidef has a second
  implementation of its parser, and its own rules hold the two to the
  same fixtures. That one cannot move until this package is ported. So
  every apidef step taken here must leave apidef's output exactly as it
  is.
- **apidef's changes stay on a branch until this package is
  published.** They are proven locally throughout, but apidef's own
  continuous integration installs published packages, so the branch
  merges at the end (Decision 20).

Non-goals, unchanged from the earlier plan: validating an instance
against a schema, validating a description against the OpenAPI schema,
generating code, making HTTP requests, and evaluating `$dynamicRef`
dynamically. One is added: writing a description back as YAML with its
comments, anchors and layout (Decision 32).

## 2. Where it stands

### 2.1 The corpus baseline (E7)

8,986 distinct documents, 924 MB: the whole APIs.guru directory (4,138
descriptions), the OpenAPI Initiative's test and example documents, the
multi-file sources of DigitalOcean (3,636 files) and Redocly's starter,
GitHub's and Stripe's descriptions, and a sample of Azure's (929 files).
5,182 declare a version this package knows; the rest are fragments of
multi-file descriptions and a few drafts. The reference parsers
(`JSON.parse`, and the npm `yaml` package under the core schema) accept
every one. The sweep ran under Node 22 with a 4 GB limit per document.
`engines` names Node 24, and the tool of T0 ran it again there, from a
fresh fetch: every figure below is the same, document by document.

| Measure | Result |
|---|---|
| Descriptions that parse | 5,162 of 5,182 |
| Refused though valid | 19 |
| Out of memory | 1 under the sweep's 4 GB limit; under Node's default limit both Microsoft Graph descriptions (26 MB and 58 MB) |
| JSON documents equal to `JSON.parse` | 907 of 907 |
| YAML documents whose tree differs from the reference | 233 |
| A repeated member name | none in any document |
| `resolve` errors thrown | 0 in 5,162 descriptions |
| Reference sites | 1,190,999: 1,159,428 resolved, 1,972 cut, 29,599 left as written |
| Left as written | 29,595 name another document (789 descriptions, 15%); 4 name nothing, correctly |
| Wrong landings | 0 in a check of 122,423 references across 600 documents |

The 233 documents whose tree differs are of four kinds, and only two
are defects in the reading:

| Kind | Documents | What it is | Where it is repaired |
|---|---|---|---|
| A reading the base grammars make on purpose | 186 with nothing else, 192 in all | `yes`, `no`, `on` and `off` read as booleans (166 documents, nearly all `enum` entries), and `_` allowed in numbers (45: `1_000`, `01009_01`). Both are documented behaviour and differ from the core schema | a decision (21); the numbers here, the words in `@tabnas/yaml` |
| jsonic's comment syntax, left on under YAML | 32 | `//` and `/* */` in a plain scalar start a comment, so `url: //api.example.com` reads as `null` | here: two engine options on this package's own parser |
| Layout defects in `@tabnas/yaml` | 13 | compact nested lists, a list at its key's indent with an empty entry, a scalar on the line after its key, `>+` with a trailing blank line. GitHub's own YAML description is one | `@tabnas/yaml` |
| The reference parser's own error | 2 | not this package's | the ledger |

The 19 refusals are of the same two defect kinds: 12 from the comment
syntax (`path: /*`, a key `//openapi:`), repaired here, and 7 in
`@tabnas/yaml` (an indented root mapping, a digit-led key with colons
and a block value, `.042 mg/L`). Three of the seven are official OpenAPI
Initiative examples.

So among the 5,182 descriptions, 58 meet a real defect: 19 refused and
39 with a lost or mangled value. E11 confirms the repair that is this
repository's. With the engine's `comment.def.slash` and
`comment.def.multi` off and `number.sep` unset on the parser `make`
builds, the flagged documents were swept again: 12 of the 19 refusals
are gone, the trees that differ fall from 233 to 181, no comment or
underscore case is left, and nothing new appears.

Above 100 KB the package parses YAML in about 0.83 of the reference
parser's time, at 85 to 160 bytes of memory per byte of YAML, where the
reference parser needed about 36 on the largest document.

Resolution within one document is sound on real documents. Its limits
are the 789 descriptions that name other documents, and sources such as
DigitalOcean's that put a `$ref` where the specification allows none:
917 of them, which `resolve` reads as references only under its
`slots: 'all'` option.

### 2.2 The same documents through apidef (E11)

apidef reads through the same base grammars, so every reading
difference above should be apidef's too. It is. apidef's own reader, at
the versions apidef installs (`@tabnas/yaml` 0.5.15, `@tabnas/jsonic`
0.7.1), was run over the 254 documents the sweep flagged:

| | This package | apidef's reader |
|---|---|---|
| Valid descriptions refused | 19 | the same 19 |
| Documents whose tree differs from the reference | 233 | the same 233 |
| YAML 1.1 words, underscore numbers | 166, 45 | the same documents |
| A value lost to comment syntax | 32, as `null` | the same documents; at apidef's older versions the member is dropped outright in 21 of them |

Why these are not known defects in apidef:

- **Most never reach apidef's output.** apidef's guide and model were
  built twice from each flagged document up to 1 MB: from the document
  as written, and from the same document re-read by the reference
  parser. Of the 198 that parse, the output is the same in 160.
- **apidef's own tests barely read YAML.** Its `ts/test/def/` holds 43
  OpenAPI definitions: 41 are JSON and 2 are YAML. Every difference
  above is in YAML.
- **The documents are rare.** Each defect kind touches under one
  description in a hundred.
- **Where apidef has met a reading defect, it was found and repaired.**
  Its history has four: Lob's definition, which raised its yaml floor;
  flow collections; an explicit path key; and the alias limit.

They are apidef's defects all the same. In the other 38 documents its
output changes:

| What changes in apidef's output | Documents | Cause |
|---|---|---|
| a server URL: `url: //api.edrv.io` is lost, and the model carries a `{base}` placeholder | 21 | comment syntax |
| an example value | 13 | `_` in a number, or a YAML 1.1 word |
| a field's `required` flag, for a property named `on` or `off` | 2 | a YAML 1.1 word in `required` |
| a logo URL | 1 | comment syntax |
| descriptive text | 1 | the reference parser's own error |

The 19 refusals are the loud ones: apidef fails on each with a syntax
error, and gives no model for any of the 18 compared.

### 2.3 Defects the audit found (E8)

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

None of W1 to W6 showed in the sweep: they are shapes the
specification allows and real documents rarely use. The sweep cannot
see W1 to W3, and E12 looked for them with the index: W3 is in seven
descriptions of the corpus and the W1 shape in two (section 11). Missing
rather than
wrong: resolution across documents; the implicit discriminator mapping;
a check that a target has the type its reference expects;
`$recursiveRef`; bundling; and the reading rules for an operation
(inherited parameters, servers and security). Two refusals are choices,
not defects, and Decision 25 takes them: a trailing empty YAML document,
and a byte-order mark under `strict`.

One cost is this repository's to remove: `parse` keeps one parser for
every call, and after a grammar parse of the GitHub description that
parser holds about 840 MB until it is dropped. T2 removed it
(section 11).

**Found in T1: W10.** A reference that reaches its own container while
it is being folded is left in the tree as the raw map, and reported as
resolved. In `A: { $ref: '#/…/C/properties/q' }` written before
`C: { properties: { q: { $ref: '#/…/C' } } }`, the fold follows `q` to
`C`, and `C` holds `q`, which is still being folded. `expr`'s fold, as
released, then gives `C` the map as written for it. Nothing is cut and
nothing is listed as unresolved, and the resolved tree shares that map
with the raw tree. With `C` written first, `q` is cut and `A` with it,
which is the right answer for both orders. Unlike W1 to W6, this one
shows in the corpus: under the default options, 180 references in 23
documents, all versions of one Azure description. The repair is merged
in `expr`, as tabnas/expr#117, and released in 0.6.4.
`ts/test/resolve.test.ts` expects the cut in both orders, so it fails
on an `expr` before that. `cycles: 'keep'` no longer meets it
(section 11). The
sweep counts such sites since T3, as `heldAsWritten` in each baseline
(section 11).

**Found in T2: W11 and W12.** Both are the yaml grammar's. Neither
changes a tree the corpus reads: W11 is about where a token is said to
be, and no document of the corpus has the shape of W12.

- W11. A token's row and column are not exact. After each `: ` on a line
  the column is one too far, a line break inside a quoted scalar is not
  counted as a row, and the token after a block scalar has column 0. The
  offset into the text is right. So the line and column of an error, and
  the `row` and `col` of this package's provenance, can be off, while
  the tree is not affected. The `lossy` report of T2 counts its rows and
  columns from the offset for that reason.
- W12. A plain scalar that starts as a number and runs on to the next
  line is not read as one scalar. `a: 12` with `more` indented on the
  next line is the string `12 more` in YAML. In a block it is refused,
  as `unexpected`. In a flow map, `{a: 12` then `more}`, it is read
  silently as two members, `a` and `more`. A scalar that starts as a
  word reads correctly.

**Repaired in T2b**, in tabnas/yaml#151: W9, W11 and W12, with the
layout defects and the refusals of section 2.1. They are repaired in the
yaml grammar, and reached this package with that grammar's release,
`@tabnas/yaml` 0.5.33.

**Repaired in T3, item 2**: W1, W2, W3 and W6, in this repository, by
the site index of section 3. Each has rows in
`test/resolve/landings.tsv`. W4 and W5 are item 3's.

**Repaired in T3, item 3**: W4 and W5, in this repository. A schema of
3.1 or 3.2 is read by the dialect it declares, and URIs are compared in
their normal form. `test/resolve/dialects.tsv` and
`test/resolve/uris.tsv` have the rows.

**Found in T3, item 3: W13.** An `$id` written as a fragment alone, as
in `$id: '#name'`, was read in a 2020-12 schema as naming a resource:
the one it is in, since a fragment is dropped from an identifier. That
schema then stood in the index where the document stood, or the
resource around it, and every reference into that resource was read
from the schema. One such `$id` in a 3.1 description left every
`#/components/…` reference of the document `not-found`. It is how
draft-06 and draft-07 name an anchor, so a schema pasted from either
has it. No description of the corpus does. It is repaired with the
dialects: such an identifier is an anchor where its dialect has that,
and names nothing where it does not. The same holds for any identifier
that is the URI of the resource it is in, such as `id: '#'` at the top
of a schema pasted from draft-04, or the document's own URI: it names
nothing new, and the document stays where it is.

**Added in T3, item 4**: the three reports the audit found missing and
this phase owed, each read from the index and none changing the tree.
The implicit mapping of a discriminator is rows of `connections`; a
reference that lands on a type it does not expect has `conflict` in its
`provenance` row; and the URLs a description gives are a report of
their own, `urls`. `test/resolve/reports.tsv` has the rows.

**Repaired in T3, item 5**: the last of the audit's findings on the
object model, a 3.0 component under a name the specification's pattern
refuses. The repair of W3 reads such a component where a reference
lands on it. One that nothing references kept its own references as
written, counted as data and reported nowhere, which is the audit's
probe 3.7. It is read as any other component now, as 3.1 and 3.2 read
it, which Decision 25 chose.

**Found in T2b.** Four shapes were read, each wrongly, and are refused
by that change. No document of the corpus has one. The first three are
not YAML, and the reference parser refuses them as well. The fourth is
YAML that a tree cannot hold.

- A tab in a line's indentation before a mapping key or a sequence
  entry. The key was read as its parent's sibling: `a:` then a tab and
  `b: 1` gave `{a: null, b: 1}`. It is refused as `yaml_tab_indent`.
- `key: - a`, a block sequence that starts on its key's line. It read as
  `{key: [a]}`.
- A plain scalar continued on a line below a sequence at a lesser
  indent, which was joined to the sequence's last entry.
- An alias inside the node its anchor names, the recursive alias of W9.
  It read as `null`, and is refused as `yaml_recursive_alias`. YAML
  allows it and means a node that holds itself, which the reference
  parser builds. This package copies what an alias names (Decision 23),
  and a copy of a node into itself has no end, so the grammar says so
  where it said `null`.

Five limits of the grammar were met and left, none of them in the
corpus: a tagged plain scalar that runs on to the next line is refused;
a tagged quoted scalar keeps its escapes as written; `!!str x, y` in a
block is refused; a flow collection left open at the end of the text is
read as if closed; and a key written as a number in another base, such
as `0x1`, keeps its text.

### 2.4 What apidef needs (E9)

With apidef's resolver deleted and the preset in its place, 2,473 of
apidef's 2,475 tests pass, one is skipped as before, and one fails: a
path written twice, which apidef's base grammar merges and this package
reads as its last value. apidef's guide and model are byte-identical on
all 54 definitions and on the GitHub description. Stripe's description
fails in apidef before and after, in a later stage, so it measures
nothing here.

Each remaining hand-written step needs something before it can go, and
all but one of those things is in this repository:

| apidef step | Needs | Where |
|---|---|---|
| the repeated-key merge | a `parse` option (Decision 18) | here |
| `validateSource` | `openapi_root` to say `empty` for white space and comments alone, as it does for no text | here |
| `validateAliases` and `yamlalias.ts` | an alias budget; without the guard apidef's suite runs out of memory | here (Decision 23) |
| `wellFormed`, which reads a lone surrogate as U+FFFD | the same as a function (Decision 24) | here |
| `dropIgnoredHeaders` | a report of the header parameters the specification says to ignore | here, in T5 |
| `normalizePathKeys` | a repair: an explicit key with a lone-surrogate escape keeps its quotes | `@tabnas/yaml` |
| its cycle markers | nothing: `cycles: 'cut'` replaces them, but that changes apidef's output, so it waits (section 1) | apidef, later |

apidef's later stages write on the parsed tree and compare objects by
identity, so the per-site copies of `sharing: 'site'` and the `x-ref`
member are a contract. apidef also hands the parsed definition to other
tools, so its shape is a contract beyond apidef's own suite.

**How apidef is validated.** A clone of `voxgig/apidef` that can be
pushed to sits beside this checkout. Its `@tabnas/openapi` is a symbolic
link to this checkout's `ts/`, kept in its ignored `node_modules`, as
apidef's own guide prescribes for unreleased tools; no manifest or
lockfile changes for it. This package's own dependencies are found
through that link, so apidef's older pins are not in the way. A branch
of apidef carries its changes and is pushed for review, not merged.

## 3. The design change: a site index

Today `resolve` works out what a reference names while it builds the
resolved tree, inside the fold. Three of the defects above (W1, W2, W3)
come from deciding there, and the loader of T4 must know which other
documents a description names before anything is resolved.

So the plan adds one pass before the fold: an index of the document's
sites. It is internal to `resolve`, and adds no public function. Each
`provenance` row gains what the index knows: the landing, the sites a
pointer passed through to reach it, and for a reference into another
document the resolved URI and fragment.

**What the index owns, and what stays the fold's.** The index owns
everything that is a fact about the document: which maps are sites,
their types and base URIs, the identifier index, and each landing.
`resolve`'s `recognise` and `inherit` callbacks become look-ups in it,
so there is one statement of each fact. The fold keeps what depends on
the shape being built: the values, the sharing, and which edge of a
cycle is cut, which follows the walk. `provenance`, `unresolved` and
`cuts` stay the fold's reports, in walk order as `test/AGENTS.md` pins
them.

**Pointers** (Decision 27). A pointer is read on the document as
written. Where a step is missing at a site, the walk goes on in what
that site names, and the row says which sites it passed through. This
repairs W1 and W2. It is more lenient than RFC 6901, which would find
nothing there, and E8 recommended the strict reading; the lenient one
keeps what resolves today.

**The preset** (Decision 19). apidef reads a pointer differently: it
follows a reference at every step before reading the next member, and
gives up when a reference on the way names nothing. The review found
the shapes below, where that reading and the rule above part; in one
of them the preset already resolves what apidef leaves as written.
Since apidef's output must not move (section 1), the preset takes
apidef's reading exactly. That also ends three things it resolves today
and apidef does not: anchors, a pointer under an `$id`, and a
percent-encoded pointer.

| Shape | apidef | The preset today | Under the rule above |
|---|---|---|---|
| a schema that references its own member: `A: { $ref: '#/…/A/properties/p', properties: { p } }` | as written | as written | resolves |
| a member of a reference whose own target is missing, or in another document | as written | resolves | resolves |
| a bundled schema that references its own `$defs`, and a reference to it | as written | as written | resolves |

`prototype/e9-apidef-swap/preset-shapes.cjs` runs these against apidef's
own resolver. T1 made the preset equal to apidef's resolver on all
three, and on every other shape and document compared (section 11).

**Typing an untyped target** (Decision 28). Appendix G of the
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

**What changes outside the index.** `expr` gains a way to fold a
location as written, without reading through the sites above it; that
is a small change, and without it W1 and W2 cannot be repaired.
`cycles: 'keep'` and the `connections` report both read through the
resolved tree today and are rebuilt on landings.

## 4. Work, in order

Sizes are relative, as in the earlier plan: S is a day or two of focused
work, M a week, L several weeks. Each phase is one or more pull
requests in this repository, each ready for review. Nothing is
published before T6.

### T0: gates (S to M)

Nothing below can be called done without these.

1. **The corpus sweep as a tool.** `tools/corpus/`, from the E7 scripts:
   sources pinned by repository and commit, one process per document, a
   progress line every 15 seconds, results as resumable JSON lines, the
   comparison with the reference parsers, the analysis. It runs by hand
   under the Node version `engines` names, not in `npm test`: it needs
   the network and about 26 minutes. **Decision 17:** the reference YAML
   parser as a development dependency of that tool.
2. **The ledger.** `test/corpus/ledger.tsv`: one row per document that
   fails, with its class. Today it holds the rows of section 2.1. A
   number that moves is a repair or a regression, and the ledger moves
   in the same commit. `test/corpus/accepted.tsv`, written by hand,
   names the rows that are not this package's defect, each with its
   reason; the sweep counts the rest as open.
3. **The apidef gate.** A script that builds this checkout, makes the
   link of section 2.4 in the apidef clone, and runs apidef's suite and
   the model comparison of E9 there, printing progress as the sweep
   does. Until T1 it applies E9's first diff to apidef at the commit E9
   used (3058271); from T1 it runs the apidef branch as it is.
4. **Fixture homes.** `test/spec/` is read by every suite in the
   repository. Behaviour only the TypeScript package has goes in
   `test/resolve/` and `test/model/`, which exist, and in two folders
   to come: `test/pending/`, for parse rows in the format of
   `test/spec/`, and `test/docs/`, for the cases of several documents
   (T4). Each has a TypeScript runner. Section 5 has the rule and
   `test/AGENTS.md` carries it. A new folder and its runner arrive with
   their first fixture, `test/pending/` in T1, since this repository
   fails a fixture folder with nothing in it.

Acceptance: the sweep reproduces section 2.1 from a clean checkout
under Node 24; the apidef gate reports 2,473 passing.

### T1: apidef's swap, proven locally (S here, M in apidef)

The swap works today, so it comes first and every later phase is held
to it.

1. **Here:** `duplicates: 'last' | 'merge'` on `parse`, so that the one
   failing apidef test passes; the preset takes apidef's pointer reading
   (section 3), pinned by new rows in `test/resolve/apidef-extra.tsv`,
   each checked against apidef's own resolver; the three passages that
   describe the preset say what it does.
2. **In the apidef clone, on a branch:** repair the two faults in its
   error wrapping that E9 found; then swap `parse` and `resolve` in,
   keeping every other step and its cycle markers, so that its output
   does not move. The branch is pushed for review and not merged
   (Decision 20).

Acceptance: the apidef gate fully green with apidef's resolver deleted;
models byte-identical.

Both items are done. apidef's side is the branch
`claude/jolly-maxwell-jhjgus` of apidef, open there as
voxgig/apidef#230 since 21 November 2026 and not merged, as
Decision 20 has it. [`apidef-swap/`](apidef-swap/README.md) describes
it, and section 11 has what the gate gave on it.

### T2: reading, in this repository (M)

Every valid text gives the right tree, and a hostile one gives a code.
All of it is this package's own configuration and code.

1. **`reading: 'spec'`** (Decision 21), one option that selects the
   specification's reading: comments are YAML's `#` alone; numbers
   follow the core schema; a trailing empty document is accepted. It
   takes in the YAML 1.1 words since `@tabnas/yaml` 0.5.33, whose
   `schema: 'core'` option `make` passes (T2b). It is an option until
   porting starts, since shared fixtures pin today's reading
   (section 5).
2. **The alias budget** (Decision 23): checked on the text before the
   grammar runs, as apidef's `yamlalias.ts` does, default the larger of
   1 MB and ten times the input, raising `openapi_alias_budget`.
3. **For apidef:** `openapi_root` reports `empty` for white space and
   comments alone; `wellFormed(tree)`, a function applied after `parse`,
   since raw mode never rewrites a value the grammar returned
   (Decision 24).
4. **Numbers past 2^53** (Decision 22): the tree stays plain, and a
   `lossy` report lists each such number with its source text.
5. **Bytes as input**, decoded by their byte-order mark, which the
   loader of T4 needs; and the leniencies of Decision 25.
6. **Memory.** Release what the shared parser holds after a parse.
   Until very large YAML parses in Node's default heap, a document past
   a stated size is refused with a code before the process dies, and
   the ledger carries both Microsoft Graph descriptions as a limit, not
   as a pass.

Acceptance: under `reading: 'spec'`, the sweep shows no difference of
the comment or number kinds and 12 fewer refusals; the 467-byte alias
document is refused with a code in under a second; the apidef branch
drops `validateSource`, `validateAliases` and `wellFormed` with the
gate green.

### T2b: reading, in `@tabnas/yaml` (S to M each, as instructed)

What only the grammar can repair. Each is its own instruction
(Decision 26), in that repository, under its rules; none blocks T3 to
T5.

1. An option for the core schema's words, so that `yes`, `no`, `on` and
   `off` can be read as strings (166 documents).
2. The four layout defects (13 documents) and the three refusals (7).
3. An explicit key with a lone-surrogate escape keeps its quotes; then
   apidef drops `normalizePathKeys`.
4. CR-only line breaks; JSON text after a blank first line; a recursive
   alias; tab indentation refused.
5. Memory per byte of YAML, with the engine. The engine's
   `rule.history` option, set on this package's parser, is the first
   thing to measure (section 11, while T2 was built).
6. W11 and W12 of section 2.3, found in T2: a token's row and column,
   and a plain scalar that starts as a number and runs on to the next
   line.

Acceptance: in the sweep, no valid description refused and no tree
difference outside the two kinds section 1 allows.

Built, as one pull request in that repository, tabnas/yaml#151, in every
implementation there, then merged and released as `@tabnas/yaml` 0.5.33,
which this package reads with. Section 11 has the record, measured from
this checkout with that build linked in and then swept on the released
packages. Items 1, 2, 4 and 6 are repaired, and the acceptance holds for
the grammar: under `reading: 'spec'` the only trees that differ are the
two the reference parser reads wrongly, and the only descriptions
refused are the two this package refuses for their size. Item 3 is
repaired in the grammar, and apidef keeps `normalizePathKeys` until both
of its implementations can drop it. Item 5 is measured, and Decision 34
turns the bound on for what the first parser cannot hold: section 11
has its record.

### T3: the site index, and `resolve` on it (L)

1. **Prototype E12 first**, with its recorded result, before any source
   changes. It must show:
   - the index gives the landing today's resolver gives for every site
     of Stripe, GitHub, apidef's 54 definitions and the 600-document
     check set, except in the W1 to W3 shapes, each listed;
   - the typing rounds end, and give one answer when members are
     reordered, on a case where typing reveals a second reference to the
     same target and on an `$id` inside a region typed only by
     reference;
   - the preset matches apidef's own resolver on the shapes of section
     3's table;
   - `cycles: 'keep'` built on landings gives today's graph;
   - the `expr` change alone leaves `expr`'s own fixtures green;
   - how many references in the corpus need the lenient pointer rule,
     which is the evidence for Decision 27.
2. **The index** of section 3, and `resolve` on it. W1 to W6 repaired;
   `fold_depth` surfaced as `openapi_depth`. W10 repaired in `expr`
   (section 7), and the sweep made to count a site that is reported
   resolved and holds its map as written, which it cannot see today.
3. **Dialects** (Decision 29): draft-04, draft-06, draft-07 and 2019-09
   read by their own rules (`id`, `definitions`, `$recursiveRef`),
   identifiers normalised, an unknown dialect read as 2020-12 and
   reported. URIs normalised before comparison. The object model
   follows the texts of Decision 30.
4. **Reports the audit found missing**: the implicit discriminator
   mapping; a target whose type is not the one its reference expects;
   the URL-valued fields (`externalValue`, `externalDocs.url` and the
   like) as absolute URIs, never loaded.
5. **Fixtures**: a row for every probe of E8 and for every new field of
   `provenance`.

Acceptance: every fixture green; the apidef gate and the preset
comparison unchanged; the Stripe and GitHub censuses in `AGENTS.md`
unchanged, or each change explained; in the sweep, no reference
`not-found` whose target exists, and no site reported resolved that
holds its map as written.

Item 1 is done, as
[`prototype/e12-site-index.result.md`](prototype/e12-site-index.result.md),
with no source change. Each of its six points is shown, and section 11
has what it found beside them.

Item 2 is built, but for W4 and W5, which item 3's text also has and
which are left to it. Its three changes in `expr` (section 7) are
merged as tabnas/expr#117, and released in `expr` 0.6.4. Here
the index is `ts/src/site-index.ts`, with `resolve` and the
`connections` report built on it, and section 11 has what it was held
to. With that release `resolve` runs on an install from the registry,
and the corpus baselines are swept on the released packages.

Item 3 is built as Decisions 29 and 30 have it, which the maintainer
took as built on 21 November, and section 11 has its record. The rules of each dialect are in `ts/src/dialect.ts`,
the members that hold schemas in each are in `model/applicators.json`,
and the index reads both. It asks nothing more of `expr`.

Item 4 is built. The three reports are read from the index after it is
built: `implied` in `ts/src/connections.ts` gives the implicit mapping,
`index.conflict` the type a reference did not expect, and the same walk
that finds the names gives `urls`, from the leaves the object model's
overlay marks as URLs. None of them changes the tree.

Item 5 is built: every probe of the audit has a row under its number,
and a test holds the rows to the audit's list. With it the object model
reads a 3.0 component under any name, which was the last leniency of
Decision 25 it owed. Section 11 has the record of both items, and of
the acceptance runs on the build that has all five.

### T4: several documents (L)

1. **Documents given up front, or loaded.** `documents`, a table from
   URI to text, bytes or tree, and an optional `load`. Every document
   provided is parsed and indexed before any reference is judged, as
   the specification requires. One index of `$self`, `$id` and anchors
   spans them, so a reference to an identifier is met by whichever
   document declares it. URIs are normalised, so one document reached
   by two spellings is one document.
2. **The index across documents.** A landing may be in another
   document. Discovery is the index's own output: the documents an
   index names are loaded, indexed, and so on, within the budgets.
   `resolveAll` is the asynchronous form; `resolve` stays synchronous,
   given the table.
3. **Fragment documents.** A file whose root is neither a description
   nor a schema, such as a map of schemas, is typed by the reference
   that reaches into it (section 3). A schema document with no `$schema`
   takes the OpenAPI dialect. A document of another version than the
   entry is read by its own version.
4. **Loaders** (Decision 31). None by default. Offered, each opt-in: a
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

### T5: beyond references (M each, to the scope of Decision 32)

1. **The operation as the specification reads it.** An opt-in view of
   each operation: its parameters after the Path Item's are inherited
   and overridden by name and location; its servers and security after
   inheritance; for 2.0, its `consumes`, `produces` and `schemes`. With
   it, the `ignored` report: the header parameters named `Accept`,
   `Content-Type` and `Authorization`, which the specification says to
   ignore. The apidef branch then drops `dropIgnoredHeaders`. Path
   templates that differ only in a parameter's name are reported.
2. **The embedded languages**, the earlier plan's Phase 4 unchanged:
   `readExpression`, `readTemplate`, their static checks in
   `connections`, and `evaluateExpression`.
3. **Bundling.** Several documents written as one: outside references
   rewritten to components or `$defs`, names kept apart, `$id`
   resources kept. JSON out.

### T6: finish, then publish (S to M)

1. The four documentation pages cover everything above, and the prose
   gate is green.
2. The conformance statement: which corpora, how many documents, how
   many agree, and the ledger.
3. The hand-off: every behaviour of T1 to T5 is pinned by a fixture
   that carries no TypeScript in it, and the options of section 5 are
   listed with the default each should become. That list is the brief
   for porting.
4. **The first release**, as the earlier plan's Phase 7 has it: admin
   restamps the release workflows and the descriptor, which still name
   the template this repository was made from; the maintainer makes the
   first publish; the peer ranges state what the package calls
   (Decision 33).
5. **apidef's branch merges** once the package is on the registry and
   apidef's install can take the `@tabnas/expr` this package needs.
   Today aontu's exact pins give apidef 0.5.10, where `fold` first
   shipped in 0.5.20.

## 5. Keeping the repository consistent meanwhile

Continuous integration here runs every suite the repository holds, and
`test/spec/` holds what all of them agree on. Three rules keep that
true while the TypeScript package moves ahead. Together they are
Decision 16.

- **New behaviour is an option or a new function**, pinned in the
  TypeScript-only folders of T0. No row is added to `test/spec/`.
- **No default changes where a `test/spec/` row pins it.** The readings
  of `reading: 'spec'` change such rows (a `/*` that is refused as an
  unterminated comment, `1_000` read as a number, the YAML 1.1 words, a
  second empty document refused), so they stay behind that option until
  porting starts. The later change of defaults is then one line here
  and one coordinated change to the shared rows.
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
| 16 | The rules of section 5 | as written: options now, defaults when porting starts. **Taken, 12 November 2026** | T0 |
| 17 | A reference YAML parser for the corpus tool | the npm `yaml` package, declared as this repository's other third-party development dependencies are. **Taken, 12 November 2026** | T0 |
| 18 | A repeated member name. No document of the corpus has one; one apidef test does | `duplicates: 'merge'` added and used by apidef; last wins stays the default. This replaces the earlier Decision 11, which put the merge in the preset. **Taken, 12 November 2026** | T1 |
| 19 | The apidef preset | exact: it reads pointers as apidef does and resolves nothing apidef leaves as written. The other course keeps what it resolves today and documents each difference from apidef. **Taken, 12 November 2026: exact** | T1 |
| 20 | Where apidef's changes live until this package is published | on a pushed branch of apidef, proven by the gate, merged after the release. The other course teaches apidef's continuous integration to check out and build this repository, which its guide allows. **Taken, 20 November 2026: a pushed branch of apidef** | T1 |
| 21 | How YAML plain scalars and comments are read. 3.2 recommends YAML 1.2 and names no schema; 3.0 and 3.1 point at YAML's JSON schema for tags | `reading: 'spec'`: comments are `#` alone, numbers and words follow the core schema; an option now, the default when porting starts; merge keys stay. **Taken, 20 November 2026** | T2 |
| 22 | Integers past 2^53 | the tree unchanged and a `lossy` report with the source text; no BigInt in the tree. **Taken, 20 November 2026** | T2 |
| 23 | YAML aliases | copies, as today, since apidef writes on the nodes; a budget of the larger of 1 MB and ten times the input, as apidef has it, settable by the caller, checked on the text in this package. **Taken, 20 November 2026** | T2 |
| 24 | A lone surrogate read as U+FFFD | a function here, `wellFormed(tree)`, which apidef calls; raw mode itself rewrites nothing. **Taken, 20 November 2026** | T2 |
| 25 | Leniency: a trailing empty YAML document, a byte-order mark under `strict`, a 3.0 component name outside the pattern, a version this package does not know read as the latest, the specification's text over its schema where they differ | accept each, and report where a report exists. **Taken, 20 November 2026** | T2, T3 |
| 26 | Which changes to ask of `@tabnas/yaml`, `@tabnas/expr` and the engine, and in what order. Those repositories' own rules govern how each lands | the rows of section 7, in that order, each its own instruction. **Taken, 20 November 2026** | T2b, T3 |
| 27 | A pointer that passes through a reference | lenient: the document first, then through the reference, reported in the row; `strict` raises it. E8 recommended the strict reading. E12 counted: no reference of the corpus needs the lenient step, so the two cost the same there, and six references pass a site at all, each landing on an empty stub beside the `$ref` (section 11). **Taken, 20 November 2026: lenient** | T3 |
| 28 | A target the object model does not type | the rounds of section 3; a conflict reported. E12 ran them: they end, with one answer however the members are ordered, but for two references of one round that give one target different types, which the order of the document decides. Taking the sites of a round in the order of their pointers decides it one way (section 11). **Taken, 20 November 2026: the rounds, with a conflict reported and the reference resolved all the same** | T3 |
| 29 | Schema dialects. This replaces the earlier Decision 13 | draft-04, 06, 07 and 2019-09 read; an unknown dialect read as 2020-12 and reported. **Taken, 21 November 2026** | T3 |
| 30 | The texts the object model follows | 3.1.2 and 3.2.1, the latest published, with the vendored schemas refreshed to match. **Taken, 21 November 2026** | T3 |
| 31 | Loaders | a confined file loader and an allow-listed HTTP loader, both opt-in; nothing loads by default. **Taken, 23 November 2026** | T4 |
| 32 | What "handle" covers beyond references | the operation view, the embedded languages and bundling to JSON are in; writing YAML back with its layout is out. **Taken, 23 November 2026** | T5 |
| 33 | Peer ranges of this package, as a standing rule | each floor at the first release that has what the package calls: `@tabnas/expr` 0.5.20 for `fold`, and so on. **Taken, 23 November 2026: a standing rule, set now and not at the release, and moved whenever the package comes to call something newer** | T6 |
| 34 | The engine's rule history on this package's parser. Bounded at 3 it reads every YAML document of the corpus that is read at all to the same tree, in under half the memory, under a third for the largest, and three times the time (section 11) | bounded for a text past the present limit of 16 MiB, and the limit raised to what the bound then allows, measured as T2 measured the present one; unbounded below it, where nothing changes. That reads both Microsoft Graph descriptions, the last two the sweep refuses. The other courses are a bound for every text, or none. **Taken, 22 November 2026: bounded past 16 MiB, and the limit raised.** Built with the turn on work as well as on size, and the limit at 128 MiB (section 11) | T2b item 5 |
| 35 | The rate of the bound on work. The grammar is given a step for each ten bytes of `maxBytes`, set when descriptions were thought to take one for each eight to eleven. Measured, they take one for each seven to nine, so a description meets the bound on its work at seven to nine tenths of the limit on its size (section 11) | ten, as it is: the limit is a guard, and a caller with a denser description raises `maxBytes`. The other course is seven, which makes the size limit the one a description meets, and gives every `maxBytes` a caller sets 43% more steps | T6 |

## 7. Work in other repositories

All of T0, T1, T2, T4 and T5 is in this repository. What is not:

| Repository | Change | Needed by | Size |
|---|---|---|---|
| expr | fold a location as written, not through the sites above it. Prototyped in E12 as `site.written`, 11 lines, with `expr`'s suite unchanged. Merged, as tabnas/expr#117, and released in 0.6.4 | T3 | S |
| expr | a step budget, so that a caller can bound or cancel a walk. Merged, in tabnas/expr#117, as the option `budget`: past `steps` the fold fails with `fold_budget`, and `onCheck`, called every `checkEveryN` steps, cancels it with `fold_cancel` | T3 | S |
| expr | W10: a result folded while a site it needs is still being folded is not final. The plan had the fold report a cycle to that site and fold the container again once the site is settled. Merged, in tabnas/expr#117, without the second fold: the site that asks for such a container is told it has met a cycle before the container is started, so nothing is folded twice and each site's resolver is asked once (section 11) | T3; 23 documents | S to M |
| yaml | an option for the core schema's words | T2b; 166 documents | S to M |
| yaml | compact nested lists; a list at its key's indent with an empty entry; a scalar on the line after its key; `>+` with a trailing blank line | T2b; 13 documents | S to M each |
| yaml | an indented root mapping; a digit-led key with colons and a block value; `.5 x` | T2b; 7 documents | S to M each |
| yaml | an explicit key with a lone-surrogate escape keeps its quotes | T2b; apidef's last workaround | S |
| yaml | CR-only line breaks; JSON text after a blank first line; a recursive alias; tab indentation refused | T2b | S each |
| yaml | W11: a token's row and column, counted as its offset is | T2b; every error's place | S |
| yaml | W12: a plain scalar that starts as a number and runs on to the next line | T2b | S |
| yaml, parser | memory per byte of YAML. Measured: the lever is this package's own setting, Decision 34, which is built, and nothing is asked of either repository. The bound's cost in time is the engine's to lower, if it is wanted | T2b | done here |
| apidef | the change of T1, which grows as T2 and T5 land. It is the branch `claude/jolly-maxwell-jhjgus` of apidef, voxgig/apidef#230, as Decision 20 has it, and [`apidef-swap/`](apidef-swap/README.md) describes it | G2 | M |
| aontu | at the release: pins that let `@tabnas/expr` 0.5.20 reach apidef, or apidef overrides them | T6 | S |
| admin | at the release: the workflows and the descriptor restamped | T6 | S |

Each yaml change passes that repository's own suites, its YAML Test
Suite census and its ledger of deviations from the core schema, in every
implementation there. The sizes allow for that.

Every yaml row above but the last is built in tabnas/yaml#151, as one
change, since the repairs share one scan of a plain scalar and one
reading of a line break. Section 11 has what it measured.

## 8. Risks

| Risk | Mitigation |
|---|---|
| The index and the fold disagree about a reference | the fold's callbacks read the index; E12 runs both over Stripe and GitHub before the source changes |
| The rebuilt `resolve` moves apidef's output | the preset is exact and pinned against apidef's own resolver; the apidef gate on every pull request; byte-identical models as the measure |
| The link hides a difference a real install would show | the gate confirms which copy of each `@tabnas` package apidef resolved; T6 repeats the gate against the published package before apidef's branch merges |
| The yaml changes take longer than the rest | nothing in T3 to T5 waits for them; the ledger shows progress row by row |
| A long-lived apidef branch drifts from apidef's `main` | the gate runs it on every phase; `main` is merged into it as it moves |
| Memory on very large YAML cannot be brought under the default heap | a coded refusal before the limit, and the figure in the reference page |
| T5 grows without bound | Decision 32 fixes its scope; each item is opt-in and separate |
| The loader is a file-read or request-forgery vector | nothing loads by default; the offered loaders are confined, allow-listed and budgeted |

## 9. Sequence

```
T0   gates                                S-M   first
T1   apidef's swap, proven locally        S+M   after T0                        -> G2, its first step
T2   reading, here                        M     after T1                        -> G1 (a), (d); G2, three more steps
T3   the site index, resolve on it        L     after T1; alongside T2          -> G1 (b), (d)
T4   several documents                    L     after T3                        -> G1 (c)
T5   beyond references                    M ea. first item after T3, third after T4 -> G1 (e); G2, one more step
T6   finish, then publish                 S-M   last                            -> the release; apidef's branch merges
T2b  reading, in @tabnas/yaml             S-M ea. as instructed, any time       -> G1 (a); G2, the last step
```

## 10. Verification at each step

```sh
(cd ts && npm test)                       # the TypeScript suite, shared and TypeScript-only fixtures
make test                                 # every suite in the repository stays green
node tools/corpus/sweep.cjs               # the corpus, with progress lines; then the ledger diff
node tools/apidef-gate.cjs ../apidef      # apidef's suite and models, through the link
```

A phase is complete when its fixtures are green, its acceptance line
holds, the ledger says what changed, and its documentation page says
what the code does.

## 11. What each revision changed

**Since acceptance**, on the maintainer's rulings of 21 to 23 November:

- **Every decision of section 6 is taken, and every choice T3 was built
  on is ruled.** The maintainer was asked each as a question, with the
  course built or proposed as the first answer, and took that answer
  each time.

  | Ruling | Taken | What stands |
  |---|---|---|
  | Decisions 29 and 30 | 21 November | as built: a schema is read by the dialect it declares, an unknown one as 2020-12 and reported, and the model follows the 3.1.2 and 3.2.1 texts |
  | OpenAPI's `discriminator`, `xml`, `externalDocs` and `example` in a schema that declares an older dialect | 21 November | as built: read in every dialect |
  | An `$id` that names the resource it is already in | 21 November | as built: it names nothing new, and the resource keeps the root it has |
  | A relative URL where no retrieval URI is given | 21 November | as built: `urls` gives it no absolute form, and a `provenance` row for a reference into another document keeps its `urn:` URI |
  | Which fields are URLs with a base, in 3.0 and 2.0 | 22 November | as built: 3.0 follows its recommendation for four fields, and a URL of 2.0 has no base |
  | What the implicit mapping of a discriminator lists | 22 November | as built: the schemas the description lets a value name, and a schema's own name in 2.0 alone |
  | A bound on the walk of routes with no option given | 22 November | added in this change, at the allowance the index keeps |
  | Decision 34 | 22 November | the rule history bounded for a text past 16 MiB, and the limit raised to 128 MiB, in this change |
  | Decision 33 | 23 November | a standing rule, set in this change and not left to the release |
  | Decision 31 | 23 November | a confined file loader and an allow-listed HTTP loader, each opt-in, for item 4 of T4 |
  | Decision 32 | 23 November | the operation view, the embedded languages and bundling to JSON, for T5 |
  | The agent guide's link | 23 November | `CLAUDE.md` is a link to `AGENTS.md`, set in this change |
  | T4 | 23 November | to start, from the merge of T3's acceptance |

- **The walk of routes is bounded with no option given.** Item 2 left
  this open: a value that two routes reach is walked once for each, so
  callbacks that branch to one shared Path Item double the routes at
  every level, and thirty levels would not end. `reuseOf` now holds its
  visits to `index.allowance`, the bound the index keeps for its own
  later rounds: sixteen times the work of reading the document once,
  and 100,000 besides. Past it `resolve` raises `openapi_work`, with the
  place the walk had reached. Thirty levels are refused in a few
  milliseconds, under the defaults and under the preset alike.
- **No description comes near that bound.** The walk was counted on
  each of the 5,168 descriptions the base reading resolved. The longest
  takes 7.5% of its allowance, 22,101 visits where 293,312 are allowed
  (`digitalocean.com/2.0`), and none takes more than 2.2 times the work
  of the first reading.
- **The peer ranges have floors** (Decision 33). Each was measured,
  not reasoned: the oldest release on which this package's suite passes
  with every other peer at its latest. `@tabnas/expr` starts at 0.6.4,
  since 0.6.3 has no step budget and this source does not build on it.
  `@tabnas/yaml` starts at 0.5.33, since 0.5.32 fails 62 tests, and
  `@tabnas/parser` at 0.12.16, since 0.12.15 fails 281. `@tabnas/jsonic`
  starts at 0.3.1 and `@tabnas/json` at 0.3.2, since the 0.2.0 of each
  cannot be installed beside the others. The five pass together at
  their floors. Section 6 gave `expr` 0.5.20 as its example, for
  `fold`; the package has since come to call the step budget, and the
  floor follows the code, which is the rule.
- **No range has a ceiling.** Every `@tabnas` peer range in the fleet is
  open above, so that an install resolves the latest release of each
  peer and the fleet stays tested against current versions. A floor
  keeps that. `tools/peer-floors.cjs` measures the floors in a worktree
  of its own, `tools/peer-floors.json` records them, and
  `ts/test/peer-floors.test.ts` holds the manifest to the record, the
  installed peers to the floors, and refuses a caret.
- **`CLAUDE.md` is a link to `AGENTS.md`.** The file held a pointer to
  the guide and the guide's two core principles, word for word, so
  nothing is lost. The instructions this guide copies for agents ask
  for a link named `CLAUDE.MD`. That name would differ from the file's
  only in case, which macOS and Windows do not tell apart, so the
  existing name is the link, as `tabnas/parser` has it. `AGENTS.md`
  gains the two sections of those instructions it lacked. `tabnas/expr`
  has the same change.
- **The rule history is bounded for what the first parser cannot hold**
  (Decision 34). `parse` keeps two parsers for each setting of `strict`
  and `reading`. The one that keeps every rule reads a text of up to
  16 MiB, for the 1,677,721 steps of that size at most, as it did. The
  one that keeps its last three rules reads a text past 16 MiB, and
  reads again, from its start, a text the first was stopped on. The
  default `maxBytes` is 128 MiB. A parser a caller gives reads as it
  was built, so the default limit for one stays 16 MiB.
- **128 MiB is where the bounded parser takes the memory the first
  limit was set by.** Measured in a heap of 2.2 GB, under
  `reading: 'spec'`, on descriptions made of GitHub's with its paths
  repeated, each read with no bound on its work:

  | Description | Every rule kept | The last three kept |
  |---|---|---|
  | 17.9 MiB | 4.8 s, 1,778 MB | 15.8 s, 434 MB |
  | 32.8 MiB | not measured | 27.5 s, 553 MB |
  | 66.2 MiB | not measured | 54.0 s, 892 MB |
  | 99.6 MiB | not measured | 78.9 s, 1,243 MB |
  | 129.2 MiB | not measured | 103.4 s, 1,587 MB |

  That is about 250 MB, and 10.3 MB for each MiB. Three times the time
  is E13's figure, and it holds.
- **Both Microsoft Graph descriptions are read**, which were the last
  two a sweep refused for their size. Through `parse` with no option
  but the reading, the one of 24.6 MiB took 28.5 seconds and 461 MB,
  and the one of 55.7 MiB took 57.1 seconds and 689 MB.
  In the sweep, under the specification's reading, each reads to the
  tree the reference parser reads. Under the base reading each differs
  from it by its `yes` and `no` words alone, 86 values. The two hold
  157,226 references: 157,027 resolve, 199 are cut as cycles, and none
  is left unresolved.
- **The turn is on work as well as on size.** As first built it was on
  size alone, which is what the ruling's sentence says. Measured, that
  left a gap. A description takes a step for each seven to nine bytes,
  so a dense one of 12 to 16 MiB takes more than the first parser's
  steps: one of 14.2 MiB was stopped for its work, where one of
  17.9 MiB was read. GitHub's own description, 10.5 MiB, takes 83% of
  those steps today. The limit has always had both faces, size and
  work, so the turn has both: a text the first parser is stopped on is
  read again by the second. The same 14.2 MiB is then read in 19
  seconds, the first reading included, with 1.9 GB at its most, which
  is the first reading's own cost.
- **What that changes under 16 MiB.** Every text that parsed parses as
  it did, by the same parser, at the same cost. A text that was stopped
  for its work at 1,677,721 steps is now read by the second parser, or
  stopped at the steps of the limit, which are 13,421,772 by default.
  That is a text of very many small values, and it now costs time
  where it cost memory. A caller who wants the earlier bound gives
  `maxBytes: 16 * 1024 * 1024`: the steps of a given limit are all a
  text has, on either parser.
- **The worst text for the default is one of small values.** 40 MiB of
  them, in each of the four shapes of the hostile suite, was stopped at
  the default bound after 87 to 101 seconds, with 370 to 717 MB. A
  description as dense as GitHub's meets the same bound first too: one
  of 99.6 MiB was read, in 80 seconds and 1.2 GB, and one of 125.5 MiB
  was stopped after 98 seconds, at 1.5 GB.
- **Descriptions take a step for each seven to nine bytes**, where T2
  wrote eight to eleven. Counted as `check` counts: GitHub's takes one
  for each 7.9 bytes and Stripe's one for each 9.3, in 1,394,727 and
  1,484,073 steps, and the two of Microsoft Graph one for each 7.0 and
  7.8, in 3,713,145 and 7,527,838. The rate of the bound is unchanged,
  a step for each ten bytes of `maxBytes`, so by default a description
  meets it at 89 to 119 MiB, by how dense it is. Whether the rate
  should follow the measurement is Decision 35.
- **The error held the reading it ended.** The second reading was first
  started where the first one's error was caught. That error holds its
  rule and its context, and through them every rule of the reading, so
  the second reading ran with all of the first still held: 1,361 MB of
  heap in use when it ended, where 144 MB is in use with the second
  reading started after the `catch`.
- **The two parsers are held to each other.** `ts/test/history.test.ts`
  reads every row of `test/spec/` and `test/pending/` through the
  grammar with each, 234 rows, and holds them to one outcome: the same
  tree and the same `lossy` report for 159, the same refusal, message
  included, for 75. It reads the petstore with a member past 16 MiB
  through `parse` itself, as YAML under each reading and as JSON by
  each grammar. The hostile suite reads 850 KB of small items, which
  the first parser is stopped on, and holds a limit of 17 MiB to its
  1,782,579 steps on both parsers, in a child with a heap of 2.2 GB.
- **Under the specification's reading the corpus is read whole.** It
  was swept on this build under both readings, and each sweep compared
  with the one of the released packages, document for document: 8,986
  of 8,986 are there, and the records of two differ, the two Microsoft
  Graph descriptions. Under `reading: 'spec'` the ledger is 3 rows where
  it was 5, every one accepted and none open. All 5,182 descriptions
  parse. Of the 8,986 documents, one is refused, a list of test objects
  that is no description, and two trees differ from the reference
  parser's, the two that parser reads wrongly. That is G1 for this
  reading. Under the base reading the ledger stays at 235 rows: the two
  that were refused for their size now differ by YAML 1.1's words, as
  166 other documents do by design.
- **The baselines move by those two descriptions.** 1,302,785 sites
  where there were 1,145,559 under `reading: 'spec'`, 2,123 cuts where
  there were 1,924, and the connections of the two: 29,430 tags, 3,947
  mappings and 2,831 implicit mappings more.
- **The gates, on the build of this change.** The suite passes, 897
  tests and the 11 of the prose gate. The apidef gate passes at apidef
  2a66bb9, which is its branch with apidef 8.33.2 merged, against
  25f8d4b: 2,691 of 2,692 tests, one skipped as on apidef's `main`, and
  110 of 110 definitions byte-identical. The preset
  comparison finds no difference: in 167 shapes, 6,000 generated
  documents under seed 1, 8,964 documents of the corpus with the 13 that
  `parse` refuses unread, and all 46 rows, and then in the nine
  documents over 10 MB, which now have the two Microsoft Graph
  descriptions among them. The prose
  counts are re-measured, 353 alerts where there were 357, since the
  pages on the limits are rewritten. `node tools/peer-floors.cjs` was
  run to make the record of the floors, and the suite holds the
  manifest to it.

**Since acceptance**, once `expr` 0.6.4 was released:

- **`@tabnas/expr` 0.6.4 is released**, on 21 November 2026, with the
  three changes of tabnas/expr#117: a location folded as written, the
  step budget, and W10's repair. T3's items 2 to 5 call them, so until
  that release `resolve` ran against `expr`'s `main` alone, linked here
  or cloned in CI. An install from the registry threw the `TypeError`
  of `checkFold`, except under `refs: 'pointer'`, which the preset
  sets. It now runs there, and that error, which an earlier `expr`
  still gets, names the version to install.
- **T3 is accepted on the released packages.** Its acceptance was run
  again on a clean install from the registry: `@tabnas/expr` 0.6.4,
  yaml 0.5.34, parser 0.12.21, jsonic 0.7.12 and json 0.5.20, where the
  earlier records had `expr`'s `main` linked, yaml 0.5.33 and parser
  0.12.20.

  | Run | Result |
  |---|---|
  | The suite | 888 tests and the 11 of the pages' style, none failing |
  | Sweep, base reading | every one of the 8,986 documents gives the record the linked build gave, time and memory apart. No ledger row moves |
  | Sweep, `reading: 'spec'` | the same: every document gives the linked build's record, and no ledger row moves |
  | A reference not found whose target exists | none. The four reported not found are the ones in a test document of the specification's own |
  | A site reported resolved that holds its map as written | none, under either reading |
  | apidef gate | passes on apidef's branch against its `main`: 2,588 of its 2,589 tests with one skipped, and all 107 definitions byte-identical |
  | Preset comparison | no difference in 15,177 documents, nor in the nine over 10 MB, which are run by themselves |
  | The Stripe and GitHub censuses of `AGENTS.md` | unchanged, in the object model's counts and in what `resolve` reports |

  The target check of item 5's record was not made again. It ran on
  this build, and neither the build nor what the sweep records of each
  document has moved since.
- **The corpus baselines are rewritten from those sweeps**, which is
  what item 2's record left for this release. They were last written
  as item 2 was begun, on the packages then released, since a baseline
  names its dependencies by version and no released `expr` gave the
  later figures. Both now name `expr` 0.6.4, yaml 0.5.34 and parser
  0.12.21. Under the base reading the ten figures of item 2 move by
  the amounts its record gives, the 180 sites held as written among
  them, which fall to none. The count of implicit mappings is new:
  8,232, none of them not found. Under `reading: 'spec'` the same ten
  move by the same amounts, and the implicit mappings are 8,241.
  Neither ledger changes: 235 rows under the base reading and 5 under
  the other.
- **The newer yaml and parser change nothing the sweep measures.** The
  linked build's sweeps had yaml 0.5.33 and parser 0.12.20, and every
  record of theirs is the record of these.
- **The maintainer took Decisions 20 to 28** on 20 November 2026, each
  as section 6 had it: 21 to 26 as they stood, 27 as the lenient
  reading with `strict` to raise, and 28 as the rounds with a conflict
  reported and the reference resolved all the same. Nothing built moves
  for them, since each was built on its default. Decisions 29 to 34 are
  open.
- **apidef's side is a branch of apidef**, which is Decision 20:
  `claude/jolly-maxwell-jhjgus`, open as voxgig/apidef#230 and not
  merged. Its first three commits are the three diffs this repository
  kept in `docs/design/apidef-swap/`, which applied to apidef 3b24341
  give those commits' source to the byte. The two after them merge
  apidef's `main`, the second at 00778c4, its release 8.33.1. The
  diffs are gone from here, and that folder's page describes the
  branch. The gate now compares the branch with the commit of apidef's
  `main` it last merged, where it compared a patched worktree with its
  own commit.
  apidef's `main` has grown since: its suite is 2,589 tests where it
  was 2,478, and the gate compares 107 definitions where it compared
  57, which are apidef's 93, this repository's two and the twelve of
  G2.
- **apidef's own build cannot pass on that branch until this package is
  published.** Its workflow installs published packages, and the branch
  imports one that is not. Its comment gate and its dependency gate
  pass there. So the pull request stays open, with that one failure,
  until the release of T6.
- **The peer range still admits an earlier `expr`.** `resolve` needs
  0.6.4 and the manifest says `>=0`, so an install can pair this
  package with an `expr` on which `resolve` throws. The floor is
  Decision 33, which is not taken.

**Since acceptance**, as T3's fifth item was built:

- **Every probe of the audit has a row under its number.** Section 3 of
  E8 has 17 probes that showed wrong behaviour. The eight about reading
  a text are in `test/pending/parse-probes.tsv`, and the nine about
  references in `test/resolve/probes.tsv`, each with the audit's own
  input and what it gives now. `ts/test/probes.test.ts` reads the list
  from the audit and holds the two files to it: a probe added there
  needs a row, and a row under a number the audit lacks fails.

  | Probe | It gives now | Repaired in |
  |---|---|---|
  | 3.1 YAML 1.1 words | strings under `reading: 'spec'`; booleans by default, until porting starts | T2, T2b (Decision 21) |
  | 3.2 an integer past 2^53 | the nearest number, listed with its text in `lossy` | T2 (W8, Decision 22) |
  | 2.1 an empty document after the description | accepted under `reading: 'spec'`; refused by default | T2 (Decision 25) |
  | 2.2 a byte-order mark under `strict` | read | T2 (Decision 25) |
  | 2.3 a carriage return alone as a line break | read | T2b (W9) |
  | 2.4 a blank line before JSON, read by the grammar | read | T2b (W9) |
  | 2.5 a tab in indentation | refused as `yaml_tab_indent` | T2b |
  | 3.3 a reference inside `definitions`, `dependencies`, list `items` or `additionalItems` of a 3.1 schema | both references resolve | T3, item 2 (W3) |
  | 3.4 a schema that references its own `$defs` | resolved, as the audit expected | T3, item 2 (W2) |
  | 3.5 a pointer that passes a reference | the member the document has there | T3, item 2 (W1) |
  | 3.6 a target in an extension | resolved, with the references in it | T3, item 2 (W3) |
  | 3.7 a 3.0 component under a name the pattern refuses | read as any other | T3, item 5 (Decision 25) |
  | 3.8 a schema that declares a dialect | read by it, an unknown one as 2020-12 and reported | T3, item 3 (W4) |
  | 3.9 two spellings of one URI | one URI | T3, item 3 (W5) |
  | 3.10 `description` beside a reference to a 3.2 Media Type Object | no effect | T3, item 3 (Decision 30) |
  | 7.1 aliases that copy a text out past memory | refused as `openapi_alias_budget` | T2 (W7) |
  | 7.2 nesting or a chain of references past 1,000 | refused as `openapi_depth` | T3, item 2 (W6) |

- **Every member a `provenance` row gained in T3 is in one row**, the
  first of `probes.tsv`: `landing`, `through`, `uri`, `fragment` and
  `conflict`. The same test holds it to that.
- **A 3.0 component is read under any name**, which is probe 3.7 and the
  leniency of Decision 25 that the object model still owed. The 3.0
  validation schema types a member of each map of the Components Object
  only under a name that matches `^[a-zA-Z0-9\.\-_]+$`. The 3.1 and 3.2
  schemas type every member and check the name apart, so the three
  versions say one thing of a name and their schemas read a wrong one
  differently. The object model's overlay gains an entry form for it,
  `anyName`: a map the schema types by one pattern of names holds the
  same thing under any other. The nine maps of the 3.0 Components Object
  have one each, and the generator refuses the form where it does not
  fit. The repair of W3 already read such a component where a reference
  landed on it. What changes is one that nothing references: the
  references in it were data, and are read.
- **No description of the corpus has such a name where it mattered.**
  The corpus and apidef's own definitions have 1,922 descriptions of
  3.0, and none names a component outside the pattern, so this leniency
  moves nothing there. Thirty descriptions of 2.0 have 684 such names
  between them, generic types such as `Expression[Func[Account,Int64]]`,
  and 2.0 reads a definition under any name already.
- **On generated documents that leniency is all that moves.** Item 3's
  build and this one were run on 12,000 generated documents under four
  sets of options. 635 of the 48,000 results differ, every one in a
  description of 3.0 that names a component outside the pattern, which
  311 of the documents do. Under the preset every `$ref` map was a site
  already, so there the tree, the cuts and what is left as written do
  not move. What moves is the report: 372 rows inside such components
  are a schema's where they were data, and 11 maps there whose `$ref`
  is no string are reported `not-a-string`, as they are in any other
  component. apidef reads the tree alone.
- **The other two leniencies of Decision 25 were already built.** A
  version this package does not know is read as the latest it does,
  3.2, and the result says `unknown`: that was so since Phase 2, and is
  now stated in the reference page and held by
  `test/resolve/versions.tsv`. The text over the schema where they
  differ is item 3's, with Decision 30.
- **The suite** is 888 tests and the 11 of the pages' style.
- **T3's acceptance runs hold on the build that has all five items.**

  | Run | Result |
  |---|---|
  | The suite, and the pull request's twelve checks | pass |
  | apidef gate | passes: 2,477 of its 2,478 tests with one skipped, and all 57 definitions byte-identical |
  | Preset comparison | no difference in 15,177 documents |
  | Sweep, base reading | no ledger row moves. The ten figures item 2 moved, by the same amounts, and the count of the new connection kind: 8,232, none of them not found |
  | Sweep, `reading: 'spec'` | the same ten figures by the same amounts, and 8,241 implicit mappings, since this reading reads twelve more descriptions. No ledger row moves |
  | A reference not found whose target exists | none. The four reported not found are in a test document of the specification's own, which has no `components` |
  | A site reported resolved that holds its map as written | none |
  | Target check | each of 120,648 local pointers, in 600 descriptions, lands where its pointer says |
  | The Stripe and GitHub censuses of `AGENTS.md` | unchanged but for GitHub's connections, 1,296 where it had 1,284: the 12 more are its implicit mappings |

  Against item 3's sweeps, 237 documents' records differ under the
  base reading and 240 under the other, each by the count of its
  implicit mappings alone.
- **Items 3 to 5 cost no time.** On 290 descriptions of the corpus,
  each resolved three times in turn by both builds and the least time
  of each kept, the build with all five items takes 2% less time than
  item 2's under the defaults and 1% less under `cycles: 'keep'`. Item
  3's build took 4% and 3% less, since a reference written as a
  fragment alone is now located without resolving a URI, and the three
  reports take about half of that back. Item 2's cost against the build
  before the index stands: the Stripe description takes about 220 ms
  where it took about 180, and GitHub's about 430 ms where it took
  about 365, measured together on one machine.

**Since acceptance**, as T3's fourth item was built:

- **Three reports are added, and none of them changes the tree.** Each
  is read from the index once it is built. What they hold in the corpus
  is at the end of this list.
- **The implicit mapping of a discriminator is rows of `connections`**,
  of kind `implicitMapping`, at the discriminator. A value of the
  discriminating property names the schema component of that name,
  unless `mapping` has the value as a key. The rows are the components
  a description lets it name that way. Beside `oneOf` or `anyOf` they
  are the ones listed there by reference, since an inline schema has no
  name. On a parent schema they are the components that build on it
  with `allOf`, and on those in turn, a child that names its parent
  through another reference among them. `from` says which: `oneOf`,
  `anyOf` or `allOf`. In 2.0, where `discriminator` is the name of the
  property, the schema's own name is a value too, with `from: 'self'`.
  The rows are the same under the preset, since they do not depend on
  how a reference is read.
- **A reference that lands on a type it does not expect has `conflict`**
  in its `provenance` row, which is the report rule 2 of section 3
  promised. Its value is the type the object model gives the landing by
  where it is: the name of an object, `schema`, `map` or `list` for a
  container with no type of its own, and `data` for plain JSON. The
  reference resolves all the same, under `strict` too. A landing the
  model gives no type has no conflict, since it takes the reference's.
  The second of two references that give one such landing different
  types conflicts with the first, which is the case Decision 28 left to
  the order of the document. A reference of kind `data` expects
  nothing, and under `refs: 'pointer'` no landing is typed, so neither
  has one.
- **The URLs a description gives are a report of their own, `urls`.** It
  has a row for each string at a field that holds a URL or URI of
  something outside the description: where it is, the value as written,
  what a relative value is relative to, and its absolute form in the
  normal form of item 3, where it has one. Nothing is loaded. The
  fields are in the object model's overlay, as leaves of a new kind,
  `url`, each with the sentence of the specification it is read from:

  | `base` | The fields | Read against |
  |---|---|---|
  | `description` | in 3.1 and 3.2, `termsOfService`, the `url` of a Contact, License and External Documentation Object, and `externalValue`; in 3.0 the same but for `termsOfService` | the base URI in force where the field is, as a `$ref` is |
  | `retrieval` | the `url` of a Server Object | the URI the description was retrieved from, whatever `$self` says |
  | `api` | `openIdConnectUrl`, `oauth2MetadataUrl`, the URLs of an OAuth Flow Object, and `termsOfService` in 3.0 | a server of the API, so only a value written absolute has a form |
  | `none` | the `namespace` of an XML Object, and every URL of 2.0 | nothing: 2.0 has no rule for a relative one |

  3.1 and 3.2 name the fields that follow the base URI and the ones
  relative to a server. 3.0.4 recommends the base URI for four of them
  and leaves `termsOfService` to the servers. A server's URL with
  variables has no absolute form until they are given.
- **A relative URL has an absolute form only against a real location.**
  A base is a URI with a scheme, and with an authority or a path from
  the root. With no `retrievalUri` a description is read under a fixed
  `urn:`, which is no location, and a relative URL in it has no `uri`.
  The first build of this item gave it one against the `urn:`, which a
  caller could not use and had to tell apart. The `uri` of a
  `provenance` row is as it was: there it is the name the resolver
  itself knows the other document by.
- **A test holds the overlay to the fixtures.** Every field the object
  model reads as a URL, in each version that has it, is listed by a row
  of `test/resolve/reports.tsv` with its base: 41 fields over the four
  versions.
- **In the corpus** and apidef's own definitions, 5,213 descriptions
  in all, on the build that has all five items and with no retrieval
  URI given:

  | Report | Rows | In |
  |---|---|---|
  | `conflict` | 8 | 4 descriptions |
  | `implicitMapping` | 8,232, on 1,580 discriminators: 6,855 from `allOf`, 877 `self`, 456 from `oneOf`, 44 from `anyOf` | 237 descriptions |
  | `urls` | 36,991: 24,245 `description`, 4,566 `retrieval`, 2,949 `api`, 5,231 `none` | 4,568 descriptions |

  The eight conflicts are the ones E12 found: two references to a
  response that name a schema in swaggerhub.com, five schemas that name
  a response in rumble.run and rev.ai, and one that names a parameter
  in enode.io. Of the URLs, 34,942 have an absolute form: every one
  written absolute but the servers' with variables. The 2,049 without
  one are relative, or a server's with variables.
- **The suite** was 814 tests at the end of this item. 29 deliberate
  faults in the new code are each caught by one, the last of them after
  two rows were added for it.

**Since acceptance**, as T3's third item was built:

- **Five dialects are read, each by its own rules.** `ts/src/dialect.ts`
  has what resolving needs of each: draft-04 names a schema resource
  with `id` and the rest with `$id`; that member written as a fragment
  alone is an anchor in draft-04 to draft-07, where 2019-09 has
  `$anchor` and 2020-12 `$dynamicAnchor` as well; a `$ref` stands alone
  in draft-04 to draft-07, so the members beside it are not read, an
  identifier among them; and 2019-09 leaves `$recursiveRef` to
  evaluation as 2020-12 leaves `$dynamicRef`. Which members hold schemas
  is the object model's, in `model/applicators.json`, and the generator
  makes a state of the Schema Object for each dialect a 3.1 or 3.2
  schema may declare.
- **A schema is read by the dialect in force where it is.** That is its
  own `$schema`, else its parent's, else `jsonSchemaDialect`, else the
  version's own. `$schema` is read at any Schema Object, as it was, and
  it is read first: beside a `$ref` that stands alone it still says how
  the schema is read. A region that a reference types as a schema is
  read by the dialect in force at the region, not at the reference.
- **What OpenAPI adds to a Schema Object is read in every dialect.**
  `discriminator`, `xml`, `externalDocs` and `example` are OpenAPI's,
  not a dialect's, and a schema in a description keeps them whatever it
  declares. The other course drops them under a declared draft, and
  with them a discriminator's mapping from the `connections` report.
- **An unknown dialect is read as 2020-12 and reported**, in a new
  report of the result, `dialects`. It lists every dialect the
  description declares, the root's first, with the dialect each is read
  by and whether this package knows it. It is no error, under `strict`
  or otherwise. `unsupported-dialect` is no longer a reason a reference
  is left as written, since none is.
- **An identifier of a dialect is compared in its normal form**, with
  or without the empty fragment, under `http` or `https`. The
  hyper-schema dialect of each draft is read as the draft, since it
  reads references as the draft does. The OpenAPI dialects of 3.1 and
  3.2 are read as 2020-12 whatever their date.
- **`$recursiveRef` is reported as `$dynamicRef` is**, in the
  `connections` report, as a row of kind `recursiveRef` with its first
  target and whether that has `$recursiveAnchor: true`. Neither is
  followed.
- **W13**, found here and in section 2.3: an identifier that names the
  resource it is in, with or without a fragment its dialect does not
  read as an anchor, names nothing new. An identifier of another
  resource names that resource, and a fragment on it that is no anchor
  is dropped, as it was.
- **A plain name may hold a colon**, as the names of draft-04 to 2019-09
  may. So a fragment such as `#a:b` that nothing declares is `no-anchor`
  where it was `bad-fragment`.
- **URIs are compared in their normal form**, which is W5: the scheme
  and the host in lower case, an empty port and a scheme's own dropped,
  a percent-encoded unreserved character decoded and the hex digits of
  any other in upper case, dot segments removed, and `/` for an empty
  path beside an authority. The case of a path is kept. Every base the
  index holds is in that form with no fragment, and the `uri` of a
  `provenance` row is in it.
- **The object model follows the latest texts and schemas**, which is
  Decision 30. The Initiative has published 3.2.1, and newer validation
  schemas than the ones vendored: 3.1 of 2026-11-05, 3.2 of 2026-11-12,
  and the 3.2 dialect's meta-schema of 2026-02-26. They are vendored in
  place of the older ones. One member of the model moves: the 3.2 Media
  Type Object loses `description`, which the older schema gave it and
  the text never had. `resolve` had taken that member from the schema
  as one a Reference Object overrides, which the audit found, and no
  longer does. The field
  tables of the 3.1.2 and 3.2.1 texts were then held to the model,
  object by object: every fixed field of all 30 objects of each is in
  the model, and the model has none the text lacks. Between 3.2.0 and
  3.2.1 no field table differs, and between 3.1.1 and 3.1.2 one cell
  does, the type of a Header Object's `schema`.
- **Nothing in the corpus moves.** The build before this item and this
  one give one result, the tree and every report row, on all 5,213
  documents, under the defaults, under `slots: 'all'` and under the
  preset. Three documents of the corpus declare a dialect where one is
  read. All three are the Initiative's own test documents and declare
  an OpenAPI dialect, one of them of 3.3, which is reported as unknown.
  So W4, W5 and W13 are shapes the specification allows and the corpus
  does not have, as section 2.3 said of W4 and W5. The sweep does not
  count the `dialects` report.
- **On generated documents, only the dialects move.** The build before
  this item and this one were run on 12,000 generated documents under
  four sets of options. 600 of the 48,000 results differ, every one in
  a document that declares a dialect other than 2020-12 or OpenAPI's,
  which the build before left as written. None differs under the
  preset.
- **The preset reads no dialect**, as before, and a test holds it to
  that: a declaration changes nothing in what the preset gives but its
  own member.
- **The suite** is 773 tests and the 11 of the pages' style. 41
  deliberate faults in the new code are each caught by one.
- **The gates run by hand hold on this item's build.** The apidef gate
  passes: 2,477 of its 2,478 tests with one skipped, and all 57
  definitions byte-identical. The preset comparison finds no difference
  in 15,177 documents compared. The sweep moves the ten figures item 2
  moved, by the same amounts, under both readings, with no ledger row,
  and no document's record differs from the one item 2's sweep has for
  it.
- **Decisions 29 and 30 are built on their defaults.**

**Since acceptance**, as T3's second item was built:

- **The index is in source**, as `ts/src/site-index.ts`, and `resolve`
  reads it: `inherit` and `recognise` are look-ups, a site is read at
  its landing with `site.written`, and `cycles: 'keep'` walks the
  finished tree to the same landing. `provenance` rows gain `landing`,
  `through`, and for a reference into another document `uri` and
  `fragment`.
- **It equals the prototype, everywhere it was run.** The build before
  the index, E12's prototype made from that build, and the new build
  were run on the same trees: the 5,168 descriptions of the corpus with
  apidef's 43 definitions and the petstore pair, 1,140,269 sites, and
  12,000 generated documents. The new build gives the prototype's
  result for every one, under the defaults, under `cycles: 'keep'`, and
  under `slots: 'all'` with `siblings: 'merge'` and `sharing: 'site'`,
  and the prototype's result under the preset for apidef's own.
- **Against the build before it, the eight descriptions of E12 move,
  and a ninth under `slots: 'all'`.** That one is spotify.com: seven
  references inside an extension that is itself a reference name
  members beside it, which is the W2 shape. E12 did not run the corpus
  under that option.
- **The index carries each round forward.** The prototype surveyed the
  whole document again in every round. The index surveys only what a
  newly typed region changes, and reads again only the sites whose
  facts moved. A second way of running it, which works every round out
  from nothing, is kept for the tests, and the two are held to each
  other on 1,200 generated documents, 400 of them made of regions
  nested in each other.
- **Two costs are bounded that the prototype left open.** The rounds
  after the first, and the steps of a pointer read on through
  references, can each cost more than one pass over the document: a
  chain of regions that undo each other's base, or many pointers read
  through one long chain of references. Together they may take sixteen
  times the work of the first pass and 100,000 steps besides, and past
  that `resolve` raises `openapi_work`. No description of the corpus has
  a pointer that takes such a step, and the longest has five rounds.
- **`through` lists a pointer's own steps.** The prototype also listed
  what each of those references had itself been read through, which
  grows with the square of a chain's length. Each reference has a row
  of its own that says it.
- **The step budget is two options**, `maxSteps` and `onCheck` with
  `checkEveryN`, raising `openapi_work` and `openapi_cancel`. They count
  one run of steps, the index's and then the fold's.
- **The `connections` report reads the index, not the tree.** It is the
  same report on every one of the 5,213 documents. It no longer depends
  on the shape the tree is asked in: under `inline-once` a route
  through a reference kept as written was not walked, and now is. A
  name in a region that only a reference types is found.
- **The report's routes are steps, and their growth is not yet bounded
  by default.** A value that two routes reach is walked once for each,
  as it was on the resolved tree, so callbacks that branch to a shared
  Path Item double the routes at every level: seventeen levels are
  131,070 routes in under a second, and thirty would not end. `maxSteps`
  and `onCheck` now stop that walk, since every visit is a step. With
  neither given nothing does, in this build or the one before it. A
  bound that needs no option, and its size, is a choice for G1's
  hostile inputs that this item leaves open.
- **`sharing: 'inline-once'` counts a target by where a reference
  lands**, so two pointers to one place, one of them through a
  reference, are one target. Six of the 12,000 generated documents move
  by that, and none of the corpus.
- **The order of report rows is pinned as the new one.** E12 left the
  choice to this item. A row is listed when the walk first comes to its
  reference, and a reference that a pointer only passes is not come to
  then. No description of the corpus moves by it.
- **The cost** is 15% over the build before it on 290 descriptions of
  the corpus under the defaults, and 13% under `cycles: 'keep'`, each
  document resolved three times in turn by both and the least time
  kept. Descriptions in 3.1 cost what they did. E12 gave 6% to 17%.
- **The apidef gate passes on this build**, with the three diffs at
  apidef's 3b24341: 2,477 of 2,478 tests, none failing, one skipped as
  on apidef's `main`, and 57 of 57 definitions byte-identical.
- **The preset comparison is unmoved**: no difference in the 15,177
  documents it runs.
- **The sweep moves in 31 descriptions, each of them named before it
  ran, and in no other.** Both readings were swept afresh on this
  build, with `expr`'s `main` linked, and held to the baselines, which
  were swept on the released packages. Ten figures move, by the same
  amounts under both readings, and no ledger row does. The 23 Azure
  descriptions of W10 hold nothing as written, where they held 180
  sites, and nine of them have one or two cuts more, 14 in all. The
  seven codat.io descriptions of W3 gain 196 sites that were `$ref`
  maps read as data. Three of those have a cut more and one has three
  fewer. dnd5eapi.co, of W1, has two cuts where it had five. So T3's
  acceptance holds for this item. No site is reported resolved and
  held as written. The four references the sweep reports `not-found`
  are in one of the specification's own test documents, which has no
  `components` at all. The target check finds each of 113,524 local
  pointers, in 600 descriptions, where its pointer says. The baselines
  are not rewritten: each names its dependencies by version, and no
  released `expr` gives these figures yet.
- **Decisions 27 and 28 are built on their defaults**, and each is
  stated once in the index: the lenient step in the walk of a pointer,
  which `strict` refuses, and the order of a round in one sort.
- **W4 and W5 are left to item 3.** Item 2's text has W1 to W6, and
  item 3's has the dialects and the comparison of URIs, which are W4
  and W5.
- **`resolve` needs the fold of tabnas/expr#117**, and says so: on an
  `expr` up to 0.6.3 it throws a `TypeError`, except under
  `refs: 'pointer'` with no step bound, which asks nothing new and is
  what the preset sets.

**Since acceptance**, as T3's second item was begun:

- **The three changes T3 asks of `expr` are built**, in every
  implementation there, each with a shared fixture, as one pull request,
  tabnas/expr#117: `site.written`, as E12 prototyped it; a step budget;
  and the repair of W10. It is merged, and no release of `expr` has it
  yet. Nothing under `ts/src` changes here yet.
- **The step budget** is the option `budget` on `fold`, shaped as the
  engine's own `parse.budget` is. `steps` is the most steps a fold may
  take, and the step after it fails with `fold_budget`. `onCheck` is
  called every `checkEveryN` steps and cancels the fold with
  `fold_cancel` when it returns false. A step is one container the fold
  starts to fold, or one location a resolver asks a site for, so the
  count is the same in every implementation and a fixture pins it.
- **W10 is repaired another way than section 7 planned.** The plan had
  the fold report a cycle and then fold the container a second time.
  The repair needs no second fold. A location that a reference reaches
  before the walk is counted on every location above it. A site that
  asks for a location holding one is told it has met a cycle, before
  that location is started. It is the cycle the walk finds when the
  container is written first, cut at the same site, so the two orders
  of section 2.3 give one answer, and each site's resolver is still
  asked once.
- **Measured before it was merged**, with this package's `resolve` on the
  released fold and on the repaired one, over the 5,168 descriptions of
  the corpus and apidef's 43 definitions, 1,140,055 sites. The released
  fold leaves 180 sites reported resolved that hold their map as
  written, in 23 descriptions, which are the figures of section 2.3.
  The repaired fold leaves none. Those 23 are the only documents whose
  result moves, in 96 report rows: 55 go from resolved to cut and 41
  from cut to resolved, as the cut moves to the site that closes the
  cycle. Nothing moves under `cycles: 'keep'` or under the preset. This
  package's suite moves in the one test that pins W10.
- **The sweep counts what it could not see.** Its `resolve` phase counts
  the sites reported resolved while the tree holds, at the site, the
  very map the document has there. Both baselines carry the figure as
  `heldAsWritten`: 180 in 23 descriptions under each reading, on the
  released packages. T3's acceptance holds it to zero.
- **What followed the merge, and what waits for a release.** The test
  of W10 expects the cut in both orders since the merge, because CI
  here builds against `expr`'s `main`. On an install from the registry
  that one test fails until `expr` is released, since 0.6.3 has the
  defect. Both baselines keep the 180. A baseline names its
  dependencies by version, and `expr`'s `main` is still 0.6.3 by that
  measure, so the baselines are rewritten from a sweep on the release
  that carries the repair.

**Since acceptance**, as T3 was begun, with its prototype:

- E12 is item 1 of T3, and
  [`prototype/e12-site-index.result.md`](prototype/e12-site-index.result.md)
  is its record. It changes no source. It builds the index of
  section 3, makes a resolver from the compiled one by seven
  replacements, so that `recognise` and `inherit` are look-ups in the
  index and a site is read at its landing, and gives `expr` a way to
  fold a location as written, as a diff of 11 lines.
- **The index and the fold agree.** With the index alone, the prototype
  gives today's result for every one of 5,168 descriptions of the
  corpus and their 1,139,457 sites, for apidef's 43 definitions and the
  petstore pair, for all 118 rows of `test/resolve/`, and for 6,000
  generated documents under each of four sets of options. Stripe's
  three descriptions, GitHub's four and the 600-document check set are
  among them.
- **With landings and typing, eight descriptions of the corpus move.**
  Seven are codat.io's, all 3.1.0, which keep schemas under
  `definitions`. That is W3: 196 references inside 170 such regions
  come back as written today, with their sites reported resolved. The
  sweep could not see them, which is why section 2.3 said W3 was not in
  the corpus. Two descriptions hold the W1 shape, in six references.
- **Decision 27 has its count.** Of 1,110,054 landings in the corpus,
  none passes through a site that lacks the step as written, so the
  lenient and the strict readings give the same there. The six
  references that pass a site find their steps as written, in an empty
  stub that a converter left beside a `$ref`, and resolve to `{}`.
  Today cuts all six. Under `cycles: 'keep'` today gives three of them
  the member of the target that the author meant, and the other three
  the stub. A widely used resolver gives three the stub and three the
  member, the other way about.
- **The rounds of Decision 28 end, with one answer.** Five cases give
  one answer under 502 orders of their members each: a second reference
  to one target revealed by typing, of the same type and of another; an
  `$id` inside a region typed only by reference; a region that
  references itself; and a chain of 40 regions, which ends after round
  41. In the corpus no description needs more than five rounds. One
  case has two answers: two references of one round that give one
  target different types, where the first in the document wins.
  Taking the sites of a round in the order of their pointers gives it
  one.
- **The preset is unmoved, and so is `cycles: 'keep'` off the eight.**
  Under the preset the prototype equals apidef's own resolver on all
  15,177 documents the comparison tool runs. It is unmoved because the
  index types nothing by reference under `refs: 'pointer'` and leaves
  that reading as it is. `cycles: 'keep'`, built on landings, gives
  today's graph for 5,160 of the 5,168.
- **Three things for item 2 to settle**, none of them in the plan before.
  A pointer that passes a site which is in a cycle, and names nothing
  there, is cut today and not found on landings. Report rows are in the
  order the fold first meets each site, and a fold that reads as
  written no longer meets a site that a pointer only passes, so rows
  change places in 219 of the 6,000 generated documents, and in none of
  the corpus. And eight references of the corpus, in four descriptions,
  land on a type their reference does not expect, which item 4 will
  report.
- **The cost is small.** The prototype's `resolve` takes 6% to 17% more
  time than today's over the corpus, and 24% more under `keep`, with an
  index that is not written for speed.

**Since acceptance**, once the yaml grammar's change was released:

- tabnas/yaml#151 is merged and released as `@tabnas/yaml` 0.5.33, and
  this package follows it in one change.
- `make` passes `schema: 'core'` to the yaml plugin under
  `reading: 'spec'`, so the YAML 1.1 words are text there. The row of
  `test/pending/parse-reading.tsv` that pinned them as booleans pins
  them as strings.
- The subscriber to the lexer that turned a number the core schema does
  not name into text is gone, and so is `number.sep` unset. Both were
  measured first, with the option passed. Over 1,003 texts, 64 scalars
  in each of 13 positions and the inputs of this repository's fixtures,
  neither changes a tree. Over 8,077 of the corpus's 8,079 distinct YAML
  documents neither changes a tree, and the subscriber acts on no token.
  The two left out are the Microsoft Graph descriptions, for their size.
  The yaml grammar says why: under the option a scalar that is no number
  of the core schema goes to its text handler, and the engine's number
  matcher never sees it.
- An earlier yaml package takes an option it does not know in silence,
  and would go on reading `yes` as `true`. The manifests name no version
  of that package, so the requirement is held in code, which the plan
  did not foresee: `make` parses the text `yes` with the parser it built
  and throws unless the answer is a string (`readsCoreSchema`).
- The yaml grammar's repairs moved what this repository pinned, in every
  implementation. A second document is refused at its marker, a line
  earlier than before. JSON text after a blank first line is read. The
  list of rows where the second implementation parted from the first is
  empty, since both of its entries were defects that change repaired.
  That implementation's manifest requires yaml v0.5.33.
- The three gates ran on the released packages: `@tabnas/yaml` 0.5.33,
  with jsonic 0.7.12 and expr 0.6.3, where the earlier records were made
  with 0.5.32, 0.7.11 and 0.5.21. The sweep gives what the linked build
  gave. Under `'spec'` it refuses 3 documents where it refused 10, and 2
  trees differ where 180 did. The ledger falls from 190 rows to 5: 185
  removed, none added, none changed. Three of the five are the accepted
  rows, and the other two are the Microsoft Graph descriptions, refused
  for their size, so no row is left that is a defect of reading. Under
  `'base'` it refuses 15 where it refused 22, and 220 trees differ where
  232 did. That ledger goes from 254 rows to 235: 20 removed and one
  added, the EPA's description, which was refused and, now that it is
  read, holds one YAML 1.1 word.
- Under both readings the resolve figures that moved are those of the
  seven descriptions now read, to the unit: 1,067 more sites, all
  resolved. No other figure moved, so the newer expr and jsonic change
  nothing the sweep measures. The apidef gate passes as before, with 57
  of 57 definitions byte-identical, and the preset comparison finds no
  difference in 15,177 documents.

**Since acceptance**, while T2b was built:

- T2b is one pull request in the yaml repository, tabnas/yaml#151, in
  every implementation there, with 218 fixture rows. Nothing is merged
  or released, and no file under `ts/` changes here. What follows was
  measured from this checkout with that build in place of the installed
  yaml package, and, for the specification's reading, with one line of
  `make` changed to pass the option.
- The option is `schema: 'core'` on the yaml plugin. Under it a plain
  scalar resolves as the YAML 1.2 core schema says and no other way, so
  `yes`, `no`, `on` and `off` are strings, and so is a number the core
  schema does not name. Without it the grammar reads as before. The
  YAML Test Schema's 245 scalars define it, and all read as the core
  schema says.
- Under `'spec'`, with the option passed, the sweep refuses 3 documents
  where it refused 10, and 2 trees differ where 180 did. The ledger
  falls from 190 rows to 5: 185 removed, none added, none changed. Three
  of the five are the accepted rows, two documents the reference parser
  reads wrongly and one that is a list and no description. The other two
  are the Microsoft Graph descriptions, refused for their size.
- Under `'base'`, which passes no option, it refuses 15 where it refused
  22, and 220 trees differ where 232 did. The seven refusals the grammar
  caused are gone. What is left is that reading's own, with the three
  accepted rows and the two refusals for size: the comment syntax in 12
  refusals and 32 trees, the number syntax in 45 trees, and the YAML 1.1
  words in 166. The ledger falls from 254 rows to 235: 20
  removed and one added, a description that was refused and now reads,
  and holds one of those words.
- Those sweeps ran on the build before the pull request's last change to
  the grammar. Every document was then read with both builds under both
  readings, on the grammar path: 17,972 readings, and each gives the
  same tree or the same refusal. So the figures are the final build's.
- The apidef gate passes with the three diffs against that build: 2,477
  of 2,478 tests, one skipped as on `main`, and all 57 definitions
  byte-identical.
- Beyond the corpus, the grammar's change was held to the reference
  parser on 28,975 generated texts aimed at the repaired shapes. No text
  that the released grammar and the reference read alike reads
  differently now.
- A token's row and column are now the ones its offset gives (W11), in
  the grammar itself. The `lossy` report can read them from the token
  once the release is in. It still counts them from the offset.
- Item 3. The grammar no longer leaves the quotes on an explicit key
  with a lone-surrogate escape. With apidef's call to
  `normalizePathKeys` dropped as a fourth diff, the gate passes as it
  does with three. The diff is not added. apidef holds that function to
  a table both of its implementations run, and its second
  implementation still calls it, so the call goes from both at once,
  after the release. A key with an escape that is no escape, such as
  `"\q"`, still keeps its quoted text, by the grammar's design, and
  only there does the function still do anything.
- Item 5. The engine's `rule.history`, bounded at 3 on this package's
  parser, reads every YAML document of the corpus that the released
  package reads to the tree it reads unbounded: 8,169 up to 2 MB, and 50
  from there to 13.8 MB. Eight more are refused either way, seven of
  them by the defects tabnas/yaml#151 repairs. Over those 50 it takes
  3.1 times the time, and less memory the larger the text: 42% in sum,
  and 29% for the largest. Stripe's description takes 373 MB and 11.3
  seconds where it took 1,285 MB and 3.7 seconds, GitHub's 334 MB and
  10.6 seconds where it took 1,203 MB and 3.1 seconds. The time is the
  parse's alone, and the memory the peak when it ends. The scripts and
  every row are filed as E13, under [`prototype/`](prototype/).
- Under that bound, and with the size limit lifted, both Microsoft
  Graph descriptions are read: 25.8 MB in 29 seconds at a peak of
  450 MB, where it takes 2.8 GB unbounded, and 58.4 MB in 58 seconds at
  750 MB, where unbounded it runs out of a heap of 4 GB. With the yaml
  build of tabnas/yaml#151 and its option, each gives the reference
  parser's tree exactly, in 749,797 and 1,526,519 nodes. With the
  released grammar they part from it in 24 and 62 values, every one a
  YAML 1.1 word read as a boolean, such as a parameter named `on`. They
  are the last two valid descriptions the sweep refuses, and the last
  two open rows of the ledger. Turning the bound on is Decision 34, and
  is not done here.
- What waits for the yaml release, as one change here: `make` passes
  `schema: 'core'` to the yaml plugin under `reading: 'spec'`; the row
  of `test/pending/parse-reading.tsv` that pins the YAML 1.1 words as
  booleans under that reading turns to strings; the sweep is run on the
  released package under each reading, and both ledgers and baselines
  are rewritten from it. The subscriber that turns a number the core
  schema does not name into text may then have nothing left to do,
  which that change should measure before it removes it. The package
  declares no version of the yaml package, so no manifest changes.
- The plan had this step as separate instructions, S to M each. It came
  out as one change of size L in the yaml repository: the items share
  one scan of a plain scalar and one reading of a line break, and exact
  columns showed four shapes that had been refused, or read, by
  accident (section 2.3).

**Since acceptance**, while T2 was built:

- T2 is built on the default the plan takes for each of Decisions 21 to
  25. The maintainer has taken none of them yet, and section 6 still
  shows them open. Each default is an option or a new function, apart
  from the four below, so another decision changes little.
- `reading` takes `'base'`, the default, and `'spec'`. The
  specification's reading is the same parser with three engine options
  changed and one subscriber to the lexer, which reads as text a number
  token the YAML core schema does not read as a number, such as `0b11`,
  `0X1F` and `Infinity`. It adds no token, rule or alternate, and a
  parser reads one way, the way `make` built it. Against the reference
  parser it is right for every plain scalar tried but the YAML 1.1
  words, which wait for T2b.
- The sweep runs under either reading, and each has a committed ledger
  and baseline of its own, held to the one list of accepted rows.
  Under `'base'` the record moved in one way: both Microsoft Graph
  descriptions are refused for their size, where one had parsed under
  the sweep's 4 GB and the other had run out of memory. That leaves 22
  documents refused, 232 trees that differ, and none that dies. Under
  `'spec'`, 10 are refused and 180 trees differ: the 12 refusals the
  comment syntax caused are gone, no difference of the comment or
  number kinds is left, and nothing new appears. What is left is T2b's:
  seven refusals and 15 trees by the yaml grammar's defects and the
  reference parser's own, and the YAML 1.1 words in 165 documents. That
  is T2's acceptance.
- The alias budget is apidef's scan, ported. The two agree on apidef's
  own table of 13 texts, on 200,000 generated texts and on every
  document of the corpus, where 58 have an alias that copies something
  and none is past the budget. The 467-byte document is refused in 2
  milliseconds. The budget holds only what aliases add: a text in which
  no alias copies anything is never refused for it.
- The size limit is 16 MiB by default, and `maxBytes` sets it. Where it
  was measured, Node gave a process a heap of 2,240 MB by default. A
  description of 15.5 MiB, made from two of the corpus, took 1.4 GB of
  process memory there, and both Microsoft Graph descriptions exhausted
  it. JSON text that `JSON.parse` reads has no limit.
- A shared parser held 942 MB after GitHub's YAML description. It holds
  30 MB now.
- The `lossy` report is gathered as the grammar closes each number, from
  the token the number opened on, so the tree is the same with a report
  as without. In the corpus, 34 documents write 516 numbers the tree
  does not hold exactly, under either reading: identifiers and amounts
  in examples, and the limits of a 64-bit integer.
- Of the five leniencies of Decision 25, T2 takes the two that are about
  reading a text: an empty document after the description, under
  `reading: 'spec'`, and a byte-order mark under `strict`. The other
  three are about the object model, and are T3's.
- Five defaults moved, for a caller who passes no new option. A text
  whose aliases would copy it out past the budget is refused, where it
  was copied in full. A text of more than 16 MiB that the grammar has to
  read is refused, where it was read if memory allowed. A text that
  takes more work than a description of that size is stopped, where it
  was read until memory ran out. A byte-order mark is passed over under
  `strict`, where it was refused. The `details.kind` of `openapi_root`
  is `empty` for a text of white space and `#` comments alone, where it
  was `null`. No row of `test/spec/` pins any of them, and each is
  pinned in `test/pending/` or in the package's own tests. The build
  before T2 and this one were held to each other on 475 parses. They
  differ in the first, fourth and fifth of those ways and in no other:
  no text among them is past the size limit or the work it allows.
- What `parse` does to a text before the grammar is one pass over it,
  or a counted amount of work. That was not in the plan, and three of
  T2's own checks broke it as first written. apidef's pattern for an
  empty source takes the square of a run of blank lines, 17 seconds for
  160,000 line breaks, so the test is made in one pass. The alias scan
  takes the square of anchors nested by the thousand, so its repeated
  work is counted, and a text past 32 steps for each byte is refused.
  No document of the corpus takes one step for each byte. A refused
  text is not handed to the grammar, which takes three times a text's
  size in memory before its first rule runs. apidef's check still has
  the pattern on `main`, for OpenAPI and GraphQL sources alike.
- The alias budget is held twice. A scan of the text cannot be made to
  agree with the grammar everywhere: the review of T2 found that a
  `/* */` comment of the base reading can hide an alias chain from the
  scan behind what it takes for a block scalar, and that a tag between
  an anchor and its collection ended the anchor at its line. apidef's
  own guard has both gaps on its `main`, where 322 bytes read into a
  tree of 380,301 characters unrefused. So `parse` also counts each copy
  the grammar makes, from below, and refuses at the one that passes the
  budget: the hidden chain of seven levels in a tenth of a second. The
  scan reads the tag rightly now, which is the one place it parts from
  apidef's.
- A report is read off JSON text by a pass of its own on the fast path,
  so that asking for one never sends to the grammar a text that
  `JSON.parse` reads. The two paths give one report on 1,500 generated
  texts.
- `wellFormed` merges two values only where each is a tree, as every
  value `parse` gives is. The engine's merge follows every path, and
  does not end on a cycle.
- The budget's default costs little where it is used in full: Stripe's
  description, 13.8 MiB, anchored whole and copied nine times, took
  1.4 GB where it takes 1.3 GB by itself.
- The size limit alone did not bound what a text costs, which the plan
  had not seen. The engine keeps about 900 bytes for each rule pass
  until a parse ends. The largest descriptions take a pass for each 8 to
  11 bytes. A text of very many small values takes one or two for each
  byte: a megabyte and a half of one-letter items in a flow list took
  all of a 2.2 GB heap, a tenth of the way to the size limit. So
  `maxBytes` bounds the work as well: the grammar is given a pass for
  each ten bytes of the limit, 1,677,721 by default, and a text that
  takes more is stopped as `openapi_work`. Every dense shape tried at
  the size limit is refused in about four seconds, inside the heap. No
  document of the corpus is stopped by it.
- T2b's fifth item has a lever in this package's own configuration,
  which the plan had put in other repositories. The engine's
  `rule.history` option bounds what a parse keeps of its rules, and
  TypeScript leaves it unbounded by default. With a bound of 3 on this
  package's parser, all 215 fixture rows read the same, and a megabyte
  of dense text takes 140 MB where it takes 1.5 GB, at three to four
  times the time. It is not turned on here: it wants the corpus swept
  under it, and a decision on the time it costs.
- apidef's side grew by a third diff. apidef's check for an empty
  source, its alias limit, its scan and its repair of lone surrogates
  go, and this package's stand in. `validateSource` is no longer called
  for an OpenAPI source. The function stays, because apidef's GraphQL
  reader calls it. Two sources with nothing in them now read `source is
  empty` where they read `must be an object`. The gate passes with the
  three diffs and nothing allowed to fail: 2,477 of 2,478 tests, one
  skipped as on `main`, and all 57 definitions byte-identical.
- W11 and W12 are new (section 2.3). Both are the yaml grammar's, and
  T2b lists them.

**Since acceptance**, while T1 was built:

- The preset is apidef's resolver exactly, by measurement. A new tool,
  `tools/apidef-preset.cjs`, runs both resolvers on one raw tree and
  compares the results as graphs: members, member order, values, and
  which objects are shared. Before T1 it found seventeen kinds of
  difference. Three of them were in real documents: a percent-encoded
  pointer, which apidef does not decode, in 29; W10 in 23; and a member
  of a reference that names nothing in 1. After T1 it finds none in 167
  hand-written shapes, 94,000 generated documents, and every corpus
  document that `parse` reads, which is 8,966 of 8,986.
- The preset's reading of a reference is an option of its own, `refs:
  'pointer'`, since the preset is a set of options that can each be
  turned back. Two details of apidef's resolver that are not readings
  hang on the preset itself: a `__proto__` member beside a `$ref` is left
  out, and `x-ref` takes the place of the `x-ref` of a target resolved
  earlier.
- `cycles: 'keep'` no longer follows a reference inside the fold.
  Every site holds a placeholder until the fold is done, and is then
  settled on the finished tree. Section 3 planned that rebuild for T3,
  on landings; W10 made it necessary now, because the preset keeps
  cycles and W10 is in real documents. Under `cycles: 'keep'` the
  reports are therefore in document order, where they were in the order
  targets were entered. One row of `test/resolve/apidef.tsv` changed its
  report column for that, and no tree changed.
- Outside the preset, `cycles: 'keep'` now says of a reference left as
  written what `cycles: 'cut'` says of it; before, the two disagreed in
  places, and W10 reached both. This was measured on 12,167 documents,
  hand-written and generated to be awkward. Where `cut` cuts nothing,
  which is 4,549 of them, `keep` gives the same graph and the same
  reports. In the rest, of 46,620 references, five that `cut` does not
  cut come out otherwise under `keep`, four of them resolved because the
  reference they pass through is now kept. The default did not move:
  the build before T1 and this one give the same tree and the same
  reports, in the same order, for 6,167 of those documents under five
  sets of options that cut cycles.
- W10 is new (section 2.3). Its repair is `expr`'s (section 7).
- apidef's `main` moved from 3058271 to 3b24341 while T1 was built, and
  its suite grew to 2,478 tests. The gate passes there with nothing
  allowed to fail and apidef's own resolver deleted: 2,477 passing, one
  skipped as on `main`, and apidef's output byte-identical for all 57
  definitions compared, which are apidef's 43, this repository's two,
  and the twelve of G2.
- apidef's side is kept in this repository, as the two diffs of
  `docs/design/apidef-swap/`, until Decision 20 says where it lives in
  apidef. The gate applies them in order.

**Since acceptance**, while T0 was built:

- Section 2.2 counted apidef's test definitions as 47, of which 45 were
  JSON. Four of those files are apidef's own generated output. It holds
  43 definitions: 41 JSON and 2 YAML.
- The ledger gained `test/corpus/accepted.tsv`, so that the rows which
  may stay are data the sweep checks. Section 1 names a third kind of
  row that may stay: the correct refusal of a document that is not a
  description. The corpus has one.
- T0's fourth item says which fixture folders exist and which arrive
  with their first fixture. Nothing was made empty.

**Third revision**, on the maintainer's directions of 12 November:

- The aless goal is set aside until a port exists. The reference map
  that served a viewer becomes an index internal to `resolve`, and the
  viewer check, the sibling roles, the sizes and the reverse look-up are
  gone.
- Nothing is published until T6. The early release is gone, and with
  it the decisions about publishing by hand and about versions before
  1.0.
- apidef is validated from a clone that can be pushed to, linked to
  this checkout, on a branch that merges after the release.
- The claim that reading "is where real documents fail" was checked
  against apidef and corrected. apidef's own reader was run on the same
  documents and its models compared (E11). Section 2.1 now separates
  readings made on purpose from defects, and section 2.2 says what
  apidef does with each.
- Reading work that this package can do alone is T2. Only what needs
  the grammar is T2b.

**Second revision**, after an independent reader was asked to break the
first:

- G2 was stated as fully reachable. Section 1 now says where it stops.
- The map was said to make `cuts` a view of itself. Which edge is cut
  follows the walk, so the fold keeps that.
- The pointer rule was said to keep the preset equal to apidef. The
  shapes in section 3's table show otherwise, so the preset takes
  apidef's reading exactly.
- "The first reference in document order" was circular, since typing
  reveals references. Section 3 defines the rounds.
- The fixture rule would have moved shared rows against this
  repository's own rules. Section 5 keeps them.
- The class counts were summed though they overlap, the memory failure
  was understated, and two refusals called defects are choices.
- Restored from the research: the downstream tools that read apidef's
  definition, `$recursiveRef`, the published 3.1.2 and 3.2.1 texts, the
  alias policy, the loader's hardening, and a recursive alias that
  reads as `null`.
