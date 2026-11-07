# How-to guide

Short recipes for tasks you meet with `@tabnas/openapi`. Each assumes you
have the package installed; the [tutorial](tutorial.md) covers that, and
the [reference](reference.md) has the details each recipe skips.

## Read a description from a file

Read the file as text and parse it. The format does not matter: one
parser reads YAML and JSON.

```js
const Fs = require('node:fs')
const { make } = require('@tabnas/openapi')

const parser = make()
const doc = parser.parse(Fs.readFileSync('openapi.yaml', 'utf8'))
```

Keep `parser` for the next file. Building it costs more than a parse.

## Accept strict JSON only

Pass `strict` when a description must be JSON by RFC 8259, with no
comments, no trailing commas and no YAML:

```js
const { make } = require('@tabnas/openapi')

const strict = make({ strict: true })
strict.parse('{"paths":{}}') // => { paths: {} }
```

The default parser accepts a trailing comma; the strict one refuses it:

```js
const { make } = require('@tabnas/openapi')

make().parse('{"paths":{},}') // => { paths: {} }

let code
try {
  make({ strict: true }).parse('{"paths":{},}')
} catch (err) {
  code = err.code
}
code // => 'unexpected'
```

## Install the plugin on your own parser

`make` is a shortcut. To build the parser yourself, install the base
grammar first and the plugin after it:

```js
const { Tabnas } = require('@tabnas/parser')
const { jsonic } = require('@tabnas/jsonic')
const { Yaml } = require('@tabnas/yaml')
const { OpenApi } = require('@tabnas/openapi')

const parser = new Tabnas().use(jsonic).use(Yaml).use(OpenApi)
parser.parse('paths:\n  /pets: {}') // => { paths: { '/pets': {} } }
```

For strict JSON, install `json` from `@tabnas/json` in place of `jsonic`
and `Yaml`.

## Tell parse errors apart

A failed parse throws an error with a `code`. Test the code, not the
message: the message is written for people and can change wording.

```js
const { make } = require('@tabnas/openapi')

function codeOf(src) {
  try {
    make({ strict: true }).parse(src)
    return null
  } catch (err) {
    return err.code
  }
}

codeOf('{"a":1} // note') // => 'unexpected'
codeOf('{"a":1}') // => null
```

The [reference](reference.md#errors) lists the codes.

## Keep a value YAML would change

YAML gives some unquoted values a type: `3.1` is a number, `true` a
Boolean, `null` nothing at all. Quote a value that must stay text:

```js
const { make } = require('@tabnas/openapi')

const doc = make().parse("version: '3.1'\nenum: ['true', 'null']")
doc // => { version: '3.1', enum: ['true', 'null'] }
```

The same goes for a `$ref`. Its value starts with `#`, and an unquoted
`#` after a space starts a comment.
