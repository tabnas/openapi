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

## Make a parser

`make` builds a parser with everything installed:

```js
const { make } = require('@tabnas/openapi')

const parser = make()
parser.parse('openapi: 3.1.0') // => { openapi: '3.1.0' }
```

Build it once and keep it. Building the grammar costs more than a parse,
and one parser serves every parse after that.

## Read YAML

Here is a small description in YAML:

```js
const { make } = require('@tabnas/openapi')

const doc = make().parse(`
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

Each YAML mapping becomes a plain object and each sequence an array. The
version is quoted, and the next section but one shows why.

## Read JSON

We did not tell the parser which format to expect, and we do not need to:

```js
const { make } = require('@tabnas/openapi')

const doc = make().parse(
  '{"openapi":"3.1.0","info":{"title":"Pets","version":"1"},"paths":{}}')

doc.info // => { title: 'Pets', version: '1' }
```

JSON text is also YAML, and the yaml grammar reads it to the same tree
the JSON grammar gives.

## References stay as written

A `$ref` comes back exactly as the document wrote it:

```js
const { make } = require('@tabnas/openapi')

const doc = make().parse(`
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
const { make } = require('@tabnas/openapi')

make().parse('openapi: 3.1') // => { openapi: 3.1 }
make().parse("openapi: '3.1'") // => { openapi: '3.1' }
make().parse('openapi: 3.1.0') // => { openapi: '3.1.0' }
```

`3.1.0` is not a number, so it stays a string either way.

## Insist on JSON

`strict` reads JSON alone, by RFC 8259, and refuses anything else:

```js
const { make } = require('@tabnas/openapi')

const strict = make({ strict: true })
strict.parse('{"openapi":"3.1.0"}') // => { openapi: '3.1.0' }

let code
try {
  strict.parse('openapi: 3.1.0')
} catch (err) {
  code = err.code
}
code // => 'unexpected'
```

Every parse error carries a code like this one, and the code is what to
test for.

## Where next

The [how-to guide](guide.md) reads a description from a file and installs
the plugin on a parser you already have. The [reference](reference.md)
lists every export.
