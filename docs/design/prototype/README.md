# Prototype: `expr` and OpenAPI meta-operations

The scripts behind [`../expr-for-meta-operations.md`](../expr-for-meta-operations.md).
They are an investigation, not part of the plugin or its build: nothing
here is compiled, tested or published, and no manifest in this repository
declares what they import.

| Script | Question | Result |
|---|---|---|
| `e0-input-formats.js` | Does one `jsonic`+`yaml` instance read the JSON form of a document as the strict `json` grammar does? | `e0-input-formats.result.txt` |
| `e1-ref-syntax.js` | How well does `expr`, as a sub-parser, read runtime expressions, `$ref` URIs and path templates? | `e1-ref-syntax.result.txt` |
| `e2-eager.js` | Can `expr`'s eager `evaluate` resolve a document-level reference? | `e2-eager.result.txt` |
| `e3-ref-op.js` | `$ref` as an `expr` operator node over YAML and JSON input, resolved by a post-parse fold | `e3-ref-op.result.txt` |
| `e4-expr-struct.js` | Can `expr` be extended to carry `$ref`? A lexical attempt, then a structural-operator layer over `expr`'s public surface with a tree fold and an inherited base URI | `e4-expr-struct.result.txt` |

Run them from a scratch directory with the five published packages
installed (see the appendix of the design note). The captured results were
taken against `@tabnas/parser` 0.12.15, `@tabnas/jsonic` 0.7.10,
`@tabnas/expr` 0.5.19, `@tabnas/yaml` 0.5.26 and `@tabnas/json` 0.5.19.
