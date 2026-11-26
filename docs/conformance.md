# Conformance

What `@tabnas/openapi` has been measured against, and what the
measurements say. It is the TypeScript package that is measured. The
figures below are written by `node tools/corpus/statement.cjs --write`
from the records in [`test/corpus/`](../test/corpus/), and
`ts/test/conformance.test.ts` fails when this page and those records
part.

## What is claimed

1. **Every description of the corpus is read**, under
   `reading: 'spec'`, to the tree that a reference YAML parser gives.
   Where the two trees differ, or a document is refused, the ledger has
   a row, and each row is one of three kinds: the reference parser is
   the one in error, the reading is one the maintainer has decided, or
   the document is no description and the refusal is right.
   [`test/corpus/accepted.tsv`](../test/corpus/accepted.tsv) gives
   each such row its reason. A row with no reason is open, and there
   is none.
2. **Every reference is resolved to what the specification says it
   names, or is reported with a reason.** No reference is reported as
   resolved while its place still holds the map as written.
3. **A description in several documents resolves**, from its own files
   through a loader, with no reference left to a document that is on
   disk. Written as one document, it resolves to what its documents
   resolve to.
4. **A text built to exhaust the reader ends in a refusal with a
   code**, and so does a description built to exhaust the resolver.
   That is held by `ts/test/hostile.test.ts`, by the cases of
   [`test/long/`](../test/long/) and by the bounds that each function
   states, and has no figure here.
5. **`compat: 'apidef'` gives what the resolver of `@voxgig/apidef`
   gives**, on every document compared.

The base reading is not measured against a YAML parser. It reads more
than YAML on purpose: `yes`, `no`, `on` and `off` as Booleans, `//` and
`/*` as comments, and `_` inside a number. Its ledger is kept so that
a change to it shows, and its rows are those readings.

## What is not claimed

Validating a description against the OpenAPI schema, validating an
instance against a schema, generating code, making an HTTP request,
and evaluating `$dynamicRef` are no part of this package. A document
that is not valid by the OpenAPI schema is read and resolved all the
same, and nothing here says how many of the corpus's documents are
valid.

A bundle of documents of more than one version of OpenAPI is not held
to meaning what its documents mean. The bundle is one document, read
by one version, and the
[reference](../ts/doc/reference.md#what-a-bundle-does-not-keep) says
what is not kept.

The corpus is what its sources publish, and it has little of some
things the specification allows. The figures say how many of its
descriptions are of 3.1 and of 3.2, and which features of YAML its
documents use: some they do not use at all. What the corpus lacks is
held by fixtures written from the specification's text, and by sets of
documents that three generators write.

## The figures

<!-- figures: written by tools/corpus/statement.cjs, never by hand -->

### The corpus

| Source | Commit | Documents | Descriptions |
|---|---:|---:|---:|
| `APIs-guru/openapi-directory`, as `apis-guru` | `f04b8d0bcd39` | 4,138 | 4,138 |
| `OAI/OpenAPI-Specification`, as `oai-tests-3.1` | `ef5916de74d7` | 46 | 46 |
| `OAI/OpenAPI-Specification`, as `oai-tests-3.2` | `f28506252b57` | 67 | 66 |
| `OAI/OpenAPI-Specification`, as `oai-tests-3.3` | `dec011bd0047` | 71 | 0 |
| `OAI/OpenAPI-Specification`, as `oai-archive-3.0` | `4f86429f134f` | 6 | 6 |
| `OAI/learn.openapis.org`, as `oai-learn` | `5f26927b00d5` | 46 | 38 |
| `digitalocean/openapi`, as `digitalocean` | `02ce3c5265c0` | 3,636 | 1 |
| `Redocly/openapi-starter`, as `redocly-starter` | `9cf62a576cac` | 40 | 1 |
| `github/rest-api-description`, as `github` | `e4d3628fe92e` | 3 | 3 |
| `stripe/openapi`, as `stripe` | `6763e1a3f199` | 2 | 2 |
| `Azure/azure-rest-api-specs`, as `azure` | `b9a9f66a6092` | 929 | 879 |
| `github/rest-api-description`, as `github-json` | `df36add4edae` | 1 | 1 |
| `stripe/openapi`, as `stripe-json` | `6763e1a3f199` | 1 | 1 |

8,986 documents, of which 5,182 are descriptions: a document
whose root declares a version. The other 3,804 are the parts of descriptions in
several documents, and test documents that are not descriptions.

| Version declared | YAML | JSON |
|---|---:|---:|
| 2.0 | 2,176 | 883 |
| 3.0 | 1,879 | 8 |
| 3.1 | 158 | 4 |
| 3.2 | 70 | 4 |
| none: the root is no map | 1 | 0 |
| none | 3,795 | 8 |

Of the 8,079 YAML documents, the count that use each feature of YAML:

| Feature | Documents |
|---|---:|
| a block scalar | 3,788 |
| a flow collection | 3,544 |
| an anchor | 70 |
| an alias | 58 |
| a document start marker | 19 |
| a merge key | 0 |
| a tag | 0 |
| a directive | 0 |
| a key that is no string | 0 |
| a complex key | 0 |
| more than one document in the text | 0 |

### Reading

|  | `reading: 'spec'` | the base reading |
|---|---:|---:|
| Documents read | 8,985 of 8,986 | 8,973 of 8,986 |
| Descriptions read | 5,182 of 5,182 | 5,170 of 5,182 |
| Refused | 1 `openapi_root` | 1 `openapi_root`, 1 `unexpected`, 11 `unterminated_comment` |
| Ended without an error or a tree | 0 | 0 |
| Trees compared with the reference parser | 8,985 | 8,973 |
| Trees that differ | 2 | 222 |
| Ledger rows | 3 | 235 |
| Accepted, each with its reason | 3 | 3 |
| Open | 0 | 232 |

The reference parser is `yaml` 2.9.1, read under the core schema of YAML 1.2.
Of the 907 JSON documents, the grammar gives the tree that `JSON.parse` gives for
907, differs on 0 and refuses 0. Under `strict`, 899 are accepted,
and 8 are refused for declaring no version this package reads.

The rows of the ledger under `reading: 'spec'`, with the reason each is accepted:

- `apis-guru`, `APIs/amazonaws.com/kafka/2018-11-14/openapi.yaml`: differs, `value:string:BLOCK_LITERAL:|N-=624`. The reference parser is in error: in a literal block scalar with an explicit indentation indicator (|2-) it drops a whitespace-only line indented past the content indentation, which YAML 1.2.2 section 8.1.1.1 makes content; with those lines removed from both readings every differing value is equal.
- `apis-guru`, `APIs/azure.com/recoveryservicessiterecovery-service/2018-07-10/swagger.yaml`: differs, `value:string:BLOCK_LITERAL:|N-=2`. The reference parser is in error: in a literal block scalar with an explicit indentation indicator (|2-) it drops a whitespace-only line indented past the content indentation, which YAML 1.2.2 section 8.1.1.1 makes content; with those lines removed from both readings every differing value is equal.
- `oai-tests-3.3`, `tests/schema/minimal-objects.yaml`: refused, `openapi_root`. The root is a YAML list of 28 test objects, not a description, so refusing it with openapi_root is correct.

The rows of the ledger under the base reading, by what each row says:

| Outcome and class | Documents |
|---|---:|
| `differs type:string->boolean:yaml11-bool-word:PLAIN` | 145 |
| `differs type:string->null:comment-syntax:PLAIN` | 26 |
| `differs type:string->number:underscore:PLAIN` | 25 |
| `differs type:string->boolean:yaml11-bool-word:PLAIN; type:string->number:underscore:PLAIN` | 18 |
| `refused unterminated_comment` | 11 |
| `differs type:string->boolean:yaml11-bool-word:PLAIN; type:string->null:comment-syntax:PLAIN` | 4 |
| `differs value:string:BLOCK_LITERAL:\|N-` | 2 |
| `differs type:string->boolean:yaml11-bool-word:PLAIN; type:string->null:comment-syntax:PLAIN; type:string->number:underscore:PLAIN` | 1 |
| `differs type:string->null:comment-syntax:PLAIN; type:string->number:underscore:PLAIN` | 1 |
| `refused openapi_root` | 1 |
| `refused unexpected` | 1 |

### Resolving

Under `reading: 'spec'`, each of the 5,182 descriptions is resolved by itself, with the default
options and no other document given. None threw. They hold 1,302,785 references:

| References | Count |
|---|---:|
| Resolved | 1,271,063 |
| Cut, where a cycle closes | 2,123 |
| Left as written, `external` | 29,595 |
| Left as written, `not-found` | 4 |
| Reported resolved and holding the map as written | 0 |

The 29,595 external references name documents that this run did not give, in 789
descriptions. The run below gives them. 603 descriptions have a cycle. 53,741 maps with a
`$ref` member are data where they are, an example or an extension, and are left alone.

What the descriptions name without a reference, by kind of name:

| Kind | Names | Found nothing |
|---|---:|---:|
| `defaultMapping` | 1 | 1 |
| `expression` | 11 | 3 |
| `implicitMapping` | 11,072 | 0 |
| `linkParameter` | 83 | 4 |
| `mapping` | 7,810 | 47 |
| `operationId` | 80 | 11 |
| `operationRef` | 19 | 19 |
| `pathClash` | 135 | 0 |
| `pathParameter` | 297,777 | 11,550 |
| `securityScheme` | 65,577 | 1 |
| `serverVariable` | 1,850 | 0 |
| `tag` | 152,713 | 58,701 |
| `tagParent` | 197 | 0 |
| `template` | 2 | 2 |

The operation view gives 180,252 operations: 105 by callback, 179,485 by path, 662 by webhook.
7,268 lack a parameter that is in a document this run did not give. The `ignored` report
lists 3,754 headers that the specification says to ignore, in 118 descriptions.

### Several documents

| Source | Descriptions | In several documents | Documents loaded | References | Resolved | Cut | Left as written |
|---|---:|---:|---:|---:|---:|---:|---:|
| `azure` | 885 | 585 | 1,409 | 118,246 | 117,850 | 396 | 0 |
| `redocly-starter` | 1 | 1 | 39 | 110 | 110 | 0 | 0 |
| `oai-learn` | 38 | 2 | 8 | 201 | 201 | 0 | 0 |
| `digitalocean`, under `slots: 'all'` | 1 | 1 | 3,622 | 14,456 | 14,442 | 14 | 0 |

925 descriptions, each resolved from its own file with `resolveAll` and the file
loader. 0 threw, and 0 left a reference to a document that is on disk.

| Source | Bundles that agree | That differ | Targets among the components | In the place of a reference | Left |
|---|---:|---:|---:|---:|---:|
| `azure` | 885 | 0 | 6,224 | 0 | 0 |
| `redocly-starter` | 1 | 0 | 39 | 0 | 0 |
| `oai-learn` | 38 | 0 | 10 | 0 | 0 |
| `digitalocean` | 1 | 0 | 2,218 | 2,551 | 0 |

Each description is then written as one document with `bundleAll`. A bundle agrees when it
resolves to what its documents resolve to: 925 of 925 do.

### What the figures were measured on

`@tabnas/openapi` 0.1.0 on Node.js 24, with `@tabnas/expr` 0.6.4, `@tabnas/json` 0.5.20, `@tabnas/jsonic` 0.7.12, `@tabnas/parser` 0.12.21, `@tabnas/yaml` 0.5.34.

<!-- /figures -->

## How the figures are made

`node tools/corpus/sweep.cjs` reads every document of the corpus with
the build in `ts/dist`, compares each tree with the reference parser's,
resolves every description, and holds what it finds to the ledger and
the baseline in `test/corpus/`. It ends with 0 only when nothing has
moved. `--reading spec` does the same under the specification's
reading, against a ledger and a baseline of its own.
`node tools/corpus/documents.cjs` resolves each description of four
sources from its own file, writes each as one document, and holds that
to `test/corpus/documents.json`. Each is run by hand, since each needs
the corpus, which is fetched and not committed.
[`tools/corpus/README.md`](../tools/corpus/README.md) says how.

A figure moves only on purpose. A sweep that finds a difference fails,
and `--write` accepts a change that was meant, which changes the
records in a commit that says why.
