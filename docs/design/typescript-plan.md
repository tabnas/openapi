# Plan: finishing `@tabnas/openapi` in TypeScript

A plan to take the TypeScript package from where Phase 2 of the earlier
plan left it to finished, against the two goals the maintainer holds it
to:

1. it fully parses and handles every valid OpenAPI description;
2. it fully replaces the custom parsing in `voxgig/apidef`.

Status: a proposal for the maintainer, 12 November 2026, third revision.
Section 11 says what each revision changed. Four directions from the
maintainer shape it:

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

In (a), the ledger may keep two kinds of row only: a document where the
reference parser is the one in error, and a reading the maintainer has
decided. Every defect class in section 2.1 reaches zero.

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
every one. The sweep ran under Node 22 with a 4 GB limit per document;
`engines` names Node 24.

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
- **apidef's own tests barely read YAML.** Its suite runs 47 OpenAPI
  definitions: 45 are JSON and 2 are YAML. Every difference above is in
  YAML.
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

None of W1 to W6 showed in the corpus: they are shapes the
specification allows and real documents rarely use. Missing rather than
wrong: resolution across documents; the implicit discriminator mapping;
a check that a target has the type its reference expects;
`$recursiveRef`; bundling; and the reading rules for an operation
(inherited parameters, servers and security). Two refusals are choices,
not defects, and Decision 25 takes them: a trailing empty YAML document,
and a byte-order mark under `strict`.

One cost is this repository's to remove: `parse` keeps one parser for
every call, and after a grammar parse of the GitHub description that
parser holds about 840 MB until it is dropped.

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
own resolver.

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
   in the same commit.
3. **The apidef gate.** A script that builds this checkout, makes the
   link of section 2.4 in the apidef clone, and runs apidef's suite and
   the model comparison of E9 there, printing progress as the sweep
   does. Until T1 it applies E9's first diff to apidef at the commit E9
   used (3058271); from T1 it runs the apidef branch as it is.
4. **Fixture homes.** `test/spec/` is read by every suite in the
   repository. Behaviour only the TypeScript package has goes in
   `test/resolve/`, `test/model/`, `test/docs/` and a new
   `test/pending/`, each with a TypeScript runner; section 5 has the
   rule.

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

### T2: reading, in this repository (M)

Every valid text gives the right tree, and a hostile one gives a code.
All of it is this package's own configuration and code.

1. **`reading: 'spec'`** (Decision 21), one option that selects the
   specification's reading: comments are YAML's `#` alone; numbers
   follow the core schema; a trailing empty document is accepted. It
   takes in the YAML 1.1 words when `@tabnas/yaml` offers that option
   (T2b). It is an option until porting starts, since shared fixtures
   pin today's reading (section 5).
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
5. Memory per byte of YAML, with the engine.

Acceptance: in the sweep, no valid description refused and no tree
difference outside the two kinds section 1 allows.

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
   `fold_depth` surfaced as `openapi_depth`.
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

Acceptance: every fixture green; the apidef gate unchanged; the Stripe
and GitHub censuses in `AGENTS.md` unchanged, or each change explained;
in the sweep, no reference `not-found` whose target exists.

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
| 16 | The rules of section 5 | as written: options now, defaults when porting starts | T0 |
| 17 | A reference YAML parser for the corpus tool | the npm `yaml` package, declared as this repository's other third-party development dependencies are | T0 |
| 18 | A repeated member name. No document of the corpus has one; one apidef test does | `duplicates: 'merge'` added and used by apidef; last wins stays the default. This replaces the earlier Decision 11, which put the merge in the preset | T1 |
| 19 | The apidef preset | exact: it reads pointers as apidef does and resolves nothing apidef leaves as written. The other course keeps what it resolves today and documents each difference from apidef | T1 |
| 20 | Where apidef's changes live until this package is published | on a pushed branch of apidef, proven by the gate, merged after the release. The other course teaches apidef's continuous integration to check out and build this repository, which its guide allows | T1 |
| 21 | How YAML plain scalars and comments are read. 3.2 recommends YAML 1.2 and names no schema; 3.0 and 3.1 point at YAML's JSON schema for tags | `reading: 'spec'`: comments are `#` alone, numbers and words follow the core schema; an option now, the default when porting starts; merge keys stay | T2 |
| 22 | Integers past 2^53 | the tree unchanged and a `lossy` report with the source text; no BigInt in the tree | T2 |
| 23 | YAML aliases | copies, as today, since apidef writes on the nodes; a budget of the larger of 1 MB and ten times the input, as apidef has it, settable by the caller, checked on the text in this package | T2 |
| 24 | A lone surrogate read as U+FFFD | a function here, `wellFormed(tree)`, which apidef calls; raw mode itself rewrites nothing | T2 |
| 25 | Leniency: a trailing empty YAML document, a byte-order mark under `strict`, a 3.0 component name outside the pattern, a version this package does not know read as the latest, the specification's text over its schema where they differ | accept each, and report where a report exists | T2, T3 |
| 26 | Which changes to ask of `@tabnas/yaml`, `@tabnas/expr` and the engine, and in what order. Those repositories' own rules govern how each lands | the rows of section 7, in that order, each its own instruction | T2b, T3 |
| 27 | A pointer that passes through a reference | lenient: the document first, then through the reference, reported in the row; `strict` raises it. E8 recommended the strict reading; E12 counts what each would cost | T3 |
| 28 | A target the object model does not type | the rounds of section 3; a conflict reported | T3 |
| 29 | Schema dialects. This replaces the earlier Decision 13 | draft-04, 06, 07 and 2019-09 read; an unknown dialect read as 2020-12 and reported | T3 |
| 30 | The texts the object model follows | 3.1.2 and 3.2.1, the latest published, with the vendored schemas refreshed to match | T3 |
| 31 | Loaders | a confined file loader and an allow-listed HTTP loader, both opt-in; nothing loads by default | T4 |
| 32 | What "handle" covers beyond references | the operation view, the embedded languages and bundling to JSON are in; writing YAML back with its layout is out | T5 |
| 33 | Peer ranges of this package, as a standing rule | each floor at the first release that has what the package calls: `@tabnas/expr` 0.5.20 for `fold`, and so on | T6 |

## 7. Work in other repositories

All of T0, T1, T2, T4 and T5 is in this repository. What is not:

| Repository | Change | Needed by | Size |
|---|---|---|---|
| expr | fold a location as written, not through the sites above it | T3 | S |
| expr | a step budget, so that a caller can bound or cancel a walk | T3 | S |
| yaml | an option for the core schema's words | T2b; 166 documents | S to M |
| yaml | compact nested lists; a list at its key's indent with an empty entry; a scalar on the line after its key; `>+` with a trailing blank line | T2b; 13 documents | S to M each |
| yaml | an indented root mapping; a digit-led key with colons and a block value; `.5 x` | T2b; 7 documents | S to M each |
| yaml | an explicit key with a lone-surrogate escape keeps its quotes | T2b; apidef's last workaround | S |
| yaml | CR-only line breaks; JSON text after a blank first line; a recursive alias; tab indentation refused | T2b | S each |
| yaml, parser | memory per byte of YAML | T2b | M, after measurement |
| apidef | the branch of T1, which grows as T2 and T5 land | G2 | M |
| aontu | at the release: pins that let `@tabnas/expr` 0.5.20 reach apidef, or apidef overrides them | T6 | S |
| admin | at the release: the workflows and the descriptor restamped | T6 | S |

Each yaml change passes that repository's own suites, its YAML Test
Suite census and its ledger of deviations from the core schema, in every
implementation there. The sizes allow for that.

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
