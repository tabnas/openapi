# apidef's swap

What `voxgig/apidef` changes so that it reads and resolves an OpenAPI
description with this package. This is step 2 of T1 in
[`../typescript-plan.md`](../typescript-plan.md). The change is kept here
as two diffs until it can live on a branch of apidef, which is the plan's
Decision 20 and is the maintainer's to take.

Both diffs are against apidef at `3b24341`, and the second applies after
the first:

| Diff | What it changes |
|---|---|
| [`1-error-wrapping.diff`](1-error-wrapping.diff) | The two faults in how apidef's parse stage wraps an error. It needs nothing from this package, so it can go to apidef by itself |
| [`2-swap.diff`](2-swap.diff) | `parse` and `resolve` from `@tabnas/openapi` in place of apidef's own reader and resolver. Every other step of its parse stage stays |

They hold source and fixtures only. apidef commits its build, so a commit
made from either also carries `ts/dist`, from `npm run build` in apidef's
`ts/`.

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
headers, and `decycle` with its markers all stay as they were.

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
  --patch docs/design/apidef-swap/2-swap.diff
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
with 3, since apidef does not import this package until the second.

The preset itself is held to apidef's resolver by
`tools/apidef-preset.cjs`, document by document. That comparison needs
apidef's resolver, which the swap deletes, so it is run against apidef
without these diffs.

## The commits

When the change goes to apidef it is two commits, one for each diff, with
these subjects:

1. `Say syntax for a syntax error, and prefix apidef's own parse errors once`
2. `Read and resolve OpenAPI definitions with @tabnas/openapi`

The second cannot merge until `@tabnas/openapi` is released and apidef's
`ts/package.json` names it.
