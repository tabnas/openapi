/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// The resolver: a derived tree with every `$ref` resolved, built as an
// OpenAPI vocabulary over @tabnas/expr's fold. Everything generic (the
// walk, the bag inherited down the tree, one result per location, cycles,
// the report) is expr's; everything OpenAPI knows is here: which `$ref`
// maps are references (the object model), the base URI and dialect each
// map is read under, URI resolution, fragments, anchors, and the sibling
// rules by version and kind. The raw tree is never changed.
//
// One document for now: a reference into another document is reported
// as external and left as written. The plan is
// docs/design/implementation-plan.md, Phase 2.

import { fold } from '@tabnas/expr'
import type { FoldOptions, FoldReport, Op, Path, Positions, Site } from '@tabnas/expr'

import { slot, step, rootState } from './model'
import type { ModelVersion } from './model'
import { version as readVersion } from './oas-version'

// The base a description is read under when the caller gives no retrieval
// URI and the document has no `$self`: a fixed URN, as the specification
// suggests for a document with no location, so that fragment-only
// references still resolve.
const DEFAULT_BASE = 'urn:uuid:0c2b4f0e-8f9d-4c7a-9a52-6d1e3b7a4f10'

// Why a reference was left as written.
type Why =
  | 'not-a-string'
  | 'bad-fragment'
  | 'not-found'
  | 'no-anchor'
  | 'external'
  | 'unsupported-dialect'

// The error codes `strict` raises, by reason.
const STRICT: Partial<Record<Why, string>> = {
  'not-a-string': 'openapi_ref_type',
  'bad-fragment': 'openapi_pointer',
  'not-found': 'openapi_unresolved',
  'no-anchor': 'openapi_unresolved',
  external: 'openapi_unresolved',
}

type ResolveOptions = {
  // The version to read the description as. 'auto', the default, reads
  // the root's openapi or swagger member.
  version?: 'auto' | ModelVersion
  // The URI the description was retrieved from: the base of its relative
  // references when it has no `$self`.
  retrievalUri?: string
  // Raise an error, rather than report it, for a reference that names
  // nothing, a malformed fragment, and a `$ref` whose value is not a
  // string.
  strict?: boolean
  // Each container's opening token, from expr's recordPositions, so that
  // provenance carries a row and column.
  positions?: Positions
  // The deepest the fold walks, nesting and references together.
  maxDepth?: number
}

// A reference left as written, and why.
type Unresolved = { at: string; ref: unknown; why: Why }

// One reference site, resolved or not.
type Provenance = {
  at: string
  ref: string
  kind: 'reference' | 'schema' | 'pathItem'
  // What a Reference Object stands for: response, parameter, and so on.
  type: string | null
  target: string
  resolved: boolean
  row?: number
  col?: number
}

// A reference left as written because its target was still being built:
// the edge that closes a cycle.
type Cut = { at: string; ref: string; target: string }

type ResolveResult = {
  tree: any
  version: '2.0' | '3.0' | '3.1' | '3.2' | 'unknown'
  unresolved: Unresolved[]
  provenance: Provenance[]
  cuts: Cut[]
  dynamic: FoldReport['dynamic']
  // `$ref` maps the object model types as data: an example payload, an
  // extension value, a property named `$ref`.
  dataSlots: number
}

class ResolveError extends Error {
  code: string
  at: string
  ref: unknown
  constructor(code: string, at: string, ref: unknown, why: Why) {
    super(`${why}: the reference at ${quoted(at)} (${quoted(ref)})`)
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

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

function isMap(value: unknown): value is Record<string, any> {
  if (null == value || 'object' !== typeof value || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return null === proto || Object.prototype === proto
}

// RFC 6901.
function pointer(path: readonly (string | number)[]): string {
  return path.map((p) => '/' + String(p).replace(/~/g, '~0').replace(/\//g, '~1')).join('')
}

// A URI fragment as JSON Pointer segments: percent-decoded whole first,
// then split, then `~1` and `~0` (RFC 6901 section 6). Null when it is not
// a well-formed pointer: bad percent-encoding, or a `~` not followed by 0
// or 1.
function pointerParts(fragment: string): string[] | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(fragment)
  } catch {
    return null
  }
  if ('' === decoded) return []
  if (!decoded.startsWith('/')) return null
  const parts = decoded.slice(1).split('/')
  if (parts.some((p) => /~(?![01])/.test(p))) return null
  return parts.map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'))
}

// A plain-name fragment, as JSON Schema 2020-12 defines an anchor.
const ANCHOR = /^[A-Za-z_][-A-Za-z0-9._]*$/

// RFC 3986 section 5.2: reference resolution against a base URI.
type Uri = {
  scheme?: string
  authority?: string
  path: string
  query?: string
  fragment?: string
}

function parseUri(u: string): Uri {
  const m = /^(?:([^:/?#]+):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/s.exec(u)!
  return { scheme: m[1], authority: m[2], path: m[3], query: m[4], fragment: m[5] }
}

function removeDots(input: string): string {
  let out = ''
  while (0 < input.length) {
    if (input.startsWith('../')) input = input.slice(3)
    else if (input.startsWith('./')) input = input.slice(2)
    else if (input.startsWith('/./')) input = input.slice(2)
    else if ('/.' === input) input = '/'
    else if (input.startsWith('/../') || '/..' === input) {
      input = '/' + input.slice(4)
      out = out.slice(0, Math.max(0, out.lastIndexOf('/')))
    } else if ('.' === input || '..' === input) input = ''
    else {
      const seg = /^\/?[^/]*/.exec(input)![0]
      out += seg
      input = input.slice(seg.length)
    }
  }
  return out
}

function resolveUri(base: string, ref: string): string {
  const r = parseUri(ref)
  const b = parseUri(base)
  const t: Uri = { path: '' }
  if (undefined !== r.scheme) {
    t.scheme = r.scheme
    t.authority = r.authority
    t.path = removeDots(r.path)
    t.query = r.query
  } else {
    if (undefined !== r.authority) {
      t.authority = r.authority
      t.path = removeDots(r.path)
      t.query = r.query
    } else {
      if ('' === r.path) {
        t.path = b.path
        t.query = undefined !== r.query ? r.query : b.query
      } else {
        const merged = r.path.startsWith('/')
          ? r.path
          : undefined !== b.authority && '' === b.path
            ? '/' + r.path
            : b.path.slice(0, b.path.lastIndexOf('/') + 1) + r.path
        t.path = removeDots(merged)
        t.query = r.query
      }
      t.authority = b.authority
    }
    t.scheme = b.scheme
  }
  t.fragment = r.fragment
  return (
    (undefined !== t.scheme ? t.scheme + ':' : '') +
    (undefined !== t.authority ? '//' + t.authority : '') +
    t.path +
    (undefined !== t.query ? '?' + t.query : '') +
    (undefined !== t.fragment ? '#' + t.fragment : '')
  )
}

const withoutFragment = (u: string) => u.replace(/#.*$/s, '')

function fragmentOf(u: string): string | undefined {
  const i = u.indexOf('#')
  return -1 === i ? undefined : u.slice(i + 1)
}

// JSON Schema identifiers ($id, $anchor, $dynamicAnchor) exist in OpenAPI
// from 3.1, and $self from 3.2.
const hasIds = (v: ModelVersion) => '3.1' === v || '3.2' === v
const hasSelf = (v: ModelVersion) => '3.2' === v

// The schema dialects whose `$ref` semantics the resolver applies: the
// OpenAPI dialects of 3.1 and 3.2, and JSON Schema 2020-12 itself.
function supportedDialect(dialect: string): boolean {
  return (
    dialect.startsWith('https://spec.openapis.org/oas/3.1/dialect/') ||
    dialect.startsWith('https://spec.openapis.org/oas/3.2/dialect/') ||
    'https://json-schema.org/draft/2020-12/schema' === dialect
  )
}

const DEFAULT_DIALECT: Record<string, string> = {
  '3.1': 'https://spec.openapis.org/oas/3.1/dialect/base',
  '3.2': 'https://spec.openapis.org/oas/3.2/dialect/base',
}

// A Reference Object's summary and description override the target's
// only where the target's type has the field. 3.2 adds summary to the
// Response and Tag objects and description to the Media Type object.
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
    mediaType: ['description'],
    tag: ['summary', 'description'],
  },
}

// A new map without a prototype, with the members of each given map in
// turn: defined, never assigned, so a member named `__proto__` is data.
function merged(...maps: Record<string, any>[]): Record<string, any> {
  const out = Object.create(null)
  for (const m of maps) {
    for (const k of Object.keys(m)) {
      Object.defineProperty(out, k, { value: m[k], enumerable: true, writable: true, configurable: true })
    }
  }
  return out
}

// The `$id`, `$anchor` and `$dynamicAnchor` targets of the document, in
// Schema Object positions only (an `$anchor` inside example data is data),
// and only in the versions that have them.
function indexIds(root: any, docUri: string, mv: ModelVersion): Map<string, Path> {
  const ids = new Map<string, Path>()
  if (!hasIds(mv)) return ids
  const stack: [any, Path, string, string][] = [[root, [], rootState(), docUri]]
  while (0 < stack.length) {
    const [node, path, state, inherited] = stack.pop()!
    let base = inherited
    if (Array.isArray(node)) {
      for (let i = node.length - 1; 0 <= i; i--) {
        const next = step(mv, state, i)
        if ('data' !== next) stack.push([node[i], [...path, i], next, base])
      }
      continue
    }
    if (!isMap(node)) continue
    if ('schema' === slot(mv, state).kind) {
      if ('string' === typeof node.$id) {
        base = resolveUri(base, node.$id)
        ids.set(withoutFragment(base), path)
      }
      for (const a of ['$anchor', '$dynamicAnchor']) {
        if ('string' === typeof node[a]) ids.set(withoutFragment(base) + '#' + node[a], path)
      }
    }
    const names = Object.keys(node)
    for (let i = names.length - 1; 0 <= i; i--) {
      const next = step(mv, state, names[i])
      if ('data' !== next) stack.push([node[names[i]], [...path, names[i]], next, base])
    }
  }
  return ids
}

// The operators the fold recognises: two key operators, by member name.
const OPS = {
  ref: { key: true, src: '$ref' },
  dynamicRef: { key: true, src: '$dynamicRef', dynamic: true },
}

// Resolve every `$ref` of a raw tree, from `parse`, into a new tree. The
// raw tree is never changed; every site naming one target shares one
// result; an edge that closes a cycle is cut and left as written.
function resolve(raw: any, options: ResolveOptions = {}): ResolveResult {
  const detected = readVersion(raw).version
  const asked = options.version ?? 'auto'
  const mv: ModelVersion =
    'auto' !== asked ? asked : 'unknown' === detected ? '3.2' : (detected as ModelVersion)
  const strict = true === options.strict

  const retrieval = options.retrievalUri ?? DEFAULT_BASE
  const docBase =
    hasSelf(mv) && isMap(raw) && 'string' === typeof raw.$self
      ? resolveUri(retrieval, raw.$self)
      : retrieval
  const entry = withoutFragment(docBase)
  const retrieved = withoutFragment(retrieval)
  const rootDialect =
    hasIds(mv) && isMap(raw) && 'string' === typeof raw.jsonSchemaDialect
      ? raw.jsonSchemaDialect
      : (DEFAULT_DIALECT[mv] ?? '')
  const ids = indexIds(raw, entry, mv)

  const unresolved: Unresolved[] = []
  const provenance: Provenance[] = []
  const cuts: Cut[] = []
  let dynamic: FoldReport['dynamic'] = []
  let dataSlots = 0

  const leave = (site: Site, ref: unknown, why: Why) => {
    const at = pointer(site.path)
    const code = STRICT[why]
    if (strict && null != code) throw new ResolveError(code, at, ref, why)
    unresolved.push({ at, ref, why })
  }

  const kindOf = (state: string): 'reference' | 'schema' | 'pathItem' | null => {
    const s = slot(mv, state)
    if ('schema' === s.kind) return 'schema'
    if ('refable' === s.kind || 'reference' === state) return 'reference'
    if ('object' === s.kind && 'pathItem' === s.type) return 'pathItem'
    return null
  }

  const opts: FoldOptions = {
    op: OPS,
    doc: entry,
    positions: options.positions,
    maxDepth: options.maxDepth,
    k: { state: null, depth: 0, base: docBase, dialect: rootDialect },

    // The bag each map passes down: its state in the object model, the
    // depth it was worked out at, its base URI and its schema dialect.
    // Worked out from the map's own ancestors, whatever reached it first.
    inherit: (site, node, k) => {
      let state: string
      if (0 === site.path.length || null == k.state) {
        state = rootState()
        for (const m of site.path) state = step(mv, state, m)
      } else {
        state = k.state
        for (const m of site.path.slice(k.depth)) state = step(mv, state, m)
      }
      let base: string = k.base
      let dialect: string = k.dialect
      if (hasIds(mv) && 'schema' === slot(mv, state).kind && isMap(node)) {
        if ('string' === typeof node.$schema) dialect = node.$schema
        if ('string' === typeof node.$id) base = resolveUri(base, node.$id)
      }
      return { state, depth: site.path.length, base, dialect }
    },

    // A map that owns `$ref` is a site only where the object model puts a
    // Reference Object, a Schema Object or a Path Item: in data, or as a
    // name in a map of names, it is data.
    recognise: (site, op: Op) => {
      const kind = kindOf(site.k.state)
      if ('$dynamicRef' === op.src) return 'schema' === kind && hasIds(mv)
      if (null == kind) dataSlots++
      return null != kind
    },

    evaluate: (site, op: Op, terms: any[]) => {
      const [ref, siblings] = terms
      const kind = kindOf(site.k.state)!
      const s = slot(mv, site.k.state)
      if ('string' !== typeof ref) {
        leave(site, ref, 'not-a-string')
        return site.plain()
      }
      if ('schema' === kind && hasIds(mv) && !supportedDialect(site.k.dialect)) {
        leave(site, ref, 'unsupported-dialect')
        return site.node
      }

      const abs = resolveUri(site.k.base, ref)
      const doc = withoutFragment(abs)
      const fragment = fragmentOf(abs)
      let start: Path
      if (ids.has(doc)) start = ids.get(doc)!
      else if (doc === entry || doc === retrieved) start = []
      else {
        leave(site, ref, 'external')
        return site.node
      }

      let target: Path
      if (undefined === fragment || '' === fragment) {
        target = start
      } else if (fragment.startsWith('/') || /^%2f/i.test(fragment)) {
        const parts = pointerParts(fragment)
        if (null == parts) {
          leave(site, ref, 'bad-fragment')
          return site.node
        }
        target = [...start, ...parts]
      } else if (hasIds(mv) && ANCHOR.test(fragment)) {
        const named = ids.get(doc + '#' + fragment)
        if (null == named) {
          leave(site, ref, 'no-anchor')
          return site.node
        }
        target = named
      } else {
        leave(site, ref, 'bad-fragment')
        return site.node
      }

      const hit = site.at(target)
      const at = pointer(site.path)
      const record: Provenance = {
        at,
        ref,
        kind,
        type: 'reference' === kind ? s.type : 'pathItem' === kind ? 'pathItem' : 'schema',
        target: pointer(target),
        resolved: hit.found && !hit.cycle,
      }
      if (null != site.token) {
        record.row = site.token.rI
        record.col = site.token.cI
      }
      provenance.push(record)
      if (!hit.found) {
        leave(site, ref, 'not-found')
        return site.node
      }
      if (hit.cycle) {
        cuts.push({ at, ref, target: pointer(target) })
        return site.node
      }
      return combine(hit.value, siblings, kind, record.type)
    },

    report: (r) => {
      dynamic = r.dynamic
    },
  }

  // The sibling rule, by the site's kind and the version.
  const combine = (hit: any, siblings: any, kind: string, type: string | null) => {
    if (!isMap(hit) || !isMap(siblings) || 0 === Object.keys(siblings).length) return hit
    // A Path Item's $ref is a field of the Path Item in every version,
    // Swagger 2.0 included: the fields merge.
    if ('pathItem' === kind) return merged(hit, siblings)
    // A 2.0 JSON Reference and a 3.0 Reference Object or schema $ref:
    // siblings are ignored.
    if ('2.0' === mv || '3.0' === mv) return hit
    // 3.1 and later: a Schema Object's $ref is an applicator, and its
    // siblings apply beside it.
    if ('schema' === kind) {
      const rest = merged(siblings)
      const allOf = Array.isArray(rest.allOf) ? rest.allOf : []
      delete rest.allOf
      return merged({ allOf: [hit, ...allOf] }, rest)
    }
    const fields = (OVERRIDE[mv] ?? {})[type ?? ''] ?? []
    const override: Record<string, any> = {}
    for (const f of fields) if (own(siblings, f)) override[f] = siblings[f]
    return 0 === Object.keys(override).length ? hit : merged(hit, override)
  }

  const tree = fold(raw, opts)
  return { tree, version: detected, unresolved, provenance, cuts, dynamic, dataSlots }
}

export { resolve, ResolveError, resolveUri, pointer }

export type { ResolveOptions, ResolveResult, Unresolved, Provenance, Cut, Why }
