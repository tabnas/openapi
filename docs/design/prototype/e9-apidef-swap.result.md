# E9: apidef's suite run against this package

The report of one research pass for [`../typescript-plan.md`](../typescript-plan.md),
taken on 12 November 2026 against `@tabnas/openapi` 0.1.0 as built from this
repository, and kept as it was written. The two swaps are in [`e9-apidef-swap/`](e9-apidef-swap/) as diffs against `voxgig/apidef` at 3058271.
A path under `<scratch>` names the working folder of that research session,
which is not kept; a path under `/home/user` names a checkout on the machine
that ran it.

---

## Report: replacing apidef's parse stage with @tabnas/openapi (TypeScript only)

I touched neither original checkout; `git status` is clean in both /home/user/voxgig/apidef and /home/user/openapi. All the work is under <scratch>/:
- `apidef/`: the variant 1 clone. It holds the real `npm ci` install, with `node_modules/@tabnas/openapi` symlinked to /home/user/openapi/ts.
- `apidef-v2/`: the variant 2 clone.
- `apidef-base/`: an untouched clone, used for the baseline library calls.
- `tools/`: the harnesses.
- `models/`: model dumps from the whole pipeline, one per configuration.

Node 24.22.1 (`/opt/node24/bin`). The default `node` on this machine is 22.

**The most important finding:** @tabnas/openapi does not resolve against the versions apidef installs today. `npm view @tabnas/openapi` returns 404, so it is not published. With apidef's locked tree, `parse` works but `resolve` throws `(0, expr_1.fold) is not a function` on all 43 test definitions:
- apidef's lockfile resolves `@tabnas/expr` 0.5.10, because aontu 0.76.x pins it exactly.
- `fold` was added after 0.5.19, by the expr git history (the commit of 2026-11-08); I could not confirm the first registry version that has it.
- openapi declares `@tabnas/expr: ">=0"`, which is too loose.

My variants worked only because the symlinked openapi loads its own node_modules: parser 0.12.20, jsonic 0.7.11, yaml 0.5.32, expr 0.5.21, json 0.5.20.

### (1) Baseline (unchanged apidef, `npm ci` from its lockfile)
- `npm test`: comment gate clean, dependency gate clean, dep-gate suite 25/25.
- Main suite: **2475 tests, 157 suites, 2474 pass, 0 fail, 1 skipped** (`full-solar`, "SOLAR_MODEL has drifted"). The test runner reports 7.06 s; the whole `npm test` takes about 10 s.
- The lockfile resolves `@tabnas/jsonic` 0.7.1, `@tabnas/yaml` 0.5.15 (older than the 0.5.32 explicit-key fix) and `@tabnas/parser` 0.12.2.
- The build (`tsc --build src test`) reproduces the committed `dist` byte for byte.

Two latent bugs in the error wrapping of `parse()` (ts/src/parse.ts:32-50):
- **The `syntax:` branch never runs.** Engine errors carry `code: 'unexpected'`, not a `jsonic…` code, and have no `originalError`. Every syntax error therefore reads `@voxgig/apidef: parse: internal: [jsonic/unexpected]…`. The `/syntax/` tests pass only because jsonic's hint text contains "expected syntax".
- **apidef's own errors are prefixed twice:** `@voxgig/apidef: parse: internal: @voxgig/apidef: parse: JSON/YAML source must be an object (f)`.

### (2) Variant 1: the most complete swap the current package allows
Diff: <scratch>/variant1.diff (183 lines; ts/src/parse.ts loses about 120 lines). In outline:
- `import { parse as readOpenAPI, resolve as resolveOpenAPI } from '@tabnas/openapi'` replaces `Yaml` and `yamlParser`.
- `readOpenAPI(source)`; `openapi_root` and `openapi_stream` are mapped to apidef's "JSON/YAML source must be an object" message.
- apidef's own root-object check is deleted; the version check stays.
- The resolution step is now `parsed = resolveOpenAPI(parsed, { compat: 'apidef' }).tree`.
- Deleted: `addXRefsAndResolve`, `resolveRefSite`, `replaceOwnKeys`, `refSiblings`, `isAlias`, `pointerChild`, `resolvePointer`, `followAlias`, `INDEX_RE`.
- Kept: `validateSource`, `validateAliases`, `wellFormed`, the `components` default, `normalizePathKeys`, `normalizeColonPathParams`, `dropIgnoredHeaders`, `decycle`.

**Result: 2473 pass, 1 fail, 1 skipped**; 7.03 s; both gates clean. The dependency gate passes only because `package.json` was not edited: the new import is undeclared.

The one failure is parse-resolve.tsv row 31, "the operations of one path spelled twice merge":
- It expects `["get","put"]` and gets `["put"]`.
- **Cause: the policy for a repeated member name.** jsonic+yaml deep-merges a repeated key, in both 0.5.15 and 0.5.32. The OpenApi plugin deliberately keeps the last value (reference.md: "keeps its last value, whole"). I checked this directly: `oa.parse` gives `{"/a":{"put":…}}`, while plain Jsonic+Yaml gives get and put.
- This is not caused by the yaml version or by apidef's later stages.

Whole-pipeline check (`tools/model.cjs`: guide, transformers and builders, with generate off): **guide and apimodel are byte-identical to the original on all 54 definitions** (43 test definitions and 11 OpenAPI Initiative examples) **and on GitHub REST** (56 MB). GitHub took 3.9 s against 5.8 s for the original (one run each). Stripe fails in both the original and variant 1 after about 112 s with `RangeError: Invalid string length`: `heuristic01` `resolveSchemaProperties` calls struct `clone` (a JSON round trip) on the shared DAG. This is a pre-existing apidef limit; I captured the error text for the variant only, and the original stopped at the same step at the same time.

### (3) Variant 2: removing each remaining step
Prototype with one environment toggle per step: <scratch>/parse-v2-toggles.ts (diff in variant2-prototype.diff). The clean patch for what can be removed today (a): <scratch>/variant2.diff.

The table counts failures beyond variant 1's row 31.

| Step | Removable now? | New failures |
|---|---|---|
| (a) decycle and `DECYCLED` → `cycles:'cut'` | **Yes** | 1 test; 3 if the prototype walk also goes |
| (b) refcount / `x-ref` walkers | refcount: yes, under `cut`; `x-ref`: keep | none for refcount |
| (c) `validateSource` | Needs openapi | 5 (pin `/empty/`) |
| (c) `validateAliases` | **No** | tsv.test.js crashes (OOM) |
| (c) version check | Keep, as policy | 2 (`/Unsupported/`) |
| (c) mapping of `openapi_root` | Keep, or change the message | 2 (`/JSON/`) |
| (d) `wellFormed` | Needs openapi | 5 |
| (e) `normalizePathKeys` | Needs a @tabnas/yaml fix | 1 |
| (f) `dropIgnoredHeaders` | Needs openapi, or keep | 3 |
| (g) `components` default | Yes (public API change) | 1 (`happy`) |
| (g) colon path parameters | Keep, as policy | 6 |

**(a) decycle and `DECYCLED` → `cycles: 'cut'`. Removable now.** variant2.diff: parse.ts −217/+31 lines, refcount.ts uses plain indexing in place of `decycledChild`, tsv.test.ts drops one import. Suite: 2472 pass, 2 fail (row 31, plus parse.test.ts:97 "a schema that is its own item…").
- The test at parse.test.ts:97 pins two things:
  - the `[Circular *` marker in `JSON.stringify` (line 107);
  - one extra level of unrolling: under keep+decycle, `s.items.type === 'array'`; under cut, `s.items` is the closing reference `{ $ref, 'x-ref' }`.
- Without the 15-line prototype walk, two more tests fail, `happy` and "a target is resolved once…". Both compare with `deepStrictEqual` and openapi's maps have a `null` prototype. No other code needs `Object.prototype`.
- Model: identical on 53 of 54 definitions and on GitHub. array-body differs only in the in-memory guide's `$`-suffixed `paths$[].def` copies of the definition; the apimodel and the guide without `$` keys are identical.
- `countRefs` is identical to the original on all 56 definitions (including Stripe and GitHub), and all 28 ref-count.tsv rows pass. A cut site keeps `x-ref`, which `refLabel` reads.
- No apidef source reads the marker text. The markers matter only because they make the tree acyclic, which cut also does.
- Proposal (optional): `resolve(raw, { prototype: 'object' })`. Pinned: `Object.getPrototypeOf(resolve(parse('{"openapi":"3.0.0","info":{}}'), { prototype: 'object' }).tree.info) === Object.prototype`.

**(b) refcount.ts and the `x-ref`/`$ref` walkers.**
- refcount needs no openapi change under `cut`.
- I also rebuilt `countRefs` from the `provenance` report (tools/refcount-prov.cjs). It is identical on all 28 rows and 56 definitions, under both keep and cut.
- Provenance alone is not enough, though. The rebuild also needs:
  - the raw tree, for the sibling members beside `$ref` and for alias chains;
  - the resolved tree, to know which target members have children.
- Proposal if wanted: give each provenance entry `siblings: string[]`. Example: for `{"$ref":"#/components/schemas/Pet","description":"d","properties":{…}}` the entry would carry `siblings: ["description","properties"]`. A further option would be a `uses: Record<ref, number>` report, but its cycle-cut order (code-point order of the label plus the overridden members) is apidef's own rule.
- `x-ref` must stay (`xref: true`). The heuristics, transforms and tests read it, and `ResolvedSpec.def` publishes it.
- `connections` is not used by anything in apidef.

**(c) Errors.**
- **`validateSource`**: openapi throws `openapi_root` with kind "empty" for `''` but "null" for whitespace or comment-only text. Five assertions pin `/empty/` or `/source is empty/`. Proposal: a code `openapi_empty` for text with no content (empty, whitespace only, comments only), with `parse('# c')` raising it.
- **`validateAliases`**: not removable. Without it, tsv.test.js crashes, so only 495 of 2475 tests ran.
  - openapi has no alias guard, and @tabnas/yaml copies each anchored value at every alias (`copyAnchored`).
  - On the eight-level bomb that the test builds, `parse` takes 2 s and `resolve` runs out of memory at about 2 GB.
  - Proposal: `parse(text, { aliasBudget?: number })`, default `max(1_000_000, 10 × UTF-8 bytes)`, raising `openapi_alias_budget` with `{size, limit}` details. It would be enforced inside @tabnas/yaml during alias expansion.
  - Pinned: `/YAML aliases would expand the source to about \d+ bytes, past the limit of 1000000/`. yaml-aliased-size.tsv (13 rows) tests `yamlAliasedSize` itself and goes with yamlalias.ts.
- **Version check**: openapi checks the version only under `strict`, which reads JSON only. Keep it as apidef policy (`null === version(raw).field` is equivalent except for falsy values). It pins `/Unsupported/`.
- **Root check**: if `openapi_root` is not mapped, `'bad'` fails `/JSON/` (parse-errors.tsv and parse.test `happy`).
- Every error message apidef's tests pin:
  - `/unknown/`, `/string/`, `/JSON/`, `/Unsupported/`;
  - `/empty/` and `/source is empty/`;
  - `/syntax/`, which matches only by accident;
  - the alias message above.

**(d) `wellFormed`.** Five parse-resolve rows fail without it: 33 lone surrogate in keys, values and references; 34 escaped pairs in JSON; 35 keys a lone surrogate makes equal merge; 36 YAML surrogate escapes; 40 interrupted pair. Proposal: `parse(text, { wellFormed: true })`, with every lone surrogate in a key or string becoming U+FFFD and keys this makes equal following the repeated-key rule. Pinned: `"\ud83dA\ude00"` becomes `"�A�"`.

**(e) `normalizePathKeys` is not dead.**
- Without it, row 37 fails: yaml 0.5.32 still keeps the quotes on an explicit key whose double-quoted text has a lone-surrogate escape, so `? "/a\ud800"` gives the key `"\"/a\\ud800\""`. This is a @tabnas/yaml bug.
- Every other case is dead under 0.5.32.
- Under apidef's locked 0.5.15, `? "/esc/A\/b"` and `? "/x\x41"` also keep their quotes, so removing it also depends on the yaml version actually installed.

**(f) `dropIgnoredHeaders`.**
- Without it, three ignored-headers.tsv rows fail, including "a-definition-cannot-plant-the-record": apidef deletes a document-supplied `x-apidef-ignored-headers`.
- This is the OAS 3 "SHALL be ignored" rule. Proposal: `resolve` reports `ignored: {at, name, path, method?}[]` for 3.x documents, with an option `ignoredHeaders: 'drop' | 'keep'` (default `keep`).
- apidef would then keep the record in ctx rather than on the definition, and transform/top.ts:138 would read it there.

**(g) `components` default and colon path parameters.**
- `components` default: only `happy` fails. Every reader uses `?.` (top.ts:364, 571; resolved.ts:76). It is apidef compatibility, documented in docs/reference/api.md:109.
- Colon path parameters: six tests fail without them, including resolved.test "the definition it carries is the PARSED one". Colon paths are not OpenAPI, so this is apidef policy and stays in apidef.

Shared identity and per-site copies:
- With `sharing:'share', xref:false`, 84 tests fail. `xref:true` forces a copy per site, so per-site copies are load-bearing.
- Deep-freezing the parsed definition makes 85 tests fail. **Later stages do write into the parsed tree.**

### (4) What later stages read from the parse output (ts/src, at 3058271)
- **Writes into the definition:** jostraca `each()` writes `key$` (and `index$` on arrays) onto definition nodes. The suite made 5,818 such writes. This contradicts docs/reference/pipeline.md:29-30 ("read-only downstream").
  - Write sites: guide/guide.ts:527, 531; utility.ts:1690; guide/heuristic01.ts:2449, 3045; transform/field.ts:936 (`index$`), 998; transform/args.ts:140.
  - Read back: guide.ts:528, 532-533; utility.ts:1692; field.ts:61, 715, 999.
  - This works only because every reference site is a distinct object.
- **`x-ref`:**
  - guide/heuristic01.ts:402, 405, 1486, 1537, 2153, 2167, 2172, 2222-2231, 2737, 3048 (deep `find(…,'x-ref')`), 3103-3104, 3140-3141;
  - transform/body.ts:618-619; transform/field.ts:366-372; utility.ts:1968, 2174; refcount.ts:51-53.
- **A `$ref` that survives** (unresolved, or a cut site under `cut`): transform/field.ts:383 (follows one hop), transform/args.ts:150, utility.ts:1891 and 2090 (count it as an object schema), refcount.ts:52.
- **Markers and `DECYCLED`:** only refcount.ts:3, 103, 127, 140, 148, 150, through `decycledChild` (parse.ts:247).
- **Acyclicity:**
  - heuristic01.ts:2784 and 2789 use struct `clone`, a JSON round trip;
  - apidef.ts:244 writes `<def>.full.json` under debug (pinned at cli.test.ts:283-284).
- **Shared identity:**
  - union.test.ts:154-166 asserts it with `strictEqual`;
  - refcount.ts:112 compares with `a === b`;
  - heuristic01.ts:2776-2789 clones because children are shared;
  - parse.test.ts bounds the size of the shared graph (fewer than 1000 or 200 objects).
- **`x-apidef-ignored-headers`:** transform/top.ts:11, 138.
- **Path keys in brace form:** resolved.ts:49, 89 and the guide.
- **Key order:** `each` sorts its keys (jostraca basic.ts:68); resolved.ts:89 follows `Object.keys(def.paths)`. The variants keep the same order.
- **Prototype:** only tests depend on it.
- **Visible outside apidef:**
  - `parse` is a documented export (docs/reference/api.md:97-112);
  - `ResolvedSpec.def` (resolved.ts:126-156, apidef.ts:249) gives downstream tools such as sdkgen the parse output, with its markers or cut shape, `x-ref`, colon rewrites and the `key$` annotations added later.

### (5) Recommended split
**Move to @tabnas/openapi** (with @tabnas/yaml where noted):
- an empty-text code;
- an alias expansion budget (enforced in yaml);
- the `wellFormed` option;
- a repeated-key option, `duplicates: 'last' | 'merge'`, unless apidef accepts last-wins;
- the reserved-header report;
- optionally `prototype: 'object'`;
- correct peer ranges (`@tabnas/expr` must be newer than 0.5.19, the first release with `fold`).

Fix in @tabnas/yaml: the explicit key with a lone-surrogate escape.

**Keep in apidef, as policy:**
- the version acceptance check;
- apidef's error wording and mapping;
- colon path parameters;
- the `components` default, as long as the public API promises it;
- `countRefs` (its cycle order is apidef's own);
- `x-ref`, as a contract;
- the ignored-header warning.

**Delete:**
- the hand-written resolver (now);
- decycle, `DECYCLED` and `decycledChild`, using `cut` (now);
- `normalizePathKeys` (after the yaml fix);
- `wellFormed` and the `Jsonic` import (after the openapi option);
- `validateSource` (after `openapi_empty`);
- yamlalias.ts and its TSV (after the alias budget).

### (6) Migration steps, each shippable on its own
These are the dependency changes each step would need, listed only; none is decided.
- **Step 0.** Fix the dead `syntax` branch and the double prefix. No dependency change.
- **Step 1.** Variant 1, with ts/dist rebuilt.
  - Dependencies: add `@tabnas/openapi` (it must be published first). Have a newer `@tabnas/expr` that has `fold`, plus `@tabnas/json`, at the top level of the lockfile; aontu keeps its exact pins nested. In my scratch copy, `npm install @tabnas/parser@latest` failed with ERESOLVE (peer conflict on `@tabnas/parser`). Optionally remove the now-unused `@tabnas/yaml` peer.
  - It also needs a decision on repeated keys (row 31).
- **Step 2.** `cycles: 'cut'` (variant2.diff). Update parse.test.ts:97 and pipeline.md. No dependency change.
- **Step 3.** Drop `validateSource`, then `validateAliases` and yamlalias.ts, once openapi and yaml have the new codes. Needs new openapi and yaml versions.
- **Step 4.** `wellFormed` moves to openapi. Needs a new openapi version; optionally remove the `@tabnas/jsonic` peer.
- **Step 5.** Drop `normalizePathKeys` after the yaml fix. Needs a new yaml version.
- **Step 6.** Ignored headers: move the record into ctx, using the openapi report if it exists. Needs a new openapi version, if so.
- **Step 7 (optional).** Drop the `components` default: a public API change, no dependency change.

### (7) What I could not verify
- That openapi works with the versions apidef actually resolves. Resolve fails on expr 0.5.10, and a control install of the latest jsonic, yaml and parser in apidef failed with ERESOLVE. In particular, the effect of yaml 0.5.15 under openapi is untested.
- The full pipeline on Stripe: it fails in both versions with the RangeError above.
- The registry tarball of the first `@tabnas/expr` with `fold`.
- Whether downstream users of `ResolvedSpec.def` (sdkgen and others) read the markers or the `components` default: outside this repository.
- Performance beyond single runs.
