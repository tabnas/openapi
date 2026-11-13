# The corpus sweep

This folder holds the corpus sweep. It runs `@tabnas/openapi` over 8,986
real OpenAPI documents and records every document the package fails on.
For each document it checks three things:

- whether the package parses it;
- whether the tree it gives equals the tree the reference parsers give;
- what `resolve` makes of the document's references.

The documents that fail are listed in a committed ledger,
[`test/corpus/ledger.tsv`](../../test/corpus/ledger.tsv), and the headline
figures in [`test/corpus/baseline.json`](../../test/corpus/baseline.json).
A change to the package that moves either is a repair or a regression,
and the sweep says which rows and figures moved.

The sweep is a gate run by hand. It is not part of `npm test`, because it
needs the network and about half an hour. The code that decides what a
failure is does run in `npm test`, on small inline documents, in
[`ts/test/corpus-tool.test.ts`](../../ts/test/corpus-tool.test.ts).

## Running it

From the repository root, after `npm run build` in `ts/`:

```sh
node tools/corpus/fetch.cjs     # the sources, at their pinned commits, into .corpus/src
node tools/corpus/sweep.cjs     # the sweep, then the comparison with the ledger
```

`sweep.cjs --fetch` does both. A stopped sweep resumes where it stopped:
run the same command again. The results of a run are kept in
`.corpus/run/`, so a second run with nothing to do goes straight to the
comparison. `.corpus/` is ignored by git.

A run belongs to the code that made it. After a rebuild, or any other
change to the code a run is held to (see "One run, one build" below),
the sweep refuses the earlier run and says so. Start again with:

```sh
node tools/corpus/sweep.cjs --fresh
```

Use the Node version that `engines` names in `ts/package.json`. The
figures can depend on it, since the runtime decides, for one, how much
a large document costs in memory. The baseline records the major
version it was made with, and the sweep warns when the Node in use is
older. (The baseline was made under Node 24. The research sweep it
reproduces ran under Node 22, and no document came out differently.)

### What it needs

- **Node**, as above, and git.
- **The network**, for the fetch only. Every source is a public GitHub
  repository, fetched anonymously.
- **About 1.1 GB of disk** for the sources, and about 12 MB for a run.
- **About 20 to 26 minutes** at three jobs on a shared four-core
  machine; the last measured run took 21. The fetch took about a
  minute.
- **Memory**: each document runs in its own process with a 4 GB heap
  limit. At most one large document (over 4 MB) runs at a time, and the
  largest (over 16 MB) run alone.

### Options

| Option | What it does |
|---|---|
| `--fetch` | fetch any source that is not at its pinned commit first |
| `--fresh` | discard the run already in `--out`, and sweep again |
| `--out <dir>` | where the run goes, default `.corpus/run` |
| `--jobs <n>` | documents at a time, default 3 |
| `--heap-mb <n>` | the heap limit of each document's process, default 4096 |
| `--phase-ms <n>` | the time limit of each phase of one document, default 120000 |
| `--doc-ms <n>` | the time limit of one whole document, default 900000 |
| `--only <regex>` | sweep only the documents whose `source/path` matches; no comparison then |
| `--nofast` | read JSON text with the grammar too (`fast: false`) |
| `--retry-failed` | run again each document whose process did not finish |
| `--write` | rewrite the ledger and the baseline from this run |
| `--no-compare` | stop after the figures |

`OPENAPI_DIST` names another build of the package to test, and
`CORPUS_DIR` another folder for the sources.

### One run, one build

A run's folder belongs to one environment and one set of code, and
`run.json` records both:

- **the environment**: the package's version and its dependencies', the
  reference parser's version, the Node major version, the heap limit and
  `--nofast`;
- **the code**, as a hash of the files that run: the package's build
  folder, the folder of each dependency's entry point, and this tool's
  own `examine.cjs` and `worker.cjs`, which make a document's record.

A version does not tell two builds of one checkout apart, nor a linked
dependency that has moved. Without the hashes, a sweep after a rebuild
would find every document already done, run nothing, and report the
earlier build's results as this one's.

So a sweep whose environment or code differs from the folder's is
refused, with a line for each thing that differs, and ends with 2. That
holds whether the earlier run was finished or stopped half way: two
builds' records never meet in one set of figures. `--fresh` discards
the earlier run's three files and sweeps again; another `--out` keeps
both runs. The hashes are in the run and not in the baseline, which
would otherwise move with every build.

A run stopped in the middle of writing a record leaves a last line with
no end. The next run ends that line before it appends, so the cut record
is the only one lost, and its document runs again.

## The sources

Each source is pinned in [`sources.json`](sources.json) by repository and
full commit, with how it is checked out, which of its files are
documents, and how many files and distinct documents it holds.
`fetch.cjs` fetches exactly the pinned commit (`git fetch --depth 1`) and
fails if a count differs. Identical files are counted once, by SHA-1:
the first copy, in the order of `sources.json` and then of the path,
is swept, and the others are not.

| Source | Repository | Documents |
|---|---|---|
| `apis-guru` | APIs-guru/openapi-directory, every `openapi.yaml` and `swagger.yaml` under `APIs/` | 4,138 |
| `oai-tests-3.1`, `-3.2`, `-3.3` | OAI/OpenAPI-Specification, branches `v3.1-dev`, `v3.2-dev`, `v3.3-dev`, `tests/schema` | 46, 67, 71 |
| `oai-archive-3.0` | OAI/OpenAPI-Specification, `main`, `_archive_/schemas/v3.0/pass` | 6 |
| `oai-learn` | OAI/learn.openapis.org, `examples/` and its other folders | 46 |
| `digitalocean` | digitalocean/openapi, `specification/` | 3,636 (3,661 files) |
| `redocly-starter` | Redocly/openapi-starter, `openapi/` | 40 |
| `github` | github/rest-api-description, its two YAML descriptions and the next JSON one | 3 |
| `stripe` | stripe/openapi, `latest/openapi.spec3.yaml` and `.sdk.yaml` | 2 |
| `azure` | Azure/azure-rest-api-specs, seven services, without their examples | 929 (935 files) |
| `github-json` | github/rest-api-description, `descriptions/api.github.com/api.github.com.json` at an earlier commit | 1 |
| `stripe-json` | stripe/openapi, `openapi/spec3.json` | 1 |

In all, 9,017 files and 8,986 distinct documents, 924 MB. Of those, 5,182
declare a version the package reads; the rest are fragments of
descriptions in several files, and drafts of 3.3.

## What it measures

Each document runs in its own process (`worker.cjs`), through
`examine.cjs`, in phases:

1. **The reference trees.** `JSON.parse` for JSON text; otherwise the npm
   `yaml` package under YAML 1.2 and its core schema, which is a
   development dependency in `ts/package.json`.
2. **`parse`**, with the package's defaults.
3. **The comparison** of the two trees, ignoring member order. Every
   difference has a class, from the YAML source of the value: what kind
   of difference, a detail, and the node's style, such as
   `type:string->boolean:yaml11-bool-word:PLAIN`. Three suffixes name the
   kinds the plan counts: `yaml11-bool-word` (`on`, `no` and the like read
   as booleans), `underscore` (`1_000` read as a number) and
   `comment-syntax` (a value lost because `//` or `/*` opened a comment).
4. **JSON text again**, on the grammar path and under `strict`.
5. **`resolve`**, on a document that declares a version: its sites by
   status and kind, what it left as written and why, its cuts, its data
   slots, its connections, and the form of each reference into another
   document.

A phase that ends sends its result to the sweep at once, so a document
that runs out of memory or time keeps the phases it finished.

## What it writes

`.corpus/run/` holds the run:

- `manifest.jsonl`, one line per file, identified by its SHA-1;
- `results.jsonl`, one line per document, appended as each finishes,
  with times and memory;
- `run.json`, the environment of the run and the hashes of the code
  that made it.

The committed outputs hold nothing that changes from one run to the
next, so a sweep that changes nothing rewrites them byte for byte.

`test/corpus/ledger.tsv` has one row per way a document fails, sorted:

| Column | Holds |
|---|---|
| `source` | the source's name in `sources.json` |
| `path` | the document's path within its source's checkout |
| `outcome` | `refused`, `refused-invalid`, `differs`, `died`, `unchecked`, `grammar-refused`, `grammar-differs` or `resolve-threw` |
| `detail` | for a refusal, the error code; for `differs`, each class of difference with its number of values, sorted; for `died`, why and the last phase finished |

`refused` is text the reference parser accepts and the package refuses.
`unchecked` is the opposite case, where the trees could not be compared.
The header of [`ledger.cjs`](ledger.cjs) defines each outcome.

`test/corpus/baseline.json` holds the headline figures: documents by
source, version and format; parsed, refused and died, for every document
and for descriptions; refusals by code; the JSON documents whose grammar
reading equals `JSON.parse`; trees that differ, by class and by kind,
in documents and in values; the YAML features used; the totals of
`resolve`; and the forms of reference into other documents. Its
`environment` records the package's version, the versions of its
dependencies the sweep ran with, the reference parser's version, the Node
major version, the heap limit and the parse mode.

## Reading a difference

When the sweep ends, it compares its rows and figures with the committed
ones. If nothing moved it says so and ends with 0. Otherwise it prints
one line per change and ends with 1:

```
ledger: row removed: azure specification/cosmos-db/...json: was refused (unterminated_comment), and no longer is. ...
ledger: row added: apis-guru APIs/example.com/1.0.0/openapi.yaml: now differs (type:string->null:PLAIN=1). ...
ledger: row changed: github descriptions/api.github.com/api.github.com.yaml, differs: was "length:BLOCK_SEQ=4", now "length:BLOCK_SEQ=2".
baseline: figure moved: parse.descriptions.refused: 19 -> 7 (-12)
```

- **A row removed** is a document that no longer fails that way: a
  repair, if it now reads as the reference parser reads it.
- **A row added** is a document that newly fails: a regression, unless
  the change meant it.
- **A row changed** is a document that still fails, but differently: a
  class gained or lost values, or a refusal has another code.
- **A figure moved** is the same news counted. Figures can move without
  a row moving, for instance the totals of `resolve`.
- **An environment line** comes first when the run's Node, dependencies
  or options differ from the baseline's. That alone can move figures, so
  read it before the rest.

To see why a document fails, find it under `.corpus/src/<source>/<path>`
and cut it down:

```sh
node tools/corpus/minimize.cjs <file> parse-error unexpected > small.yaml
node tools/corpus/minimize.cjs <file> mismatch 'type:string->null' > small.yaml
```

## Updating the ledger

When every change the sweep reports is meant, accept them:

```sh
node tools/corpus/sweep.cjs --write
```

It rewrites both files from the finished run in `.corpus/run`, without
sweeping again. Commit them with the change that moved them, and say in
the commit which rows moved and why. Never edit the ledger by hand: the
sweep writes it, and a hand edit shows as a changed row on the next run.
If a repair removes a row that `accepted.tsv` names, delete that entry in
the same change.

## Accepted rows

The ledger says what the sweep found. Whether a row is this package's
defect is a judgement, and that lives in a separate file,
[`test/corpus/accepted.tsv`](../../test/corpus/accepted.tsv), the only
file in that folder a person writes. Its columns are those of the ledger
and a `reason`; the first four must equal a ledger row exactly.

A row may be accepted only when it is one of these:

- **the reference parser is the one in error**, as in a literal block
  scalar with an indentation indicator, where it drops a line that YAML
  1.2.2 makes content;
- **a reading the maintainer has decided**, naming the decision;
- **a correct refusal of a document that is not a description**, such as
  a file whose root is a list.

Each entry needs its reason in one sentence, and the evidence behind it
checked first: the smallest repro, and the differing values of the
document itself, each shown to come from that cause and no other. A row
is never accepted to make a number look better. An open row is a defect
still to repair, and saying so is the ledger's job.

The sweep reads the file and never writes it. Its summary gives the
rows accepted and open, and the baseline records both counts. An entry
that matches no row of a run, because the row is gone or its detail
changed, is named in a line that says to delete or correct it, and the
sweep then ends non-zero. `--write` then writes nothing, since the
baseline would count the accepted rows wrongly. `npm test` also holds every
entry to a row of the committed ledger, so a ledger update that strands
an entry fails there.

## The other scripts

| Script | What it does |
|---|---|
| `analyze.cjs [results.jsonl] [section]` | the longer analysis of a run: by source, the classes with the smallest document showing each, `resolve`, references into other documents by host, YAML features, and times and memory |
| `minimize.cjs <file> <predicate> <argument>` | cuts a failing document to the smallest text that fails the same way |
| `repros.cjs` | the smallest text of each class found, read by both parsers |
| `probe.cjs` | YAML features the corpus barely uses, probed against the reference parser |
| `parse-only.cjs <file>` | the time and peak memory of one document, with the package alone in the process |
| `target-check.cjs [n] [seed]` | for a sample of described documents, checks that every resolved local pointer lands where it says |
| `ref-census.cjs` | every `$ref` naming another document, in every document, by form and by what it names |

Everything in the corpus is data. Nothing in it is run, and no reference
in it is followed beyond the files already fetched.
