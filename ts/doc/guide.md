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

## Find a reference that lands on the wrong type

A reference resolves to whatever its pointer comes to. Where that is
not the type the reference stands for, its entry in `provenance` has
`conflict`, the type it landed on:

```js
const { parse, resolve } = require('@tabnas/openapi')

const raw = parse(`
openapi: 3.0.3
components:
  responses:
    Gone: {description: gone}
  schemas:
    Wrong: {$ref: '#/components/responses/Gone'}
    Right: {$ref: '#/components/schemas/Wrong'}
`)
const out = resolve(raw)
out.provenance.filter((p) => p.conflict).map((p) => p.at) // => ['/components/schemas/Wrong']
out.provenance.find((p) => p.conflict).conflict // => 'response'
out.tree.components.schemas.Wrong // => { description: 'gone' }
```

`Wrong` stands for a schema and lands on a Response Object, so it has a
conflict. `Right` lands on `Wrong`, which is a schema where it stands,
and has none.

## Read schemas written in an older dialect

A schema of OpenAPI 3.1 or 3.2 says which JSON Schema dialect it is
written in with `$schema`, and `resolve` reads it by that dialect's
rules. `dialects` lists what the description declares:

```js
const { parse, resolve } = require('@tabnas/openapi')

const raw = parse(`
openapi: 3.1.0
components:
  schemas:
    Legacy:
      $schema: http://json-schema.org/draft-07/schema#
      definitions:
        Id: {type: integer}
      properties:
        id: {$ref: '#/components/schemas/Legacy/definitions/Id', description: an id}
`)
const out = resolve(raw)
out.tree.components.schemas.Legacy.properties.id // => { type: 'integer' }
out.dialects[0].at // => '/components/schemas/Legacy/$schema'
out.dialects[0].as // => 'draft-07'
out.dialects[0].known // => true
```

In draft-07 `definitions` holds schemas, and a `$ref` stands alone, so
the `description` beside it is not kept. Without the `$schema` line the
schema is read as 2020-12, which has `$defs` in that place and keeps the
`description`.

A dialect this package does not know is read as 2020-12 and has
`known: false` in the list. The
[reference](reference.md#dialects) has what each dialect changes.

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

## Resolve a description that is several files

Give `resolve` the other documents in `documents`, each under the URI
you retrieved it from, with the description's own in `retrievalUri`. A
relative name stands against that. A document can be its text, its
bytes, or a tree from `parse`:

```js
const { parse, resolve } = require('@tabnas/openapi')

const raw = parse(`
openapi: 3.1.0
info: { title: Pets, version: "1" }
paths:
  /pets:
    $ref: "paths/pets.yaml"
`)
const out = resolve(raw, {
  retrievalUri: 'https://example.com/api/openapi.yaml',
  documents: {
    'paths/pets.yaml': 'get:\n  responses:\n    "200": {$ref: "../responses.yaml#/Ok"}\n',
    'responses.yaml': 'Ok: {description: ok}\n',
  },
})
out.tree.paths['/pets'].get.responses['200'] // => { description: 'ok' }
out.unresolved // => []
out.provenance.map((p) => [p.doc ?? 'the description', p.at]) // => [ [ 'the description', '/paths/~1pets' ], [ 'https://example.com/api/paths/pets.yaml', '/get/responses/200' ] ]
```

A document that was not given stays a reference, reported with
`why: 'external'`. To have the documents found and read for you, use
`resolveAll` with a loader. `fileLoader` reads files under one
directory and refuses anything outside it:

```js
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { parse, resolveAll } = require('@tabnas/openapi')
const { fileLoader } = require('@tabnas/openapi/dist/loaders')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-'))
fs.writeFileSync(path.join(dir, 'openapi.yaml'), 'openapi: 3.1.0\ninfo: {title: t, version: "1"}\npaths: {}\ncomponents:\n  schemas:\n    Pet: {$ref: "Pet.yaml"}\n')
fs.writeFileSync(path.join(dir, 'Pet.yaml'), 'type: object\n')

const entry = path.join(dir, 'openapi.yaml')
const result = resolveAll(parse(fs.readFileSync(entry)), {
  retrievalUri: pathToFileURL(entry).href,
  load: fileLoader({ root: dir }),
})
result instanceof Promise // => true
// (await result).tree.components.schemas.Pet is { type: 'object' }
```

Write the description's `retrievalUri` from the same path as `root`, as
the example does. `fileLoader` knows its directory by the path you give
it and by that directory's real path. It refuses a document named
through any other route to the directory, such as a second link,
without looking for it.

`httpLoader` reads over HTTP from the hosts you list, and from no
others.
It checks the list again at every redirect, and refuses a host that
turns out to be at a private address:

```js
const { httpLoader } = require('@tabnas/openapi/dist/loaders')

const load = httpLoader({ hosts: ['api.example.com'] })
typeof load // => 'function'
// const { tree } = await resolveAll(raw, { retrievalUri: 'https://api.example.com/openapi.yaml', load })
```

A file that only a discriminator's `mapping` names is part of the
description too. `resolve` reads it as a schema and resolves the
references in it, and `resolveAll` loads it and the files it names in
turn. Its sites come last in `provenance`.

A loader is yours to write, too: any function from a URI to a
document, given as `resolve` takes one. A description names whatever documents
its author chose, so decide what yours may read before it reads.

`resolveAll` bounds what a description can ask of it. It asks for
10,000 documents at most, in 64 rounds at most, and holds the texts it
loads together to the size and the work that `parse` allows one text.
Raise `maxDocuments`, `maxRounds`, or `parse.maxBytes` for a
description you trust that needs more. It sets no deadline: give the
loader a `signal`, and return `false` from `onCheck` when your time is
up.

## Write a description in several files as one

`bundle` writes a description and the documents it names as one
document. What the others hold goes among the description's
components, and each reference then names its target there. It takes
the documents as `resolve` takes them:

```js
const { parse, bundle } = require('@tabnas/openapi')

const raw = parse(`
openapi: 3.1.0
info: { title: Pets, version: "1" }
paths:
  /pets:
    $ref: "paths/pets.yaml"
`)
const out = bundle(raw, {
  retrievalUri: 'https://example.com/api/openapi.yaml',
  documents: {
    'paths/pets.yaml': 'get:\n  responses:\n    "200": {$ref: "../responses.yaml#/Ok"}\n',
    'responses.yaml': 'Ok: {description: ok}\n',
  },
})
out.tree.paths['/pets'] // => { $ref: '#/components/pathItems/pets' }
out.tree.components.pathItems.pets.get.responses['200'] // => { $ref: '#/components/responses/Ok' }
out.tree.components.responses.Ok // => { description: 'ok' }
out.left // => []
```

Nothing is resolved, so the bundle is as large as the documents, and
no larger. To have the documents found and read, use `bundleAll` with
a loader, and write the tree as JSON:

```js
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { parse, bundleAll } = require('@tabnas/openapi')
const { fileLoader } = require('@tabnas/openapi/dist/loaders')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-'))
fs.writeFileSync(path.join(dir, 'openapi.yaml'), 'openapi: 3.1.0\ninfo: {title: t, version: "1"}\npaths: {}\ncomponents:\n  schemas:\n    Pet: {$ref: "Pet.yaml"}\n')
fs.writeFileSync(path.join(dir, 'Pet.yaml'), 'type: object\n')

const entry = path.join(dir, 'openapi.yaml')
const written = bundleAll(parse(fs.readFileSync(entry)), {
  retrievalUri: pathToFileURL(entry).href,
  load: fileLoader({ root: dir }),
}).then((b) => fs.writeFileSync(path.join(dir, 'bundle.json'), JSON.stringify(b.tree, null, 2)))
written instanceof Promise // => true
// bundle.json then holds one description, with Pet_2 among its schemas.
```

Read `left` before you use the bundle. It lists each reference that
names nothing, as `unresolved` does for `resolve`, and whatever else
the bundle could not make whole. An empty list means that every
reference of the bundle names a place in it.

Keep the documents to the version the description declares. A bundle
is one document, so a document of another version is read in it by
the description's version, and the two do not read everything alike.
`left` lists a member beside a reference that is read another way,
and the [reference](reference.md#what-a-bundle-does-not-keep) says
what the bundle cannot list.

A name in the bundle is the last step of the pointer to its target, or
the name of the target's file. Where the name is taken, as `Pet` is in
the example, a number follows it. `embedded` says where each target
went and where it came from.

Some descriptions keep each operation in a file of its own and name it
with a `$ref`, where the specification has no reference. Bundle such
a description under `slots: 'all'`, as you would resolve it. The
operation is then written where its `$ref` was, and what it names goes
among the components.

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

## List the schemas a discriminator can name

A discriminator names a schema by the value of a property. Beside the
entries of its `mapping`, a value names the schema component of that
name. The `implicitMapping` rows of `connections` list those
components:

```js
const { parse, resolve } = require('@tabnas/openapi')

const raw = parse(`
openapi: 3.1.0
components:
  schemas:
    Pet:
      discriminator:
        propertyName: kind
        mapping: {dog: '#/components/schemas/Dog'}
      oneOf:
        - $ref: '#/components/schemas/Dog'
        - $ref: '#/components/schemas/Cat'
    Dog: {type: object}
    Cat: {type: object}
`)
const rows = resolve(raw).connections.filter((c) => c.kind === 'implicitMapping')
rows.map((c) => c.name) // => ['Dog', 'Cat']
rows.map((c) => c.target) // => ['/components/schemas/Dog', '/components/schemas/Cat']
rows.map((c) => c.from) // => ['oneOf', 'oneOf']
```

The value `dog` is the entry of `mapping`, which has a row of kind
`mapping`. The values `Dog` and `Cat` are the names of the components
listed beside the discriminator, and `from` says where: `oneOf`,
`anyOf`, or `allOf` for a schema that builds on this one.

## List the URLs a description gives

`urls` has a row for each URL the description gives for something
outside it, with what a relative one is relative to. Give
`retrievalUri` for the absolute form of a relative one:

```js
const { parse, resolve } = require('@tabnas/openapi')

const raw = parse(`
openapi: 3.1.0
info:
  title: Pets
  version: '1'
  license: {name: MIT, url: LICENSE.txt}
servers:
  - url: /v1
`)
const out = resolve(raw, { retrievalUri: 'https://example.com/api/openapi.yaml' })
out.urls.map((u) => u.at) // => ['/info/license/url', '/servers/0/url']
out.urls.map((u) => u.base) // => ['description', 'retrieval']
out.urls.map((u) => u.uri) // => ['https://example.com/api/LICENSE.txt', 'https://example.com/v1']
```

Nothing is loaded. Without `retrievalUri` the two rows are the same
but for `uri`, which neither has. The
[reference](reference.md#urls) has which field has which base.

## List the operations with what applies to each

An Operation Object does not say everything about its operation. Its
Path Item gives it parameters, and its servers and security may come
from the root. Ask `resolve` for `operations` to have each operation
with what applies to it:

```js
const { parse, resolve } = require('@tabnas/openapi')

const raw = parse(`
openapi: 3.1.0
servers:
  - url: https://api.example.com
security:
  - key: []
paths:
  /pets/{petId}:
    parameters:
      - {name: petId, in: path, required: true}
      - {name: limit, in: query}
    get:
      parameters:
        - {name: limit, in: query, description: At most this many}
      responses: {}
    delete:
      security: []
      responses: {}
`)
const [get, del] = resolve(raw, { operations: true }).operations
get.method // => 'GET'
get.path // => '/pets/{petId}'
get.parameters.map((p) => p.name + ' from ' + p.from) // => ['petId from pathItem', 'limit from operation']
get.parameters[1].parameter.description // => 'At most this many'
get.servers.from // => 'root'
get.servers.value[0].url // => 'https://api.example.com'
get.security.from // => 'root'
del.parameters.map((p) => p.at) // => ['/paths/~1pets~1{petId}/parameters/0', '/paths/~1pets~1{petId}/parameters/1']
del.security.from // => 'operation'
del.security.value // => []
```

The `GET` operation has its own `limit` in the place of its Path
Item's. The `DELETE` operation has both of its Path Item's parameters,
and its empty `security` list removes the root's. Each value is the
object that the resolved tree has at `at`, so a parameter given by
`$ref` is the Parameter Object itself. The
[reference](reference.md#operations) has the rules, and what a webhook
and a callback give.

## Find the headers the specification says to ignore

From 3.0 a header parameter named `Accept`, `Content-Type` or
`Authorization` is to be ignored: the request body, the responses, and
the security schemes describe those. `ignored` lists each one, and no
operation of the view has it among its parameters:

```js
const { parse, resolve } = require('@tabnas/openapi')

const raw = parse(`
openapi: 3.1.0
paths:
  /pets:
    parameters:
      - {name: Accept, in: header}
    post:
      parameters:
        - {name: content-type, in: header}
        - {name: X-Trace, in: header}
      responses: {}
`)
const out = resolve(raw, { operations: true })
out.ignored.map((i) => i.name) // => ['Accept', 'content-type']
out.ignored.map((i) => i.at) // => ['/paths/~1pets/parameters/0', '/paths/~1pets/post/parameters/0']
out.ignored.map((i) => i.method) // => [undefined, 'POST']
out.operations[0].parameters.map((p) => p.name) // => ['X-Trace']
```

The report is given with or without `operations`. It also lists a
header named `Content-Type` among the headers of a response or of an
encoding, which the specification says to ignore too.

## Check the paths, the servers, and the links of a description

A path and a server's URL are templates, with names between braces. A
name of a path is a path parameter, and a name of a server's URL is one
of its variables. A Link and a callback hold runtime expressions, which
name parameters of a request. `connections` says what each of those
names reaches. List the ones that reach nothing:

```js
const { parse, resolve } = require('@tabnas/openapi')

const raw = parse(`
openapi: 3.1.0
servers:
  - url: https://{region}.example.com
paths:
  /pets/{petId}:
    get:
      operationId: getPet
      parameters:
        - {name: id, in: path, required: true}
      responses:
        '200':
          description: A pet
          links:
            owner:
              operationId: getPet
              parameters:
                id: $request.path.petId
`)
const missing = resolve(raw).connections.filter((c) => !c.found)
missing.map((c) => c.kind + ' ' + c.name)
// => ['serverVariable region', 'pathParameter petId', 'pathParameter id', 'expression $request.path.petId']
missing.map((c) => c.why)
// => [undefined, 'no-parameter', 'no-expression', undefined]
```

The server's URL names a variable that the Server Object does not
declare. The path names `petId`, and the operation declares `id`, so
each lacks the other. The Link's expression names a path parameter that
its operation does not declare. The Link's own parameter name, `id`, is
found: the operation it names has that parameter.

A template that is not well made has a row of kind `template`, and two
paths that differ only in the names between their braces have a
`pathClash` row. The [reference](reference.md#connections) has every
kind.

## Read a runtime expression, and give it a value

A runtime expression names a value of one request and its response.
`readExpression` reads one into its parts, and `evaluateExpression`
gives its value, from a request and a response that the caller has:

```js
const { readExpression, readTemplate, evaluateExpression } = require('@tabnas/openapi')

readExpression('$request.query.a.b').name // => 'a.b'
readExpression('$response.body#/items/0/id').tokens // => ['items', '0', 'id']

const exchange = {
  request: {
    method: 'POST',
    url: 'https://example.org/subscribe?queryUrl=https://client.example.com/hook',
    headers: { 'Content-Type': 'application/json' },
    query: { queryUrl: 'https://client.example.com/hook' },
    body: { ids: [7, 8] },
  },
  response: { statusCode: 201, headers: { Location: 'https://example.org/subscription/1' } },
}
evaluateExpression('$request.header.content-type', exchange) // => 'application/json'
evaluateExpression('$request.body#/ids/1', exchange) // => 8
evaluateExpression('$response.header.Location', exchange) // => 'https://example.org/subscription/1'
evaluateExpression('$request.query.missing', exchange) // => undefined
```

A callback's key is a runtime expression. It may stand alone, or
between braces in a URL. Read it as a template of kind `'runtime'`, and
evaluate that for the URL to call:

```js
const { readTemplate, evaluateExpression } = require('@tabnas/openapi')

const key = readTemplate('{$request.query.queryUrl}?status={$statusCode}', 'runtime')
key.parts.length // => 3
const exchange = {
  request: { query: { queryUrl: 'https://client.example.com/hook' } },
  response: { statusCode: 201 },
}
evaluateExpression(key, exchange) // => 'https://client.example.com/hook?status=201'
```

Text that is no expression, or braces that are no template's, raise an
`ExpressionError` with the code `openapi_expression`:

```js
const { readExpression, readTemplate } = require('@tabnas/openapi')

let code
try { readExpression('$request.body.x') } catch (err) { code = err.code }
code // => 'openapi_expression'
readTemplate('/pets/{petId}/photos/{photoId}').parts.filter((p) => 'name' in p).map((p) => p.name) // => ['petId', 'photoId']
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
takes memory and time in step with the text, so `parse` gives the
grammar at most 128 MiB unless `maxBytes` says otherwise. JSON text that
`JSON.parse` reads is not limited. A text of very many small values
costs far more than its size suggests, and is stopped by the work it
takes, as `openapi_work`, under the same limit. A description of
60 MiB takes about a minute to read, and the
[reference](reference.md#aliasbudget-and-maxbytes) has what each size
costs.

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
