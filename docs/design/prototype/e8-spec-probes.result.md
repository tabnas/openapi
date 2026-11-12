# E8: an audit against the specification texts

The report of one research pass for [`../typescript-plan.md`](../typescript-plan.md),
taken on 12 November 2026 against `@tabnas/openapi` 0.1.0 as built from this
repository, and kept as it was written. The probes are in [`e8-spec-probes/`](e8-spec-probes/); `verify.cjs` there re-runs the defects the plan leans on.
A path under `<scratch>` names the working folder of that research session,
which is not kept; a path under `/home/user` names a checkout on the machine
that ran it.

---

## Audit: what valid OpenAPI descriptions can contain that `@tabnas/openapi` (TS) does not yet read, resolve or report correctly

Nothing was changed in any checkout. The spec texts were cloned shallow into `<scratch>/coverage/spec/oas` (commit 4f86429, 2026-10-18). **Note: 3.1.2 and 3.2.1 are published texts (`versions/3.1.2.md`, `versions/3.2.1.md`), not only 3.2.0.** Their field tables match 3.1.0 and 3.2.0 apart from table artefacts. All probe scripts are in `<scratch>/coverage/probes/`:
- `p1.cjs`, `p1b.cjs`: document forms.
- `p4.cjs`, `p4b.cjs`: references and connections.
- `p7.cjs`, `p7b.cjs`, `p7c.cjs`, `p7d.cjs`: robustness.
- `fields2.cjs` + `cmp.cjs`: compares spec field tables against the model.

Everything ran against `/home/user/openapi/ts/dist/openapi.js`.

---

## (1) Audit table

### 1. Document forms

| Capability | Spec basis | Status | Evidence / closing the gap |
|---|---|---|---|
| JSON text (RFC 8259) | all versions, "Format" | **works** | Fast path is `JSON.parse` with null-prototype rebuild (`openapi.ts` `fastParse`), else the grammar. Fixtures `raw-json.tsv`, `raw-fast.tsv`. |
| YAML 1.2 block/flow, comments, quoting, block scalars (`|`, `>`, `|-`, `|+`, indentation indicator, more-indented folding), multi-line plain/quoted, explicit `?` string keys, `%YAML`/`%TAG` directives, `---`/`...` markers, CRLF | 3.0.4/3.1.2 "Format" (YAML 1.2 RECOMMENDED); 3.2.0 "JSON and YAML Compatibility" (YAML 1.2 + RFC 9512 §3.4) | **works** | Probes p1/p1b: all gave the right values, including `\N \_ \L \P` escapes (85 a0 2028 2029), comment-then-value on the next line, and anchor plus comment. |
| Anchors and aliases (block and flow, on scalars, as keys) | YAML 1.2 | **works**, but aliases are deep **copies** (`t.a===t.c` is false) with no bound. See §7. | Repair belongs in yaml (Phase 5 / Risks). |
| Merge keys `<<` (single and list) | YAML 1.1 only. Not part of YAML 1.2 core, where `<<` is a plain key. | **works as 1.1** (merges, local key wins) | Pragmatic. Whether to keep merging is a decision. |
| Tags | 3.0.4/3.1.2: "Tags MUST be limited to those allowed by YAML's JSON schema ruleset" | **works** for `!!str`/`!!int`/`!!map`. `!foo`, `!!binary`, `!!set` and `!!timestamp` are silently ignored (value kept as string or map). | Out-of-ruleset tags are invalid anyway. Fine. |
| Map keys are failsafe strings (`200:`, `true:`, `~:`, `1.0:`, `0x1F:`, `007:`, `""`) | 3.0.4/3.1.2: "Keys used in YAML maps MUST be limited to a scalar string, as defined by the YAML Failsafe schema" | **works** | Gives `"200"`, `"true"`, `"~"`, `"1.0"`, `"0x1F"`, `"007"`, `""` (p1, p1b). JS orders integer-like names first (AGENTS gotcha), which matters only to a writer. |
| Complex (non-scalar) keys | forbidden by the line above | rejected as `unexpected` | Fine. |
| Duplicate keys | YAML 1.2: keys MUST be unique; "Patterned fields MUST have unique names" | **works**: last wins (Decision 11); `openapi_duplicate_key` under strict | `raw-errors.tsv` |
| Plain scalars: YAML 1.1 booleans | 3.2.0 requires YAML 1.2 (core: `yes/no/on/off` are strings) | **wrong** | `enum: [NO, SE, DK, On]` reads as `[false,"SE","DK",true]` (probe 3.1). Pinned in `raw-yaml-scalars.tsv`. Ledger `yaml/test/yaml-test-schema-deviations.tsv` lists 12 boolean forms plus 13 jsonic number forms (`1_000`, `0b1`, `-0x30`, `85_230.15`). Fix is the planned Phase 5 yaml "plain-scalar schema option" (core or JSON schema). |
| Numbers: exponents, `.inf`/`.nan`, hex/octal, `017` → 17 | YAML 1.2 core | **works** | `1e400` becomes Infinity. `.inf` is a float infinity, which JSON cannot carry. The 3.2 text says "SHOULD NOT rely on JSON-incompatible YAML values". |
| Integers beyond 2^53 (e.g. `maximum: 9223372036854775807`) | JSON/YAML allow them; very common with `format: int64` | **wrong (silent precision loss)** | Probe 3.2. Needs a lossless-number option (BigInt, or keep source text) in the yaml and json grammars and the fast path. That is a decision. |
| Dates / timestamps | YAML 1.2 core has no timestamp | **works** (strings) | `2024-01-01` stays a string. |
| Sexagesimal `1:20` (YAML 1.1) | 1.2: string | **works** | Gives a string. |
| Empty text, empty document, `---` alone | — | refused `openapi_root` | Correct: a description is a map. |
| Trailing empty document (`openapi: 3.1.0\n---\n`, or `---\n# end`) | YAML: a two-document stream whose second document is null | **refused** `openapi_stream` (probe 2.1) | Debatable: such a file is valid YAML and its only non-empty document is a valid description. Decision: accept null or comment-only trailing documents. |
| Byte-order mark | RFC 8259 §8.1: a parser MAY ignore a BOM | **works** by default; **refused under strict** (`unexpected`) | Strict could skip a leading U+FEFF. |
| Encodings other than UTF-8 (UTF-16/32, which YAML 1.2 allows) | 3.2.0 Example Object section: UTF-8 "the only interoperable character set for JSON, and therefore also for JSON-compatible YAML" | **missing**: `parse` takes only a JS string | Add a bytes entry (Buffer/Uint8Array) with BOM sniffing, or document that the caller decodes. Needed by the Phase 3 loader. |
| CR-only line breaks | YAML 1.2 b-break | **wrong**: `openapi: 3.1.0\ra: 1` gives `unexpected` | Rare. Upstream yaml. |
| Tab used as indentation | invalid YAML | accepted but **misread**: `info:\n\ttitle: x` gives `{"info":null,"title":"x"}` | Invalid input, so not a valid-description gap. Worth an error rather than a wrong tree. |
| JSON text after a blank line, grammar path | valid JSON and YAML | **wrong** with `fast:false` (`unexpected`), works on the default fast path | `DIVERGENCE.md` "JSON text after a blank first line" |
| yaml `unparsed` ledger (21 valid cases rejected) | YAML Test Suite | Most need complex or empty keys (2JQS, 4FJ6, 6BFJ, 6M2F, 6PBE, CFD4, FRK4, LX3P, M5DY, NKF9, PW8X, S3PD, SBG9, SM9W/01, UKK6, X38W, Q9WF), which descriptions cannot contain. | **Plausible hits:** NHX8 (`:` + blank lines, needs an empty key, so actually not), and **RZP5/XW4D** (trailing comments). I probed their description-shaped parts separately (`key  : #c\n  v`, `e: &node # c`, plain multi-line plus comment); all parse. Practical exposure from the ledger: **low**. The lenient ledger (70 invalid cases accepted) only matters as misreads of invalid input. |

### 2. Version handling (`oas-version.ts`)

| Form | Status |
|---|---|
| `"3.0.0".."3.0.4"`, `"3.1.0".."3.1.2"`, `"3.2.0"`, `"3.2.1"`, pre-releases `"3.1.1-rc0"`, `"3.1"` string | **works** (regex `^3\.([0-2])(?:\.\d+)?(?:[-+]…)?$`) |
| YAML numbers: `openapi: 3.0` gives 3, then 3.0; `3.1`, `3.2` | **works** |
| `swagger: "2.0"`, `2.0` (gives 2), `2`, `"2.0.0"` | **works**. `"2.0.0"` is lenient: 2.0 says the value MUST be "2.0". |
| `openapi: 3.10` (gives the number 3.1) | read as 3.1, a harmless misread |
| Unknown / future (`3.3.0`, `4.0.0`) | raw: accepted. strict: `openapi_version`. `resolve`: `version: 'unknown'`, **read with the 3.2 model** (`resolve.ts` `mv`). Decision: is "unknown reads as latest" right? |
| `openapi` and `swagger` both present | `openapi` wins |

**Can raw mode reject a valid description?**
- Non-strict:
  - `openapi_root` cannot hit a valid description.
  - `openapi_stream` can, on a trailing empty or comment-only document (probe 2.1).
  - Beyond those, only the base-grammar defects above (CR-only line breaks, blank first line before JSON on the grammar path).
- Strict:
  - A JSON text with a BOM (allowed by RFC 8259 §8.1).
  - By design: YAML text, duplicate keys, unknown versions.

### 3. Object model, per version

Method: `fields2.cjs` extracted every Fixed/Patterned Fields table from 2.0, 3.0.4, 3.1.2 and 3.2.0, and `cmp.cjs` diffed them against `model/object-model.json` props. **Every fixed field of every object is present in all four versions.** That includes all the 3.2 additions:
- `$self`, `additionalOperations`, `query`;
- `querystring` (an `in` value, so data);
- `itemSchema`, `prefixEncoding`/`itemEncoding` on both Media Type and Encoding, and the nested Encoding `encoding`;
- Tag `parent`/`kind`/`summary`, `components.mediaTypes` (refable), `content` values refable;
- Example `dataValue`/`serializedValue`, Discriminator `defaultMapping`;
- OAuth `deviceAuthorization`/`deviceAuthorizationUrl`, `oauth2MetadataUrl`, Security Scheme `deprecated`, XML `nodeType`, Server `name`, Response `summary`.

Differences found:

| Item | Status | Notes |
|---|---|---|
| Fields the model lacks (`readOnly`, `writeOnly`, `nullable`, `deprecated` in 2.0/3.0 schemas; Reference Object `summary`/`description`; 2.0 Responses `default` as a prop) | harmless | They are data or covered by patterns; none can hold a reference. |
| 3.2 Media Type `description` | in the model and in `OVERRIDE['3.2'].mediaType` | It is in the vendored 3.2 *schema* but **not in the 3.2.0 or 3.2.1 text's Fixed Fields**. The Reference Object rule says "If the referenced object-type does not allow a description field, then this field has no effect". So the resolver applies an override the text does not grant. Decision: text or schema. |
| 3.0 component names | **wrong (silent)**: 3.0 states use `patterns: ^[a-zA-Z0-9\.\-_]+$` with no `rest`, so a component named `B C` is typed data. References *to* it resolve, but references *inside* it are silently left (probe 3.2). 3.1/3.2 use `rest`, so they are lenient. | The regex is a MUST in 3.0.4 and 3.1.2 alike, so such names are invalid. The inconsistency still matters for real files. Fix: `rest` for 3.0 too. |
| Where `$ref` is allowed: 3.0 Reference Object list (components ×9, operation/path parameters, requestBody, callbacks, schema, examples, Encoding/Response/Header headers, Responses default and codes, links) | **works** | Matches the text (grep of "Reference Object" rows); probes resolved them. |
| Same, 3.1 | **works** | Adds `components.pathItems`. Webhooks and Callback values are Path Item (`$ref` field) and are read as `pathItem` kind. |
| Same, 3.2 | **works** | Adds `mediaTypes` and `content`. |
| 2.0 positions | **works** | Schema anywhere in schemas, parameters lists, responses, Path Item `$ref`. Definitions maps (`parameters`, `responses`) are not refable, as the 2.0 schema says. |
| Extensions `^x-` | **works** in every extensible object, every version. Non-extensible maps (`components.schemas`, `content`, Security Requirement, `mapping`) correctly treat `x-…` as a name. | — |
| Schema applicators (`model/applicators.json`) | **works** for 2020-12, Wright-00 and draft-04 | — |
| Draft-07 and 2019-09 keywords in 3.1/3.2 schemas (`definitions`, `dependencies` schema form, `additionalItems`, array-form `items`) | **wrong (silent)** | They are typed data, so refs inside are left with no `unresolved` row (only `dataSlots` counts them). Probe 3.3. |

### 4. References within one document (`resolve.ts`, `uri.ts`, `connections.ts`)

| Capability | Spec basis | Status | Evidence / gap |
|---|---|---|---|
| RFC 6901 pointer: `~0` `~1`, percent-decoding before split, empty-token keys, trailing `/`, indices without leading zeros, `-` not found, out of range | RFC 6901 §4 and §6 (cited from knowledge) | **works** | `pointers.tsv`. Probe p7c: `#/…/a~1b~0c`, `%2F` whole-fragment decode, `%E2%82%AC`, `/prefixItems/01` not-found, `-` not-found, `~2` bad-fragment. |
| Raw `{ }` or spaces in a fragment | spec example requires `%7B` `%7D` | accepted leniently | Fine. |
| Fragment-only refs, `#` (whole document) | — | **works** | `#` from inside a component is a cut. |
| Same-document ref through an absolute URI or own file name | RFC 3986 §5 | **works** with `retrievalUri` or 3.2 `$self` | `$self` is correctly ignored in 3.1. |
| URI equivalence (scheme/host case, default port, `%61`) | RFC 3986 §6.2.2–6.2.3 (from knowledge) | **wrong**: `HTTPS://E.COM/a/api.yaml#/info`, `:443`, `%61pi` give `external` against `retrievalUri https://e.com/a/api.yaml`. Same for an `$id` that differs only in host case. | Normalise before comparing (it matters more in Phase 3). |
| `$id` (absolute, relative, embedded resource changes base); fragment under `$id` resolves inside that resource | 3.1.2 "Relative References in API Description URIs"; 2020-12 §8.2 | **works** | `base-uri.tsv`; probes. `#/components/…` under an `$id` is `not-found`, which is spec-correct and a frequent author error. |
| `$anchor`, `$dynamicAnchor` as plain-name targets (3.1+); `#foo` in 3.0 gives bad-fragment | 2020-12 | **works** | `anchors.tsv` |
| `$dynamicRef` | 2020-12 | **reported, not evaluated** (left as written; `connections` row with initial target and `anchor` flag) | A plan non-goal. Also `$recursiveRef` (2019-09) is not recognised. |
| `$schema` / `jsonSchemaDialect` | 3.2.0 "Specifying Schema Dialects": "Tooling MUST support the OAS dialect schema id, and MAY support additional values of `$schema`" | **partial**. Supported: OAS 3.1/3.2 dialect prefixes and `https://json-schema.org/draft/2020-12/schema`. **Everything else leaves every schema `$ref` under it unresolved** (`why: unsupported-dialect`, not an error even under strict). | Probes: draft-07, 2019-09, `…/2020-12/schema#` (trailing empty fragment) and a custom `jsonSchemaDialect` all give unresolved. A custom root dialect unresolves every schema ref in the document. Plan Decision 13 defers draft-04/06/07. Needed: draft-04/06/07 semantics (siblings ignored, `id`/`$id`, `definitions`), 2019-09 (≈2020-12 plus `$recursiveRef`), empty-fragment normalisation, and a policy for unknown custom dialects (e.g. treat as 2020-12-compatible and report). The dialect is also read from `$schema` at any schema, not only at resource roots. |
| `$defs` | — | **works** | — |
| `definitions` | — | 2.0: works. 3.1: data, refs inside silent (above). | — |
| Self-subtree target: `{$ref:'#/$defs/x', $defs:{x:…}}` (standard compound/bundled JSON Schema shape) | 2020-12 | **wrong**: treated as a cycle and cut, and every reference *to* that schema is also cut | Probe 3.4. Root cause: expr's `at()` folds through a site on the path (followAlias semantics), so the path runs through the in-progress site. |
| Pointer through a `$ref` site | RFC 6901 evaluates the raw document | **wrong in 3.0**: the target is read from the *resolved* value | Probe 3.5. Same root cause. |
| Reference through reference (chains) | — | **works** | apidef rows; long chains hit `fold_depth` past 1000 (§7). |
| References to non-objects | — | **works** (`targets:'any'`) | `/enum` gives `["a"]`. |
| Target interpreted in the referring site's context | 3.2.0 Appendix G "Conflicts Between Field Types and Reference Contexts": an object is interpreted "As a reference target, with the Object type matching the reference source's context" | **wrong (silent)**: the target is classified by its *own position* only. A response `$ref` to `#/x-common/NotFound`, or a schema `$ref` into `…/definitions/x`, returns the target with its inner `$ref` left raw, while provenance says `resolved` and `unresolved` is empty. | Probes 3.3 and 3.6. Fix: when a site resolves to a position the model types as data (or a different type), re-walk the target under the site's kind (memoised per location+kind), and report a type conflict. **Essential for Phase 3**, where whole referenced documents are "fragments". |
| Reference type check (Response `$ref` pointing at a Schema) | Appendix G: MAY be treated as an error | **missing** | No check that the target position's type matches the site's type. Candidate `connections`/warning row. |
| 2.0 JSON Reference: siblings ignored; "only canonical dereferencing" | 2.0 Reference Object | **works** (siblings dropped; draft-04 `id` not used; `$ref: Pet` is a relative file, so `external`) | — |
| Sibling rules 3.0 (ignored), 3.1+ Reference Object `summary`/`description` override by target type, 3.1+ schema `$ref` with siblings | — | **works** | 3.1+ schema siblings are rendered as `{allOf:[target], …siblings}`. Faithful, but a shape consumers must know about. |
| Path Item `$ref` (all versions, merge, conflicting fields reported) | 3.2.0 Path Item `$ref`: "behavior is undefined" | **works** | `pathItemMerge` connection |
| Link `operationRef` | — | **works**: reported, type-checked `operation`, never substituted; a literal `{` in the fragment is accepted | — |
| Link `operationId` (incl. duplicates `targets`) | — | **works** | — |
| `externalValue`, `externalDocs.url`, `license.url`, `contact.url`, `server.url` | 3.0.4 "Relative References in URLs": the `$ref` process is RECOMMENDED for these; 3.1+ are URIs against the document base | **ignored** | Candidate: report them as resolved absolute URIs (never loaded). |
| Discriminator `mapping` / `defaultMapping` (name first, then URI) | — | **works** (`connections`) | — |
| **Implicit** discriminator mapping (schema names via `allOf` to the parent; 2.0 `discriminator: <prop>`) | 3.x Discriminator Object; 2.0 Schema `discriminator` | **missing**. Plan §3.4 lists "the implicit mapping" as a connection; it is not implemented. | — |
| Security Requirement names (2.0 `securityDefinitions`, 3.x components; 3.2 URI form, name wins, `ambiguous`) | 3.2.0 Security Considerations | **works**. 3.1 correctly does not read URI keys. | — |
| Tags, 3.2 tag `parent` (with cycle check) | — | **works** | — |
| `operationId` uniqueness across paths/webhooks/callbacks | "MUST be unique among all operations" | **works** (`operationIdReuse`) | — |

### 5. Descriptions in several documents

**Status: missing.** Any reference that leaves the document is `why:'external'`, left as written (`resolve.ts` `locate`). There is no `load`, no documents option, no async API, no loader. expr's fold already has `load?(doc, site)` and cross-document `at(path, doc)` (`/home/user/expr/ts/src/expr.ts` lines 207–236, 1867–1876).

What a reader must do:

| Need | Spec basis | In the plan (Phase 3)? |
|---|---|---|
| Relative file refs, absolute URLs, whole-document refs (`./pet.yaml`), refs into non-OpenAPI documents (bare JSON Schema; YAML fragment documents such as 2.0/3.0 `definitions.yaml#/Pet`, `responses.yaml#/NotFound`) | 3.1.2/3.2.0 "OpenAPI Description Structure": roots MUST be an OpenAPI or Schema Object for well-defined behaviour; others "implementation-defined" (Appendix G) | Partly. Root kind is openapi field, else Schema Object, else "by the referring site's kind, marked inferred". **Omitted:** typing the *target* (not the root) by the referring context. A `definitions.yaml` whose root is a *map of schemas* is neither an OpenAPI nor a Schema Object; treating its root as a Schema makes `Pet` an unknown keyword, so Pet's inner refs are silently dropped (the context bug in §4). |
| Base URI per document: RFC 3986 §5.1.1–5.1.4, 3.2 `$self` (relative `$self` resolved first), `$id`; retrieval URI after redirects | 3.2.0 "Establishing the Base URI" | Yes ($self, retrieval URI, `$id`; the loader returns `retrievalUri`). |
| "Implementations MUST NOT treat a reference as unresolvable before completely parsing all documents **provided**"; "SHOULD allow users to provide documents with their intended retrieval URIs" | 3.2.0 "Parsing Documents" and "Establishing the Base URI" | **Omitted.** The plan has only a lazy `load(uri)`. Needed: an up-front document set (URI to text) that is fully parsed and indexed before judging, and a **global `$id`/`$anchor`/`$self` index across all documents**. A ref to `https://x/schemas/pet` is satisfied by any provided document whose root or embedded `$id` is that URI, wherever it lives. The plan keys only by `$self`, else retrieval URI. |
| Parsing referenced documents as complete documents, not fragments | 3.1.2 "Parsing Documents"; 3.2.0 Appendix G "Warnings Regarding Fragmentary Parsing" | Yes (fold loads whole documents). |
| Dialect of a standalone Schema document without `$schema`: "SHOULD be assumed to be the OAS dialect" | 3.2.0 "Specifying Schema Dialects" | Not stated. |
| Version of a referenced OpenAPI document that differs from the entry (3.0 entry → 3.1 document): which sibling rules and dialect apply | spec silent | **Omitted.** Decision. |
| Implicit connections: components and tags from the entry document, operationId across all documents, security names (name first, then URI), mapping names | 3.2.0 "Resolving Implicit Connections", Appendix G; 3.0.4/3.1.2 Appendix F | Yes (Phase 3 item 3). |
| Cycles across documents; one document reached by different URIs | — | Cycles: yes (fold). URI equivalence and normalisation (case, ports, percent-encoding, `file:` paths, symlinks, `$self` aliasing): **omitted**. |
| Loader API: sync vs async | — | Decision 3: sync `resolve` plus async `resolveAll`. |
| Files and HTTP | — | "Never a default loader that touches the network or disk". So every user writes the risky part. Decision: ship opt-in safe loaders (file confined to a root, HTTP with an allow list). |
| Caching, limits | — | `maxDocuments` 64, `maxBytes` 64 MiB. **Omitted:** per-document byte cap, timeouts, cancellation (`AbortSignal`), concurrency, cache across calls. **Alias-bomb bound in loaded YAML** (a byte budget does not bound alias expansion), decompression bombs. |
| Credentials | — | **Omitted:** per-origin credentials, never forwarded cross-origin or on redirect. |
| Safety | 3.2.0 "Handling External Resources" | Allow list plus budgets: yes. **Omitted:** re-checking the allow list after redirects, private-IP/DNS-rebinding SSRF, `file:` off by default, path traversal after `remove_dots` and symlinks, scheme allow list. |
| Content type / format detection for loaded documents | Appendix G "Detecting … using media types" | **Omitted.** The loader returns `{text, retrievalUri}` only. |
| Report rows naming both documents | — | Yes. |

Judgement: Phase 3 as written is necessary but not sufficient. Add:
- an up-front document set and a global id index;
- context-typed targets in fragment documents;
- URI normalisation;
- a version-mixing rule;
- loader hardening;
- a loaded-document alias bound;
- bytes input and decoding.

**There is no bundling phase.** AGENTS.md lists "documents, bundling" among phases 3 to 7, but the plan has none. See §6.

### 6. Output and handling beyond resolve

| Candidate | Spec says it is part of reading? | Package | Recommendation |
|---|---|---|---|
| Bundling many documents into one (rewrite external refs to local `#/components/...` or `$defs`, keep `$id` resources, avoid name collisions) | No (tooling) | **missing, unplanned** | Reader-adjacent; belongs in this package as its own phase once Phase 3 exists. `inline-once` across documents would leave relative refs that no longer resolve. |
| Full dereference | — | **works in memory** (`share`/`site`/`keep`); `copy` bounded by `budget`; DAG/cyclic output | Done. |
| Writing back out (JSON/YAML) | — | **missing.** The raw tree loses comments, anchors, quoting style, number spelling (`1.0` becomes 1, big ints lose precision) and key order (integer-like names first in JS). `ts/doc/concepts.md` says "A formatter writes the document back"; nothing supports a lossless write. | Decide scope. JSON output from `inline-once` is possible today. |
| Validation against the OAS | — | Plan non-goal (§1: "the error codes and the `connections` report are the only structural checks in v1; a validator is a possible later package") | Consumer, or a later package. |
| Path templating equivalence (`/pets/{a}` vs `/pets/{b}`), concrete-before-templated matching | 3.2.0 Paths: "Templated paths with the same hierarchy but different templated names MUST NOT exist"; "Path Templating Matching" | ignored. Plan Phase 4 parses templates and checks params, not equivalence. | Report in `connections` (cheap, needs Phase 4's reader). |
| Path Item parameters inherited by operations, override by (name, in), never removed | 3.2.0 Operation `parameters`; 2.0 same | ignored. Phase 4 computes the effective set internally for its link checks. | Export an "effective operation" helper (reader-level, since spec semantics decide meaning), opt-in. |
| `servers` inheritance (root → path → operation; empty or missing means `[{url:'/'}]`); relative server URL against the document URI | 3.2.0 `servers`; "Relative References in API URLs" | ignored | Same helper. Needs the retrieval URI. |
| `security` inheritance and override (`[]` removes, `{}` optional) | 3.2.0 Operation `security` | ignored | Same helper. |
| Header params `Accept`, `Content-Type`, `Authorization` "SHALL be ignored" | 3.2.0 Parameter `name` | ignored | Same helper, flagging them. |
| `style`/`explode`/`required` defaults; Encoding `contentType` defaults; `allowReserved` | 3.2.0 Parameter, Encoding | ignored | Consumer (serialisation), or the helper with defaults filled. |
| `nullable` (3.0) vs `type: [..,'null']` (3.1) | 3.0.4 Schema | ignored | Consumer (a normaliser), not the reader. |
| 2.0 `consumes`/`produces`/`schemes` override and clear; `host`+`basePath`+`schemes` as base URL; `collectionFormat` default | 2.0 Operation | ignored | Same helper for 2.0. |
| Discriminator implicit mapping | 3.x Discriminator | missing | Reader (connections); planned in §3.4. |

### 7. Robustness on valid input that looks hostile

| Case | Measured | Limit |
|---|---|---|
| Alias "billion laughs" (10-wide, n levels) | 349 B: 69 ms, +24 MB. 408 B: 777 ms, **+268 MB**, resolve 727 ms. **467 B (n=7): V8 "heap out of memory", process aborted (uncatchable)**. Aliases are deep copies (`p7.cjs`). | **None.** Plan Risks says "apidef's guard stays until yaml bounds it", but Phase 5's yaml row does not list an alias bound. |
| Deep nesting | parse (fast, grammar, YAML flow) to 20,000 levels OK; YAML block 2,000 OK. **`resolve` throws `fold_depth` at 1000** (nesting plus reference hops), also on a 5,000-link `$ref` chain (`p7b.cjs`). It is a thrown expr `FoldError`, not a `ResolveError` or a report row. | `maxDepth` default 1000 (expr `foldTree`). The error type is inconsistent. |
| Large documents | Synthetic 1.37 MB YAML parses in 1.15 s (about 1.2 MB/s); 1.0 MB JSON in 44 ms (fast) or 966 ms (grammar); resolve 385 ms for 4,050 sites. A 20–30 MB YAML description would take tens of seconds. | none |
| Awkward keys `__proto__`, `constructor`, `toString`, `""`, keys with `/` and `~` | **work** as targets and in pointers (`p7c.cjs`); null-prototype maps on both paths | — |
| Lone surrogates | kept on the fast and YAML paths | — |
| Very long strings (100 KB plain line) | OK | — |
| Numbers beyond double | precision lost (§1) | — |
| Engine bounds | `rule.maxmul` 3, `rewind.history` 64 (`parser/ts/src/defaults.ts`); `copy` budget; no input-size or alias limit | — |

---

## (2) Ten most important gaps, ranked by how many valid real descriptions they affect

1. **Multi-document descriptions are not resolved** (§5). Split files are the norm for 2.0/3.0 hand-written APIs and are common in 3.1. Every external `$ref` is left `external`.
2. **Reference targets are not interpreted in the referring context** (Appendix G). Refs into `x-` stores, into draft-07 `definitions`/`dependencies`/`additionalItems`/array `items`, and (once Phase 3 lands) into every fragment document return the target with inner refs raw, **reported as resolved**. Silent wrongness, and it gates Phase 3 correctness for 2.0/3.0 multi-file sets.
3. **YAML 1.1 scalars** (`yes/no/on/off` in 12 casings, `1_000`, `0b…`). Hits enums of country and language codes (`NO`), feature flags and `yes/no` string enums in YAML descriptions. Silent type change.
4. **Integers beyond 2^53 lose precision.** int64 bounds in `maximum`/`minimum`/`default`/`example`/`enum` are common in generated descriptions. Silent.
5. **Non-2020-12 dialects leave all schema refs unresolved:** draft-07, 2019-09, `…/2020-12/schema#`, custom `jsonSchemaDialect`. 3.1 descriptions often paste JSON Schemas carrying a draft-07 `$schema`, and a custom root dialect unresolves the whole document.
6. **`$ref` into its own subschema (`$ref` + `$defs`) is cut as a cycle, along with every reference to it.** This is the standard shape of bundled 2020-12 schemas, which 3.1 descriptions embed. Silent loss.
7. **Unbounded alias expansion, which crashes the process.** It affects any service parsing untrusted YAML, and benign heavy anchor use costs memory because aliases are copied.
8. **No bundling or writer** (no plan phase), so "handle" ends at an in-memory graph. Needed for any tool that emits a single file.
9. **`fold_depth` at 1000 throws** (deeply nested schemas, long chains). Rare, but it is a hard failure on valid input with an error type outside the package's own.
10. **Missing reader-level semantics and reports:**
    - the implicit discriminator mapping, and 2.0 discriminator;
    - path-template equivalence;
    - Reference Object target-type conflicts;
    - URI normalisation for same-document and `$id` equality;
    - 3.0 component-name regex dropping refs silently;
    - trailing empty YAML document refused as a stream.

---

## (3) Every probe that showed wrong behaviour

All inputs were run through `parse` and then `resolve` with default options unless noted.

- **3.1 YAML 1.1 booleans**
  - Input: `openapi: 3.1.0\nenum: [NO, SE, DK, On, n, Y]`
  - Expected: `["NO","SE","DK","On","n","Y"]`. YAML 1.2 core, required by 3.2.0 "JSON and YAML Compatibility" and recommended by 3.0.4/3.1.2.
  - Actual: `[false,"SE","DK",true,"n","Y"]`

- **3.2 Big integer**
  - Input: `openapi: 3.1.0\nmax: 9223372036854775807`, and the same as JSON.
  - Expected: the integer 9223372036854775807. JSON/YAML integers; `format: int64`.
  - Actual: `9223372036854776000` on both paths.

- **2.1 Trailing empty document**
  - Input: `openapi: 3.1.0\n---\n`, `openapi: 3.1.0\n---\n# end\n`, `openapi: 3.1.0\n...\n---\n`
  - Expected: arguably the description, since the stream's only non-null document is it.
  - Actual: `ERROR openapi_stream`

- **2.2 Strict with BOM**
  - Input: `﻿{"openapi":"3.1.0"}` with `{strict:true}`
  - Expected: `{"openapi":"3.1.0"}`. RFC 8259 §8.1: parsers "MAY ignore the presence of a byte order mark".
  - Actual: `ERROR unexpected`

- **2.3 CR-only line break**
  - Input: `openapi: 3.1.0\ra: 1`
  - Expected: `{"openapi":"3.1.0","a":1}` (YAML 1.2 b-break).
  - Actual: `ERROR unexpected`

- **2.4 Blank line before JSON, grammar path** (known, `DIVERGENCE.md`)
  - Input: `\n{"openapi":"3.1.0"}` with `{fast:false}`
  - Actual: `ERROR unexpected`

- **2.5 Tab indentation** (invalid input, but misread rather than refused)
  - Input: `openapi: 3.1.0\ninfo:\n\ttitle: x`
  - Actual: `{"openapi":"3.1.0","info":null,"title":"x"}`

- **3.3 Refs inside non-applicator schema keywords (3.1)**
  - Input: `{openapi:'3.1.0',components:{schemas:{A:{type:'string'},B:{definitions:{x:{$ref:'#/components/schemas/A'}}},C:{$ref:'#/components/schemas/B/definitions/x'}}}}`
  - Expected: C becomes `{"type":"string"}` (the target is read as a Schema, its reference context, per 3.2.0 Appendix G), or at least an `unresolved` row.
  - Actual: C is `{"$ref":"#/components/schemas/A"}`, `unresolved: []`, `cuts: []`, provenance `resolved`, `dataSlots: 1`.
  - Same for `dependencies: {p: {$ref…}}` and `items: [{$ref…}]` / `additionalItems` (left raw, nothing reported).

- **3.4 `$ref` to own `$defs`**
  - Input: `{openapi:'3.1.0',components:{schemas:{B:{$id:'https://e.com/s',$ref:'#/$defs/x',$defs:{x:{type:'string'}}},C:{$ref:'https://e.com/s'}}}}`
  - Expected (2020-12 `$ref` applicator): B becomes `{allOf:[{type:'string'}],$id,$defs}`; C is the same.
  - Actual: B and C are left as written; `cuts` holds both `/components/schemas/B` and `/components/schemas/C`.
  - Without `$id` (`$ref:'#/components/schemas/B/$defs/x'`) the result is the same cut. In 3.0 `{$ref:'#/…/B/properties/x', properties:{x}}` is also cut.

- **3.5 Pointer through a site (3.0)**
  - Input: `{openapi:'3.0.3',components:{schemas:{A:{properties:{x:{type:'string'}}},B:{$ref:'#/components/schemas/A',properties:{x:{type:'integer'}}},C:{$ref:'#/components/schemas/B/properties/x'}}}}`
  - Expected: `{"type":"integer"}`, by RFC 6901 on the document.
  - Actual: `{"type":"string"}`

- **3.6 Target outside typed positions**
  - Input: `{openapi:'3.0.3',paths:{'/a':{get:{responses:{'404':{$ref:'#/x-common/NotFound'}}}}},'x-common':{NotFound:{description:'nf',content:{'application/json':{schema:{$ref:'#/components/schemas/E'}}}}},components:{schemas:{E:{type:'object'}}}}`
  - Expected: the response, with its schema resolved to `{type:'object'}` (Appendix G reference context).
  - Actual: `{"description":"nf","content":{"application/json":{"schema":{"$ref":"#/components/schemas/E"}}}}`, `unresolved: []`, provenance `resolved`.

- **3.7 3.0 component name outside the regex**
  - Input: `{openapi:'3.0.3',components:{schemas:{A:{type:'string'},'B C':{properties:{p:{$ref:'#/components/schemas/A'}}}}}}`
  - Actual: `B C` is unchanged, `unresolved: []`, `dataSlots: 1`. The same input under 3.1 resolves.

- **3.8 Dialects** (3.1, `B:{$schema:X,$ref:'#/components/schemas/A'}`)
  - X = `http://json-schema.org/draft-07/schema#`, `https://json-schema.org/draft/2020-12/schema#`, or `https://json-schema.org/draft/2019-09/schema`; or root `jsonSchemaDialect:'https://example.com/my-dialect'` (which hits every schema ref).
  - Expected: resolved. Draft-07 and 2019-09 share `$ref` targeting; the empty fragment names the same meta-schema; a custom dialect is allowed by 3.1/3.2.
  - Actual: `unresolved … why:"unsupported-dialect"`. The spec permits a tool to support only the OAS dialect ("MAY support additional values"), so this is a gap against "handle all", not a violation.

- **3.9 URI equivalence**
  - Input: `$ref` `HTTPS://E.COM/a/api.yaml#/info`, `https://e.com:443/a/api.yaml#/info` or `https://e.com/a/%61pi.yaml#/info`, with `retrievalUri:'https://e.com/a/api.yaml'`. Also `$ref:'https://E.com/s/a'` against `$id:'https://e.com/s/a'`.
  - Expected: resolved (RFC 3986 §6.2.2/6.2.3 normalisation, cited from knowledge).
  - Actual: `why:"external"`

- **7.1 Alias bomb**
  - Input:
    ```
    openapi: 3.1.0
    l0: &l0 [x,x,x,x,x,x,x,x,x,x]
    l1: &l1 [*l0 ×10]
    …
    l7: &l7 [*l6 ×10]
    ```
    (467 bytes)
  - Expected: a bounded refusal (a valid but hostile YAML document; 3.2.0 Security Considerations points to YAML's).
  - Actual: `FATAL ERROR: … JavaScript heap out of memory`, process aborted. At n=6 (408 B): 268 MB, 0.8 s.

- **7.2 Depth**
  - Input: nesting or a `$ref` chain deeper than 1000.
  - Actual: throws expr `FoldError fold_depth` ("nesting and references deeper than 1000"); parse alone is fine to 20,000.

- **3.10 3.2 Media Type `description` override**
  - The resolver overrides `description` for a Reference Object pointing at a Media Type (`OVERRIDE['3.2'].mediaType`). The 3.2.0 and 3.2.1 Media Type Fixed Fields have no `description`; only the vendored 3.2 schema does. Text rule: "If the referenced object-type does not allow a description field, then this field has no effect."

---

## (4) Questions only the maintainer can decide

1. **Scope of "handle":** reference resolution plus connections only, or also an opt-in "effective operation" view? That view would cover inherited parameters, servers, security, ignored headers, and 2.0 consumes/produces/schemes. The recommendation is that a reader exposes it opt-in, and that defaults, `nullable` normalisation and serialisation stay with consumers.
2. **Bundling and writing:** are they in scope? If so, add a phase: bundle to which layout (`components` vs `$defs`), JSON and/or YAML output, and whether comments, anchors and key order are preserved (which needs a CST the grammar does not keep).
3. **YAML scalar default:** 1.2 core, the JSON schema ruleset, or keep 1.1 booleans and number syntax? And keep merge keys `<<` (a 1.1 feature) under a 1.2 setting?
4. **Big numbers:** BigInt, lossless number objects, or keeping the source text? This affects tree types and the fast path.
5. **Alias policy:** a default expansion bound, and whether aliases share identity (a DAG) instead of copying.
6. **Dialects:** support draft-04/06/07 and 2019-09 (Decision 13 defers this). Should an unknown custom dialect default to 2020-12 semantics with a report? Should `…/schema#` and `http://` variants be normalised?
7. **Reference-context typing (Appendix G):** interpret targets by the referring site's kind, with a conflict report? Report or ignore type mismatches?
8. **Pointer semantics:** keep the fold's "a path through a site reads its resolved value" (apidef's followAlias, which causes 3.4 and 3.5) as default, or use the raw RFC 6901 path by default and keep followAlias for `compat:'apidef'`? This is an expr-level change.
9. **Phase 3 additions:**
   - an up-front document set;
   - a global `$id` index;
   - URI normalisation;
   - mixed-version referenced documents;
   - whether the package ships safe file and HTTP loaders or none;
   - timeouts, cancellation and caching;
   - bytes input and decoding.
10. **Leniency questions:**
    - trailing empty YAML documents;
    - BOM under strict;
    - 3.0 component names outside the regex;
    - unknown future versions read as 3.2;
    - `fold_depth` as a thrown error vs a report, and its default of 1000.
11. **Text vs schema:** follow the text or the schema where they differ (3.2 Media Type `description`)?
12. **Patch releases:** should 3.1.2 and 3.2.1 (both published) be named targets?

---

## (5) What I could not verify

- **Multi-document behaviour:** nothing exists to probe, so §5 is from the spec, the plan and expr's fold API.
- **Real-world prevalence:** the ranking is reasoning, not measurement (another agent has the corpus).
- **The full YAML Test Suite and YAML Test Schema through this plugin:** I relied on yaml's ledgers plus targeted probes.
- **The JSON Schema test suite** (`$id`/`$anchor`/`$dynamic*`): it is planned in plan §7 and not vendored here, so not run.
- **Draft-04 "canonical dereferencing"** in 2.0 (whether `id` changes the base): read from the 2.0 text only; the package ignores `id`.
- **Positions and columns:** not audited.
- **Size:** performance above about 1.4 MB was not measured.
- **Citations from knowledge, not fetched:** RFC 6901, RFC 3986 §6 normalisation, and JSON Schema 2020-12 semantics.

---

## Existing plan, phases 3 to 7: commitments and open items

- **Phase 3 (documents):**
  - Commits to: a documents table behind the fold's `load`; root-kind detection (openapi, else Schema, else inferred); a loader that is off by default with an `allow` list, 64 documents and 64 MiB; sync `resolve` plus async `resolveAll`; `no-base-uri`; implicit connections across documents per the spec; `test/docs/` fixtures.
  - Leaves open: everything listed in §5's "Omitted" items.
- **Phase 4 (embedded languages):**
  - Commits to: `readExpression`, `readTemplate`, static link and parameter checks (path-param correspondence, single-occurrence template expressions, `url` without query or fragment, declared server variables), and `evaluateExpression`. None of it is implemented yet (not exported).
  - Leaves open: path-template equivalence; exporting the effective parameter set it computes; server URL building and variable substitution; style/explode serialisation.
- **Phase 5 (upstream):**
  - Commits to: expr's predicate key operator; parser's `parse.complete`; yaml's info marker, column drift, leading-newline JSON and a plain-scalar schema option; jsonic's info merge.
  - Leaves open: an **alias expansion bound** (named only in Risks); number fidelity; CR line breaks; trailing empty documents; the pointer-through-site semantics in expr.
- **Phase 6 (apidef migration):** consumer work. Not relevant to "all valid descriptions".
- **Phase 7 (docs and release):**
  - Commits to: Diátaxis pages; the descriptor and fleet rows; release prerequisites; the conformance write-up (§7 corpora: OAI examples including multi-document, the JSON Schema suite's ref cases, Stripe, GitHub, APIs.guru, apidef).
  - Leaves open: no bundling phase anywhere, despite AGENTS.md listing one; no writer; no validator (an explicit non-goal).
