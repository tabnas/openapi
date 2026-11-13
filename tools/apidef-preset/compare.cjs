/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */
'use strict'

// tools/apidef-preset/compare.cjs: one document, both resolvers, and what
// differs.
//
// `compareText(text, sides)` parses the text with this package's `parse`
// three times: one tree for apidef's `addXRefsAndResolve(tree, tree)`,
// which changes its tree in place, one for `resolve(tree, { compat:
// 'apidef' })`, and one left untouched to read the document as written.
// It compares the two results as graphs (graph.cjs) and, when they
// differ, looks at every reference site of the document (every map with
// a `$ref`, the root included) to say which sites differ and how, and
// gives each a class by its cause (classify.cjs).
//
// `sides` is { A, O, options }: A from apidef.cjs, O this package's build,
// and `options`, when given, the `resolve` options to put beside the
// preset, which shows what one option of the preset is there for.
//
// A module for apidef-preset.cjs and its worker; it runs nothing by itself.

const G = require('./graph.cjs')
const { classify } = require('./classify.cjs')

const firstLine = (e) => String(e?.message ?? e).replace(/\x1b\[[0-9;]*m/g, '').split('\n')[0].slice(0, 300)
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

// Every map with a `$ref` member, in document order, the root first.
function sitesOf(raw) {
  const out = []
  const stack = [[raw, []]]
  while (0 < stack.length) {
    const [v, path] = stack.pop()
    if (!G.isObj(v)) continue
    if (!Array.isArray(v) && own(v, '$ref')) out.push({ path, ref: v.$ref })
    const ks = G.keysOf(v)
    for (let i = ks.length - 1; 0 <= i; i--) stack.push([v[ks[i]], [...path, ks[i]]])
  }
  return out
}

const SITE_BUDGET = 4000

function compareText(text, sides, { cutBudget = 2e7 } = {}) {
  const { A, O } = sides
  const options = { compat: 'apidef', ...(sides.options ?? {}) }
  const rec = { bytes: Buffer.byteLength(text) }
  let rawA, rawP, rawX
  try {
    rawA = O.parse(text)
    rawP = O.parse(text)
    rawX = O.parse(text)
  } catch (e) {
    rec.failed = { stage: 'parse', error: (e.code ? e.code + ': ' : '') + firstLine(e) }
    return rec
  }
  try {
    A.addXRefsAndResolve(rawA, rawA)
  } catch (e) {
    rec.failed = { stage: 'apidef', error: e.name + ': ' + firstLine(e) }
  }
  let r
  try {
    r = O.resolve(rawP, options)
  } catch (e) {
    rec.failed = rec.failed ?? { stage: 'preset', error: e.name + ': ' + firstLine(e) }
    if ('apidef' === rec.failed.stage) rec.failed.also = 'preset: ' + e.name + ': ' + firstLine(e)
  }
  if (rec.failed) return rec
  rec.version = r.version
  const pTree = r.tree

  const first = G.graphDiff(rawA, pTree)
  rec.graphEqual = null == first
  if (rec.graphEqual) {
    rec.verdict = 'equal'
    return rec
  }
  rec.first = first
  const bis = new G.Bisim()
  const ca = G.cutHash(rawA, { budget: cutBudget })
  const cp = null == ca ? null : G.cutHash(pTree, { budget: cutBudget })
  rec.cutEqual = null == ca || null == cp ? null : ca === cp
  if (false === rec.cutEqual) {
    const sa = G.cutHash(rawA, { sorted: true, budget: cutBudget })
    const sp = null == sa ? null : G.cutHash(pTree, { sorted: true, budget: cutBudget })
    rec.sortedEqual = null == sa || null == sp ? null : sa === sp
  }
  rec.unfoldedEqual = bis.equal(rawA, pTree)
  rec.verdict =
    true === rec.cutEqual ? 'sharing'
      : true === rec.sortedEqual ? 'order'
        : null == rec.cutEqual && rec.unfoldedEqual ? 'sharing'
          : 'content'

  // The sites, as written, and what each side made of each.
  const prov = new Map()
  for (const p of r.provenance) prov.set(p.at, p)
  const unres = new Map()
  for (const u of r.unresolved) unres.set(u.at, u.why)
  const cutAt = new Set(r.cuts.map((c) => c.at))
  const sites = sitesOf(rawX)
  rec.sites = sites.length
  const differing = []
  let graphChecks = 0
  for (const s of sites) {
    const a = G.at(rawA, s.path)
    const p = G.at(pTree, s.path)
    let how = null
    if (!bis.equal(a, p)) {
      if (!Bisim0(a, p)) how = 'top'
      else how = 'below'
    } else if (G.isObj(a) && graphChecks < SITE_BUDGET) {
      graphChecks++
      const d = G.graphDiff(a, p)
      if (null != d) how = 'sharing'
    }
    if (null == how) continue
    const at = G.ptr(s.path)
    const pv = prov.get(at)
    const d = {
      at,
      path: s.path,
      ref: s.ref,
      how,
      apidef: statusA(a, s, rawX, A),
      preset: null == pv ? (undefined === p ? 'absent' : 'not a site') : pv.status + (unres.has(at) ? ' (' + unres.get(at) + ')' : cutAt.has(at) && 'cut' !== pv.status ? ' (cut)' : ''),
      presetTarget: pv?.target ?? null,
      presetKind: pv?.kind ?? null,
      a: G.show(a),
      p: G.show(p),
    }
    if ('top' === how && G.isObj(a) && G.isObj(p) && !Array.isArray(a) && !Array.isArray(p)) {
      const ka = Object.keys(a)
      const kp = Object.keys(p)
      const same = ka.length === kp.length && ka.slice().sort().join('\0') === kp.slice().sort().join('\0')
      // The same members in another order; `orderOnly` when nothing below differs either.
      d.reordered = same
      if (same) d.orderOnly = ka.every((k) => Bisim0(a[k], p[k]) && bis.equal(a[k], p[k]))
      d.aKeys = ka
      d.pKeys = kp
    }
    // The preset holds the map as written at the site's own place: its
    // x-ref, if any, is not the reference, which neither of the preset's
    // paths for a site makes under xref (both define x-ref as the $ref).
    if ('string' === typeof s.ref && G.isObj(p) && !Array.isArray(p) && p.$ref === s.ref && p['x-ref'] !== s.ref) d.presetBare = true
    differing.push(d)
  }
  rec.differing = differing
  const ctx = { raw: rawX, A, version: r.version, sites, prov, unres }
  rec.classes = classify(rec, ctx)
  return rec
}

// The same keys in order and the same scalars, at one level.
function Bisim0(a, b) {
  if (!G.isObj(a) || !G.isObj(b)) return G.Bisim.shallow(a, b)
  if (!G.Bisim.shallow(a, b)) return false
  for (const k of G.keysOf(a)) {
    const x = a[k]
    const y = b[k]
    if (G.isObj(x) !== G.isObj(y)) return false
    if (!G.isObj(x) && !G.Bisim.shallow(x, y)) return false
    if (G.isObj(x) && Array.isArray(x) !== Array.isArray(y)) return false
  }
  return true
}

// What apidef made of a site: the reference as written (it still has the
// `$ref` it was written with), resolved, or not there at all.
function statusA(node, s, raw, A) {
  if (undefined === node) return 'absent'
  if (!G.isObj(node)) return 'not a map'
  if (own(node, '$ref') && ('string' === typeof s.ref ? node.$ref === s.ref : 'string' !== typeof node.$ref)) return 'as written'
  return 'resolved'
}

module.exports = { compareText, sitesOf }
