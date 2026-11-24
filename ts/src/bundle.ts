/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// Bundling: a description in several documents, written as one. The
// result is the description's own document with what it names in the
// others brought in, and every reference that named another document
// naming a place in the bundle. Nothing is resolved: a reference is
// still a reference, and the bundle resolves to what the documents
// resolve to.
//
// Where a target goes follows from what names it:
//
// - The target of a reference that the object model types goes among
//   the components of its type, under a name of its own: a schema in
//   `components.schemas`, a response in `components.responses`. In 2.0
//   that is `definitions`, `parameters` or `responses`.
// - Where the description's version has no place for the type, the
//   target is written in the place of the first reference to it, and
//   every later reference names that place: a Path Item in 3.0, and
//   anything that a `$ref` in data names under `slots: 'all'`.
// - A schema that declares its own identifier, with `$id`, is a schema
//   resource. It is brought in whole and keeps its identifier, so every
//   reference that names it by that identifier still does, and the
//   references inside it are read against it as before.
// - A reference inside such a resource cannot name a place in the
//   bundle by a fragment alone, since a fragment is read in the
//   resource. What it names outside is copied into the resource's own
//   `$defs`.
//
// What moves is read again where it arrives, and three things decide
// what content means in a place: the base URI, the schema dialect in
// force, and what the object model reads there. Each is kept. A
// relative URI is written again to name what it named. A schema that
// is read under another dialect than its new place is given its own as
// `$schema`. And a target goes where things of its type go, so that
// what was a schema is read as a schema.
//
// The references are read by the site index (site-index.ts), over the
// set of documents, so a reference is rewritten by where it lands, on
// the documents as written: through a `$id`, an anchor, or a pointer
// that passes through another reference. A reference that names nothing
// in the set is left to name what it named, and listed.

import { frontOf, gather, quoted, settle } from './resolve'
import type { Front, Loader, ResolveOptions, ResolveResult } from './resolve'
import { slot, step } from './model'
import type { ModelVersion } from './model'
import { EXTRA_FACTOR, pathOf } from './site-index'
import type { Landing, Loc, SiteFacts } from './site-index'
import {
  PLAIN_NAME,
  define,
  fragmentOf,
  hierarchical,
  isMap,
  merged,
  normalizeUri,
  own,
  pointer,
  relativeTo,
  resolveUri,
  withoutFragment,
} from './uri'
import type { Path } from './uri'

// The options of `resolve` that say how the documents are read. What is
// asked of a resolved tree is not asked of a bundle.
const OPTIONS = [
  'version',
  'retrievalUri',
  'documents',
  'parse',
  'maxDepth',
  'maxSteps',
  'onCheck',
  'checkEveryN',
  'slots',
  'extensions',
] as const

type BundleOptions = Pick<ResolveOptions, (typeof OPTIONS)[number]>

type BundleAllOptions = BundleOptions & {
  // Gives a document by its URI, as `resolveAll` takes it.
  load: Loader
  maxDocuments?: number
  maxRounds?: number
}

// One target that was brought into the bundle.
type Embedded = {
  // Where the bundle has it.
  at: string
  // The document it came from, by the URI that document was given
  // under, and where it is there.
  doc: string
  from: string
  // How it was brought in: among the components, in the `$defs` of a
  // schema resource, or in the place of the reference that names it.
  as: 'component' | 'defs' | 'inline'
}

// What the bundle could not make whole, and why. A reference that
// names nothing has the reason `resolve` gives it, and `loop` where its
// pointer comes back to itself. The others:
//
//   cycle     a target that would be written inside itself without end
//   outside   what a mapping value or an `operationRef` names is in a
//             document of the set, and the bundle has no place for it
//   dynamic   a `$dynamicRef` or a `$recursiveRef` in content that
//             moved, where what it names first did not move with it
//   anchor    an anchor that was left out, because the place it moved
//             to has one of that name
//   id        an identifier that was left out, because it named the
//             resource it was in, and where it is now it would start one
//
// `ref` is the text as the documents have it.
type Left = { at: string; ref: unknown; why: string }

// A schema that was given a `$schema`: it moved to a place that is read
// under another dialect than the one it was written for.
type Declared = { at: string; dialect: string }

type BundleResult = {
  // The one document.
  tree: any
  version: ResolveResult['version']
  // The other documents that were read, each by its URI.
  documents: string[]
  embedded: Embedded[]
  left: Left[]
  dialects: Declared[]
}

// Where the components of each type are, from 3.0.
const SECTION: Record<string, string> = {
  schema: 'schemas',
  response: 'responses',
  parameter: 'parameters',
  example: 'examples',
  requestBody: 'requestBodies',
  header: 'headers',
  securityScheme: 'securitySchemes',
  link: 'links',
  callback: 'callbacks',
  pathItem: 'pathItems',
  mediaType: 'mediaTypes',
}

// And in 2.0, at the root.
const SECTION_20: Record<string, string> = { schema: 'definitions', parameter: 'parameters', response: 'responses' }

const ABSOLUTE = /^[A-Za-z][A-Za-z0-9+.-]*:/

// A component's name, as every version reads one.
const NAME = /^[A-Za-z0-9._-]+$/

// A space of the bundle: the description's own, or a schema resource in
// it. A fragment alone names a place in the space it is read in.
type Space = {
  // The resource, or null for the description's own space.
  res: Loc | null
  // The copy of the resource's root, and where the bundle has it.
  node: any
  at: Path
  // The base URI and the schema dialect in force at its root.
  base: string
  dialect: string
  // What it has of the other documents, each by where it came from, as
  // a path from its root: a map or a list by its location, and a plain
  // value by its document and pointer.
  defs: Map<Loc, Path>
  values: Map<string, Path>
  // The anchors that content from elsewhere brought into it.
  anchors: Set<string>
}

// How the object model reads a place of the bundle: the state it has
// there, in the model of one version.
type Dest = { state: string; v: ModelVersion }

// A target that has a place and is still to be copied there. `dd` is
// the schema dialect in force at that place, and `ds` how the object
// model reads it.
type Unit = { node: any; loc: Loc | undefined; space: Space; at: Path; rel: Path; dd: string; ds: Dest }

// What names a target: a site's `$ref`, or a mapping value.
type From = {
  // Where it is written, with its text and the base URI that is read
  // against.
  loc: Loc
  text: string
  base: string
  // The type it expects of what it names.
  expect: string | null
  // Whether the target can stand in its place, and whether it would
  // stand there alone, with nothing of the reference's own laid over.
  inline: boolean
  pure: boolean
  // Whether it is a mapping value. No reference types what one names.
  mapping: boolean
}

// A string that is read once every target has its place.
type Later = { what: 'operationRef' | 'dynamic'; out: any; key: string | number; text: string; loc: Loc; space: Space; at: Path }

// A pointer as a URI fragment: a `%` or a `#` of a member name is
// written as its escape, which a reader of the fragment reads back.
const fragment = (path: Path): string => pointer(path).replace(/%/g, '%25').replace(/#/g, '%23')

// The text of a relative URI reference that was written to be read
// against one base, for another: it names what it named. An absolute
// one names that wherever it is, and so does a relative one that reads
// the same against both.
function rebase(text: string, from: string, to: string): string {
  if (from === to || ABSOLUTE.test(text) || !hierarchical(from)) return text
  const named = resolveUri(from, text)
  return resolveUri(to, text) === named ? text : relativeTo(to, named)
}

function only(options: Record<string, unknown>, who: string): BundleOptions {
  if (null == options || 'object' !== typeof options) throw new TypeError(who + ': options must be an object')
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(options)) {
    if (undefined === options[k]) continue
    if (!(OPTIONS as readonly string[]).includes(k)) {
      throw new TypeError(`${who}: no option ${quoted(k)}; it takes ${OPTIONS.join(', ')}`)
    }
    out[k] = options[k]
  }
  return out as BundleOptions
}

// A discriminator's mapping value may be all that names a schema: one
// in a document with no version, which no `$ref` reaches. The index
// types such a place by the references that land on it, and a mapping
// value is none, so the schema is plain data to it, and the references
// in the schema are unread. The bundle is then written again on an
// index that is told of each such schema, at most this many times: a
// schema that is typed so may hold a mapping value of its own.
const MAPPING_ROUNDS = 8

// The description as the index is given it, where mapping values name
// schemas that nothing types: with a reference to each among its schema
// components, which the bundle does not have.
function withTypers(raw: any, typers: string[]): any {
  if (0 === typers.length || !isMap(raw)) return raw
  const components = isMap(raw.components) ? raw.components : Object.create(null)
  const extra = Object.create(null)
  typers.forEach((uri, i) => define(extra, '\u0000' + i, { $ref: uri }))
  const schemas = merged(isMap(components.schemas) ? components.schemas : Object.create(null), extra)
  return merged(raw, { components: merged(components, { schemas }) })
}

// Write a description and the documents given with it as one document.
// Neither the raw tree nor any document is changed.
function bundle(raw: any, options: BundleOptions = {}): BundleResult {
  let o = settle(only(options as Record<string, unknown>, 'bundle'), 'bundle')
  const typers: string[] = []
  for (let round = 0; ; round++) {
    const front = frontOf(withTypers(raw, typers), o, 'bundle')
    const { result, untyped } = bundleOn(raw, front, 'all' === o.slots)
    // What was told of and is still not typed cannot be.
    const fresh = [...untyped].filter((uri) => !typers.includes(uri))
    if (0 === fresh.length || MAPPING_ROUNDS === round) return result
    typers.push(...fresh)
    // The documents are read once: what was given as text is given
    // again as it was read.
    if (0 === round && 0 < front.others.length) {
      const documents = Object.create(null)
      for (const doc of front.others) define(documents, doc.key, doc.raw)
      o = { ...o, documents }
    }
  }
}

// One bundle, on one index of the documents. `untyped` is what mapping
// values name that the index gives no type.
function bundleOn(raw: any, front: Front, all: boolean): { result: BundleResult; untyped: Set<string> } {
  const { detected, mv, others, limit, counting, tick, refuse, index } = front
  const untyped = new Set<string>()
  const home = index.docs[0]
  const rootIsMap = isMap(raw)

  // The base URI a location's own identifier is read against.
  const aboveOf = (loc: Loc): string => (undefined === loc.parent ? loc.doc.uri : loc.parent.base)

  // Whether a schema's identifier names the resource it is already in,
  // as the index reads one: it is no new resource there.
  const namesItself = (loc: Loc): boolean => {
    const rules = loc.rules
    const node = loc.raw
    if (undefined === rules || !isMap(node) || (rules.refAlone && 'string' === typeof node.$ref)) return false
    const id = node[rules.id]
    if ('string' !== typeof id) return false
    const above = aboveOf(loc)
    const abs = normalizeUri(resolveUri(above, id))
    const name = fragmentOf(abs)
    if (rules.idAnchor && undefined !== name && PLAIN_NAME.test(name)) return false
    return withoutFragment(abs) === above
  }

  // A schema resource starts where a schema's identifier gives it a base
  // URI of its own. The root of another document that names itself by
  // that document's URI is one too: it says what it is, and is brought
  // whole as any other.
  const isResource = (loc: Loc): boolean =>
    loc.base !== aboveOf(loc) || (undefined === loc.parent && loc.doc !== home && namesItself(loc))

  // The schema resource a location is in: the nearest one, at or above
  // it. Null in the plain content of its document.
  const resources = new Map<Loc, Loc | null>()
  const resourceOf = (loc: Loc): Loc | null => {
    const had = resources.get(loc)
    if (undefined !== had) return had
    let found: Loc | null = null
    for (let p: Loc | undefined = loc; undefined !== p; p = p.parent) {
      const known = p === loc ? undefined : resources.get(p)
      if (undefined !== known) {
        found = known
        break
      }
      if (isResource(p)) {
        found = p
        break
      }
    }
    resources.set(loc, found)
    return found
  }

  // The outermost resource of its document that a resource is in.
  const topOf = (res: Loc): Loc => {
    let top = res
    for (let p = top.parent; undefined !== p; p = top.parent) {
      const outer = resourceOf(p)
      if (null === outer) break
      top = outer
    }
    return top
  }

  const sectionOf = (type: string | null): Path | null => {
    if (null === type || !rootIsMap) return null
    if ('2.0' === mv) return own(SECTION_20, type) ? [SECTION_20[type]] : null
    if (!own(SECTION, type) || 'data' === step(mv, 'components', SECTION[type])) return null
    return ['components', SECTION[type]]
  }

  const expectOf = (site: SiteFacts): string | null =>
    'schema' === site.kind ? 'schema' : 'pathItem' === site.kind ? 'pathItem' : 'reference' === site.kind ? site.type : null

  // The type a landing has of its own: the model's, or the one that the
  // first reference to land on it gave it. A target goes where things of
  // its type go, whatever names it, so that it is read there as it was.
  const typeAt = (land: Landing): string | null => {
    const loc = land.loc
    if (undefined === loc || 'typed' !== loc.known) return null
    const s = slot(loc.doc.mv, loc.state)
    return 'schema' === s.kind ? 'schema' : 'object' === s.kind || 'refable' === s.kind ? s.type : null
  }

  // What a state holds, by name: the type of an object, `schema`, `map`
  // or `list` for a container with no type of its own, and `data`.
  const holds = (d: Dest): string => {
    if ('data' === d.state) return 'data'
    const s = slot(d.v, d.state)
    if ('schema' === s.kind) return 'schema'
    if ('object' === s.kind || 'refable' === s.kind) return s.type ?? 'map'
    return 'list' === s.kind ? 'list' : 'data'
  }

  // The type that a reference in a place expects, as the model reads
  // the place.
  const expectAt = (d: Dest): string | null => {
    if ('data' === d.state) return null
    const s = slot(d.v, d.state)
    if ('schema' === s.kind) return 'schema'
    if ('refable' === s.kind || 'reference' === d.state) return s.type
    return 'object' === s.kind && 'pathItem' === s.type ? 'pathItem' : null
  }

  // How the model reads the place a path names, from a place it reads.
  const destFrom = (start: Dest, path: Path): Dest => {
    let state = start.state
    for (const seg of path) {
      if ('data' === state) break
      state = step(start.v, state, seg)
    }
    return { state, v: start.v }
  }
  const rootDest: Dest = { state: index.root.state, v: mv }

  // A name for a target: the last step to it, or for a whole document
  // the name of its file. A component's name has letters, digits, `.`,
  // `-` and `_`.
  const nameOf = (land: Landing): string => {
    const path = land.path!
    let name: string
    if (0 < path.length) name = String(path[path.length - 1])
    else {
      const last = withoutFragment(land.doc!.key).replace(/[?].*$/s, '').replace(/\/+$/, '').split('/').pop() ?? ''
      name = last.replace(/\.[A-Za-z0-9]+$/, '')
      try {
        name = decodeURIComponent(name)
      } catch {
        // A name that is no percent-encoding is taken as it is.
      }
    }
    name = name.replace(/[^A-Za-z0-9._-]/g, '_')
    return '' === name ? 'bundled' : name
  }

  // The landing that is a whole location.
  const whole = (loc: Loc): Landing => ({ found: true, doc: loc.doc, path: pathOf(loc), node: loc.raw, loc })

  // What the entry has as written at a path, where it has a map there.
  const entryAt = (path: Path): any => {
    let node = raw
    for (const seg of path) node = isMap(node) && own(node, String(seg)) ? node[seg] : undefined
    return node
  }

  // The description's schema components, as written: a mapping value
  // that is one of their names is a name.
  const schemasAt = sectionOf('schema')
  const named = null === schemasAt ? undefined : entryAt(schemasAt)

  // One writing of the bundle. `tops` is given for a second one: the
  // targets that were found to hold other targets, each with the type
  // it was brought in as, so that such a target is brought once and
  // what is in it is named there.
  const write = (tops: Map<Loc, string | null> | undefined) => {
    const embedded: Embedded[] = []
    const left: Left[] = []
    const dialects: Declared[] = []
    // The targets put among the description's components, each with the
    // type the reference to it expects.
    const units = new Map<Loc, string | null>()

    // A copy is made of each target once, but for one written in the
    // place of its reference where that place is not its alone. Those
    // can multiply, so the copying is held to the index's allowance.
    let copied = 0
    const work = (at: Path) => {
      if (counting) tick()
      if (index.allowance < ++copied) {
        refuse(
          'openapi_work',
          'bundling this description takes more than ' + EXTRA_FACTOR + ' times the work of reading its documents once',
          pointer(at),
        )
      }
    }

    // The names taken in each map that targets are put in: the ones the
    // map has as written, and the ones given since.
    const taken = new Map<string, Set<string>>()
    const unique = (holder: string, has: any, want: string): string => {
      let names = taken.get(holder)
      if (undefined === names) taken.set(holder, (names = new Set(isMap(has) ? Object.keys(has) : [])))
      let name = want
      for (let n = 2; names.has(name); n++) name = want + '_' + n
      names.add(name)
      return name
    }

    const rootSpace: Space = {
      res: null,
      node: undefined,
      at: [],
      base: home.uri,
      dialect: home.rootDialect,
      defs: new Map(),
      values: new Map(),
      anchors: new Set(),
    }
    const queue: Unit[] = []
    const later: Later[] = []
    // The references left because their target was being written around
    // them, each with its row of `left`: the target may get a place of
    // its own later in the writing.
    const around: { out: any; loc: Loc; row: Left }[] = []
    // The targets being written in the place of a reference, and the
    // places being written that a reference's own fields will be laid
    // over: such a place is no target's alone, nor is it for a target
    // that is written there because the first is a reference to it.
    const inlining = new Set<Loc>()
    const overlaid = new Set<string>()

    // Whether a location is where it was written, in its own space: in
    // the description's own content, or in a schema resource that the
    // bundle has whole.
    const settledAt = (loc: Loc, space: Space): boolean =>
      resourceOf(loc) === space.res && (null !== space.res || loc.doc === home)

    // Where a space already has a location: itself, or inside a target
    // that it has.
    const within = (space: Space, loc: Loc): Path | undefined => {
      for (let p: Loc | undefined = loc; undefined !== p; p = p.parent) {
        const got = space.defs.get(p)
        if (undefined !== got) return [...got, ...pathOf(loc).slice(pathOf(p).length)]
      }
      return undefined
    }

    // Put a target in a map of the space, to be copied there, and give
    // where it will be, from the space's root. A target is put once.
    const put = (land: Landing, space: Space, section: Path, has: any, expect: string | null): Path => {
      const loc = land.loc
      const key = land.doc!.key + '#' + pointer(land.path!)
      const had = undefined === loc ? space.values.get(key) : space.defs.get(loc)
      if (undefined !== had) return had
      const name = unique(pointer([...space.at, ...section]), has, nameOf(land))
      const rel = [...section, name]
      if (undefined === loc) space.values.set(key, rel)
      else space.defs.set(loc, rel)
      if (undefined !== loc && space === rootSpace) units.set(loc, expect)
      const ds = destFrom(null === space.res ? rootDest : { state: space.res.state, v: space.res.doc.mv }, rel)
      queue.push({ node: land.node, loc, space, at: [...space.at, ...rel], rel, dd: space.dialect, ds })
      embedded.push({
        at: pointer([...space.at, ...rel]),
        doc: land.doc!.key,
        from: pointer(land.path!),
        as: null === space.res ? 'component' : 'defs',
      })
      return rel
    }

    // On the second writing: bring the target that holds a location,
    // where one was found to.
    const brought = (loc: Loc): void => {
      if (undefined === tops) return
      let top: Loc | undefined
      for (let p: Loc | undefined = loc; undefined !== p; p = p.parent) if (tops.has(p)) top = p
      if (undefined === top || rootSpace.defs.has(top)) return
      const expect = tops.get(top)!
      const section = sectionOf(expect)
      if (null !== section) put(whole(top), rootSpace, section, entryAt(section), expect)
    }

    // Why a landing is itself a reference that names nothing, if it is
    // one, through as many references as it takes. A reference to such
    // a one is left as that one is, as resolving leaves it, so nothing
    // is written in its place. References that come round to one of
    // themselves name something: each other.
    const danglingAt = (land: Landing): string | undefined => {
      const seen = new Set<Loc>()
      for (let loc = land.loc; undefined !== loc && undefined !== loc.site; ) {
        if (seen.has(loc)) return undefined
        seen.add(loc)
        const next = index.landing(loc.site)
        if (!next.found) return true === next.loop ? 'loop' : (loc.site.why ?? 'not-found')
        loc = next.loc
      }
      return undefined
    }

    // Write a target in the place of the reference that names it. Where
    // it stands there alone, that place is the target's from then on.
    const inline = (land: Landing, at: Path, dd: string, pure: boolean, ds: Dest): { inline: any } | { left: string } => {
      const loc = land.loc
      const place = pointer(at)
      const lays = !pure && !overlaid.has(place)
      if (undefined !== loc) {
        if (inlining.has(loc)) return { left: 'cycle' }
        if (limit <= inlining.size) {
          refuse('openapi_depth', 'targets written one inside another deeper than ' + limit, place)
        }
        inlining.add(loc)
        if (pure && !overlaid.has(place)) rootSpace.defs.set(loc, at)
      }
      if (lays) overlaid.add(place)
      let value: any
      try {
        value = copy(land.node, loc, rootSpace, at, dd, ds)
      } finally {
        if (undefined !== loc) inlining.delete(loc)
        if (lays) overlaid.delete(place)
      }
      embedded.push({ at: place, doc: land.doc!.key, from: pointer(land.path!), as: 'inline' })
      return { inline: value }
    }

    // Whether what a mapping value names can be brought in as a schema.
    // A map that the index gives no type would be read as a schema where
    // it is brought to, with references in it that nothing has read. It
    // is asked to be typed, and this writing leaves it.
    const schemaAt = (land: Landing): boolean => {
      const loc = land.loc
      if (undefined === loc || !isMap(loc.raw)) return true
      if ('unknown' !== loc.known) return 'schema' === slot(loc.doc.mv, loc.state).kind
      const path = land.path!
      untyped.add(land.doc!.key + (0 === path.length ? '' : '#' + fragment(path)))
      return false
    }

    // The new text of what names a target, or the value to write in its
    // place.
    const refer = (
      from: From,
      land: Landing,
      space: Space,
      at: Path,
      dd: string,
      ds: Dest,
    ): { ref: string } | { inline: any } | { left: string } => {
      const text = from.text
      // What names it is where it was written, in its own space. A
      // fragment alone is then read in the space it was written for,
      // which has every place it had: it stands. Where its pointer is
      // read on through another reference, that one is written to name
      // what it named.
      const settled = settledAt(from.loc, space)
      if (settled && text.startsWith('#')) return { ref: text }
      const lloc = land.loc
      const path = land.path!
      // A value that is no map or list is in the container above it, but
      // for a document that is one such value.
      const hl = lloc ?? (0 === path.length ? undefined : index.landingAt(path.slice(0, -1), land.doc).loc)
      if (undefined === hl && 0 < path.length) return { left: 'not-found' }
      const rest: Path = undefined === lloc && 0 < path.length ? [path[path.length - 1]] : []

      if (undefined !== hl) {
        const lres = resourceOf(hl)
        if (null !== lres) {
          // It lands in a schema resource, which the bundle has whole
          // and by its own identifier.
          const rel = [...pathOf(hl).slice(pathOf(lres).length), ...rest]
          if (lres.doc !== home) {
            brought(lres)
            if (undefined === within(rootSpace, lres)) {
              if (null === schemasAt) return { left: 'outside' }
              put(whole(topOf(lres)), rootSpace, schemasAt, named, 'schema')
            }
          }
          if (space.res === lres) return { ref: '#' + fragment(rel) }
          // The text may name the resource by its identifier already,
          // and then it stands. But for a relative one in the
          // description's own space that named another document: that
          // is read against where the bundle is, which the identifier
          // need not follow, and a pointer names the resource wherever
          // the bundle is.
          if (
            settled &&
            withoutFragment(normalizeUri(resolveUri(from.base, text))) === lres.base &&
            (lres.doc === home || null !== space.res || ABSOLUTE.test(text))
          ) {
            return { ref: text }
          }
          // From the description's own space a pointer reaches it, and
          // from another resource its identifier does.
          const there = lres.doc === home ? pathOf(lres) : within(rootSpace, lres)
          if (null === space.res && undefined !== there) return { ref: '#' + fragment([...there, ...rel]) }
          const uri = lres.base + (0 === rel.length ? '' : '#' + fragment(rel))
          return { ref: ABSOLUTE.test(text) ? uri : relativeTo(space.base, uri) }
        }
      }

      if (null === space.res) {
        // In the description's own space. A place in the description
        // itself is where it was: a reference that names the document
        // by its URI is written as the pointer alone.
        if (undefined !== hl) {
          if (hl.doc === home) return { ref: '#' + fragment([...pathOf(hl), ...rest]) }
          brought(hl)
          const got = within(rootSpace, hl)
          if (undefined !== got) return { ref: '#' + fragment([...got, ...rest]) }
        }
        const expect = typeAt(land) ?? from.expect
        const section = sectionOf(expect)
        if (null === section) {
          if (!from.inline) return { left: 'outside' }
          const why = danglingAt(land)
          return undefined === why ? inline(land, at, dd, from.pure, ds) : { left: why }
        }
        if (from.mapping && !schemaAt(land)) return { left: 'outside' }
        return { ref: '#' + fragment(put(land, rootSpace, section, entryAt(section), expect)) }
      }

      // It is named from inside a schema resource, and is plain content
      // outside it, which a fragment cannot reach from there: it is
      // copied into the resource's own definitions.
      const got = undefined === hl ? undefined : within(space, hl)
      if (undefined !== got) return { ref: '#' + fragment([...got, ...rest]) }
      if (from.mapping && !schemaAt(land)) return { left: 'outside' }
      const key = undefined !== space.res.rules && space.res.rules.refAlone ? 'definitions' : '$defs'
      const has = isMap(space.res.raw) ? space.res.raw[key] : undefined
      return { ref: '#' + fragment(put(land, space, [key], has, 'schema')) }
    }

    // A discriminator's mapping value: the name of one of the
    // description's schemas, or a URI reference to a schema.
    const mapped = (v: string, holder: Loc, space: Space, at: Path): string => {
      if (isMap(named) && own(named, v)) return v
      const settled = settledAt(holder, space)
      const where = index.locate(v, holder.base)
      const land = undefined === where.target ? undefined : index.landingAt(where.target, where.doc)
      if (undefined === land || !land.found) {
        // What reads as a name is one, wherever it is.
        if (NAME.test(v)) return v
        left.push({ at: pointer(at), ref: v, why: where.why ?? 'not-found' })
        return settled ? v : rebase(v, holder.base, space.base)
      }
      const from: From = { loc: holder, text: v, base: holder.base, expect: 'schema', inline: false, pure: true, mapping: true }
      const to = refer(from, land, space, at, '', rootDest)
      if ('ref' in to) return to.ref
      if ('left' in to) left.push({ at: pointer(at), ref: v, why: to.left })
      return settled ? v : rebase(v, holder.base, space.base)
    }

    // A string the object model types, in content that the bundle has:
    // what it names is named from where it is now.
    const leaf = (v: string, holder: Loc, k: string | number, space: Space, at: Path, out: any, as: Dest): string => {
      const state = as.state
      if ('data' === state) return v
      if ('mapping' === state) return mapped(v, holder, space, at)
      if ('locator:operation' === state) {
        later.push({ what: 'operationRef', out, key: k, text: v, loc: holder, space, at })
        return v
      }
      const s = slot(as.v, state)
      if ('url' !== s.kind) return v
      // A URL that is relative to the description is read against the
      // base URI in force, and a server's against the URI its document
      // was retrieved from. One with variables has no form to read
      // until they are given, and stands as written.
      if ('description' === s.type) return rebase(v, holder.base, space.base)
      if ('retrieval' === s.type && !/[{}]/.test(v)) return rebase(v, holder.doc.key, home.key)
      return v
    }

    // Copy what a location holds, as written, into a space of the
    // bundle. `dd` is the schema dialect in force where the copy goes,
    // and `ds` how the object model reads the place.
    //
    // What is copied was read where it was written, by the model or by
    // the references that land on it, and is read again where it goes.
    // The two can differ for what was brought in. Content that nothing
    // gave a type may go where the model gives it one: an operation in a
    // file of its own, which a reference in data names. What it holds
    // is then read as the model reads it there, so a string in it is a
    // URL or a mapping value by where it now is, and a reference in it
    // expects the type of its place. And content may go where the model
    // reads data, with a part in it that a reference gave a type. That
    // part would be data there too, and a reference in it one in data.
    // Under `slots: 'all'`, where a reference in data is read, it goes
    // among the components of its type, and a reference to it stands in
    // its place.
    function copy(node: any, loc: Loc | undefined, sp: Space, at: Path, dd: string, ds: Dest): any {
      if (null === node || 'object' !== typeof node) return node
      work(at)
      const child = (k: string | number, v: any): Loc | undefined =>
        undefined === loc || null === v || 'object' !== typeof v ? undefined : index.child(loc, k)
      // A schema resource starts here: what is in it is read against its
      // own identifier, wherever the bundle has it.
      const starts = undefined !== loc && isMap(node) && isResource(loc)
      // Plain content that is not where it was written: of another
      // document, or copied into a resource's definitions.
      const moved = undefined !== loc && !starts && !settledAt(loc, sp)
      // How a member is read where it was written, and where it goes.
      // Content that has the type of its new place is read there as it
      // was, by the model of its own version.
      const was: Dest | undefined = undefined !== loc && 'data' !== loc.state ? { state: loc.state, v: loc.doc.mv } : undefined
      const keeps = undefined !== was && 'data' !== ds.state && holds(was) === holds(ds)
      const destOf = (k: string | number): Dest =>
        'data' === ds.state ? ds : destFrom(keeps ? was! : ds, [k])
      const below = (k: string | number, v: any, space: Space, dialect: string): any => {
        const kid = child(k, v)
        const d = destOf(k)
        if (all && moved && 'data' === d.state && undefined !== kid && 'typed' === kid.known) {
          const land = whole(kid)
          const type = typeAt(land)
          const section = sectionOf(type)
          // A reference that names nothing stands where it is: one to it
          // would be left as it is left, with another text.
          if (null !== section && undefined === danglingAt(land)) {
            const ref = Object.create(null)
            define(ref, '$ref', '#' + fragment(put(land, rootSpace, section, entryAt(section), type)))
            return ref
          }
        }
        return copy(v, kid, space, [...at, k], dialect, d)
      }
      // A string is what the documents read it as, and where they give
      // it no type, what the bundle will.
      const text = (v: string, k: string | number, space: Space, into: any): string =>
        undefined === loc ? v : leaf(v, loc, k, space, [...at, k], into, undefined !== was ? destFrom(was, [k]) : destOf(k))
      if (Array.isArray(node)) {
        const list: any[] = []
        for (let i = 0; i < node.length; i++) {
          const v = node[i]
          list.push('string' === typeof v ? text(v, i, sp, list) : below(i, v, sp, dd))
        }
        return list
      }
      if (!isMap(node)) return node

      const out: Record<string, any> = Object.create(null)
      let space = sp
      const rules = loc?.rules
      if (starts) {
        space = { res: loc!, node: out, at, base: loc!.base, dialect: loc!.dialect, defs: new Map(), values: new Map(), anchors: new Set() }
      }
      // Whether the schema's identifier and anchors are read at all.
      const reads = undefined !== rules && !(rules.refAlone && 'string' === typeof node.$ref)

      // A schema is read under the dialect it declares, else the one in
      // force where it is. One that was read under another than its new
      // place has in force says so, so that it is read as it was.
      let inside = dd
      if (undefined !== loc && undefined !== rules && '' !== loc.dialect) {
        if (!own(node, '$schema') && normalizeUri(loc.dialect) !== normalizeUri(dd)) {
          define(out, '$schema', loc.dialect)
          dialects.push({ at: pointer(at), dialect: loc.dialect })
        }
        inside = loc.dialect
      }

      for (const k of Object.keys(node)) {
        const v = node[k]
        if ('string' !== typeof v) {
          define(out, k, below(k, v, space, inside))
          continue
        }
        if (moved && reads) {
          const name = rules!.anchors.includes(k) ? v : rules!.idAnchor && k === rules!.id && v.startsWith('#') ? v.slice(1) : undefined
          if (undefined !== name && PLAIN_NAME.test(name)) {
            // An anchor of content that moved becomes one of the space
            // it is in. One that the space has already would take that
            // one's place, so it is left out.
            if (space.anchors.has(name) || undefined !== index.locate('#' + name, space.base).target) {
              left.push({ at: pointer([...at, k]), ref: v, why: 'anchor' })
              continue
            }
            space.anchors.add(name)
          } else if (k === rules!.id && withoutFragment(normalizeUri(resolveUri(space.base, v))) !== space.base) {
            // An identifier that named the resource it was in. Where it
            // is now it would start a resource, and what is below it
            // would be read against that.
            left.push({ at: pointer([...at, k]), ref: v, why: 'id' })
            continue
          }
        }
        define(out, k, text(v, k, space, out))
      }

      // A resource's identifier is read against the base URI above it.
      // Where that is another than it was, a relative one is written to
      // name the same resource from there.
      if (starts && undefined !== rules && 'string' === typeof node[rules.id]) {
        define(out, rules.id, rebase(node[rules.id], aboveOf(loc!), sp.base))
      }

      // A reference that is left to evaluation, in content that moved.
      if (undefined !== loc && loc.dynamic && moved && undefined !== rules && null !== rules.dynamic) {
        const text = node[rules.dynamic]
        if ('string' === typeof text) later.push({ what: 'dynamic', out, key: rules.dynamic, text, loc, space, at })
      }

      const site = loc?.site
      if (undefined === site) return out
      const settled = settledAt(loc!, space)
      // A reference the bundle has as it was written still names what
      // it named, where it is read against another base.
      const stands = (why: string) => {
        left.push({ at: pointer(at), ref: site.ref, why })
        if (!settled && 'string' === typeof site.ref) define(out, '$ref', rebase(site.ref, site.base, space.base))
      }
      const land = index.landing(site)
      if (!land.found) {
        stands(true === land.loop ? 'loop' : (site.why ?? 'not-found'))
        return out
      }
      const from: From = {
        loc: loc!,
        text: 'string' === typeof site.ref ? site.ref : '',
        base: site.base,
        // Where the documents read it as a reference in data, it expects
        // what the model reads its new place as.
        expect: expectOf(site) ?? expectAt(ds),
        inline: true,
        // A Path Item's own fields beside its `$ref` are laid over the
        // fields of the one it names, as resolving lays them. In any
        // other place where a target is written, the members beside
        // the reference are not read.
        pure: 'pathItem' !== site.kind || Object.keys(node).every((k) => '$ref' === k),
        mapping: false,
      }
      const to = refer(from, land, space, at, dd, ds)
      if ('ref' in to) define(out, '$ref', to.ref)
      else if ('left' in to) {
        stands(to.left)
        if ('cycle' === to.left && undefined !== land.loc) around.push({ out, loc: land.loc, row: left[left.length - 1] })
      } else {
        if (from.pure || !isMap(to.inline)) return to.inline
        for (const k of Object.keys(out)) if ('$ref' !== k) define(to.inline, k, out[k])
        return to.inline
      }
      return out
    }

    const tree = copy(raw, index.root, rootSpace, [], home.rootDialect, rootDest)
    rootSpace.node = tree

    // The targets, each copied where it was put. A target may name more.
    for (let i = 0; i < queue.length; i++) {
      const unit = queue[i]
      const value = copy(unit.node, unit.loc, unit.space, unit.at, unit.dd, unit.ds)
      let holder = unit.space.node
      if (!isMap(holder)) continue
      for (const seg of unit.rel.slice(0, -1)) {
        if (!isMap(holder[seg])) define(holder, String(seg), Object.create(null))
        holder = holder[seg]
      }
      define(holder, String(unit.rel[unit.rel.length - 1]), value)
    }

    // A target that could not be written inside itself has a place by
    // now where another reference holds it alone: it is named there.
    const placed = new Set<Left>()
    for (const c of around) {
      const got = within(rootSpace, c.loc)
      if (undefined === got) continue
      define(c.out, '$ref', '#' + fragment(got))
      placed.add(c.row)
    }
    if (0 < placed.size) left.splice(0, left.length, ...left.filter((row) => !placed.has(row)))

    // What could not be read until every target had its place.
    for (const d of later) {
      const settled = settledAt(d.loc, d.space)
      const where = index.locate(d.text, d.loc.base)
      const land = undefined === where.target ? undefined : index.landingAt(where.target, where.doc)
      const path = undefined !== land && land.found ? land.path! : undefined
      // The location it names, or the container of the value it names.
      const hl =
        undefined === path ? undefined : (land!.loc ?? (0 === path.length ? undefined : index.landingAt(path.slice(0, -1), land!.doc).loc))
      const rest: Path = undefined !== path && undefined === land!.loc && 0 < path.length ? [path[path.length - 1]] : []
      let text = d.text
      if ('operationRef' === d.what) {
        // An operation has no place of its own among the components: it
        // is named where the bundle has it, in the description or in a
        // Path Item that was brought in.
        const there = undefined === hl ? undefined : hl.doc === home ? pathOf(hl) : within(rootSpace, hl)
        if (settled && d.text.startsWith('#')) continue
        if (null === d.space.res && undefined !== there) text = '#' + fragment([...there, ...rest])
        else {
          left.push({ at: pointer(d.at), ref: d.text, why: undefined === path ? (where.why ?? 'not-found') : 'outside' })
          if (!settled) text = rebase(d.text, d.loc.base, d.space.base)
        }
      } else {
        // A fragment alone is read in the space it is in now, so what it
        // names first has to be plain content of that space. Any other
        // text names a schema resource by its identifier, which the
        // bundle has to have.
        const res = undefined === hl ? null : resourceOf(hl)
        let fine = false
        if (undefined !== hl && d.text.startsWith('#')) {
          fine =
            null === d.space.res
              ? null === res && (hl.doc === home || undefined !== within(rootSpace, hl))
              : res === d.space.res || undefined !== within(d.space, hl)
        } else if (null !== res) {
          fine = res.doc === home || undefined !== within(rootSpace, res)
        }
        if (!fine) left.push({ at: pointer(d.at), ref: d.text, why: 'dynamic' })
        if (!settled && !d.text.startsWith('#')) text = rebase(d.text, d.loc.base, d.space.base)
      }
      if (text === d.text) continue
      if (Array.isArray(d.out)) d.out[d.key as number] = text
      else define(d.out, String(d.key), text)
    }

    return { tree, embedded, left, dialects, units }
  }

  let done = write(undefined)
  // A target that is inside another target would be in the bundle
  // twice, and which of the two a reference names would follow the
  // order the references are met in. Where that is so the bundle is
  // written again, bringing in the outermost of them only.
  const inside = (loc: Loc): boolean => {
    for (let p = loc.parent; undefined !== p; p = p.parent) if (done.units.has(p)) return true
    return false
  }
  const units = [...done.units.keys()]
  if (units.some(inside)) {
    const tops = new Map<Loc, string | null>()
    for (const loc of units) if (!inside(loc)) tops.set(loc, done.units.get(loc)!)
    done = write(tops)
  }

  const result: BundleResult = {
    tree: done.tree,
    version: detected,
    documents: others.map((doc) => doc.key),
    embedded: done.embedded,
    left: done.left,
    dialects: done.dialects,
  }
  return { result, untyped }
}

// Find and load the documents a description names, as `resolveAll`
// does, and write them as one.
async function bundleAll(raw: any, options: BundleAllOptions): Promise<BundleResult> {
  const { load, maxDocuments, maxRounds, ...mine } = options ?? ({} as BundleAllOptions)
  const checked = only(mine as Record<string, unknown>, 'bundleAll')
  const loading: Record<string, unknown> = { load }
  if (undefined !== maxDocuments) loading.maxDocuments = maxDocuments
  if (undefined !== maxRounds) loading.maxRounds = maxRounds
  const { rest, documents } = await gather(raw, { ...checked, ...loading } as any, 'bundleAll')
  return bundle(raw, { ...(rest as BundleOptions), documents })
}

export { bundle, bundleAll }

export type { BundleAllOptions, BundleOptions, BundleResult, Declared, Embedded, Left }
