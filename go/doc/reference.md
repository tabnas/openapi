# Go reference

The exports of `github.com/tabnas/openapi/go`, package `tabnasopenapi`,
the tree a parse returns, and the errors it raises. The
[concepts](concepts.md) page explains the design behind them. `tabnas`
below is the engine, `github.com/tabnas/parser/go`.

## Exports

### `Make`

```go
func Make(opts ...MakeOptions) *tabnas.Tabnas

type MakeOptions struct {
	Strict bool // default false
}
```

Returns a new parser with the plugin installed. Only the first
`MakeOptions` is read.

| `Strict` | Base grammar | Reads |
|---|---|---|
| `false` | jsonic, then yaml | YAML, and JSON text |
| `true` | json | JSON text by RFC 8259 |

`Make` panics only if a grammar fails to install, which no input can
cause. A parser can be reused for any number of parses, including
concurrent ones.

### `OpenApi` and `Defaults`

```go
func OpenApi(j *tabnas.Tabnas, opts map[string]any) error

var Defaults = map[string]any{}
```

The plugin, with its option defaults. Install it after the base grammar,
with `j.UseDefaults(OpenApi, Defaults)`. It takes no options. In this
release it adds no grammar and changes no parse result.

### `VERSION`

```go
const VERSION = "0.1.0"
```

The module version, equal to the TypeScript package's.

## The tree

`Parse` returns the document as written, with nothing followed or
checked:

| In the document | In the tree |
|---|---|
| a YAML mapping or JSON object | `*tabnas.OrderedMap`, members in document order |
| a YAML sequence or JSON array | `[]any` |
| a JSON number, or a YAML scalar that reads as a number | `float64` |
| `true`, `false` | `bool` |
| `null`, or an empty YAML value | `nil` |
| any other scalar | `string` |
| `$ref` and every other member | kept as written |

An `OrderedMap` holds its member names in `Keys`, in document order, and
its values in `Vals`; `Get(name)` reads one. `json.Marshal` writes it
back in document order.

YAML rules that decide a value's type:

| Written | Read as |
|---|---|
| `openapi: 3.1` | the number `3.1` |
| `openapi: 3.1.0` | the string `"3.1.0"` |
| `swagger: 2.0` | the number `2` |
| `swagger: '2.0'` | the string `"2.0"` |
| `$ref: #/a` | `nil`: the `#` after a space starts a comment |
| `$ref: '#/a'` | the string `"#/a"` |

## What this release does not do

- It does not check that the root is an OpenAPI or Swagger document, or
  that the version field names a version it supports.
- It does not resolve `$ref`. The tree holds each reference as written.

## Errors

A failed parse returns a `*tabnas.TabnasError`. `Code` names the
failure, and `Row` and `Col` give its position, counting from 1. The
codes are the engine's:

| Code | Returned when |
|---|---|
| `unexpected` | the text has a token the grammar does not allow there: under `Strict`, YAML, a comment, or a trailing comma |
| `unterminated_string` | under `Strict`, a string has no closing quote |
| `invalid_unicode` | under `Strict`, a `\u` escape is malformed |
| `unterminated_comment` | a block comment has no end |

The default parser is lenient: it reads some text that the strict parser
refuses, and returns fewer of these codes. The message is for people,
and its wording can change between releases. Test the code.
