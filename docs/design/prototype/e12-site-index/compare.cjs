/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */
'use strict'

// E12: today's `resolve` against the prototype built on the site index,
// for one raw tree.
//
// The prototype is run in three modes, so that a difference can be laid
// at one change:
//
//   index     the fold's facts come from the index, and nothing else
//             changes: this must be today's resolver exactly;
//   landings  a site is also read at its landing, on the document as
//             written (what repairs W1 and W2);
//   full      the regions the model does not type are also typed by the
//             references that land in them (what repairs W3).
//
// Two results are equal when their provenance, unresolved and cut rows
// are the same rows in the same order, their connections and data-slot
// counts are the same, and their trees are the same graphs: members,
// member order, values, and which objects are shared.

const Path = require('node:path')

const ROOT = Path.join(__dirname, '..', '..', '..', '..')
const O = require(process.env.OPENAPI_DIST || Path.join(ROOT, 'ts', 'dist', 'openapi.js'))
const R = require('./resolver.cjs')
const { graphDiff } = require(Path.join(ROOT, 'tools', 'apidef-preset', 'graph.cjs'))

const MODES = {
  index: { typing: false, landings: false },
  landings: { typing: false, landings: true },
  full: { typing: true, landings: true },
}

const firstLine = (e) => String(e?.message ?? e).replace(/\x1b\[[0-9;]*m/g, '').split('\n')[0].slice(0, 200)

function run(fn) {
  const t = performance.now()
  try {
    const r = fn()
    return { ok: true, r, ms: performance.now() - t }
  } catch (e) {
    return { ok: false, code: e?.code ?? e?.name ?? 'Error', msg: firstLine(e), ms: performance.now() - t }
  }
}

const today = (raw, options) => run(() => O.resolve(raw, options))

function proto(raw, options, mode, order) {
  R.mode({ ...MODES[mode], order: order ?? 'document' })
  return run(() => R.resolve(raw, options))
}

// Two lists of report rows, each row keyed by `at`.
function rowsDiff(a, b, fields) {
  const key = (r) => fields.map((f) => JSON.stringify(r[f] ?? null)).join('\u0001')
  let same = a.length === b.length
  for (let i = 0; same && i < a.length; i++) same = a[i].at === b[i].at && key(a[i]) === key(b[i])
  if (same) return { same: true }
  const ma = new Map(a.map((r) => [r.at, r]))
  const mb = new Map(b.map((r) => [r.at, r]))
  const out = { same: false, sameRows: true, onlyA: 0, onlyB: 0, changed: 0, samples: [] }
  const note = (s) => {
    out.sameRows = false
    if (out.samples.length < 12) out.samples.push(s)
  }
  for (const [at, r] of ma) {
    const q = mb.get(at)
    if (null == q) {
      out.onlyA++
      note({ at, only: 'today', row: r })
    } else if (key(r) !== key(q)) {
      out.changed++
      const moved = fields.filter((f) => JSON.stringify(r[f] ?? null) !== JSON.stringify(q[f] ?? null))
      note({ at, changed: Object.fromEntries(moved.map((f) => [f, [r[f] ?? null, q[f] ?? null]])) })
    }
  }
  for (const [at, q] of mb) {
    if (!ma.has(at)) {
      out.onlyB++
      note({ at, only: 'prototype', row: q })
    }
  }
  return out
}

function diffResults(a, b) {
  if (!a.ok || !b.ok) {
    return { equal: !a.ok && !b.ok && a.code === b.code, threw: [a.ok ? null : a.code + ': ' + a.msg, b.ok ? null : b.code + ': ' + b.msg] }
  }
  const out = {}
  const p = rowsDiff(a.r.provenance, b.r.provenance, ['ref', 'kind', 'type', 'target', 'status'])
  const u = rowsDiff(a.r.unresolved, b.r.unresolved, ['ref', 'why'])
  const c = rowsDiff(a.r.cuts, b.r.cuts, ['ref', 'target'])
  if (!p.same) out.provenance = p
  if (!u.same) out.unresolved = u
  if (!c.same) out.cuts = c
  if (JSON.stringify(a.r.connections) !== JSON.stringify(b.r.connections)) {
    out.connections = [a.r.connections.length, b.r.connections.length]
  }
  if (a.r.dataSlots !== b.r.dataSlots) out.dataSlots = [a.r.dataSlots, b.r.dataSlots]
  const d = graphDiff(a.r.tree, b.r.tree)
  if (null != d) out.tree = d
  out.equal = 0 === Object.keys(out).length
  // Whether the rows are the same rows, in another order.
  out.order = !out.equal && null == out.tree && null == out.dataSlots && null == out.connections &&
    [p, u, c].every((x) => x.same || x.sameRows)
  return out
}

const inc = (o, k, n = 1) => {
  o[k] = (o[k] ?? 0) + n
}

// What the index found, as figures and a few samples.
function indexStats(index) {
  const s = {
    rounds: index.rounds,
    roots: index.roots.size,
    maps: index.maps,
    sites: index.order.length,
    byRound: {},
    kinds: {},
    why: {},
    landings: { found: 0, missing: 0, loop: 0, depth: 0, passes: 0, through: 0, under: 0, passesAndMissing: 0, typedByReference: 0, inData: 0 },
    conflicts: index.conflicts.length,
    conflictKinds: {},
    samples: { through: [], under: [], roots: [], conflicts: [], missing: [] },
  }
  for (const row of index.order) {
    inc(s.byRound, row.round)
    inc(s.kinds, row.kind)
    if (null != row.why) inc(s.why, row.why)
    const l = row.landing
    if (null == l || null == row.target) continue
    const passes = 0 < (l.passes ?? []).length
    if (passes) s.landings.passes++
    if (passes && !l.found && !l.loop && !l.depth) s.landings.passesAndMissing++
    if (l.found) {
      s.landings.found++
      if (0 < l.through.length) {
        s.landings.through++
        if (s.samples.through.length < 5) s.samples.through.push({ at: row.at, ref: row.ref, landing: l.ptr, through: l.through })
      }
      if (null != l.under) {
        s.landings.under++
        if (s.samples.under.length < 5) s.samples.under.push({ at: row.at, ref: row.ref, landing: l.ptr, under: l.under })
      }
      if (null != l.typedBy) s.landings.typedByReference++
      if ('data' === l.known) s.landings.inData++
    } else if (l.loop) s.landings.loop++
    else if (l.depth) s.landings.depth++
    else {
      s.landings.missing++
      if (s.samples.missing.length < 3) s.samples.missing.push({ at: row.at, ref: row.ref, stopped: l.stopped, step: l.step, through: l.through })
    }
  }
  for (const [ptr, root] of index.roots) {
    if (s.samples.roots.length < 8) s.samples.roots.push({ at: ptr, state: root.state, by: root.by, round: root.round })
  }
  for (const c of index.conflicts) {
    inc(s.conflictKinds, c.wants + ' -> ' + c.found)
    if (s.samples.conflicts.length < 8) s.samples.conflicts.push(c)
  }
  return s
}

// Every comparison for one raw tree. `preset` adds the apidef preset.
function examine(raw, { preset = false, order = 'document' } = {}) {
  const rec = { ms: {} }

  let T = today(raw)
  rec.ms.today = T.ms
  rec.sites = T.ok ? T.r.provenance.length : null

  // The index alone.
  let P = proto(raw, undefined, 'index', order)
  rec.ms.index = P.ms
  rec.index = diffResults(T, P)
  P = null

  // Landings and typing.
  P = proto(raw, undefined, 'full', order)
  rec.ms.full = P.ms
  rec.stats = P.ok ? indexStats(P.r.index) : null
  rec.full = diffResults(T, P)
  P = null
  if (!rec.full.equal) {
    P = proto(raw, undefined, 'landings', order)
    rec.landings = diffResults(T, P)
    P = null
  }
  T = null

  // `cycles: 'keep'`, built on landings.
  let K = today(raw, { cycles: 'keep' })
  rec.ms.keepToday = K.ms
  P = proto(raw, { cycles: 'keep' }, 'full', order)
  rec.ms.keepFull = P.ms
  rec.keep = diffResults(K, P)
  P = null
  if (!rec.keep.equal) {
    P = proto(raw, { cycles: 'keep' }, 'index', order)
    rec.keepIndex = diffResults(K, P)
    P = proto(raw, { cycles: 'keep' }, 'landings', order)
    rec.keepLandings = diffResults(K, P)
    P = null
  }
  K = null

  if (preset) {
    let A = today(raw, { compat: 'apidef' })
    P = proto(raw, { compat: 'apidef' }, 'full', order)
    rec.preset = diffResults(A, P)
    rec.presetSites = A.ok ? A.r.provenance.length : null
    A = P = null
  }
  return rec
}

module.exports = { O, R, MODES, today, proto, diffResults, indexStats, examine }
