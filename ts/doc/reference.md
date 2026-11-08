# Reference

The exports of `@tabnas/openapi`, the tree a parse returns, and the
errors it raises. The [concepts](concepts.md) page explains the design
behind them.

## Exports

```ts
import { parse, version, make, OpenApi, VERSION } from '@tabnas/openapi'
import type { ParseOptions, VersionInfo, MakeOptions, OpenApiOptions } from '@tabnas/openapi'
```

### `parse(text, options?)`

```ts
function parse(text: string, options?: ParseOptions): any

type ParseOptions = {
  strict?: boolean          // default false
  fast?: boolean | 'auto'   // default 'auto'
  instance?: Tabnas         // default: a shared parser per `strict`
}
```

Reads a description and returns its raw tree. It refuses:

| Code | When |
|---|---|
| `openapi_root` | the root of the document is not a map |
| `openapi_stream` | the text is a YAML stream of more than one document |
| `openapi_version` | under `strict`, the root names no version this package reads |
| `openapi_duplicate_key` | under `strict`, a map holds one member name twice |

`strict` reads JSON alone, by RFC 8259, and adds the last two checks.

`fast` decides whether JSON text is read with `JSON.parse` before the
grammar:

| `fast` | Takes the fast path |
|---|---|
| `'auto'` | when the text opens with `{`, after JSON whitespace |
| `true` | always |
| `false` | never |

When `JSON.parse` refuses the text, or its root is not a map, the
grammar reads the text instead, so every error comes from the grammar.
Under `strict` the grammar always reads it. Both paths give the same
tree.

`instance` must be a parser from `make`, or one with the plugin
installed; `parse` throws an `Error` otherwise. It throws a `TypeError`
when `text` is not a string.

### `version(tree)`

```ts
function version(tree: unknown): VersionInfo

type VersionInfo = {
  version: '2.0' | '3.0' | '3.1' | '3.2' | 'unknown'
  field: 'openapi' | 'swagger' | null
  value: unknown
}
```

Reads the version a tree's root names. `openapi` is read before
`swagger`, and either may be a string or a number:

| Member | Read as |
|---|---|
| `openapi: "3.1.0"`, `"3.1.2"`, `"3.1.0-rc1"` | `'3.1'` |
| `openapi: 3.1` | `'3.1'` |
| `openapi: 3.0`, `3` | `'3.0'` |
| `openapi: "3.0.3"` | `'3.0'` |
| `openapi: "3.2.0"`, `3.2` | `'3.2'` |
| `swagger: "2.0"`, `2.0`, `2` | `'2.0'` |
| anything else, or neither member | `'unknown'` |

`field` names the member read, and `value` is its value as written.

### `make(options?)`

```ts
function make(options?: MakeOptions): Tabnas

type MakeOptions = {
  strict?: boolean // default false
}
```

Returns a new parser with the plugin installed:

| `strict` | Base grammar | Reads |
|---|---|---|
| `false` | `jsonic`, then `Yaml` | YAML, and JSON text |
| `true` | `json` | JSON text by RFC 8259 |

Every call builds a new parser. A parser can be reused for any number of
parses. Its own `parse` method reads the text with the grammar alone and
raises none of the plugin's codes: a stream comes back as an array of
documents, and a root that is not a map comes back as it is.

### `OpenApi`

```ts
const OpenApi: Plugin

type OpenApiOptions = Record<string, never>
```

The plugin. Install it after the base grammar, with `tn.use(OpenApi)`.
It takes no options; `OpenApi.defaults` is `{}`. It adds no rule. It
declares the four error codes `parse` raises, makes a repeated member
name keep its last value, and runs the checks when `parse` asks for
them.

### `VERSION`

```ts
const VERSION: string
```

The package version, equal to the `version` in `package.json`.

## The tree

A parse returns the document as written, with nothing followed:

| In the document | In the tree |
|---|---|
| a YAML mapping or JSON object | an object with no prototype, members in document order |
| a YAML sequence or JSON array | an array |
| a JSON number, or a YAML scalar that reads as a number | a `number` |
| `true`, `false` | a `boolean` |
| `null`, or an empty YAML value | `null` |
| any other scalar | a `string` |
| `$ref` and every other member | kept as written |

A member named `__proto__` is an ordinary member. A member name that
appears twice in one map keeps its last value, whole, at the place of its
first appearance, as `JSON.parse` keeps it. These hold for both paths and
both base grammars, with one exception: only the default parser reads
YAML.

YAML rules that decide a value's type:

| Written | Read as |
|---|---|
| `openapi: 3.1` | the number `3.1` |
| `openapi: 3.1.0` | the string `'3.1.0'` |
| `swagger: 2.0` | the number `2` |
| `swagger: '2.0'` | the string `'2.0'` |
| `$ref: #/a` | `null`: the `#` after a space starts a comment |
| `$ref: '#/a'` | the string `'#/a'` |
| `yes`, `on`, `no`, `off` | `true`, `true`, `false`, `false` |
| `.inf`, `-.inf`, `.nan` | `Infinity`, `-Infinity`, `NaN` |

## What this release does not do

It does not resolve `$ref`. The tree holds each reference as written.

## Errors

A failed parse throws a `TabnasError`. Its `code` names the failure,
and its `toJSON()` gives the row and column, counting from 1. The
plugin's codes are in the table under `parse`. The engine's are these:

| Code | Raised when |
|---|---|
| `unexpected` | the text has a token the grammar does not allow there: under `strict`, YAML, a comment, or a trailing comma |
| `unterminated_string` | under `strict`, a string has no closing quote |
| `invalid_unicode` | under `strict`, a `\u` escape is malformed |
| `unterminated_comment` | a block comment has no end |

`openapi_stream` is placed at the start of the second document,
`openapi_duplicate_key` at the repeated name, and the others at the start
of the document. A member name a message quotes is JSON-quoted and cut
short. The default parser is lenient: it reads some text that the strict
parser refuses, and raises fewer of the engine's codes. The message is
for people, and its wording can change between releases. Test the code.
