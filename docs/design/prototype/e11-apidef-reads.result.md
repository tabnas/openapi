# E11: the documents the sweep flagged, through apidef

A measurement for [`../typescript-plan.md`](../typescript-plan.md),
taken on 12 November 2026. The scripts are in
[`e11-apidef-reads/`](e11-apidef-reads/).

## The question

E7 found 19 valid descriptions that `@tabnas/openapi` refuses and 233
documents whose tree differs from a reference parser's. `voxgig/apidef`
reads through the same base grammars. So are those apidef's defects
too, and if they are, why are they not known there?

## What was run

1. **apidef's own reader** over the 254 documents E7 flagged (233 that
   differ, 20 refused, 1 that ran out of memory). The reader is
   `Jsonic.make().use(Yaml)`, as apidef's `ts/src/parse.ts` builds it,
   at the versions apidef's lockfile installs: `@tabnas/yaml` 0.5.15,
   `@tabnas/jsonic` 0.7.1, `@tabnas/parser` 0.12.2.
   `apidef-reader.cjs` stands in for this package in E7's sweep.
2. **apidef's output**, for each flagged document up to 1 MB (219 of
   the 254). apidef's pipeline, unchanged, built its guide and model
   twice: from the document as written, and from the same document
   re-read by the reference parser (the npm `yaml` package, core
   schema) and handed over as JSON text. The comparison leaves out the
   copies of the input the guide carries under keys ending in `$`.
   `model-compare.cjs` runs it and `summarise.cjs` tallies it.
3. **This package with two engine options** set on the parser `make`
   builds: `comment.def.slash` and `comment.def.multi` off, and
   `number.sep` unset. `with-options.cjs` stands in for the package in
   E7's sweep over the same 254 documents, and `reading-options.cjs` is
   the same question on twelve small cases.

## Results

### 1. apidef's reader misreads the same documents

| | This package | apidef's reader |
|---|---|---|
| Refused | 20: 19 valid descriptions, and one list that is not a description | the same 19; it has no check on the root |
| Out of memory | 1 (58 MB) | the same 1 |
| Tree differs from the reference | 233 | the same 233 |
| YAML 1.1 words read as booleans | 166 | 166 |
| `_` read as part of a number | 45 | 45 |
| A value lost to `//` or `/* */` | 32, each read as `null` | 35: `null` in 10, the member dropped outright in 21, other shapes in the rest |
| Layout defects | 13 | 13 |
| The reference parser's own error | 2 | 2 |

No document differs under one reader and not under the other.

### 2. Most of it never reaches apidef's output

By the kind of difference each document has:

| Kind | Documents | Output the same | Output differs | Not compared |
|---|---|---|---|---|
| YAML 1.1 words, `_` in numbers | 160 | 143 | 15 | 2 (timed out) |
| Comment syntax | 28 | 6 | 22 | 0 |
| Layout defects | 10 | 10 | 0 | 0 |
| The reference parser's own error | 2 | 1 | 1 | 0 |
| Refused | 19 | 1 (the list, which fails both ways) | 18 (no model at all) | 0 |

So of the 198 documents that parse and were compared, apidef's output
is the same in 160 and differs in 38:

| What changes | Documents | Example |
|---|---|---|
| A server URL | 21 | `edrv.io`: the model has `{base}` where the corrected reading gives `https://api.edrv.io`, because `url: //api.edrv.io` is lost |
| An example value | 13 | `adyen.com`: `13008` where the document has the string `1_3008`; `api2cart.com`: `false` where it has `No` |
| A field's `required` flag | 2 | `launchdarkly.com`, `theracingapi.com`: a property named `on` or `off`, listed in `required`, where the list entry is read as a boolean |
| A logo URL | 1 | `rumble.run`: `null` where the document has `//www.rumble.run/img/…` |
| Descriptive text | 1 | `amazonaws.com/kafka`: the reference parser's own error, not apidef's |

apidef's own suite does not exercise any of this: of the 43 OpenAPI
definitions in its `ts/test/def/`, 41 are JSON and 2 are YAML. (An
earlier text of this page said 47 and 45. That counted four generated
`.full.json` files, two of them GraphQL dumps, as definitions.)

### 3. Two options on this package's own parser repair the comment and number kinds

Over the same 254 documents:

| | As shipped | With the two options |
|---|---|---|
| Refused | 20 | 8: the 7 that are `@tabnas/yaml`'s, and the list |
| Tree differs from the reference | 233 | 181 |
| A value lost to comment syntax | 32 | 0 |
| `_` read as part of a number | 45 | 0 |
| YAML 1.1 words | 166 | 166 |
| Layout defects | 13 | 13 |
| Documents that differ only with the options on | | 0 |

The 12 refusals that go are all from comment syntax: `path: /*` in
eleven Azure descriptions, and a key `//openapi:` in one. The seven that
stay are an indented root mapping (3), a digit-led key with colons and a
block value (3), and `.042 mg/L` (1).

`reading-options.cjs` shows the same on small cases. `0b11` still reads
as 3 with `number.bin` off, so that one is not the engine's number
option; no corpus document has it.

## What this does not show

- The 35 flagged documents over 1 MB were not put through apidef's
  pipeline, and two under that size timed out at 180 seconds.
- "Output" is apidef's guide and model with generation off. What an SDK
  generated from them would do with a `{base}` server URL was not run.
- The corrected reading is the reference parser's under the core
  schema. Whether OpenAPI should read `yes` and `on` as strings is the
  plan's Decision 21, not a finding.

## Running it again

```sh
# 1. apidef's reader over a manifest of documents (see ../README.md for the corpus)
OPENAPI_DIST=$PWD/e11-apidef-reads/apidef-reader.cjs APIDEF_TS=<apidef>/ts YAML_REF=<scratch>/node_modules/yaml \
  node e7-corpus/driver.cjs flagged.jsonl reads.jsonl --jobs 3

# 2. apidef's output, as written against re-read
APIDEF_TS=<apidef>/ts YAML_REF=<scratch>/node_modules/yaml \
  node e11-apidef-reads/model-compare.cjs flagged.jsonl models.jsonl --jobs 3 --max-bytes 1000000
node e11-apidef-reads/summarise.cjs models.jsonl <E7 results.jsonl>

# 3. this package with the two options
OPENAPI_DIST=$PWD/e11-apidef-reads/with-options.cjs YAML_REF=<scratch>/node_modules/yaml \
  node e7-corpus/driver.cjs flagged.jsonl options.jsonl --jobs 3
node e11-apidef-reads/reading-options.cjs
```

`<apidef>` is a checkout of `voxgig/apidef` (3058271 here), built, with
its dependencies installed. `flagged.jsonl` is the rows of E7's manifest
whose result differs, was refused, or died. Each driver prints a
progress line every 15 seconds.
