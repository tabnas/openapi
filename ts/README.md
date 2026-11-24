# @tabnas/openapi

A [Tabnas](https://github.com/tabnas/parser) plugin that reads
[OpenAPI](https://spec.openapis.org/oas/latest.html) and Swagger
descriptions, in YAML or in JSON, with one parser for both.

`parse` returns the raw tree: the document as written, with every `$ref`
kept as a reference, after checking that it is one description with a
map at its root. `resolve` builds a new tree with the references resolved,
within the document and into any other document given with it, and
`resolveAll` loads the documents a description names, with a loader
you give it. `bundle` writes a description in several documents as
one, with every reference still a reference. `resolve` also reports what a description names without a
reference, and gives each operation with the parameters, servers, and
security that apply to it. `readExpression`, `readTemplate`, and
`evaluateExpression` read the runtime expressions and the templates
that a description holds in its strings.

## Install

```bash
npm install @tabnas/openapi @tabnas/parser @tabnas/jsonic @tabnas/yaml @tabnas/json @tabnas/expr
```

`@tabnas/parser`, `@tabnas/jsonic`, `@tabnas/yaml`, `@tabnas/json`, and
`@tabnas/expr` are peer dependencies. Node.js 24 or later.

## One example

```js
const { parse, version } = require('@tabnas/openapi')

parse('openapi: 3.1.0\npaths: {}') // => { openapi: '3.1.0', paths: {} }
parse('{"openapi":"3.1.0","paths":{}}') // => { openapi: '3.1.0', paths: {} }
parse("$ref: '#/components/schemas/Pet'") // => { $ref: '#/components/schemas/Pet' }
version(parse('swagger: "2.0"')).version // => '2.0'
```

YAML and JSON, one function, and the reference kept as written.
`parse(text, { strict: true })` reads JSON alone, by RFC 8259, and
requires a known version.

## Documentation

- [Tutorial](doc/tutorial.md): read a description in both formats.
- [How-to guide](doc/guide.md): files and bytes, strict JSON, the
  specification's reading, versions, your own parser, the limits on
  what is read, resolving and writing out a description, the names it
  uses, its operations, runtime expressions, error codes.
- [Reference](doc/reference.md): every export, the tree, the errors.
- [Concepts](doc/concepts.md): why one parser, why the raw tree comes
  first, the two readings, and what resolution makes of references,
  cycles, and names.

## License

MIT.
