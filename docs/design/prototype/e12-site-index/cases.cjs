#!/usr/bin/env node
/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */
'use strict'

// E12: the shapes the site index changes, and the typing rounds.
//
//   EXPR_DIST=<expr build with site.written>/ts/dist/expr.js node cases.cjs
//
// Part 1 runs each shape through today's `resolve` and through the
// prototype, and prints what each gives. Part 2 runs the typing rounds
// on cases built for them, each under many orders of its members, and
// counts the answers. Exit status 1 when a case that the plan says has
// one answer has more.

const { O, R, MODES } = require('./compare.cjs')

const J = JSON.stringify
const copy = (v) => JSON.parse(J(v))
const info = { title: 't', version: '1' }

function show(result, pick) {
  if (!result.ok) return 'THROWS ' + result.code
  const r = result.r
  const value = pick(r.tree)
  const left = r.provenance.filter((p) => 'resolved' !== p.status).map((p) => p.at.split('/').pop() + ' ' + p.status)
  return J(value) + (0 < left.length ? '   [' + left.join(', ') + ']' : '')
}

const run = (fn) => {
  try {
    return { ok: true, r: fn() }
  } catch (e) {
    return { ok: false, code: e.code ?? e.name }
  }
}

// ---- part 1: the shapes ----

const S = (schemas, version = '3.0.3') => ({ openapi: version, info, paths: {}, components: { schemas } })

const SHAPES = [
  ['W1  a pointer through a reference, to a member the reference has as written',
    S({
      A: { properties: { x: { type: 'string' } } },
      B: { $ref: '#/components/schemas/A', properties: { x: { type: 'integer' } } },
      C: { $ref: '#/components/schemas/B/properties/x' },
    }), (t) => t.components.schemas.C],
  ['W1  the same pointer, to a member only the reference\'s target has (the lenient rule)',
    S({
      A: { properties: { y: { type: 'string' } } },
      B: { $ref: '#/components/schemas/A' },
      C: { $ref: '#/components/schemas/B/properties/y' },
    }), (t) => t.components.schemas.C],
  ['W1  the lenient rule under 3.1, where the reference has other members',
    S({
      A: { properties: { y: { type: 'string' } } },
      B: { $ref: '#/components/schemas/A', description: 'b' },
      C: { $ref: '#/components/schemas/B/properties/y' },
    }, '3.1.0'), (t) => t.components.schemas.C],
  ['W1  through two references in turn',
    S({
      A: { properties: { y: { type: 'string' } } },
      B: { $ref: '#/components/schemas/A' },
      B2: { $ref: '#/components/schemas/B' },
      C: { $ref: '#/components/schemas/B2/properties/y' },
    }), (t) => t.components.schemas.C],
  ['W1  through a reference that names nothing',
    S({
      B: { $ref: '#/components/schemas/Missing' },
      C: { $ref: '#/components/schemas/B/properties/y' },
    }), (t) => t.components.schemas.C],
  ['W2  a schema that references its own $defs, and a reference to it',
    S({
      B: { $ref: '#/components/schemas/B/$defs/x', $defs: { x: { type: 'string' } } },
      C: { $ref: '#/components/schemas/B' },
    }, '3.1.0'), (t) => [t.components.schemas.B, t.components.schemas.C]],
  ['W2  a schema that references its own member (section 3, row 1)',
    S({
      A: { $ref: '#/components/schemas/A/properties/p', properties: { p: { type: 'string' } } },
    }), (t) => t.components.schemas.A],
  ['W2  a member of a reference whose own target is missing (section 3, row 2)',
    S({
      B: { $ref: '#/components/schemas/Missing', properties: { x: { type: 'integer' } } },
      C: { $ref: '#/components/schemas/B/properties/x' },
    }), (t) => t.components.schemas.C],
  ['W2  a reference from inside a site to a member beside it',
    S({
      B: { $ref: '#/components/schemas/A', properties: { p: { $ref: '#/components/schemas/B/properties/q' }, q: { type: 'integer' } } },
      A: { type: 'object' },
      C: { allOf: [{ $ref: '#/components/schemas/B/properties/p' }] },
    }), (t) => t.components.schemas.C.allOf[0]],
  ['W3  a reference into an extension, with a reference inside the target',
    {
      openapi: '3.0.3', info,
      paths: { '/a': { get: { responses: { 404: { $ref: '#/x-common/NotFound' } } } } },
      'x-common': { NotFound: { description: 'nf', content: { 'application/json': { schema: { $ref: '#/components/schemas/E' } } } } },
      components: { schemas: { E: { type: 'object' } } },
    }, (t) => t.paths['/a'].get.responses['404']],
  ['W3  a reference into `definitions` in a 3.1 schema',
    S({
      A: { definitions: { inner: { properties: { e: { $ref: '#/components/schemas/E' } } } } },
      B: { $ref: '#/components/schemas/A/definitions/inner' },
      E: { type: 'integer' },
    }, '3.1.0'), (t) => t.components.schemas.B],
  ['W3  a 3.0 component whose name the pattern refuses',
    S({
      'a b': { properties: { e: { $ref: '#/components/schemas/E' } } },
      B: { $ref: '#/components/schemas/a b' },
      E: { type: 'integer' },
    }), (t) => t.components.schemas.B],
  ['--  a loop of pointers, each through the other',
    S({
      A: { $ref: '#/components/schemas/B/x' },
      B: { $ref: '#/components/schemas/A/y' },
    }), (t) => [t.components.schemas.A, t.components.schemas.B]],
]

function shapes() {
  console.log('## The shapes\n')
  for (const [name, doc, pick] of SHAPES) {
    const raw = copy(doc)
    const line = (label, result) => console.log('   ' + label.padEnd(26) + show(result, pick))
    console.log(name)
    line('today', run(() => O.resolve(raw)))
    R.mode(MODES.landings)
    line('prototype, landings', run(() => R.resolve(raw)))
    R.mode(MODES.full)
    const full = run(() => R.resolve(raw))
    line('prototype, and typing', full)
    line('today, keep', run(() => O.resolve(raw, { cycles: 'keep', sharing: 'site' })))
    line('prototype, keep', run(() => R.resolve(raw, { cycles: 'keep', sharing: 'site' })))
    line('today, the preset', run(() => O.resolve(raw, { compat: 'apidef', cycles: 'cut' })))
    line('prototype, the preset', run(() => R.resolve(raw, { compat: 'apidef', cycles: 'cut' })))
    if (full.ok) {
      const ix = full.r.index
      const notes = []
      for (const row of ix.order) {
        const l = row.landing
        if (null == l) continue
        if (l.found && 0 < l.through.length) notes.push(`${row.at} lands on ${l.ptr} through ${l.through.join(', ')}`)
        else if (l.found && null != l.under) notes.push(`${row.at} lands on ${l.ptr}, inside the site ${l.under}`)
        else if (l.loop) notes.push(`${row.at} is a loop`)
      }
      for (const [ptr, root] of ix.roots) notes.push(`${ptr} typed ${root.state} by ${root.by}, round ${root.round}`)
      for (const n of notes) console.log('   index: ' + n)
    }
    console.log()
  }
}

// ---- part 2: the rounds ----

// A seeded generator, so that a run can be repeated.
function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
}

// The same document with the members of every map in another order.
// Lists keep theirs: the order of a list is part of what it says.
function reorder(v, next) {
  if (Array.isArray(v)) return v.map((x) => reorder(x, next))
  if (null == v || 'object' !== typeof v) return v
  const keys = Object.keys(v)
  for (let i = keys.length - 1; 0 < i; i--) {
    const j = Math.floor(next() * (i + 1))
    ;[keys[i], keys[j]] = [keys[j], keys[i]]
  }
  const out = {}
  for (const k of keys) out[k] = reorder(v[k], next)
  return out
}

const reversed = (v) => {
  if (Array.isArray(v)) return v.map(reversed)
  if (null == v || 'object' !== typeof v) return v
  const out = {}
  for (const k of Object.keys(v).reverse()) out[k] = reversed(v[k])
  return out
}

// What the index says, in a form that does not depend on the order it
// was found in.
function answer(index) {
  const sites = index.order
    .map((r) => [r.at, r.kind, r.type, r.round, r.base, r.why ?? null,
      r.landing?.found ? r.landing.ptr : r.landing?.loop ? 'loop' : null, (r.landing?.through ?? []).join(' ')])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
  const roots = [...index.roots].map(([p, r]) => [p, r.state, r.by, r.round]).sort((a, b) => (a[0] < b[0] ? -1 : 1))
  const ids = [...index.ids].map(([u, p]) => [u, p.join('/')]).sort((a, b) => (a[0] < b[0] ? -1 : 1))
  const conflicts = index.conflicts.map((c) => [c.at, c.landing, c.wants, c.found]).sort((a, b) => (a[0] < b[0] ? -1 : 1))
  return J({ rounds: index.rounds, sites, roots, ids, conflicts })
}

const chain = (n) => {
  const doc = { openapi: '3.0.3', info, paths: { '/a': { get: { responses: { 200: { $ref: '#/x-r0/R' } } } } } }
  doc['x-r0'] = { R: { description: 'd', content: { 'application/json': { schema: { $ref: '#/x-s1/S' } } } } }
  for (let i = 1; i <= n; i++) {
    doc['x-s' + i] = { S: i < n ? { properties: { next: { $ref: `#/x-s${i + 1}/S` } } } : { type: 'string' } }
  }
  return doc
}

const ROUNDS = [
  ['R1  typing reveals a second reference to the same target, of the same type', true, {
    openapi: '3.0.3', info,
    paths: { '/a': { get: { responses: { 404: { $ref: '#/x-responses/NotFound' } } } } },
    'x-responses': { NotFound: { description: 'nf', content: { 'application/json': { schema: { $ref: '#/x-schemas/Error' } } } } },
    components: { schemas: { Problem: { properties: { cause: { $ref: '#/x-schemas/Error' } } } } },
    'x-schemas': { Error: { type: 'object', properties: { code: { $ref: '#/x-schemas/Code' } } }, Code: { type: 'integer' } },
  }],
  ['R2  typing reveals a second reference to the same target, of another type', true, {
    openapi: '3.0.3', info,
    paths: { '/a': { get: { responses: { 404: { $ref: '#/x-responses/NotFound' }, 500: { $ref: '#/x-shared/Thing' } } } } },
    'x-responses': { NotFound: { description: 'nf', content: { 'application/json': { schema: { $ref: '#/x-shared/Thing' } } } } },
    'x-shared': { Thing: { description: 'a response, by the first reference to it', type: 'object' } },
  }],
  ['R3  an $id inside a region typed only by reference', true, {
    openapi: '3.1.0', info, paths: {},
    components: {
      schemas: {
        A: { $ref: '#/x-defs/Thing' },
        B: { $ref: 'https://example.com/schemas/thing#/properties/name' },
        C: { $ref: 'https://example.com/schemas/thing#tag' },
      },
    },
    'x-defs': {
      Thing: {
        $id: 'https://example.com/schemas/thing',
        type: 'object',
        properties: { name: { type: 'string', $anchor: 'tag' }, self: { $ref: '#/properties/name' } },
      },
    },
  }],
  ['R4  a region that references itself', true, {
    openapi: '3.0.3', info, paths: {},
    components: { schemas: { A: { $ref: '#/x-a/Node' } } },
    'x-a': { Node: { properties: { next: { $ref: '#/x-a/Node' }, other: { $ref: '#/x-a/Leaf' } } }, Leaf: { type: 'string' } },
  }],
  ['R5  a chain of 40 regions, each typed by a reference in the one before', true, chain(40)],
  ['R6  two references of one round that give one target different types', false, {
    openapi: '3.0.3', info, paths: {},
    components: {
      responses: { R: { $ref: '#/x-u/T' } },
      schemas: { S: { $ref: '#/x-u/T' } },
    },
    'x-u': { T: { description: 'a response or a schema', type: 'object' } },
  }],
]

function rounds() {
  console.log('## The rounds\n')
  let bad = 0
  const SHUFFLES = 500
  for (const [name, oneAnswer, doc] of ROUNDS) {
    console.log(name)
    for (const order of ['document', 'pointer']) {
      R.mode({ ...MODES.full, order })
      const next = rng(12345)
      const answers = new Map()
      let most = 0
      const variants = [copy(doc), reversed(copy(doc))]
      for (let i = 0; i < SHUFFLES; i++) variants.push(reorder(copy(doc), next))
      let first = null
      for (const v of variants) {
        const r = R.resolve(v)
        first ??= r
        most = Math.max(most, r.index.rounds)
        const a = answer(r.index)
        answers.set(a, (answers.get(a) ?? 0) + 1)
      }
      const ix = first.index
      console.log(`   order ${order.padEnd(8)}: ${variants.length} orders of the members, ${answers.size} answer${1 === answers.size ? '' : 's'}; ` +
        `rounds ${ix.rounds} (at most ${most}), sites ${ix.order.length}, regions typed ${ix.roots.size}, conflicts ${ix.conflicts.length}`)
      if ('document' === order) {
        for (const [ptr, root] of [...ix.roots].slice(0, 4)) console.log(`      ${ptr} typed ${root.state} by ${root.by}, round ${root.round}`)
        if (4 < ix.roots.size) console.log(`      ... and ${ix.roots.size - 4} more`)
        for (const c of ix.conflicts) console.log(`      conflict: ${c.at} wants ${c.wants}, and ${c.landing} is ${c.found}`)
        if (oneAnswer && 1 !== answers.size) bad++
      }
      if (1 < answers.size) {
        for (const [a, n] of answers) {
          const o = JSON.parse(a)
          console.log(`      ${n} orders: ${o.roots.map((r) => `${r[0]} typed ${r[1]} by ${r[2]}`).join('; ')}`)
        }
      }
    }
    console.log()
  }
  R.mode(MODES.full)
  return bad
}

shapes()
const bad = rounds()
if (0 < bad) {
  console.log(`${bad} case(s) that should have one answer have more`)
  process.exit(1)
}
