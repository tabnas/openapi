# @tabnas/openapi

<!-- tabnas-badges -->
[![npm](https://tabnas.github.io/status/badges/openapi-npm.svg)](https://www.npmjs.com/package/@tabnas/openapi)
[![CI](https://github.com/tabnas/openapi/actions/workflows/ci.yml/badge.svg)](https://github.com/tabnas/openapi/actions/workflows/ci.yml)
[![go](https://tabnas.github.io/status/badges/openapi-go.svg)](https://pkg.go.dev/github.com/tabnas/openapi/go)
[![tabnas standard](https://tabnas.github.io/status/badges/openapi-standard.svg)](https://tabnas.github.io/status/)
<!-- /tabnas-badges -->

A plugin that teaches the [Tabnas](https://github.com/tabnas/parser)
parser to read [OpenAPI](https://spec.openapis.org/oas/latest.html) and
Swagger descriptions, in YAML or in JSON, with one parser for both.
Available for TypeScript, Go and Rust, with the same tree from the same
text in all three.

This is an early release. `parse` reads a description and returns the
raw tree: the document as written, with every `$ref` kept as a
reference, after checking that the text is one description with a map
at its root. `resolve` builds a new tree with the references within the
document resolved; it does not load other documents yet.

## Install

```bash
# TypeScript / JavaScript
npm install @tabnas/openapi @tabnas/parser @tabnas/jsonic @tabnas/yaml @tabnas/json

# Go
go get github.com/tabnas/openapi/go@latest
```

The Rust crate, `tabnas-openapi` in [`rs/`](rs/), takes its tabnas crates
from sibling checkouts; [`rs/README.md`](rs/README.md) has the setup.

## One example

```js
const { parse } = require('@tabnas/openapi')

const doc = parse(`
openapi: 3.1.0
info: { title: Pets, version: "1" }
paths:
  /pets:
    get:
      parameters:
        - $ref: '#/components/parameters/Limit'
`)

doc.info.title // => 'Pets'
doc.paths['/pets'].get.parameters // => [{ $ref: '#/components/parameters/Limit' }]

parse('{"openapi":"3.1.0","paths":{}}') // => { openapi: '3.1.0', paths: {} }
```

`parse` read YAML and then JSON, without being told which.
`parse(text, { strict: true })` reads JSON alone, by RFC 8259.

## Documentation

| | TypeScript | Go | Rust |
|---|---|---|---|
| Tutorial | [ts/doc/tutorial.md](ts/doc/tutorial.md) | [go/doc/tutorial.md](go/doc/tutorial.md) | [rs/README.md](rs/README.md) |
| How-to guide | [ts/doc/guide.md](ts/doc/guide.md) | [go/doc/guide.md](go/doc/guide.md) | |
| Reference | [ts/doc/reference.md](ts/doc/reference.md) | [go/doc/reference.md](go/doc/reference.md) | |
| Concepts | [ts/doc/concepts.md](ts/doc/concepts.md) | [go/doc/concepts.md](go/doc/concepts.md) | |

TypeScript is canonical. The shared fixtures in [`test/spec/`](test/spec/)
run in all three runtimes and are the parity contract between them.

## Contributing

Read [AGENTS.md](AGENTS.md) first. It has the layout, the commands
that build and test each runtime, and the rules every change follows.
The design and the plan for what comes next, resolution included, are
in [`docs/design/`](docs/design/).

## License

MIT. See [LICENSE](LICENSE).
