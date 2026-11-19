/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// @tabnas/openapi: OpenAPI and Swagger documents, in JSON or YAML, for the
// tabnas engine.
//
// The plugin installs on a jsonic instance that carries the yaml grammar,
// so one parser reads both serialisations, or, with `strict`, on the
// strict json grammar alone. Raw mode, the document exactly as written, is
// the engine's own parse; `parse` adds the checks the engine cannot make
// (the root, a stream of several documents, and under `strict` the version
// and repeated member names), the choice of what a repeated member name
// gives, the choice of reading (the base grammars' own, or the
// specification's), and a fast path for JSON text. Resolution, a derived tree with
// `$ref` resolved, is an OpenAPI vocabulary over @tabnas/expr's fold. The
// plans are docs/design/implementation-plan.md and, for what remains,
// docs/design/typescript-plan.md.

import { Tabnas, TabnasError, Plugin } from '@tabnas/parser'
import type { Context, Rule, RuleDone } from '@tabnas/parser'
import { jsonic } from '@tabnas/jsonic'
import { Yaml } from '@tabnas/yaml'
import { json } from '@tabnas/json'

import { readsCoreSchema } from './core-schema'
import { version } from './oas-version'
import type { VersionInfo } from './oas-version'
import { isLossy, located, lossyInJson } from './lossy'
import type { Lossy, LossyFound } from './lossy'
import { decode, hasContent, utf8Length } from './text'
import { wellFormed } from './well-formed'
import type { WellFormedOptions } from './well-formed'
import { aliasedBytes, aliasedSize, defaultAliasBudget, weigh } from './yaml-alias'

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
  openapi_alias_budget:
    'the YAML aliases of the text would copy it out to about {size} bytes, ' +
    'past the budget of {budget}',
  openapi_size:
    'the text is {size} bytes, and the grammar is given at most {limit}',
  openapi_work:
    'the text takes more than {steps} steps to read, the most the grammar ' +
    'is given under a limit of {limit} bytes',
  openapi_encoding: 'the bytes are not well-formed {encoding}',
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
  openapi_alias_budget:
    'An alias is read as a copy of the node its anchor labels, so aliases ' +
    'inside anchored nodes multiply. Write the repeated part out where ' +
    'it is used, or raise aliasBudget for a text you trust.',
  openapi_size:
    'Reading YAML takes about a hundred bytes of memory for each byte of ' +
    'the text. Raise maxBytes where the process has that much. JSON text ' +
    'that JSON.parse reads has no limit.',
  openapi_work:
    'The grammar keeps about a kilobyte for each step until it is done, ' +
    'and a text of very many small values takes a step or two for each ' +
    'of its bytes, where a description takes one for each ten. Raise ' +
    'maxBytes where the process has the memory.',
  openapi_encoding:
    'Save the description as UTF-8, or parse it without strict to have ' +
    'each ill-formed sequence read as U+FFFD.',
}

// The per-parse state `parse` hands the plugin through the engine's parse
// metadata. A parse without it, `tn.parse(text)`, is the engine's own and
// the plugin raises nothing in it.
type ParseState = {
  strict: boolean
  // What a repeated member name gives in this parse.
  duplicates: Duplicates
  // How the text is read: see `Reading`.
  reading: Reading
  // The text holds nothing but white space and YAML comments. Such a text
  // reads to an empty document, which the root check reports as empty.
  empty: boolean
  docs: number
  // A refusal decided from the text before the grammar ran. It is raised
  // on the first rule pass, where an error can carry its place.
  refuse?: { code: string; details: Record<string, unknown> }
  // The numbers the text wrote that the tree does not hold exactly, when
  // the parse was asked to report them.
  lossy?: LossyFound[]
  // The steps left for finding where those numbers are in the tree.
  placing: number
  // The work the grammar may still do for this text, in rule passes, with
  // what it was given and the size limit that gave it.
  work: { left: number; steps: number; limit: number }
  // The copies the grammar makes at aliases, counted as they are made:
  // how much they may come to, how much they have, the size of the text,
  // and the budget that the two together are held to.
  copies?: { allowed: number; made: number; bytes: number; budget: number }
}

// The instances the plugin is installed on.
const INSTALLED = new WeakSet<Tabnas>()

// The plugin. It installs after the base grammar, adds no rule, and
// records nothing on the parsed tree. It declares its error codes, decides
// what a repeated member name gives (its last value, as JSON.parse does,
// unless the parse asks for the base grammars' merge), and subscribes to
// rule completion for the checks `parse` asks for.
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
      // would otherwise merge two maps given under one name. A parse that
      // asks for that merge gets it, as the grammars themselves make it.
      merge: (prev: any, curr: any, _rule: Rule, ctx: Context) =>
        'merge' === ctx?.meta?.openapi?.duplicates ? mergeValues(prev, curr) : curr,
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

  // What `parse` decided from the text alone, before any of it is built.
  if (null != state.refuse) {
    const { code, details } = state.refuse
    state.refuse = undefined
    throw new TabnasError(code, details, token(rule, ctx), rule, ctx)
  }

  // The work the grammar may do for one text. The size limit alone does
  // not bound what a text costs: the grammar keeps about a kilobyte for
  // each rule pass until it is done, and a text of very many small values
  // takes a pass or two for each byte, where a description takes one for
  // each ten. So the passes are counted, and a text is stopped once it
  // has taken as many as a description at the size limit takes.
  if (--state.work.left < 0) {
    throw new TabnasError(
      'openapi_work',
      { steps: state.work.steps, limit: state.work.limit },
      token(rule, ctx),
      rule,
      ctx,
    )
  }

  // An alias, as its `val` closes on the copy the grammar made of its
  // anchor's node. The measure `parse` took of the text reads it as YAML
  // and nothing else, and a text can be written so that the grammar
  // reads copies out of it that the measure did not count: behind a
  // comment that only the base reading has, for one. So each copy is
  // counted again here, as it is made, and held to the same budget. The
  // count is from below (`weigh`), so it refuses nothing that the
  // measure, where it is right, allows.
  if (undefined !== state.copies && 'val' === rule.name && 'c' === done.state) {
    const tkn = rule.o0
    if (null != tkn && 'string' === typeof tkn.src && 0x2a === tkn.src.charCodeAt(0)) {
      const copies = state.copies
      copies.made += weigh(rule.node, copies.allowed - copies.made)
      if (copies.allowed < copies.made) {
        throw new TabnasError(
          'openapi_alias_budget',
          { size: copies.bytes + copies.made, budget: copies.budget },
          tkn,
          rule,
          ctx,
        )
      }
    }
  }

  // A number, as its `val` closes: the token it opened on has the text
  // the document wrote.
  if (
    null != state.lossy &&
    'val' === rule.name &&
    'c' === done.state &&
    'number' === typeof rule.node
  ) {
    const found = lossyOf(rule, ctx, state)
    if (null != found) state.lossy.push(found)
  }

  // Each document of a YAML stream is a `val` the `stream` rule pushes.
  // The second one is refused where it starts. Under the specification's
  // reading it is refused only once it is known to hold something.
  if (
    'stream' === rule.name &&
    'o' === done.state &&
    'val' === done.alt?.p
  ) {
    state.docs++
    if (1 < state.docs && 'spec' !== state.reading) {
      throw new TabnasError('openapi_stream', {}, token(rule, ctx), rule, ctx)
    }
    return
  }

  // A document after the first, under the specification's reading. Its
  // `val` opens on the first token of what it holds. An empty document
  // opens on the end of the text, or on the marker that ends it or starts
  // the next, and is passed over.
  if (
    'spec' === state.reading &&
    1 < state.docs &&
    'val' === rule.name &&
    'o' === done.state &&
    'stream' === rule.parent?.name
  ) {
    const first = rule.o0?.name
    if ('#ZZ' !== first && '#DS' !== first && '#DE' !== first) {
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
    // A stream of several documents comes back as their list. It gets
    // this far only where every document after the first is empty.
    const value = 1 < state.docs && Array.isArray(root.node) ? root.node[0] : root.node
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

// The number a closing `val` holds, if the tree does not hold what the
// document wrote: an integer written out in full that is not the number
// read, or a number written with digits that is too large to be read at
// all. An alias opens on the alias, not on a number, and is its anchor's
// to report.
function lossyOf(rule: Rule, ctx: Context, state: ParseState): LossyFound | undefined {
  const tkn = rule.o0
  const value = rule.node as number
  if (null == tkn || '#NR' !== tkn.name || 'string' !== typeof tkn.src) return undefined
  const text = tkn.src
  if (!isLossy(text, value)) return undefined

  // The members and indexes above it. A pair has its name by now, and a
  // list holds the items before this one, so its length is this one's
  // index. A rule this does not know how to read leaves the place unsaid.
  // So does a parse that has spent its steps: a place costs one for each
  // rule above the number, and a text can be built to make that the
  // square of its size.
  let path: string[] | undefined = []
  for (let r: Rule | undefined = rule.parent; null != r && r !== ctx.NORULE; r = r.parent) {
    if (--state.placing < 0) {
      state.placing = 0
      path = undefined
      break
    }
    if ('pair' === r.name || 'yamlElemPair' === r.name) {
      if ('string' !== typeof r.u.key) {
        path = undefined
        break
      }
      path.push(r.u.key)
    } else if ('elem' === r.name || 'yamlBlockList' === r.name || 'yamlBlockElem' === r.name) {
      if (!Array.isArray(r.node)) {
        path = undefined
        break
      }
      path.push(String(r.node.length))
    }
  }
  path?.reverse()
  // The token's offset into the text is exact. Its row and column are
  // not, under the yaml grammar, so `located` counts them from the offset.
  return { text, value, pos: tkn.sI, path }
}

// Two values given under one member name, merged as the base grammars
// merge them when no plugin says otherwise: the engine's `deep`, which
// jsonic's `map.extend` applies. Two maps merge member by member and two
// lists index by index, the later value winning wherever the two are not
// both maps or both lists. The engine builds what it merges in as plain
// objects, so every map of the result is rebuilt without a prototype, as
// every other map of a raw tree is.
function mergeValues(prev: any, curr: any): any {
  const out = Tabnas.util.deep(prev, curr)
  if (Array.isArray(out)) {
    return nullPrototypes({ list: out }).list
  }
  return isMap(out) ? nullPrototypes(out) : out
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

// How YAML's plain scalars, its comments and its document markers are
// read.
//
// 'base', the default, is the base grammars' own reading: `//` and
// `/* */` start a comment, as in jsonic; a number is whatever the engine
// and JavaScript read as one, so `1_000`, `0b11` and `Infinity` are
// numbers; the words of YAML 1.1 (`yes`, `no`, `on`, `off`) are
// booleans; and a second document is refused, an empty one included.
//
// 'spec' is the specification's: a comment starts with `#` and nothing
// else; a plain scalar is what the YAML 1.2 core schema reads it as, so
// a number is one of that schema's number forms, a boolean is `true` or
// `false`, and any other is the text as written; and an empty document
// after the description is passed over.
type Reading = 'base' | 'spec'

// Options for `make`.
type MakeOptions = {
  // Read strict JSON (RFC 8259) with the json grammar alone, instead of
  // JSON and YAML with jsonic and the yaml grammar.
  strict?: boolean

  // How the text is read. Default 'base'. Strict JSON has one reading, so
  // under `strict` this changes nothing.
  reading?: Reading
}

// The reading each parser from `make` was built for.
const READING = new WeakMap<Tabnas, Reading>()

function readingOf(value: unknown, who: string): Reading {
  const reading = value ?? 'base'
  if ('base' !== reading && 'spec' !== reading) {
    throw new TypeError(who + ': reading must be base or spec, not ' + quoted(reading))
  }
  return reading
}

// A parser instance with the plugin installed: jsonic with the yaml
// grammar, which reads JSON text as the strict json grammar does and YAML
// besides, or, with `strict`, json alone.
//
// It declares its own window setting, `lex.window` false, so that
// `parseReader` reads a reader whole (admin ADR-30): the plugin's matchers
// and actions are not yet verified at the window's edge, and a base that
// declares the window must not carry it to them. The setting comes last,
// after everything the base and the plugins set.
//
// The specification's reading is this package's own configuration of that
// parser, and adds no rule. The yaml grammar's `schema: 'core'` option
// makes a plain scalar what the YAML 1.2 core schema reads it as, and two
// engine options end jsonic's comment syntax.
//
// That option arrived in @tabnas/yaml 0.5.33. A grammar before it takes
// the option in silence and keeps its own reading, and this package names
// no version of that one, so `make` asks the parser it built
// (`readsCoreSchema`) and refuses the reading where the answer is no.
function make(options: MakeOptions = {}): Tabnas {
  const strict = true === options.strict
  const reading = readingOf(options.reading, 'make')
  const spec = 'spec' === reading && !strict
  const tn = strict
    ? new Tabnas().use(json)
    : new Tabnas().use(jsonic).use(Yaml, spec ? { schema: 'core' } : {})
  tn.use(OpenApi)
  if (spec) {
    tn.options({ comment: { def: { slash: { lex: false }, multi: { lex: false } } } })
  }
  tn.options({ lex: { window: false } })
  if (spec && !readsCoreSchema(tn)) {
    throw new TypeError(
      "make: reading 'spec' needs @tabnas/yaml 0.5.33 or later; the yaml grammar installed does not read the core schema",
    )
  }
  READING.set(tn, strict ? 'base' : reading)
  return tn
}

// What a member name given twice in one map gives.
type Duplicates = 'last' | 'merge'

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
  // and under `duplicates: 'merge'` the grammar always runs.
  fast?: boolean | 'auto'

  // What a repeated member name gives. 'last', the default, keeps the
  // last value, whole, as JSON.parse does. 'merge' merges the values as
  // the base grammars do when left to themselves: two maps member by
  // member, two lists index by index, and otherwise the later value. A
  // later member named `__proto__`, `constructor` or `prototype` is not
  // merged in: the engine's merge leaves those names out. Under `strict` a
  // repeated name is refused whatever this says.
  duplicates?: Duplicates

  // How the text is read: 'base', the default, as the base grammars read
  // it, or 'spec', as the specification does. See `Reading`. With an
  // `instance` it must be the reading that parser was built for.
  reading?: Reading

  // The most bytes the text may come to once every YAML alias is copied
  // in, as `aliasedSize` measures it. Default: the larger of 1,000,000 and
  // ten times the text. A text its aliases take past it is refused, as
  // `openapi_alias_budget`, before any of it is built. A text in which no
  // alias copies anything is never refused for it. Infinity lifts it.
  aliasBudget?: number

  // The largest text, in bytes of UTF-8, the grammar is given. Default
  // 16 MiB: reading YAML takes about a hundred bytes of memory for each
  // byte of a description. A larger text is refused, as `openapi_size`,
  // before any of it is built, unless JSON.parse reads it. The limit
  // also bounds the work the grammar does: a text that takes more steps
  // than a description of this size takes is stopped, as `openapi_work`,
  // since a text of very many small values costs ten times what a
  // description of its size does. Infinity lifts both.
  maxBytes?: number

  // A map this parse fills with what it has to say beside the tree. Its
  // `lossy` is then the list of numbers the tree does not hold exactly.
  report?: ParseReport

  // The parser to use, from `make`. Default: one shared parser per
  // setting of `strict` and `reading`.
  instance?: Tabnas
}

// What a parse reports beside the tree.
type ParseReport = {
  lossy?: Lossy[]
}

// The largest text the grammar is given unless the parse says otherwise.
const MAX_BYTES = 16 * 1024 * 1024

// The work the grammar is given with it: a rule pass for each ten bytes
// of the size limit, which is what the largest descriptions take (one for
// each 8 to 11 bytes, measured on GitHub's and Stripe's), and a hundred
// thousand passes at least, so that a small limit still reads a small
// text. At the default limit that is 1,677,721 passes, and about 1.6 GB.
const BYTES_A_STEP = 10
const STEPS_FLOOR = 100_000

// A shared parser holds the whole of its last parse until its next one
// starts: about a hundred times the size of the text. Past this many
// characters it is made to let go.
const RELEASE_OVER = 65536

// The steps one parse may take finding where its lossy numbers are in the
// tree. A real description takes a few hundred.
const PLACING = 2_000_000

// A run of digits long enough to be an integer a double cannot hold, or
// an exponent large enough to pass the largest double.
const MAY_BE_LOSSY = /[0-9]{16}|[eE][+]?[0-9]{3}/

const shared: { loose?: Tabnas; spec?: Tabnas; strict?: Tabnas } = {}

// Parse a description and return its raw tree: the document as written,
// every `$ref` kept as a reference. The text is a string, or its bytes.
// Raises `openapi_root` when the root is not a map, `openapi_stream` for a
// stream of several YAML documents, `openapi_alias_budget` for aliases
// that would copy the text out past the budget and `openapi_size` for a
// text too large for the grammar and `openapi_work` for one that takes
// too much work to read; under `strict`, also `openapi_version`,
// `openapi_duplicate_key` and, for bytes, `openapi_encoding`.
function parse(source: string | Uint8Array, options: ParseOptions = {}): any {
  const strict = true === options.strict
  let text: string
  // The size of the text in bytes of UTF-8, once it is known.
  let bytes: number | undefined
  let illFormed: string | undefined
  // A byte-order mark opened the text, and has been passed over.
  let marked = false
  if ('string' === typeof source) {
    text = source
  } else if (source instanceof Uint8Array) {
    const decoded = decode(source)
    text = decoded.text
    marked = 0 < decoded.skipped
    // The bytes given are the text's own size where they are well-formed
    // UTF-8. Otherwise it is counted from the text as read.
    if ('utf-8' === decoded.encoding && !decoded.illFormed) bytes = source.length - decoded.skipped
    if (decoded.illFormed) illFormed = decoded.encoding
  } else {
    throw new TypeError('parse: the text must be a string, or its bytes as a Uint8Array')
  }
  // A byte-order mark is not part of the text. The default reader passes
  // over it, and strict JSON may: RFC 8259 leaves that to the reader. One
  // mark is passed over, and a second is text.
  if (!marked && 0xfeff === text.charCodeAt(0)) {
    text = text.slice(1)
    marked = true
  }
  const duplicates = options.duplicates ?? 'last'
  if ('last' !== duplicates && 'merge' !== duplicates) {
    throw new TypeError('parse: duplicates must be last or merge, not ' + quoted(duplicates))
  }
  const aliasBudget = limitOf(options.aliasBudget, 'aliasBudget')
  const maxBytes = limitOf(options.maxBytes, 'maxBytes') ?? MAX_BYTES
  const report = options.report
  if (undefined !== report && (null == report || 'object' !== typeof report || Array.isArray(report))) {
    throw new TypeError('parse: report must be a map for the parse to fill, not ' + quoted(report))
  }
  // A parser reads one way, the way `make` built it for.
  const built = null == options.instance ? undefined : (READING.get(options.instance) ?? 'base')
  const reading = undefined === options.reading && undefined !== built ? built : readingOf(options.reading, 'parse')
  if (undefined !== built && built !== reading && !strict) {
    throw new TypeError(
      `parse: reading is ${reading}, and the instance reads as ${built}; build it with make({ reading: '${reading}' })`,
    )
  }
  const tn =
    options.instance ??
    (strict
      ? (shared.strict ??= make({ strict: true }))
      : 'spec' === reading
        ? (shared.spec ??= make({ reading: 'spec' }))
        : (shared.loose ??= make()))
  if (!tn.internal().plugins.includes(OpenApi)) {
    throw new Error('parse: the instance has no OpenApi plugin; build it with make()')
  }

  // Strict JSON refuses a text with nothing in it itself, as `unexpected`.
  const empty = !strict && !hasContent(text)
  const steps = Infinity === maxBytes ? Infinity : Math.max(STEPS_FLOOR, Math.floor(maxBytes / BYTES_A_STEP))
  const state: ParseState = {
    strict,
    duplicates,
    reading,
    empty,
    docs: 0,
    placing: PLACING,
    work: { left: steps, steps, limit: maxBytes },
  }

  // Bytes that were not what their encoding allows. They were read with
  // U+FFFD in place of each ill-formed sequence, which strict JSON does
  // not accept.
  if (strict && undefined !== illFormed) {
    state.refuse = { code: 'openapi_encoding', details: { encoding: illFormed } }
  }

  // JSON.parse keeps the last value of a repeated name, so it cannot stand
  // in for a parse that merges them. It tells nothing of a number it could
  // not hold either, so a report is read off the text, by a pass of its
  // own, and only where the text has a number that could be one.
  const fast = options.fast ?? 'auto'
  if (!strict && 'merge' !== duplicates && false !== fast && (true === fast || OPENS_WITH_BRACE.test(text))) {
    const value = fastParse(text)
    if (undefined !== value) {
      if (undefined !== report) {
        report.lossy = MAY_BE_LOSSY.test(text) ? located(lossyInJson(text, PLACING), value, text) : []
      }
      return value
    }
  }

  // What the text alone decides, before the grammar builds any of it.
  if (null == state.refuse) {
    // The text is at most three bytes for each of its characters.
    if (maxBytes < 3 * text.length) {
      bytes ??= utf8Length(text)
      if (maxBytes < bytes) {
        state.refuse = { code: 'openapi_size', details: { size: bytes, limit: maxBytes } }
      }
    }
  }
  if (null == state.refuse && !strict && text.includes('&') && text.includes('*')) {
    const encoded = new TextEncoder().encode(text)
    const size = aliasedBytes(encoded)
    const budget = aliasBudget ?? defaultAliasBudget(encoded.length)
    // Only what the aliases add is refused: a text in which no alias
    // copies anything is its own size, and `maxBytes` is its limit.
    if (encoded.length < size && budget < size) {
      state.refuse = { code: 'openapi_alias_budget', details: { size, budget } }
    } else if (Infinity !== budget) {
      // The grammar's own copies are held to the budget as well: see
      // `check`.
      state.copies = { allowed: budget - encoded.length, made: 0, bytes: encoded.length, budget }
    }
  }
  if (undefined !== report) state.lossy = []

  // The text the grammar is given. The engine returns at once for an
  // empty text and runs no rule, so it is handed a single line break
  // instead, which reads to an empty document. The yaml grammar passes
  // over one byte-order mark of its own accord, so where the one mark has
  // gone and a second follows, which is text, the first is put back for
  // the grammar to pass over.
  let given = text
  if (!strict) {
    if ('' === text) given = '\n'
    else if (marked && 0xfeff === text.charCodeAt(0)) given = '\ufeff' + text
  }

  // A text that is refused is not handed to the grammar. Handing a text
  // over takes time and memory in step with its size before the first
  // rule runs, three times the text and more, which is what a refusal is
  // there to spare.
  if (null != state.refuse) refuseAt(tn, state, opening(given))

  let value: any
  try {
    value = tn.parse(given, { openapi: state })
  } finally {
    if (null == options.instance && RELEASE_OVER < text.length) release(tn)
  }
  // Several documents come back as their list. The root check let them
  // by only because each after the first is empty.
  if (1 < state.docs && Array.isArray(value)) value = value[0]
  if (undefined !== report) report.lossy = located(state.lossy!, value, given)
  return value
}

// The opening of a text: its first three lines, and 240 characters at
// most. It is what an error placed at the start of the text shows.
function opening(text: string): string {
  let shown = text.slice(0, 240)
  let end = 0
  for (let line = 0; line < 3; line++) {
    const next = shown.indexOf('\n', end)
    if (-1 === next) return whole(shown)
    end = next + 1
  }
  return shown.slice(0, end)
}

// A piece of text that does not end on half of a surrogate pair.
function whole(piece: string): string {
  const last = piece.charCodeAt(piece.length - 1)
  return 0xd800 <= last && last < 0xdc00 ? piece.slice(0, -1) : piece
}

// A text every grammar here opens on. It stands in for the opening of a
// refused text where that opening does not start a parse by itself, as
// when it ends inside the text's first token.
const OPENS_ANY = '{}'

// Raise the refusal `parse` decided from the text. An error needs a
// token and a context to carry its place, so the opening of the text is
// parsed, and `check` raises the refusal on its first rule pass.
function refuseAt(tn: Tabnas, state: ParseState, shown: string): never {
  const refuse = state.refuse!
  for (const stand of [shown, OPENS_ANY]) {
    state.refuse = refuse
    try {
      tn.parse(stand, { openapi: state })
    } catch (err: any) {
      if (refuse.code === err?.code) throw err
    }
  }
  // Not reached: `check` raises the refusal on the first rule pass.
  throw new Error('parse: ' + refuse.code)
}

// A limit given as an option: a number that is not negative, Infinity
// included, or nothing.
function limitOf(value: unknown, name: string): number | undefined {
  if (undefined === value) return undefined
  if ('number' !== typeof value || Number.isNaN(value) || value < 0) {
    throw new TypeError(`parse: ${name} must be a number of bytes, not ${quoted(value)}`)
  }
  return value
}

// Make a shared parser let go of its last parse: its next one, of
// anything, starts by dropping it.
function release(tn: Tabnas): void {
  try {
    tn.parse('0')
  } catch {
    // Nothing is held by a parse that failed either.
  }
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

export { OpenApi, aliasedSize, make, parse, version, wellFormed, VERSION }

export { resolve, ResolveError } from './resolve'
export type {
  Cut,
  Cycles,
  Kind,
  Provenance,
  ResolveOptions,
  ResolveResult,
  Sharing,
  Status,
  Unresolved,
  Why,
} from './resolve'
export type { Connection, ConnectionKind } from './connections'
export type { DialectName, DialectUse } from './dialect'

export type {
  Duplicates,
  Lossy,
  MakeOptions,
  OpenApiOptions,
  ParseOptions,
  ParseReport,
  Reading,
  VersionInfo,
  WellFormedOptions,
}
