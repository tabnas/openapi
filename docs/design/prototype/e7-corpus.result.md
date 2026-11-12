# E7: a sweep of 8,986 real documents

The report of one research pass for [`../typescript-plan.md`](../typescript-plan.md),
taken on 12 November 2026 against `@tabnas/openapi` 0.1.0 as built from this
repository, and kept as it was written. The scripts are in [`e7-corpus/`](e7-corpus/), with their defaults changed to read this checkout.
A path under `<scratch>` names the working folder of that research session,
which is not kept; a path under `/home/user` names a checkout on the machine
that ran it.

---

## Baseline: @tabnas/openapi 0.1.0 (TypeScript) over 8,986 real documents

I swept 8,986 distinct documents (924 MB) through the package. Of the 5,182 that declare a version, 5,162 parse. Every document in the corpus is valid by the reference parsers, so every rejection is the package refusing valid input. Raw mode has two kinds of defect:
- **Parse rejections:** six classes of valid YAML are refused. 19 documents are hit, plus one that ran out of memory.
- **Silent tree errors:** about 231 documents parse but come back with a wrong tree. Some of this is deliberate YAML 1.1 typing; some is plain bugs, including values silently replaced by `null` and lists restructured.

Resolution looks sound:
- **No errors:** no thrown errors and no false `not-found` results.
- **Correct targets:** 0 target mismatches in a 600-document check of 122,423 references.

Resolution's real limits are references into other documents, and multi-file descriptions that put `$ref` where the specification does not allow it. Nearly every defect is in `@tabnas/yaml`, or in jsonic defaults that it leaves switched on.

The package was run from `/home/user/openapi/ts/dist`, with its installed dependencies: @tabnas/parser 0.12.20, yaml 0.5.32, jsonic 0.7.11 and json 0.5.20. `/home/user/yaml` is also 0.5.32. The machine runs Node v22.23.4, while `engines` asks for 24 or later. No checkout under /home/user was changed. The reference YAML parser is the npm `yaml` package 2.9.1 (eemeli), installed in the scratch directory only, with YAML 1.2 and the core schema; merge keys were tried separately. PyYAML 6.0.1 was used as a third opinion on spot checks.

## (1) The corpus
Everything is under `<scratch>/corpus/src` (1.1 GB on disk). Identical files were counted once (42 duplicates by SHA-1).

| Source | Docs | Bytes | Descriptions / fragments |
|---|---|---|---|
| APIs-guru openapi-directory, all of `APIs/` (sparse checkout) | 4,138 | 750 MB | 4,138 descriptions: 2.0 ×2,168, 3.0 ×1,863, 3.1 ×107; all YAML |
| OAI `tests/schema` pass and fail, branches v3.1-dev, v3.2-dev, v3.3-dev (no v3.0-dev branch exists) | 46 / 67 / 71 | 134 KB | 3.3-dev documents declare `openapi: 3.3.0`, which `version()` reads as `unknown` |
| OAI main `_archive_/schemas/v3.0/pass` | 6 | 30 KB | 3.0 |
| learn.openapis.org `examples/` | 46 | 175 KB | 23 JSON, 23 YAML; 2.0, 3.0, 3.1, 3.2, plus 8 fragments |
| digitalocean/openapi `specification/` | 3,636 | 3.9 MB | 1 root (3.0), 3,635 fragments |
| Redocly/openapi-starter `openapi/` | 40 | 33 KB | 1 root (3.1), 39 fragments |
| github/rest-api-description | 3 | 36 MB | 3.0 YAML; 3.1 JSON and YAML |
| stripe/openapi `latest/*.yaml` | 2 | 22 MB | 3.0 |
| Azure azure-rest-api-specs: keyvault, storage, compute, monitor, common-types, webpubsub, ai-foundry openapi3 (no `examples/`) | 929 | 89 MB | 881 JSON (875 at 2.0, 4 at 3.2), 48 YAML |
| Already on disk: `census/github.json`, `real-spec-dl/spec3.json` | 2 | 22.5 MB | The 11 files in `census/oai/` duplicate the learn.openapis.org examples |

By version and format:

| Version | YAML | JSON |
|---|---|---|
| 2.0 | 2,176 | 883 |
| 3.0 | 1,879 | 8 |
| 3.1 | 158 | 4 |
| 3.2 | 70 | 4 |
| No version (fragments, 3.3 drafts) | 3,796 | 8 |

YAML feature use, over the 8,079 YAML documents:

| Feature | Documents |
|---|---|
| Anchors | 70 |
| Aliases | 58 |
| `---` marker | 19 |
| Flow collections | 3,544 |
| Block scalars | 3,788 |
| Merge keys | 0 |
| Explicit tags | 0 |
| Multi-document streams | 0 |
| `...`, `%` directives | 0 |
| Non-string keys | 0 |
| Complex keys | 0 |

## (2) Headline numbers
- **Parse:** 8,965 of 8,986 documents parsed.
  - 20 were refused although the reference parser accepts them. One of those is correct: `oas-v3.3-dev/tests/schema/minimal-objects.yaml` is a list of test objects, not a description, and `openapi_root` is right for it.
  - 1 ran out of memory.
  - **0 documents were refused for being invalid**: the reference parsers accept every document in the corpus.
  - Among descriptions: 5,162 parsed, 19 refused though valid, 1 out of memory.
  - All OAI test documents parse, the "fail" ones included. Those fail by schema, not by syntax.
- **JSON:** all 907 JSON documents give the same tree on the grammar path (`fast:false`) as `JSON.parse`. Under `strict`, 899 parse and 8 are refused with `openapi_version`, all of them versionless learn.openapis.org fragments. No duplicate keys were found anywhere.
- **Tree comparison:** 8,965 trees were compared, ignoring key order. 233 differ. 2 of those are the reference parser's own bug (class L), so about 231 are real.

| Class | Documents | Values |
|---|---|---|
| E: YAML 1.1 Boolean words | 166 | 1,036 |
| F: underscore numbers | 45 | 233 |
| A2: comment syntax gives `null` | 32 | 71 |
| H: compact nested lists | 6 | 29 |
| J: scalar on the next line | 6 | 13 |
| I: zero-indented list with an empty entry | 2 | 20 |
| K: `>+` trailing whitespace line | 1 | 1 |
| L: reference parser artifact | 2 | 626 |

- **Resolve:** it ran on the 5,162 parsed descriptions and threw nothing. Versionless documents were skipped (3,803).

| Measure | Count |
|---|---|
| Sites | 1,190,999 |
| Resolved | 1,159,428 |
| Cut | 1,972 (in 601 documents) |
| Unresolved | 29,599 |
| `external` | 29,595 (in 789 documents) |
| `not-found` | 4 |
| `bad-fragment`, `no-anchor`, `unsupported-dialect` | 0 |
| Path Item sites | 13 |
| `$ref` maps read as data | 53,937 (in 893 documents) |

  - The 4 `not-found` references are all in `oas-v3.2-dev/tests/schema/fail/path-item-object-conflicting-additional-operation.yaml`, and their targets really are absent. No resolver bug turned up.
  - The 600-document target check found no mismatch: for every resolved `#/…` reference, the reported target equals its percent-decoded pointer.

## (3) Failure classes
Every repro below was confirmed by running it, and all are in `tools/repros.cjs` (16 fail today, plus one PASS row that guards class L).

**Comment syntax read inside YAML plain scalars** (layer: `@tabnas/yaml`, high confidence). The jsonic base keeps its `comment.def.slash` (`//`) and `comment.def.multi` (`/* */`) switched on, and the YAML grammar does not turn them off. They are in `node_modules/@tabnas/jsonic/dist/defaults.js` lines 85–100. They could also be switched off in `make()` in openapi.ts.
- **A1, refused:** `a: /*` gives `unterminated_comment`. 11 documents: azure cosmos-db (`path: /*`, 7 documents) and frontdoor (`- /*`, 4 documents).
- **A2, silent loss:** `a: //api.example.com/` and `a: /* x */` both give `{"a":null}`. 32 documents, 71 values. Smallest: `APIs/ote-godaddy.com/agreements/1.0.0/openapi.yaml`, `- url: //api.ote-godaddy.com`. Also `description: // Redshift Database` and `sp: //*`.
- **A3, refused:** `a:\n  //x:\n    b: 1` gives `unexpected`. 1 document: clever-cloud.com/1.0.0, with the key `//openapi:`.

**B: indented root mapping** (`@tabnas/yaml`, high). `"  a: 1\n  b: 2\n"` and `"---\n  a: 1\n  b: 2\n"` give `unexpected`. 3 documents: learn.openapis.org `examples/v2.0/yaml/petstore-minimal.yaml`, `petstore-simple.yaml` and `petstore-with-external-docs.yaml`. These are official OAI examples.

**C: a key starting with a digit, containing colons, with a block value** (`@tabnas/yaml`, high). `"a:\n  1:2:\n    b: 1\n"` gives `unexpected`; `1:2: 1` on one line works, and so does `x:y:` with a block value. 3 documents: docker.com/engine/1.33 (`127.0.0.1:5000:`), and meraki.com 0.0.0-streaming and 1.32.0 (`22:33:44:55:66:77:`).

**D: a plain scalar of the form `.digit text`** (`@tabnas/yaml`, high). `a: .5 x` and `a: -.5 x` give `unexpected`, while `5. x`, `+1 x` and `1e3 x` work. The grammar's check for a number followed by text only covers values starting with a digit. 1 document: epa.gov/dfr, `example: .042 mg/L`.

**OOM: memory on very large YAML** (engine and `@tabnas/yaml`, medium on which layer).
- `microsoft.com/graph-beta/1.0.1/openapi.yaml` (58 MB) died in the sweep's 4 GB worker. Run alone with a 12 GB heap it parses in 25 s, peaking at 5.3 GB RSS, and resolves in 5.6 s.
- `microsoft.com/graph/1.0.1` (25.8 MB) parses in 9.8 s at 2.7 GB with a large heap.
- **Both run out of memory under this machine's default Node heap limit of 2,096 MB.** The `yaml` package parses the 58 MB file in that default heap in 21 s, peaking at 2.1 GB.

**E: YAML 1.1 Boolean words** (`@tabnas/yaml` `valMap`, yaml.ts around line 1784; deliberate, and documented in `doc/reference.md`). `on`, `off`, `yes`, `no` and their capitalised forms become Booleans: `a: [on, off, yes, no, On, OFF]` gives `[true,false,true,false,true,false]`. 166 documents, 1,036 values, almost all inside `enum` lists, so string enums turn into Boolean ones. Smallest: `do-openapi/specification/resources/droplets/models/droplet.yml`, `- off`. Whether this is a bug depends on whether the package targets YAML 1.2.

**F: number forms outside the core schema** (jsonic number lexer defaults `sep:'_'`, `bin`, `hex`, which the YAML grammar does not override; high).
- Seen in the corpus: `1_000` becomes 1000, and `00_400` becomes 400. 45 documents, 233 values. Smallest: bclaws.ca/bclaws/1.0.0, `default: 01009_01`.
- Found by probe only: `0b11` becomes 3, `Infinity` and `-Infinity` become numbers, and `+0x1F`/`-0x1F` become ±31. YAML 1.2 core reads all of these as strings.

**H: compact nested lists** (`@tabnas/yaml`, high). `"a:\n- - x\n- - y\n"` gives `[["x - - y"]]`, where the answer is `[["x"],["y"]]`. It fails indented as well. 6 documents: azure machinelearning-webservices, two resourcegraph versions, and mailchimp 3.0.55, where it corrupts an `enum`.

**I: zero-indented lists with an empty entry** (`@tabnas/yaml`, high). This means a list at the same indentation as its key.
- `"a:\n- x\n-\n- y\n"` gives `["x",["y"]]`; the answer is `["x",null,"y"]`.
- `"a:\n- b: 1\n  v:\n- c: 2\n"` gives `[{"b":1,"v":[{"c":2}]}]`; the answer is `[{b:1,v:null},{c:2}]`.
- The indented forms are correct.
- 2 documents, 20 values: GitHub's own `descriptions/…/api.github.com.yaml` and `descriptions-next/…yaml`. It corrupts `enum` lists and examples.

**J: a scalar on the line after its key is always a string** (`@tabnas/yaml`, high). `"a:\n  1\n"` gives `"1"`; `true` and `null` become the strings `"true"` and `"null"`. 6 DigitalOcean fragments, 13 values, all `total:\n  N`.

**K: `>+` with a trailing whitespace-only line** (`@tabnas/yaml`, high). `"a: >+\n  x\n   \nb: 1\n"` gives `"x\n \n\n"`, where the answer is `"x\n \n"`; PyYAML agrees with the reference. 1 document: viator.com/1.0.0, around line 7720.

**L: not a tabnas bug.** In `"a: |2-\n      x\n     \nb: 1\n"`, tabnas and PyYAML keep the indented whitespace line and the `yaml` package drops it. By YAML 1.2.2 §8.1.1.1 the line is content, so tabnas is right. 2 documents: amazonaws.com/kafka (624 values) and one other.

**Supplementary probes** (synthetic, `tools/probe.cjs`). Anchors and aliases, block scalars, quoting, CRLF, BOM, `%YAML`, explicit keys, flow across lines and aliases as keys all match the reference. `!!binary` stays a string. Merge-key members land in a different key order (the values match). Two invalid inputs are accepted: `a: b: c` and backticks. `[1, 2]: v` as a key gives `unexpected`, but no corpus document uses one. Numeric keys keep their source text, so `1.0:` stays `"1.0"`, where the `yaml` package gives `"1"`.

## (4) References to other documents
- **What resolve reported** (29,595 `external`, 789 documents):

| Form | References | Documents |
|---|---|---|
| Relative `.json` with a pointer fragment | 29,566 | 785 |
| Relative `.yaml` without a fragment | 17 | 2 |
| Relative `.json` without a fragment | 8 | 1 |
| Relative `.yaml` with a fragment | 2 | 1 |
| Absolute `https` (example.com, OAI tests) | 2 | 2 |

  - By target: 29,155 name another OpenAPI document (Azure 2.0 cross-file references, 581 documents). 409 name files absent from APIs-guru (203 documents). 16 name schema fragments, 9 path-item fragments, 4 maps of definitions.
  - By source: Azure 581, APIs-guru 203, Redocly 1, learn.openapis.org 2, OAI tests 2.
- **Every non-local `$ref` text in all documents, fragments included.** This is a regex census, so it is approximate.

| Form | References | Documents |
|---|---|---|
| Relative `.json#/ptr` | 29,586 | 785 |
| Relative `.json` | 17,307 | 696 |
| Relative `.yml` | 8,955 | 1,487 |
| Relative `.yml#/ptr` | 4,295 | 1,245 |
| Relative `.yaml` | about 117 | 27 |
| `http(s)` | 4 | 4 |
| Code samples (`.cs`, `.php`) | 2 | 1 |

  - The 17,307 relative `.json` references are Azure `x-ms-examples` files. These are data positions, and their targets are outside my checkout.
- **DigitalOcean resolves nothing.** Its 917 `$ref`s replace Operation Objects under `paths./x.get` and `tags[].description`. These are positions where the specification does not allow a reference, so resolve finds 0 sites and counts 917 data slots. With `slots:'all'`, all 917 become `external`.
- **Redocly starter:** 9 Path Item `$ref`s, all `external`.

## (5) Performance
Times come from the sweep: a fresh process per document, 4 at a time on a 4-CPU machine. Building the parser costs about 45 ms per process (`require` adds about 35 ms), and that dominates small-document times.

| Format | Size | Documents | Parse p50 / p90 / max | Resolve p50 / p90 / max |
|---|---|---|---|---|
| YAML | under 10 KB | 4,402 | 75 / 111 / 533 ms | 6 / 16 / 51 ms |
| YAML | 10–100 KB | 2,425 | 178 / 294 / 727 ms | 15 / 36 / 334 ms |
| YAML | 100 KB–1 MB | 1,134 | 347 / 686 / 1,848 ms | 49 / 152 / 609 ms |
| YAML | 1–4 MB | 73 | 1.3 / 2.3 / 3.9 s | 254 / 581 / 1,244 ms |
| YAML | 4 MB and over | 24 | 2.9 / 4.4 / 15.1 s | 322 / 615 / 2,751 ms |
| JSON | 4 MB and over (fast path) | 5 | p50 88 ms, max 129 ms | p50 306 ms, max 584 ms |

- **Grammar path for JSON** (`fast:false`): GitHub's 14 MB JSON takes 3.6 s and 1.2 GB; `strict` takes 2.1 s.
- **Against the `yaml` package**, as a ratio of parse times: 10.6× under 10 KB (setup cost), 1.5× at 10–100 KB, 0.84× at 100 KB–1 MB, and 0.83× above 1 MB.
- **Slowest per byte** (YAML over 50 KB, about 0.1 MB/s): resourcegroupstaggingapi, apisetu.gov.in transport*, sportsdata nhl-v3-stats. Each is about 0.5 s, so this is probably setup cost again.
- **Ten slowest parses:** graph 15.1 s (25.8 MB); autotask.net 5.3 s (4.1 MB, the worst per byte among large documents, with resolve 1.8 s); github api.github.com.2022-11-28 4.4 s; stripe sdk 4.4 s; GitHub descriptions-next YAML 4.0 s; GitHub descriptions YAML 4.0 s; ghec 4.0 s; mist.com 3.9 s (3.6 MB, 0.9 MB/s); loket.nl 3.8 s; ghes-3.8 3.7 s.
- **Clean peak memory** (parse alone, then resolve):

| Document | Size | Parse | Peak RSS |
|---|---|---|---|
| GitHub YAML | 11 MB | 3.6 s | 1.07 GB (1.16 GB after resolve) |
| Stripe sdk | 13.8 MB | 4.2 s | 1.16 GB |
| autotask | 4.1 MB | 1.8 s | 0.66 GB |
| graph | 25.8 MB | 9.8 s | 2.7 GB |
| graph-beta | 58 MB | 25 s | 5.3 GB |

  - That is roughly 85–160 bytes of RSS per byte of YAML. The sweep's memory figures for YAML include the reference tree held in the same process.

## (6) Files and how to rerun
All paths are under `<scratch>/corpus/`. The scripts are in `tools/`, the outputs in `run/`, and the downloads in `src/`.

| File | What it is |
|---|---|
| `run/results.final.jsonl` | Raw results, one line per document (`results.jsonl` is the same minus one rerun) |
| `run/manifest.jsonl` | The corpus manifest |
| `run/sweep.log` | Progress log of the sweep |
| `tools/manifest.cjs` | Builds the manifest |
| `tools/driver.cjs` | Resumable driver with per-phase timeouts; prints progress every 15 s |
| `tools/worker.cjs` | One document in a fresh process |
| `tools/analyze.cjs` | All the aggregates in this report |
| `tools/ext-analyze.cjs`, `tools/ref-census.cjs` | External-reference statistics |
| `tools/target-check.cjs` | The resolver target check |
| `tools/minimize.cjs` | Delta-debugging minimiser |
| `tools/parse-only.cjs` | Clean timing and memory for one document |
| `tools/repros.cjs` | The minimal repros as a quick gate |
| `tools/probe.cjs` | Synthetic YAML feature probes |

Commands, run from `tools/`. Set `OPENAPI_DIST=<path to openapi.js>` to test another build.
```
node manifest.cjs > ../run/manifest.jsonl
node driver.cjs ../run/manifest.jsonl ../run/results-NEW.jsonl --jobs 4 > ../run/sweep-NEW.log     # ~26 min; rerun to resume
node driver.cjs ../run/manifest.jsonl ../run/results-NEW.jsonl --jobs 1 --heap-mb 8192 --only graph-beta   # the 58 MB file
node analyze.cjs ../run/results-NEW.jsonl            # sections: corpus parse compare resolve features perf
node ext-analyze.cjs ../run/results-NEW.jsonl; node ref-census.cjs ../run/manifest.jsonl
node target-check.cjs ../run/results-NEW.jsonl 600; node repros.cjs
```
`driver.cjs` takes `--jobs`, `--phase-ms` (default 120000), `--heap-mb` (default 4096), `--only <regex>` and `--nofast`. A record counts as a worker failure when its process ends without sending its `done` message. I fixed a race that lost messages part-way through the sweep and reran the one affected document, so it no longer occurs.

## (7) What I could not do
- **Azure examples:** I left `examples/` out of the Azure checkout, so their 17k `x-ms-examples` references point at missing files. I took 6 services, not more.
- **Spec markdown:** example snippets inside the specification's own markdown were not harvested.
- **Unresolved document sets:** resolve was not run on fragments, or on the 3.3-dev tests, whose versions read as `unknown` (3,803 documents). The multi-file sets (DigitalOcean, Redocly, Azure) cannot be resolved across files by this release, so I counted their references instead.
- **One reference parser:** comparison is against `yaml` 2.9.1 alone. PyYAML was only a spot check, and found one bug in the reference itself (class L).
- **Approximate `$ref` census:** the census of all `$ref` text uses a regex, so some counts are approximate. Values containing `{` are cut short, and properties named `$ref` show up as noise.
- **Untested by the corpus:** merge keys, tags, streams and non-string keys do not occur, so only the synthetic probes test them.
- **Memory figures:** in-sweep memory includes the reference parser. I have clean figures for 6 large documents only.
- **Timing and runtime:** timings come from a shared 4-CPU machine with cold processes, and the run used Node 22, not the 24 that `engines` asks for.
- **Resolved values:** I did not check the resolved values themselves, only their targets.
- **Disk:** about 1.1 GB was used.
