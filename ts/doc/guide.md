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
