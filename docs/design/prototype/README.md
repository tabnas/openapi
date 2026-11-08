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
