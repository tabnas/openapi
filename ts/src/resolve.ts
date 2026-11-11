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
// One document for now: a reference into another document is reported
// as external and left as written. The plan is
// docs/design/implementation-plan.md, Phase 2.

import { fold } from '@tabnas/expr'
import type { FoldOptions, Op, Positions, Site } from '@tabnas/expr'

import { connectionsOf, reuseOf } from './connections'
import type { Connection } from './connections'
import { slot, step, rootState, walkModel } from './model'
import type { ModelVersion } from './model'
import { version as readVersion } from './oas-version'
import {
  ANCHOR,
  NOTHING,
  define,
  fragmentOf,
  isMap,
  merged,
  own,
  pointer,
  pointerParts,
  resolveUri,
  stepInto,
  withoutFragment,
} from './uri'
import type { Path } from './uri'

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
  | 'non-object-target'
  | 'unsupported-dialect'

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
  // Raise an error, rather than report it, for a reference that names
  // nothing, a malformed fragment, and a `$ref` whose value is not a
  // string.
  strict?: boolean
  // Each container's opening token, from expr's recordPositions, so that
  // provenance carries a row and column.
  positions?: Positions
  // The deepest the fold walks, nesting and references together.
  maxDepth?: number
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
  // Write `x-ref`, the reference as written, beside every site, resolved
  // or not. Each site then holds its own copy.
  xref?: boolean
  // Extension members whose values hold references to resolve, though
  // the object model reads an extension as data: Stripe's
  // x-expansionResources, say.
  extensions?: string[]
  // A named set of the options above. 'apidef' resolves as @voxgig/apidef
  // does: { siblings: 'merge', xref: true, sharing: 'site', cycles: 'keep',
  // slots: 'all', targets: 'object' }. Options given beside it win.
  compat?: 'apidef'
}

// The kind of a site: what the object model says its position holds, or
// data for a site that `slots` or `extensions` made one.
type Kind = 'reference' | 'schema' | 'pathItem' | 'data'

// What a site's place in the tree holds: its target's value, the
// reference as written because it names nothing or closes a cycle, or the
// reference as written because 'inline-once' put the value at an earlier
// site.
type Status = 'resolved' | 'unresolved' | 'cut' | 'kept'

// A reference left as written, and why.
type Unresolved = { at: string; ref: unknown; why: Why }

// One reference site, whatever became of it.
type Provenance = {
  at: string
  ref: unknown
  kind: Kind
  // What a Reference Object stands for: response, parameter, and so on.
  type: string | null
  // The location it names, when it names one in this document.
  target: string | null
  status: Status
  row?: number
  col?: number
}

// A reference left as written because resolving it would close a cycle:
// the edge that closes one, or a reference to such an edge.
type Cut = { at: string; ref: string; target: string }

type ResolveResult = {
  tree: any
  version: '2.0' | '3.0' | '3.1' | '3.2' | 'unknown'
  unresolved: Unresolved[]
  provenance: Provenance[]
  cuts: Cut[]
  connections: Connection[]
  // `$ref` maps the object model types as data: an example payload, an
  // extension value, a property named `$ref`.
  dataSlots: number
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

const PRESETS: Record<string, ResolveOptions> = {
  apidef: { siblings: 'merge', xref: true, sharing: 'site', cycles: 'keep', slots: 'all', targets: 'object' },
}

const CHOICES: Record<string, string[]> = {
  sharing: ['share', 'site', 'inline-once', 'copy'],
  cycles: ['cut', 'keep'],
  siblings: ['spec', 'merge'],
  slots: ['spec', 'all'],
  targets: ['any', 'object'],
}

type Settled = Required<Omit<ResolveOptions, 'positions' | 'maxDepth' | 'budget' | 'retrievalUri' | 'compat'>> &
  Pick<ResolveOptions, 'positions' | 'maxDepth' | 'budget' | 'retrievalUri'>

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
  return o
}

// The `$id`, `$anchor` and `$dynamicAnchor` targets of the document, in
// Schema Object positions only (an `$anchor` inside example data is data),
// and only in the versions that have them.
function indexIds(root: any, docUri: string, mv: ModelVersion): Map<string, Path> {
  const ids = new Map<string, Path>()
  if (!hasIds(mv)) return ids
  walkModel<string>(mv, root, docUri, (node, path, state, base) => {
    if (!isMap(node) || 'schema' !== slot(mv, state).kind) return base
    let mine = base
    if ('string' === typeof node.$id) {
      mine = resolveUri(base, node.$id)
      ids.set(withoutFragment(mine), path)
    }
    for (const a of ['$anchor', '$dynamicAnchor']) {
      if ('string' === typeof node[a]) ids.set(withoutFragment(mine) + '#' + node[a], path)
    }
    return mine
  })
  return ids
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

// One site, from the moment the walk first meets it.
type SiteInfo = {
  seq: number
  at: string
  kind: Kind
  type: string | null
  ref: unknown
  target?: Path
  // Why it cannot resolve, when that is known before its target is
  // folded.
  why?: Why
  status: Status
  token?: { rI: number; cI: number }
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

  const retrieval = o.retrievalUri ?? DEFAULT_BASE
  const docBase =
    hasSelf(mv) && isMap(raw) && 'string' === typeof raw.$self ? resolveUri(retrieval, raw.$self) : retrieval
  const entry = withoutFragment(docBase)
  const retrieved = withoutFragment(retrieval)
  const rootDialect =
    hasIds(mv) && isMap(raw) && 'string' === typeof raw.jsonSchemaDialect
      ? raw.jsonSchemaDialect
      : (DEFAULT_DIALECT[mv] ?? '')
  const ids = indexIds(raw, entry, mv)

  const infos = new Map<string, SiteInfo>()
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
  // Under 'keep', the placeholder each edge that closed a cycle holds
  // until the fold is done.
  const deferred = new Map<object, { info: SiteInfo; siblings: any; plain: any }>()
  let seq = 0
  let dataSlots = 0

  // A URI reference, against a base: the location it names in this
  // document, or why it names none here.
  const locate = (ref: string, base: string): { target?: Path; why?: Why } => {
    const abs = resolveUri(base, ref)
    const doc = withoutFragment(abs)
    const fragment = fragmentOf(abs)
    let start: Path
    if (ids.has(doc)) start = ids.get(doc)!
    else if (doc === entry || doc === retrieved) start = []
    else return { why: 'external' }
    if (undefined === fragment || '' === fragment) return { target: start }
    if (fragment.startsWith('/') || /^%2f/i.test(fragment)) {
      const parts = pointerParts(fragment)
      return null == parts ? { why: 'bad-fragment' } : { target: [...start, ...parts] }
    }
    if (hasIds(mv) && ANCHOR.test(fragment)) {
      const named = ids.get(doc + '#' + fragment)
      return null == named ? { why: 'no-anchor' } : { target: named }
    }
    return { why: 'bad-fragment' }
  }

  const kindOf = (state: string): Kind | null => {
    const s = slot(mv, state)
    if ('schema' === s.kind) return 'schema'
    if ('refable' === s.kind || 'reference' === state) return 'reference'
    if ('object' === s.kind && 'pathItem' === s.type) return 'pathItem'
    return null
  }

  const unresolvedHere = (info: SiteInfo, why: Why) => {
    const code = STRICT[why]
    if (strict && null != code) {
      throw new ResolveError(code, `${why}: the reference at ${quoted(info.at)} (${quoted(info.ref)})`, info.at, info.ref)
    }
    unresolvedRows.push([info.seq, { at: info.at, ref: info.ref, why }])
    info.status = 'unresolved'
  }

  const cutHere = (info: SiteInfo) => {
    cutRows.push([info.seq, { at: info.at, ref: info.ref as string, target: pointer(info.target!) }])
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
    // A Path Item's $ref is a field of the Path Item in every version,
    // Swagger 2.0 included: the fields merge, and a field on both sides,
    // which the specification leaves undefined, is reported.
    if ('pathItem' === info.kind) {
      const both = Object.keys(siblings).filter((k) => own(hit, k))
      if (0 < both.length) {
        mergeRows.push([
          info.seq,
          { kind: 'pathItemMerge', at: info.at, name: info.ref as string, found: true, target: pointer(info.target!), fields: both },
        ])
      }
      return merged(hit, siblings)
    }
    if ('merge' === o.siblings) return merged(hit, siblings)
    // A 2.0 JSON Reference, a 3.0 Reference Object or schema $ref, and a
    // reference in data: siblings are ignored.
    if ('data' === info.kind || '2.0' === mv || '3.0' === mv) return hit
    // 3.1 and later: a Schema Object's $ref is an applicator, and its
    // siblings apply beside it.
    if ('schema' === info.kind) {
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
    if ('inline-once' === o.sharing && firstFor.get(pointer(info.target!)) !== info.seq) {
      info.status = 'kept'
      return asWritten(plain, info)
    }
    info.status = 'resolved'
    let out = combine(body(value), siblings, info)
    if (siteShape && out === value && (isMap(out) || Array.isArray(out))) {
      out = Array.isArray(out) ? out.slice() : merged(out)
    }
    if (o.xref && isMap(out)) {
      define(out, 'x-ref', info.ref)
      ours.add(out)
    }
    return out
  }

  const opts: FoldOptions = {
    op: OPS,
    doc: entry,
    positions: o.positions,
    maxDepth: o.maxDepth,
    k: { state: null, depth: 0, base: docBase, dialect: rootDialect, ext: false },

    // The bag each map passes down: its state in the object model, the
    // depth it was worked out at, its base URI, its schema dialect, and
    // whether it is inside an extension the caller named. Worked out from
    // the map's own ancestors, whatever reached it first.
    inherit: (site, node, k) => {
      const from = 0 === site.path.length || null == k.state ? 0 : k.depth
      let state: string = 0 === from ? rootState() : k.state
      let ext: boolean = 0 === from ? false : k.ext
      for (const m of site.path.slice(from)) {
        state = step(mv, state, m)
        if (!ext && extensions.has(String(m))) ext = true
      }
      let base: string = k.base
      let dialect: string = k.dialect
      if (hasIds(mv) && 'schema' === slot(mv, state).kind && isMap(node)) {
        if ('string' === typeof node.$schema) dialect = node.$schema
        if ('string' === typeof node.$id) base = resolveUri(base, node.$id)
      }
      return { state, depth: site.path.length, base, dialect, ext }
    },

    // A map that owns `$ref` is a site where the object model puts a
    // Reference Object, a Schema Object or a Path Item. In data, or as a
    // name in a map of names, it is data, unless `slots` or `extensions`
    // say otherwise and its `$ref` is a string. Called once per location,
    // in walk order, so each site's record is made here.
    recognise: (site: Site, op: Op) => {
      const kind = kindOf(site.k.state)
      if ('$dynamicRef' === op.src) return 'schema' === kind && hasIds(mv)
      const ref = (site.node as any).$ref
      let k: Kind | null = kind
      if (null == k) {
        dataSlots++
        if ('string' !== typeof ref || ('all' !== o.slots && true !== site.k.ext)) return false
        k = 'data'
      }
      const s = slot(mv, site.k.state)
      const info: SiteInfo = {
        seq: seq++,
        at: pointer(site.path),
        kind: k,
        type: 'reference' === k ? s.type : 'pathItem' === k || 'schema' === k ? k : null,
        ref,
        status: 'resolved',
      }
      if (null != site.token) info.token = site.token
      if ('string' !== typeof ref) info.why = 'not-a-string'
      else if ('schema' === k && hasIds(mv) && !supportedDialect(site.k.dialect)) info.why = 'unsupported-dialect'
      else {
        const where = locate(ref, site.k.base)
        if (null != where.why) info.why = where.why
        else {
          info.target = where.target
          const key = pointer(where.target!)
          if ('inline-once' === o.sharing && !firstFor.has(key)) firstFor.set(key, info.seq)
        }
      }
      infos.set(info.at, info)
      sites.push(info)
      return true
    },

    evaluate: (site, _op: Op, terms: any[]) => {
      const siblings = terms[1]
      const info = infos.get(pointer(site.path))!
      if ('not-a-string' === info.why) {
        unresolvedHere(info, 'not-a-string')
        return site.plain()
      }
      if (null != info.why) {
        unresolvedHere(info, info.why)
        return asWritten(site.plain(), info, { cut: false, why: info.why })
      }
      const hit = site.at(info.target!)
      if (!hit.found) {
        unresolvedHere(info, 'not-found')
        return asWritten(site.plain(), info, { cut: false, why: 'not-found' })
      }
      if (hit.cycle || deferred.has(hit.value)) {
        if ('keep' === o.cycles) {
          const placeholder = Object.create(null)
          deferred.set(placeholder, { info, siblings, plain: site.plain() })
          return placeholder
        }
        cutHere(info)
        return asWritten(site.plain(), info, { cut: true })
      }
      return settleSite(info, hit.value, siblings, site.plain())
    },
  }

  // Under 'keep', each edge that closed a cycle held a placeholder while
  // the fold ran; now every target is built, each placeholder becomes its
  // site's value, in place, which makes the tree a cyclic graph. A target
  // that is itself a placeholder is settled first, and one met again while
  // it is being settled is a loop of references, which is cut.
  function keepCycles(root: any): any {
    const finals = new Map<object, any>()
    const busy = new Set<object>()
    const LOOP = Symbol('loop')

    const finalOf = (ph: object): any => {
      const done = finals.get(ph)
      if (undefined !== done || finals.has(ph)) return done
      const d = deferred.get(ph)!
      busy.add(ph)
      let node: any = root
      const land = () => {
        if (deferred.has(node)) node = busy.has(node) ? LOOP : finalOf(node)
      }
      land()
      for (const seg of d.info.target!) {
        if (LOOP === node || NOTHING === node) break
        node = stepInto(node, seg)
        land()
      }
      busy.delete(ph)
      let v: any
      if (LOOP === node || NOTHING === node) {
        cutHere(d.info)
        v = asWritten(d.plain, d.info, { cut: true })
      } else {
        v = settleSite(d.info, node, d.siblings, d.plain)
      }
      finals.set(ph, v)
      return v
    }

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

  let tree = fold(raw, opts)
  if (0 < deferred.size) tree = keepCycles(tree)

  const connections = [
    ...connectionsOf(raw, tree, mv, docBase, locate, hasIds(mv)),
    ...mergeRows.sort((a, b) => a[0] - b[0]).map((r) => r[1]),
    ...reuseOf(tree, mv),
  ]

  if ('copy' === o.sharing || 'inline-once' === o.sharing) {
    tree = unshare(tree, 'copy' === o.sharing ? o.budget : undefined)
  }

  const provenance: Provenance[] = sites.map((info) => {
    const p: Provenance = {
      at: info.at,
      ref: info.ref,
      kind: info.kind,
      type: info.type,
      target: null == info.target ? null : pointer(info.target),
      status: info.status,
    }
    if (null != info.token) {
      p.row = info.token.rI
      p.col = info.token.cI
    }
    return p
  })

  const bySeq = <T>(rows: [number, T][]) => rows.sort((a, b) => a[0] - b[0]).map((r) => r[1])

  return {
    tree,
    version: detected,
    unresolved: bySeq(unresolvedRows),
    provenance,
    cuts: bySeq(cutRows),
    connections,
    dataSlots,
  }

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

export { resolve, ResolveError }

export type { Cut, Cycles, Kind, Provenance, ResolveOptions, ResolveResult, Sharing, Status, Unresolved, Why }
