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
//     is read against another base where it is now, or a pointer to the
//     place an `embedded` row gives, or to the place that a pointer
//     which is read on through a reference lands on. Only a string that
//     a bundle writes again may: a reference, an identifier, a mapping
//     value, an `operationRef`, and a member that the `urls` report
//     lists. A base is the URI of a document, or one that a schema of
//     the documents declares with an identifier: the check reads those
//     off the documents as they are given or loaded, since a part of a
//     schema resource may be brought without the schema that declares
//     the identifier it was read against.
//   - A reference that is one of a loop of references, which resolving
//     cuts and leaves as written, is a reference in both, whatever it
//     is written as.
//   - A reference that a `left` row says would be written inside itself
//     without end (`cycle`), or names what the bundle has no place for
//     (`outside`), is left in the bundle, and named something.
//   - A part that a `left` row says may be read as another type than
//     the documents read it as, or as data (`type`), is not compared.
//   - A field beside a reference that a `left` row says stands unread
//     (`version`) is not compared, where the reference is: a document
//     of a later version read it in the place of its target's own.
//
// Beside the trees:
//
//   - A reference of the description's own that named nothing still
//     names nothing, and no other of its references does, but for one
//     to a loop of references, which was cut and is now left.
//   - Every reference that names nothing in the bundle is one that the
//     bundle's `left` report lists, or names such a one.
//   - A mapping value or an `operationRef` that was found is found where
//     the bundle has it, and lands on what it landed on, unless `left`
//     says the bundle has no place for what it names. One that was not
//     found is not found.
//
// The suite runs this on every case of test/bundle/ and test/docs/, on
// every set of test/bundle-held/ and on generated sets of documents,
// and tools/corpus/documents.cjs on the corpus's descriptions in
// several documents.
//
// Run as a command, it checks bundles that were written elsewhere: by
// an implementation of this package in another language, which cannot
// be handed to `agree`.
//
//   node tools/corpus/bundle-agree.cjs <file.json>...
//
// Each file is JSON in the form of a file of test/bundle-held/: the
// `retrievalUri` of the entry, and `sets`, each an `entry`, its
// `documents` and its `options` if any. Each set also has `bundle`,
// what was written of it: its `tree`, and its `embedded`, `left` and
// `dialects` rows as `bundle` gives them here. The documents are
// resolved by this checkout's build, and so is each bundle. It ends
// with 0 when every bundle agrees with its documents, with 1 when one
// does not, and with 2 when it could not run.

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

// The steps of a JSON Pointer as a report has it: the text itself, with
// no percent-decoding.
const stepsOf = (at) => ('' === at ? [] : at.slice(1).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~')))

// What a tree has at a pointer.
const valueAt = (tree, at) => {
  let node = tree
  for (const seg of stepsOf(at)) {
    if (!isObj(node) || !own(node, seg)) return undefined
    node = node[seg]
  }
  return node
}

// The connections that locate by URI, which a bundle writes again.
const LOCATORS = new Set(['mapping', 'defaultMapping', 'operationRef'])

// The members whose text a bundle may write again, beside the values of
// a `mapping` and the members that hold a URL.
const WRITTEN = new Set(['$ref', '$id', 'id', '$dynamicRef', '$recursiveRef', 'operationRef', 'defaultMapping'])

// A place as one text: its document, and the steps to it.
const spot = (doc, parts) => (0 === parts.length ? doc : doc + '#' + JSON.stringify(parts))

// What a bundle's reports allow of the tree it resolves to. `loose` is
// the references of the bundle's resolved tree that a loop of
// references, a `cycle` row or an `outside` row accounts for, and
// `unread` the parts that a `type` row does: each is the object the
// tree has there, so that it is known by whichever way it is come to.
// `urls` is the names of the members that hold a URL, and `vouched` the
// pairs of texts, each as the one before, a NUL and the one after, that
// a reference or a locator has in the documents and in the bundle where
// it lands on the same thing in both. `sites` is where each reference
// of the documents lands, by its document and place: a pointer that
// passes one is read on in what it names.
function allowances(U, bundle, home, loose, unread, urls, vouched, sites, declared = [], fields = new Map()) {
  const lastOf = (at) => {
    const parts = stepsOf(at)
    return 0 === parts.length ? '' : parts[parts.length - 1]
  }
  const defs = new Set(bundle.embedded.filter((e) => 'defs' === e.as).map((e) => lastOf(e.at)))
  const dialects = new Set(bundle.dialects.map((d) => d.dialect))
  const gone = new Set(bundle.left.filter((l) => 'anchor' === l.why || 'id' === l.why).map((l) => lastOf(l.at) + '\0' + l.ref))
  const rows = bundle.embedded.map((e) => ({ at: stepsOf(e.at), doc: e.doc, from: stepsOf(e.from), as: e.as }))
  // The schema resources that were brought in, each by its identifier:
  // a text may name one so, where the documents had a pointer to it.
  const byId = new Map()
  for (const e of bundle.embedded) {
    const node = valueAt(bundle.tree, e.at)
    const id = isObj(node) && !Array.isArray(node) ? (node.$id ?? node.id) : undefined
    if ('string' !== typeof id) continue
    for (const base of home) byId.set(U.withoutFragment(U.normalizeUri(U.resolveUri(base, id))), stepsOf(e.at))
  }
  // Every base a relative URI may have been written against, or is read
  // against now: the description's, each other document's, each
  // identifier that was left out, which what is below it was read
  // against, and each base that a schema of the documents declares with
  // an identifier. A part of a schema resource may be brought without
  // the schema that declares the identifier it was read against.
  const docs = [...new Set([...home, ...bundle.documents])]
  const ids = bundle.left.filter((l) => 'id' === l.why && 'string' === typeof l.ref).map((l) => l.ref)
  const bases = [
    ...new Set([
      ...docs,
      ...ids.flatMap((id) => docs.map((doc) => U.withoutFragment(U.normalizeUri(U.resolveUri(doc, id))))),
      ...byId.keys(),
      ...declared,
    ]),
  ]
  // What a URI names: its document, and the steps of its pointer where
  // its fragment is one. A fragment that is empty names the document,
  // and a pointer is the same one however it is escaped.
  const split = (uri) => {
    const hash = uri.indexOf('#')
    const doc = hash < 0 ? uri : uri.slice(0, hash)
    const fragment = hash < 0 ? '' : uri.slice(hash + 1)
    if ('' === fragment) return { doc, parts: [] }
    const parts = '/' === fragment[0] || /^%2f/i.test(fragment) ? U.pointerParts(fragment) : null
    return null == parts ? { doc, fragment } : { doc, parts }
  }
  const named = (uri) => {
    const s = split(uri)
    return undefined === s.parts ? s.doc + '#' + s.fragment : spot(s.doc, s.parts)
  }
  // A place of the bundle, as the places it came from.
  const originsOf = (parts) => {
    const out = []
    for (const row of rows) {
      if (row.at.length <= parts.length && row.at.every((seg, i) => seg === parts[i])) {
        out.push(spot(row.doc, [...row.from, ...parts.slice(row.at.length)]))
      }
    }
    return out
  }
  const origins = (uri) => {
    const s = split(uri)
    return undefined === s.parts || !home.includes(s.doc) ? [] : originsOf(s.parts)
  }
  const absolute = (text) => bases.map((base) => U.normalizeUri(U.resolveUri(base, text)))
  // A place as the documents read a pointer to it: on through each
  // reference it passes.
  const through = (doc, parts) => {
    for (let turn = 0; turn < 32; turn++) {
      let moved = false
      for (let n = parts.length - 1; 0 <= n && !moved; n--) {
        const to = sites.get(doc + '\0' + U.pointer(parts.slice(0, n)))
        if (undefined === to) continue
        parts = [...to.parts, ...parts.slice(n)]
        doc = to.doc
        moved = true
      }
      if (!moved) break
    }
    return spot(doc, parts)
  }
  const landed = (uri) => {
    const s = split(uri)
    return undefined === s.parts ? undefined : through(s.doc, s.parts)
  }
  const explained = (a, b) => {
    if (vouched.has(a + '\0' + b)) return true
    const was = new Set(absolute(a).map(named))
    for (const uri of absolute(a)) {
      const to = landed(uri)
      if (undefined !== to) was.add(to)
    }
    for (const now of absolute(b)) {
      if (was.has(named(now))) return true
      for (const o of origins(now)) if (was.has(o)) return true
      // By the identifier of a resource that was brought in.
      const s = split(now)
      const at = byId.get(s.doc)
      if (undefined !== at && undefined !== s.parts) for (const o of originsOf([...at, ...s.parts])) if (was.has(o)) return true
    }
    // In a schema resource a fragment alone names a place of the
    // resource: one of the definitions that the bundle put there.
    const inside = b.startsWith('#') ? U.pointerParts(b.slice(1)) : null
    if (null != inside && 2 <= inside.length && DEFS.has(inside[0])) {
      for (const row of rows) {
        const n = row.at.length
        if ('defs' !== row.as || row.at[n - 2] !== inside[0] || row.at[n - 1] !== inside[1]) continue
        if (was.has(spot(row.doc, [...row.from, ...inside.slice(2)]))) return true
      }
    }
    return false
  }
  // Whether the string at a path is one that a bundle writes again.
  const rewrites = (path) => {
    const k = path[path.length - 1]
    return WRITTEN.has(k) || urls.has(k) || 'mapping' === path[path.length - 2]
  }
  return { defs, dialects, gone, explained, rewrites, originsOf, loose, unread, fields }
}

// Two graphs, member by member and in order, each pair of objects once.
// `seen` has every pair that was started: a graph that comes round to
// itself is done when a pair comes round, and the two need not come
// round at the same place.
function same(a, b, path, allow, seen, why) {
  if (a === b) return true
  if ('string' === typeof a && 'string' === typeof b) {
    if (allow.rewrites(path) && allow.explained(a, b)) return true
    why.push(`${path.join('/')}: ${JSON.stringify(a).slice(0, 80)} / ${JSON.stringify(b).slice(0, 80)}`)
    return false
  }
  if (!isObj(a) || !isObj(b)) {
    why.push(`${path.join('/')}: ${String(JSON.stringify(a)).slice(0, 80)} / ${String(JSON.stringify(b)).slice(0, 80)}`)
    return false
  }
  const met = seen.get(a)
  if (undefined === met) seen.set(a, new Set([b]))
  else if (met.has(b)) return true
  else met.add(b)
  if (allow.unread.has(b) || ('string' === typeof b.$ref && allow.loose.has(b))) return true
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
    // The fields that stand unread beside the reference this came from.
    const unreadHere = allow.fields.get(b)
    if (undefined !== unreadHere) {
      ka = ka.filter((k) => !unreadHere.has(k))
      kb = kb.filter((k) => !unreadHere.has(k))
    }
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
  const { load, maxDocuments, maxRounds, ...rest } = options
  // The documents, as they are given or loaded: the check reads the
  // identifiers they declare.
  const texts = new Map()
  const loading =
    undefined === load
      ? undefined
      : {
          load: async (uri) => {
            const doc = await load(uri)
            texts.set(uri, doc)
            return doc
          },
          maxDocuments,
          maxRounds,
        }
  const bundle = loading ? await O.bundleAll(raw, { ...rest, ...loading }) : O.bundle(raw, rest)
  const before = loading
    ? await O.resolveAll(raw, { ...rest, ...loading, cycles: 'keep' })
    : O.resolve(raw, { ...rest, cycles: 'keep' })
  const { documents, parse, ...alone } = rest
  const after = O.resolve(bundle.tree, { ...alone, cycles: 'keep' })

  // The URIs the description is known by: the one it was retrieved
  // from, and its `$self` where it has one.
  const retrieved = U.withoutFragment(U.normalizeUri(rest.retrievalUri ?? ''))
  const home = [retrieved]
  if (isObj(raw) && 'string' === typeof raw.$self && '' !== retrieved) {
    home.push(U.withoutFragment(U.normalizeUri(U.resolveUri(retrieved, raw.$self))))
  }
  // A reference to one that is left as written is left as that one is.
  // So what is said of a place is said of each reference that leads to
  // it: that the bundle lists it, and why.
  // A place may be listed for more reasons than one.
  const landings = new Map(after.provenance.map((p) => [p.at, p.landing]))
  const listed = new Map()
  for (const l of bundle.left) listed.set(l.at, (listed.get(l.at) ?? new Set()).add(l.why))
  // A part that the bundle says may not be read as it was. What is in
  // it is said with it.
  const unread = bundle.left.filter((l) => 'type' === l.why).map((l) => l.at)
  const DATA = new Set(['type'])
  const saidOf = (at) => {
    const seen = new Set()
    let said
    for (let cur = at; null != cur && !seen.has(cur); cur = landings.get(cur)) {
      const here = listed.get(cur) ?? (unread.some((part) => cur.startsWith(part + '/')) ? DATA : undefined)
      if (undefined !== here) said = new Set([...(said ?? []), ...here])
      seen.add(cur)
    }
    return said
  }
  // What the bundle leaves as a reference, and says so: one it would
  // write inside itself without end, and one it has no place for.
  const leaves = (said) => undefined !== said && (said.has('cycle') || said.has('outside'))
  const loosely = new Set(after.provenance.filter((p) => 'cut' === p.status).map((p) => p.at))
  for (const u of after.unresolved) if (leaves(saidOf(u.at))) loosely.add(u.at)
  const objects = (places) => new Set([...places].map((at) => valueAt(after.tree, at)).filter(isObj))
  // A part that is read as data, with what it holds: the objects that
  // the resolved tree has where the bundle has the part's own, down to
  // each reference in it, which is another thing's.
  const partsOf = (places) => {
    const out = new Set()
    // An object may be come to first as what a reference in one part
    // resolves to, and then as another part's own: it is gone into the
    // second time.
    const gone = new Set()
    const walk = (doc, tree) => {
      if (!isObj(doc) || !isObj(tree)) return
      out.add(tree)
      if (!Array.isArray(doc) && 'string' === typeof doc.$ref && 'string' !== typeof tree.$ref) return
      if (gone.has(tree)) return
      gone.add(tree)
      for (const k of Object.keys(doc)) if (own(tree, k)) walk(doc[k], tree[k])
    }
    for (const at of places) walk(valueAt(bundle.tree, at), valueAt(after.tree, at))
    return out
  }
  const urls = new Set([...before.urls, ...after.urls].map((u) => stepsOf(u.at).pop()))
  const vouched = new Set()
  const passes = new Map()
  for (const p of before.provenance) {
    if (null == p.landing) continue
    const doc = p.doc ?? home[0]
    passes.set(doc + '\0' + p.at, { doc: p.landingDoc ?? p.targetDoc ?? doc, parts: stepsOf(p.landing) })
  }
  // The base URIs that the schemas of the documents declare with an
  // identifier, each read against the one above it. In a document that
  // is given as text they are looked for in the text, which finds more
  // than there are: a base that nothing was read against explains
  // nothing.
  const declared = new Set()
  const absolute = (base, id) => {
    try {
      return U.withoutFragment(U.normalizeUri(U.resolveUri(base, id)))
    } catch {
      return base
    }
  }
  const gather = (node, base, met) => {
    if (!isObj(node) || met.has(node) || 4096 <= declared.size) return
    met.add(node)
    let here = base
    if (!Array.isArray(node)) {
      const id = 'string' === typeof node.$id ? node.$id : 'string' === typeof node.id ? node.id : undefined
      if (undefined !== id) declared.add((here = absolute(base, id)))
    }
    for (const k of Object.keys(node)) gather(node[k], here, met)
  }
  const ID = /["']?\$id["']?[ \t]*:[ \t]*["']?([^"'\s,}\]]+)/g
  const scan = (text, base) => {
    const found = []
    for (const m of text.matchAll(ID)) if (found.length < 16) found.push(absolute(base, m[1]))
    for (const one of found) declared.add(one)
    for (const m of text.matchAll(ID)) for (const one of found.slice(0, 4)) if (declared.size < 4096) declared.add(absolute(one, m[1]))
  }
  gather(raw, retrieved, new Set())
  if (undefined === loading) {
    for (const [name, doc] of Object.entries(rest.documents ?? {})) texts.set(absolute(retrieved, name), doc)
  }
  for (const [uri, doc] of texts) {
    if ('string' === typeof doc) scan(doc, uri)
    else gather(doc, uri, new Set())
  }
  // The fields that the bundle says stand unread beside a reference, by
  // the object its resolved tree has where the reference is.
  const fields = new Map()
  for (const l of bundle.left) {
    if ('version' !== l.why) continue
    const steps = stepsOf(l.at)
    const held = valueAt(after.tree, l.at.slice(0, l.at.lastIndexOf('/')))
    if (isObj(held)) fields.set(held, (fields.get(held) ?? new Set()).add(steps[steps.length - 1]))
  }
  const allow = allowances(U, bundle, home, objects(loosely), partsOf(unread), urls, vouched, passes, [...declared], fields)
  const why = []

  // A locator is found where the bundle has it, if it was found, and
  // lands on what it landed on: at its own place in the description,
  // and for one in another document at each place its content was
  // brought to. One that was not found is not found.
  const places = new Map()
  for (const row of after.connections) if (LOCATORS.has(row.kind)) places.set(row.kind + ' ' + row.at, row)
  // What the bundle says it has no place for.
  const outside = new Set(bundle.left.filter((l) => 'outside' === l.why).map((l) => l.at))
  // Where the bundle has what a row of the documents is about: its own
  // place in the description, and each place its content was brought
  // to, which content of the description's own is too where a schema
  // resource has a copy of it.
  const placesOf = (row) => {
    const at = undefined === row.doc ? [row.at] : []
    const doc = row.doc ?? home[0]
    for (const e of bundle.embedded) {
      if (e.doc === doc && (row.at === e.from || row.at.startsWith(e.from + '/'))) at.push(e.at + row.at.slice(e.from.length))
    }
    return at
  }
  // Whether a place of the bundle is what a place of the documents was.
  const sameSpot = (was, here) => spot(home[0], here) === was || allow.originsOf(here).includes(was)

  // A reference that lands on something lands on that in the bundle,
  // whatever its text is now: its pointer may be read on through
  // another reference, which a text does not show.
  const sites = new Map(after.provenance.map((p) => [p.at, p]))
  for (const row of before.provenance) {
    if (null == row.landing || 'string' !== typeof row.ref) continue
    const was = spot(row.landingDoc ?? row.targetDoc ?? row.doc ?? home[0], stepsOf(row.landing))
    for (const place of placesOf(row)) {
      const now = sites.get(place)
      if (undefined === now || null == now.landing || 'string' !== typeof now.ref) continue
      if (sameSpot(was, stepsOf(now.landing))) vouched.add(row.ref + '\0' + now.ref)
    }
  }

  let located = 0
  for (const row of before.connections) {
    if (!LOCATORS.has(row.kind)) continue
    for (const place of placesOf(row)) {
      const now = places.get(row.kind + ' ' + place)
      if (undefined === now) continue
      located++
      const names = `${JSON.stringify(row.name)} / ${JSON.stringify(now.name)}`
      if (!row.found) {
        if (now.found) why.push(`${row.kind} ${place}: ${names}: was not found, and is found in the bundle`)
        continue
      }
      if (!now.found) {
        if (!outside.has(place)) why.push(`${row.kind} ${place}: ${names}: was found, and is not found in the bundle`)
        continue
      }
      // A row says where a pointer lands where that is not where it is
      // written, with its document where that is not the description.
      const doc = undefined === row.landing ? row.targetDoc : row.landingDoc
      const was = spot(doc ?? home[0], stepsOf(row.landing ?? row.target))
      if (sameSpot(was, stepsOf(now.landing ?? now.target))) vouched.add(row.name + '\0' + now.name)
      else why.push(`${row.kind} ${place}: ${names}: lands on another place in the bundle`)
    }
  }

  same(before.tree, after.tree, [], allow, new Map(), why)

  // The description's own places are where they were. What was brought
  // in is under the place an `embedded` row gives.
  const brought = bundle.embedded.map((e) => e.at)
  const inEntry = (at) => !brought.some((b) => at === b || at.startsWith(b + '/'))
  const was = new Set(before.unresolved.filter((u) => undefined === u.doc).map((u) => u.at))
  const now = new Set(after.unresolved.map((u) => u.at))
  // A reference to a loop of references was cut with it. The loop is a
  // reference left as written in the bundle, and so is one to it.
  const cut = new Set(before.provenance.filter((p) => 'cut' === p.status && undefined === p.doc).map((p) => p.at))
  for (const at of was) if (!now.has(at)) why.push(`unresolved: ${at} named nothing, and names something in the bundle`)
  for (const at of now) {
    const said = saidOf(at)
    if (undefined === said) why.push(`unresolved: ${at} names nothing in the bundle, and the bundle does not say so`)
    else if (inEntry(at) && !was.has(at) && !leaves(said) && !(said.has('loop') && cut.has(at))) {
      why.push(`unresolved: ${at} names nothing in the bundle, and named something`)
    }
  }

  return { ok: 0 === why.length, why, bundle, before, after, located }
}

// Whether each bundle of a file agrees with its documents: the bundle
// is the one the file gives, and not one this package writes.
// `onSet`, when given, is told each set's number as it is done.
async function checkWritten(O, U, held, onSet) {
  const results = []
  for (const [n, set] of held.sets.entries()) {
    const options = { retrievalUri: held.retrievalUri, documents: set.documents, ...(set.options ?? {}) }
    // The documents a bundle was made of, where it does not list them:
    // the ones the set gives, each by its URI in normal form.
    const documents = Object.keys(set.documents ?? {}).map((uri) => U.withoutFragment(U.normalizeUri(U.resolveUri(held.retrievalUri ?? '', uri))))
    const written = { documents, embedded: [], left: [], dialects: [], ...set.bundle }
    let result
    try {
      result = await agree({ ...O, bundle: () => written }, U, O.parse(JSON.stringify(set.entry)), options)
    } catch (e) {
      result = { ok: false, why: ['the check could not be made: ' + String(e && e.message).split('\n')[0]] }
    }
    results.push({ ok: result.ok, why: result.why })
    if (undefined !== onSet) onSet(n + 1, held.sets.length)
  }
  return results
}

module.exports = { agree, same, loose, allowances, checkWritten }

if (require.main === module) {
  const Fs = require('node:fs')
  const Path = require('node:path')
  const files = process.argv.slice(2)
  if (0 === files.length || files.some((f) => f.startsWith('-'))) {
    console.error('usage: node tools/corpus/bundle-agree.cjs <file.json>...')
    process.exit(2)
  }
  const dist = Path.join(__dirname, '..', '..', 'ts', 'dist')
  ;(async () => {
    const O = require(Path.join(dist, 'openapi.js'))
    const U = require(Path.join(dist, 'uri.js'))
    let failed = 0
    for (const file of files) {
      const held = JSON.parse(Fs.readFileSync(file, 'utf8'))
      // A line at least every ten seconds, with how far through the file it is.
      let said = Date.now()
      const results = await checkWritten(O, U, held, (done, of) => {
        if (Date.now() - said < 10000) return
        said = Date.now()
        console.log(`bundle-agree: ${file}: ${done} of ${of} sets (${((100 * done) / of).toFixed(1)}%)`)
      })
      for (const [n, r] of results.entries()) {
        if (r.ok) continue
        failed++
        console.log(`bundle-agree: ${file}, set ${n}: ${r.why.join('; ')}`)
      }
      console.log(`bundle-agree: ${file}: ${results.filter((r) => r.ok).length} of ${results.length} bundles agree with their documents`)
    }
    process.exit(0 === failed ? 0 : 1)
  })().catch((e) => {
    console.error('bundle-agree: ' + String(e && e.message))
    process.exit(2)
  })
}
