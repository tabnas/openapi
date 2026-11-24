# Reference

The exports of `@tabnas/openapi`, the tree a parse returns, and the
errors it raises. The [concepts](concepts.md) page explains the design
behind them.

## Exports

```ts
import { parse, resolve, resolveAll, version, make, aliasedSize, wellFormed, OpenApi, ResolveError, VERSION } from '@tabnas/openapi'
import type { Connection, Lossy, ParseOptions, ParseReport, Reading, ResolveOptions, ResolveResult, VersionInfo } from '@tabnas/openapi'
```

### `parse(text, options?)`

```ts
function parse(text: string | Uint8Array, options?: ParseOptions): any

type ParseOptions = {
  strict?: boolean                // default false
  reading?: 'base' | 'spec'       // default 'base'
  fast?: boolean | 'auto'         // default 'auto'
  duplicates?: 'last' | 'merge'   // default 'last'
  aliasBudget?: number            // bytes; default: the larger of 1,000,000 and ten times the text
  maxBytes?: number               // bytes; default 16,777,216
  report?: ParseReport            // a map the parse fills
  instance?: Tabnas               // default: a shared parser per `strict` and `reading`
}
```

Reads a description and returns its raw tree. It refuses:

| Code | When |
|---|---|
| `openapi_root` | the root of the document is not a map |
| `openapi_stream` | the text is a YAML stream of more than one document |
| `openapi_alias_budget` | the YAML aliases of the text would copy it out past `aliasBudget` |
| `openapi_size` | the text is past `maxBytes`, and `JSON.parse` does not read it |
| `openapi_work` | the text takes more work to read than a description of `maxBytes` takes |
| `openapi_version` | under `strict`, the root names no version this package reads |
| `openapi_duplicate_key` | under `strict`, a map holds one member name twice |
| `openapi_encoding` | under `strict`, the bytes are not well-formed in their encoding |

`strict` reads JSON alone, by RFC 8259, and adds the last three checks.

#### The text

`text` is a string, or the bytes of one as a `Uint8Array`. Bytes are
read by their byte-order mark:

| The bytes open with | Read as |
|---|---|
| `EF BB BF`, or no mark | UTF-8 |
| `FF FE` | UTF-16, little-endian |
| `FE FF` | UTF-16, big-endian |
| `FF FE 00 00` | UTF-32, little-endian |
| `00 00 FE FF` | UTF-32, big-endian |

A sequence the encoding does not allow is read as `U+FFFD`. Under `strict`
it is refused, as `openapi_encoding`. A byte-order mark at the start of
the text is passed over, in a string as in bytes, and under `strict`
too. One mark is: a second is text, as YAML has it. Rows, columns and
offsets are counted in the text without the mark. `parse` throws a
`TypeError` for a text that is neither a string nor a `Uint8Array`.

#### `reading`

`reading` decides what starts a comment, what a plain scalar is, and
what an empty document after the description gives:

| | `'base'` | `'spec'` |
|---|---|---|
| A comment starts with | `#`, `//` or `/*` | `#` |
| A number | whatever the base grammars and JavaScript read as one: `1_000`, `0b11`, `0X1F`, `-0x1F`, `Infinity` | one the YAML core schema reads as a number: a decimal integer or float with an optional sign, `0o17`, `0x1F` |
| `yes`, `no`, `on`, `off` | `true` and `false`, as in YAML 1.1 | the text as written |
| An empty document after the description | refused, as `openapi_stream` | passed over |

Under `'spec'` a plain scalar is what the YAML 1.2 core schema reads it
as. One that is not a number, a Boolean or a null of that schema is the
text as written, so `1_000` is the string `'1_000'`, `yes` is the string
`'yes'` and `//host/path` is the string `'//host/path'`. A second
document that holds anything is refused under both. Under `strict` the
grammar is JSON's and `reading` changes nothing.

`'spec'` needs `@tabnas/yaml` 0.5.33 or later, the first with the core
schema. With an earlier one `make` and `parse` throw a `TypeError`
rather than read `yes` as `true`.

#### `fast`

`fast` decides whether JSON text is read with `JSON.parse` before the
grammar:

| `fast` | Takes the fast path |
|---|---|
| `'auto'` | when the text opens with `{`, after JSON whitespace |
| `true` | always |
| `false` | never |

When `JSON.parse` refuses the text, or its root is not a map, the
grammar reads the text instead, so every error comes from the grammar.
The grammar always reads it under `strict` and under
`duplicates: 'merge'`. Both paths give the same tree, and the same
`report`.

#### `duplicates`

`duplicates` decides what a member name given twice in one map gives:

| `duplicates` | The member's value |
|---|---|
| `'last'` | the last value, whole, as `JSON.parse` keeps it |
| `'merge'` | the values merged, as the base grammars merge them |

Under `'merge'`, two maps merge member by member and two lists index by
index, to any depth. Where the two values are not both maps or both
lists, the later one replaces the earlier. A later member named
`__proto__`, `constructor` or `prototype` is left out, because the
engine's merge skips those names. Under `strict` a repeated name is
refused, whatever `duplicates` says.

#### `aliasBudget` and `maxBytes`

Both are a number of bytes of UTF-8, and `Infinity` lifts either. Each
is checked on the text, before the grammar builds any of it, and held
again while the grammar reads.

`aliasBudget` is the most the text may come to once every YAML alias is
copied in, as [`aliasedSize`](#aliasedsizetext) measures it. The default
is the larger of 1,000,000 and ten times the text. Only what the aliases
add is held to it: a text in which no alias copies anything is never
refused for it, whatever the budget. Strict JSON has no alias, and is
not measured.

The budget is held twice. The measure is taken of the text, before the
grammar builds anything, and it reads the text as YAML. The base reading
takes more than YAML, so a text can be written in which the grammar
finds an alias that the measure passed over. So `parse` also counts each
copy the grammar makes, as it makes it, and refuses the text at the
alias whose copy passes the budget. That count is from below: one for
each member, each item, and each scalar copied.

`maxBytes` is the largest text the grammar is given, 128 MiB by default.
JSON text that `JSON.parse` reads has no limit.

`maxBytes` bounds the work of the grammar as well as the size of the
text, because size alone does not say what a text costs. The grammar
takes a step for each rule it runs. A description takes a step for each
seven to nine of its bytes. A text of very many small values takes one
or two steps for each byte: a list of a million one-letter items is such
a text. So the grammar has a step for each ten bytes of `maxBytes`, and
a hundred thousand at least, and `parse` stops a text that takes more,
as `openapi_work`. The default gives 13,421,772 steps. A description meets
that bound before the limit on its size: by default `parse` reads one of
up to between 90 and 120 MiB, by how dense it is.

What a text costs in memory depends on which parser reads it. `parse`
has two. The first keeps every rule it has run until it is done. That
makes it the faster of the two, and it takes about a hundred bytes of
memory for each byte of a description: one of 17.9 MiB took 1.8 GB and
5 seconds, in a heap of 2.2 GB. So it reads a text of up to 16 MiB, and
has 1,677,721 steps at most, which hold it to about 1.5 GB. The second
keeps its last three rules only. It reads the same tree in three times
the time, and takes far less memory: the same 17.9 MiB took 434 MB and
16 seconds, and a description of 99.6 MiB took 1.2 GB and 80 seconds.
It reads a text past 16 MiB, and reads again, from the start, a text
that took more steps than the first parser has.

A text of small values costs time more than memory. The default bound
stopped 40 MiB of them, in each of four shapes, after 87 to 101 seconds
and 370 to 717 MB. A process with less time or less memory to give
needs a smaller `maxBytes`: under 16 MiB it holds the first parser to
fewer steps as well.

These figures are with `@tabnas/parser` 0.12.20 or later, which is
where the package's peer range starts. An earlier one takes more memory
for each rule, and the largest texts then run the second parser out of
a heap of 2.2 GB.

A parser from `make`, given as `instance`, keeps every rule whatever the
size of the text, and is the only parser to read it. So the limit for
one is 16 MiB, unless `maxBytes` says otherwise.

Each error carries the figures in `details`: `size` and `budget` for
`openapi_alias_budget`, `size` and `limit` for `openapi_size`, `steps`
and `limit` for `openapi_work`. The `size` of `openapi_alias_budget` is
`Infinity` for a text that [`aliasedSize`](#aliasedsizetext) did not
measure to the end. Where the grammar's copies passed the budget and
the measure had not, `size` is what the text and its copies had come to
when the parse was stopped.

#### `report`

```ts
type ParseReport = {
  lossy?: Lossy[]
}

type Lossy = {
  text: string    // the number as written
  value: number   // the number the tree holds
  pos: number     // the offset into the text, from 0
  row: number     // from 1
  col: number     // from 1
  at?: string     // an RFC 6901 pointer to it in the tree
}
```

Give `report` a map and the parse sets its `lossy` to the numbers the
tree does not hold exactly, in the order they are written:

- an integer written out in full that the number read does not equal,
  such as `9007199254740993`, which is past 2^53
- a number written with digits that is too large to read, such as
  `1e400`, which reads as `Infinity`

The integers themselves are compared. A JavaScript number prints with
the fewest digits that tell it from its neighbours, so `value` can print
as `text` reads and still be another integer: `243670157034784130` is
read as the number 243670157034784128, which prints as
`243670157034784130`. `BigInt(value)` is the integer the tree holds.

A float with more digits than a double holds is not listed. `at` is
there when the tree holds that number at that place. A number under a
repeated member name that the tree does not keep has no `at`. An alias
copies its anchor's node, and the number is listed once, at the anchor.
`pos`, `row` and `col` count as JavaScript counts a string.

Finding a place takes a step for each level between the root and the
number, and a parse takes two million such steps at most. A description
uses a few hundred. In a text built to use them up, with numbers by the
hundred under nesting thousands deep, every number is still listed, and
the later ones have no `at`.

#### Other options

`instance` must be a parser from `make`, or one with the plugin
installed; `parse` throws an `Error` otherwise. A parser reads one way,
so `parse` throws a `TypeError` when `reading` is not the reading the
parser was made for.

`parse` throws a `TypeError` for an option outside its values.

A parser holds its last parse until its next one starts, at about a
hundred times the size of the text. `parse` makes its shared parsers
let go once a parse of more than 65,536 characters has returned. A
parser given as `instance` is not touched.

### `aliasedSize(text)`

```ts
function aliasedSize(text: string): number
```

Returns the size, in bytes of UTF-8, that a YAML text comes to once
every alias is replaced by the node its anchor labels, all the way down.
A text with no alias is its own size. It reads the text alone and parses
nothing: comments, quoted scalars and block scalars are passed over. It
reads the text as YAML, so an anchor or an alias behind `//` or inside
`/* */` is counted, though the base reading takes those for comments.

The measure is one pass over the text, and then work that grows with
how the anchors nest. That work is counted, at 32 steps for each byte of
the text and a million more. A text built to need more than that, with
anchors nested by the thousand, is not measured to the end, and its size
is `Infinity`. The descriptions this was measured on take less than one
step for each byte.

### `wellFormed(tree, options?)`

```ts
function wellFormed<T>(tree: T, options?: { duplicates?: 'last' | 'merge' }): T
```

Returns the tree with every lone surrogate read as `U+FFFD`, in its
strings and in its member names. A tree with none comes back as it is,
the same object. Otherwise the result is a new tree and the one given is
not changed: what was shared stays shared, a cycle stays a cycle, and
each map keeps its prototype.

`duplicates` decides what two member names give when the repair makes
them one name, as it does for `parse`. The default is `'last'`. Under
`'merge'` two values are merged where each is a tree, as every value
`parse` gives is. Where one holds a cycle or shares a part with
another, the later is kept. A string is repaired as a tree of one value,
and any other value is returned as it is.

### `resolve(raw, options?)`

```ts
function resolve(raw: any, options?: ResolveOptions): ResolveResult

type ResolveOptions = {
  version?: 'auto' | '2.0' | '3.0' | '3.1' | '3.2'    // default 'auto'
  retrievalUri?: string                               // default: a fixed urn:uuid:
  documents?: Record<string, unknown>                 // the other documents, by URI
  parse?: ParseOptions                                // how one given as text is read
  strict?: boolean                                    // default false
  positions?: (node: object) => Token | undefined     // from recordPositions
  maxDepth?: number                                   // default 1000
  maxSteps?: number                                   // default: no bound
  onCheck?: (steps: number) => boolean | void         // false stops resolving
  checkEveryN?: number                                // default 1000
  sharing?: 'share' | 'site' | 'inline-once' | 'copy' // default 'share'
  budget?: number                                     // bytes; copy needs it
  cycles?: 'cut' | 'keep'                             // default 'cut'
  siblings?: 'spec' | 'merge'                         // default 'spec'
  slots?: 'spec' | 'all'                              // default 'spec'
  targets?: 'any' | 'object'                          // default 'any'
  refs?: 'uri' | 'pointer'                            // default 'uri'
  xref?: boolean                                      // default false
  extensions?: string[]                               // default []
  compat?: 'apidef'
}

type ResolveResult = {
  tree: any                     // the resolved tree
  version: '2.0' | '3.0' | '3.1' | '3.2' | 'unknown'
  documents: string[]           // the other documents that were read, by URI
  unresolved: { at: string, ref: unknown, why: Why, doc?: string }[]
  provenance: Provenance[]      // one entry per site
  cuts: { at: string, ref: string, target: string, doc?: string, targetDoc?: string }[]
  connections: Connection[]
  dataSlots: number             // $ref maps read as data
  dialects: DialectUse[]        // the schema dialects it declares
  urls: UrlUse[]                // the URLs it gives for things outside it
}

type DialectUse = {
  at: string                    // /jsonSchemaDialect, or a schema's $schema
  dialect: string               // as written
  as: 'draft-04' | 'draft-06' | 'draft-07' | '2019-09' | '2020-12'
  known: boolean                // false: not a dialect this package knows
  doc?: string                  // the document, where not the description
}

type UrlUse = {
  at: string                    // the field
  doc?: string                  // the document, where not the description
  value: string                 // as written
  base: 'description' | 'retrieval' | 'api' | 'none'
  uri?: string                  // its absolute form, where it has one
}

type Provenance = {
  at: string
  doc?: string                  // the document the site is in, where not the description
  ref: unknown
  kind: 'reference' | 'schema' | 'pathItem' | 'data'
  type: string | null           // what a Reference Object stands for
  target: string | null         // the location it names, when it names one
  targetDoc?: string            // the document that is in, where not the site's own
  landing: string | null        // the location it lands on, as the document is written
  landingDoc?: string           // the document that is in, where not the target's
  through?: string[]            // the references its pointer was read through
  uri?: string                  // for a reference into a document not given: its URI
  fragment?: string             // and its fragment, when it has one
  conflict?: string             // the type it lands on, when not the one it expects
  status: 'resolved' | 'unresolved' | 'cut' | 'kept'
  row?: number                  // with positions
  col?: number
}
```

Returns a new tree with every reference in the document replaced by
what it names. The raw tree is never changed.

The description is read by the version its root names, or by `version`
when that is given. A version this package does not know is read as
3.2, and the result's `version` is `'unknown'`.

#### Sites

A map that owns `$ref` is a site where the description's version puts a
Reference Object, a Schema Object, or a Path Item. In an example, an
extension, or as a property named `$ref`, it is data and stays as
written; `dataSlots` counts those. `slots: 'all'` also makes a site of
every such map whose `$ref` is a string, of kind `data`. `extensions`
does the same inside the extension members it names.

A map the version gives no type at all takes the type of the first
reference to land on it, in document order. Such a map is in an
extension, or under a member the version does not have, such as
`definitions` in a 2020-12 schema. The references inside it are then
sites, and they can type further maps in turn. A reference of kind
`data` types nothing.

A component is what its map of the Components Object holds, whatever
its name. The specification has a pattern for a component's name,
`^[a-zA-Z0-9\.\-_]+$`, and a component named otherwise is read as any
other, in every version.

#### Targets

A reference resolves against the nearest `$id` (3.1 and 3.2, its own
map's included), else the document's `$self` (3.2), else
`retrievalUri`. Its fragment is a JSON Pointer, percent-decoded first,
or from 3.1 an anchor that a `$anchor` or `$dynamicAnchor` declares. An
array index is `0`, or digits with no leading zero, in range. Only a
map's own members are members. A schema of an earlier dialect names
itself and its anchors by that dialect's rules, which
[Dialects](#dialects) has.

A URI is compared with another in the normal form of RFC 3986, section
6.2. The scheme and the host are in lower case. An empty port and
the scheme's own are dropped. A percent-encoded letter, digit, `-`,
`.`, `_` or `~` is that character, and the hex digits of any other
percent-encoding are in upper case. Dot segments are removed, and an
empty path beside a host is `/`. So `HTTPS://API.Example.com:443/a.yaml`
names the document retrieved from `https://api.example.com/a.yaml`. The
case of a path is kept, since it can matter.

A pointer is read on the document as it is written, so a member that a
reference has beside its `$ref` is the one a pointer through it names.
Where a step is missing at a reference, the pointer is read on in what
that reference names. `landing` is the location the pointer comes to,
and `through` lists each reference it was read through. A reference
into another document can't be read through, and neither can the
root. A JSON Pointer has no such step of its own, and `strict` does not
take it: the reference is `not-found`.

For a reference into another document, `uri` is that document's URI,
resolved against the same base and in its normal form, and `fragment`
is the reference's fragment. Give `retrievalUri` for `uri` to be a real
location.

A reference to a site left as written is left as written too, and
reported as that site is.

A reference expects a type: a Reference Object the type its place
holds, the `$ref` of a schema a schema, and the `$ref` of a Path Item
a Path Item. Where it lands on something the version gives another
type, the reference resolves all the same, and its row has `conflict`,
the type it landed on: `response` for a reference from a schema to a
Response Object, `map` or `list` for a container with no type of its
own, and `data` for plain JSON, as an example is. A landing the
version gives no type takes the reference's, and has no conflict.
Neither has a reference of kind `data`, which expects nothing.

`refs: 'pointer'` reads a `$ref` as a JSON Pointer into the document
and nothing else:

- A reference names something only where it begins `#/`. Any other is
  left as written, with `why` set to `bad-fragment` where it begins `#`
  and to `external` where it does not.
- The pointer is read from the document's root. `~1` and `~0` are
  decoded, and nothing is percent-decoded.
- `$id`, anchors, schema dialects, `$self` and `retrievalUri` are not
  read, `$dynamicRef` makes no site, and `dialects` is empty.
- A pointer that passes through a string `$ref` left as written ends
  there. Its site is cut where that reference was cut, and has `why` set
  to `not-found` otherwise. Under `uri` it reads on in that map as
  written.
- The root is never a site. Where the root has a string `$ref`, no
  pointer names anything, and every one is `not-found`.

`refs` does not change `connections`.

#### Dialects

A Schema Object of 3.1 or 3.2 is written in a JSON Schema dialect. It
is the one its own `$schema` names, else the one in force where it is.
At the root that is the description's `jsonSchemaDialect`, else the
OpenAPI dialect of the version. A `$schema` is read at any schema that
has one, which is lenient: the specification gives it a meaning only at
the root of a schema resource. Five dialects are read, each by its own
rules:

| | draft-04 | draft-06, draft-07 | 2019-09 | 2020-12 |
|---|---|---|---|---|
| Names a schema resource | `id` | `$id` | `$id` | `$id` |
| Names an anchor | `id: '#name'` | `$id: '#name'` | `$anchor` | `$anchor`, `$dynamicAnchor` |
| Members beside a `$ref` | not read | not read | apply | apply |
| Reported, never followed | | | `$recursiveRef` | `$dynamicRef` |
| Maps of schemas | `properties`, `patternProperties`, `definitions`, `dependencies` | the same | `properties`, `patternProperties`, `$defs`, `dependentSchemas` | the same |
| A list of schemas in `items` | yes, with `additionalItems` | yes | yes | no: `prefixItems` |

draft-06 adds `contains` and `propertyNames`, and draft-07 adds `if`,
`then` and `else`. 2019-09 adds `unevaluatedItems`,
`unevaluatedProperties` and `contentSchema`. A member a dialect does
not have holds no schemas in it. A `$ref` there is read only where a
reference lands on it, as [Sites](#sites) has.

The OpenAPI dialects of 3.1 and 3.2 are read as 2020-12, and so is a
dialect this package does not know. An identifier is compared in its
normal form, with or without the empty fragment, under `http` or
`https`. A draft's hyper-schema dialect is read as the draft.

Three things follow from a `$ref` whose neighbours are not read. Its
site holds the target alone. An `$id` beside it names nothing, so the
reference is read against the base its parent has. And `$schema` is
still read first, since it says how the rest is read.

An identifier that is a fragment alone, such as `$id: '#name'`, is an
anchor in draft-04 to draft-07. In 2019-09 and 2020-12 it names
nothing: not an anchor, and not the resource it is in. In every
dialect, an identifier that is the URI of the resource it is in names
nothing new, so a schema can't take the place of the document or of
the schema resource around it. An identifier of another resource that
has a fragment names that resource, and the fragment is dropped.

What OpenAPI adds to a Schema Object is read in every dialect:
`discriminator`, `xml`, `externalDocs` and `example`.

`dialects` lists what the description declares: the root's
`jsonSchemaDialect` first, then the `$schema` of each schema in
document order. `as` is the dialect whose rules it is read by, and `known` is
false for one this package does not know. An unknown dialect is not an
error, under `strict` or otherwise. 2.0 and 3.0 have no dialects:
`$schema` there is a member like any other, and `dialects` is empty.

#### Siblings

What happens to the members beside a `$ref` under `siblings: 'spec'`:

| Site | 2.0, 3.0 | 3.1, 3.2 |
|---|---|---|
| Reference Object | ignored | `summary` and `description` override the target's, where its type has them |
| Schema Object | ignored | kept, with the target joined in an `allOf`. Ignored in a schema of draft-04 to draft-07 |
| Path Item | merged with the target's fields | merged with the target's fields |
| data | ignored | ignored |

`siblings: 'merge'` lays the members over the target, the site's
winning, at every site in every version. Every merge is shallow.

#### Output shapes

`sharing` decides what a site holds:

| `sharing` | Each site holds | `cycles` |
|---|---|---|
| `share` | its target's value, one value for every site naming that target | `cut` or `keep` |
| `site` | a shallow copy of the value, its members shared | `cut` or `keep` |
| `inline-once` | the value at the first site to land on the target, in walk order; the reference as written at the rest, with status `kept` | `cut` |
| `copy` | a copy of the value all the way down, so nothing in the tree is shared | `cut` |

`copy` needs `budget`: the most bytes, in UTF-8, of the compact JSON
the copy may make. Without one, or past it, `resolve` throws a
`ResolveError` coded `openapi_budget`.

A reference whose target is still being built when the walk reaches it
closes a cycle. Under `cycles: 'cut'` it is left as written and listed
in `cuts`, and so is a reference to it. Under `cycles: 'keep'` it holds
its target's value once the walk is done, which makes the tree a cyclic
graph that `JSON.stringify` refuses. A loop made of references alone has
no value to hold, and is cut either way, and so is a reference to a
member of such a loop. A pointer that comes back to a reference it is
being read through is cut in the same way.

`xref: true` writes `x-ref`, the reference as written, in every site's
value, resolved or not, except where the `$ref` is not a string. It is
the last member, or takes the place of an `x-ref` the document wrote
there. Each site then holds a copy, as under `site`.

`targets: 'object'` leaves a reference to anything but a map as
written, with `why` set to `non-object-target`.

The walk runs from the root in document order. Under `cycles: 'cut'` a
reference's landing is entered at its first reference, and that order
decides which edge of a cycle is cut and which site `inline-once`
fills. It is also the order of `unresolved`, `cuts` and `provenance`. A
reference that a pointer only passes is not entered then. Under
`cycles: 'keep'` no landing is entered early, and those three are in
document order.

Three options bound the work:

- `maxDepth` bounds how deep the document nests and how many references
  are followed one inside another, counted together. Past it, `resolve`
  throws a `ResolveError` coded `openapi_depth`, with the place it
  stopped in `at`.
- `maxSteps` bounds the steps `resolve` takes: one for each map or list
  it comes to, each time it comes to one, and one for each reference it
  reads. Past it, `resolve` throws a `ResolveError` coded
  `openapi_work`.
- `onCheck` is called every `checkEveryN` steps with the number taken
  so far. When it returns `false`, `resolve` throws a `ResolveError`
  coded `openapi_cancel`. A caller keeps a deadline there.

Two bounds need no option. Typing maps by the references that land on
them, and reading pointers on through references, can each cost more
than one pass over the document. Together they are held to sixteen
times the work of reading the document once, and 100,000 steps besides.
The walk of routes for the `connections` report has the same allowance
to itself. It visits a value once for each route that reaches it, so
callbacks that branch to one shared Path Item double the routes at
every level. No description of the 5,168 measured comes near either
bound, and the longest walk of routes takes 7.5% of its allowance. Past
either, `resolve` throws `openapi_work`.

`resolve` needs `@tabnas/expr` 0.6.4 or later. With an earlier one it
throws a `TypeError` that says so, except under `refs: 'pointer'` with
neither `maxSteps` nor `onCheck`, which asks nothing new of it.

#### `compat: 'apidef'`

The resolution `@voxgig/apidef` makes: `{ siblings: 'merge', xref:
true, sharing: 'site', cycles: 'keep', slots: 'all', targets: 'object',
refs: 'pointer' }`. An option given beside it wins.

The preset also keeps two details of how `@voxgig/apidef` builds a
site's value, which no option names:

- A member named `__proto__` beside a `$ref` is left out of the value
  of a site that resolves.
- Where a site's target is itself a resolved site, and a walk of the
  resolved tree, from the root in member order, meets the target before
  the site, the site's `x-ref` takes the place of the target's. It is
  then not the last member where the site has members the target lacks.

#### Several documents

A description may be several documents. `documents` gives the others,
each under the URI the caller retrieved it from. `resolve` reads a
relative name against `retrievalUri`, which it then needs. Each
document is a tree as `parse` gives one, or its text or bytes, which
`parse` reads as the `parse` option says.

```js
const { parse, resolve } = require('@tabnas/openapi')

const raw = parse('openapi: 3.1.0\ninfo: {title: t, version: "1"}\npaths: {}\ncomponents:\n  schemas:\n    Pet: {$ref: "schemas/Pet.yaml"}\n')
const r = resolve(raw, {
  retrievalUri: 'https://example.com/api/openapi.yaml',
  documents: { 'schemas/Pet.yaml': 'type: object\nproperties:\n  name: {type: string}\n' },
})
r.tree.components.schemas.Pet.properties.name.type // => 'string'
r.documents // => [ 'https://example.com/api/schemas/Pet.yaml' ]
r.unresolved // => []
```

A document given as text may be anything at its root, a schema that is
`true` or a list that a pointer reads into, and needs no version. Only
a description has to be a map that declares one. A name whose document
is `undefined` throws a `TypeError`, and `null` is a document with
nothing in it.

`resolve` holds the texts together to the limits of one text:

- `parse.maxBytes` in size, 128 MiB unless given. JSON text counts,
  though `parse` reads one JSON text of any size. Past it `resolve`
  throws a `ResolveError` coded `openapi_size`.
- The steps of that size in work, 13,421,772 unless `maxBytes` is
  given. Past them it throws `openapi_work`.
- One alias budget. Each text's aliases may copy out ten times its
  size, and the texts share 1,000,000 bytes more between them. Past
  that `parse` raises `openapi_alias_budget`. With
  `parse.aliasBudget` given, each text has that budget to itself.

The first two have the URI of the document they stopped at in `at`. A
tree does not count toward any of the three, and neither does the
description: whoever built a tree had its size to bound.

An error that `parse` raises for one of these texts says which document
it is in. The document's URI is the error's `fileName`, and the file in
the place its message shows, where the description's own text has none.

`resolve` indexes every document it has before it judges any
reference, so a reference resolves into whichever document holds what
it names:

- A schema that declares an identifier with `$id`, in any of the
  documents, answers to that identifier, and an anchor to its
  identifier and name.
- A document answers to its own URI, which is its `$self` in 3.2, and
  to the URI in `documents`.
- A fragment alone names the document that holds it.

`resolve` compares each URI in its normal form, so one document reached
by two spellings is one document.

A document whose root declares a version is a description of that
version, with a `$self` and a `jsonSchemaDialect` of its own. The
references that land in any other document type it: as a schema, a
Path Item, a map of parameters. A schema there that names no dialect
with `$schema` has the dialect of the description's version. A part of
such a document that no reference lands on is data, and a `$ref` in it
is no site, unless `slots` is `'all'`.

The members beside a reference follow the rule of the version of the
document that holds the reference. Sharing, cycles, `maxDepth` and
`maxSteps` span the documents. Two references to one location hold one
value, whichever documents hold them, and `resolve` cuts or keeps a
cycle through two documents as it does one in a single document.

A report row for a site in another document carries that document's
URI in `doc`. Where a target is in another document than its site,
`targetDoc` names it, and `landingDoc` does the same for a landing that
a pointer reached in a third by reading through a reference. The
result's `documents` lists the documents `resolve` read, each by its
URI in normal form.

`resolve` loads nothing. It leaves a reference into a document it does
not have as written, with `why: 'external'` and the document's URI in
the `uri` of its `provenance` row.
[`resolveAll`](#resolveallraw-options) loads what a description names.

`documents` throws a `TypeError` for a relative name with no
`retrievalUri`, for two names that are one URI, and under
`refs: 'pointer'`, which reads a reference as a pointer into its own
document and nothing else.

#### What is left as written

A reference left as written for a reason other than a cycle is listed
in `unresolved`, with `why`:

| `why` | The reference |
|---|---|
| `not-found` | names nothing in the document |
| `no-anchor` | names an anchor nothing declares |
| `bad-fragment` | has a fragment that is not a well-formed JSON Pointer or, from 3.1, a plain name. Under `refs: 'pointer'`: begins `#` and not `#/` |
| `not-a-string` | is not a string; its map is resolved as a plain map |
| `external` | names a document that was not given: see [Several documents](#several-documents). Under `refs: 'pointer'`: does not begin `#` |
| `non-object-target` | names a value that is not a map, under `targets: 'object'` |

A site left as written keeps its other members, each resolved, so a
reference inside a sibling still resolves.

Under `strict`, `resolve` throws a `ResolveError` instead, coded
`openapi_unresolved` (`not-found`, `no-anchor`, `external`,
`non-object-target`), `openapi_pointer` (`bad-fragment`) or
`openapi_ref_type` (`not-a-string`), with `at` and `ref`. An option
outside its choices throws a `TypeError`, and so does `inline-once` or
`copy` with `cycles: 'keep'`. Every `at`, `target` and cut path is an
RFC 6901 pointer.

#### Connections

```ts
type Connection = {
  kind: ConnectionKind
  at: string              // the position that names something
  doc?: string            // the document that is in, where not the description
  name: string            // the name or URI as written
  found: boolean
  target: string | null   // what it names, when found
  targetDoc?: string      // the document that is in, where not the description
  why?: string            // why a URI found nothing, as in unresolved
  type?: string | null    // the object type at a located target
  via?: 'name' | 'uri'
  ambiguous?: boolean
  targets?: string[]
  cycle?: boolean
  anchor?: boolean
  fields?: string[]
  routes?: string[]
  from?: 'oneOf' | 'anyOf' | 'allOf' | 'self'
}
```

`connections` lists the places a description names something other than
through `$ref`. Nothing in it is put into the tree.

| `kind` | `at` | What it names | Other members |
|---|---|---|---|
| `operationId` | a Link's `operationId` | the operation that declares it | `targets`, when more than one does |
| `operationRef` | a Link's `operationRef` | the location its URI names | `type`, which should be `operation` |
| `securityScheme` | a Security Requirement's member name | a security scheme by name; in 3.2, failing that, by URI | `via`; `type` when read as a URI; `ambiguous` for a 3.2 name that is also a URI to a security scheme, where the name wins |
| `tag` | an entry of an operation's `tags` | the root `tags` entry of that name | |
| `tagParent` | a 3.2 tag's `parent` | the root `tags` entry of that name | `cycle`, when the chain of parents loops |
| `mapping` | a Discriminator `mapping` value | a schema by component name, failing that by URI | `via` |
| `defaultMapping` | a 3.2 Discriminator's `defaultMapping` | as `mapping` | `via` |
| `implicitMapping` | the `discriminator` of a schema | a schema component whose name is a value of the discriminating property | `from`: where the component is named |
| `dynamicRef` | a 2020-12 schema with `$dynamicRef` | its initial target, by URI | `anchor`, when that target has a `$dynamicAnchor` of the fragment's name |
| `recursiveRef` | a 2019-09 schema with `$recursiveRef` | its initial target, by URI | `anchor`, when that target has `$recursiveAnchor: true` |
| `pathItemMerge` | a Path Item with `$ref` | the Path Item it names | `fields`: the fields both have, where the specification leaves the merge undefined |
| `operationIdReuse` | the first route | one `operationId` that more than one route through `paths`, `webhooks` and callbacks reaches | `routes` |

A discriminator has an implicit mapping beside its `mapping`: a value
of its property names the schema component of that name. Its
`implicitMapping` rows list the components it can name that way, each
with `name`, the value. They are the ones listed by reference beside
it in `oneOf` or `anyOf`, and the ones that build on its schema with
`allOf`, and on those in turn. An inline schema has no name, and has
no row. A value that `mapping` has is that entry's, and has no
implicit row. In 2.0 the discriminator is the name of the property,
and the name of the schema itself is a value too, with `from` set to
`self`.

The rows come in document order, then the `pathItemMerge` rows in walk
order, then the `operationIdReuse` rows. A name inside example data is
data, and has no row. A name in a map that only a reference types has
one. A target is looked for as a reference's is: on the document as
written, and through a `$ref` where a step is missing, so a target
reached through a `$ref` is found. A route is walked the same way, with
a Path Item's own fields beside its `$ref`. None of the report depends
on `sharing`, `cycles` or `siblings`.

With [several documents](#several-documents) the report covers every
document: the description first, then each other in the order of
`documents`, with `doc` on a row for a position outside the
description. A document with no version has rows where a reference
types it. A name is looked for as the specification recommends:

- A security scheme, a tag, and a mapping value read as a name are the
  description's own, whichever document uses the name.
- An `operationId` is looked for among the operations of every
  document. Where the first to declare it is in another document,
  `targetDoc` names that document, and each of the `targets` outside
  the description is that document's URI with the pointer as its
  fragment.
- A URI names what it names, in whichever document that is, with
  `targetDoc`.

The `implicitMapping` rows are those of the description's own schemas,
since the names they list are its components. The routes of
`operationIdReuse` are the description's, since the API has the
description's paths and no others.

#### URLs

`urls` lists each URL or URI the description gives for something
outside it, in document order. Nothing is loaded. `base` says what a
relative value is relative to, and `uri` is the absolute form of the
value, in its normal form, where it has one. A value written with a
scheme has one whatever its `base`:

| `base` | The field | `uri` of a relative value |
|---|---|---|
| `description` | `termsOfService` (3.1, 3.2), `url` of a Contact, License or External Documentation Object, `externalValue` | the value against the base URI in force, as for a `$ref` |
| `retrieval` | `url` of a Server Object | the value against `retrievalUri`, whatever `$self` says. None while the URL has variables |
| `api` | `openIdConnectUrl`, `oauth2MetadataUrl`, `authorizationUrl`, `tokenUrl`, `refreshUrl`, `deviceAuthorizationUrl`, and `termsOfService` in 3.0 | none: it is relative to a server of the API |
| `none` | `namespace` of an XML Object, and every URL of 2.0 | none |

A relative value has a `uri` only against a base that a relative
reference can be read against: a URI with a scheme, and with an
authority or a path from the root. With no `retrievalUri`, the
description is read under a base that stands for no location, and a
relative value has no `uri`, unless `$self` or the nearest `$id` is
such a URI. A `urn:` is none either.

A value that is no string has no row, and neither has one in an example
or an extension.

### `resolveAll(raw, options)`

```ts
function resolveAll(raw: any, options: ResolveAllOptions): Promise<ResolveResult>

type ResolveAllOptions = ResolveOptions & {
  load: (uri: string) => unknown | Promise<unknown>
  maxDocuments?: number         // default 10000
  maxRounds?: number            // default 64
}
```

Resolves a description that is several documents, loading each document
it names. It works in rounds: it indexes the documents so far, asks
`load` for each document they name and do not have, and goes on until a
round names nothing new. It then resolves the description as `resolve`
does, given those documents. Its options and its result are those of
`resolve`.

`load` takes an absolute URI in its normal form, with no fragment. It
returns the document, as `documents` takes one. For a document it
does not have it returns `undefined` or `null`, which leaves the
references to it as written. `resolveAll` asks for a document once, and
never for one in `documents`. It also loads a document that only a URI
of the `connections` report names, such as an `operationRef`.

`load` is the only thing here that reaches outside the process, and it
is the caller's. What it may read is its own to bound, since a
description names whatever documents its author chose. A loader that
throws stops `resolveAll` with that error.

`resolveAll` bounds what a description can make it do, with no option
given. Each bound throws a `ResolveError`, with the URI it stopped at
in `at`:

- `resolveAll` asks `load` for `maxDocuments` documents at most,
  counting the ones `load` does not have. One more is `openapi_work`.
- It loads in `maxRounds` rounds at most. A round loads what the
  documents so far name, so the count is how deep one document names
  another. The description of DigitalOcean, in 3,622 files, takes 7.
  Each round indexes every document again, so a long chain of
  documents would cost the square of its length. One more round is
  `openapi_work`. Documents given in `documents` take no round.
- It holds the texts and bytes that `load` gives, with those in
  `documents`, together to the limits of one text: see
  [Several documents](#several-documents).

`maxSteps`, `maxDepth` and `onCheck` hold for each round, and for the
resolving after the rounds. No bound here is on time: an `onCheck` that
returns `false` after a deadline stops the indexing, and a loader's own
`signal` stops a request.

Under `strict` the rounds run as they do without it, and `resolveAll`
then refuses a reference that is still unresolved.

```js
const { parse, resolveAll } = require('@tabnas/openapi')

const files = {
  'https://example.com/api/a.yaml': 'A: {type: object, properties: {b: {$ref: "b.yaml#/B"}}}\n',
  'https://example.com/api/b.yaml': 'B: {type: string}\n',
}
const asked = []
const load = (uri) => (asked.push(uri), files[uri])
const raw = parse('openapi: 3.1.0\ninfo: {title: t, version: "1"}\npaths: {}\ncomponents:\n  schemas:\n    A: {$ref: "a.yaml#/A"}\n')
let tree
resolveAll(raw, { retrievalUri: 'https://example.com/api/openapi.yaml', load }).then((r) => {
  tree = r.tree
})
```

### `fileLoader(options)`

```ts
import { fileLoader } from '@tabnas/openapi/dist/loaders'

function fileLoader(options: { root: string, maxBytes?: number }): Loader
```

A `load` for `resolveAll` that reads files under one directory, `root`.
It is in a module of its own, which the main one does not load, so a
program that makes no loader has no file code in reach.

It reads a document that a `file:` URI names, and gives its bytes. It
has none for any other URI, for a file that is not there, and for a
directory. It refuses a file outside `root`, with a `ResolveError`
coded `openapi_load`. It judges the path as written first, before it
looks for anything, and again once it has followed every symbolic link
on the path, so it refuses a link under `root` that leads out of it as
well. It refuses a file past `maxBytes`, 128 MiB unless given, before
reading it.

As written, a path is under `root` when it starts with `root` as the
caller gave it, or with the real path of that directory, which has no
link left in it. A document named by any other path to the same
directory, through a second link or by a short name on Windows, is
outside as written, and the loader refuses it without looking for it.
So the `retrievalUri` of a description starts with the path given as
`root`, or with the real path of that directory.

The result names a document by its URI in normal form, which has `~`
where Node's `pathToFileURL` writes `%7E`. The two name one file, and
the loader reads either.

The loader bounds what a description can name. It is no defence
against someone who can write to `root` while it reads.

```js
const { pathToFileURL } = require('node:url')
const { parse, resolveAll } = require('@tabnas/openapi')
const { fileLoader } = require('@tabnas/openapi/dist/loaders')

const load = fileLoader({ root: '/srv/api' })
typeof load // => 'function'
// const raw = parse(fs.readFileSync('/srv/api/openapi.yaml'))
// const { tree } = await resolveAll(raw, { retrievalUri: pathToFileURL('/srv/api/openapi.yaml').href, load })
```

### `httpLoader(options)`

```ts
import { httpLoader } from '@tabnas/openapi/dist/loaders'

function httpLoader(options: {
  hosts: string[]                      // the hosts it reads from
  schemes?: ('https' | 'http')[]       // default ['https']
  privateAddresses?: boolean           // default false
  maxBytes?: number                    // default 16 MiB
  timeoutMs?: number                   // default 10000
  maxRedirects?: number                // default 5
  signal?: AbortSignal
  headers?: Record<string, Record<string, string>>  // by origin
  cache?: boolean                      // default true
  lookup?: (host: string) => Promise<{ address: string, family: number }[]>
}): Loader
```

A `load` for `resolveAll` that reads documents over HTTP, from the
hosts in `hosts` and no others. Each host is as a URL writes it, with
its port where that is not the scheme's own: `api.example.com`,
`localhost:8080`.

It reads a document that an `http:` or `https:` URI names, and gives
its bytes. It has none for any other URI, and none for a document the
server answers 404 or 410 for. Everything else it cannot read, or may
not, it refuses with a `ResolveError` coded `openapi_load`:

- A host or a scheme that is not in its lists. It checks both again at
  every redirect, so a listed host cannot hand it on to one that is
  not. It follows `maxRedirects` at most.
- A host at an address that is not a public one: the machine's own, a
  private or link-local address, or one of the ranges kept for other
  uses, an IPv4 address inside an IPv6 one included. Whoever answers for a
  listed name could otherwise point it at the machine itself, or at the
  network the machine is on. The loader sends its request to the
  addresses it judged, the next where it cannot reach the first, so
  the name is not resolved a second time. `privateAddresses: true`
  lifts this, for a host that is meant to be on such a network.
- A document past `maxBytes`, by the length the server declares or as
  the bytes arrive, and one that takes longer than `timeoutMs`,
  redirects included. `signal` stops a request under way.
- A URI with a user name or a password in it.
- An answer that is neither success nor a redirect, apart from 404 and
  410.

`headers` gives the headers to send, by origin. Each set goes to that
origin alone, so a credential for one host does not follow a redirect
to another.

The loader keeps what it read for as long as it is kept itself, unless
`cache` is `false`. It asks again for a document that failed.

Its connections are its own. It takes up none that other code of the
process opened, since such a connection may be to an address the loader
did not judge. It keeps a connection for the next document from the
same host. Where the server had closed a kept connection, it asks once
more on a new one.

`resolveAll` knows a document that a redirect led to by the URI it
asked for, and reads the document's relative references against that
URI.

```js
const { httpLoader } = require('@tabnas/openapi/dist/loaders')

const load = httpLoader({
  hosts: ['api.example.com'],
  headers: { 'https://api.example.com': { authorization: 'Bearer ...' } },
})
typeof load // => 'function'
load('file:///etc/passwd') // => undefined
// const { tree } = await resolveAll(raw, { retrievalUri: 'https://api.example.com/openapi.yaml', load })
```

### `version(tree)`

```ts
function version(tree: unknown): VersionInfo

type VersionInfo = {
  version: '2.0' | '3.0' | '3.1' | '3.2' | 'unknown'
  field: 'openapi' | 'swagger' | null
  value: unknown
}
```

Reads the version a tree's root names. `openapi` is read before
`swagger`, and either may be a string or a number:

| Member | Read as |
|---|---|
| `openapi: "3.1.0"`, `"3.1.2"`, `"3.1.0-rc1"` | `'3.1'` |
| `openapi: 3.1` | `'3.1'` |
| `openapi: 3.0`, `3` | `'3.0'` |
| `openapi: "3.0.3"` | `'3.0'` |
| `openapi: "3.2.0"`, `3.2` | `'3.2'` |
| `swagger: "2.0"`, `2.0`, `2` | `'2.0'` |
| anything else, or neither member | `'unknown'` |

`field` names the member read, and `value` is its value as written.

### `make(options?)`

```ts
function make(options?: MakeOptions): Tabnas

type MakeOptions = {
  strict?: boolean              // default false
  reading?: 'base' | 'spec'     // default 'base'
}
```

Returns a new parser with the plugin installed:

| `strict` | Base grammar | Reads |
|---|---|---|
| `false` | `jsonic`, then `Yaml` | YAML, and JSON text |
| `true` | `json` | JSON text by RFC 8259 |

`reading: 'spec'` sets the parser to the specification's reading, by
the yaml grammar's `schema: 'core'` option and two options of the
engine. It adds no token and no rule. Under `strict` it changes nothing.
The option needs `@tabnas/yaml` 0.5.33 or later: `make` asks the parser
it built whether it reads the core schema, and throws a `TypeError` when
it does not.

Every call builds a new parser. A parser can be reused for any number of
parses. Its own `parse` method reads the text with the grammar alone and
raises none of the plugin's codes: a stream comes back as an array of
documents, and a root that is not a map comes back as it is.

### `OpenApi`

```ts
const OpenApi: Plugin

type OpenApiOptions = Record<string, never>
```

The plugin. Install it after the base grammar, with `tn.use(OpenApi)`.
It takes no options; `OpenApi.defaults` is `{}`. It adds no rule. It
declares the error codes `parse` raises, makes a repeated member name
keep its last value unless `parse` asks for the merge, and runs the
checks when `parse` asks for them.

### `VERSION`

```ts
const VERSION: string
```

The package version, equal to the `version` in `package.json`.

## The tree

A parse returns the document as written, with nothing followed:

| In the document | In the tree |
|---|---|
| a YAML mapping or JSON object | an object with no prototype, members in document order |
| a YAML sequence or JSON array | an array |
| a JSON number, or a YAML scalar that reads as a number | a `number` |
| `true`, `false` | a `boolean` |
| `null`, or an empty YAML value | `null` |
| any other scalar | a `string` |
| `$ref` and every other member | kept as written |

A member named `__proto__` is an ordinary member. A member name that
appears twice in one map keeps its last value, whole, at the place of its
first appearance, as `JSON.parse` keeps it. `duplicates: 'merge'` merges
the two values there instead. These hold for both paths and both base
grammars, with one exception: only the default parser reads YAML.

YAML rules that decide a value's type, under both readings:

| Written | Read as |
|---|---|
| `openapi: 3.1` | the number `3.1` |
| `openapi: 3.1.0` | the string `'3.1.0'` |
| `swagger: 2.0` | the number `2` |
| `swagger: '2.0'` | the string `'2.0'` |
| `$ref: #/a` | `null`: the `#` after a space starts a comment |
| `$ref: '#/a'` | the string `'#/a'` |
| `true`, `False`, `~`, `NULL` | `true`, `false`, `null`, `null` |
| `.inf`, `-.inf`, `.nan` | `Infinity`, `-Infinity`, `NaN` |

And where the readings part:

| Written | Under `'base'` | Under `'spec'` |
|---|---|---|
| `url: //host/path` | `null`: `//` starts a comment | the string `'//host/path'` |
| `path: /*` | refused, as `unterminated_comment` | the string `'/*'` |
| `1_000` | the number `1000` | the string `'1_000'` |
| `yes`, `on`, `no`, `off` | `true`, `true`, `false`, `false` | the strings `'yes'`, `'on'`, `'no'`, `'off'` |
| `0b11`, `0X1F`, `-0x1F` | `3`, `31`, `-31` | the strings as written |
| `Infinity` | `Infinity` | the string `'Infinity'` |

## What this release does not do

`resolve` loads nothing, and `resolveAll` loads only what its `load`
reads. No loader is on unless the caller makes one.

Under `refs: 'pointer'`, and so under `compat: 'apidef'`, no other
document is read.

## Errors

A failed parse throws a `TabnasError`. Its `code` names the failure,
its `details` holds what the message quotes, and its `toJSON()` gives
the row and column, counting from 1. The plugin's codes are in the
table under `parse`. The engine's are these:

| Code | Raised when |
|---|---|
| `unexpected` | the text has a token the grammar does not allow there: under `strict`, YAML, a comment, or a trailing comma |
| `unterminated_string` | under `strict`, a string has no closing quote |
| `invalid_unicode` | under `strict`, a `\u` escape is malformed |
| `unterminated_comment` | a block comment has no end |

`openapi_stream` is placed at the start of the second document,
`openapi_duplicate_key` at the repeated name, and the others at the start
of the document. `openapi_root` says what the root is in
`details.kind`: `'empty'` for a text of white space and comments alone,
or `'null'`, `'a list'`, `'a string'`, `'a number'` or `'a Boolean'`. A
member name a message quotes is JSON-quoted and cut short. The default parser is lenient: it reads some text that the strict
parser refuses, and raises fewer of the engine's codes. The message is
for people, and its wording can change between releases. Test the code.
