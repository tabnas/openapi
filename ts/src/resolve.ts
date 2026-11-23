/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// The resolver: a derived tree with every `$ref` resolved, built as an
// OpenAPI vocabulary over @tabnas/expr's fold. Everything generic (the
// walk, the bag inherited down the tree, one result per location, cycles)
// is expr's; everything OpenAPI knows is here: which `$ref` maps are
// references (the object model), the base URI and dialect each map is
// read under, URI resolution, fragments, anchors, the sibling rules by
// version and kind, the output shapes, and the report. The raw tree is
// never changed.
//
//
// What a reference names is a fact about the document, and is worked out
// before the fold, by the site index (site-index.ts): which maps are
// sites, the state, base URI and dialect of every map, the identifiers,
// and where each reference lands. The fold's `inherit` and `recognise`
// are look-ups in it. What depends on the tree being built stays here:
// the values, what is shared, and which edge of a cycle is cut.
//
// A description may be several documents. The others are given with
// it, in `documents`, each by the URI it was retrieved from, and a
// reference that names one resolves into it. Nothing is loaded here: a
// reference into a document that was not given is reported as external
// and left as written. The plan is docs/design/typescript-plan.md, steps
// T3 and T4.

import { fold, FoldError } from '@tabnas/expr'
import type { FoldOptions, Op, Positions, Site } from '@tabnas/expr'

import { connectionsOf, reuseOf } from './connections'
import type { Connection, UrlUse } from './connections'
import { dialectOf } from './dialect'
import type { DialectUse } from './dialect'
import type { ModelVersion } from './model'
import { version as readVersion } from './oas-version'
import { parse } from './openapi'
import type { ParseOptions } from './openapi'
import { Loc, buildIndex, hasIds } from './site-index'
import { HISTORY_OVER, MAX_BYTES, PART, stepsOf, utf8Length } from './text'
import type { Part } from './text'
import { ALIAS_FACTOR, ALIAS_FLOOR } from './yaml-alias'
import type { DocFacts, DocInput, Kind, SiteFacts, Why } from './site-index'
import { NOTHING, define, isMap, merged, normalizeUri, own, pointer, resolveUri, stepInto, withoutFragment } from './uri'
import type { Path } from './uri'

// The reader of the other documents of a description that are given as
// text or bytes. A description names whatever documents its author
// chose, and each limit `parse` holds one text to has a floor that a set
// of small texts would have once for each of them: 100,000 steps, and
// 1,000,000 bytes copied out by aliases. Twenty texts of 50 kB took four
// seconds to read, and ten thousand would take half an hour. So the
// texts of one description are held to one limit together, the one a
// single text has:
//
// - `maxBytes` in size, whichever way a text is read. JSON text that
//   JSON.parse reads has no limit by itself, and has this one.
// - the steps of that size in work: each text is given what is left.
// - one alias budget: each text may copy out ten times its own size, and
//   they share the floor between them. A caller's own `aliasBudget` is
//   each text's, as given.
//
// A tree is not counted: its size was whoever built it to bound.
function partReader(given: ParseOptions | undefined): (doc: string | Uint8Array, uri: string) => any {
  const limit = 'number' === typeof given?.maxBytes ? given.maxBytes : null == given?.instance ? MAX_BYTES : HISTORY_OVER
  // A limit that is no number of bytes is `parse`'s to refuse.
  if (!(0 <= limit)) return (doc) => parse(doc, { ...given, [PART]: {} } as ParseOptions)
  const all = stepsOf(limit)
  const pool = { bytes: limit, steps: all, spare: ALIAS_FLOOR }
  const shared = undefined === given?.aliasBudget
  return (doc, uri) => {
    const size = 'string' === typeof doc ? utf8Length(doc) : doc.length
    if (pool.bytes < size) {
      throw new ResolveError(
        'openapi_size',
        `resolve: the documents given as text are more than ${limit} bytes together, at ${quoted(uri)}`,
        uri,
      )
    }
    pool.bytes -= size
    const part: Part = { steps: pool.steps }
    const options: any = { ...given, [PART]: part }
    if (shared) options.aliasBudget = ALIAS_FACTOR * size + pool.spare
    try {
      return parse(doc, options)
    } catch (err: any) {
      // Stopped for what the texts before it took, not for its own size.
      if ('openapi_work' === err?.code && pool.steps < all && pool.steps <= (part.taken ?? 0)) {
        throw new ResolveError(
          'openapi_work',
          `resolve: the documents given as text take more than ${all} steps to read together, ` +
            `the most a limit of ${limit} bytes gives, at ${quoted(uri)}`,
          uri,
        )
      }
      throw err
    } finally {
      pool.steps = Math.max(0, pool.steps - (part.taken ?? 0))
      if (shared) {
        pool.spare = Math.max(0, pool.spare - Math.max(0, (part.copied ?? 0) - (ALIAS_FACTOR - 1) * size))
      }
    }
  }
}

// The base a description is read under when the caller gives no retrieval
// URI and the document has no `$self`: a fixed URN, as the specification
// suggests for a document with no location, so that fragment-only
// references still resolve.
const DEFAULT_BASE = 'urn:uuid:0c2b4f0e-8f9d-4c7a-9a52-6d1e3b7a4f10'

// The error codes `strict` raises, by reason.
const STRICT: Partial<Record<Why, string>> = {
  'not-a-string': 'openapi_ref_type',
  'bad-fragment': 'openapi_pointer',
  'not-found': 'openapi_unresolved',
  'no-anchor': 'openapi_unresolved',
  external: 'openapi_unresolved',
  'non-object-target': 'openapi_unresolved',
}

type Sharing = 'share' | 'site' | 'inline-once' | 'copy'
type Cycles = 'cut' | 'keep'

type ResolveOptions = {
  // The version to read the description as. 'auto', the default, reads
  // the root's openapi or swagger member.
  version?: 'auto' | ModelVersion
  // The URI the description was retrieved from: the base of its relative
  // references when it has no `$self`.
  retrievalUri?: string
  // The other documents of the description, each by the URI it was
  // retrieved from: a tree, as `parse` gives one, or text or bytes, which
  // `parse` reads. A name that is relative is read against
  // `retrievalUri`, which it then needs. A reference that names one of
  // them resolves into it: by that URI, by the document's own `$self`,
  // or by an identifier one of its schemas declares. A document whose
  // root declares a version is read as a description of that version.
  // Any other is read as the references that land in it type it: a
  // schema, a Path Item, a map of parameters. Not read under
  // `refs: 'pointer'`.
  documents?: Record<string, unknown>
  // How `parse` reads a document given as text or bytes. Such a document
  // may be anything at its root, and needs no version. The texts are
  // held together to what one text is: `maxBytes` in size, the steps of
  // that size in work, and one alias budget, unless `aliasBudget` gives
  // each its own.
  parse?: ParseOptions
  // Raise an error, rather than report it, for a reference that names
  // nothing, a malformed fragment, and a `$ref` whose value is not a
  // string.
  strict?: boolean
  // Each container's opening token, from expr's recordPositions, so that
  // provenance carries a row and column.
  positions?: Positions
  // The deepest a map or list may be nested, and the most references that
  // may be followed one inside another, counted together. Default 1000.
  // Past it resolve raises `openapi_depth`.
  maxDepth?: number
  // The most steps resolving may take: one for each map or list it comes
  // to, each time it comes to one, and one for each reference it reads.
  // Past it resolve raises `openapi_work`. No bound by default.
  maxSteps?: number
  // A check that can stop resolving: called every `checkEveryN` steps,
  // 1,000 unless given, with the steps taken so far. When it returns
  // false, resolve raises `openapi_cancel`. A caller keeps a deadline
  // there.
  onCheck?: (steps: number) => boolean | void
  checkEveryN?: number
  // How the sites naming one target hold it: one value they all share
  // ('share', the default); a shallow copy each ('site'); the value at
  // the first site and the reference as written at the rest
  // ('inline-once'); or a copy each, all the way down ('copy'), which
  // needs a `budget`.
  sharing?: Sharing
  // The most bytes of compact JSON a 'copy' may make.
  budget?: number
  // An edge that closes a cycle: left as written and reported in `cuts`
  // ('cut', the default), or followed, which makes the tree a cyclic
  // graph ('keep'). A loop made of references alone is cut either way.
  cycles?: Cycles
  // The members beside a `$ref`: by the specification's rule for the
  // version and the kind of site ('spec', the default), or merged over
  // the target, the site's own winning ('merge').
  siblings?: 'spec' | 'merge'
  // Which maps with a `$ref` are sites: where the object model puts a
  // reference ('spec', the default), or also every other map whose `$ref`
  // is a string ('all').
  slots?: 'spec' | 'all'
  // Whether a reference may resolve to a value that is not a map ('any',
  // the default) or is left as written ('object').
  targets?: 'any' | 'object'
  // How a `$ref` names its target. 'uri', the default: as a URI reference,
  // resolved against the base in force, with `$id`, anchors, schema
  // dialects and percent-decoding. 'pointer': as a JSON Pointer into this
  // document, written `#/…`, and nothing else. The pointer is read from
  // the document's root, which is then never a site itself, with `~0` and
  // `~1` but no percent-decoding; the walk ends at a reference left as
  // written, where 'uri' reads on in the map as written; `$id`, anchors,
  // dialects and `$dynamicRef` are not read at all.
  refs?: 'uri' | 'pointer'
  // Write `x-ref`, the reference as written, beside every site, resolved
  // or not. Each site then holds its own copy.
  xref?: boolean
  // Extension members whose values hold references to resolve, though
  // the object model reads an extension as data: Stripe's
  // x-expansionResources, say.
  extensions?: string[]
  // A named set of the options above. 'apidef' resolves as @voxgig/apidef
  // does: { siblings: 'merge', xref: true, sharing: 'site', cycles: 'keep',
  // slots: 'all', targets: 'object', refs: 'pointer' }. Options given
  // beside it win. It also keeps two details of how apidef builds a
  // site's value, which no option names: a member named `__proto__` beside
  // a `$ref` is left out, and `x-ref` takes the place of an `x-ref` the
  // target's value already has.
  compat?: 'apidef'
}

// What a site's place in the tree holds: its target's value, the
// reference as written because it names nothing or closes a cycle, or the
// reference as written because 'inline-once' put the value at an earlier
// site.
type Status = 'resolved' | 'unresolved' | 'cut' | 'kept'

// A reference left as written, and why. `doc` is the document it is in,
// by the URI that document was given under, where that is not the
// description itself.
type Unresolved = { at: string; ref: unknown; why: Why; doc?: string }

// One reference site, whatever became of it.
type Provenance = {
  at: string
  // The document the site is in, by the URI it was given under, where
  // that is not the description itself.
  doc?: string
  ref: unknown
  kind: Kind
  // What a Reference Object stands for: response, parameter, and so on.
  type: string | null
  // The location it names, when it names one in this document.
  target: string | null
  // The location it lands on, read on the document as it is written:
  // `target`, unless a step of the pointer was missing at a reference and
  // was read in what that reference names. Null when it lands nowhere
  // here, and under `refs: 'pointer'`, which reads a pointer otherwise.
  landing: string | null
  // The document `target` and `landing` are in, by the URI it was given
  // under, where that is not the document the site is in.
  targetDoc?: string
  // The references the pointer was read through to land there, when
  // there are any.
  through?: string[]
  // The document `landing` is in, where a pointer read through a
  // reference ended in another than `target` is in.
  landingDoc?: string
  // For a reference into another document: that document's URI, and the
  // fragment of the reference when it has one.
  uri?: string
  fragment?: string
  // The type of what it lands on, where the object model types that and
  // it is not the type the reference expects: `response` for a schema's
  // reference to a Response Object, `data` for one into an example. The
  // reference resolves all the same.
  conflict?: string
  status: Status
  row?: number
  col?: number
}

// A reference left as written because resolving it would close a cycle:
// the edge that closes one, or a reference to such an edge.
type Cut = { at: string; ref: string; target: string; doc?: string; targetDoc?: string }

type ResolveResult = {
  tree: any
  version: '2.0' | '3.0' | '3.1' | '3.2' | 'unknown'
  // The other documents of the description that were read, each by the
  // URI it was retrieved from, in its normal form: those given in
  // `documents`, and under `resolveAll` those that were loaded.
  documents: string[]
  unresolved: Unresolved[]
  provenance: Provenance[]
  cuts: Cut[]
  connections: Connection[]
  // `$ref` maps the object model types as data: an example payload, an
  // extension value, a property named `$ref`.
  dataSlots: number
  // The schema dialects the description declares, the root's
  // `jsonSchemaDialect` first and then each schema's `$schema` in document
  // order, with the dialect each is read by. One this package does not
  // know is read as 2020-12, and has `known: false` here. Empty for 2.0
  // and 3.0, which have no dialects, and under `refs: 'pointer'`, which
  // reads none.
  dialects: DialectUse[]
  // The URLs and URIs the description gives for things outside it, in
  // document order, each with its absolute form where it has one. None is
  // loaded.
  urls: UrlUse[]
}

class ResolveError extends Error {
  code: string
  at: string
  ref: unknown
  constructor(code: string, message: string, at = '', ref?: unknown) {
    super(message)
    this.name = 'ResolveError'
    this.code = code
    this.at = at
    this.ref = ref
  }
}

// Document content in a message: JSON-quoted and cut short.
function quoted(value: unknown): string {
  let text: string
  try {
    text = JSON.stringify(value) ?? String(value)
  } catch {
    text = String(value)
  }
  return 60 < text.length ? text.slice(0, 57) + '...' : text
}

// $self exists in OpenAPI from 3.2.
const hasSelf = (v: ModelVersion) => '3.2' === v

// A URI with a scheme, which needs no base to be read against.
const ABSOLUTE = /^[A-Za-z][A-Za-z0-9+.-]*:/

const DEFAULT_DIALECT: Record<string, string> = {
  '3.1': 'https://spec.openapis.org/oas/3.1/dialect/base',
  '3.2': 'https://spec.openapis.org/oas/3.2/dialect/base',
}

// A Reference Object's summary and description override the target's
// only where the target's type has the field, by the specification's
// text. 3.2 adds summary to the Response and Tag objects. Its Media Type
// Object has no description, though the validation schemas before
// 2026-11-12 gave it one.
const OVERRIDE_31: Record<string, string[]> = {
  response: ['description'],
  parameter: ['description'],
  example: ['summary', 'description'],
  requestBody: ['description'],
  header: ['description'],
  link: ['description'],
  securityScheme: ['description'],
  callback: [],
  pathItem: ['summary', 'description'],
}

const OVERRIDE: Record<string, Record<string, string[]>> = {
  '3.1': OVERRIDE_31,
  '3.2': {
    ...OVERRIDE_31,
    response: ['summary', 'description'],
    tag: ['summary', 'description'],
  },
}

const PRESETS: Record<string, ResolveOptions> = {
  apidef: {
    siblings: 'merge',
    xref: true,
    sharing: 'site',
    cycles: 'keep',
    slots: 'all',
    targets: 'object',
    refs: 'pointer',
  },
}

const CHOICES: Record<string, string[]> = {
  sharing: ['share', 'site', 'inline-once', 'copy'],
  cycles: ['cut', 'keep'],
  siblings: ['spec', 'merge'],
  slots: ['spec', 'all'],
  targets: ['any', 'object'],
  refs: ['uri', 'pointer'],
}

type Loose =
  | 'positions'
  | 'maxDepth'
  | 'maxSteps'
  | 'onCheck'
  | 'checkEveryN'
  | 'budget'
  | 'retrievalUri'
  | 'compat'
  | 'documents'
  | 'parse'

type Settled = Required<Omit<ResolveOptions, Loose>> & Pick<ResolveOptions, Loose>

// The options in force: the preset, then what was given, then the
// defaults, each choice checked.
function settle(options: ResolveOptions): Settled {
  let preset: ResolveOptions = {}
  if (null != options.compat) {
    preset = PRESETS[options.compat]
    if (null == preset) throw new TypeError('resolve: unknown compat ' + quoted(options.compat))
  }
  const given: Record<string, any> = {}
  for (const [k, v] of Object.entries(options)) if (undefined !== v) given[k] = v
  const o: Settled = {
    version: 'auto',
    strict: false,
    sharing: 'share',
    cycles: 'cut',
    siblings: 'spec',
    slots: 'spec',
    targets: 'any',
    refs: 'uri',
    xref: false,
    extensions: [],
    ...preset,
    ...given,
  } as Settled
  for (const [name, allowed] of Object.entries(CHOICES)) {
    const v = (o as any)[name]
    if (!allowed.includes(v)) {
      throw new TypeError(`resolve: ${name} must be one of ${allowed.join(', ')}, not ${quoted(v)}`)
    }
  }
  if (!Array.isArray(o.extensions) || o.extensions.some((e) => 'string' !== typeof e)) {
    throw new TypeError('resolve: extensions must be a list of member names, not ' + quoted(o.extensions))
  }
  if (('copy' === o.sharing || 'inline-once' === o.sharing) && 'keep' === o.cycles) {
    throw new TypeError(`resolve: sharing ${o.sharing} makes a tree, so it cannot keep cycles`)
  }
  if ('copy' === o.sharing && !(Number.isFinite(o.budget) && 0 <= (o.budget as number))) {
    throw new ResolveError('openapi_budget', 'resolve: sharing copy needs a budget, the most bytes it may make')
  }
  for (const name of ['maxDepth', 'maxSteps', 'checkEveryN'] as const) {
    const v = o[name]
    if (undefined !== v && !(('number' === typeof v && Number.isInteger(v) && 0 < v) || Infinity === v)) {
      throw new TypeError(`resolve: ${name} must be a whole number above 0, not ${quoted(v)}`)
    }
  }
  if (undefined !== o.onCheck && 'function' !== typeof o.onCheck) {
    throw new TypeError('resolve: onCheck must be a function, not ' + quoted(o.onCheck))
  }
  return o
}

// What this resolver asks of @tabnas/expr's fold that its releases up to
// 0.6.3 do not have: a step budget, and a site that reads a location as
// the document is written. They arrived together, so one probe finds
// both: a fold of two maps under a budget of one step. Run once, and
// only when one of the two is needed.
let foldIsNewEnough: boolean | undefined
function checkFold(): void {
  if (undefined === foldIsNewEnough) {
    foldIsNewEnough = false
    try {
      fold({ a: {} }, { evaluate: (_site, _op, terms) => terms, budget: { steps: 1 } })
    } catch (err: any) {
      foldIsNewEnough = err instanceof FoldError && 'fold_budget' === err.code
    }
  }
  if (!foldIsNewEnough) {
    throw new TypeError(
      'resolve: the installed @tabnas/expr is too old. Its fold has no step budget and no site.written, ' +
        'which @tabnas/openapi needs: install 0.6.4 or later',
    )
  }
}

// The fold's own errors that are this package's to name.
const FOLD_CODES: Record<string, string> = {
  fold_depth: 'openapi_depth',
  fold_budget: 'openapi_work',
  fold_cancel: 'openapi_cancel',
}

// The UTF-8 length of a string.
function utf8(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (0xd800 <= c && c < 0xdc00 && i + 1 < s.length && 0xdc00 <= s.charCodeAt(i + 1) && s.charCodeAt(i + 1) < 0xe000) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

// The operators the fold recognises: two key operators, by member name.
const OPS = {
  ref: { key: true, src: '$ref' },
  dynamicRef: { key: true, src: '$dynamicRef', dynamic: true },
}

// One site, from the moment the walk first meets it. `row` is what the
// index knows of it, which the walk does not change.
type SiteInfo = {
  seq: number
  row: SiteFacts
  at: string
  // The document it is in, where that is not the description.
  doc?: string
  kind: Kind
  type: string | null
  ref: unknown
  target?: Path
  // What 'inline-once' counts as one target: where the reference lands.
  key?: string
  // Why it cannot resolve, when that is known before its target is
  // folded.
  why?: Why
  status: Status
  token?: { rI: number; cI: number }
  // For `orderAsWalked`: the value the site landed on, and the names of
  // its own other members, in document order.
  landing?: object
  siblings?: string[]
  // The value a resolved site holds, for `throughLeft`.
  value?: any
}

// A site left as written, and whether that is for a cycle or a reason.
type Left = { cut: boolean; why?: Why }

// Resolve every `$ref` of a raw tree, from `parse`, into a new tree. The
// raw tree is never changed.
function resolve(raw: any, options: ResolveOptions = {}): ResolveResult {
  const o = settle(options)
  const detected = readVersion(raw).version
  const mv: ModelVersion =
    'auto' !== o.version ? o.version : 'unknown' === detected ? '3.2' : (detected as ModelVersion)
  const strict = true === o.strict
  const siteShape = 'site' === o.sharing || o.xref
  const extensions = new Set(o.extensions)

  // The URI the description was retrieved from, and its own: both in
  // their normal form and without a fragment, as every base URI below is.
  const retrieved = withoutFragment(normalizeUri(o.retrievalUri ?? DEFAULT_BASE))
  const entry =
    hasSelf(mv) && isMap(raw) && 'string' === typeof raw.$self
      ? withoutFragment(normalizeUri(resolveUri(retrieved, raw.$self)))
      : retrieved
  const rootDialect =
    hasIds(mv) && isMap(raw) && 'string' === typeof raw.jsonSchemaDialect
      ? raw.jsonSchemaDialect
      : (DEFAULT_DIALECT[mv] ?? '')
  const limit = o.maxDepth ?? 1000
  const pointers = 'pointer' === o.refs

  // The other documents of the description, each by the URI it was
  // retrieved from, in its normal form. One whose root declares a
  // version is a description of that version, with a `$self` and a
  // default dialect of its own. Any other is read by the version of the
  // description, and its schemas by that version's own dialect, as the
  // specification has it for a schema document that names none.
  const others: DocInput[] = []
  if (undefined !== o.documents) {
    if (pointers) throw new TypeError("resolve: documents are read under refs: 'uri', and refs is 'pointer'")
    if (!isMap(o.documents)) throw new TypeError('resolve: documents must be a map from URI to document')
    const taken = new Set([retrieved, entry])
    const read = partReader(o.parse)
    for (const name of Object.keys(o.documents)) {
      if (undefined === o.retrievalUri && !ABSOLUTE.test(name)) {
        throw new TypeError(
          `resolve: documents names ${quoted(name)}, which is relative, and no retrievalUri says what it is relative to`,
        )
      }
      const key = withoutFragment(normalizeUri(resolveUri(retrieved, name)))
      if (taken.has(key)) {
        throw new TypeError(`resolve: documents names ${quoted(name)}, and ${quoted(key)} is a document already`)
      }
      taken.add(key)
      let doc: any = o.documents[name]
      // A document that is missing is not one with nothing in it.
      if (undefined === doc) {
        throw new TypeError(`resolve: documents names ${quoted(name)} and gives no document for it`)
      }
      if ('string' === typeof doc || doc instanceof Uint8Array) doc = read(doc, key)
      const said = readVersion(doc)
      const described = null !== said.field
      const dmv: ModelVersion = !described ? mv : 'unknown' === said.version ? '3.2' : (said.version as ModelVersion)
      others.push({
        key,
        uri:
          described && hasSelf(dmv) && 'string' === typeof doc.$self
            ? withoutFragment(normalizeUri(resolveUri(key, doc.$self)))
            : key,
        raw: doc,
        mv: dmv,
        described,
        rootDialect:
          described && hasIds(dmv) && 'string' === typeof doc.jsonSchemaDialect
            ? doc.jsonSchemaDialect
            : (DEFAULT_DIALECT[dmv] ?? ''),
      })
    }
  }

  // The steps taken, the index's and then the fold's, for `maxSteps` and
  // `onCheck`.
  const maxSteps = o.maxSteps ?? Infinity
  const onCheck = o.onCheck
  const checkEveryN = undefined === onCheck ? 0 : (o.checkEveryN ?? 1000)
  let steps = 0
  const counting = Infinity !== maxSteps || undefined !== onCheck

  // Under `refs: 'pointer'` a pointer is read by `site.at`, which every
  // fold has. Anything else reads a landing as written, and a count of
  // steps is kept through the fold's budget.
  if (!pointers || counting) checkFold()
  const tick = () => {
    steps++
    if (maxSteps < steps) throw new ResolveError('openapi_work', `resolve: more than ${maxSteps} steps`)
    if (0 < checkEveryN && 0 === steps % checkEveryN && false === onCheck!(steps)) {
      throw new ResolveError('openapi_cancel', `resolve: stopped by onCheck after ${steps} steps`)
    }
  }

  const refuse = (code: string, message: string, at: string): never => {
    throw new ResolveError(code, `resolve: ${message}` + ('' === at ? '' : ` at ${quoted(at)}`), at)
  }

  const index = buildIndex(raw, {
    mv,
    entry,
    retrieved,
    rootDialect,
    others,
    slots: o.slots,
    extensions,
    pointers,
    maxDepth: limit,
    refuse,
    tick: counting ? tick : undefined,
  })
  // For `resolveAll`: the documents this set names and does not have. The
  // names and URIs of the `connections` report are located too, since a
  // document may be named by one of those alone.
  if (true === (options as any)[WANTED]) {
    connectionsOf(raw, mv, index, hasIds(mv), counting ? tick : undefined)
    return { wanted: [...index.wanted] } as any
  }

  const home = index.docs[0]
  const byKey = new Map<string, DocFacts>()
  for (const doc of index.docs) byKey.set(doc.key, doc)
  // A document's key, where it is not the description.
  const keyOf = (doc: DocFacts | undefined): string | undefined => (undefined === doc || doc === home ? undefined : doc.key)
  // A place for a message: its pointer, and its document where that is
  // not the description.
  const where = (info: SiteInfo): string => (undefined === info.doc ? info.at : info.doc + '#' + info.at)

  const infos = new Map<SiteFacts, SiteInfo>()
  const sites: SiteInfo[] = []
  const unresolvedRows: [number, Unresolved][] = []
  const cutRows: [number, Cut][] = []
  const mergeRows: [number, Connection][] = []
  // The seq of the first site naming each target, for 'inline-once'.
  const firstFor = new Map<string, number>()
  // The values of sites left as written: a site naming one is left too.
  const left = new WeakMap<object, Left>()
  // The copies this resolver wrote `x-ref` on.
  const ours = new WeakSet<object>()
  // Under `compat: 'apidef'` with `x-ref`, each resolved site by its value.
  const siteValue = new Map<object, SiteInfo>()
  // Under 'keep', the placeholder each site holds until the fold is done.
  const deferred = new Map<object, { info: SiteInfo; siblings: any; plain: any }>()
  let seq = 0

  // The preset's two details that no option names: see `settleSite` and
  // `orderAsWalked`.
  const asApidef = 'apidef' === o.compat

  // The first reference left as written that the walk to a location
  // passes through, if any. Under `refs: 'pointer'` such a walk ends
  // there, even where the map as written has the next member.
  // A `$ref` that is not a string makes no reference, so the walk reads
  // through that map as it reads through any other. Past the first site
  // that resolved, the fold steps on in that site's value, and so does
  // this, where the references left as written are known by their values.
  const throughLeft = (target: Path): Left | undefined => {
    const ended = (why: Left): Left => (why.cut ? { cut: true } : { cut: false, why: 'not-found' })
    let loc: Loc | undefined = index.root
    for (let i = 1; i < target.length; i++) {
      loc = undefined === loc ? undefined : index.child(loc, target[i - 1])
      if (undefined === loc) return undefined
      const via = undefined === loc.site ? undefined : infos.get(loc.site)
      if (null == via || 'not-a-string' === via.why) continue
      if ('cut' === via.status) return { cut: true }
      if (null != via.why || 'unresolved' === via.status) return { cut: false, why: 'not-found' }
      let node = via.value
      for (let j = i; j < target.length; j++) {
        if (null == node || 'object' !== typeof node) return undefined
        const why = left.get(node)
        if (null != why) return ended(why)
        node = stepInto(node, target[j])
        if (NOTHING === node) return undefined
      }
      return undefined
    }
    return undefined
  }

  const unresolvedHere = (info: SiteInfo, why: Why) => {
    const code = STRICT[why]
    if (strict && null != code) {
      throw new ResolveError(code, `${why}: the reference at ${quoted(where(info))} (${quoted(info.ref)})`, info.at, info.ref)
    }
    const row: Unresolved = { at: info.at, ref: info.ref, why }
    if (undefined !== info.doc) row.doc = info.doc
    unresolvedRows.push([info.seq, row])
    info.status = 'unresolved'
  }

  const cutHere = (info: SiteInfo) => {
    const row: Cut = { at: info.at, ref: info.ref as string, target: pointer(info.target!) }
    if (undefined !== info.doc) row.doc = info.doc
    const to = info.row.targetDoc
    if (undefined !== to && to !== info.row.loc.doc) row.targetDoc = to.key
    cutRows.push([info.seq, row])
    info.status = 'cut'
  }

  // The value of a site left as written: its map, member by member, so a
  // reference inside a sibling still resolves, with `x-ref` when asked.
  const asWritten = (plain: any, info: SiteInfo, why?: Left) => {
    let v = plain
    if (o.xref && 'string' === typeof info.ref) {
      v = merged(plain)
      define(v, 'x-ref', info.ref)
      ours.add(v)
    }
    if (null != why) left.set(v, why)
    return v
  }

  // A value as the next site sees it: without the `x-ref` this resolver
  // wrote on it, so a chain of references gets the last site's.
  const body = (v: any) => {
    if (!ours.has(v)) return v
    const out = merged(v)
    delete out['x-ref']
    return out
  }

  // The sibling rule, by the site's kind and the version.
  const combine = (hit: any, siblings: any, info: SiteInfo) => {
    if (!isMap(hit) || !isMap(siblings) || 0 === Object.keys(siblings).length) return hit
    // The rule is that of the version of the document the site is in.
    const mv = info.row.loc.doc.mv
    // A Path Item's $ref is a field of the Path Item in every version,
    // Swagger 2.0 included: the fields merge, and a field on both sides,
    // which the specification leaves undefined, is reported.
    if ('pathItem' === info.kind) {
      const both = Object.keys(siblings).filter((k) => own(hit, k))
      if (0 < both.length) {
        const row: Connection = {
          kind: 'pathItemMerge',
          at: info.at,
          name: info.ref as string,
          found: true,
          target: pointer(info.target!),
          fields: both,
        }
        if (undefined !== info.doc) row.doc = info.doc
        const to = info.row.targetDoc
        if (undefined !== to && to !== info.row.loc.doc) row.targetDoc = to.key
        mergeRows.push([info.seq, row])
      }
      return merged(hit, siblings)
    }
    if ('merge' === o.siblings) return merged(hit, siblings)
    // A 2.0 JSON Reference, a 3.0 Reference Object or schema $ref, and a
    // reference in data: siblings are ignored.
    if ('data' === info.kind || '2.0' === mv || '3.0' === mv) return hit
    // 3.1 and later: a Schema Object's $ref is an applicator, and its
    // siblings apply beside it, unless the schema is of a dialect whose
    // $ref stands alone (draft-04 to draft-07).
    if ('schema' === info.kind) {
      if (info.row.alone) return hit
      const rest = merged(siblings)
      const allOf = Array.isArray(rest.allOf) ? rest.allOf : []
      delete rest.allOf
      return merged({ allOf: [hit, ...allOf] }, rest)
    }
    const fields = (OVERRIDE[mv] ?? {})[info.type ?? ''] ?? []
    const override: Record<string, any> = {}
    for (const f of fields) if (own(siblings, f)) override[f] = siblings[f]
    return 0 === Object.keys(override).length ? hit : merged(hit, override)
  }

  // A site whose target was found: its value, by the options in force.
  const settleSite = (info: SiteInfo, value: any, siblings: any, plain: any) => {
    const d = null != value && 'object' === typeof value ? left.get(value) : undefined
    if (null != d) {
      // A reference to a reference left as written is left as written.
      if (d.cut) cutHere(info)
      else unresolvedHere(info, d.why!)
      return asWritten(plain, info, d)
    }
    if ('object' === o.targets && !isMap(value)) {
      unresolvedHere(info, 'non-object-target')
      return asWritten(plain, info, { cut: false, why: 'non-object-target' })
    }
    if ('inline-once' === o.sharing && firstFor.get(info.key!) !== info.seq) {
      info.status = 'kept'
      return asWritten(plain, info)
    }
    info.status = 'resolved'
    // @voxgig/apidef gathers a site's other members by assignment into a
    // plain object, where a member named `__proto__` sets the prototype
    // and makes no member. Under the preset it is left out likewise.
    if (asApidef && isMap(siblings) && own(siblings, '__proto__')) {
      siblings = merged(siblings)
      delete siblings.__proto__
    }
    let out = combine(body(value), siblings, info)
    if (siteShape && out === value && (isMap(out) || Array.isArray(out))) {
      out = Array.isArray(out) ? out.slice() : merged(out)
    }
    if (o.xref && isMap(out)) {
      define(out, 'x-ref', info.ref)
      ours.add(out)
      if (asApidef && null != value && 'object' === typeof value) {
        info.landing = value
        info.siblings = isMap(siblings) ? Object.keys(siblings) : []
        siteValue.set(out, info)
      }
    }
    info.value = out
    return out
  }

  // A site's landing as a pointer: the target's own text, unless the
  // pointer was read through a reference.
  const landingAt = (row: SiteFacts): string | null => {
    const land = row.landing
    if (undefined === land || !land.found) return null
    return (keyOf(land.doc) ?? '') + (undefined === land.through ? pointer(row.target!) : pointer(land.path!))
  }

  // A pointer with a step missing as written, read on in what a reference
  // names, is found only by this package's lenient rule: RFC 6901 finds
  // nothing there, and `strict` holds to that.
  const readThrough = (info: SiteInfo): boolean => !strict || undefined === info.row.landing!.through
  const MISSING = { found: false, cycle: false, value: undefined }

  // Under 'keep', the finished tree of each other document a site lands
  // in: see `keepCycles`.
  const folded = new Map<string, any>()

  const opts: FoldOptions = {
    op: OPS,
    // A document is known to the fold by the URI it was given under.
    doc: home.key,
    load: (key: string) => byKey.get(key)?.raw,
    positions: o.positions,
    maxDepth: limit,
    // The bag of every map is its location in the index, which has its
    // state in the object model, its base URI, its schema dialect, and
    // whether it is inside an extension the caller named. The starting
    // bag is no location, so the root is found from there.
    k: {},

    // The fold asks for the bag of each map on a path it needs, from the
    // root down, and gives the bag of the nearest map above it. A list
    // between the two has a location and no bag of its own.
    inherit: (site, _node, k) => {
      const path = site.path
      // Every document's root starts from the same bag, which is no
      // location: its own root is found from there.
      let loc: Loc | undefined = k instanceof Loc ? k : byKey.get(site.doc)?.root
      for (let i = undefined === loc ? 0 : loc.depth; i < path.length && undefined !== loc; i++) loc = index.child(loc, path[i])
      if (undefined === loc) throw new Error('resolve: no location in the index for ' + quoted(pointer(path)))
      return loc as any
    },

    // A map that owns `$ref` is a site where the object model puts a
    // Reference Object, a Schema Object or a Path Item. In data, or as a
    // name in a map of names, it is data, unless `slots` or `extensions`
    // say otherwise and its `$ref` is a string. The index has decided
    // that for every map. This is called once per location, in walk
    // order, so each site's record of what became of it is made here.
    recognise: (site: Site, op: Op) => {
      const loc = site.k as unknown as Loc
      if ('$dynamicRef' === op.src) return loc.dynamic
      const row = loc.site
      if (undefined === row) return false
      const info: SiteInfo = { seq: seq++, row, at: row.at, kind: row.kind, type: row.type, ref: row.ref, status: 'resolved' }
      const inDoc = keyOf(loc.doc)
      if (undefined !== inDoc) info.doc = inDoc
      if (null != site.token) info.token = site.token
      if (undefined !== row.why) info.why = row.why
      else {
        info.target = row.target
        if ('inline-once' === o.sharing) {
          // Two references that land on one location name one target,
          // however each is written.
          info.key = (pointers ? null : landingAt(row)) ?? (keyOf(row.targetDoc) ?? '') + pointer(row.target!)
          if (!firstFor.has(info.key)) firstFor.set(info.key, info.seq)
        }
      }
      infos.set(row, info)
      sites.push(info)
      return true
    },

    evaluate: (site, _op: Op, terms: any[]) => {
      const siblings = terms[1]
      const info = infos.get((site.k as unknown as Loc).site!)!
      if ('not-a-string' === info.why) {
        unresolvedHere(info, 'not-a-string')
        return site.plain()
      }
      if (null != info.why) {
        unresolvedHere(info, info.why)
        return asWritten(site.plain(), info, { cut: false, why: info.why })
      }
      // Under 'keep' the tree becomes a graph, and what a site lands on
      // is read from the finished tree: see `keepCycles`. The site holds a
      // placeholder until then.
      if ('keep' === o.cycles) {
        // A landing in another document is read off that document's
        // finished tree, so the document is folded, whole, the first time
        // a site lands in it. Every site in it holds a placeholder too.
        const far = info.row.landing?.doc
        if (undefined !== far && far !== home && !folded.has(far.key)) {
          folded.set(far.key, undefined)
          const whole = site.written([], far.key)
          if (whole.found) folded.set(far.key, whole.value)
        }
        const placeholder = Object.create(null)
        deferred.set(placeholder, { info, siblings, plain: site.plain() })
        return placeholder
      }
      // Under `refs: 'pointer'` the pointer is read as apidef reads it:
      // through each reference on its way, and no further than one left
      // as written.
      if (pointers) {
        const hit = site.at(info.target!)
        const via = hit.cycle ? undefined : throughLeft(info.target!)
        if (hit.cycle || true === via?.cut) {
          cutHere(info)
          return asWritten(site.plain(), info, { cut: true })
        }
        if (!hit.found || null != via) {
          unresolvedHere(info, 'not-found')
          return asWritten(site.plain(), info, { cut: false, why: 'not-found' })
        }
        return settleSite(info, hit.value, siblings, site.plain())
      }
      // Otherwise the index has read the pointer, on the document as
      // written, and the fold gives the value at the landing. A pointer
      // that comes back to a reference it is read through names nothing
      // but itself, and is cut as a cycle is.
      const land = info.row.landing!
      if (true === land.loop) {
        cutHere(info)
        return asWritten(site.plain(), info, { cut: true })
      }
      const hit = !land.found || !readThrough(info) ? MISSING : site.written(land.path!, land.doc!.key)
      if (hit.cycle) {
        cutHere(info)
        return asWritten(site.plain(), info, { cut: true })
      }
      if (!hit.found) {
        unresolvedHere(info, 'not-found')
        return asWritten(site.plain(), info, { cut: false, why: 'not-found' })
      }
      return settleSite(info, hit.value, siblings, site.plain())
    },
  }
  if (counting) {
    // The fold's steps follow the index's, and are held to the same bound
    // and the same check: it reports each step before it takes it.
    const before = steps
    opts.budget = {
      checkEveryN: 1,
      onCheck: (n: number) => {
        steps = before + n - 1
        tick()
      },
    }
  }

  // Under 'keep' every site held a placeholder while the fold ran, so the
  // fold made one pass over the document, top to bottom, and followed no
  // reference. Now that every container is built, each placeholder
  // becomes its site's value, in place, which makes the tree a graph
  // where a reference closes a cycle.
  //
  // Where a site lands is the index's: the finished tree is walked along
  // the landing's path, and a site on the way is stepped through as the
  // map it is written as. A placeholder landed on is settled first. One
  // met again while it is being settled is a loop of references with no
  // value in it, and is cut.
  //
  // Under `refs: 'pointer'` the pointer is read as apidef reads it: from
  // the root as written, one member at a time, with a placeholder met on
  // the way settled first, so a reference is followed before the next
  // member is read. A reference to an edge that was cut is cut, as is one
  // through such an edge to something that is there, and the walk ends at
  // a site left as written.
  //
  // (The fold can follow references itself, and under 'cut' it does. It
  // is not used for that here because a graph cannot be read off a tree
  // that is still being built: a container reached through a reference
  // while it is being folded has no value yet to share.)
  function keepCycles(root: any): any {
    const finals = new Map<object, any>()
    const busy = new Set<object>()
    const LOOP = Symbol('loop')
    // Where every walk starts: the root's own map, whatever `$ref` the
    // root has itself.
    const start = deferred.has(root) ? deferred.get(root)!.plain : root
    // The finished root of the document a landing is in, and where a
    // walk in it starts.
    const rootIn = (doc: DocFacts | undefined): any => (undefined === doc || doc === home ? root : folded.get(doc.key))
    const startIn = (doc: DocFacts | undefined): any => {
      const top = rootIn(doc)
      return null != top && deferred.has(top) ? deferred.get(top)!.plain : top
    }

    const finalOf = (ph: object): any => {
      if (finals.has(ph)) return finals.get(ph)
      // As the fold raises under 'cut' for a chain of references this
      // deep.
      if (limit <= busy.size) {
        const at = deferred.get(ph)!.info.at
        throw new ResolveError('openapi_depth', `resolve: references deeper than ${limit} at ${quoted(at)}`, at)
      }
      if (counting) tick()
      const d = deferred.get(ph)!
      busy.add(ph)
      let node: any = start
      // Whether the walk has passed through a reference that was cut.
      let throughCut = false
      const land = () => {
        if (deferred.has(node)) node = busy.has(node) ? LOOP : finalOf(node)
      }
      const landing = d.info.row.landing
      if (!pointers) {
        if (true === landing!.loop) node = LOOP
        else if (!landing!.found || !readThrough(d.info) || undefined === rootIn(landing!.doc)) node = NOTHING
        else {
          node = 0 === landing!.path!.length ? rootIn(landing!.doc) : startIn(landing!.doc)
          for (const seg of landing!.path!) {
            if (deferred.has(node)) node = deferred.get(node)!.plain
            node = stepInto(node, seg)
            if (NOTHING === node) break
          }
          land()
        }
      }
      // A reference to the whole document lands on the root itself, which
      // may be a site.
      if (pointers && 0 === d.info.target!.length) {
        node = root
        land()
      }
      for (const seg of pointers ? d.info.target! : []) {
        if (LOOP === node || NOTHING === node) break
        // The walk has come to a site left as written. The root is where
        // it starts, and is not on its way.
        const why = node !== start && null != node && 'object' === typeof node ? left.get(node) : undefined
        if (null != why) {
          if (pointers) {
            node = why.cut ? LOOP : NOTHING
            break
          }
          if (why.cut) throughCut = true
        }
        node = stepInto(node, seg)
        land()
      }
      // What lies past a cut reference is cut with it, where it is there
      // at all.
      if (throughCut && NOTHING !== node) node = LOOP
      busy.delete(ph)
      let v: any
      if (LOOP === node) {
        cutHere(d.info)
        v = asWritten(d.plain, d.info, { cut: true })
      } else if (NOTHING === node) {
        unresolvedHere(d.info, 'not-found')
        v = asWritten(d.plain, d.info, { cut: false, why: 'not-found' })
      } else {
        v = settleSite(d.info, node, d.siblings, d.plain)
      }
      finals.set(ph, v)
      return v
    }

    // Every site is settled, in document order. One inside members that
    // its own site dropped is in no value of the tree, and is settled all
    // the same, so that it is reported as what it is.
    const inOrder = [...deferred.keys()].sort((a, b) => deferred.get(a)!.info.seq - deferred.get(b)!.info.seq)
    for (const ph of inOrder) finalOf(ph)
    const top = deferred.has(root) ? finalOf(root) : root
    const seen = new Set<object>()
    const stack: any[] = [top]
    while (0 < stack.length) {
      const node = stack.pop()
      if (null == node || 'object' !== typeof node || seen.has(node)) continue
      seen.add(node)
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
          if (deferred.has(node[i])) node[i] = finalOf(node[i])
          stack.push(node[i])
        }
      } else if (isMap(node)) {
        for (const k of Object.keys(node)) {
          let v = node[k]
          if (deferred.has(v)) {
            v = finalOf(v)
            define(node, k, v)
          }
          stack.push(v)
        }
      }
    }
    return top
  }

  // Under `compat: 'apidef'` with `x-ref`, the order of a resolved site's
  // members is the order that @voxgig/apidef's resolving in place leaves,
  // one site after another as a walk of the document meets them: the
  // target's members, then the site's own that the target lacks, then
  // `x-ref`. A target that is itself a site already resolved by then
  // carries its own `x-ref`, and the new one takes that place; one not yet
  // met is read through to what it names, and carries none. A site here is
  // settled when its value is first needed, or once the walk is done, so
  // which of the two a walk in place would have seen is not known then.
  // This puts each site's members in that order afterwards. No value
  // changes, and no map is replaced.
  function orderAsWalked(root: any): void {
    // The order in which a walk of the finished graph first meets each
    // resolved site, which is the order a walk in place resolves them in.
    const met = new Map<object, number>()
    const seen = new Set<object>()
    const stack: any[] = [root]
    while (0 < stack.length) {
      const node = stack.pop()
      if (null == node || 'object' !== typeof node || seen.has(node)) continue
      seen.add(node)
      if (siteValue.has(node)) met.set(node, met.size)
      const inside = Array.isArray(node) ? node : Object.keys(node).map((k) => node[k])
      for (let i = inside.length - 1; 0 <= i; i--) stack.push(inside[i])
    }

    const union = (a: string[], b: string[]) => {
      const has = new Set(a)
      return [...a, ...b.filter((k) => !has.has(k))]
    }
    // The member names a landing gave a site met at `time`: its own, in
    // place, when it is a plain map or a site met earlier; else what it
    // named in turn, then its own other members.
    const namesOf = (landing: object, time: number, depth: number): string[] => {
      const site = siteValue.get(landing)
      const at = met.get(landing)
      if (null == site || (undefined !== at && at < time) || 1000 < depth) return Object.keys(landing)
      return union(namesOf(site.landing!, time, depth + 1), site.siblings!)
    }

    for (const [value, time] of met) {
      const site = siteValue.get(value)!
      const want = union(union(namesOf(site.landing!, time, 0), site.siblings!), ['x-ref'])
      const have = Object.keys(value)
      if (want.length !== have.length || want.some((k) => !own(value, k))) continue
      if (want.every((k, i) => k === have[i])) continue
      const values = want.map((k) => (value as any)[k])
      for (const k of have) delete (value as any)[k]
      want.forEach((k, i) => define(value, k, values[i]))
    }
  }

  let tree: any
  try {
    tree = fold(raw, opts)
    if ('keep' === o.cycles) tree = keepCycles(tree)
  } catch (err: any) {
    // The fold's bounds are this package's to name: nesting and
    // references past `maxDepth`, and its budget.
    const code = err instanceof FoldError ? FOLD_CODES[err.code] : undefined
    if (undefined === code) throw err
    const at = 'string' === typeof (err as any).at ? (err as any).at : ''
    throw new ResolveError(code, 'resolve: ' + String(err.message).replace(/^expr fold: /, ''), at)
  }
  if (asApidef && o.xref) orderAsWalked(tree)

  const named = connectionsOf(raw, mv, index, hasIds(mv), counting ? tick : undefined)
  const connections = [
    ...named.rows,
    ...mergeRows.sort((a, b) => a[0] - b[0]).map((r) => r[1]),
    ...reuseOf(raw, mv, index, refuse, counting ? tick : undefined),
  ]

  if ('copy' === o.sharing || 'inline-once' === o.sharing) {
    tree = unshare(tree, 'copy' === o.sharing ? o.budget : undefined)
  }

  const provenance: Provenance[] = sites.map((info) => {
    const row = info.row
    const target = null == info.target ? null : pointer(info.target)
    const land = pointers ? undefined : row.landing
    const p: Provenance = {
      at: info.at,
      ref: info.ref,
      kind: info.kind,
      type: info.type,
      target,
      landing: undefined === land || !land.found ? null : undefined === land.through ? target : pointer(land.path!),
      status: info.status,
    }
    if (undefined !== info.doc) p.doc = info.doc
    if (undefined !== row.targetDoc && row.targetDoc !== row.loc.doc && null !== target) p.targetDoc = row.targetDoc.key
    if (undefined !== land && undefined !== land.through) p.through = land.through.slice()
    if (undefined !== land && land.found && land.doc !== (row.targetDoc ?? row.loc.doc)) p.landingDoc = land.doc!.key
    if (undefined !== row.uri) {
      p.uri = row.uri
      if (undefined !== row.fragment) p.fragment = row.fragment
    }
    const conflict = pointers ? undefined : index.conflict(row)
    if (undefined !== conflict) p.conflict = conflict
    if (null != info.token) {
      p.row = info.token.rI
      p.col = info.token.cI
    }
    return p
  })

  const bySeq = <T>(rows: [number, T][]) => rows.sort((a, b) => a[0] - b[0]).map((r) => r[1])

  // The dialects the description declares: the root's, then each
  // schema's.
  const dialects: DialectUse[] = []
  if (!pointers) {
    for (const doc of index.docs) {
      if (!doc.described || !hasIds(doc.mv) || !isMap(doc.raw) || 'string' !== typeof doc.raw.jsonSchemaDialect) continue
      const d = dialectOf(doc.raw.jsonSchemaDialect)
      const use: DialectUse = { at: '/jsonSchemaDialect', dialect: doc.raw.jsonSchemaDialect, as: d.dialect.name, known: d.known }
      if (doc !== home) use.doc = doc.key
      dialects.push(use)
    }
    for (const use of index.dialects()) dialects.push(use)
  }

  return {
    tree,
    version: detected,
    documents: others.map((doc) => doc.key),
    unresolved: bySeq(unresolvedRows),
    provenance,
    cuts: bySeq(cutRows),
    connections,
    dataSlots: index.dataSlots,
    dialects,
    urls: named.urls,
  }

}

// What `resolveAll` takes beside the options of `resolve`.
type Loader = (uri: string) => unknown | Promise<unknown>

type ResolveAllOptions = ResolveOptions & {
  // Reads a document by its URI, which is absolute and in its normal
  // form: its tree, its text or its bytes, or `undefined` or `null` when
  // it has none, which leaves the references to it as written. It is the only
  // thing here that reaches outside the process, and what it may reach is
  // its own to bound: see the loaders of `@tabnas/openapi/loaders`.
  load: Loader
  // The most documents `load` may be asked for, whether or not it has
  // them. Default 10,000. Past it `resolveAll` raises `openapi_work`.
  maxDocuments?: number
  // The most rounds of loading. A round loads what the documents so far
  // name, so the count is how deep one document names another. Default
  // 64. Past it `resolveAll` raises `openapi_work`.
  maxRounds?: number
}

// An option of `resolve` that only `resolveAll` gives: stop once the
// index is built, and say which documents it names and does not have.
const WANTED = Symbol('wanted')

// Resolve a description that is several documents, loading each document
// it names. The documents are found in rounds: the set so far is indexed,
// the documents it names and does not have are loaded, and so on until a
// round names nothing new. A document is asked for once. The description
// is then resolved as `resolve` resolves it, given those documents.
//
// What a description can make this cost is bounded, with no option
// given. `load` is asked for `maxDocuments` documents at most, counting
// the ones it does not have, since asking is what a loader's work is.
// The rounds are `maxRounds` at most: each indexes every document so
// far, so a chain of documents that each name the next would cost the
// square of its length. And the texts `load` gives are read together as
// one text would be: see `partReader`.
async function resolveAll(raw: any, options: ResolveAllOptions): Promise<ResolveResult> {
  const { load, maxDocuments = 10_000, maxRounds = 64, ...rest } = options
  if ('function' !== typeof load) throw new TypeError('resolveAll: load must be a function, not ' + quoted(load))
  for (const [name, n] of [
    ['maxDocuments', maxDocuments],
    ['maxRounds', maxRounds],
  ] as [string, number][]) {
    if (!((Number.isInteger(n) && 0 < n) || Infinity === n)) {
      throw new TypeError(`resolveAll: ${name} must be a whole number above 0, not ` + quoted(n))
    }
  }
  // Each document is read once, here, so that a round does not read the
  // texts of the rounds before it again.
  const read = partReader(rest.parse)
  const documents: Record<string, unknown> = {}
  for (const [name, doc] of Object.entries(rest.documents ?? {})) {
    documents[name] = 'string' === typeof doc || doc instanceof Uint8Array ? read(doc, name) : doc
  }
  const asked = new Set<string>()
  for (let round = 0; ; round++) {
    // A round is never strict: a document it lacks is what it is for.
    const found = resolve(raw, { ...rest, documents, strict: false, [WANTED]: true } as any) as unknown as { wanted: string[] }
    const fresh = found.wanted.filter((uri) => !asked.has(uri))
    if (0 === fresh.length) break
    if (maxRounds <= round) {
      throw new ResolveError(
        'openapi_work',
        `resolveAll: the documents name one another more than ${maxRounds} rounds of loading deep, at ${quoted(fresh[0])}`,
        fresh[0],
      )
    }
    for (const uri of fresh) {
      if (maxDocuments <= asked.size) {
        throw new ResolveError('openapi_work', `resolveAll: more than ${maxDocuments} documents to load, at ${quoted(uri)}`, uri)
      }
      asked.add(uri)
      const doc = await load(uri)
      // Null is how many a loader says it has nothing, as undefined is.
      if (null == doc) continue
      documents[uri] = 'string' === typeof doc || doc instanceof Uint8Array ? read(doc, uri) : doc
    }
  }
  return resolve(raw, { ...rest, documents })
}

// A tree with nothing shared: every map and list copied, so a value two
// sites share is written twice. With a budget, the copy stops with
// `openapi_budget` once its compact JSON would pass that many bytes.
function unshare(root: any, budget?: number): any {
  let bytes = 0
  const counting = undefined !== budget
  const count = (n: number) => {
    bytes += n
    if (budget! < bytes) {
      throw new ResolveError('openapi_budget', `resolve: the copy passes its budget of ${budget} bytes`)
    }
  }
  const copy = (v: any): any => {
    if (Array.isArray(v)) {
      if (counting) count(1 + Math.max(1, v.length))
      return v.map(copy)
    }
    if (isMap(v)) {
      const names = Object.keys(v)
      if (counting) count(1 + Math.max(1, names.length))
      const out = Object.create(null)
      for (const k of names) {
        if (counting) count(utf8(JSON.stringify(k)) + 1)
        define(out, k, copy(v[k]))
      }
      return out
    }
    if (counting) count(utf8(JSON.stringify(v) ?? 'null'))
    return v
  }
  return copy(root)
}

export { resolve, resolveAll, ResolveError }

export type {
  Cut,
  Cycles,
  Kind,
  Loader,
  Provenance,
  ResolveAllOptions,
  ResolveOptions,
  ResolveResult,
  Sharing,
  Status,
  Unresolved,
  Why,
}
