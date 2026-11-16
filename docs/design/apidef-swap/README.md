# apidef's swap

What `voxgig/apidef` changes so that it reads and resolves an OpenAPI
description with this package. This is apidef's side of T1 and T2 in
[`../typescript-plan.md`](../typescript-plan.md). The change is kept here
as three diffs until it can live on a branch of apidef, which is the
plan's Decision 20 and is the maintainer's to take.

The diffs are against apidef at `3b24341`, and each applies after the one
before it:

| Diff | What it changes |
|---|---|
| [`1-error-wrapping.diff`](1-error-wrapping.diff) | The two faults in how apidef's parse stage wraps an error. It needs nothing from this package, so it can go to apidef by itself |
| [`2-swap.diff`](2-swap.diff) | `parse` and `resolve` from `@tabnas/openapi` in place of apidef's own reader and resolver. Every other step of its parse stage stays |
| [`3-source-checks.diff`](3-source-checks.diff) | The checks apidef made on the text before reading it, and its repair of lone surrogates, taken from this package in place of apidef's own |

They hold source and fixtures only. apidef commits its build, so a commit
made from any of them also carries `ts/dist`, from `npm run build` in
apidef's `ts/`.

## What each diff does

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
diff. The third takes the first two and `wellFormed`.

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
the other implementation named the file this diff deletes, and is
reworded.

Two sources read differently after this diff, both of them texts with
nothing in them:

| Source | Before | After |
|---|---|---|
| Only `//` or `/* */` comments | `JSON/YAML source must be an object` | `OpenAPI: source is empty` |
| Only a YAML document end, `...` | `JSON/YAML source must be an object` | `OpenAPI: source is empty` |

Both are refused before and after. apidef's fixtures pin neither.

## What the diffs leave out

Neither diff touches apidef's manifests. `@tabnas/openapi` is not
published, so apidef cannot declare it yet, and the gate runs apidef
against this checkout through a link at
`ts/node_modules/@tabnas/openapi`. After the swap apidef's source no
longer imports `@tabnas/yaml`. Declaring the one and dropping the other
are dependency changes, which apidef's maintainer instructs when this
package is released.

apidef has a second implementation of its parser, which this change does
not touch. Its fixtures still pass, because apidef's output does not
move.

## How it is proven

From this repository's root, with apidef cloned beside it and its
dependencies installed:

```bash
node tools/apidef-gate.cjs ../apidef \
  --patch docs/design/apidef-swap/1-error-wrapping.diff \
  --patch docs/design/apidef-swap/2-swap.diff \
  --patch docs/design/apidef-swap/3-source-checks.diff
```

The gate applies the diffs to a worktree of the apidef checkout's commit,
builds it, runs apidef's suite there against this checkout's build, and
compares apidef's guide and model with those of the same commit
unpatched. A diff that no longer applies stops the gate before anything
runs, and is to be made again at apidef's new commit.

At apidef `3b24341` the gate passes with nothing allowed to fail: 2,478
tests, 2,477 passing, none failing and one skipped, as on apidef's
`main`. apidef's guide and model are byte-identical for all 45
definitions the gate compares by itself, which are apidef's 43 and this
repository's two, and for the twelve more that the plan's G2 names,
given with `--extra`.

With the first diff alone the suite passes the same, and the gate ends
with 3, since apidef does not import this package until the second. With
the first two, or with all three, the result is the one above.

The preset itself is held to apidef's resolver by
`tools/apidef-preset.cjs`, document by document. That comparison needs
apidef's resolver, which the swap deletes, so it is run against apidef
without these diffs.

## The commits

When the change goes to apidef it is three commits, one for each diff,
with these subjects:

1. `Say syntax for a syntax error, and prefix apidef's own parse errors once`
2. `Read and resolve OpenAPI definitions with @tabnas/openapi`
3. `Take the source checks, the alias limit and the surrogate repair from @tabnas/openapi`

The second and third cannot merge until `@tabnas/openapi` is released and
apidef's `ts/package.json` names it.
