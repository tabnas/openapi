# Tutorial: read an OpenAPI description

An OpenAPI description is a tree of maps and lists. It is written in
YAML or in JSON. In this tutorial we read one in both forms and look
at what comes back. It takes about ten minutes, most of it reading.

You need Node.js 24 or later.

## Install the package

Install it with the parser and the three grammars it composes:

```bash
npm install @tabnas/openapi @tabnas/parser @tabnas/jsonic @tabnas/yaml @tabnas/json
```

The last four are peer dependencies, so your project decides their
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

## Where next

The [how-to guide](guide.md) reads a description from a file, resolves
it, checks its version, and keeps a parser for reuse. The
[reference](reference.md) lists every export.
