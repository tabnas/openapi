# How-to guide

Short recipes for tasks you meet with `@tabnas/openapi`. Each assumes you
have the package installed; the [tutorial](tutorial.md) covers that, and
the [reference](reference.md) has the details each recipe skips.

## Read a description from a file

Read the file as text and parse it. The format does not matter: `parse`
reads YAML and JSON.

```js
const Fs = require('node:fs')
const { parse } = require('@tabnas/openapi')

const doc = parse(Fs.readFileSync('openapi.yaml', 'utf8'))
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
row // => 3
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
