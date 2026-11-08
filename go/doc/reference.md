# Go reference

The exports of `github.com/tabnas/openapi/go`, package `tabnasopenapi`,
the tree a parse returns, and the errors it raises. The
[concepts](concepts.md) page explains the design behind them. `tabnas`
below is the engine, `github.com/tabnas/parser/go`.

## Exports

### `Parse`

```go
func Parse(text string, opts ...ParseOptions) (any, error)

type ParseOptions struct {
	Strict   bool           // default false
	Fast     Fast           // default FastAuto
	Instance *tabnas.Tabnas // default: a shared parser per Strict
}
```

Reads a description and returns its raw tree. Only the first
`ParseOptions` is read. It refuses:

| Code | When |
|---|---|
| `openapi_root` | the root of the document is not a map |
| `openapi_stream` | the text is a YAML stream of more than one document |
| `openapi_version` | under `Strict`, the root names no version this package reads |
| `openapi_duplicate_key` | under `Strict`, a map holds one member name twice |

`Strict` reads JSON alone, by RFC 8259, and adds the last two checks.
`Instance` must have the plugin installed; `Parse` returns an error
otherwise. `Parse` is safe for concurrent use, except that a given
`Instance` must not run two parses at once.

### `Fast`

```go
type Fast int

const (
	FastAuto Fast = iota
	FastOn
	FastOff
)
```

Decides whether JSON text is read with `encoding/json` before the
grammar:

| `Fast` | Takes the fast path |
|---|---|
| `FastAuto` | when the text opens with `{`, after JSON whitespace |
| `FastOn` | always |
| `FastOff` | never |

When `encoding/json` refuses the text, its root is not a map, or the
text is not UTF-8, the grammar reads the text instead, so every error
comes from the grammar. Under `Strict` the grammar always reads it. Both
paths give the same tree.

### `Version`

```go
func Version(tree any) VersionInfo

type VersionInfo struct {
	Version string // "2.0", "3.0", "3.1", "3.2" or "unknown"
	Field   string // "openapi", "swagger" or ""
	Value   any    // that member's value, as written
}
```

Reads the version a tree's root names. `openapi` is read before
`swagger`, and either may be a string or a number:

| Member | Read as |
|---|---|
| `openapi: "3.1.0"`, `"3.1.2"`, `"3.1.0-rc1"` | `"3.1"` |
| `openapi: 3.1` | `"3.1"` |
| `openapi: 3.0`, `3` | `"3.0"` |
| `openapi: "3.0.3"` | `"3.0"` |
| `openapi: "3.2.0"`, `3.2` | `"3.2"` |
| `swagger: "2.0"`, `2.0`, `2` | `"2.0"` |
| anything else, or neither member | `"unknown"` |

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
cause. A parser can be reused for any number of parses, one at a time:
the yaml grammar keeps the state of a parse on the parser. Its own
`Parse` method reads the text with the grammar alone and returns none of
the plugin's codes.

### `OpenApi` and `Defaults`

```go
func OpenApi(j *tabnas.Tabnas, opts map[string]any) error

var Defaults = map[string]any{}
```

The plugin, with its option defaults. Install it after the base grammar,
with `j.UseDefaults(OpenApi, Defaults)`. It takes no options and adds no
rule. It declares the four error codes `Parse` returns, makes a repeated
member name keep its last value, and runs the checks when `Parse` asks
for them.

### `VERSION`

```go
const VERSION = "0.1.0"
```

The module version, equal to the TypeScript package's.

## The tree

`Parse` returns the document as written, with nothing followed:

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
back in document order. A member name that appears twice in one map
keeps its last value, whole, at the place of its first appearance.

YAML rules that decide a value's type:

| Written | Read as |
|---|---|
| `openapi: 3.1` | the number `3.1` |
| `openapi: 3.1.0` | the string `"3.1.0"` |
| `swagger: 2.0` | the number `2` |
| `swagger: '2.0'` | the string `"2.0"` |
| `$ref: #/a` | `nil`: the `#` after a space starts a comment |
| `$ref: '#/a'` | the string `"#/a"` |
| `yes`, `on`, `no`, `off` | `true`, `true`, `false`, `false` |

## What this release does not do

It does not resolve `$ref`. The tree holds each reference as written.

## Errors

A failed parse returns a `*tabnas.TabnasError`. `Code` names the
failure, and `Row` and `Col` give its position, counting from 1. The
plugin's codes are in the table under `Parse`. The engine's are these:

| Code | Returned when |
|---|---|
| `unexpected` | the text has a token the grammar does not allow there: under `Strict`, YAML, a comment, or a trailing comma |
| `unterminated_string` | under `Strict`, a string has no closing quote |
| `invalid_unicode` | under `Strict`, a `\u` escape is malformed |
| `unterminated_comment` | a block comment has no end |

`openapi_stream` is placed at the start of the second document,
`openapi_duplicate_key` at the repeated name, and the others at the start
of the document. A member name a message quotes is JSON-quoted and cut
short. The default parser is lenient: it reads some text that the strict
parser refuses, and returns fewer of the engine's codes. The message is
for people, and its wording can change between releases. Test the code.
