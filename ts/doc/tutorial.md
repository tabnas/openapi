# Tutorial: read an OpenAPI description

An OpenAPI description is a tree of maps and lists. It is written in
YAML or in JSON. In this tutorial we read one in both forms and look
at what comes back. Then we resolve its references, across two files
as well, write those files as one, and ask what applies to an
operation. It takes about fifteen minutes, most of it reading.

You need Node.js 24 or later.

## Install the package

Install it with the parser, the three grammars it composes, and the
package its resolver is built on:

```bash
npm install @tabnas/openapi @tabnas/parser @tabnas/jsonic @tabnas/yaml @tabnas/json @tabnas/expr
```

The last five are peer dependencies, so your project decides their
versions.

## Read YAML

`parse` reads a description and returns its tree:

```js
const { parse } = require('@tabnas/openapi')

const doc = parse(`
openapi: 3.1.0
info:
  title: Pets
  version: "1"
paths:
  /pets:
    get:
      responses:
        '200':
          description: A list of pets
`)

doc.info.title // => 'Pets'
doc.paths['/pets'].get.responses['200'].description // => 'A list of pets'
```

Each YAML mapping becomes an object and each sequence an array. The
version is quoted, and the section after next shows why.

## Read JSON

We did not tell `parse` which format to expect, and we do not need to:

```js
const { parse } = require('@tabnas/openapi')

const doc = parse(
  '{"openapi":"3.1.0","info":{"title":"Pets","version":"1"},"paths":{}}')

doc.info // => { title: 'Pets', version: '1' }
```

JSON text is also YAML, and the yaml grammar reads it to the same tree
the JSON grammar gives. JSON text that opens with `{` takes a fast path
through `JSON.parse`, and comes out the same.

## References stay as written

A `$ref` comes back exactly as the document wrote it:

```js
const { parse } = require('@tabnas/openapi')

const doc = parse(`
parameters:
  - $ref: '#/components/parameters/Limit'
`)

doc.parameters // => [{ $ref: '#/components/parameters/Limit' }]
```

That is the raw tree: the document as written, nothing followed. The
reference is quoted for a reason YAML imposes. Unquoted, the `#` after a
space starts a comment, and the value would be empty.

## Keep versions as text

YAML reads `3.1` as a number. Quote a version to keep it a string:

```js
const { parse, version } = require('@tabnas/openapi')

parse('openapi: 3.1') // => { openapi: 3.1 }
parse("openapi: '3.1'") // => { openapi: '3.1' }
version(parse('openapi: 3.1.0')).version // => '3.1'
```

`version` reads the version a description names. It reads a string and
a number alike, so both of the first two read as `'3.1'`.

## What parse refuses

A description is one document with a map at its root. `parse` refuses
anything else, with an error whose `code` says why:

```js
const { parse } = require('@tabnas/openapi')

function codeOf(text) {
  try {
    parse(text)
  } catch (err) {
    return err.code
  }
}

codeOf('- a list\n- of things') // => 'openapi_root'
codeOf('openapi: 3.1.0\n---\nopenapi: 3.0.0') // => 'openapi_stream'
```

The code is what to test for. The message is written for people.

## Insist on JSON

`strict` reads JSON alone, by RFC 8259. It also requires a version this
package reads, and each member name once per map:

```js
const { parse } = require('@tabnas/openapi')

parse('{"openapi":"3.1.0"}', { strict: true }) // => { openapi: '3.1.0' }

let code
try {
  parse('openapi: 3.1.0', { strict: true })
} catch (err) {
  code = err.code
}
code // => 'unexpected'
```

## Resolve the references

The raw tree keeps every `$ref`. `resolve` builds a new tree with each
one replaced by what it names:

```js
const { parse, resolve } = require('@tabnas/openapi')

const raw = parse(`
openapi: 3.1.0
paths:
  /pets:
    parameters:
      - $ref: '#/components/parameters/Limit'
components:
  parameters:
    Limit: { name: limit, in: query }
`)

resolve(raw).tree.paths['/pets'].parameters // => [{ name: 'limit', in: 'query' }]
raw.paths['/pets'].parameters // => [{ $ref: '#/components/parameters/Limit' }]
```

We still have the raw tree, unchanged, beside the resolved one.

## Resolve across two files

A description is often several files. `resolve` reads no file itself,
so we hand it the other one, under the name the description uses for
it, and say where the description came from:

```js
const { parse, resolve } = require('@tabnas/openapi')

const raw = parse(`
openapi: 3.1.0
paths: {}
components:
  schemas:
    Animal: { $ref: 'schemas/Pet.yaml' }
`)

const result = resolve(raw, {
  retrievalUri: 'https://example.com/api/openapi.yaml',
  documents: {
    'schemas/Pet.yaml': 'type: object\nproperties:\n  name: { type: string }\n',
  },
})

result.tree.components.schemas.Animal.properties.name // => { type: 'string' }
result.unresolved // => []
```

The name `schemas/Pet.yaml` is relative, and `retrievalUri` is what it
is relative to. `unresolved` lists each reference that `resolve` had to
leave as written. Here it left none.

## Write the two files as one

`bundle` takes the same two files and writes one description. It does
not resolve anything. Each reference is still a reference, and now
names a place in the one document:

```js
const { parse, bundle } = require('@tabnas/openapi')

const raw = parse(`
openapi: 3.1.0
paths: {}
components:
  schemas:
    Animal: { $ref: 'schemas/Pet.yaml' }
`)

const one = bundle(raw, {
  retrievalUri: 'https://example.com/api/openapi.yaml',
  documents: {
    'schemas/Pet.yaml': 'type: object\nproperties:\n  name: { type: string }\n',
  },
})

one.tree.components.schemas.Animal // => { $ref: '#/components/schemas/Pet' }
one.tree.components.schemas.Pet.properties.name // => { type: 'string' }
one.left // => []
```

The schema from the second file became a component, named after its
file. `JSON.stringify(one.tree)` is the bundle as text.

## See what applies to an operation

An operation does not hold everything that applies to it. Its Path Item
can give it parameters, and the root can give it servers and security.
With `operations: true`, `resolve` lists each operation with all of
that worked out:

```js
const { parse, resolve } = require('@tabnas/openapi')

const raw = parse(`
openapi: 3.1.0
paths:
  /pets/{id}:
    parameters:
      - { name: id, in: path, required: true }
    get:
      parameters:
        - { name: limit, in: query }
      responses: {}
`)

const [operation] = resolve(raw, { operations: true }).operations

operation.method // => 'GET'
operation.path // => '/pets/{id}'
operation.parameters.map((p) => [p.name, p.from]) // => [['id', 'pathItem'], ['limit', 'operation']]
```

The operation wrote one parameter and has two. `from` says where each
came from.

## Where next

The [how-to guide](guide.md) reads a description from a file, loads
the files it names, checks its version, and keeps a parser for reuse.
The [reference](reference.md) lists every export, and the
[concepts](concepts.md) page says why the package is built this way.
