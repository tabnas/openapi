# @tabnas/openapi

A [Tabnas](https://github.com/tabnas/parser) plugin that reads
[OpenAPI](https://spec.openapis.org/oas/latest.html) and Swagger
descriptions, in YAML or in JSON, with one parser for both.

This release returns the raw tree: the document as written, with every
`$ref` kept as a reference. It does not yet check the document or resolve
its references.

## Install

```bash
npm install @tabnas/openapi @tabnas/parser @tabnas/jsonic @tabnas/yaml @tabnas/json
```

`@tabnas/parser`, `@tabnas/jsonic`, `@tabnas/yaml` and `@tabnas/json` are
peer dependencies. Node.js 24 or later.

## One example

```js
const { make } = require('@tabnas/openapi')

const parser = make()

parser.parse('openapi: 3.1.0\npaths: {}') // => { openapi: '3.1.0', paths: {} }
parser.parse('{"openapi":"3.1.0","paths":{}}') // => { openapi: '3.1.0', paths: {} }
parser.parse("$ref: '#/components/schemas/Pet'") // => { $ref: '#/components/schemas/Pet' }
```

YAML and JSON, one parser, and the reference kept as written.
`make({ strict: true })` reads JSON alone, by RFC 8259.

## Documentation

- [Tutorial](doc/tutorial.md): read a description in both formats.
- [How-to guide](doc/guide.md): files, strict JSON, your own parser,
  error codes.
- [Reference](doc/reference.md): every export, the tree, the errors.
- [Concepts](doc/concepts.md): why one parser, and why the raw tree
  comes first.

## License

MIT.
