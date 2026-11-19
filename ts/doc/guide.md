# How-to guide

Short recipes for tasks you meet with `@tabnas/openapi`. Each assumes you
have the package installed; the [tutorial](tutorial.md) covers that, and
the [reference](reference.md) has the details each recipe skips.

## Read a description from a file

Read the file and parse it. The format does not matter: `parse` reads
YAML and JSON.

```js
const Fs = require('node:fs')
const { parse } = require('@tabnas/openapi')

const doc = parse(Fs.readFileSync('openapi.yaml'))
```

`parse` takes the file's bytes as they are, and reads them by their
byte-order mark. It reads UTF-8 with or without one, and UTF-16 and
UTF-32 with one. It takes a string too.

```js
const { parse } = require('@tabnas/openapi')

const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('openapi: 3.1.0\n', 'utf16le')])
parse(utf16) // => { openapi: '3.1.0' }
```

## Accept strict JSON only

Pass `strict` when a description must be JSON by RFC 8259, with no
comments, no trailing commas, and no YAML. It also refuses an unknown
version and a member name given twice in one map:

```js
const { parse } = require('@tabnas/openapi')

function codeOf(text) {
  try {
    parse(text, { strict: true })
    return null
  } catch (err) {
    return err.code
  }
}

codeOf('{"openapi":"3.1.0","paths":{}}') // => null
codeOf('{"openapi":"3.1.0","paths":{},}') // => 'unexpected'
codeOf('{"openapi":"4.0.0"}') // => 'openapi_version'
codeOf('{"openapi":"3.1.0","a":1,"a":2}') // => 'openapi_duplicate_key'
```

Without `strict`, the trailing comma is read, any version is accepted,
and the repeated name keeps its last value.

## Find out which version a description claims

`version` reads the root's `openapi` or `swagger` member:

```js
const { parse, version } = require('@tabnas/openapi')

version(parse('swagger: "2.0"\ninfo: {}')).version // => '2.0'
version(parse('openapi: 3.2.0\ninfo: {}')).version // => '3.2'
version(parse('info: {}')).version // => 'unknown'
```

Branch on `version`, not on the raw member: YAML may have read an
unquoted `3.1` as a number.

## Keep a parser for many descriptions

`parse` shares one parser per setting of `strict`. To hold your own,
make it and pass it as `instance`:

```js
const { make, parse } = require('@tabnas/openapi')

const parser = make()
parse('openapi: 3.1.0', { instance: parser }) // => { openapi: '3.1.0' }
```

A parser you build by hand works too, once the plugin is installed after
the base grammar:

```js
const { Tabnas } = require('@tabnas/parser')
const { jsonic } = require('@tabnas/jsonic')
const { Yaml } = require('@tabnas/yaml')
const { OpenApi, parse } = require('@tabnas/openapi')

const parser = new Tabnas().use(jsonic).use(Yaml).use(OpenApi)
parse('paths:\n  /pets: {}', { instance: parser }) // => { paths: { '/pets': {} } }
```

For strict JSON, install `json` from `@tabnas/json` in place of `jsonic`
and `Yaml`.

## Read JSON through the grammar only

JSON text that opens with `{` is read with `JSON.parse` first. Pass
`fast: false` to have the grammar read it, which is slower and gives the
same tree:

```js
const { parse } = require('@tabnas/openapi')

parse('{"openapi":"3.1.0"}', { fast: false }) // => { openapi: '3.1.0' }
```

## Read YAML as the specification does

The grammars beneath this package read more than YAML does. `//` starts
a comment, as in JSON with comments, `1_000` is a number, and `on` and
`off` are `true` and `false`, as in YAML 1.1. A description written for
a YAML reader can lose a value that way: a server URL with no scheme
reads as nothing at all, and a list of the words `on` and `off` reads as
`true` and `false`. Pass `reading: 'spec'` to read a comment as YAML does
and a plain scalar as its core schema does:

```js
const { parse } = require('@tabnas/openapi')

const text = `
openapi: 3.0.0
servers:
  - url: //api.example.com/v1
x-batch: 1_000
x-modes: [on, off]
`

parse(text).servers[0].url // => null
parse(text)['x-batch'] // => 1000
parse(text)['x-modes'] // => [true, false]
parse(text, { reading: 'spec' }).servers[0].url // => '//api.example.com/v1'
parse(text, { reading: 'spec' })['x-batch'] // => '1_000'
parse(text, { reading: 'spec' })['x-modes'] // => ['on', 'off']
```

The specification's reading needs `@tabnas/yaml` 0.5.33 or later.

It also passes over an empty document after the description, which the
default reading refuses as a second document. The
[reference](reference.md#reading) lists what each reading takes.

## Merge a member name written twice

A member name given twice in one map keeps its last value. Some
descriptions are written for a reader that merges the two values, so
that the operations of one path can be spelled in two places. Pass
`duplicates: 'merge'` to read them that way:

```js
const { parse } = require('@tabnas/openapi')

const text = `
openapi: 3.0.0
paths:
  /pets:
    get: { responses: {} }
  /pets:
    post: { responses: {} }
`

Object.keys(parse(text).paths['/pets']) // => ['post']
Object.keys(parse(text, { duplicates: 'merge' }).paths['/pets']) // => ['get', 'post']
```

The merge is the one the grammars beneath this package make by
themselves. The [reference](reference.md#parsetext-options) has its
rules.

## Resolve the references in a description

`resolve` takes the raw tree `parse` returns and gives back a new tree
with every reference replaced by what it names:

```js
const { parse, resolve } = require('@tabnas/openapi')

const raw = parse(`
openapi: 3.1.0
paths:
  /pets:
    get:
      responses:
        '200':
          $ref: '#/components/responses/Pets'
components:
  responses:
    Pets:
      description: A list of pets
`)

const out = resolve(raw)
out.tree.paths['/pets'].get.responses['200'] // => { description: 'A list of pets' }
out.unresolved // => []
```

The raw tree still holds the `$ref`, so you can keep both.

## Fail on a broken reference

By default a reference that names nothing is listed in `unresolved` and
left as written. Pass `strict` to have `resolve` throw instead:

```js
const { parse, resolve } = require('@tabnas/openapi')

const raw = parse('openapi: 3.1.0\ncomponents: {schemas: {S: {$ref: "#/nope"}}}')
resolve(raw).unresolved // => [{ at: '/components/schemas/S', ref: '#/nope', why: 'not-found' }]

let code
try {
  resolve(raw, { strict: true })
} catch (err) {
  code = err.code
}
code // => 'openapi_unresolved'
```

## See where a reference lands

`provenance` has one entry for each reference. Its `target` is the
location the pointer names, and its `landing` is the location the
pointer comes to. The two differ where a step of the pointer is missing
at a reference and is read in what that reference names. `through`
lists each such reference:

```js
const { parse, resolve } = require('@tabnas/openapi')

const raw = parse(`
openapi: 3.0.3
components:
  schemas:
    Pet: {properties: {name: {type: string}}}
    Alias: {$ref: '#/components/schemas/Pet'}
    Name: {$ref: '#/components/schemas/Alias/properties/name'}
`)
const out = resolve(raw)
const name = out.provenance.find((p) => p.at === '/components/schemas/Name')
name.target // => '/components/schemas/Alias/properties/name'
name.landing // => '/components/schemas/Pet/properties/name'
name.through // => ['/components/schemas/Alias']
out.tree.components.schemas.Name // => { type: 'string' }
```

Under `strict` that step is not taken, and the reference is not found.

## Bound the work of resolving, or stop it

`maxSteps` is the most steps a resolve may take. Past it, `resolve`
throws `openapi_work`. `onCheck` is asked every `checkEveryN` steps
whether to go on, and when it returns `false`, `resolve` throws
`openapi_cancel`. Keep a deadline there:

```js
const { parse, resolve } = require('@tabnas/openapi')

const raw = parse('{"openapi":"3.1.0","components":{"schemas":{"A":{"$ref":"#/components/schemas/B"},"B":{"type":"string"}}}}')

let code
try {
  resolve(raw, { maxSteps: 3 })
} catch (err) {
  code = err.code
}
code // => 'openapi_work'

const deadline = Date.now() + 2000
const out = resolve(raw, { checkEveryN: 100, onCheck: () => Date.now() < deadline })
out.unresolved // => []
```

## Write a resolved description to a file

The default result shares one value among the sites that name it, and
JSON writes a shared value out at every one of them. Ask for a tree
instead. `inline-once` fills the first site naming each target and
leaves the rest as references:

```js
const { parse, resolve } = require('@tabnas/openapi')

const raw = parse(`
openapi: 3.1.0
paths:
  /a:
    get:
      responses:
        "200": { $ref: "#/components/responses/Ok" }
  /b:
    get:
      responses:
        "200": { $ref: "#/components/responses/Ok" }
components:
  responses:
    Ok: { description: ok }
`)

const out = resolve(raw, { sharing: 'inline-once' })
out.tree.paths['/a'].get.responses['200'] // => { description: 'ok' }
out.tree.paths['/b'].get.responses['200'] // => { $ref: '#/components/responses/Ok' }
```

To fill every site, pass `sharing: 'copy'` with a `budget`, the most
bytes of JSON you accept. Past it, `resolve` stops with
`openapi_budget`:

```js
const { parse, resolve } = require('@tabnas/openapi')

const raw = parse('{"openapi":"3.1.0","components":{"schemas":{"A":{"$ref":"#/components/schemas/B"},"B":{"type":"string"}}}}')
resolve(raw, { sharing: 'copy', budget: 4096 }).tree.components.schemas.A // => { type: 'string' }

let code
try {
  resolve(raw, { sharing: 'copy', budget: 10 })
} catch (err) {
  code = err.code
}
code // => 'openapi_budget'
```

## Check what the names in a description reach

Tags, `operationId` values, security requirements, and discriminator
mappings name things without `$ref`. `connections` says what each one reaches.
List the names that reach nothing:

```js
const { parse, resolve } = require('@tabnas/openapi')

const raw = parse(`
openapi: 3.1.0
tags:
  - name: pets
paths:
  /pets:
    get:
      tags: [pets, toys]
      responses: {}
`)

resolve(raw).connections.filter((c) => !c.found).map((c) => c.name) // => ['toys']
```

## Resolve the references inside an extension

The values of `x-` members are data, so a `$ref` inside one stays as
written. Name the extensions whose references you want resolved:

```js
const { parse, resolve } = require('@tabnas/openapi')

const raw = parse(`
openapi: 3.0.0
components:
  schemas:
    Charge:
      type: object
      x-expansionResources:
        oneOf:
          - $ref: "#/components/schemas/Customer"
    Customer: { type: object }
`)

const out = resolve(raw, { extensions: ['x-expansionResources'] })
out.tree.components.schemas.Charge['x-expansionResources'].oneOf[0] // => { type: 'object' }
```

## Resolve as @voxgig/apidef does

`compat: 'apidef'` gives the tree that `@voxgig/apidef`'s own resolver
builds: every `$ref` that is a pointer into the document resolved, the
site's own members laid over the target's, and `x-ref` beside them:

```js
const { parse, resolve } = require('@tabnas/openapi')

const raw = parse(`
openapi: 3.0.0
components:
  schemas:
    A: { $ref: "#/components/schemas/B", description: mine }
    B: { type: string, description: theirs }
`)

resolve(raw, { compat: 'apidef' }).tree.components.schemas.A // => { type: 'string', description: 'mine', 'x-ref': '#/components/schemas/B' }
```

It keeps cycles, so the tree can loop. Write it out with `cycles: 'cut'`
beside the preset, or walk it as a graph.

The preset reads a reference as `@voxgig/apidef` does, which is narrower
than the specification: only a pointer written `#/...` names anything.
An anchor, a URI, and a percent-encoded pointer are left as written. To
resolve those too, give `refs: 'uri'` beside the preset:

```js
const { parse, resolve } = require('@tabnas/openapi')

const raw = parse(`
openapi: 3.1.0
components:
  schemas:
    A: { $ref: "#tee" }
    T: { $anchor: tee, type: string }
`)

resolve(raw, { compat: 'apidef' }).tree.components.schemas.A // => { $ref: '#tee', 'x-ref': '#tee' }
resolve(raw, { compat: 'apidef', refs: 'uri' }).tree.components.schemas.A // => { '$anchor': 'tee', type: 'string', 'x-ref': '#tee' }
```

## Refuse a text that would exhaust memory

A YAML alias is read as a copy of the node its anchor labels. Aliases
inside anchored nodes multiply, so a short text can ask for more memory
than the process has. `parse` measures that on the text and refuses it
before it builds anything:

```js
const { parse, aliasedSize } = require('@tabnas/openapi')

let text = 'openapi: 3.1.0\nl0: &l0 [x, x, x, x, x, x, x, x, x, x]\n'
for (let i = 1; i <= 7; i++) {
  text += `l${i}: &l${i} [${Array(10).fill('*l' + (i - 1)).join(', ')}]\n`
}

let code
try {
  parse(text)
} catch (err) {
  code = err.code
}
text.length // => 467
aliasedSize(text) // => 444444447
code // => 'openapi_alias_budget'
```

The budget is the larger of 1,000,000 bytes and ten times the text.
Pass `aliasBudget` to set your own.

A large text is refused the same way, as `openapi_size`. Reading YAML
takes about a hundred bytes of memory for each byte of a description, so
`parse` gives the grammar at most 16 MiB unless `maxBytes` says
otherwise. JSON text that `JSON.parse` reads is not limited. A text of
very many small values costs far more than its size suggests, and is
stopped by the work it takes, as `openapi_work`, under the same limit.

```js
const { parse } = require('@tabnas/openapi')

let code
try {
  parse('openapi: 3.1.0\ninfo: {}\n', { maxBytes: 16 })
} catch (err) {
  code = err.code
}
code // => 'openapi_size'
parse('{"openapi":"3.1.0","info":{}}', { maxBytes: 16 }) // => { openapi: '3.1.0', info: {} }
```

## Find the numbers that lost precision

A JavaScript number holds an integer exactly up to 2^53. A description
can write a larger one, such as the largest 64-bit integer, and the tree
then holds the nearest number a double can. Give `parse` a `report` and
it lists each such number, with the text as written and where it is:

```js
const { parse } = require('@tabnas/openapi')

const report = {}
const doc = parse('openapi: 3.1.0\nmax: 9223372036854775807\n', { report })

doc.max // => 9223372036854775807
doc.max === 9223372036854775808 // => true
report.lossy.length // => 1
report.lossy[0].text // => '9223372036854775807'
report.lossy[0].at // => '/max'
report.lossy[0].row // => 2
BigInt(report.lossy[0].text) // => 9223372036854775807n
```

The tree is the same with a report as without. To keep the exact value,
read it from `text`.

## Make a tree safe to write as UTF-8

An escape can spell half of a surrogate pair, and a JavaScript string
holds it. UTF-8 cannot: an encoder writes `U+FFFD` in its place. A tree
that is written to a file, hashed, or compared with one read from bytes
then differs from the one in memory. `wellFormed` reads every lone
surrogate as `U+FFFD`, in strings and in member names:

```js
const { parse, wellFormed } = require('@tabnas/openapi')

const raw = parse('{"openapi":"3.1.0","info":{"title":"a\\ud800b"}}')

raw.info.title === 'a\ud800b' // => true
wellFormed(raw).info.title === 'a\ufffdb' // => true
raw.info.title === 'a\ud800b' // => true
```

It returns a new tree and leaves the one it was given alone. A tree
with nothing to repair comes back as it is.

## Tell parse errors apart

A failed parse throws an error with a `code`, and `toJSON()` gives its
row and column. Test the code, not the message: the message is written
for people and can change wording.

```js
const { parse } = require('@tabnas/openapi')

let row, code
try {
  parse('openapi: 3.1.0\n---\nopenapi: 3.0.0')
} catch (err) {
  ;({ code, row } = err.toJSON())
}
code // => 'openapi_stream'
row // => 2
```

The [reference](reference.md#errors) lists the codes.

## Keep a value YAML would change

YAML gives some unquoted values a type: `3.1` is a number, `true` a
Boolean, `null` nothing at all. Quote a value that must stay text:

```js
const { parse } = require('@tabnas/openapi')

const doc = parse("version: '3.1'\nenum: ['true', 'null']")
doc // => { version: '3.1', enum: ['true', 'null'] }
```

The same goes for a `$ref`. Its value starts with `#`, and an unquoted
`#` after a space starts a comment.
