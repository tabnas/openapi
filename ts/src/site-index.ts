/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// The site index: every fact about a document that resolving it needs,
// worked out before any value is built. `resolve` reads it and adds
// nothing to it, so each fact is stated once, here.
//
// It is one index over a set of documents: the description, and any
// document given with it. Each has a root and locations of its own. The
// identifiers, the sites, the landings and the rounds are those of the
// set, so a reference is met by whichever document holds what it names.
//
// What it owns:
//
//   locations  every map and list of each document, by where it is, with
//              the state the object model gives it, its base URI and the
//              schema dialect it is read by;
//   sites      every map whose `$ref` is a reference, with its kind and
//              type, and what the reference names;
//   ids        the index of identifiers and anchors, each schema's by the
//              rules of its dialect;
//   landings   for each site, the location its reference lands on, read on
//              the document as written, and the sites the pointer was read
//              through to get there;
//   regions    the maps the model gives no state, typed by the references
//              that land on them, found in rounds.
//
// What it does not own is anything that depends on the tree being built:
// the values, what is shared, and which edge of a cycle is cut. Those are
// the fold's, in `resolve`.
//
// The design is section 3 of docs/design/typescript-plan.md, and the
// prototype it follows is docs/design/prototype/e12-site-index/.

import { DIALECTS, dialectOf } from './dialect'
import type { Dialect, DialectUse } from './dialect'
import { kindFrom, schemaStates, slot, stepper } from './model'
import type { How, ModelVersion, SlotKind } from './model'
import {
  NOTHING,
  PLAIN_NAME,
  fragmentOf,
  isMap,
  normalizeEncoding,
  normalizeUri,
  own,
  pointer,
  pointerParts,
  resolveUri,
  stepInto,
  withoutFragment,
} from './uri'
import type { Path } from './uri'

// The kind of a site: what the object model says its position holds, or
// data for a site that `slots` or `extensions` made one.
type Kind = 'reference' | 'schema' | 'pathItem' | 'data'

// Why a reference was left as written.
type Why =
  | 'not-a-string'
  | 'bad-fragment'
  | 'not-found'
  | 'no-anchor'
  | 'external'
  | 'non-object-target'

// What the model, and the typing by reference, know of a location: it has
// a state (`typed`); the model names it and says it is plain JSON
// (`data`); or the model gives it no state at all (`unknown`), because it
// is in an extension, or a member the model does not have, or below one.
// Only an unknown location is typed by a reference that lands on it.
type Known = 'typed' | 'data' | 'unknown'

// JSON Schema identifiers and anchors, and schema dialects, exist in
// OpenAPI from 3.1.
const hasIds = (v: ModelVersion) => '3.1' === v || '3.2' === v

// A region typed by a reference: the state it took, the site whose
// landing gave it, and the round that found it.
type Region = { state: string; by: SiteFacts; round: number }

// One document of the set.
type DocFacts = {
  // The URI the document is known by: the one it was retrieved from, in
  // its normal form and with no fragment. The fold knows it by this.
  key: string
  // Its own URI, which is the base URI of its root: its `$self` where it
  // has one, else `key`.
  uri: string
  raw: any
  // The version whose object model it is read by: its own, where its
  // root declares one. A document that declares none takes the version
  // of the first document whose reference types a part of it.
  mv: ModelVersion
  // Whether it is read as a description, from its root down. Any other
  // document is read as the references that land in it type it.
  described: boolean
  // The dialect a schema of it is read under unless it says.
  rootDialect: string
  root: Loc
}

// A document as the caller of `buildIndex` gives it.
type DocInput = Omit<DocFacts, 'root'>

// One map or list of a document, by where it is. Two locations that
// hold one object, as a tree built by hand may, are two of these.
class Loc {
  // Its members that are maps or lists, in their order, and the same by
  // name once one has been asked for by name.
  kids: Loc[] | undefined = undefined
  named: Map<string, Loc> | undefined = undefined
  // Its place in document order, a container before its members.
  ord = -1
  // What the model says it holds, and what is known of that.
  state = 'data'
  known: Known = 'unknown'
  // The base URI and schema dialect its own members are read under: its
  // parent's, or its own identifier and `$schema` where it is a Schema
  // Object. The dialect is the identifier as written.
  base = ''
  dialect = ''
  // The rules a Schema Object here is read by, which are its dialect's.
  rules: Dialect | undefined = undefined
  // Whether it is inside an extension the caller named.
  ext = false
  // The site it is, if its `$ref` is a reference.
  site: SiteFacts | undefined = undefined
  // Whether it is a reference its dialect leaves to evaluation: a
  // `$dynamicRef` of 2020-12 or a `$recursiveRef` of 2019-09.
  dynamic = false
  // Whether it is a `$ref` map the model types as data.
  slot = false
  // The identifiers it declares, as keys of the index.
  ids: string[] | undefined = undefined
  // The type a reference gave it, and whether a location below it was
  // given one.
  region: Region | undefined = undefined
  holdsRegion = false
  // The state, base URI and dialect it was given when it was last
  // surveyed. With what is known of it and `ext`, they are what a survey
  // reads it under, so one that would find the same again can pass it by.
  // Its state is the one given unless it is a schema of another dialect.
  inState = 'data'
  inBase = ''
  inDialect = ''

  constructor(
    readonly parent: Loc | undefined,
    readonly seg: string | number,
    readonly raw: any,
    readonly depth: number,
    readonly doc: DocFacts,
  ) {}
}

// Where a reference lands: the location, read on the document as
// written. `through` lists the sites the pointer was read through, where a
// step was missing as written and the walk went on in what that site
// names. Each is listed where this pointer's own step was missing: what
// such a site was itself read through is in its own landing.
type Landing = {
  found: boolean
  // The pointer comes back to a site it is being read through.
  loop?: boolean
  // The document the landing is in, and its path there.
  doc?: DocFacts
  path?: Path
  // The raw value there, and its location when it is a map or a list.
  node?: any
  loc?: Loc
  through?: string[]
}

// One site: a fact about the document, whatever resolving makes of it.
type SiteFacts = {
  loc: Loc
  // The round that first found it: 0 for a site the model types by
  // position, and one more for each region a reference had to type first.
  round: number
  path: Path
  at: string
  kind: Kind
  type: string | null
  state: string
  ref: unknown
  base: string
  dialect: string
  // Whether its `$ref` stands alone, as in a schema of draft-04 to
  // draft-07: the members beside it are not read.
  alone: boolean
  // Why it names nothing in this document, when that is so.
  why?: Why
  // The location it names, as the reference is written, and the document
  // that location is in.
  target?: Path
  targetDoc?: DocFacts
  // For a reference into another document: that document's URI, and the
  // fragment the reference has, if any.
  uri?: string
  fragment?: string
  landing?: Landing
  // A reason that follows from the site alone, before it is located.
  pre?: Why
  // Whether it is to be located again.
  stale?: boolean
}

type IndexConfig = {
  mv: ModelVersion
  // The URI of the document, which is the base URI of its root, and the
  // URI it was retrieved from: each in its normal form, with no fragment.
  entry: string
  retrieved: string
  // The dialect a schema is read under unless it says.
  rootDialect: string
  // The documents given with the description, in the order given.
  others?: DocInput[]
  // 'spec' or 'all', as `resolve` takes it.
  slots: 'spec' | 'all'
  // The extension members the caller named.
  extensions: Set<string>
  // True under `refs: 'pointer'`: no identifiers, no landings and no
  // typing by reference.
  pointers: boolean
  // The deepest a map or list may be, and the most sites one pointer may
  // be read through.
  maxDepth: number
  // Raise an error: nesting or a pointer past `maxDepth`
  // (`openapi_depth`), or typing rounds that take more work than a
  // document of this size does (`openapi_work`).
  refuse: (code: string, message: string, at: string) => never
  // Called once for each unit of work, when the caller counts them.
  tick?: () => void
  // For the tests: false to work every round out from nothing, which is
  // what the incremental index is held to.
  incremental?: boolean
}

type Located = { target?: Path; doc?: DocFacts; why?: Why; uri?: string; fragment?: string }

type SiteIndex = {
  // The description's own root, and every document of the set, the
  // description first.
  root: Loc
  docs: DocFacts[]
  // The documents that something located here names and the set does not
  // have, by URI.
  wanted: Set<string>
  // The URI the document was retrieved from, which is not its own where
  // it has `$self`.
  retrieved: string
  // Every site, in the order found: document order within a round.
  sites: SiteFacts[]
  // The `$ref` maps the model types as data.
  dataSlots: number
  // How many rounds of typing by reference found something.
  rounds: number
  // The location of a member of a map or list, when it is one itself.
  child: (loc: Loc, seg: string | number) => Loc | undefined
  // A URI reference against a base: the location it names here, or why it
  // names none.
  locate: (ref: string, base: string) => Located
  // Where a site's reference lands.
  landing: (site: SiteFacts) => Landing
  // Where a location named by a path lands, as a site's reference does:
  // in the description, or in the document given.
  landingAt: (target: Path, doc?: DocFacts) => Landing
  // The state at a landing: the model's, or the one a reference gave.
  stateAt: (landing: Landing) => string
  // The dialect each schema declares with `$schema`, in document order,
  // and the one it is read by.
  dialects: () => DialectUse[]
  // The type of what a site's reference lands on, where the model types
  // that and it is not the type the reference expects.
  conflict: (site: SiteFacts) => string | undefined
  // The most work that anything past one reading of the document may
  // take: `EXTRA_FACTOR` times that reading, and `EXTRA_FLOOR` besides.
  // The index holds its own later rounds and pointer steps to it, and the
  // `connections` report its walk of routes.
  allowance: number
}

// Two things the index does can cost more than one pass over the
// document: the typing rounds after the first, and reading a pointer on
// through a reference where a step is missing. Together they may take
// this many times the work of the first pass, and this much besides. A
// description comes nowhere near it. Of 5,168 in the corpus, seven have a
// round after the first, the longest five, and none has a pointer that is
// read through a reference at all. A document built to make each round
// undo the last, or to read many pointers through one long chain, ends
// here with a code.
const EXTRA_FACTOR = 16
const EXTRA_FLOOR = 100_000

const NO_LANDING: Landing = { found: false }
const LOOP: Landing = { found: false, loop: true }

function pathOf(loc: Loc): Path {
  const path: Path = []
  for (let p: Loc | undefined = loc; undefined !== p && undefined !== p.parent; p = p.parent) path.push(p.seg)
  return path.reverse()
}

const samePath = (a: Path | undefined, b: Path | undefined): boolean => {
  if (a === b) return true
  if (undefined === a || undefined === b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (String(a[i]) !== String(b[i])) return false
  return true
}

// What a state is in one version's object model.
type StateInfo = { kind: Kind | null; type: string | null; schema: boolean; refable: boolean; from: SlotKind }

// What a dialect's identifier names in one version's object model: its
// rules, whether this package knows it, and the state of a Schema Object
// read by it.
type Spoken = { rules: Dialect; known: boolean; state: string }

// One version's object model, as the index reads it: each answer worked
// out once.
type Model = {
  mv: ModelVersion
  step: (state: string, member: string | number, why?: { how: How }) => string
  // Whether a schema of this version has identifiers and anchors.
  ids: boolean
  infoOf: (state: string) => StateInfo
  spokenOf: (uri: string) => Spoken
  // Whether the model has a state of this name.
  has: (state: string) => boolean
  // The name of what a state holds: the type of an object, `schema` for
  // a schema of any dialect, `map` or `list` for a container with no type
  // of its own, and `data` for anything else, a string the model reads
  // as a name or a URL among them.
  typeOf: (state: string) => string
}

function modelFor(mv: ModelVersion): Model {
  const stateInfos = new Map<string, StateInfo>()
  const infoOf = (state: string): StateInfo => {
    let i = stateInfos.get(state)
    if (undefined === i) {
      const s = slot(mv, state)
      const kind: Kind | null =
        'schema' === s.kind
          ? 'schema'
          : 'refable' === s.kind || 'reference' === state
            ? 'reference'
            : 'object' === s.kind && 'pathItem' === s.type
              ? 'pathItem'
              : null
      i = { kind, type: s.type, schema: 'schema' === s.kind, refable: 'refable' === s.kind, from: kindFrom(mv, state) }
      stateInfos.set(state, i)
    }
    return i
  }
  const schemaState = schemaStates(mv)
  const spokens = new Map<string, Spoken>()
  const spokenOf = (uri: string): Spoken => {
    let spoken = spokens.get(uri)
    if (undefined === spoken) {
      const d = dialectOf(uri)
      spoken = { rules: d.dialect, known: d.known, state: schemaState[d.dialect.name] ?? 'schema' }
      spokens.set(uri, spoken)
    }
    return spoken
  }
  const typeOf = (state: string): string => {
    const s = slot(mv, state)
    if ('schema' === s.kind) return 'schema'
    if ('object' === s.kind || 'refable' === s.kind) return s.type ?? 'map'
    return 'list' === s.kind ? 'list' : 'data'
  }
  return {
    mv,
    step: stepper(mv),
    ids: hasIds(mv),
    infoOf,
    spokenOf,
    has: (state) => 'data' === state || slot(mv, state).state === state,
    typeOf,
  }
}

// Build the index of a description, and of the documents given with it.
function buildIndex(raw: any, cfg: IndexConfig): SiteIndex {
  const { pointers, maxDepth, refuse } = cfg
  const all = 'all' === cfg.slots
  const extensions = cfg.extensions
  const incremental = false !== cfg.incremental
  const typing = !pointers

  // The object model of each version a document of the set is read by.
  const models = new Map<ModelVersion, Model>()
  const modelOf = (doc: DocFacts): Model => {
    let m = models.get(doc.mv)
    if (undefined === m) models.set(doc.mv, (m = modelFor(doc.mv)))
    return m
  }

  // The documents: the description first, then the others as given. Each
  // is known by its retrieval URI and by its own, and of two documents
  // with one URI the first given has it.
  const docs: DocFacts[] = []
  const docByUri = new Map<string, DocFacts>()
  const wanted = new Set<string>()
  const addDoc = (d: DocInput) => {
    const doc = { ...d } as DocFacts
    doc.root = new Loc(undefined, '', d.raw, 0, doc)
    docs.push(doc)
    if (!docByUri.has(doc.key)) docByUri.set(doc.key, doc)
    if (!docByUri.has(doc.uri)) docByUri.set(doc.uri, doc)
  }
  addDoc({ key: cfg.retrieved, uri: cfg.entry, raw, mv: cfg.mv, described: true, rootDialect: cfg.rootDialect })
  for (const other of cfg.others ?? []) addDoc(other)
  const root = docs[0].root

  // Under `refs: 'pointer'` no dialect is read, and every schema is the
  // version's own.
  const OWN: Spoken = { rules: DIALECTS['2020-12'], known: true, state: 'schema' }
  // The schemas that declare a dialect, and what each declares.
  const declared = new Map<Loc, string>()

  const sites: SiteFacts[] = []
  const idIndex = new Map<string, Loc>()
  // The locations that declare an identifier.
  const declarers = new Set<Loc>()
  let idsMoved = false
  let dataSlots = 0
  let nextOrd = 0
  let round = 0
  // Sites found, or changed, since the landings were last worked out.
  let stirred: SiteFacts[] = []

  // The work done, in visits, references located and pointer steps. The
  // part of it that is held to a bound is `extra`: everything after the
  // first round, and every step of a pointer read on through a reference.
  let work = 0
  let extra = 0
  let extraLimit = Infinity
  const tick = cfg.tick
  const charge = (at: Loc | undefined) => {
    extra++
    if (extraLimit < extra) {
      refuse(
        'openapi_work',
        'reading the references of this document takes more than ' +
          EXTRA_FACTOR +
          ' times the work of reading it once',
        undefined === at ? '' : pointer(pathOf(at)),
      )
    }
  }
  const worked = (at: Loc | undefined) => {
    work++
    if (0 < round) charge(at)
    if (undefined !== tick) tick()
  }

  // ---- the survey: every fact that follows from the typing so far ----

  const how: { how: How } = { how: 'none' }

  const knownAfter = (known: Known, fromKind: string, next: string): Known => {
    if ('data' !== next) return 'typed'
    if ('below' === how.how) return 'typed' === known ? 'data' : known
    if ('ext' === how.how || 'none' === how.how) return 'unknown'
    // A schema's catch-all takes the keywords its dialect does not have,
    // `definitions` and `dependencies` in 2020-12 among them. Any other
    // catch-all to data is a map of plain values the model names.
    if ('rest' === how.how) return 'schema' === fromKind ? 'unknown' : 'data'
    return 'data'
  }

  const declare = (loc: Loc, keys: string[] | undefined) => {
    const had = loc.ids
    if (undefined === had && undefined === keys) return
    if (undefined !== had && undefined !== keys && had.length === keys.length && had.every((k, i) => k === keys[i])) return
    loc.ids = keys
    if (undefined === keys) declarers.delete(loc)
    else declarers.add(loc)
    // In the first pass the locations come in document order, so the last
    // to declare a name has it. After that the index is made again.
    if (0 === round && undefined === had) for (const k of keys!) idIndex.set(k, loc)
    else idsMoved = true
  }

  type Frame = [Loc, string, Known, string, string, boolean]

  // Survey the document from `top` down, which is read under what the
  // frame says. A location found as it was last surveyed is passed by,
  // with everything below it.
  const survey = (top: Frame, skip: boolean) => {
    const stack: Frame[] = [top]
    while (0 < stack.length) {
      const frame = stack.pop()!
      const loc = frame[0]
      let state = frame[1]
      let known = frame[2]
      const base = frame[3]
      const dialect = frame[4]
      const ext = frame[5]
      if (undefined !== loc.region) {
        state = loc.region.state
        known = 'typed'
      }
      if (
        skip &&
        0 <= loc.ord &&
        loc.inState === state &&
        loc.known === known &&
        loc.inBase === base &&
        loc.inDialect === dialect &&
        loc.ext === ext
      ) {
        continue
      }
      worked(loc)
      if (maxDepth <= loc.depth) {
        refuse('openapi_depth', 'nesting deeper than ' + maxDepth, pointer(pathOf(loc)))
      }
      const first = loc.ord < 0
      if (first) loc.ord = nextOrd++
      loc.inState = state
      loc.inBase = base
      loc.inDialect = dialect

      const node = loc.raw
      const list = Array.isArray(node)
      const m = modelOf(loc.doc)
      let info = m.infoOf(state)
      let mine = base
      let speaks = dialect
      let rules: Dialect | undefined
      if (!list) {
        if (loc.slot) {
          dataSlots--
          loc.slot = false
        }
        loc.dynamic = false
        let keys: string[] | undefined
        let says: string | undefined
        if (m.ids && info.schema) {
          // A Schema Object is read by the dialect it declares, else by
          // the one in force where it is. Its state is that dialect's,
          // which says which of its members hold schemas.
          if ('string' === typeof node.$schema) speaks = node.$schema
          const spoken = pointers ? OWN : m.spokenOf(speaks)
          rules = spoken.rules
          if (!pointers) {
            if ('string' === typeof node.$schema) says = node.$schema
            if (state !== spoken.state) {
              state = spoken.state
              info = m.infoOf(state)
            }
          }
          // In draft-04 to draft-07 a `$ref` stands alone: an identifier
          // beside it is not read.
          if (!(rules.refAlone && 'string' === typeof node.$ref)) {
            const id = node[rules.id]
            if ('string' === typeof id) {
              const abs = normalizeUri(resolveUri(base, id))
              const resource = withoutFragment(abs)
              const name = fragmentOf(abs)
              if (rules.idAnchor && undefined !== name && PLAIN_NAME.test(name)) {
                // `#name`, the anchor of draft-04 to draft-07: the base
                // is as it was.
                keys = [abs]
              } else if (resource !== base) {
                // A schema resource, whose URI its members are read
                // against. A fragment that is no anchor here is dropped,
                // as the empty one of the older dialects' own
                // identifiers is.
                mine = resource
                keys = [mine]
              }
              // What is left names the resource it is in, with or
              // without a fragment that is no anchor here: `$id: '#name'`
              // in 2020-12, or `id: '#'`. It names nothing new. Read as
              // a resource it would take the place of the one it is in,
              // and every reference into that one would be read from
              // here.
            }
            for (const a of rules.anchors) {
              if ('string' === typeof node[a]) (keys ??= []).push(mine + '#' + node[a])
            }
          }
        }
        if (undefined === says) declared.delete(loc)
        else declared.set(loc, says)
        declare(loc, keys)
        if (own(node, '$ref')) {
          const ref = node.$ref
          let k: Kind | null = info.kind
          if (null == k) {
            dataSlots++
            loc.slot = true
            if ('string' === typeof ref && (all || ext)) k = 'data'
          }
          // Under `refs: 'pointer'` the root is where pointers start,
          // never a site of its own.
          if (null != k && !(pointers && 0 === loc.depth)) {
            const type = 'reference' === k ? info.type : 'pathItem' === k || 'schema' === k ? k : null
            const pre: Why | undefined = 'string' !== typeof ref ? 'not-a-string' : undefined
            const alone = undefined !== rules && rules.refAlone
            let row = loc.site
            if (undefined === row) {
              const path = pathOf(loc)
              row = loc.site = {
                loc, round, path, at: pointer(path), kind: k, type, state, ref, base: mine, dialect: speaks, alone, pre, stale: true,
              }
              sites.push(row)
              stirred.push(row)
            } else if (
              row.kind !== k ||
              row.type !== type ||
              row.state !== state ||
              row.base !== mine ||
              row.dialect !== speaks ||
              row.alone !== alone ||
              row.pre !== pre
            ) {
              row.kind = k
              row.type = type
              row.state = state
              row.base = mine
              row.dialect = speaks
              row.alone = alone
              row.pre = pre
              if (!row.stale) {
                row.stale = true
                stirred.push(row)
              }
            }
          }
        } else if (undefined !== rules && null !== rules.dynamic && own(node, rules.dynamic)) {
          loc.dynamic = !pointers
        }
      }
      loc.state = state
      loc.known = known
      loc.base = mine
      loc.dialect = speaks
      loc.rules = rules
      loc.ext = ext

      // Its members that are maps or lists are found once, in their
      // order, and are the same members at every later survey.
      let kids = loc.kids
      if (first) {
        const names: (string | number)[] = list ? node.map((_: any, i: number) => i) : Object.keys(node)
        for (const name of names) {
          const child = node[name]
          if (!Array.isArray(child) && !isMap(child)) continue
          if (undefined === kids) kids = loc.kids = []
          kids.push(new Loc(loc, name, child, loc.depth + 1, loc.doc))
        }
      }
      if (undefined !== kids) {
        for (let i = kids.length - 1; 0 <= i; i--) {
          const kid = kids[i]
          const next = m.step(state, kid.seg, how)
          stack.push([
            kid,
            next,
            knownAfter(known, info.from, next),
            mine,
            speaks,
            ext || (0 < extensions.size && extensions.has(String(kid.seg))),
          ])
        }
      }
    }
  }

  // A description is read from its root, which the model types. Any other
  // document is data, of which nothing is known, until a reference types
  // a part of it.
  const surveyAll = (skip: boolean) => {
    for (const doc of docs) {
      if (!Array.isArray(doc.raw) && !isMap(doc.raw)) continue
      const top: Frame = doc.described
        ? [doc.root, 'root', 'typed', doc.uri, doc.rootDialect, false]
        : [doc.root, 'data', 'unknown', doc.uri, doc.rootDialect, false]
      survey(top, skip)
    }
  }

  // ---- what a reference names ----

  // A reference read as a pointer into this document and nothing else:
  // `#/…`, from the root, with `~1` and `~0` and no percent-decoding.
  // Under `refs: 'pointer'`, a root that is itself a reference is followed
  // before any pointer is read, and following it needs the root again: no
  // pointer names anything in such a document.
  const rootIsReference = pointers && isMap(raw) && 'string' === typeof raw.$ref
  const locatePointer = (ref: string): Located => {
    if (!ref.startsWith('#/')) return { why: ref.startsWith('#') ? 'bad-fragment' : 'external' }
    if (rootIsReference) return { why: 'not-found' }
    return { target: ref.slice(2).split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~')) }
  }

  // A URI reference, against a base: the location it names in a document
  // of the set, or why it names none there. An identifier a schema
  // declares is looked for first, in every document, and then a document
  // by its own URI or the one it was retrieved from. URIs are compared in
  // their normal form (RFC 3986 section 6.2), so one that differs from a
  // document's in the case of its scheme or host, in a default port or in
  // a percent-encoded letter still names that document. Every base is in
  // that form and has no fragment, so a reference that is a fragment
  // alone names the base's own document without being resolved.
  const locateUri = (ref: string, base: string): Located => {
    let doc: string
    let fragment: string | undefined
    if (ref.startsWith('#')) {
      doc = base
      fragment = normalizeEncoding(ref.slice(1))
    } else {
      const abs = normalizeUri(resolveUri(base, ref))
      doc = withoutFragment(abs)
      fragment = fragmentOf(abs)
    }
    let start: Path
    let home: DocFacts
    const named = idIndex.get(doc)
    if (undefined !== named) {
      start = pathOf(named)
      home = named.doc
    } else {
      const whole = docByUri.get(doc)
      if (undefined === whole) {
        wanted.add(doc)
        return undefined === fragment ? { why: 'external', uri: doc } : { why: 'external', uri: doc, fragment }
      }
      start = []
      home = whole
    }
    if (undefined === fragment || '' === fragment) return { target: start, doc: home }
    if (fragment.startsWith('/') || /^%2f/i.test(fragment)) {
      const parts = pointerParts(fragment)
      return null == parts ? { why: 'bad-fragment' } : { target: [...start, ...parts], doc: home }
    }
    // A plain name is an anchor where the document named has schemas that
    // declare them.
    if (modelOf(home).ids && PLAIN_NAME.test(fragment)) {
      const anchored = idIndex.get(doc + '#' + fragment)
      return undefined === anchored ? { why: 'no-anchor' } : { target: pathOf(anchored), doc: anchored.doc }
    }
    return { why: 'bad-fragment' }
  }

  // Locate one site, and say whether what it names moved.
  const locateSite = (row: SiteFacts): boolean => {
    worked(row.loc)
    const where: Located =
      undefined !== row.pre
        ? { why: row.pre }
        : pointers
          ? locatePointer(row.ref as string)
          : locateUri(row.ref as string, row.base)
    const moved =
      row.why !== where.why ||
      row.uri !== where.uri ||
      row.fragment !== where.fragment ||
      row.targetDoc !== where.doc ||
      !samePath(row.target, where.target)
    row.why = where.why
    row.target = where.target
    row.targetDoc = where.doc
    row.uri = where.uri
    row.fragment = where.fragment
    row.stale = false
    return moved
  }

  // ---- landings: a pointer read on the document as written ----

  const busy = new Set<SiteFacts>()

  // The member of a location by name, where it is a map or a list. A
  // location with many such members keeps them by name from the first
  // time one is asked for.
  const kidOf = (loc: Loc | undefined, seg: string | number): Loc | undefined => {
    if (undefined === loc) return undefined
    const kids = loc.kids
    if (undefined === kids) return undefined
    const key = String(seg)
    if (kids.length <= 8) {
      for (let i = 0; i < kids.length; i++) if (String(kids[i].seg) === key) return kids[i]
      return undefined
    }
    let named = loc.named
    if (undefined === named) {
      named = loc.named = new Map()
      for (const kid of kids) named.set(String(kid.seg), kid)
    }
    return named.get(key)
  }

  // Read `segs` from the root of `start`. Where a step is missing at a
  // site, the walk goes on in what that site names, which may be in
  // another document. `self` is the site whose reference this is, when
  // it is one.
  const walkTo = (segs: Path, self: SiteFacts | undefined, start: DocFacts): Landing => {
    let doc = start
    let node: any = doc.raw
    let loc: Loc | undefined = doc.root
    // The location reached, once it is no longer the first `i` segments.
    let moved: Path | undefined
    let through: string[] | undefined
    let seen: Set<number> | undefined
    let i = 0
    while (i < segs.length) {
      worked(loc)
      const v = stepInto(node, segs[i])
      if (NOTHING !== v) {
        loc = null != v && 'object' === typeof v ? kidOf(loc, segs[i]) : undefined
        node = v
        if (undefined !== moved) moved.push(segs[i])
        i++
        continue
      }
      // The step is missing here. The root is where a walk starts, and is
      // not on its way.
      const here = undefined !== loc && 0 < loc.depth ? loc.site : undefined
      if (undefined === here || undefined !== here.why) return undefined === through ? NO_LANDING : { found: false, through }
      const key = here.loc.ord * (segs.length + 1) + i
      if (undefined === seen) seen = new Set()
      if (seen.has(key)) return { found: false, loop: true, through }
      seen.add(key)
      charge(loc)
      const via = here === self ? LOOP : landingOf(here)
      ;(through ??= []).push(here.at)
      if (via.loop) return { found: false, loop: true, through }
      if (!via.found) return { found: false, through }
      node = via.node
      loc = via.loc
      doc = via.doc!
      moved = via.path!.slice()
    }
    const out: Landing = { found: true, doc, path: undefined === moved ? segs : moved, node }
    if (undefined !== loc) out.loc = loc
    if (undefined !== through) out.through = through
    return out
  }

  const landingOf = (row: SiteFacts): Landing => {
    if (undefined !== row.landing) return row.landing
    if (undefined === row.target) return (row.landing = NO_LANDING)
    if (busy.has(row)) return LOOP
    if (maxDepth <= busy.size) {
      refuse('openapi_depth', 'a pointer read through more than ' + maxDepth + ' references', row.at)
    }
    busy.add(row)
    let out: Landing
    try {
      out = walkTo(row.target, row, row.targetDoc ?? row.loc.doc)
    } finally {
      busy.delete(row)
    }
    return (row.landing = out)
  }

  // ---- typing by reference ----

  // The state a landing takes from its site, where the site has one to
  // give.
  const gives = (row: SiteFacts): string | null => {
    if ('schema' === row.kind) return 'schema'
    if ('pathItem' === row.kind) return 'pathItem'
    if ('reference' === row.kind && modelOf(row.loc.doc).infoOf(row.state).refable) return row.state
    return null
  }

  // Type the landings of `rows` that the model gives no state, in the
  // order of their rounds and then of the document. Nothing is typed
  // twice: the first to land on a location types it.
  const typeLandings = (rows: SiteFacts[]): number => {
    // What each site gives is settled before anything is typed: a site
    // that this pass turns from data into a schema types in the next.
    const plan = rows
      .slice()
      .sort((a, b) => (a.round !== b.round ? a.round - b.round : a.loc.ord - b.loc.ord))
      .map((row): [SiteFacts, string | null] => [row, gives(row)])
    let typed = 0
    for (const [row, give] of plan) {
      const land = row.landing
      if (null == give || undefined === land || !land.found) continue
      const at = land.loc
      if (undefined === at || !isMap(at.raw) || 'unknown' !== at.known) continue
      // A state that the model of the landing's own document does not
      // have types nothing there: the two are of different versions.
      if (at.doc !== row.loc.doc && !modelOf(at.doc).has(give)) continue
      at.region = { state: give, by: row, round: round + 1 }
      for (let p = at.parent; undefined !== p && !p.holdsRegion; p = p.parent) p.holdsRegion = true
      typed++
      // What the region now holds is found at once, so that the next
      // landing in this pass is judged by it. The sites in it are of the
      // next round.
      round++
      try {
        if (incremental) survey([at, at.inState, at.known, at.inBase, at.inDialect, at.ext], true)
        else surveyAll(false)
      } finally {
        round--
      }
    }
    return typed
  }

  // Bring what each site names, and where it lands, up to the survey.
  // Gives the sites whose landing was worked out again.
  const settle = (): SiteFacts[] => {
    let everySite = !incremental
    let everyLanding = !incremental
    if (idsMoved) {
      idsMoved = false
      const before = new Map(idIndex)
      idIndex.clear()
      // The last in the document to declare a name has it.
      const inOrder = [...declarers].sort((a, b) => a.ord - b.ord)
      for (const loc of inOrder) {
        worked(loc)
        for (const k of loc.ids!) idIndex.set(k, loc)
      }
      let same = before.size === idIndex.size
      if (same) for (const [k, v] of before) if (idIndex.get(k) !== v) same = false
      // An identifier that moved may be named by any site.
      if (!same) everySite = true
    }
    if (everySite) for (const row of sites) row.stale = true
    const again = everySite ? sites : stirred
    const fresh = new Set<SiteFacts>()
    for (const row of again) {
      if (!row.stale) continue
      const isNew = undefined === row.landing
      // A site that names something else now may be one that another
      // site's pointer was read through.
      if (locateSite(row) && !isNew) everyLanding = true
      fresh.add(row)
    }
    stirred = []
    let redo: SiteFacts[]
    if (everyLanding) redo = sites
    else {
      // A new site may be one that a pointer stopped at for want of a
      // step: every landing not found is read again.
      redo = [...fresh]
      for (const row of sites) if (!fresh.has(row) && undefined !== row.landing && !row.landing.found) redo.push(row)
    }
    for (const row of redo) row.landing = undefined
    // Under `refs: 'pointer'` a site is read by the fold, as apidef reads
    // it, and a landing is worked out only when something asks for one.
    if (!pointers) for (const row of redo) landingOf(row)
    return redo
  }

  // ---- the rounds ----

  try {
    surveyAll(false)
    extraLimit = work * EXTRA_FACTOR + EXTRA_FLOOR
    let moved = settle()
    if (typing) {
      for (;;) {
        if (0 === typeLandings(incremental ? moved : sites)) break
        round++
        moved = settle()
      }
    }
  } catch (err: any) {
    if (err instanceof RangeError && /call stack/i.test(String(err.message))) {
      refuse('openapi_depth', 'the stack ran out before maxDepth (' + maxDepth + ') was reached; lower maxDepth', '')
    }
    throw err
  }

  // What the model holds at a landing, and what is known of it. A value
  // that is neither a map nor a list is judged by its parent's step to it.
  const heldAt = (landing: Landing): { state: string; known: Known } => {
    if (undefined !== landing.loc) return { state: landing.loc.state, known: landing.loc.known }
    const path = landing.path!
    let loc: Loc | undefined = (landing.doc ?? docs[0]).root
    for (let i = 0; i < path.length - 1 && undefined !== loc; i++) loc = kidOf(loc, path[i])
    if (undefined === loc || 0 === path.length) return { state: 'data', known: 'unknown' }
    const m = modelOf(loc.doc)
    const next = m.step(loc.state, path[path.length - 1], how)
    return { state: next, known: knownAfter(loc.known, m.infoOf(loc.state).from, next) }
  }

  const stateAt = (landing: Landing): string => (landing.found ? heldAt(landing).state : 'data')

  // A landing the model types keeps its type, whatever reference lands on
  // it. Where that is not the type the reference expects, the two
  // conflict: a schema's `$ref` to a response, say, or to a value the
  // model reads as plain data. A landing the model gives no type has
  // none to conflict with.
  const conflictOf = (row: SiteFacts): string | undefined => {
    const give = gives(row)
    if (null === give) return undefined
    const land = landingOf(row)
    if (!land.found) return undefined
    const held = heldAt(land)
    if ('unknown' === held.known) return undefined
    // Each is named by the model of its own document.
    const got = modelOf(land.doc ?? docs[0]).typeOf(held.state)
    return modelOf(row.loc.doc).typeOf(give) === got ? undefined : got
  }

  const dialects = (): DialectUse[] =>
    [...declared]
      .sort((a, b) => a[0].ord - b[0].ord)
      .map(([loc, uri]) => {
        const spoken = modelOf(loc.doc).spokenOf(uri)
        const use: DialectUse = { at: pointer([...pathOf(loc), '$schema']), dialect: uri, as: spoken.rules.name, known: spoken.known }
        if (loc.doc !== docs[0]) use.doc = loc.doc.key
        return use
      })

  return {
    root,
    docs,
    wanted,
    retrieved: cfg.retrieved,
    sites,
    dataSlots,
    rounds: round,
    child: kidOf as (loc: Loc, seg: string | number) => Loc | undefined,
    locate: locateUri,
    landing: landingOf,
    landingAt: (target, doc) => walkTo(target, undefined, doc ?? docs[0]),
    stateAt,
    dialects,
    conflict: conflictOf,
    allowance: extraLimit,
  }
}

export { Loc, buildIndex, hasIds, EXTRA_FACTOR }

export type { DocFacts, DocInput, IndexConfig, Kind, Known, Landing, Located, Region, SiteFacts, SiteIndex, Why }
