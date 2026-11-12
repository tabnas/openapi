# Plan: finishing `@tabnas/openapi` in TypeScript

A plan to take the TypeScript package from where Phase 2 left it to
finished, against three goals the maintainer set on 12 November 2026:

1. it fully parses and handles every valid OpenAPI description;
2. it fully replaces the custom parsing in `voxgig/apidef`;
3. it meets the needs of the `rjrodger/aless` viewer, so that a user can
   expand and collapse a referenced section, such as a component schema.

Status: a proposal for the maintainer, 12 November 2026. It replaces the
order of work in [`implementation-plan.md`](implementation-plan.md)
(its Phases 3 to 7 and its section 9) and adds to its decisions; that
document stays the record of the design through Phase 2. Porting is
deferred until the TypeScript version is finished, by the maintainer's
direction, and is outside this plan. Section 5 says how the repository
stays consistent in the meantime.

The plan rests on four measurements taken for it, each recorded under
[`prototype/`](prototype/) with its scripts and result: a sweep of 8,986
real documents (E7), an audit against the specification texts with
probes (E8), apidef's own suite run against this package (E9), and a
reading of what aless's viewer needs (E10). Section 2 gives the numbers.
Every point marked **Decision** is the maintainer's; the plan names the
default it would take. Every dependency change is a decision, as this
repository's `CLAUDE.md` requires, and nothing below is an instruction
to make one.

## 1. What finished means

| | Goal | Finished when | Measured by |
|---|---|---|---|
| G1 | Every valid description is read and handled | (a) Every valid document in the corpus parses, and its tree equals the reference parsers' reading, with any difference in a committed ledger. (b) Every reference is either resolved to what the specification says it names or reported with a reason: no silent result. (c) A description in several documents resolves, given its documents or a loader. (d) Input built to exhaust the reader ends in a coded refusal, never a crash. (e) The reading rules the specification states are applied or reported, to the scope of Decision 3 | the corpus sweep (section 2.1) re-run as a gate; the fixtures for each defect in section 2.2; the multi-document corpora; the JSON Schema test suite's reference cases |
| G2 | apidef has no parsing of its own | apidef's `ts/src/parse.ts` holds only apidef's policy (which versions it accepts, its error wording, its colon path parameters, its `components` default); its suite is green against the published package; its models are byte-identical on its 43 definitions, the 11 OpenAPI Initiative examples and the GitHub description | apidef's suite (2,475 tests) and the model comparison of E9 |
| G3 | aless can expand and collapse references | The reference map of section 3 gives a viewer every item in section 2.4, each pinned by a fixture, at a measured cost, without building a resolved tree; aless's own decisions (section 6) are recorded in aless | `test/resolve/map-*.tsv`; the cost table on the GitHub description |

G3 is finished here when the map exists and is pinned. aless takes it up
after porting, which this plan does not cover.

Non-goals, unchanged from the earlier plan: validating an instance
against a schema, validating a description against the OpenAPI schema,
generating code, making HTTP requests, and evaluating `$dynamicRef`
dynamically. One is added: writing a description back as YAML with its
comments, anchors and layout (Decision 3).

## 2. Where it stands

### 2.1 The corpus baseline (E7)

8,986 distinct documents, 924 MB: the whole APIs.guru directory (4,138
descriptions), the OpenAPI Initiative's test and example documents, the
multi-file sources of DigitalOcean (3,636 files) and Redocly's starter,
GitHub's and Stripe's descriptions, and a sample of Azure's (929 files).
5,182 declare a version; the rest are fragments. The reference parsers
(`JSON.parse`, and the npm `yaml` package under the YAML 1.2 core
schema) accept every one.

| Measure | Result |
|---|---|
| Descriptions that parse | 5,162 of 5,182 |
| Refused though valid | 19 |
| Out of memory | 1 (58 MB of YAML needs 5.3 GB; the reference parser needs 2.1 GB) |
| JSON documents equal to `JSON.parse` | 907 of 907 |
| YAML documents whose tree differs from the reference | about 231 |
| `resolve` errors thrown | 0 in 5,162 descriptions |
| Reference sites | 1,190,999: 1,159,428 resolved, 1,972 cut, 29,599 left as written |
| Left as written | 29,595 name another document (789 descriptions, 15%); 4 name nothing, correctly |
| Wrong targets | 0 in a check of 122,423 references across 600 documents |

Reading is where real documents fail, and nearly all of it is in
`@tabnas/yaml` or in jsonic defaults it leaves on:

| Class | Documents | What happens |
|---|---|---|
| YAML 1.1 words (`on`, `off`, `yes`, `no`) | 166 | read as booleans; almost all are `enum` entries, so a string enum becomes a boolean one |
| Numbers outside the core schema (`1_000`, `01009_01`) | 45 | read as other numbers |
| `//` and `/* */` inside a plain scalar | 44 | 32 documents lose the value to `null` (`url: //api.example.com`); 12 are refused |
| Compact nested lists, a list at its key's indent with an empty entry, a scalar on the line after its key, `>+` with a trailing blank line | 15 | a wrong tree; GitHub's own YAML description is one |
| An indented root mapping, a digit-led key with colons, `.042 mg/L` | 7 | refused; three are official OpenAPI Initiative examples |

Resolution within one document is sound on real documents. Its limits
are the 789 descriptions that name other documents, and sources such as
DigitalOcean's that put a `$ref` where the specification allows none
(917 of them, found only under `slots: 'all'`).

### 2.2 Defects the audit found (E8)

The object model has every fixed field of 2.0, 3.0.4, 3.1.2 and 3.2.0,
the 3.2 additions included. The audit's probes found these, each
re-run and confirmed:

| | Defect | Effect |
|---|---|---|
| W1 | A reference whose pointer passes through another reference reads the resolved value, where RFC 6901 reads the document | the wrong member, silently |
| W2 | A schema that references its own `$defs`, the usual shape of a bundled schema | cut as a cycle, with every reference to it |
| W3 | A target is typed by its own position only. A reference into an extension, into `definitions` or `dependencies` in a 3.1 schema, or into a 3.0 component whose name the pattern refuses | the target comes back with the references inside it as written, reported as resolved |
| W4 | A schema that declares draft-07, 2019-09, `…/2020-12/schema#` or a custom dialect | every reference under it is left as written |
| W5 | URIs that differ in case of scheme or host, a default port, or a percent-encoded letter | a same-document reference read as another document |
| W6 | Nesting and reference hops past 1,000 | an `expr` error, not this package's |
| W7 | YAML aliases are copied without limit | 408 bytes take 268 MB; 467 bytes kill the process |
| W8 | Integers past 2^53, such as int64 limits | lose precision, on both paths |
| W9 | A trailing empty YAML document; a byte-order mark under `strict`; CR-only line breaks; JSON text after a blank line on the grammar path | a valid document refused |

Missing rather than wrong: resolution across documents; the implicit
discriminator mapping; a check that a target has the type its reference
expects; bundling; and the reading rules for an operation (inherited
parameters, servers and security).

### 2.3 What apidef needs (E9)

With apidef's resolver deleted and `resolve(raw, { compat: 'apidef' })`
in its place, 2,473 of apidef's 2,475 tests pass, one is skipped as
before, and one fails: a path written twice, which apidef's base grammar
merges and this package reads as its last value. Its guide and model are
byte-identical on all 54 definitions and on the GitHub description.
Replacing its cycle markers with `cycles: 'cut'` works now.

Each remaining hand-written step needs something here before it can go:

| apidef step | Needs |
|---|---|
| the repeated-key merge | a `parse` option, or apidef accepts last wins (Decision 6) |
| `validateSource` | a code for text with no content |
| `validateAliases` and `yamlalias.ts` | an alias budget; without the guard apidef's suite runs out of memory |
| `wellFormed` | an option that reads a lone surrogate as U+FFFD |
| `normalizePathKeys` | a yaml fix: an explicit key with a lone-surrogate escape keeps its quotes |
| `dropIgnoredHeaders` | a report of the header parameters the specification says to ignore |

Two blockers are not code. `@tabnas/openapi` is not on npm. And it
declares `@tabnas/expr` as `>=0`, where `fold` first shipped in 0.5.20:
apidef's lockfile resolves 0.5.10 and `resolve` fails there.

apidef's later stages write on the parsed tree and compare objects by
identity, so the per-site copies of `sharing: 'site'` and the `x-ref`
member are a contract, not a convenience.

### 2.4 What aless needs (E10)

aless builds one tree per file, eagerly, and keys folds, search, copied
paths and reloads by a node's path in that tree. It would not use a
resolved tree: it needs a table that points back into the tree as
written, so that a reference can show the target's own nodes. The
package's `provenance` report is most of that table. Missing:

| | Need | Today |
|---|---|---|
| A1 | the location a reference lands on, in the tree as written, and the end of a chain | `target` is the pointer as written, which may not exist in that tree |
| A2 | what each member beside `$ref` does: ignored, overrides, applied beside the target, merged | visible only through the combined value |
| A3 | for a reference into another document, the resolved URI and the fragment | `external`, nothing more |
| A4 | whether opening a reference leads back to it, whatever order the document is walked in | `cut` marks one edge, in walk order |
| A5 | which references name a location | derivable, wrong where a pointer passes through a reference |
| A6 | the table alone, with no resolved tree built | `resolve` builds the tree (about 0.4 s and 30 MB on the GitHub description; a bare walk is about 0.1 s) |
| A7 | how large a target is when written out in full, so that "unfold everything" can refuse | not available; 5.5 times the document on GitHub |
| A8 | the same answers on a tree aless parsed itself | true for `resolve`, but `parse` differs from the base grammars on a repeated key and on a stream |

## 3. The design change: one reference map

Today `resolve` works out what a reference names while it builds the
resolved tree, inside the fold. Three consumers need that answer without
the tree, or before it: a viewer, which shows the document as written
and opens a reference in place; the loader, which must know which other
documents a description names before anything is resolved; and apidef's
reference counting. Three of the defects in section 2.2 (W1, W2, W3)
come from deciding inside the fold.

So the plan adds one pass before the fold and makes it the single
statement of what every reference names. `references(tree, options)` is
a working name:

```ts
const map = references(tree, { version: 'auto', retrievalUri, slots: 'spec' })
// map.sites: one row per reference site, in document order
// {
//   at,              // RFC 6901 pointer of the site, in the tree as written
//   ref,             // the reference as written
//   kind, type,      // as `provenance` has them today
//   uri, fragment,   // the reference resolved against its base
//   landing,         // the location it names in the tree as written, or null
//   via,             // the references its pointer passed through to get there
//   final,           // the landing at the end of a chain of references
//   status, why,     // resolved, or left as written and why
//   siblings,        // [{ name, role }]: ignored | overrides | applied | merged | conflict
//   cyclic, loop,    // opening it leads back to it; a loop of references alone
//   size,            // values in the target written out in full, capped
// }
// map.uses(location)        the sites that land on a location, chains included
// map.land(fragment, type)  where a reference from another document lands here
```

The map takes a tree, not text, so it holds for a tree a viewer parsed
itself. It builds no resolved value. Its rows are plain data, so shared
fixtures can pin them.

Three rules change with it, each a decision:

- **A pointer is read on the document as written.** Where a step is
  missing at a reference, the walk goes on in what that reference names,
  and the row's `via` says so. This repairs W1 and W2 and keeps apidef's
  chains (Decision 7).
- **A location the object model does not type takes the type of the
  first reference to it**, in document order, as Appendix G of the
  specification describes; a later reference of another type is reported
  as a conflict. This repairs W3 and is what makes a fragment document
  readable in section 4's T4 (Decision 8).
- **`cyclic` is a property of the graph, not of the walk**: a site is
  cyclic when it is in, or reaches, a strongly connected set of targets.

`resolve` is then rebuilt on the map: its `evaluate` takes a site's
landing from the map and asks the fold for the value there. The fold
stays `expr`'s. `expr` gains one thing, a way to fold a location as
written without reading through the references above it (section 7).
`provenance`, `unresolved` and `cuts` become views of the map, so the
two cannot disagree.

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
   the network and about 26 minutes. **Decision 12:** the reference YAML
   parser as a development dependency of that tool.
2. **The ledger.** `test/corpus/ledger.tsv`: one row per document that
   fails, with its class. Today it holds the rows of section 2.1. A
   number that moves is a fix or a regression, and the ledger moves in
   the same commit.
3. **The consumer gate.** A script that runs apidef's suite and model
   comparison against this working tree, as E9 did, with no wiring
   committed. Every later phase runs it.
4. **Fixture homes.** `test/resolve/` and `test/model/` are read by the
   TypeScript runner only. `test/spec/` is read by every runner in the
   repository, so a row there must pass everywhere. Behaviour that only
   the TypeScript package has goes in a new `test/pending/`, with its own
   runner; section 5 has the rule.

Acceptance: the sweep reproduces section 2.1 from a clean checkout; the
consumer gate reports 2,473 passing.

### T1: reading (M here, M to L in `@tabnas/yaml`)

Every valid text gives the right tree, and a hostile one gives a code.

1. **In `@tabnas/yaml`** (section 7 lists each; Decision 2 says how they
   land): comment syntax off inside YAML; a YAML 1.2 core option for
   plain scalars and numbers; the seven grammar defects of section 2.1;
   an alias budget with a coded error; the explicit key that keeps its
   quotes; CR-only line breaks, JSON after a blank line, tab
   indentation refused; memory per byte of input.
2. **Here, `parse` options and codes:**
   - `scalars`: the core schema by default, today's reading on request
     (Decision 4);
   - `aliasBudget`, default the larger of 1 MB and ten times the input,
     raising `openapi_alias_budget`;
   - `duplicates: 'last' | 'merge'` (Decision 6);
   - `wellFormed`: a lone surrogate in a key or a string becomes U+FFFD;
   - `openapi_empty` for text with no content: empty, white space, or
     comments alone;
   - a trailing empty document accepted; a byte-order mark accepted
     under `strict`;
   - bytes as input, decoded by their byte-order mark, which the loader
     of T4 needs.
3. **Numbers past 2^53** (Decision 5): the tree stays plain, and a
   `lossy` report lists each such number with its source text.
4. **Memory.** Find where the 840 MB held after a grammar parse of the
   GitHub description lives, and release it. Then the target: the 58 MB
   Microsoft Graph description parses in Node's default heap, or is
   refused with a code before the process dies.

Acceptance: in the sweep, no valid description refused, no tree
difference outside the ledger, and each ledger row has a reason; the
467-byte alias document is refused with a code in under a second;
apidef's five surrogate rows and its alias row pass on this package's
options alone.

### T2: the reference map, and `resolve` on it (L)

1. **Prototype E11 first**: the index pass over Stripe, GitHub, apidef's
   definitions and the E8 probes, with its recorded result, before any
   source changes.
2. **The map** of section 3: rows, `uses`, `land`, sizes; valid on a
   tree from the base grammars; a step budget, so that a caller can
   bound or cancel it.
3. **`expr`:** fold a location as written; the budget hook; depth past
   the bound surfaced here as `openapi_depth` (section 7).
4. **`resolve` on the map.** W1 to W6 repaired. Dialects by Decision 9:
   draft-04, draft-06, draft-07 and 2019-09 read by their own sibling
   rule, identifiers normalised, an unknown dialect read as 2020-12 and
   reported. URIs normalised before comparison. A 3.0 component name
   outside the pattern typed as its map types it.
5. **Reports the audit found missing**: the implicit discriminator
   mapping, a target whose type is not the one its reference expects,
   and the URL-valued fields (`externalValue`, `externalDocs.url` and
   the like) as absolute URIs, never loaded.
6. **Fixtures**: `test/resolve/map-*.tsv` for every item of section 2.4;
   a row for every probe of E8; the JSON Schema test suite's `$ref`,
   `$id`, `$anchor` and `$dynamicAnchor` cases, vendored with a notice;
   a reload fixture (a member inserted above a site moves the table by
   location only).

Acceptance: every fixture green; the consumer gate unchanged; the
Stripe and GitHub censuses in `AGENTS.md` unchanged, or each change
explained; the map of the GitHub description in under a quarter of a second
from a parsed tree, with no resolved tree built; in the sweep, no reference
`not-found` whose target exists.

### T3: apidef moves over (S here, M in apidef)

It can start when T1 is released; it does not wait for T2.

1. **Here:** the peer ranges state what the package needs (Decision
   11); the report of ignored header parameters, `ignored`, with
   `ignoredHeaders: 'keep' | 'drop'`; `siblings` on each `provenance`
   row; the three passages that say the preset gives exactly apidef's
   tree corrected (Decision 13).
2. **The first npm release** (Decision 1).
3. **In apidef**, each step shippable alone, as E9 lists them: repair
   its error wrapping; swap in `parse` and `resolve`; `cycles: 'cut'`
   in place of its markers; drop `validateSource`, `validateAliases`
   and `yamlalias.ts`; drop `wellFormed`; drop `normalizePathKeys`;
   read ignored headers from the report. Its dependency changes are its
   maintainer's, and E9 lists what each step would need.

Acceptance: G2's measure.

### T4: several documents (L)

1. **Documents given up front, or loaded.** `documents`, a table from
   URI to text, bytes or tree, and an optional `load`. Every document
   provided is parsed and indexed before any reference is judged, as
   the specification requires. One index of `$self`, `$id` and anchors
   spans them, so a reference to an identifier is met by whichever
   document declares it. URIs are normalised, so one document reached
   by two spellings is one document.
2. **The map across documents.** A site's `landing` may be in another
   document. Discovery is the map's own output: the documents a map
   names are loaded, mapped, and so on, within the budgets.
   `resolveAll` is the asynchronous form; `resolve` stays synchronous,
   given the table.
3. **Fragment documents.** A file whose root is neither a description
   nor a schema, such as a map of schemas, is typed by the reference
   that reaches into it (T2's rule). A schema document with no
   `$schema` takes the OpenAPI dialect. A document of another version
   than the entry is read by its own version.
4. **Loaders** (Decision 10). None by default. Offered, each opt-in: a
   file loader confined to a root directory, and an HTTP loader with an
   allow-list that is checked again after a redirect, refuses private
   addresses, and takes a byte cap, a timeout and a cancel signal.
   Credentials never cross an origin.
5. **Implicit connections across documents**, as the specification
   recommends: components and tags from the entry document,
   `operationId` from all, security names before URIs.
6. **Sources that put `$ref` anywhere**: under `slots: 'all'` the same
   machinery reads DigitalOcean's layout.
7. **Fixtures** in `test/docs/<case>/`, each a small set of files with
   an entry and a retrieval URI.

Acceptance: the specification's multi-document examples resolve; the
Azure sample, Redocly's starter and DigitalOcean's source resolve from
their roots with nothing left as written that exists on disk; a
reference outside the allow-list is refused with `openapi_load`; the
walk stops at its budgets.

### T5: beyond references (M each, to the scope of Decision 3)

1. **The operation as the specification reads it.** An opt-in view of
   each operation: its parameters after the Path Item's are inherited
   and overridden by name and location, with the three reserved headers
   marked; its servers and security after inheritance; for 2.0, its
   `consumes`, `produces` and `schemes`. Path templates that differ
   only in a parameter's name are reported.
2. **The embedded languages**, the earlier plan's Phase 4 unchanged:
   `readExpression`, `readTemplate`, their static checks in
   `connections`, and `evaluateExpression`.
3. **Bundling.** Several documents written as one: outside references
   rewritten to components or `$defs`, names kept apart, `$id`
   resources kept. JSON out, through `inline-once`.

### T6: finish (S to M)

1. The four documentation pages cover everything above, and the prose
   gate is green.
2. `tabnas.plugin.json` still describes the template this repository
   was made from. It is stamped by admin, so the change is admin's.
3. The conformance statement: which corpora, how many documents, how
   many agree, and the ledger.
4. The hand-off: every behaviour of T1 to T5 is pinned by a fixture
   that carries no TypeScript in it, and `DIVERGENCE.md` lists each
   place the TypeScript package is ahead. That list is the brief for
   porting.

## 5. Keeping the repository consistent meanwhile

This repository's continuous integration runs every suite it holds, and
`test/spec/` is shared by all of them. While the TypeScript package
moves ahead:

- New behaviour is pinned in `test/resolve/`, `test/model/`,
  `test/docs/` or `test/pending/`, never by a new row in `test/spec/`.
- Where the TypeScript package changes what an existing `test/spec/`
  row expects, the row moves to `test/pending/` with its new value, and
  `DIVERGENCE.md` records the difference and its repair direction.
- No TypeScript-only change may turn another suite red. The full
  `make test` stays the gate for every pull request.
- A change reaches `test/spec/` only when it arrives for every runner
  at once, as a released `@tabnas/yaml` does.

## 6. Decisions for the maintainer

| | Decision | Default the plan takes |
|---|---|---|
| 1 | Publish `@tabnas/openapi` to npm before porting, so that apidef can depend on it. A release publishes the repository at one version; everything but the TypeScript package would go out as it stands | yes, a 0.x once T1 is in |
| 2 | The `@tabnas/yaml` and `@tabnas/expr` changes of section 7 fall under those repositories' own rules, which hold every runtime there to shared fixtures | follow each repository's rules; each change its own pull request and release there, on instruction |
| 3 | What "handle" covers beyond references | the operation view, the embedded languages and bundling to JSON are in; writing YAML back with its layout is out |
| 4 | Plain scalars in YAML | the YAML 1.2 core schema by default, as 3.2 requires; `scalars: 'legacy'` keeps today's reading; merge keys stay |
| 5 | Integers past 2^53 | the tree unchanged and a `lossy` report with the source text; no BigInt in the tree |
| 6 | A repeated member name | `duplicates: 'merge'` added, and the apidef preset documented with it; last wins stays the default |
| 7 | A pointer that passes through a reference | the document first, then through the reference, reported in `via` |
| 8 | A target the object model does not type | typed by the first reference to it; a conflict reported |
| 9 | Schema dialects | draft-04, 06, 07 and 2019-09 read; an unknown dialect read as 2020-12 and reported |
| 10 | Loaders | a confined file loader and an allow-listed HTTP loader, both opt-in; nothing loads by default |
| 11 | Peer ranges of this package | each floor at the first release that has what the package calls: `@tabnas/expr` 0.5.20 for `fold` |
| 12 | A reference YAML parser for the corpus tool | the npm `yaml` package, pinned exactly, a development dependency of the tool only |
| 13 | The apidef preset resolves three kinds of reference apidef leaves as written (anchors, a pointer under an `$id`, a percent-encoded pointer) | keep the behaviour and correct the wording |
| 14 | Leniency: a trailing empty document, a byte-order mark under `strict`, a 3.0 component name outside the pattern, a version this package does not know read as the latest, the specification's text over its schema where they differ | accept each, and report where a report exists |
| 15 | Who carries apidef's changes | this plan lists them; `voxgig/apidef` is not attached to the sessions that work here |

aless's own decisions belong in a decision record there, since
expanding references would be its first behaviour particular to one
format. E10 lists ten with a recommendation for each. The reader's side
needs only two of them settled: an opened reference shows its target
as written, with the members beside `$ref` marked by role and never a
merged value; and nothing loads another file unless the user asks.

## 7. Work in other repositories

| Repository | Change | Needed by | Size |
|---|---|---|---|
| yaml | `//` and `/* */` are not comments in YAML | T1; 44 documents | S |
| yaml | a plain-scalar option for the YAML 1.2 core schema: the 1.1 words, `_` in numbers, binary, signed hexadecimal, `Infinity` | T1; 211 documents | S to M |
| yaml | an indented root mapping; a digit-led key with colons and a block value; `.5 x` | T1; 7 documents | S each |
| yaml | compact nested lists; a list at its key's indent with an empty entry; a scalar on the line after its key; `>+` with a trailing blank line | T1; 15 documents | S each |
| yaml | a budget on alias expansion, with a coded error | T1, T3 | S |
| yaml | an explicit key with a lone-surrogate escape keeps its quotes | T3 | S |
| yaml | CR-only line breaks; JSON text after a blank first line; tab indentation refused | T1 | S each |
| yaml, parser | memory per byte of YAML, and what a finished parse leaves on the instance | T1 | M, after measurement |
| expr | fold a location as written, not through the references above it | T2 | S |
| expr | a step budget; the depth error catchable by its code | T2 | S |
| apidef | the steps of T3 | G2 | M |
| aless | its decision record; adoption after porting | G3 | outside this plan |
| admin | the descriptor and its rollout row | T6 | S |

## 8. Risks

| Risk | Mitigation |
|---|---|
| The map and the fold disagree about a reference | `resolve` reads the map, and the reports are views of it; the E11 prototype runs both over Stripe and GitHub before the source changes |
| The rebuilt `resolve` changes apidef's output | the consumer gate on every pull request; the `apidef` fixture; byte-identical models as the measure |
| The yaml changes wait on that repository's own gates | they are small and independent; T2 does not depend on them; the ledger shows progress row by row |
| A default that changes (scalars, pointers, dialects) surprises a consumer | each is an option with the old reading available; the release notes name each; apidef moves with the old reading and turns each on by measurement |
| Publishing ahead leaves the package's other parts behind the TypeScript one | Decision 1 is explicit; `DIVERGENCE.md` lists every difference |
| Memory on very large YAML cannot be brought under the default heap | a coded refusal before the limit, and the figure in the reference page |
| T5 grows without bound | Decision 3 fixes its scope; each item is opt-in and separate |
| The loader is a file-read or request-forgery vector | nothing loads by default; the offered loaders are confined, allow-listed and budgeted |

## 9. Sequence

```
T0  gates                                S-M   first
T1  reading (+ yaml)                     M     ─┬─ the first release (Decision 1)
T3  apidef moves over                    S+M    │   starts at that release       -> G2
T2  the reference map, resolve on it     L     ─┘   alongside T3                 -> G3, G1 (a), (b), (d)
T4  several documents                    L                                       -> G1 (c)
T5  beyond references                    M each                                  -> G1 (e)
T6  finish                               S-M                                     -> the brief for porting
```

T1 and T2 have no dependency on each other and can run side by side.
T4 needs T2. T5's first item needs T2, its third needs T4.

## 10. Verification at each step

```sh
(cd ts && npm test)                       # the TypeScript suite, shared and pending fixtures
make test                                 # every suite in the repository stays green
node tools/corpus/sweep.cjs               # the corpus, with progress lines; then the ledger diff
node tools/consumer-gate.cjs              # apidef's suite and models against this tree
```

A phase is complete when its fixtures are green, its acceptance line
holds, the ledger and `DIVERGENCE.md` say what changed, and its
documentation page says what the code does.
