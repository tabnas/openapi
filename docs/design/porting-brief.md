# The brief for porting

This is the hand-off that T6 of [`typescript-plan.md`](typescript-plan.md)
asks for, its third item: what a port of the TypeScript package is held
to, each option with the default it has today and the one it has once
porting starts, and what no fixture can carry. It is written for
whoever ports the package. Where `AGENTS.md`, `test/AGENTS.md` or the
[reference](../../ts/doc/reference.md) say more, they are the authority.

## 1. What a port is held to

**The fixtures are the contract.** What the package does, wherever data
can state it, is in a folder of `test/` in a format with no TypeScript
in it. [`test/AGENTS.md`](../../test/AGENTS.md) has every format. A port
has a runner for each folder, as `ts/test/` has, and has ported a
behaviour when the cases that pin it pass.

| Folder | What it holds | The runner here |
|---|---|---|
| `spec/` | what `parse` gives, in every implementation | `ts/test/parity.test.ts` |
| `pending/` | what `parse` gives in this package alone, the `lossy` report among it | `ts/test/pending.test.ts` |
| `bytes/` | what `parse` gives of a text given as bytes | `ts/test/bytes-spec.test.ts` |
| `long/` | what `parse` and `resolve` give of texts built from a recipe | `ts/test/long.test.ts` |
| `petstore/` | one description as YAML and as JSON | each suite's own package tests |
| `model/` | the state the object model gives a position | `ts/test/model.test.ts` |
| `resolve/` | what `resolve` gives of one document, and of several under the options a case of `docs/` cannot have | `ts/test/resolve-spec.test.ts` |
| `docs/` | what `resolve` and `bundle` give of a description in several files | `ts/test/documents-spec.test.ts` |
| `load/` | what `resolveAll` and `bundleAll` give, and what they ask a loader for; which addresses are public | `ts/test/load-spec.test.ts` |
| `bundle/` | what `bundle` writes | `ts/test/bundle-spec.test.ts` |
| `bundle-held/` | sets of documents a bundle has to keep the meaning of | `ts/test/bundle-spec.test.ts` |
| `expression/` | the readers of runtime expressions and templates | `ts/test/expression-spec.test.ts` |

Three things about them:

- **The line formats of `resolve/` are in its runner.** A report column
  holds one line for each row of the report, and the opening comment of
  `ts/test/resolve-spec.test.ts` is where each line's form is written
  down. A port's runner writes the same lines from its own reports.
- **A report's order is part of what a row pins.** Report arrays are in
  walk order: document order, with a landing entered at its first
  reference, and what only mapping values name in another document
  last. Under `cycles: 'keep'` it is plain document order.
- **A bundle is checked for what it means.** A case of `bundle/` and
  `docs/` says the bundle exactly, so a port that writes the same
  bundle is right. A set of `bundle-held/` says none: it is held to
  resolving to what its documents resolve to, which
  [`tools/corpus/bundle-agree.cjs`](../../tools/corpus/bundle-agree.cjs)
  decides. That tool is JavaScript, and it takes this package. Run as a
  command, it checks bundles that another implementation wrote, each
  given beside its set in a file of the form `bundle-held/` has:
  `node tools/corpus/bundle-agree.cjs <file.json>`. The documents and
  the bundle are both resolved by this package, so a port can hold its
  `bundle` to the documents before it has ported the check.

`corpus/` is a record, not a contract for a port. The corpus sweep, the
apidef gate and the preset comparison are run by hand on the TypeScript
package, and [`docs/conformance.md`](../conformance.md) says what they
measure. A port is not held to them. It is held to the fixtures, which
is how the two stay one package.

## 2. What a port builds on

- **The base grammars and the engine**, as raw mode has them today.
- **The tree layer of `expr`**, for the resolver: `fold`, with a step
  budget and `site.written`. Every implementation of `expr` has had
  both since 0.6.4. `tools/port-deps.json` records that the other
  implementations here do not depend on `expr` yet, with its repair:
  they take it when they port the resolver.
- **The object model**, [`model/object-model.json`](../../model/object-model.json),
  which is generated and is to be embedded as it is. It is the one
  statement of what a position in a description is, for every version.
  A port writes the stepper over it, `step` and `classify` in
  `ts/src/model.ts`, and `test/model/classify.tsv` holds that.
- **Nothing else is shared as code.** The rules of each schema dialect
  are `ts/src/dialect.ts`, the URI helpers `ts/src/uri.ts`, and both
  are short. `test/resolve/dialects.tsv` and `uris.tsv` hold them.

The parts, in the order they were built, which is an order a port can
take them in. Each can be merged alone, since each is an option or a
new function:

| Part | Source | Held by |
|---|---|---|
| `duplicates` on `parse` | `openapi.ts` | `pending/parse-duplicates.tsv` |
| `reading: 'spec'` | `openapi.ts`, `core-schema.ts` | `pending/parse-reading.tsv`, `parse-empty.tsv` |
| the limits on a text: aliases, size, work | `text.ts`, `yaml-alias.ts`, `openapi.ts` | `pending/parse-limits.tsv`, `long/parse.json` |
| bytes as input, and the byte-order mark | `text.ts`, `openapi.ts` | `bytes/parse.tsv`, `pending/parse-mark.tsv` |
| the `lossy` report | `lossy.ts`, `openapi.ts` | `pending/parse-lossy.tsv` |
| `wellFormed` | `well-formed.ts` | this package's own tests: see section 5 |
| the object model's stepper | `model.ts` | `model/classify.tsv` |
| the site index | `site-index.ts`, `dialect.ts`, `uri.ts` | every row of `resolve/`, through `resolve` |
| `resolve` | `resolve.ts` | `resolve/`, `docs/` |
| the `connections` report | `connections.ts` | `resolve/connections.tsv`, `reports.tsv`, `templates.tsv` |
| the apidef preset | `resolve.ts` | `resolve/apidef.tsv`, `apidef-extra.tsv` |
| several documents, given | `site-index.ts`, `resolve.ts` | `docs/`, `resolve/documents.tsv` |
| several documents, loaded | `resolve.ts` | `load/` |
| the operation view and `ignored` | `operations.ts` | `resolve/operations.tsv` |
| expressions and templates | `expression.ts` | `expression/`, `resolve/templates.tsv` |
| `bundle` and `bundleAll` | `bundle.ts` | `bundle/`, `bundle-held/`, `docs/`, `load/` |
| the loaders | `loaders.ts` | `load/addresses.tsv`, and its own tests |

Three notes on that table:

- **The site index is where the work is.** `resolve`, the reports and
  `bundle` all read it and add little. `AGENTS.md`, under "The
  resolver", says what it holds and why each rule is there.
  `ts/test/site-index.test.ts` tests it directly, by its own interface,
  which a port need not have: the rows of `resolve/landings.tsv` are
  the same behaviour seen through `resolve`.
- **The loaders are the one part that needs a runtime.** A port writes
  its own over its own file and network interfaces, or none. What it
  keeps is the rule that each is made with its bound stated, and
  judged at every hop. `addresses.tsv` is the one table of it.
- **`wellFormed` is for a runtime whose strings can hold half of a
  surrogate pair.** Where a string cannot, `parse` has already read one
  as U+FFFD, and the function has nothing to do.

## 3. The options, and the default each should have

One default changes when porting starts. Every other option keeps the
default it has, and every refusal that is made with no option given
stays one.

### `parse` and `make`

| Option | Today | When porting starts |
|---|---|---|
| `strict` | `false` | the same |
| `reading` | `'base'` | **`'spec'`** |
| `fast` | `'auto'` | the same |
| `duplicates` | `'last'` | the same |
| `aliasBudget` | the larger of 1,000,000 bytes and ten times the text | the same |
| `maxBytes` | 128 MiB, and 16 MiB for a parser given as `instance` | the same |
| `report` | none | the same |
| `instance` | a shared parser for each `strict` and `reading` | the same |

`reading: 'spec'` becomes the default by Decision 21: comments are `#`
alone, plain scalars follow YAML 1.2's core schema, and a trailing
empty document is no second document. `'base'` stays as an option. It
is one coordinated change, as section 5 of the plan has it:

- The default changes in every implementation at once.
- Eight rows of `test/spec/` change with it, and no other. Run with
  `reading: 'spec'` beside each row's own options, these are the rows
  whose result moves:

  | Row | Text | Today | Under `'spec'` |
  |---|---|---|---|
  | `raw-errors.tsv:7` | `/* x` | `ERROR:unterminated_comment` | `ERROR:openapi_root` |
  | `raw-errors.tsv:22` | `a: 1`, `---` | `ERROR:openapi_stream` | `{"a":1}` |
  | `raw-yaml-scalars.tsv:6` | `a: yes` | `{"a":true}` | `{"a":"yes"}` |
  | `raw-yaml-scalars.tsv:7` | `a: no` | `{"a":false}` | `{"a":"no"}` |
  | `raw-yaml-scalars.tsv:8` | `a: on` | `{"a":true}` | `{"a":"on"}` |
  | `raw-yaml-scalars.tsv:9` | `a: off` | `{"a":false}` | `{"a":"off"}` |
  | `raw-yaml-scalars.tsv:10` | `a: Yes` | `{"a":true}` | `{"a":"Yes"}` |
  | `raw-yaml-scalars.tsv:22` | `a: 1_000` | `{"a":1000}` | `{"a":"1_000"}` |

  Each keeps its text and gains `{"reading":"base"}` for today's
  result, and has a twin with no options for the new one.
- The files of `test/pending/` move to `test/spec/` as they are. A row
  there that gives `{"reading":"spec"}` then says the default aloud. A
  row that gives no `reading`, and has another result under `'spec'`,
  gains `{"reading":"base"}`. Run with the option beside their own,
  thirteen rows are such, as the files stand with this brief: six of
  `parse-limits.tsv` (lines 38, 39, 78, 79, 82 and 83, the texts with
  a `/*` comment), one of `parse-lossy.tsv` (38), four of
  `parse-probes.tsv` (14, 26, 27 and 28) and two of
  `parse-reading.tsv` (69 and 79).
- The corpus is measured under both readings already. Under
  `reading: 'spec'` every one of its descriptions is read, and no row
  of its ledger is open: [`docs/conformance.md`](../conformance.md).
- The floor of the yaml peer is the release that has the core schema,
  and `make` checks that the grammar reads it. A port needs the same
  release of its own yaml grammar.

Three codes are raised with no option given, `openapi_alias_budget`,
`openapi_size` and `openapi_work`, for one text and for the texts of a
description's other documents together. They are defaults today and
stay defaults. They are not in `test/spec/`, so the other suites do not
yet refuse what they refuse.

### `resolve`

Every default stays.

| Option | Default |
|---|---|
| `version` | `'auto'`: the version the root declares, and the latest for one this package does not know |
| `retrievalUri` | a fixed URI, `urn:uuid:0c2b4f0e-8f9d-4c7a-9a52-6d1e3b7a4f10` |
| `documents` | none |
| `parse` | the defaults of `parse`, for a document given as text |
| `strict` | `false` |
| `positions` | none |
| `maxDepth` | 1,000 |
| `maxSteps` | no bound |
| `onCheck`, `checkEveryN` | none, and every 1,000 steps |
| `sharing` | `'share'` |
| `budget` | none, and `sharing: 'copy'` needs one |
| `cycles` | `'cut'` |
| `siblings` | `'spec'` |
| `slots` | `'spec'` |
| `targets` | `'any'` |
| `refs` | `'uri'` |
| `xref` | `false` |
| `extensions` | none |
| `operations` | `false` |
| `compat` | none. `'apidef'` sets seven of the options above, and two details that no option names |

`parse` under `resolve` follows `parse`: when `reading` changes its
default, a document given as text is read by the new one.

### `resolveAll`, `bundle`, `bundleAll` and the loaders

Every default stays.

| Option | Default |
|---|---|
| `load` | none: it is required |
| `maxDocuments` | 10,000, counting what `load` is asked for |
| `maxRounds` | 64 |
| the options of `bundle` | those of `resolve` that say how the documents are read: `version`, `retrievalUri`, `documents`, `parse`, `maxDepth`, `maxSteps`, `onCheck`, `checkEveryN`, `slots`, `extensions` |
| `fileLoader`: `root`, `maxBytes` | required, and 128 MiB |
| `httpLoader`: `hosts`, `schemes`, `privateAddresses` | required, `['https']`, `false` |
| `httpLoader`: `maxBytes`, `timeoutMs`, `maxRedirects`, `cache` | 16 MiB, 10,000, 5, `true` |

## 4. Figures a port shares

A bound is a behaviour. These are the figures behind the ones a fixture
can see, each with the fixture that sees it. A port has the same
figure, not one of its own measuring.

| Figure | Where | Seen by |
|---|---|---|
| A description with no retrieval URI has the URI `urn:uuid:0c2b4f0e-8f9d-4c7a-9a52-6d1e3b7a4f10` | `DEFAULT_BASE` in `resolve.ts` | `resolve/uris.tsv`, the row of a relative reference |
| The alias budget: the larger of 1,000,000 and ten times the text | `ALIAS_FLOOR`, `ALIAS_FACTOR` in `yaml-alias.ts` | `pending/parse-limits.tsv`, `long/parse.json` |
| The measure of what aliases copy gives up past 32 steps for each byte, and 1,000,000, and the text is then refused | `WORK_PER_BYTE`, `WORK_FLOOR` in `yaml-alias.ts` | `long/parse.json`, its first four cases |
| The grammar is given a step for each ten bytes of `maxBytes`, and 100,000 at least | `BYTES_A_STEP`, `STEPS_FLOOR` in `text.ts` | `long/parse.json`, each shape on both sides of the bound |
| The texts of a description's other documents are held together to `parse.maxBytes`, to its steps, and to ten times their own size in aliases with one floor of 1,000,000 | `partReader` in `resolve.ts` | `resolve/documents.tsv` and `load/texts-held.json` for the size, `long/resolve.json` for the work and the aliases |
| The index's later rounds, the route walk and the walk of the operations each have sixteen times the work of reading the document once, and 100,000 | `EXTRA_FACTOR`, `EXTRA_FLOOR` in `site-index.ts` | `resolve/bounds.tsv`, `long/resolve.json` |
| Nesting, and references that follow one another: 1,000 | `maxDepth` | `resolve/landings.tsv`, `keep.tsv` |
| Rounds of loading: 64 | `maxRounds` | `load/rounds-default.json` |
| A member name in a message is JSON-quoted, and cut to 57 characters and `...` past 60 | `quoted` in `openapi.ts`, `resolve.ts` and `expression.ts` | this package's own tests |

Two more are this implementation's answer to its own engine, and a
port measures its own:

- **Memory for each rule pass.** The engine here keeps every rule it
  has run until the parse ends, about 900 bytes each. So `parse` reads
  a text of up to 16 MiB with a parser that keeps them, and a larger
  one, or one the first was stopped on, with a parser that keeps the
  last three (Decision 34). What a port keeps of that is the limits a
  caller sees, `maxBytes` and its steps. Whether it needs two parsers
  is its engine's to say.
- **Letting go of a large parse.** After a text of more than 65,536
  characters, `parse` runs a small parse on its shared parser so that
  the large one can be freed. That is about what this engine holds on
  to.

A count of steps is each implementation's own. No fixture holds one:
a row gives a bound far below any count, or far above, and a pair of
cases is set well apart on each side of a bound.

## 5. What no fixture carries

A fixture is data, and some of what the package does is not a function
of data. Each kind is below with the test that pins it here. A port
pins each in its own language, or does not have it.

| What | Why no fixture | Pinned here in |
|---|---|---|
| Sharing. Under `sharing: 'share'` two references to one target hold one object, under `'site'` each has its own shallow copy, and `'copy'` shares nothing | identity is not a value | `resolve.test.ts`, `documents.test.ts` |
| A kept cycle is a graph | JSON has no cycles. `resolve/keep.tsv` selects the parts that are none | `resolve.test.ts`, `documents.test.ts` |
| A value of the operation view is the resolved tree's own object at its place | identity | `operations.test.ts`, and `heldToTree` in `resolve-spec.test.ts` |
| Nothing a caller gave is changed: the raw tree, the documents | it is about the caller's objects | `resolve.test.ts`, `bundle.test.ts`, and each fixture runner, which compares its inputs before and after |
| A map of a tree has no prototype, and a member named `__proto__` pollutes nothing | it is about the language's objects. The trees themselves are rows | `openapi.test.ts`, `resolve.test.ts`, `bundle.test.ts` |
| Infinities, not-a-number, negative zero, and half of a surrogate pair in a tree | JSON cannot carry them, and runtimes differ | `openapi.test.ts` |
| `wellFormed`, with its merge and its cycles | it reads what only this runtime's strings can hold | `openapi.test.ts` |
| An option outside its choices is a `TypeError`, with its message | it has no code. Every such check is at the head of `resolve`, `parse`, `bundle`, `resolveAll` and the loaders | `resolve.test.ts`, `openapi.test.ts`, `bundle.test.ts`, `documents.test.ts`, `loaders.test.ts` |
| An error's fields beyond its code and its place: `details`, the message and the hint, the row and the column | a fixture holds the code, and `at` or `file` where a row says one | `openapi.test.ts`, `resolve.test.ts`, `hostile.test.ts` |
| `onCheck` and `checkEveryN`: a caller's function is told the steps, and `false` from it is `openapi_cancel` | a callback | `resolve.test.ts`, `bundle.test.ts`, `documents.test.ts` |
| Counts of steps, and that two ways of resolving take the same | each implementation's own | `resolve.test.ts` |
| `positions`: a row and a column in `provenance` | it needs a parser that records them, by `recordPositions` | `resolve.test.ts` |
| A root that is no map, given to `resolve` or `bundle` as a value | a fixture's entry is read by `parse`, which refuses one | `resolve.test.ts`, `bundle.test.ts`, `operations.test.ts` |
| Time. Each hostile shape is refused, or read, within a stated time | a machine's own. `long/` holds that each is refused or read | `hostile.test.ts`, `site-index.test.ts`, `operations.test.ts` |
| Memory. A large parse is let go, and the default limit is read within a stated heap | a child process with a heap limit | `openapi.test.ts`, `hostile.test.ts`, `history.test.ts` |
| A text that is refused from its opening is not handed to the grammar | a count of what the lexer was given | `hostile.test.ts` |
| The two parsers read every row of `spec/` and `pending/` alike | it is about this engine's rule history | `history.test.ts` |
| An asynchronous loader, and one that throws | callbacks | `documents.test.ts`, `bundle.test.ts` |
| A document given as bytes among the `documents` | the formats give a document as text or as a tree. `bytes/` holds bytes through `parse` | `documents.test.ts` |
| The file loader and the HTTP loader | a file system and a network | `loaders.test.ts` |
| The site index by its own interface: its rounds, and that a round carried forward equals one worked out from nothing | internal. A port tests its own index | `site-index.test.ts` |
| The object model's generator, and that the committed model is what its inputs generate | the generator is not ported: the model is embedded | `model.test.ts` |
| Sets of documents that are generated: a description in one document is its own bundle, and a bundle resolves to what its documents resolve to | three generators, in `bundle.test.ts`. The sets that one of them failed on are in `bundle-held/` | `bundle.test.ts` |
| The check of a bundle fails a bundle that is wrong | it is the check's own test | `bundle.test.ts` |
| The preset gives what apidef's resolver gives | it runs apidef. `resolve/apidef.tsv` and `apidef-extra.tsv` hold the rows | `tools/apidef-preset.cjs`, by hand |

Two limits of the formats themselves:

- **A column on a line after a character outside the basic plane.**
  The engine here counts a column in the units of its strings. No row
  has such a character before a place that a row states, on the same
  line, so what a port counts there is not decided by a fixture.
- **The order of a map's members.** A comparison of a row is of values,
  and does not see order. Where order is the point, a row of
  `resolve/` says `yes` in its `order` column, and a case of `bundle/`
  is compared as text as well as by value. A map of a tree keeps the
  order of the document in every implementation but this one, where a
  member whose name is a whole number comes first: no row depends on
  that.

## 6. The error codes

A code is the contract, and a message is not. Every code below has a
row or a case that raises it.

| Code | Raised by | Held by |
|---|---|---|
| `openapi_root`, `openapi_stream`, `openapi_version`, `openapi_duplicate_key` | `parse`, in every implementation today | `spec/raw-errors.tsv`, `raw-versions.tsv` |
| `openapi_alias_budget`, `openapi_size`, `openapi_work` | `parse` | `pending/parse-limits.tsv`, `long/parse.json` |
| `openapi_encoding` | `parse`, under `strict` | `bytes/parse.tsv` |
| `openapi_unresolved`, `openapi_pointer`, `openapi_ref_type` | `resolve`, under `strict` | `resolve/strict.tsv` |
| `openapi_budget` | `resolve`, for `sharing: 'copy'` | `resolve/sharing.tsv` |
| `openapi_depth`, `openapi_work` | `resolve` and `bundle` | `resolve/landings.tsv`, `bounds.tsv`, `long/resolve.json` |
| `openapi_cancel` | `resolve` and `bundle`, from a caller's `onCheck` | this package's own tests: a callback |
| `openapi_size`, `openapi_work`, over a description's documents | `resolve`, `resolveAll` and the two of `bundle` | `load/` |
| `openapi_load` | a loader | `loaders.test.ts`: a file system and a network |
| `openapi_expression` | `readExpression`, `readTemplate` | `expression/` |
