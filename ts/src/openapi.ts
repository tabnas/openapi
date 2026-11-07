/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// @tabnas/openapi: OpenAPI and Swagger documents, in JSON or YAML, for the
// tabnas engine.
//
// The plugin installs on a jsonic instance that carries the yaml grammar,
// so one parser reads both serialisations, or, with `strict`, on the
// strict json grammar alone. Raw mode, the document exactly as written, is
// the engine's own parse; `parse` adds the checks the engine cannot make
// (the root, a stream of several documents, and under `strict` the version
// and repeated member names) and a fast path for JSON text. Resolution, a
// derived tree with `$ref` resolved, is an OpenAPI vocabulary over
// @tabnas/expr's fold. The plan is docs/design/implementation-plan.md.

import { Tabnas, TabnasError, Plugin } from '@tabnas/parser'
import type { Context, Rule, RuleDone } from '@tabnas/parser'
import { jsonic } from '@tabnas/jsonic'
import { Yaml } from '@tabnas/yaml'
import { json } from '@tabnas/json'

// Plugin options. There are none: raw mode needs none, and the resolver's
// options belong to `resolve`, since `use()` deep-copies what it is given.
type OpenApiOptions = Record<string, never>

// The error codes the plugin raises, with their messages and hints. A
// placeholder in braces is filled from the error's details. Member names
// in a message are document content, so they arrive JSON-quoted and cut
// short (see `quoted`).
const ERRORS: Record<string, string> = {
  openapi_root:
    'the document is {kind} at its root, where an OpenAPI description is a map',
  openapi_stream:
    'the text holds more than one YAML document, where a description is one',
  openapi_version:
    'the root names no OpenAPI or Swagger version this package reads ({found})',
  openapi_duplicate_key: 'the member name {key} appears twice in one map',
}

const HINTS: Record<string, string> = {
  openapi_root:
    'Put the members of the description, such as openapi, info and paths, ' +
    'at the top level of the document.',
  openapi_stream:
    'Split the stream at each --- line and parse each document on its own.',
  openapi_version:
    'Set openapi to a 3.0, 3.1 or 3.2 version string, such as "3.1.0", ' +
    'or swagger to "2.0".',
  openapi_duplicate_key:
    'Remove or rename one of the two members. JSON readers disagree on ' +
    'which of them to keep.',
}

// The per-parse state `parse` hands the plugin through the engine's parse
// metadata. A parse without it, `tn.parse(text)`, is the engine's own and
// the plugin raises nothing in it.
type ParseState = {
  strict: boolean
  // The text was empty. The engine returns at once for an empty text and
  // runs no rule, so `parse` hands it a single line break instead, which
  // reads to an empty document, and this says what the reader wrote.
  empty: boolean
  docs: number
}

// The instances the plugin is installed on.
const INSTALLED = new WeakSet<Tabnas>()

// The plugin. It installs after the base grammar, adds no rule, and
// records nothing on the parsed tree. It declares its error codes, makes
// a repeated member name keep its last value, as JSON.parse does, and
// subscribes to rule completion for the checks `parse` asks for.
const OpenApi: Plugin = function OpenApi(tn: Tabnas, _options: OpenApiOptions) {
  // Once per instance: a second subscriber would count every YAML
  // document twice and refuse a single document as a stream.
  if (INSTALLED.has(tn)) {
    return
  }
  INSTALLED.add(tn)
  tn.options({
    error: ERRORS,
    hint: HINTS,
    map: {
      // The last value of a repeated name wins, whole: the base grammars
      // would otherwise merge two maps given under one name.
      merge: (_prev: any, curr: any) => curr,
    },
  })
  tn.sub({ ruleDone: check })
}

OpenApi.defaults = {} as OpenApiOptions

// The checks, on each rule pass. They run only in a parse `parse` made.
function check(rule: Rule, ctx: Context, done: RuleDone): void {
  const state: ParseState | undefined = ctx.meta?.openapi
  if (null == state || done.probe || done.forced) {
    return
  }

  // Each document of a YAML stream is a `val` the `stream` rule pushes.
  // The second one is refused where it starts.
  if (
    'stream' === rule.name &&
    'o' === done.state &&
    'val' === done.alt?.p
  ) {
    state.docs++
    if (1 < state.docs) {
      throw new TabnasError('openapi_stream', {}, token(rule, ctx), rule, ctx)
    }
    return
  }

  // A repeated member name, under strict. The open pass of a pair has read
  // its key and not yet set its value, so the key is already in the map
  // only when it is repeated.
  if (
    state.strict &&
    'pair' === rule.name &&
    'o' === done.state &&
    null != rule.node &&
    'object' === typeof rule.node &&
    'string' === typeof rule.u.key &&
    Object.prototype.hasOwnProperty.call(rule.node, rule.u.key)
  ) {
    throw new TabnasError(
      'openapi_duplicate_key',
      { key: quoted(rule.u.key) },
      token(rule, ctx),
      rule,
      ctx,
    )
  }

  // The root, once the root rule has closed for the last time.
  if (
    0 === rule.d &&
    'c' === done.state &&
    (null == done.alt || ('' === done.alt.p && '' === done.alt.r && null == done.alt.err))
  ) {
    const root = ctx.root()
    const value = root.node
    const at = root.o0 && '#ZZ' !== root.o0.name ? root.o0 : token(rule, ctx)
    if (!isMap(value)) {
      throw new TabnasError(
        'openapi_root',
        { kind: state.empty ? 'empty' : kindOf(value) },
        at,
        rule,
        ctx,
      )
    }
    if (state.strict) {
      const found = version(value)
      if ('unknown' === found.version) {
        throw new TabnasError(
          'openapi_version',
          {
            found:
              null == found.field
                ? 'no openapi or swagger member'
                : found.field + ' is ' + quoted(found.value),
          },
          at,
          rule,
          ctx,
        )
      }
    }
  }
}

// The token to place an error at: the one the rule opened on, else the
// one in hand.
function token(rule: Rule, ctx: Context) {
  return null != rule.o0 && '#ZZ' !== rule.o0.name ? rule.o0 : ctx.t0
}

// Document content in a message: JSON-quoted, so a control character or a
// quote cannot reshape the message, and cut short.
function quoted(value: unknown): string {
  let text: string
  try {
    text = JSON.stringify(value) ?? String(value)
  } catch {
    text = String(value)
  }
  return 60 < text.length ? text.slice(0, 57) + '...' : text
}

function isMap(value: unknown): value is Record<string, unknown> {
  return null != value && 'object' === typeof value && !Array.isArray(value)
}

function kindOf(value: unknown): string {
  if (undefined === value) return 'empty'
  if (null === value) return 'null'
  if (Array.isArray(value)) return 'a list'
  if ('string' === typeof value) return 'a string'
  if ('number' === typeof value) return 'a number'
  if ('boolean' === typeof value) return 'a Boolean'
  return 'a ' + typeof value
}

// The OpenAPI or Swagger version a tree's root names.
type VersionInfo = {
  // The version, to its minor: '2.0' for Swagger, '3.0', '3.1' or '3.2'
  // for OpenAPI, and 'unknown' for anything else.
  version: '2.0' | '3.0' | '3.1' | '3.2' | 'unknown'
  // The member the version came from, `openapi` taking precedence, or
  // null when the root has neither.
  field: 'openapi' | 'swagger' | null
  // That member's value, as written.
  value: unknown
}

const OPENAPI_VERSION = /^3\.([0-2])(?:\.\d+)?(?:[-+][0-9A-Za-z.-]*)?$/
const SWAGGER_VERSION = /^2\.0(?:\.\d+)?$/

// Read the version from a tree's root, leniently: a string or a number, as
// YAML may have read an unquoted `3.1` or `2.0`.
function version(tree: unknown): VersionInfo {
  if (!isMap(tree)) {
    return { version: 'unknown', field: null, value: undefined }
  }
  const own = (name: string) => Object.prototype.hasOwnProperty.call(tree, name)
  if (own('openapi')) {
    const value = tree.openapi
    let minor: string | null = null
    if ('string' === typeof value) {
      const m = OPENAPI_VERSION.exec(value)
      minor = null == m ? null : m[1]
    } else if (3 === value) {
      minor = '0'
    } else if (3.1 === value) {
      minor = '1'
    } else if (3.2 === value) {
      minor = '2'
    }
    return {
      version: null == minor ? 'unknown' : (('3.' + minor) as VersionInfo['version']),
      field: 'openapi',
      value,
    }
  }
  if (own('swagger')) {
    const value = tree.swagger
    const known =
      ('string' === typeof value && SWAGGER_VERSION.test(value)) || 2 === value
    return { version: known ? '2.0' : 'unknown', field: 'swagger', value }
  }
  return { version: 'unknown', field: null, value: undefined }
}

// Options for `make`.
type MakeOptions = {
  // Read strict JSON (RFC 8259) with the json grammar alone, instead of
  // JSON and YAML with jsonic and the yaml grammar.
  strict?: boolean
}

// A parser instance with the plugin installed: jsonic with the yaml
// grammar, which reads JSON text as the strict json grammar does and YAML
// besides, or, with `strict`, json alone.
function make(options: MakeOptions = {}): Tabnas {
  const tn = true === options.strict
    ? new Tabnas().use(json)
    : new Tabnas().use(jsonic).use(Yaml)
  return tn.use(OpenApi)
}

// Options for `parse`.
type ParseOptions = {
  // Read strict JSON alone, and refuse an unknown version and a repeated
  // member name. Default false.
  strict?: boolean

  // Read JSON text with JSON.parse rather than the grammar, falling back
  // to the grammar when JSON.parse refuses the text or its root is not a
  // map, so every error still comes from the grammar. 'auto', the
  // default, takes the fast path when the text opens with `{`; true takes
  // it whatever the text opens with; false never takes it. Under `strict`
  // the grammar always runs.
  fast?: boolean | 'auto'

  // The parser to use, from `make`. Default: one shared parser per
  // setting of `strict`.
  instance?: Tabnas
}

const shared: { loose?: Tabnas; strict?: Tabnas } = {}

// Parse a description and return its raw tree: the document as written,
// every `$ref` kept as a reference. Raises `openapi_root` when the root is
// not a map and `openapi_stream` for a stream of several YAML documents;
// under `strict`, also `openapi_version` and `openapi_duplicate_key`.
function parse(text: string, options: ParseOptions = {}): any {
  if ('string' !== typeof text) {
    throw new TypeError('parse: the text must be a string')
  }
  const strict = true === options.strict
  const tn =
    options.instance ??
    (strict
      ? (shared.strict ??= make({ strict: true }))
      : (shared.loose ??= make()))
  if (!tn.internal().plugins.includes(OpenApi)) {
    throw new Error('parse: the instance has no OpenApi plugin; build it with make()')
  }

  const fast = options.fast ?? 'auto'
  if (!strict && false !== fast && (true === fast || OPENS_WITH_BRACE.test(text))) {
    const value = fastParse(text)
    if (undefined !== value) {
      return value
    }
  }

  // Strict JSON refuses an empty text itself, as `unexpected`.
  const empty = '' === text && !strict
  const state: ParseState = { strict, empty, docs: 0 }
  return tn.parse(empty ? '\n' : text, { openapi: state })
}

const OPENS_WITH_BRACE = /^[ \t\n\r]*\{/

// The fast path: JSON.parse, with every map rebuilt without a prototype,
// as the grammar builds them, so a member named `__proto__` is data on
// both paths. Returns undefined when the grammar must decide instead.
function fastParse(text: string): any {
  let value: any
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isMap(value)) {
    return undefined
  }
  return nullPrototypes(value)
}

// Rebuild every map of a JSON.parse tree without a prototype, in place for
// lists. Iterative, so a deep document cannot exhaust the stack here.
function nullPrototypes(root: any): any {
  const copy = (map: Record<string, any>) => {
    const out: Record<string, any> = Object.create(null)
    for (const name of Object.keys(map)) {
      // Without a prototype there is no `__proto__` setter to call, so
      // this defines a member, whatever its name.
      out[name] = map[name]
    }
    return out
  }
  const top = copy(root)
  const stack: any[] = [top]
  while (0 < stack.length) {
    const node = stack.pop()
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const item = node[i]
        if (null != item && 'object' === typeof item) {
          node[i] = Array.isArray(item) ? item : copy(item)
          stack.push(node[i])
        }
      }
    } else {
      for (const name of Object.keys(node)) {
        const item = node[name]
        if (null != item && 'object' === typeof item) {
          node[name] = Array.isArray(item) ? item : copy(item)
          stack.push(node[name])
        }
      }
    }
  }
  return top
}

// VERSION is this package's version. It MUST equal package.json "version":
// the release orchestrator rewrites both, and the version test fails the
// build if they drift. Mirrors `const VERSION` in go/openapi.go and
// `VERSION` in rs/src/lib.rs.
const VERSION = '0.1.0'

export { OpenApi, make, parse, version, VERSION }

export type { OpenApiOptions, MakeOptions, ParseOptions, VersionInfo }
