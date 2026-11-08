# @tabnas/openapi

A [Tabnas](https://github.com/tabnas/parser) plugin that reads
[OpenAPI](https://spec.openapis.org/oas/latest.html) and Swagger
descriptions, in YAML or in JSON, with one parser for both.

This release returns the raw tree: the document as written, with every
`$ref` kept as a reference, after checking that it is one description
with a map at its root. It does not resolve references yet.

## Install

```bash
npm install @tabnas/openapi @tabnas/parser @tabnas/jsonic @tabnas/yaml @tabnas/json
```

`@tabnas/parser`, `@tabnas/jsonic`, `@tabnas/yaml` and `@tabnas/json` are
peer dependencies. Node.js 24 or later.

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
- [How-to guide](doc/guide.md): files, strict JSON, versions, your own
  parser, error codes.
- [Reference](doc/reference.md): every export, the tree, the errors.
- [Concepts](doc/concepts.md): why one parser, and why the raw tree
  comes first.

## License

MIT.
