# apidef's swap

What `voxgig/apidef` changes so that it reads and resolves an OpenAPI
description with this package. This is apidef's side of T1, T2 and the
first item of T5 in [`../typescript-plan.md`](../typescript-plan.md).

The change lives in apidef, on its branch `claude/jolly-maxwell-jhjgus`,
as the pull request voxgig/apidef#230. That is the plan's Decision 20,
taken on 20 November 2026: a pushed branch of apidef, proven by the gate
here, and merged after this package's first release. Until 21 November
2026 the change was kept in this folder as three diffs against apidef
at `3b24341`. The branch's first three commits are those diffs, each with
the build apidef commits beside its source. The two after them merge
apidef's `main`, the second at `00778c4`, which is apidef 8.33.1.

| Commit | What it changes |
|---|---|
| `Say syntax for a syntax error, and prefix apidef's own parse errors once` | The two faults in how apidef's parse stage wraps an error. It needs nothing from this package, so it can go to apidef's `main` by itself |
| `Read and resolve OpenAPI definitions with @tabnas/openapi` | `parse` and `resolve` from `@tabnas/openapi` in place of apidef's own reader and resolver. Every other step of its parse stage stays |
| `Take the source checks, the alias limit and the surrogate repair from @tabnas/openapi` | The checks apidef made on the text before reading it, and its repair of lone surrogates, taken from this package in place of apidef's own |
| `Drop the ignored headers the reader lists` | Which header parameters OpenAPI says to ignore is read from the `ignored` report of `resolve`, in place of apidef's own search of the paths. It follows the merges of apidef's `main` |

Against apidef's `main` the branch changes five files of source and
fixtures: `ts/src/parse.ts`, `ts/src/yamlalias.ts`, which goes,
`ts/test/tsv.test.ts`, `test/parse-errors.tsv`, and one comment in the
other implementation. apidef commits its build, so the branch also
carries `ts/dist` and `ts/dist-test` as `npm run build` in apidef's
`ts/` makes them.

## What each commit does

**The error wrapping.** apidef's parse stage wrapped every failure of the
reader in two ways that did not hold:

- The branch for a syntax error never ran. It looked for an
  `originalError`, or a code starting `jsonic`, and the reader's errors
  carry neither: the code is the bare name, such as `unexpected`. So a
  syntax error read `@voxgig/apidef: parse: internal: ...`, and the test
  that expects `syntax` passed only because the reader's hint text holds
  that word. A reader's refusal is now told by its code.
- apidef's own errors were prefixed twice. `JSON/YAML source must be an
  object` and `Unsupported spec` are thrown with the package's prefix and
  then gained a second one. They now keep the one, and gain the file.

`test/parse-errors.tsv` gains three rows for those messages. Both of
apidef's suites run that file, and both pass.

**The swap.** In apidef's `ts/src/parse.ts`:

- `parse(source, { duplicates: 'merge' })` reads the text. A member name
  given twice still merges, so the operations of one path written twice
  still merge.
- `resolve(parsed, { compat: 'apidef' }).tree` resolves it.
- A root that is not a map, and a stream of several documents, still read
  `JSON/YAML source must be an object`: the codes `openapi_root` and
  `openapi_stream` are mapped to it.
- apidef's resolver goes: eight functions and a constant, 109 lines.

The source and alias checks, the version check, `wellFormed`, the
`components` default, the path keys, colon path parameters, ignored
headers, and `decycle` with its markers all stay as they were in this
commit. The third takes the first two and `wellFormed`.

**The source checks.** Before it read an OpenAPI text, apidef checked it
twice, and after reading it repaired the tree once. All three are now
this package's:

- *The empty source.* apidef's `validateSource` refused a text of white
  space and `#` comments alone. `parse` refuses the same text as
  `openapi_root`, with `details.kind` of `empty`, and apidef maps that to
  its message, `OpenAPI: source is empty`. `validateSource` is no longer
  called for OpenAPI. The function stays, because apidef's GraphQL reader
  calls it. Its pattern takes time that grows with the square of a run of
  blank lines: 160,000 line breaks take it 17 seconds. `parse` makes the
  same test in one pass, so an OpenAPI source no longer meets that, and
  a GraphQL source still does.
- *The alias limit.* apidef's `validateAliases` measured what the text
  comes to once every YAML alias is copied in, and refused one past ten
  times its size or a megabyte, whichever is larger. `parse` holds a text
  to the same budget by default and refuses with `openapi_alias_budget`,
  which apidef maps to its message with the two sizes from the error's
  `details`. `validateAliases` goes, and so does `ts/src/yamlalias.ts`,
  the scan it used: `aliasedSize` here is that scan, with the work it
  repeats counted, so that a text built to make the scan itself slow is
  refused as well.

  apidef's own guard lets two shapes of alias bomb through on its
  `main`, and this commit closes both. Its scan reads the text as YAML,
  and apidef's reader also takes the comments of JSON with comments:
  after `components: /*`, a line `|` and a line `*/`, the scan takes
  what follows for a block scalar and finds no alias, while the reader
  copies. Ten references to a list of ten, four levels deep, are 322
  bytes that apidef's `main` measures as 322 and reads into a tree of
  380,301 characters; seven levels would be a thousand times that. And a
  tag between an anchor and its collection, `&a !!map {`, ends the
  anchor at its line for the scan: 500 bytes measured as 940, and read
  into 530,890 characters. `parse` measures the second shape rightly,
  and holds every copy the grammar makes to the budget as it is made,
  which stops the first and any other text the scan and the reader take
  differently.
- *The surrogate repair.* apidef's `wellFormed` and `wellFormedString`
  go, with their two patterns. `wellFormed(tree, { duplicates: 'merge' })`
  from this package does the same to the tree, and `wellFormed(string)`
  to a path key.

apidef passes `maxBytes: Infinity`. This package's size limit is for a
process whose memory is not known, and apidef has always read whatever
it was given.

apidef's table for the scan, `test/yaml-aliased-size.tsv`, stays, and its
TypeScript suite now runs it against `aliasedSize`. So the two
implementations of the scan are still held to one table. One comment in
the other implementation named the file this commit deletes, and is
reworded.

**The ignored headers.** From 3.0 a header parameter named `Accept`,
`Content-Type` or `Authorization` is to be ignored. apidef's
`dropIgnoredHeaders` searched the resolved tree for them, in each path's
own list and in the lists of eight methods, dropped each, and recorded
it for a warning. Which parameters those are is the specification's to
say, and `resolve` now says it, in `ignored`. So the search goes:

- `resolve(parsed, { compat: 'apidef' })` gives the tree and `ignored`.
- `dropIgnoredHeaders` applies the rows that are apidef's to act on: a
  parameter, under `paths`, in a Path Item's own list or in the list of
  one of the eight methods apidef reads. It drops each by its place in
  its list, and records the path, the method and the name, sorted as
  the search found them: by path, a path's own list first, then the
  methods in apidef's order.
- `normalizeColonPathParams` says which paths it renamed, since it runs
  between the two and a row names a path as the tree had it.

apidef's `main` has since gained a step of its own that follows, which
keeps the first of a repeated parameter and records the rest. The branch
runs it after the headers are dropped, as `main` does. A row names a
parameter by its place in its list as written, so the rows are applied
before any list is cut for another reason.

What apidef does with them is still apidef's: that it drops them, that
it reads eight methods, that it warns. The report also lists the ones
under webhooks and callbacks, under `query` and `additionalOperations`,
and a `Content-Type` header of a response or of an encoding. apidef
passes those by, as its search did.

On the corpus the two agree on every description: 5,238 of them, read
as apidef reads them, give the same list and the same tree. 95 have
such a parameter, 2,388 in all.

Two sources read differently after the third commit, both of them texts
with nothing in them:

| Source | Before | After |
|---|---|---|
| Only `//` or `/* */` comments | `JSON/YAML source must be an object` | `OpenAPI: source is empty` |
| Only a YAML document end, `...` | `JSON/YAML source must be an object` | `OpenAPI: source is empty` |

Both are refused before and after. apidef's fixtures pin neither.

## What the branch leaves out

It does not touch apidef's manifests. `@tabnas/openapi` is not
published, so apidef cannot declare it yet, and the gate runs apidef
against this checkout through a link at
`ts/node_modules/@tabnas/openapi`. After the swap apidef's source
imports neither `@tabnas/jsonic` nor `@tabnas/yaml`, which its parse
stage read with before. Declaring the one, and what becomes of the other
two, are dependency changes, which apidef's maintainer instructs when
this package is released. The sentence of apidef's pages that names the
packages its parse stage reads with changes with them.

So apidef's own build cannot pass on the branch yet. Its workflow
installs published packages, and `ts/src/parse.ts` imports one that is
not published, so the build fails there until the release. That is the
one failure the branch is expected to show. apidef's comment gate and
its dependency gate pass on it.

apidef has a second implementation of its parser, which this change does
not touch, but for the one comment. Its suite passes on the branch,
because apidef's output does not move.

## How it is proven

From this repository's root, with apidef cloned beside it, its branch
checked out and its dependencies installed:

```bash
git -C ../apidef fetch origin main
node tools/apidef-gate.cjs ../apidef --base "$(git -C ../apidef merge-base HEAD origin/main)" \
  --extra docs/design/apidef-swap/definitions/*.json
```

The gate builds two worktrees of the apidef clone, one at the branch and
one at the commit of apidef's `main` that the branch last merged. It
runs apidef's suite in the first against this checkout's build, and
compares apidef's guide and model with those of the second. The base is
that commit, and not wherever `main` has moved to since, so that the two
differ by the swap alone. When apidef's `main` moves, it is merged into
the branch, and the gate is run again.

At apidef `a774fb5`, the branch with `main` merged, against `00778c4`,
the gate passes with nothing allowed to fail: 2,589 tests, 2,588
passing, none failing and one skipped, the one apidef's `main` skips.
apidef's guide and model are byte-identical for all 95 definitions the
gate compares by itself, which are apidef's 93 and this repository's
two, and for the twelve more that the plan's G2 names, given with
`--extra`. That run was on this checkout's build, with its
dependencies as the registry serves them: `@tabnas/expr` 0.6.4, yaml
0.5.34 and parser 0.12.21.

At apidef `ef123d3`, which adds the commit for the ignored headers,
against `25f8d4b`, apidef 8.33.2, the gate passes the same: 2,691 of
2,692 tests, one skipped as on apidef's `main`, and all 110 definitions
byte-identical, the twelve of G2 among them.

At apidef `10cdaed`, which merges apidef's `main` at `895450a`, the gate
passes again: 2,700 of 2,701 tests, one skipped as on apidef's `main`,
and all 110 definitions byte-identical. That `main` keeps the first of a
repeated parameter and records the rest, in a step after the ignored
headers are dropped, and the merge keeps the two in that order.

None of the 110 definitions has a header that apidef ignores or a
parameter that is repeated, so that comparison says nothing of either
step. apidef's own fixture rows hold the two steps, in its suite, which
the gate runs. [`definitions/`](definitions/) adds four descriptions
for the comparison, which the command gives with `--extra`: ignored
headers beside repeated parameters in one list, the same by reference,
the same under a path that apidef renames, and repeats in a 2.0
description, where no header is ignored. apidef drops 17 headers and
20 repeats from them, and its output for each is byte-identical to that
of its `main`.

At apidef `9bceec8`, which merges apidef's `main` at `2ffac75`, apidef
8.33.3, the gate passes the same: 2,734 of 2,735 tests, one skipped as
on apidef's `main`, and all 120 definitions byte-identical. Those are
the 104 the gate compares by itself, six of which apidef had added, the
twelve of G2, and the four here. None of the six has a header that
apidef ignores or a parameter that is repeated either.

At apidef `3186c51`, which merges apidef 8.34.0 at `46c33ab`, the same
again: 2,734 of 2,735 tests and all 120 definitions byte-identical.
That release moved apidef's version and nothing else.

At apidef `9549a6c`, which merges apidef 8.34.1 at `259e4c3`, the same
once more: 2,734 of 2,735 tests and all 120 definitions byte-identical.
That release changes how apidef's guide reads a version segment inside
a path, which is after its parse stage, and the merge had no conflict.

At apidef `3b24341`, where the change was made, the three diffs gave
the same result on the suite and definitions apidef had then: 2,477 of
2,478 tests, and 57 definitions. With the first of them alone the suite
passed the same and the gate ended with 3, since apidef does not import
this package until the second.

The preset itself is held to apidef's resolver by
`tools/apidef-preset.cjs`, document by document. That comparison needs
apidef's resolver, which the swap deletes, so it is run against a commit
of apidef's `main`, which keeps that resolver until the branch merges.

## When it merges

After this package's first release, in this order: apidef's
`ts/package.json` names `@tabnas/openapi`, on its maintainer's
instruction; apidef's build passes on the branch; and the branch merges.
Until then each step of the plan that changes what apidef takes from
this package adds a commit to the branch, and the gate above holds it.
