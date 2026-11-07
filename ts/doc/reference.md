# Reference

The exports of `@tabnas/openapi`, the tree a parse returns, and the
errors it raises. The [concepts](concepts.md) page explains the design
behind them.

## Exports

```ts
import { make, OpenApi, VERSION } from '@tabnas/openapi'
import type { MakeOptions, OpenApiOptions } from '@tabnas/openapi'
```

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
parses.

### `OpenApi`

```ts
const OpenApi: Plugin

type OpenApiOptions = Record<string, never>
```

The plugin. Install it after the base grammar, with `tn.use(OpenApi)`.
It takes no options; `OpenApi.defaults` is `{}`. In this release it adds
no grammar and changes no parse result.

### `VERSION`

```ts
const VERSION: string
```

The package version, equal to the `version` in `package.json`.

## The tree

A parse returns the document as written, with nothing followed or
checked:

| In the document | In the tree |
|---|---|
| a YAML mapping or JSON object | a plain object, members in document order |
| a YAML sequence or JSON array | an array |
| a JSON number, or a YAML scalar that reads as a number | a `number` |
| `true`, `false` | a `boolean` |
| `null`, or an empty YAML value | `null` |
| any other scalar | a `string` |
| `$ref` and every other member | kept as written |

These hold for both base grammars, with one exception: only the default
parser reads YAML.

YAML rules that decide a value's type:

| Written | Read as |
|---|---|
| `openapi: 3.1` | the number `3.1` |
| `openapi: 3.1.0` | the string `'3.1.0'` |
| `swagger: 2.0` | the number `2` |
| `swagger: '2.0'` | the string `'2.0'` |
| `$ref: #/a` | `null`: the `#` after a space starts a comment |
| `$ref: '#/a'` | the string `'#/a'` |

## What this release does not do

- It does not check that the root is an OpenAPI or Swagger document, or
  that the version field names a version it supports.
- It does not resolve `$ref`. The tree holds each reference as written.

## Errors

A failed parse throws an error whose `code` names the failure. The codes
are the engine's:

| Code | Raised when |
|---|---|
| `unexpected` | the text has a token the grammar does not allow there: under `strict`, YAML, a comment, or a trailing comma |
| `unterminated_string` | under `strict`, a string has no closing quote |
| `invalid_unicode` | under `strict`, a `\u` escape is malformed |
| `unterminated_comment` | a block comment has no end |

The default parser is lenient: it reads some text that the strict parser
refuses, and raises fewer of these codes. The message is for people, and
its wording can change between releases. Test the code.
