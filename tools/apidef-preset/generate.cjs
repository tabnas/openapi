/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */
'use strict'

// tools/apidef-preset/generate.cjs: small documents, made at random from a
// seed, so that a run repeats.
//
// Each document combines, at random: a version (2.0, 3.0, 3.1, 3.2 or
// none), a few schemas under ordinary and awkward names (`a/b`, `a~b`,
// `a b`, `a%20b`, `__proto__`, `constructor`, ``, `0`, `Été`), declared
// in a random order; reference sites with and without sibling members
// (before or after the `$ref`, `x-ref` and `__proto__` among them),
// nested inside properties, lists, items and example data; reference
// forms (a plain pointer, a pointer into a member, an index, a list or
// scalar target, a missing target, another document, `#` and ``, a
// percent-encoded pointer, `#%2F...`, a bad `~`, an anchor, an `$id`
// URI, the document's `$self`, a non-string `$ref`); `$id`, `$anchor`,
// `$schema` and `jsonSchemaDialect`; a root `$ref` now and then; and
// Path Items that reference one another. Chains and cycles arise from
// the references naming one another. See `generate` for the two profiles.
//
// A module for apidef-preset.cjs; it runs nothing by itself.

// mulberry32: a small seeded generator.
function rng(seed) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const R = {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p) => next() < p,
    pick: (list) => list[Math.floor(next() * list.length)],
    shuffle: (list) => {
      const out = list.slice()
      for (let i = out.length - 1; 0 < i; i--) {
        const j = Math.floor(next() * (i + 1))
        ;[out[i], out[j]] = [out[j], out[i]]
      }
      return out
    },
  }
  return R
}

const PLAIN = ['A', 'B', 'C', 'D', 'E']
const ODD = ['a/b', 'a~b', 'a b', 'a%20b', '__proto__', 'constructor', '', '0', 'Été', 'toString']
const VERSIONS = [['2.0', 1], ['3.0', 3], ['3.1', 3], ['3.2', 2], ['none', 1]]
const DIALECTS = ['http://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft/2020-12/schema', 'https://spec.openapis.org/oas/3.1/dialect/base']

const esc = (s) => s.replace(/~/g, '~0').replace(/\//g, '~1')
const define = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true })

function weighted(R, pairs) {
  const total = pairs.reduce((a, p) => a + p[1], 0)
  let x = R.next() * total
  for (const [v, w] of pairs) {
    x -= w
    if (x < 0) return v
  }
  return pairs[pairs.length - 1][0]
}

function makeDoc(R, plain) {
  const v = weighted(R, VERSIONS)
  // The plain profile keeps $id, anchors and dialects out, so that a schema
  // reads its pointers as apidef does.
  const ids = !plain && ('3.1' === v || '3.2' === v || 'none' === v)
  const names = R.shuffle(PLAIN).slice(0, R.int(2, 4))
  if (!plain && R.chance(0.3)) names.push(R.pick(ODD))
  const order = R.shuffle([...new Set(names)])
  const base = '2.0' === v ? '#/definitions/' : '#/components/schemas/'
  const self = !plain && '3.2' === v && R.chance(0.3) ? 'https://example.com/api/doc.json' : null
  const anchors = []
  const idOf = {}

  const ptrTo = (name) => base + esc(name)
  const refTo = () => {
    const name = R.pick(order)
    const form = weighted(R, [
      ['plain', 30], ['member', 10], ['index', 4], ['list', 2], ['scalar', 1], ['missing', plain ? 0 : 3], ['external', plain ? 0 : 2],
      ['hash', plain ? 0 : 1], ['empty', plain ? 0 : 1], ['pct', plain ? 0 : 3], ['pct-slash', plain ? 0 : 1], ['tilde', plain ? 0 : 1],
      ['anchor', ids ? 2 : 0], ['id', ids ? 2 : 0], ['self', self ? 2 : 0], ['nonstring', 1], ['member-of-member', 3],
    ])
    switch (form) {
      case 'plain': return ptrTo(name)
      case 'member': return ptrTo(name) + '/properties/' + R.pick(['p', 'q', 'r'])
      case 'member-of-member': return ptrTo(name) + '/properties/p/properties/' + R.pick(['p', 'q'])
      case 'index': return ptrTo(name) + '/allOf/' + R.pick(['0', '1', '01', '-', '5'])
      case 'list': return ptrTo(name) + '/enum'
      case 'scalar': return ptrTo(name) + '/type'
      case 'missing': return base + 'Missing'
      case 'external': return R.pick(['other.yaml#/X', './other.json#' + base.slice(1) + 'A', 'https://example.org/x.json'])
      case 'hash': return '#'
      case 'empty': return ''
      case 'pct': return base + encodeURIComponent(name) + (R.chance(0.3) ? '/properties/p' : '')
      case 'pct-slash': return '#' + encodeURIComponent(base.slice(1) + esc(name))
      case 'tilde': return base + R.pick(['a~2b', 'a~', '~'])
      case 'anchor': return '#' + R.pick(['anc', 'dyn', 'none'])
      case 'id': return R.pick(['https://example.com/s/' + R.int(0, 2), 's' + R.int(0, 2) + '.json'])
      case 'self': return self + (R.chance(0.8) ? '#' + base.slice(1) + esc(name) : '')
      case 'nonstring': return R.pick([1, null, true, ['#/x'], { $ref: ptrTo(name) }])
    }
    return ptrTo(name)
  }

  const leaf = () => R.pick([{ type: 'string' }, { type: 'integer', format: 'int32' }, { enum: [1, 2] }, { type: 'boolean', description: 'b' }])

  const site = (depth) => {
    const s = {}
    const sibs = []
    const nSibs = weighted(R, [[0, 5], [1, 3], [2, 2], [3, 1]])
    for (let i = 0; i < nSibs; i++) {
      const k = weighted(R, [['description', 4], ['title', 2], ['type', 2], ['properties', 3], ['x-ref', 1], ['__proto__', plain ? 0 : 1], ['allOf', 1], ['example', 1]])
      if (sibs.some((x) => x[0] === k)) continue
      let val
      if ('properties' === k) val = { p: sub(depth + 1), [R.pick(['q', 'r'])]: sub(depth + 1) }
      else if ('allOf' === k) val = [sub(depth + 1)]
      else if ('example' === k) val = R.chance(0.5) ? { $ref: refTo() } : { a: 1 }
      else if ('__proto__' === k) val = R.chance(0.5) ? { type: 'number' } : 'x'
      else if ('type' === k) val = R.pick(['object', 'string'])
      else val = k + '-' + R.int(0, 9)
      sibs.push([k, val])
    }
    const before = R.chance(0.3)
    if (!before) define(s, '$ref', refTo())
    for (const [k, val] of sibs) define(s, k, val)
    if (before) define(s, '$ref', refTo())
    return s
  }

  const sub = (depth) => {
    if (3 <= depth) return R.chance(0.5) ? leaf() : site(depth)
    const kind = weighted(R, [['leaf', 3], ['site', 5], ['object', 3], ['allOf', 1], ['items', 1], ['example', 1]])
    if ('leaf' === kind) return leaf()
    if ('site' === kind) return site(depth)
    if ('object' === kind) {
      const o = { type: 'object', properties: {} }
      for (const p of R.shuffle(['p', 'q', 'r']).slice(0, R.int(1, 3))) o.properties[p] = sub(depth + 1)
      return o
    }
    if ('allOf' === kind) return { allOf: [sub(depth + 1), sub(depth + 1)] }
    if ('items' === kind) return { type: 'array', items: sub(depth + 1) }
    return { type: 'object', example: { $ref: refTo(), v: 1 } }
  }

  const schemas = {}
  for (const name of order) {
    let s = sub(0)
    if (ids && R.chance(0.15)) {
      const id = R.pick(['https://example.com/s/' + R.int(0, 2), 's' + R.int(0, 2) + '.json'])
      s = Object.assign({ $id: id }, s)
      idOf[name] = id
    }
    if (ids && R.chance(0.1)) {
      const a = R.pick(['anc', 'dyn'])
      s = Object.assign({ ['anc' === a ? '$anchor' : '$dynamicAnchor']: a }, s)
      anchors.push(a)
    }
    if (ids && R.chance(0.05)) s = Object.assign({ $schema: R.pick(DIALECTS) }, s)
    define(schemas, name, s)
  }

  const doc = {}
  if ('none' !== v) doc['2.0' === v ? 'swagger' : 'openapi'] = { '2.0': '2.0', '3.0': '3.0.3', '3.1': '3.1.0', '3.2': '3.2.0' }[v]
  if (self) doc.$self = self
  if (ids && R.chance(0.05)) doc.jsonSchemaDialect = R.pick(DIALECTS)
  doc.info = { title: 't', version: '1' }
  const paths = {}
  if (R.chance(0.3)) {
    paths['/a'] = { get: { responses: { 200: { description: 'ok' } } } }
    paths['/b'] = R.chance(0.5) ? { $ref: '#/paths/~1a' } : { $ref: '#/paths/~1a', summary: 's', get: { description: 'mine' } }
  }
  doc.paths = paths
  if ('2.0' === v) doc.definitions = schemas
  else doc.components = { schemas }
  if (!plain && R.chance(0.03)) doc.$ref = refTo()
  return doc
}

// `count` documents from `seed`, as { name, text }: the first half from the
// mixed profile, the second from the plain one, which leaves out the
// reference forms, names and keywords known to part the two resolvers by
// themselves (missing and external targets, `#`, ``, percent-encoding, a
// bad `~`, anchors, `$id`, `$self`, dialects, `__proto__`, odd names, a
// root `$ref`), so that what is left is how references combine: chains,
// cycles, siblings, order of declaration, sharing.
function* generate(seed, count) {
  const R = rng(seed)
  const half = Math.ceil(count / 2)
  for (let i = 0; i < count; i++) {
    const plain = i >= half
    const doc = makeDoc(R, plain)
    yield { name: `gen-${seed}-${plain ? 'plain' : 'mixed'}-${i}`, text: JSON.stringify(doc) }
  }
}

module.exports = { generate, rng }
