/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */
'use strict'

// E12: the site index of ../../typescript-plan.md, section 3, as a
// prototype. Nothing in ts/src imports it.
//
// One pass over a raw tree, before any fold, that works out every fact
// about the document a resolver needs:
//
//   sites       every map with a `$ref` that is a reference, with its
//               kind, type, base URI and dialect, and what it names;
//   typed       the state, base URI and dialect of every map the object
//               model types, by pointer;
//   ids         the `$id`, `$anchor` and `$dynamicAnchor` index;
//   landings    for each site, the location its reference lands on, read
//               on the document as written (Decision 27), and the sites
//               the pointer passed through to get there;
//   roots       the regions the model gives no state, typed by the
//               references that land on them (Decision 28), found in
//               rounds;
//   conflicts   each reference that lands where the type is not the one
//               it expects.
//
// It reads the compiled object model and URI helpers of this checkout
// (ts/dist), or of the folder OPENAPI_DIST_DIR names.

const Path = require('node:path')

const DIST = process.env.OPENAPI_DIST_DIR || Path.join(__dirname, '..', '..', '..', '..', 'ts', 'dist')
const { OBJECT_MODEL } = require(Path.join(DIST, 'object-model.js'))
const { ANCHOR, NOTHING, fragmentOf, isMap, own, pointerParts, resolveUri, stepInto, withoutFragment } =
  require(Path.join(DIST, 'uri.js'))

const hasIds = (v) => '3.1' === v || '3.2' === v

// As ts/src/resolve.ts has it.
function supportedDialect(dialect) {
  return (
    dialect.startsWith('https://spec.openapis.org/oas/3.1/dialect/') ||
    dialect.startsWith('https://spec.openapis.org/oas/3.2/dialect/') ||
    'https://json-schema.org/draft/2020-12/schema' === dialect
  )
}

const esc = (seg) => String(seg).replace(/~/g, '~0').replace(/\//g, '~1')

const PATTERNS = new Map()
function pattern(src) {
  let re = PATTERNS.get(src)
  if (null == re) PATTERNS.set(src, (re = new RegExp(src, 'u')))
  return re
}

const INDEX = /^(?:0|[1-9][0-9]*)$/

// One step of the object model, as `step` in ts/src/model.ts takes it,
// with how it was decided:
//
//   prop     the model names the member
//   pattern  a pattern of the model matches the member's name
//   ext      the member is an extension, by the `^x-` pattern
//   rest     the position's catch-all
//   items    an item of a list
//   none     nothing in the model names it
//   below    it is below a position that holds no members of its own
function stepHow(states, state, member) {
  let s = states[state]
  if (null == s) return ['data', 'below']
  if ('refable' === s.kind && null != s.target) {
    s = states[s.target]
    if (null == s) return ['data', 'none']
  }
  const index = 'number' === typeof member || INDEX.test(member)
  if ('list' === s.kind) return index && null != s.items ? [s.items, 'items'] : ['data', 'none']
  if ('object' !== s.kind && 'schema' !== s.kind) return ['data', 'below']
  if (index && null != s.items) return [s.items, 'items']
  const name = String(member)
  if (null != s.props && own(s.props, name)) return [s.props[name], 'prop']
  for (const [src, to] of s.patterns ?? []) {
    if (pattern(src).test(name)) return [to, '^x-' === src ? 'ext' : 'pattern']
  }
  return null != s.rest ? [s.rest, 'rest'] : ['data', 'none']
}

// The kind of the state a step is taken from, a refable slot stepping as
// the object it holds.
function kindFrom(states, state) {
  let s = states[state]
  if (null == s) return 'data'
  if ('refable' === s.kind && null != s.target) s = states[s.target] ?? s
  return s.kind
}

// What the model knows of a position: 'typed' (an object, a list, a
// schema, a name), 'data' (the model names it, and says it is plain
// JSON), or 'unknown' (the model gives it no state at all: it is in an
// extension, or a member the model does not know, or below one).
function knownAfter(known, kind, next, how) {
  if ('data' !== next) return 'typed'
  if ('below' === how) return 'typed' === known ? 'data' : known
  if ('ext' === how || 'none' === how) return 'unknown'
  // A schema's catch-all takes the keywords its dialect does not have,
  // `definitions` and `dependencies` in 2020-12 among them. Any other
  // catch-all to data is a map of plain values the model names.
  if ('rest' === how) return 'schema' === kind ? 'unknown' : 'data'
  return 'data'
}

// Build the index of one document.
//
//   mv           the model version
//   docBase      the base URI of the document (`$self` resolved)
//   entry        the document's URI, without a fragment
//   retrieved    the URI it was retrieved from, without a fragment
//   rootDialect  the dialect a schema is read under unless it says
//   slots        'spec' or 'all', as `resolve` takes it
//   extensions   a Set of member names, as `resolve` takes them
//   pointers     true under `refs: 'pointer'`: no identifiers, no
//                landings and no typing by reference
//   typing       false to leave the regions the model does not type
//                untyped (the default is to type them, unless `pointers`)
//   order        within a round, whose landing types a region first:
//                'document' (the plan's rule) or 'pointer' (the sites in
//                the code-point order of their pointers)
//   maxRounds    the most rounds (default 1000)
//   maxThrough   the most sites one pointer may pass through (default 1000)
function buildIndex(raw, cfg) {
  const { mv, docBase, entry, retrieved, rootDialect } = cfg
  const versions = OBJECT_MODEL.versions
  if (null == versions[mv]) throw new Error('index: no object model for version ' + JSON.stringify(mv))
  const states = versions[mv].states
  const ids = hasIds(mv)
  const pointers = true === cfg.pointers
  const typing = false !== cfg.typing && !pointers
  const all = 'all' === cfg.slots
  const extensions = cfg.extensions ?? new Set()
  const byPointer = 'pointer' === cfg.order
  const maxRounds = cfg.maxRounds ?? 1000
  const maxThrough = cfg.maxThrough ?? 1000
  const rootIsReference = pointers && isMap(raw) && 'string' === typeof raw.$ref

  const kindOfState = (state) => {
    const s = states[state]
    if (null == s) return null
    if ('schema' === s.kind) return 'schema'
    if ('refable' === s.kind || 'reference' === state) return 'reference'
    if ('object' === s.kind && 'pathItem' === s.type) return 'pathItem'
    return null
  }

  // The regions typed by a reference: pointer -> { state, by, round }.
  const roots = new Map()
  // The round each site was first seen in, by pointer.
  const firstSeen = new Map()

  // ---- the survey: every fact that follows from the typing so far ----

  function survey() {
    const sites = new Map()
    const order = []
    const typed = new Map()
    const dynamic = new Set()
    const idIndex = new Map()
    let dataSlots = 0
    let maps = 0
    const stack = [[raw, [], '', 'root', 'typed', docBase, rootDialect, false]]
    while (0 < stack.length) {
      const frame = stack.pop()
      const node = frame[0]
      const path = frame[1]
      const ptr = frame[2]
      let state = frame[3]
      let known = frame[4]
      let base = frame[5]
      let dialect = frame[6]
      const ext = frame[7]
      if (0 < roots.size) {
        const root = roots.get(ptr)
        if (null != root) {
          state = root.state
          known = 'typed'
        }
      }
      const s = states[state]
      const list = Array.isArray(node)
      if (!list && !isMap(node)) continue
      if (!list) {
        maps++
        if ('data' !== state) {
          if (ids && null != s && 'schema' === s.kind) {
            if ('string' === typeof node.$schema) dialect = node.$schema
            if ('string' === typeof node.$id) {
              base = resolveUri(base, node.$id)
              idIndex.set(withoutFragment(base), path)
            }
            for (const a of ['$anchor', '$dynamicAnchor']) {
              if ('string' === typeof node[a]) idIndex.set(withoutFragment(base) + '#' + node[a], path)
            }
          }
          typed.set(ptr, { state, base, dialect })
        }
        if (own(node, '$ref')) {
          const ref = node.$ref
          let k = kindOfState(state)
          if (null == k) {
            dataSlots++
            if ('string' === typeof ref && (all || ext)) k = 'data'
          }
          // Under `refs: 'pointer'` the root is where pointers start,
          // never a site of its own.
          if (null != k && !(pointers && 0 === path.length)) {
            const row = {
              at: ptr,
              path,
              kind: k,
              type: 'reference' === k ? (s.type ?? null) : 'pathItem' === k || 'schema' === k ? k : null,
              state,
              ref,
              base,
              dialect,
              n: order.length,
            }
            if ('string' !== typeof ref) row.why = 'not-a-string'
            else if (!pointers && 'schema' === k && ids && !supportedDialect(dialect)) row.why = 'unsupported-dialect'
            sites.set(ptr, row)
            order.push(row)
          }
        } else if (own(node, '$dynamicRef')) {
          if (!pointers && ids && 'schema' === kindOfState(state)) dynamic.add(ptr)
        }
      }
      const kind = kindFrom(states, state)
      const names = list ? node.map((_, i) => i) : Object.keys(node)
      for (let i = names.length - 1; 0 <= i; i--) {
        const child = node[names[i]]
        if (null == child || 'object' !== typeof child) continue
        const [next, how] = stepHow(states, state, names[i])
        stack.push([
          child,
          [...path, names[i]],
          ptr + '/' + esc(names[i]),
          next,
          knownAfter(known, kind, next, how),
          base,
          dialect,
          ext || extensions.has(String(names[i])),
        ])
      }
    }
    return { sites, order, typed, dynamic, idIndex, dataSlots, maps }
  }

  // What the model, and the typing by reference so far, know of the
  // location at `path`.
  function knownAt(path) {
    let state = 'root'
    let known = 'typed'
    let ptr = ''
    for (let i = 0; ; i++) {
      const root = roots.get(ptr)
      if (null != root) {
        state = root.state
        known = 'typed'
      }
      if (i === path.length) break
      const kind = kindFrom(states, state)
      const [next, how] = stepHow(states, state, path[i])
      known = knownAfter(known, kind, next, how)
      state = next
      ptr += '/' + esc(path[i])
    }
    return { state, known, root: roots.get(ptr) }
  }

  // ---- what a reference names: as `locate` in ts/src/resolve.ts ----

  let facts

  const locatePointer = (ref) => {
    if (!ref.startsWith('#/')) return { why: ref.startsWith('#') ? 'bad-fragment' : 'external' }
    if (rootIsReference) return { why: 'not-found' }
    return { target: ref.slice(2).split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~')) }
  }

  const locateUri = (ref, base) => {
    const abs = resolveUri(base, ref)
    const doc = withoutFragment(abs)
    const fragment = fragmentOf(abs)
    let start
    if (facts.idIndex.has(doc)) start = facts.idIndex.get(doc)
    else if (doc === entry || doc === retrieved) start = []
    else return { why: 'external', uri: doc, fragment }
    if (undefined === fragment || '' === fragment) return { target: start }
    if (fragment.startsWith('/') || /^%2f/i.test(fragment)) {
      const parts = pointerParts(fragment)
      return null == parts ? { why: 'bad-fragment' } : { target: [...start, ...parts] }
    }
    if (ids && ANCHOR.test(fragment)) {
      const named = facts.idIndex.get(doc + '#' + fragment)
      return null == named ? { why: 'no-anchor' } : { target: named }
    }
    return { why: 'bad-fragment' }
  }

  // ---- landings: a pointer read on the document as written ----

  const LOOP = { found: false, loop: true, through: [], passes: [] }

  function landings() {
    const sites = facts.sites
    const busy = new Set()

    const landingOf = (row) => {
      if (null != row.landing) return row.landing
      if (null == row.target) return (row.landing = { found: false, through: [], passes: [] })
      if (busy.has(row)) return LOOP
      if (maxThrough <= busy.size) return { found: false, depth: true, through: [], passes: [] }
      busy.add(row)
      const segs = row.target
      const seen = new Set()
      const through = []
      // Every site the pointer goes on past, whatever it finds there.
      const passes = []
      let node = raw
      let loc = []
      let ptr = ''
      let out
      let i = 0
      while (i < segs.length) {
        if (0 < loc.length && sites.has(ptr) && passes[passes.length - 1] !== ptr) passes.push(ptr)
        const v = stepInto(node, segs[i])
        if (NOTHING !== v) {
          node = v
          loc.push(segs[i])
          ptr += '/' + esc(segs[i])
          i++
          continue
        }
        // The step is missing here. Where this is a site, the walk goes
        // on in what the site names. The root is where a walk starts, and
        // is not on its way.
        const here = 0 < loc.length ? sites.get(ptr) : undefined
        if (null == here || null != here.why) {
          out = { found: false, through, stopped: ptr, step: segs[i] }
          break
        }
        const key = ptr + '\n' + i
        if (seen.has(key)) {
          out = { found: false, loop: true, through }
          break
        }
        seen.add(key)
        const via = here === row ? LOOP : landingOf(here)
        if (via.loop || via.depth) {
          out = { found: false, loop: true === via.loop, depth: true === via.depth, through: [...through, here.at] }
          break
        }
        if (!via.found) {
          out = { found: false, through: [...through, here.at], stopped: ptr, step: segs[i] }
          break
        }
        through.push(here.at, ...via.through)
        node = via.node
        loc = via.path.slice()
        ptr = via.ptr
      }
      if (null == out) out = { found: true, path: loc, ptr, through, node }
      out.passes = passes
      busy.delete(row)
      return (row.landing = out)
    }

    for (const row of facts.order) landingOf(row)
  }

  // ---- typing by reference ----

  // The state a landing takes from its site, where the site has one to
  // give.
  const gives = (row) => {
    if ('schema' === row.kind) return 'schema'
    if ('pathItem' === row.kind) return 'pathItem'
    if ('reference' === row.kind && null != states[row.state] && 'refable' === states[row.state].kind) return row.state
    return null
  }

  const typeName = (state, known) => {
    if ('typed' !== known) return known
    const s = states[state]
    if (null == s) return 'data'
    return s.type ?? state
  }

  const inOrder = (rows) =>
    rows.slice().sort((a, b) =>
      a.round !== b.round ? a.round - b.round : byPointer ? (a.at < b.at ? -1 : a.at > b.at ? 1 : 0) : a.n - b.n)

  function typeLandings(nextRound) {
    let fresh = 0
    for (const row of inOrder(facts.order)) {
      const give = gives(row)
      if (null == give || null == row.landing || !row.landing.found) continue
      const k = knownAt(row.landing.path)
      if ('unknown' !== k.known) continue
      roots.set(row.landing.ptr, { state: give, by: row.at, round: nextRound })
      fresh++
    }
    return fresh
  }

  // ---- the rounds ----

  let round = 0
  for (;;) {
    facts = survey()
    for (const row of facts.order) {
      if (!firstSeen.has(row.at)) firstSeen.set(row.at, round)
      row.round = firstSeen.get(row.at)
      if (null == row.why) {
        const where = pointers ? locatePointer(row.ref) : locateUri(row.ref, row.base)
        if (null != where.why) {
          row.why = where.why
          if (null != where.uri) {
            row.uri = where.uri
            row.fragment = where.fragment
          }
        } else row.target = where.target
      }
    }
    if (!pointers) landings()
    if (!typing) break
    if (0 === typeLandings(round + 1)) break
    round++
    if (maxRounds < round) throw new Error('index: the typing rounds did not end in ' + maxRounds)
  }

  // ---- what the finished index says of each landing ----

  const conflicts = []
  if (!pointers) {
    for (const row of facts.order) {
      const land = row.landing
      if (null == land || !land.found) continue
      const k = knownAt(land.path)
      land.state = k.state
      land.known = k.known
      if (null != k.root) land.typedBy = k.root.by
      // Whether the landing is inside a site as written: a member beside a
      // `$ref`, or below one.
      let p = ''
      land.under = null
      for (let i = 0; i < land.path.length; i++) {
        if (0 < i && facts.sites.has(p)) {
          land.under = p
          break
        }
        p += '/' + esc(land.path[i])
      }
      const give = gives(row)
      if (null == give) continue
      const want = typeName(give, 'typed')
      const got = typeName(k.state, k.known)
      if (want !== got) {
        conflicts.push({ at: row.at, ref: row.ref, landing: land.ptr, wants: want, found: got, typedBy: land.typedBy })
      }
    }
  }

  return {
    sites: facts.sites,
    order: facts.order,
    typed: facts.typed,
    dynamic: facts.dynamic,
    ids: facts.idIndex,
    dataSlots: facts.dataSlots,
    maps: facts.maps,
    rounds: round,
    roots,
    conflicts,
    knownAt,
    locateUri,
    locatePointer,
  }
}

module.exports = { buildIndex, stepHow, knownAfter, kindFrom, supportedDialect }
