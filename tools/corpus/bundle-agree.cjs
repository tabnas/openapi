/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */
'use strict'

// tools/corpus/bundle-agree.cjs: whether a bundle resolves to what its
// documents resolve to.
//
// `bundle` writes a description in several documents as one. What that
// has to keep is what the description means, and the check of it is
// here: resolve the documents, bundle them and resolve the bundle, then
// compare the two resolved trees, value by value, from the root.
//
// They are equal but for what a bundle is allowed to differ in, and each
// allowance is read off the bundle's own reports, so that a difference
// the bundle does not account for fails:
//
//   - The maps that targets are put in have more members: the root,
//     `components` and its sections, and in 2.0 `definitions`,
//     `parameters` and `responses`.
//   - A schema resource has the `$defs` members its `embedded` rows name.
//   - A schema has the `$schema` that a `dialects` row gives it.
//   - A member is gone that a `left` row says was left out.
//   - A string names by another text what it named: a relative URI that
//     is read against another base where it is now, or a mapping value
//     or an `operationRef` that names the place an `embedded` row gives.
//   - A reference that is one of a loop of references, which resolving
//     cuts and leaves as written, is a reference in both, whatever it
//     is written as.
//   - A reference that a `left` row says would be written inside itself
//     without end (`cycle`) is left in the bundle, and named something.
//
// Beside the trees:
//
//   - A reference of the description's own that named nothing still
//     names nothing, and no other of its references does.
//   - Every reference that names nothing in the bundle is one that the
//     bundle's `left` report lists, or names such a one.
//   - A mapping value or an `operationRef` that was found is found where
//     the bundle has it, unless `left` says the bundle has no place for
//     what it names.
//
// The suite runs this on every case of test/docs/, and
// tools/corpus/documents.cjs on the corpus's descriptions in several
// documents.

const isObj = (v) => null != v && 'object' === typeof v
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

const SECTIONS = new Set([
  'schemas',
  'responses',
  'parameters',
  'examples',
  'requestBodies',
  'headers',
  'securitySchemes',
  'links',
  'callbacks',
  'pathItems',
  'mediaTypes',
])

// Where the bundle may have more members than the description had.
const loose = (path) =>
  0 === path.length ||
  (1 === path.length && ['components', 'definitions', 'parameters', 'responses'].includes(path[0])) ||
  (2 === path.length && 'components' === path[0] && SECTIONS.has(path[1]))

const DEFS = new Set(['$defs', 'definitions'])

// The connections that locate by URI, which a bundle writes again.
const LOCATORS = new Set(['mapping', 'defaultMapping', 'operationRef'])

// What a bundle's reports allow of the tree it resolves to. `loose` is
// the places where the bundle's resolved tree has a reference that a
// loop of references or a `cycle` row accounts for.
function allowances(U, bundle, home, loose) {
  const lastOf = (at) => {
    const parts = U.pointerParts(at) ?? []
    return 0 === parts.length ? '' : parts[parts.length - 1]
  }
  const defs = new Set(bundle.embedded.filter((e) => 'defs' === e.as).map((e) => lastOf(e.at)))
  const dialects = new Set(bundle.dialects.map((d) => d.dialect))
  const gone = new Set(bundle.left.filter((l) => 'anchor' === l.why || 'id' === l.why).map((l) => lastOf(l.at) + '\0' + l.ref))
  // Every base a relative URI may have been written against, or is read
  // against now: the description's, and each other document's.
  const bases = [...new Set([...home, ...bundle.documents])]
  const rows = bundle.embedded.map((e) => ({ at: U.pointerParts(e.at) ?? [], doc: e.doc, from: U.pointerParts(e.from) ?? [] }))
  // A URI that names a place in the bundle, as the place it came from.
  const origins = (uri) => {
    const hash = uri.indexOf('#')
    if (hash < 0 || !home.includes(uri.slice(0, hash))) return []
    const parts = U.pointerParts(uri.slice(hash + 1))
    if (null === parts) return []
    const out = []
    for (const row of rows) {
      if (row.at.length <= parts.length && row.at.every((seg, i) => seg === parts[i])) {
        const from = U.pointer([...row.from, ...parts.slice(row.at.length)])
        out.push(U.normalizeUri(row.doc + ('' === from ? '' : '#' + from)))
      }
    }
    return out
  }
  const absolute = (text) => bases.map((base) => U.normalizeUri(U.resolveUri(base, text)))
  const explained = (a, b) => {
    const was = new Set(absolute(a))
    for (const now of absolute(b)) {
      if (was.has(now)) return true
      for (const o of origins(now)) if (was.has(o)) return true
    }
    return false
  }
  return { defs, dialects, gone, explained, loose, pointer: U.pointer }
}

// Two graphs, member by member and in order, each pair of objects once.
function same(a, b, path, allow, seen, why) {
  if (a === b) return true
  if ('string' === typeof a && 'string' === typeof b) {
    if (allow.explained(a, b)) return true
    why.push(`${path.join('/')}: ${JSON.stringify(a).slice(0, 80)} / ${JSON.stringify(b).slice(0, 80)}`)
    return false
  }
  if (!isObj(a) || !isObj(b)) {
    why.push(`${path.join('/')}: ${String(JSON.stringify(a)).slice(0, 80)} / ${String(JSON.stringify(b)).slice(0, 80)}`)
    return false
  }
  if (seen.get(a) === b) return true
  seen.set(a, b)
  if (0 < allow.loose.size && 'string' === typeof b.$ref && allow.loose.has(allow.pointer(path))) return true
  if (Array.isArray(a) !== Array.isArray(b)) {
    why.push(path.join('/') + ': a list / a map')
    return false
  }
  let ka = Object.keys(a)
  let kb = Object.keys(b)
  if (!Array.isArray(a)) {
    const inDefs = 0 < path.length && DEFS.has(path[path.length - 1])
    const more = (k) =>
      loose(path) ||
      (inDefs && allow.defs.has(k)) ||
      ('$schema' === k && allow.dialects.has(b[k])) ||
      (DEFS.has(k) && isObj(b[k]) && Object.keys(b[k]).every((name) => allow.defs.has(name)))
    kb = kb.filter((k) => own(a, k) || !more(k))
    ka = ka.filter((k) => own(b, k) || 'string' !== typeof a[k] || !allow.gone.has(k + '\0' + a[k]))
  }
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) {
    why.push(`${path.join('/')}: members ${ka.join(',').slice(0, 100)} / ${kb.join(',').slice(0, 100)}`)
    return false
  }
  for (const k of ka) if (!same(a[k], b[k], [...path, k], allow, seen, why)) return false
  return true
}

// Resolve, bundle, resolve the bundle, and compare. `options` are those
// of `bundle`, or with `load` those of `bundleAll`.
async function agree(O, U, raw, options) {
  const { load, maxDocuments, maxRounds, ...plain } = options
  const loading = undefined === load ? undefined : { load, maxDocuments, maxRounds }
  const before = loading ? await O.resolveAll(raw, { ...plain, ...loading, cycles: 'keep' }) : O.resolve(raw, { ...plain, cycles: 'keep' })
  const bundle = loading ? await O.bundleAll(raw, { ...plain, ...loading }) : O.bundle(raw, plain)
  const { documents, parse, ...alone } = plain
  const after = O.resolve(bundle.tree, { ...alone, cycles: 'keep' })

  // The URIs the description is known by: the one it was retrieved
  // from, and its `$self` where it has one.
  const retrieved = U.withoutFragment(U.normalizeUri(plain.retrievalUri ?? ''))
  const home = [retrieved]
  if (isObj(raw) && 'string' === typeof raw.$self && '' !== retrieved) {
    home.push(U.withoutFragment(U.normalizeUri(U.resolveUri(retrieved, raw.$self))))
  }
  // A reference to one that is left as written is left as that one is.
  // So what is said of a place is said of each reference that leads to
  // it: that the bundle lists it, and why.
  const landings = new Map(after.provenance.map((p) => [p.at, p.landing]))
  const listed = new Map(bundle.left.map((l) => [l.at, l.why]))
  const saidOf = (at) => {
    const seen = new Set()
    for (let cur = at; null != cur && !seen.has(cur); cur = landings.get(cur)) {
      if (listed.has(cur)) return listed.get(cur)
      seen.add(cur)
    }
    return undefined
  }
  const loosely = new Set(after.provenance.filter((p) => 'cut' === p.status).map((p) => p.at))
  for (const u of after.unresolved) if ('cycle' === saidOf(u.at)) loosely.add(u.at)
  const allow = allowances(U, bundle, home, loosely)
  const why = []
  same(before.tree, after.tree, [], allow, new Map(), why)

  // The description's own places are where they were. What was brought
  // in is under the place an `embedded` row gives.
  const brought = bundle.embedded.map((e) => e.at)
  const own = (at) => !brought.some((b) => at === b || at.startsWith(b + '/'))
  const was = new Set(before.unresolved.filter((u) => undefined === u.doc).map((u) => u.at))
  const now = new Set(after.unresolved.map((u) => u.at))
  for (const at of was) if (!now.has(at)) why.push(`unresolved: ${at} named nothing, and names something in the bundle`)
  for (const at of now) {
    const said = saidOf(at)
    if (undefined === said) why.push(`unresolved: ${at} names nothing in the bundle, and the bundle does not say so`)
    else if (own(at) && !was.has(at) && 'cycle' !== said) why.push(`unresolved: ${at} names nothing in the bundle, and named something`)
  }

  // A locator that was found is found where the bundle has it: at its
  // own place in the description, and for one in another document at
  // each place its content was brought to.
  const places = new Map()
  for (const row of after.connections) if (LOCATORS.has(row.kind)) places.set(row.kind + ' ' + row.at, row)
  const rows = bundle.embedded.map((e) => ({ at: e.at, doc: e.doc, from: e.from }))
  // What the bundle says it has no place for.
  const outside = new Set(bundle.left.filter((l) => 'outside' === l.why).map((l) => l.at))
  let located = 0
  for (const row of before.connections) {
    if (!LOCATORS.has(row.kind) || !row.found) continue
    const at = []
    if (undefined === row.doc) at.push(row.at)
    else {
      for (const e of rows) {
        if (e.doc === row.doc && (row.at === e.from || row.at.startsWith(e.from + '/'))) at.push(e.at + row.at.slice(e.from.length))
      }
    }
    for (const place of at) {
      const now = places.get(row.kind + ' ' + place)
      if (undefined === now) continue
      located++
      if (!now.found && !outside.has(place)) why.push(`${row.kind} ${place}: ${JSON.stringify(row.name)} was found, and ${JSON.stringify(now.name)} is not`)
    }
  }

  return { ok: 0 === why.length, why, bundle, before, after, located }
}

module.exports = { agree, same, loose, allowances }
