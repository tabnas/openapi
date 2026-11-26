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

import { OVERRIDE, frontOf, gather, quoted, settle } from './resolve'
import type { Front, Loader, ResolveOptions, ResolveResult } from './resolve'
import { kindFrom, slot, step, stepper } from './model'
import type { ModelVersion } from './model'
import { dialectOf } from './dialect'
import { EXTRA_FACTOR, hasIds, pathOf } from './site-index'
import type { DocFacts, Landing, Loc, SiteFacts } from './site-index'
import {
  PLAIN_NAME,
  define,
  fragmentOf,
  hierarchical,
  isMap,
  normalizeUri,
  own,
  pointer,
  ranOut,
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
//   outside   what is named is in a document of the set, and the bundle
//             has no place for it: what a mapping value or an
//             `operationRef` names, or the target of a reference where
//             the description has something else in the place of the
//             components of that type
//   dynamic   a `$dynamicRef` or a `$recursiveRef` in content that
//             moved, where what it names first did not move with it
//   anchor    an anchor that was left out, because the place it moved
//             to has one of that name, or has a reference that names
//             one and finds none
//   id        an identifier that was left out, because it named the
//             resource it was in, and where it is now it would start one
//   type      a part of a target that the documents read as one type,
//             where the bundle may read it as another, or as data. A
//             reference gave it its type, and in the bundle no
//             reference of that type lands on it, or one of another
//             type does too, or the place it is in has a type of its
//             own. What is in it is then not read as it was
//   sibling   a member beside a reference of a document of an earlier
//             version than the description's, that was left out: its
//             own version did not read it, and the description's would
//   version   a field beside a reference of a document of a later
//             version than the description's, that stands unread: its
//             own version read it in the place of the target's, and
//             the description's has no such rule
//
// `ref` is the text as the documents have it, for `type` the place the
// part came from, as a URI, and for `sibling` and `version` the
// member's value.
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

// Where the security schemes are, from 3.0.
const SCHEMES: Path = ['components', 'securitySchemes']

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
// there, in the model of one version. `plain` says that the model names
// the place and reads plain JSON there, an example's value or a schema's
// `default`: no reference that lands on it gives it a type, as one does
// in a place the model says nothing of.
//
// `edge` says that the place reads data, and that what is written there
// is written as the documents read it, a part that a reference gave a
// type: a reference of the bundle may give it that type again, or
// another.
type Dest = { state: string; v: ModelVersion; plain?: boolean; edge?: boolean }

// What the references of a bundle name and do not find. A place is its
// document and pointer, as the documents have it, and an anchor its
// base URI and name. Nothing new is written where one is hoped for: the
// reference would find it, and name what it never named.
type Hoped = {
  // The places themselves, and each with the places on the way to it
  // that are not there either.
  exact: Set<string>
  under: Set<string>
  anchors: Set<string>
}

const noHopes = (): Hoped => ({ exact: new Set(), under: new Set(), anchors: new Set() })

// A new place is at most this many steps past what is there: the map of
// the components, the map of one type of them, and a name.
const NEW_STEPS = 3

// How many times a bundle is written at most. It is written again where
// the writing found that a target holds another, or that a name it gave
// is one that a reference hopes for, and once more can show nothing new.
const WRITES = 6

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
  // The type it expects of what it names, and whether it has that from
  // its place in the bundle alone: the documents read it as a reference
  // in data, which gives what it names no type.
  expect: string | null
  placed: boolean
  // Whether the target can stand in its place, and the members of the
  // reference's own that are laid over it there: null where it would
  // stand alone.
  inline: boolean
  lays: string[] | null
  // Whether it is a mapping value. No reference types what one names.
  mapping: boolean
}

// A place of the bundle while it is being written: the steps to it from
// the root, the last one first. A step further is one more link,
// however deep the place is, where a path would be copied whole.
type At = { up: At; seg: string | number; n: number } | null

const down = (at: At, seg: string | number): At => ({ up: at, seg, n: (null === at ? 0 : at.n) + 1 })

const atOf = (path: Path): At => {
  let at: At = null
  for (const seg of path) at = down(at, seg)
  return at
}

const stepsOf = (at: At): Path => {
  const out: Path = []
  for (let p = at; null !== p; p = p.up) out.push(p.seg)
  return out.reverse()
}

const pointerAt = (at: At): string => pointer(stepsOf(at))

// A string that is read once every target has its place.
type Later = { what: 'operationRef' | 'dynamic'; out: any; key: string | number; text: string; loc: Loc; space: Space; at: At }

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

// Which of the members beside a reference a version reads: every one
// beside a schema's from 3.1, unless the schema is of a dialect whose
// `$ref` stands alone, and beside a Reference Object's the fields that
// stand in the place of its target's. A Path Item's are read in every
// version and a reference's in data in none, so neither is asked.
type Beside = 'all' | string[]
function readBeside(v: ModelVersion, site: SiteFacts, alone: boolean): Beside {
  if ('schema' === site.kind) return hasIds(v) && !alone ? 'all' : []
  return 'reference' === site.kind ? ((OVERRIDE[v] ?? {})[site.type ?? ''] ?? []) : []
}
const isRead = (beside: Beside, name: string): boolean => 'all' === beside || beside.includes(name)

// Write a description and the documents given with it as one document.
// Neither the raw tree nor any document is changed.
function bundle(raw: any, options: BundleOptions = {}): BundleResult {
  const o = settle(only(options as Record<string, unknown>, 'bundle'), 'bundle')
  return bundleOn(raw, frontOf(raw, o, 'bundle'), 'all' === o.slots)
}

// One bundle, on the index of the documents.
function bundleOn(raw: any, front: Front, all: boolean): BundleResult {
  const { detected, mv, others, limit, counting, tick, refuse, index } = front
  const home = index.docs[0]
  const rootIsMap = isMap(raw)

  // A place of a document, as one string.
  const keyOf = (doc: DocFacts, path: Path): string => doc.key + '#' + pointer(path)

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

  // Whether a schema has the identifier it declares. Of two schemas of
  // the set that declare one identifier, the index gives it to one, and
  // reads every reference by it in that one: a fragment alone that is
  // written in the other, too. The other is no resource to a bundle: it
  // is content of the space it is in, read against a base that space
  // does not have, and its identifier is left out.
  const owned = new Map<Loc, boolean>()
  const owns = (loc: Loc): boolean => {
    let has = owned.get(loc)
    if (undefined === has) {
      const where = index.locate('#', loc.base)
      const path = pathOf(loc)
      has =
        where.doc === loc.doc &&
        undefined !== where.target &&
        where.target.length === path.length &&
        where.target.every((seg, i) => String(seg) === String(path[i]))
      owned.set(loc, has)
    }
    return has
  }

  // A schema resource starts where a schema's identifier gives it a base
  // URI of its own. The root of another document that names itself by
  // that document's URI is one too: it says what it is, and is brought
  // whole as any other. A description of a version before 3.1 has no
  // schema resources, whatever its other documents are: nothing in it
  // reads an identifier, so a fragment in it is read from its root, and
  // what was a resource is plain content there.
  const isResource = (loc: Loc): boolean =>
    hasIds(mv) &&
    ((loc.base !== aboveOf(loc) && owns(loc)) || (undefined === loc.parent && loc.doc !== home && namesItself(loc)))

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
  // What is below plain JSON is plain JSON, and what is below a place the
  // model says nothing of is such a place too.
  const steppers = new Map<ModelVersion, ReturnType<typeof stepper>>()
  const how: { how: 'prop' | 'pattern' | 'ext' | 'rest' | 'items' | 'none' | 'below' } = { how: 'none' }
  const destFrom = (start: Dest, path: Path): Dest => {
    let state = start.state
    let plain = true === start.plain
    let stepOf = steppers.get(start.v)
    if (undefined === stepOf) steppers.set(start.v, (stepOf = stepper(start.v)))
    for (const seg of path) {
      if ('data' === state) break
      const from = kindFrom(start.v, state)
      state = stepOf(state, seg, how)
      plain =
        'data' === state &&
        'ext' !== how.how &&
        'none' !== how.how &&
        !('rest' === how.how && 'schema' === from)
    }
    return plain ? { state, v: start.v, plain } : { state, v: start.v }
  }
  const rootDest: Dest = { state: index.root.state, v: mv }

  // How the model reads a location below a place that holds `from` and
  // is read as `ds`: as a copy made there reads it, step by step. Content
  // that has the type of its place is read as it was.
  const destAt = (from: Loc, ds: Dest, to: Loc): Dest => {
    const chain: Loc[] = []
    for (let p: Loc | undefined = to; undefined !== p && p !== from; p = p.parent) chain.push(p)
    let d = ds
    let cur = from
    for (let i = chain.length - 1; 0 <= i && 'data' !== d.state; i--) {
      const was: Dest | undefined = 'data' !== cur.state ? { state: cur.state, v: cur.doc.mv } : undefined
      d = destFrom(undefined !== was && holds(was) === holds(d) ? was : d, [chain[i].seg])
      cur = chain[i]
    }
    return d
  }

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

  // Whether a text, read against a base, names the description itself.
  const namesHome = (text: string, base: string): boolean => {
    try {
      const doc = withoutFragment(normalizeUri(resolveUri(base, text)))
      return doc === home.uri || doc === home.key
    } catch {
      return false
    }
  }

  // The text of a reference that is left as it was written: it names
  // what it named, read against the base of the space it is in now. In
  // the description's own space, one that names the description by its
  // URI is written as the fragment alone, as a reference to a place in
  // it is. The bundle may have that place though the documents did not,
  // and the bundle of the bundle would write it so.
  const leftAs = (text: string, from: string, space: { res: Loc | null; base: string }): string => {
    const moved = rebase(text, from, space.base)
    if (null !== space.res || moved.startsWith('#') || !namesHome(moved, space.base)) return moved
    const hash = moved.indexOf('#')
    return hash < 0 ? '#' : moved.slice(hash)
  }

  // The text of a reference in a schema resource that is left because
  // the resource's definitions have no place for its target. Where it
  // named the target through a reference of the description, that place
  // of the description holds something else in the bundle: a reference
  // that stands for the target. The bundle of the bundle would take that
  // for what is named, and copy it in. So the text names the target in
  // its own document, which the bundle does not have.
  const outsideAs = (text: string, from: string, land: Landing, space: { res: Loc | null; base: string }): string | undefined => {
    if (null === space.res || undefined === land.doc || land.doc === home || !namesHome(text, from)) return undefined
    const path = land.path!
    const uri = land.doc.key + (0 === path.length ? '' : '#' + fragment(path))
    return ABSOLUTE.test(text) ? uri : relativeTo(space.base, uri)
  }

  // The object that a value of plain JSON is in: the nearest location
  // above it that the model gives a type.
  const typedAbove = (loc: Loc): Loc | undefined => {
    for (let p = loc.parent; undefined !== p; p = p.parent) if ('typed' === p.known) return p
    return undefined
  }

  // Whether a location has its type from a reference alone, in a place
  // where the object above it reads plain JSON: a schema's `default`, on
  // which a reference landed before anything read the schema. In the
  // bundle that object is read first, wherever it is, and no reference
  // makes the part what it was. It is what it was only by itself.
  const plainParts = new Map<Loc, boolean>()
  const isPlainPart = (loc: Loc): boolean => {
    if ('typed' !== loc.known) return false
    let has = plainParts.get(loc)
    if (undefined === has) {
      const above = typedAbove(loc)
      has = false
      if (undefined !== above) {
        const by = destAt(above, { state: above.state, v: above.doc.mv }, loc)
        has = 'data' === by.state && true === by.plain
      }
      plainParts.set(loc, has)
    }
    return has
  }

  // What the entry has as written at a path, where it has a map there.
  const entryAt = (path: Path): any => {
    let node = raw
    for (const seg of path) node = isMap(node) && own(node, String(seg)) ? node[seg] : undefined
    return node
  }

  // Where the description's schema components are: a mapping value that
  // reads as a name hopes for one of that name there.
  const schemasAt = sectionOf('schema')

  // One writing of the bundle. `tops` is given for a second one: the
  // targets that were found to hold other targets, each with the type
  // it was brought in as, so that such a target is brought once and
  // what is in it is named there.
  const write = (tops: Map<Loc, string | null> | undefined, hoped: Hoped) => {
    const embedded: Embedded[] = []
    const left: Left[] = []
    const dialects: Declared[] = []
    // The targets put among the description's components, each with the
    // type the reference to it expects.
    const units = new Map<Loc, string | null>()
    // What this writing finds that a reference names and does not find,
    // and what it made that such a reference could find: the places it
    // gave a name, the maps it made to hold them, and the anchors that
    // came into a space with content that moved.
    const wished = noHopes()
    const given = new Set<string>()
    const made = new Set<string>()
    const anchored = new Set<string>()
    const hopedUnder = (key: string): boolean => hoped.under.has(key) || wished.under.has(key)
    const hopedExact = (key: string): boolean => hoped.exact.has(key) || wished.exact.has(key)
    const hopedAnchor = (key: string): boolean => hoped.anchors.has(key) || wished.anchors.has(key)
    // A place that is hoped for, of which the first `there` steps are
    // there. A new place is a few steps past what is there, so only so
    // many of the places on the way count.
    const wishAt = (doc: DocFacts, path: Path, there: number): void => {
      if (path.length - there <= NEW_STEPS) wished.exact.add(keyOf(doc, path))
      const top = Math.min(path.length, there + NEW_STEPS)
      for (let n = there + 1; n <= top; n++) wished.under.add(keyOf(doc, path.slice(0, n)))
    }
    const wish = (land: Landing | undefined): void => {
      const miss = land?.miss
      if (undefined !== miss) wishAt(miss.doc, [...miss.path, ...miss.rest], miss.path.length)
    }
    // What a URI reference names and does not find, read against a base.
    const wishOf = (text: string, base: string): void => {
      const where = index.locate(text, base)
      if ('no-anchor' === where.why) {
        const abs = text.startsWith('#') ? base + text : normalizeUri(resolveUri(base, text))
        wished.anchors.add(withoutFragment(abs) + '#' + (fragmentOf(abs) ?? ''))
      } else if (undefined !== where.target) wish(index.landingAt(where.target, where.doc))
    }

    // A copy is made of each target once, but for one written in the
    // place of its reference where that place is not its alone. Those
    // can multiply, so the copying is held to the index's allowance.
    let copied = 0
    const work = (at: At) => {
      if (counting) tick()
      if (index.allowance < ++copied) {
        refuse(
          'openapi_work',
          'bundling this description takes more than ' + EXTRA_FACTOR + ' times the work of reading its documents once',
          pointerAt(at),
        )
      }
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
    // A place of a space, as the documents have it: in the description
    // for its own space, and in a schema resource where that was written.
    const originOf = (space: Space, rel: Path): string =>
      null === space.res ? keyOf(home, rel) : keyOf(space.res.doc, [...pathOf(space.res), ...rel])

    // The map of a space that targets are put in, by its path from the
    // space's root: the names it has, as written and as given since. Null
    // where the bundle has no such map and makes none. Something else is
    // there, which a new map would take the place of: a value that is no
    // map, or a reference, which has the members of what it names. Or a
    // reference names the place and finds nothing, and would find the map.
    // A resource that the bundle has in two places has a map in each,
    // and the same names are given in both: the two are one resource to
    // whatever reads the bundle, and a fragment in one is read in either.
    const holders = new Map<string, Set<string> | null>()
    const holderOf = (space: Space, section: Path): Set<string> | null => {
      const key = pointer([...space.at, ...section])
      const had = holders.get(key)
      if (undefined !== had) return had
      const names = ((): Set<string> | null => {
        let node: any = null === space.res ? raw : space.res.raw
        let loc: Loc | undefined = null === space.res ? index.root : space.res
        // A root that is a reference is written as what it names.
        if (null === space.res && undefined !== index.root.site) return null
        for (let i = 0; i < section.length; i++) {
          const seg = String(section[i])
          if (!isMap(node) || !own(node, seg)) {
            const fresh: string[] = []
            for (let n = i + 1; n <= section.length; n++) {
              const at = originOf(space, section.slice(0, n))
              if (hopedExact(at)) return null
              fresh.push(at)
            }
            for (const at of fresh) made.add(at)
            return new Set()
          }
          const v = node[seg]
          loc = undefined === loc ? undefined : index.child(loc, seg)
          if (!isMap(v) || undefined !== loc?.site) return null
          node = v
        }
        return new Set(Object.keys(node))
      })()
      holders.set(key, names)
      return names
    }

    // Where the components of a type go, with the names taken there. Null
    // where the version has no such place, or the description has it for
    // something else.
    const placeOf = (type: string | null): { section: Path; names: Set<string> } | null => {
      const section = sectionOf(type)
      const names = null === section ? null : holderOf(rootSpace, section)
      return null === section || null === names ? null : { section, names }
    }

    // A name that a map does not have, for a target that would be named
    // `want`: that name, or it with a number. A name is passed over where
    // a reference hopes for it. The search goes on from where the last
    // one for that name ended, so that many targets of one name cost a
    // step each.
    const counts = new Map<string, number>()
    const unique = (space: Space, section: Path, names: Set<string>, want: string): string => {
      const holder = originOf(space, section)
      const count = pointer([...space.at, ...section]) + '\u0000' + want
      let n = counts.get(count) ?? 1
      let name = 1 === n ? want : want + '_' + n
      while (names.has(name) || hopedUnder(holder + '/' + name)) name = want + '_' + ++n
      counts.set(count, n + 1)
      names.add(name)
      given.add(holder + '/' + name)
      return name
    }

    const queue: Unit[] = []
    const later: Later[] = []
    // The references of the description's own space that were left for
    // want of a place for their target, each with its row of `left`: one
    // whose target was being written around it, and one that the bundle
    // had no place for. The target may get a place of its own later in
    // the writing.
    const around: { out: any; at: At; loc: Loc; row: Left; gives: string | null }[] = []
    // The targets being written in the place of a reference, and the
    // places being written that a reference's own fields will be laid
    // over, each with the names of those fields: such a place is no
    // target's alone, nor is it for a target that is written there
    // because the first is a reference to it.
    const inlining = new Set<Loc>()
    const inlined = new Set<Loc>()
    const overlaid = new Map<string, Set<string>>()
    // How the model reads each place that the description's own space
    // has a target at.
    const seats = new Map<Loc, Dest>()
    // The references with a type that were written to land on a place of
    // the bundle, each with where it is written. A mapping value is one,
    // of a schema: it types what it names, as a reference does.
    const landings: { at: At; to: string; gives: string | null; loc: Loc }[] = []
    const givenBy = (from: From, ds: Dest): string | null => (from.mapping ? 'schema' : expectAt(ds))
    // The parts of targets that a reference gave a type, each where it
    // was written in a place the bundle reads as data, or as another
    // type: `never` says that the place has a type of its own, or is one
    // that the model reads plain JSON in, so that no
    // reference can make the part what it was.
    const edges: { at: At; loc: Loc; never?: boolean }[] = []

    // Whether a location is where it was written, in its own space: in
    // the description's own content, or in a schema resource that the
    // bundle has whole. It is read there against the base it was written
    // for, which content under an identifier that another schema has is
    // not.
    const settledAt = (loc: Loc, space: Space): boolean =>
      resourceOf(loc) === space.res && (null !== space.res || loc.doc === home) && loc.base === space.base

    // Where a space already has a location: itself, or inside a target
    // that it has.
    const within = (space: Space, loc: Loc): Path | undefined => {
      for (let p: Loc | undefined = loc; undefined !== p; p = p.parent) {
        const got = space.defs.get(p)
        if (undefined !== got) return [...got, ...pathOf(loc).slice(pathOf(p).length)]
      }
      return undefined
    }

    // Where the description's own space has a location in a place that
    // the model reads by where it is: in the nearest target above it
    // that is so placed.
    const seated = (loc: Loc): Path | undefined => {
      for (let p: Loc | undefined = loc; undefined !== p; p = p.parent) {
        const got = rootSpace.defs.get(p)
        if (undefined === got) continue
        if ('data' !== destAt(p, seats.get(p)!, loc).state) return [...got, ...pathOf(loc).slice(pathOf(p).length)]
      }
      return undefined
    }

    // Put a target in a map of the space, to be copied there, and give
    // where it will be, from the space's root. A target is put once, but
    // for one that the space has only where it is not read as what it
    // is: that one is put `again`, where it is.
    const put = (
      land: Landing,
      space: Space,
      section: Path,
      names: Set<string>,
      expect: string | null,
      again = false,
    ): Path => {
      const loc = land.loc
      const key = land.doc!.key + '#' + pointer(land.path!)
      const had = undefined === loc ? space.values.get(key) : space.defs.get(loc)
      if (undefined !== had && !again) return had
      const name = unique(space, section, names, nameOf(land))
      const rel = [...section, name]
      const ds = destFrom(null === space.res ? rootDest : { state: space.res.state, v: space.res.doc.mv }, rel)
      if (undefined === loc) space.values.set(key, rel)
      else space.defs.set(loc, rel)
      if (undefined !== loc && space === rootSpace) {
        units.set(loc, expect)
        seats.set(loc, ds)
      }
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
      const place = placeOf(expect)
      if (null !== place) put(whole(top), rootSpace, place.section, place.names, expect)
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

    // Write a target in the place of the reference that names it, in the
    // space the reference is in. Where it stands there alone, and the
    // place reads it as what it is, that place is the target's from then
    // on. Where the reference lays members of its own over it, those
    // members of the target are not written: the bundle has nothing of
    // them, so nothing in them has a place in it.
    const inline = (
      land: Landing,
      space: Space,
      at: At,
      dd: string,
      ds: Dest,
      lays: string[] | null,
      expect: string | null,
    ): { inline: any } | { left: string } => {
      const loc = land.loc
      const place = pointerAt(at)
      const outer = overlaid.get(place)
      const skip = null === lays ? outer : new Set([...(outer ?? []), ...lays])
      if (undefined !== loc) {
        if (inlining.has(loc)) return { left: 'cycle' }
        if (limit <= inlining.size) {
          refuse('openapi_depth', 'targets written one inside another deeper than ' + limit, place)
        }
        inlining.add(loc)
        inlined.add(loc)
        if (undefined === skip && (null === expect || holds(ds) === expect)) {
          space.defs.set(loc, stepsOf(at).slice(space.at.length))
          if (space === rootSpace) seats.set(loc, ds)
        }
      }
      if (null !== lays) overlaid.set(place, skip!)
      let value: any
      try {
        value = copy(land.node, loc, space, at, dd, ds, skip)
      } finally {
        if (undefined !== loc) inlining.delete(loc)
        if (null !== lays) {
          if (undefined === outer) overlaid.delete(place)
          else overlaid.set(place, outer)
        }
      }
      embedded.push({ at: place, doc: land.doc!.key, from: pointer(land.path!), as: 'inline' })
      return { inline: value }
    }

    // Whether what a mapping value names can be brought in as a schema.
    // The index types a map that the model gives no state as one, where
    // a mapping value is the first to land on it. So a map that is no
    // schema here is of another type, or of another version's model, and
    // read as a schema where it is brought to it would hold references
    // that nothing has read.
    const schemaAt = (land: Landing): boolean => {
      const loc = land.loc
      if (undefined === loc || !isMap(loc.raw)) return true
      return 'unknown' !== loc.known && 'schema' === slot(loc.doc.mv, loc.state).kind
    }

    // The new text of what names a target, or the value to write in its
    // place.
    const refer = (
      from: From,
      land: Landing,
      space: Space,
      at: At,
      dd: string,
      ds: Dest,
    ): { ref: string } | { inline: any } | { left: string } => {
      const text = from.text
      // What names it is where it was written, in its own space. A
      // fragment alone is then read in the space it was written for,
      // which has every place it had: it stands. But for one whose
      // pointer is read on through a reference into another document.
      // That reference may be one the bundle cannot keep, and a reader
      // that takes a pointer by the letter reads on through none. It is
      // written to name where the bundle has what it named.
      const settled = settledAt(from.loc, space)
      const lloc = land.loc
      if (settled && text.startsWith('#') && (undefined === land.doc || land.doc === from.loc.doc)) return { ref: text }
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
          const inner = pathOf(hl).slice(pathOf(lres).length)
          const rel = [...inner, ...rest]
          if (lres.doc !== home) {
            brought(lres)
            // The bundle has to read its identifier, so it has to be
            // where a schema is read: among the schemas, or in one of
            // them where a schema is. The outermost resource it is in
            // comes whole where it is so in that one, and else it comes
            // by itself.
            if (undefined === seated(lres)) {
              const place = placeOf('schema')
              if (null === place) return { left: 'outside' }
              const top = topOf(lres)
              const read = destAt(top, destFrom(rootDest, [...place.section, 'x']), lres)
              put(whole('data' === read.state ? lres : top), rootSpace, place.section, place.names, 'schema')
            }
          }
          if (space.res === lres) return { ref: '#' + fragment(rel) }
          // A part of the resource that a reference gave a type, where
          // the resource itself reads plain JSON: a `default`, on which a
          // reference landed before anything read the schema around it.
          // No reference makes it what it was there, so it is brought by
          // itself, where its type is read.
          if (undefined !== lloc && lloc !== lres && lres.doc !== home && isPlainPart(lloc)) {
            const had = space.defs.get(lloc)
            if (undefined !== had) return { ref: '#' + fragment(had) }
            const type = typeAt(land)
            if (null === space.res) {
              const place = placeOf(type)
              if (null !== place) return { ref: '#' + fragment(put(land, rootSpace, place.section, place.names, type, true)) }
            } else {
              // From another resource it goes among that one's own
              // definitions, which read a schema.
              const key = undefined !== space.res.rules && space.res.rules.refAlone ? 'definitions' : '$defs'
              const names = 'schema' === type ? holderOf(space, [key]) : null
              if (null === names) return { left: 'outside' }
              return { ref: '#' + fragment(put(land, space, [key], names, 'schema', true)) }
            }
          }
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
          const there = lres.doc === home ? pathOf(lres) : seated(lres)
          if (undefined !== there) landings.push({ at, to: pointer([...there, ...inner]), gives: givenBy(from, ds), loc: hl })
          if (null === space.res && undefined !== there) return { ref: '#' + fragment([...there, ...rel]) }
          const uri = lres.base + (0 === rel.length ? '' : '#' + fragment(rel))
          return { ref: ABSOLUTE.test(text) ? uri : relativeTo(space.base, uri) }
        }
      }

      if (null === space.res) {
        // In the description's own space. A place in the description
        // itself is where it was: a reference that names the document
        // by its URI is written as the pointer alone.
        // Whether the target is put again, where its type is read.
        let again = false
        if (undefined !== hl) {
          if (hl.doc === home) return { ref: '#' + fragment([...pathOf(hl), ...rest]) }
          brought(hl)
          // A value that the model reads as plain JSON is that by where it
          // is: in the object above it that has a type. Among the
          // components it would be read as one of them, and a reference
          // in it with it. So that object is brought, where its type is
          // read, and the value is named in it.
          const above = 'data' === hl.known ? typedAbove(hl) : undefined
          if (undefined !== above) {
            let seat = seated(above)
            if (undefined === seat) {
              const type = typeAt(whole(above))
              const place = placeOf(type)
              if (null === place) return { left: 'outside' }
              put(whole(above), rootSpace, place.section, place.names, type, true)
              seat = seated(above)
              if (undefined === seat) return { left: 'outside' }
            }
            return { ref: '#' + fragment([...seat, ...pathOf(hl).slice(pathOf(above).length), ...rest]) }
          }
          const got = within(rootSpace, hl)
          if (undefined !== got) {
            // A reference that has its type from its new place alone, on
            // content that nothing gave a type and that the bundle has
            // where it reads data. It was written there as data, and this
            // reference would make it more: it is put again, where the
            // type is read, and the copy that is data stays data. So is a
            // part that a reference gave a type, which the bundle has
            // where the model reads plain JSON: no reference makes it
            // what it was there.
            again =
              undefined !== lloc &&
              undefined === seated(lloc) &&
              ((from.placed && 'unknown' === lloc.known) || isPlainPart(lloc))
            if (!again) {
              landings.push({ at, to: pointer(got), gives: givenBy(from, ds), loc: hl })
              return { ref: '#' + fragment([...got, ...rest]) }
            }
          }
        }
        const expect = typeAt(land) ?? from.expect
        const place = placeOf(expect)
        if (null === place) {
          if (!from.inline) return { left: 'outside' }
          const why = danglingAt(land)
          if (undefined !== why) return { left: why }
          // A target that has a type is written where that type is read,
          // or where data is. In a place that reads another type it would
          // be read as that one, and what is in it with it: a reference
          // in it that the documents do not read would be read.
          //
          // Under `slots: 'all'` a part that a reference gave a type may
          // stay in a place that reads data, and is read as what it was
          // where a reference lands on it again. So a place in such a
          // part reads what the documents read there, though the model
          // reads data: an operation written in the place of a Path Item
          // reference there would be read as a Path Item.
          const reads = holds(ds)
          const was =
            'data' === reads && true !== ds.plain && 'typed' === from.loc.known
              ? holds({ state: from.loc.state, v: from.loc.doc.mv })
              : reads
          if (null !== expect && 'data' !== was && was !== expect) return { left: 'outside' }
          return inline(land, rootSpace, at, dd, ds, from.lays, expect)
        }
        if (from.mapping && !schemaAt(land)) return { left: 'outside' }
        return { ref: '#' + fragment(put(land, rootSpace, place.section, place.names, expect, again)) }
      }

      // It is named from inside a schema resource, and is plain content
      // outside it, which a fragment cannot reach from there: it is
      // copied into the resource's own definitions.
      const key = undefined !== space.res.rules && space.res.rules.refAlone ? 'definitions' : '$defs'
      // A value of plain JSON is named in the object above it that has a
      // type, as in the description's own space. That object is a schema,
      // or the resource's definitions do not read it as what it is.
      const above = undefined !== hl && 'data' === hl.known ? typedAbove(hl) : undefined
      if (undefined !== above && undefined !== hl) {
        let seat = within(space, above)
        if (undefined === seat) {
          if ('schema' !== typeAt(whole(above))) return { left: 'outside' }
          const names = holderOf(space, [key])
          if (null === names) return { left: 'outside' }
          seat = put(whole(above), space, [key], names, 'schema')
        }
        return { ref: '#' + fragment([...seat, ...pathOf(hl).slice(pathOf(above).length), ...rest]) }
      }
      const got = undefined === hl ? undefined : within(space, hl)
      // A part that is what it was only by itself, which the resource
      // has inside something else: it is put again, by itself.
      const again = undefined !== lloc && isPlainPart(lloc) && !space.defs.has(lloc)
      if (undefined !== got && undefined !== hl && !again) {
        landings.push({ at, to: pointer([...space.at, ...got]), gives: givenBy(from, ds), loc: hl })
        return { ref: '#' + fragment([...got, ...rest]) }
      }
      if (from.mapping && !schemaAt(land)) return { left: 'outside' }
      // What goes into the resource's definitions is read as a schema
      // there. A target that the documents read as something else would
      // be read as one, and what is in it with it.
      const type = typeAt(land)
      if (null !== type && 'schema' !== type) return { left: 'outside' }
      // A target that nothing gave a type, named from a place that reads
      // data, is written in that place, as the description's own space
      // has it. Among the definitions it would be read as a schema, and
      // a reference in it would give what it lands on a type that the
      // documents do not.
      if (null === type && null === from.expect) {
        if (!from.inline) return { left: 'outside' }
        const why = danglingAt(land)
        if (undefined !== why) return { left: why }
        return inline(land, space, at, dd, ds, from.lays, null)
      }
      const names = holderOf(space, [key])
      if (null === names) return { left: 'outside' }
      return { ref: '#' + fragment(put(land, space, [key], names, 'schema', again)) }
    }

    // A discriminator's mapping value: the name of one of the
    // description's schemas, or a URI reference to a schema.
    const mapped = (v: string, holder: Loc, space: Space, at: At): string => {
      // The index says how one is read. A name stays a name.
      const where = index.locateMapping(v, holder.base)
      if ('name' === where.via) return v
      const land = undefined === where.target ? undefined : index.landingAt(where.target, where.doc)
      if (undefined === land || !land.found) {
        // What reads as a name is one, wherever it is: it hopes for a
        // schema of that name among the description's.
        if (NAME.test(v)) {
          if (null !== schemasAt) wishAt(home, [...schemasAt, v], schemasAt.length)
          return v
        }
        if ('no-anchor' === where.why) wishOf(v, holder.base)
        else wish(land)
        left.push({ at: pointerAt(at), ref: v, why: where.why ?? 'not-found' })
        return leftAs(v, holder.base, space)
      }
      const from: From = {
        loc: holder,
        text: v,
        base: holder.base,
        expect: 'schema',
        placed: false,
        inline: false,
        lays: null,
        mapping: true,
      }
      const to = refer(from, land, space, at, '', rootDest)
      if ('ref' in to) return to.ref
      if ('left' in to) left.push({ at: pointerAt(at), ref: v, why: to.left })
      const out = 'left' in to && 'outside' === to.left ? outsideAs(v, holder.base, land, space) : undefined
      return out ?? leftAs(v, holder.base, space)
    }

    // A string the object model types, in content that the bundle has:
    // what it names is named from where it is now.
    const leaf = (v: string, holder: Loc, k: string | number, space: Space, at: At, out: any, as: Dest): string => {
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
    //
    // `skip` names the members that are not written: the ones that a
    // reference's own are laid over.
    //
    // A copy goes as deep as the bundle nests, on the stack. So what
    // decides how a member is copied (`below`) is done with before the
    // member is gone into, and says what to go into with: its frame is
    // not on the stack under the whole of what is below.
    const GO = Symbol('go')
    let goKid: Loc | undefined
    let goAt: At = null
    let goDest: Dest = rootDest
    function copy(node: any, loc: Loc | undefined, sp: Space, at: At, dd: string, ds: Dest, skip?: Set<string>): any {
      if (null === node || 'object' !== typeof node) return node
      work(at)
      // A target written in the place of a reference is as deep as its
      // place and its own depth together, so the bundle can nest deeper
      // than any of its documents. It is held to what one of them is.
      if (null !== at && limit <= at.n) refuse('openapi_depth', 'the bundle nests deeper than ' + limit, pointerAt(at))
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
      const destOf = (k: string | number): Dest => {
        if ('data' === ds.state) return ds
        const d = destFrom(keeps ? was! : ds, [k])
        if (true === ds.edge) d.edge = true
        return d
      }
      const below = (k: string | number, v: any, space: Space, dialect: string): any => {
        const kid = child(k, v)
        const next = down(at, k)
        let d = destOf(k)
        // A schema resource in plain content that moved. The content may
        // be written in more places than one, and the resource is
        // written in one: where the bundle has it, which is here only if
        // this is that place. Anywhere else a reference to it stands for
        // it, so that the bundle declares its identifier once.
        if (moved && undefined !== kid && ('data' !== d.state || all) && isMap(v) && isResource(kid)) {
          const seat = kid.doc === home ? pathOf(kid) : seated(kid)
          if (undefined === seat || pointer(seat) !== pointerAt(next)) {
            const from: From = {
              loc: loc!,
              text: '',
              base: loc!.base,
              expect: 'schema',
              placed: false,
              inline: false,
              lays: null,
              mapping: false,
            }
            const to = refer(from, whole(kid), space, next, dialect, d)
            if ('ref' in to) {
              const ref = Object.create(null)
              define(ref, '$ref', to.ref)
              return ref
            }
          }
        }
        // A part that a reference gave one type, in a place that the
        // model gives another: it is read by where it is. That is so in
        // anything the bundle brought in, a schema resource that came
        // whole too: where a part is in the bundle is what types it
        // there, and in the documents a reference may have come first.
        if (
          undefined !== kid &&
          (moved || kid.doc !== home) &&
          'typed' === kid.known &&
          'data' !== d.state &&
          holds({ state: kid.state, v: kid.doc.mv }) !== holds(d)
        ) {
          edges.push({ at: next, loc: kid, never: true })
        }
        // And where the model reads plain JSON, in a schema resource that
        // came whole as in anything else, no reference makes the part
        // what it was.
        if (!moved && undefined !== kid && kid.doc !== home && 'typed' === kid.known && 'data' === d.state && true === d.plain) {
          edges.push({ at: next, loc: kid, never: true })
        }
        if (moved && 'data' === d.state && undefined !== kid && 'typed' === kid.known) {
          if (all) {
            const land = whole(kid)
            // A reference that names nothing stands where it is: one to
            // it would be left as it is left, with another text. And the
            // part stays where it is if the bundle has no place for it
            // that a reference from here can name: from the description's
            // own space, among the components of its type, and from a
            // schema resource, which a fragment does not leave, among
            // that resource's definitions if it is a schema.
            const stands = undefined !== danglingAt(land)
            if (!stands && !isResource(kid)) {
              const type = typeAt(land)
              let to: Path | undefined
              if (null === space.res) {
                const place = placeOf(type)
                if (null !== place) to = put(land, rootSpace, place.section, place.names, type)
              } else if ('schema' === type) {
                const key = undefined !== space.res.rules && space.res.rules.refAlone ? 'definitions' : '$defs'
                const names = holderOf(space, [key])
                if (null !== names) to = put(land, space, [key], names, 'schema')
              }
              if (undefined !== to) {
                const ref = Object.create(null)
                define(ref, '$ref', '#' + fragment(to))
                return ref
              }
            }
            // It stays, in a place that reads data. A reference in it is
            // read there as one in data is, which is not always as it
            // was: the members beside it are not read. It is read as it
            // was only if a reference lands on it here, and never where
            // the model names the place as plain JSON.
            if (!stands) edges.push(true === d.plain ? { at: next, loc: kid, never: true } : { at: next, loc: kid })
          } else if (true === d.plain) {
            // The model names the place and reads plain JSON there. No
            // reference that lands on it makes the part what it was.
            edges.push({ at: next, loc: kid, never: true })
          } else {
            // Where a reference in data is not read, the part is read
            // here as it was only if a reference lands on it here, as one
            // did where it was written. It is written as if one will,
            // and looked at again once every reference is written.
            edges.push({ at: next, loc: kid })
            d = { state: kid.state, v: kid.doc.mv, edge: true }
          }
        }
        goKid = kid
        goAt = next
        goDest = d
        return GO
      }
      // A string is what the documents read it as, and where they give
      // it no type, what the bundle will.
      const text = (v: string, k: string | number, space: Space, into: any): string =>
        undefined === loc ? v : leaf(v, loc, k, space, down(at, k), into, undefined !== was ? destFrom(was, [k]) : destOf(k))
      if (Array.isArray(node)) {
        const list: any[] = []
        for (let i = 0; i < node.length; i++) {
          const v = node[i]
          if ('string' === typeof v) {
            list.push(text(v, i, sp, list))
            continue
          }
          const done = below(i, v, sp, dd)
          list.push(GO === done ? copy(v, goKid, sp, goAt, dd, goDest) : done)
        }
        return list
      }
      if (!isMap(node)) return node

      const out: Record<string, any> = Object.create(null)
      let space = sp
      const rules = loc?.rules
      if (starts) {
        space = { res: loc!, node: out, at: stepsOf(at), base: loc!.base, dialect: loc!.dialect, defs: new Map(), values: new Map(), anchors: new Set() }
      }
      // Whether the schema's identifier and anchors are read at all.
      const reads = undefined !== rules && !(rules.refAlone && 'string' === typeof node.$ref)
      // Content that the documents did not read as a schema, where the
      // bundle may: its identifier and its anchors were plain members,
      // and there they would be read, by the dialect in force. That is so
      // in a place where a schema is. It is so for a part that a
      // reference gave another type, written where a reference of the
      // bundle may give it one again: that one may be a schema's. And
      // under `slots: 'all'` it is so in any place that a reference may
      // give a type: a reference in data may be written where it has a
      // type, and what it lands on takes it.
      const live =
        undefined !== loc &&
        undefined === rules &&
        hasIds(mv) &&
        (('data' !== ds.state && 'schema' === slot(ds.v, ds.state).kind) ||
          true === ds.edge ||
          (all && 'data' === ds.state && true !== ds.plain))
          ? dialectOf(dd).dialect
          : undefined
      const schema = reads ? rules : live

      // A schema is read under the dialect it declares, else the one in
      // force where it is. One that was read under another than its new
      // place has in force says so, so that it is read as it was.
      let inside = dd
      if (undefined !== loc && undefined !== rules && '' !== loc.dialect) {
        if (!own(node, '$schema') && normalizeUri(loc.dialect) !== normalizeUri(dd)) {
          define(out, '$schema', loc.dialect)
          dialects.push({ at: pointerAt(at), dialect: loc.dialect })
        }
        inside = loc.dialect
      }

      // A security requirement names schemes among the description's. A
      // name that is none of them hopes for one.
      const read = undefined !== was ? was : ds
      if ('2.0' !== mv && 'data' !== read.state && 'connection:securityScheme' === slot(read.v, read.state).keys) {
        const has = entryAt(SCHEMES)
        for (const k of Object.keys(node)) if (!isMap(has) || !own(has, k)) wishAt(home, [...SCHEMES, k], 0)
      }

      for (const k of Object.keys(node)) {
        const v = node[k]
        // A member that a reference's own is laid over is not written.
        // It keeps its place among the others.
        if (undefined !== skip && skip.has(k)) {
          define(out, k, undefined)
          continue
        }
        if ('string' !== typeof v) {
          const done = below(k, v, space, inside)
          define(out, k, GO === done ? copy(v, goKid, space, goAt, inside, goDest) : done)
          continue
        }
        if (moved && undefined !== schema && !(schema.refAlone && 'string' === typeof node.$ref)) {
          const name = schema.anchors.includes(k) ? v : schema.idAnchor && k === schema.id && v.startsWith('#') ? v.slice(1) : undefined
          if (undefined !== name && PLAIN_NAME.test(name)) {
            // An anchor of content that moved becomes one of the space
            // it is in. One that the space has already would take that
            // one's place, so it is left out.
            const key = space.base + '#' + name
            if (space.anchors.has(name) || hopedAnchor(key) || undefined !== index.locate('#' + name, space.base).target) {
              left.push({ at: pointerAt(down(at, k)), ref: v, why: 'anchor' })
              continue
            }
            space.anchors.add(name)
            anchored.add(key)
          } else if (k === schema.id && withoutFragment(normalizeUri(resolveUri(space.base, v))) !== space.base) {
            // An identifier that named the resource it was in, or that
            // was not read. Where it is now it would start a resource,
            // and what is below it would be read against that.
            left.push({ at: pointerAt(down(at, k)), ref: v, why: 'id' })
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

      // A reference that is left to evaluation. What it names and does
      // not find, it hopes for. In content that moved it is looked at
      // once every target has its place.
      if (undefined !== loc && loc.dynamic && undefined !== rules && null !== rules.dynamic) {
        const text = node[rules.dynamic]
        if ('string' === typeof text) {
          wishOf(text, loc.base)
          if (moved) later.push({ what: 'dynamic', out, key: rules.dynamic, text, loc, space, at })
        }
      }

      const site = loc?.site
      if (undefined === site) return out
      // A reference the bundle has as it was written still names what
      // it named, where it is read against another base.
      const stands = (why: string, to?: Landing) => {
        left.push({ at: pointerAt(at), ref: site.ref, why })
        if ('string' !== typeof site.ref) return
        const text = ('outside' === why && undefined !== to ? outsideAs(site.ref, site.base, to, space) : undefined) ?? leftAs(site.ref, site.base, space)
        if (text !== site.ref) define(out, '$ref', text)
      }
      const land = index.landing(site)
      if (!land.found) {
        // What it names and does not find, it hopes for.
        if ('no-anchor' === site.why && 'string' === typeof site.ref) wishOf(site.ref, site.base)
        else wish(land)
        stands(true === land.loop ? 'loop' : (site.why ?? 'not-found'))
        return out
      }
      const beside = Object.keys(node).filter((k) => '$ref' !== k)
      const written = loc!.doc.mv
      const from: From = {
        loc: loc!,
        text: 'string' === typeof site.ref ? site.ref : '',
        base: site.base,
        // Where the documents read it as a reference in data, it expects
        // what the model reads its new place as.
        expect: expectOf(site) ?? expectAt(ds),
        placed: null === expectOf(site) && null !== expectAt(ds),
        // A target can be written in the place of a reference where the
        // members beside the reference are not read: beside one in data,
        // one of 2.0 or 3.0, or a schema's of a dialect whose `$ref`
        // stands alone, as resolving reads none there. A Path Item's own
        // fields beside its `$ref` are laid over the fields of the one
        // it names, as resolving lays them. Any other reference has to
        // be alone.
        inline:
          0 === beside.length ||
          'pathItem' === site.kind ||
          'data' === site.kind ||
          '2.0' === written ||
          '3.0' === written ||
          ('schema' === site.kind && site.alone),
        lays: 'pathItem' === site.kind && 0 < beside.length ? beside : null,
        mapping: false,
      }
      const to = refer(from, land, space, at, dd, ds)
      if ('ref' in to) {
        define(out, '$ref', to.ref)
        // A reference in data has nothing beside it that is read. Where
        // it is written in a place that has a type, what is beside it
        // would be: it is written alone.
        if ('data' === site.kind && null !== expectAt(ds)) for (const k of beside) delete out[k]
        // And a reference of a document of another version than the
        // description's is read in the bundle by the description's rule
        // for what is beside it.
        else if (written !== mv && 0 < beside.length && ('data' !== ds.state || true === ds.edge)) {
          const then = readBeside(written, site, site.alone)
          const now = readBeside(mv, site, hasIds(mv) ? dialectOf(inside).dialect.refAlone : true)
          // What that rule reads, and the document's own did not, is
          // left out, and said: a member beside a schema's `$ref` in
          // 3.0, which 3.1 would apply, and a `summary` beside a
          // response's reference in 3.1, which 3.2 would put in the
          // place of the response's own.
          for (const k of beside) {
            if (!own(out, k) || !isRead(now, k) || isRead(then, k)) continue
            left.push({ at: pointerAt(down(at, k)), ref: out[k], why: 'sibling' })
            delete out[k]
          }
          // What the document's rule read, and the description's does
          // not. Beside a schema's `$ref` it is what applies with the
          // reference, which every version can say: the reference is
          // written as the first of an `allOf`, as resolving reads it.
          // Beside any other reference it is a field that stands in the
          // place of the target's own. No older version has a way to
          // say that, so the field stands where it is, unread, and is
          // said.
          const lost = beside.filter((k) => own(out, k) && isRead(then, k) && !isRead(now, k))
          if (0 < lost.length && 'schema' === site.kind) {
            const rest: [string, any][] = Object.keys(out).filter((k) => '$ref' !== k && 'allOf' !== k).map((k) => [k, out[k]])
            const first = Object.create(null)
            define(first, '$ref', out.$ref)
            // An `allOf` there that is no list is nothing that resolving
            // reads beside a `$ref`, and the list has no place for it:
            // it is left out, and said.
            if (own(out, 'allOf') && !Array.isArray(out.allOf)) {
              left.push({ at: pointerAt(down(at, 'allOf')), ref: out.allOf, why: 'sibling' })
            }
            const all = [first, ...(Array.isArray(out.allOf) ? out.allOf : [])]
            for (const k of Object.keys(out)) delete out[k]
            define(out, 'allOf', all)
            for (const [k, v] of rest) define(out, k, v)
          } else {
            for (const k of lost) left.push({ at: pointerAt(down(at, k)), ref: out[k], why: 'version' })
          }
        }
      } else if ('left' in to) {
        stands(to.left, land)
        if (('cycle' === to.left || 'outside' === to.left) && null === space.res && undefined !== land.loc) {
          around.push({ out, at, loc: land.loc, row: left[left.length - 1], gives: expectAt(ds) })
        }
      } else {
        if (null === from.lays || !isMap(to.inline)) return to.inline
        for (const k of from.lays) define(to.inline, k, out[k])
        return to.inline
      }
      return out
    }

    const tree = copy(raw, index.root, rootSpace, null, home.rootDialect, rootDest)
    rootSpace.node = tree

    // The targets, each copied where it was put. A target may name more.
    for (let i = 0; i < queue.length; i++) {
      const unit = queue[i]
      const value = copy(unit.node, unit.loc, unit.space, atOf(unit.at), unit.dd, unit.ds)
      // The map it was given a name in is there, or is made now. A name
      // was given only where the bundle has such a map, or nothing.
      let holder = unit.space.node
      const name = String(unit.rel[unit.rel.length - 1])
      for (const seg of unit.rel.slice(0, -1)) {
        if (isMap(holder) && !own(holder, String(seg))) define(holder, String(seg), Object.create(null))
        holder = isMap(holder) ? holder[seg] : undefined
      }
      if (!isMap(holder) || own(holder, name)) throw new Error('bundle: no place for a target at ' + pointer(unit.at))
      define(holder, name, value)
    }

    // A target that could not be written inside itself has a place by
    // now where another reference holds it alone: it is named there.
    const placed = new Set<Left>()
    for (const c of around) {
      const got = within(rootSpace, c.loc)
      if (undefined === got) continue
      define(c.out, '$ref', '#' + fragment(got))
      landings.push({ at: c.at, to: pointer(got), gives: c.gives, loc: c.loc })
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
          if (undefined === path) {
            if ('no-anchor' === where.why) wishOf(d.text, d.loc.base)
            else wish(land)
          }
          left.push({ at: pointerAt(d.at), ref: d.text, why: undefined === path ? (where.why ?? 'not-found') : 'outside' })
          text = leftAs(d.text, d.loc.base, d.space)
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
        if (!fine) left.push({ at: pointerAt(d.at), ref: d.text, why: 'dynamic' })
        if (!settled && !d.text.startsWith('#')) text = rebase(d.text, d.loc.base, d.space.base)
      }
      if (text === d.text) continue
      if (Array.isArray(d.out)) d.out[d.key as number] = text
      else define(d.out, String(d.key), text)
    }

    // A part that a reference gave a type is read as it was where a
    // reference of that type lands on it in the bundle, and that
    // reference is itself read: it is not inside a part that is read as
    // data. So the parts that are read are found from the outside in,
    // and the others are listed. A part that a reference of another type
    // lands on too is listed with them: which of the two types it is
    // read as follows the order they are read in, which is not the order
    // the documents had them in.
    if (0 < edges.length) {
      type Edge = (typeof edges)[number]
      const byPlace = new Map<string, Edge>()
      const byAt = new Map<At, Edge>()
      for (const e of edges) {
        byPlace.set(pointerAt(e.at), e)
        byAt.set(e.at, e)
      }
      // The innermost such part that a place is in, and the parts that
      // the references in each land on. Null is the rest of the bundle.
      const lands = new Map<Edge | null, Edge[]>()
      const mixed = new Set<Edge>(edges.filter((e) => true === e.never))
      const places = [...byPlace.keys()]
      for (const l of landings) {
        if (null === l.gives) continue
        // A reference of another type than what it lands on has. Where
        // that is in such a part, or is one, it may be the first to
        // land there, and then the part is read as that type.
        if (l.gives !== typeAt(whole(l.loc))) {
          for (const place of places) if (l.to === place || l.to.startsWith(place + '/')) mixed.add(byPlace.get(place)!)
          continue
        }
        const to = byPlace.get(l.to)
        if (undefined === to) continue
        let within: Edge | null = null
        for (let p = l.at; null !== p && null === within; p = p.up) within = byAt.get(p) ?? null
        const list = lands.get(within)
        if (undefined === list) lands.set(within, [to])
        else list.push(to)
      }
      const read = new Set<Edge>()
      const todo: (Edge | null)[] = [null]
      while (0 < todo.length) {
        for (const to of lands.get(todo.pop()!) ?? []) {
          if (read.has(to) || mixed.has(to)) continue
          read.add(to)
          todo.push(to)
        }
      }
      // A part that is listed says what is in it too.
      const inside = (e: Edge): boolean => {
        for (let p = null === e.at ? null : e.at.up; null !== p; p = p.up) {
          const outer = byAt.get(p)
          if (undefined !== outer && !read.has(outer)) return true
        }
        return false
      }
      for (const e of edges) {
        if (read.has(e) || inside(e)) continue
        const path = pathOf(e.loc)
        left.push({ at: pointerAt(e.at), ref: e.loc.doc.key + (0 === path.length ? '' : '#' + fragment(path)), why: 'type' })
      }
    }

    // Whether a reference hopes for something this writing made.
    const meets = (keys: Set<string>, hopes: Set<string>): boolean => {
      for (const key of keys) if (hopes.has(key)) return true
      return false
    }
    const clash = meets(given, wished.under) || meets(made, wished.exact) || meets(anchored, wished.anchors)
    return { tree, embedded, left, dialects, units, targets: rootSpace.defs, inlined, wished, clash }
  }

  // The copying follows the nesting of what it copies. A depth that the
  // stack cannot hold is refused as the index refuses one.
  const writing = (tops: Map<Loc, string | null> | undefined, hoped: Hoped) => {
    try {
      return write(tops, hoped)
    } catch (err: any) {
      if (ranOut(err)) {
        refuse('openapi_depth', 'the stack ran out before maxDepth (' + limit + ') was reached; lower maxDepth', '')
      }
      throw err
    }
  }

  // A target that is inside another target would be in the bundle
  // twice, and which of the two a reference names would follow the
  // order the references are met in. Where that is so the bundle is
  // written again, bringing in the outermost of them only, and what is
  // in it is named there. It is written again too where a name it gave,
  // a map it made or an anchor it took in is one that a reference hopes
  // for, which a writing may find only after it gave the name. The next
  // writing starts with every hope of this one.
  let tops: Map<Loc, string | null> | undefined
  let hoped = noHopes()
  let done = writing(tops, hoped)
  for (let round = 1; ; round++) {
    let again = false
    const units = done.units
    const inside = (loc: Loc): boolean => {
      for (let p = loc.parent; undefined !== p; p = p.parent) if (units.has(p)) return true
      return false
    }
    let nested = false
    for (const loc of done.targets.keys()) if ((nested = inside(loc))) break
    if (!nested) for (const loc of done.inlined) if ((nested = inside(loc))) break
    if (nested) {
      const next = new Map(tops ?? [])
      for (const [loc, type] of units) if (!inside(loc)) next.set(loc, type)
      if (next.size !== (tops?.size ?? 0)) {
        tops = next
        again = true
      }
    }
    if (done.clash) {
      const w = done.wished
      hoped = {
        exact: new Set([...hoped.exact, ...w.exact]),
        under: new Set([...hoped.under, ...w.under]),
        anchors: new Set([...hoped.anchors, ...w.anchors]),
      }
      again = true
    }
    if (!again) break
    if (WRITES <= round) throw new Error('bundle: the writing does not settle')
    done = writing(tops, hoped)
  }

  const result: BundleResult = {
    tree: done.tree,
    version: detected,
    documents: others.map((doc) => doc.key),
    embedded: done.embedded,
    left: done.left,
    dialects: done.dialects,
  }
  return result
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
