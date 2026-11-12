# Prototype: `expr` and OpenAPI meta-operations

The scripts behind [`../expr-for-meta-operations.md`](../expr-for-meta-operations.md)
and the inputs to [`../implementation-plan.md`](../implementation-plan.md).
They are an investigation, not part of the plugin or its build: nothing
here is compiled, tested or published, and no manifest in this repository
declares what they import.

| Script | Question | Result |
|---|---|---|
| `e0-input-formats.js` | Does one `jsonic`+`yaml` instance read the JSON form of a document as the strict `json` grammar does? | `e0-input-formats.result.txt` |
| `e1-ref-syntax.js` | How well does `expr`, as a sub-parser, read runtime expressions, `$ref` URIs and path templates, on the specification's examples and on ABNF-legal adversarial names? | `e1-ref-syntax.result.txt` |
| `e2-eager.js` | What does `expr`'s eager `evaluate` see of the document when an expression closes? | `e2-eager.result.txt` |
| `e3-ref-op.js` | `$ref` as an `expr` operator node over YAML and JSON input, resolved by a post-parse fold: end of parse through the engine's `ruleDone` subscriber, version-aware sibling rules, cycle cuts, a provenance side table, an `unresolved` report. Also exports `resolve(raw, opts)`. | `e3-ref-op.result.txt` |
| `e4-expr-struct.js` | Can `expr` be extended to carry `$ref`? A lexical attempt, then a structural-operator layer over `expr`'s public surface with a tree fold and an inherited base URI (`$self`, `$id`, `$anchor`) | `e4-expr-struct.result.txt` |
| `e6-expr-fold.js [doc.yaml \| spec.json]` | The OpenAPI resolver as a vocabulary over `expr`'s tree layer (key operators and `fold`, `tabnas/expr` pull request 100): version-gated identifiers (`$self` from 3.2, `$id`, `$anchor` and `$dynamicAnchor` from 3.1), RFC 3986 resolution, a classifier that reads names as names, data slots, siblings by version and target type, cycles, `$dynamicRef`, another document through `load`, reasons for each miss, provenance with positions. With no argument it folds `e6-doc.yaml`; given a `.json` file it reads it with `JSON.parse` and prints one summary line, which is how the Stripe line was captured. Run it from this directory with the `expr` checkout: see the note's appendix. | `e6-expr-fold.result.txt` |
| `bench.js <spec.json>` | Parse and resolve cost on a large real description, and the serialised size of shared (diamond) structure | `bench.result.txt` (Stripe's `spec3.json`, fetched from the `stripe/openapi` repository; not committed) |

Run them from a scratch directory with the five published packages
installed (see the appendix of the design note). The captured results were
taken against `@tabnas/parser` 0.12.15, `@tabnas/jsonic` 0.7.10,
`@tabnas/expr` 0.5.19, `@tabnas/yaml` 0.5.26 and `@tabnas/json` 0.5.19,
under Node 22, except `e6-expr-fold.result.txt`, which was captured
against the `tabnas/expr` checkout of pull request 100 at commit 6ae48c3,
whose `package.json` still reads 0.5.19 although the published 0.5.19 has
no `fold`.

## The measurements behind the TypeScript plan

Four more, taken on 12 November 2026 for
[`../typescript-plan.md`](../typescript-plan.md) against this
repository's own build (`ts/dist/openapi.js`, with `@tabnas/parser`
0.12.20, `@tabnas/yaml` 0.5.32, `@tabnas/jsonic` 0.7.11, `@tabnas/json`
0.5.20 and `@tabnas/expr` 0.5.21). Each result file is the report of the
pass, as written.

| Folder | Question | Result |
|---|---|---|
| `e7-corpus/` | What does the package do with 8,986 real documents: which does it refuse, which trees differ from a reference parser's, what does `resolve` leave as written, and at what cost? | `e7-corpus.result.md` |
| `e8-spec-probes/` | What can a valid description contain, by the texts of 2.0, 3.0.4, 3.1.2 and 3.2.0, that the package reads or resolves wrongly? `verify.cjs` re-runs the defects the plan leans on. | `e8-spec-probes.result.md` |
| `e9-apidef-swap/` | Does `voxgig/apidef`'s own suite pass with its parsing and resolution replaced by this package, and what does each remaining hand-written step need? Two diffs against apidef at 3058271. | `e9-apidef-swap.result.md` |
| `e10-aless-needs/` | What does the `rjrodger/aless` viewer need in order to open a reference in place, and what does the package cost on a 14 MB description? | `e10-aless-needs.result.md` |

Every script reads this checkout's build unless `OPENAPI_DIST` names
another. The corpus sweep needs the sources below cloned into one
folder, named by `CORPUS_SRC`, and the npm `yaml` package installed in
a scratch folder, named by `YAML_REF`. Nothing here declares that
package: it is the reference parser of the measurement, not a
dependency of this repository.

```sh
cd e7-corpus
node manifest.cjs > manifest.jsonl
node driver.cjs manifest.jsonl results.jsonl --jobs 4 > sweep.log   # about 26 minutes; run again to resume
node driver.cjs manifest.jsonl results.jsonl --jobs 1 --heap-mb 8192 --only graph-beta --retry-failed   # a failed document again, with more heap
node analyze.cjs results.jsonl
node repros.cjs                                                     # the minimal reproductions, 16 failing
```

The sources, as swept:

| Folder under `CORPUS_SRC` | Repository | Commit |
|---|---|---|
| `oad` | `APIs-guru/openapi-directory`, `APIs/` | f04b8d0 |
| `OpenAPI-Specification` | `OAI/OpenAPI-Specification`, `main` | 4f86429 |
| `oas-v3.1-dev`, `oas-v3.2-dev`, `oas-v3.3-dev` | the same repository, those branches, `tests/schema` | ef5916d, f285062, dec011b |
| `learn.openapis.org` | `OAI/learn.openapis.org` | 5f26927 |
| `do-openapi` | `digitalocean/openapi`, `specification/` | 02ce3c5 |
| `openapi-starter` | `Redocly/openapi-starter`, `openapi/` | 9cf62a5 |
| `rest-api-description` | `github/rest-api-description` | e4d3628 |
| `stripe-openapi` | `stripe/openapi`, `latest/` | 6763e1a |
| `azure-rest-api-specs` | `Azure/azure-rest-api-specs`, the paths in `e7-corpus/azure-sparse.txt` | b9a9f66 |
