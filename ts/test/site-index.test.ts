/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// The site index, held to itself: the typing rounds, their bound, and the
// index that carries each round forward against one that works every
// round out from nothing. What `resolve` makes of the index is in
// resolve.test.ts and test/resolve/.

import { describe, test } from 'node:test'
import assert from 'node:assert'
import { join } from 'node:path'

import { buildIndex } from '../dist/site-index'
import type { DocFacts, DocInput, IndexConfig, Loc, SiteIndex } from '../dist/site-index'
import { pointer } from '../dist/uri'

const { generate } = require(join(__dirname, '..', '..', 'tools', 'apidef-preset', 'generate.cjs'))

const DOC = 'https://example.com/doc'

const DIALECT: Record<string, string> = {
  '3.1': 'https://spec.openapis.org/oas/3.1/dialect/base',
  '3.2': 'https://spec.openapis.org/oas/3.2/dialect/base',
}

function config(raw: any, over: Partial<IndexConfig> = {}): IndexConfig {
  const v = String(raw?.openapi ?? raw?.swagger ?? '3.2')
  const mv = (v.startsWith('2') ? '2.0' : v.startsWith('3.0') ? '3.0' : v.startsWith('3.1') ? '3.1' : '3.2') as IndexConfig['mv']
  return {
    mv,
    entry: DOC,
    retrieved: DOC,
    rootDialect: DIALECT[mv] ?? '',
    slots: 'spec',
    extensions: new Set(),
    pointers: false,
    maxDepth: 1000,
    refuse: (code, message, at) => {
      const err: any = new Error(message)
      err.code = code
      err.at = at
      throw err
    },
    ...over,
  }
}

const indexOf = (raw: any, over: Partial<IndexConfig> = {}): SiteIndex => buildIndex(raw, config(raw, over))

const pathOf = (loc: Loc): (string | number)[] => {
  const path: (string | number)[] = []
  for (let p: Loc | undefined = loc; undefined !== p && undefined !== p.parent; p = p.parent) path.push(p.seg)
  return path.reverse()
}

// A place as the tests write it: its pointer, after its document's key
// where that is not the description.
const placed = (index: SiteIndex, doc: DocFacts | undefined, at: string): string =>
  undefined === doc || doc === index.docs[0] ? at : doc.key + ' ' + at

// Everything the index says, in a form that does not depend on the order
// it was found in: every location's facts in every document, every
// site's, and the count of data slots.
function answer(index: SiteIndex): string {
  const locs: any[] = []
  const stack: Loc[] = index.docs.map((doc) => doc.root)
  while (0 < stack.length) {
    const loc = stack.pop()!
    locs.push([
      placed(index, loc.doc, pointer(pathOf(loc))),
      loc.state,
      loc.known,
      loc.base,
      loc.dialect,
      loc.rules?.name ?? null,
      loc.ext,
      loc.dynamic,
      loc.slot,
      loc.ids ?? null,
      undefined === loc.region ? null : [loc.region.state, placed(index, loc.region.by.loc.doc, loc.region.by.at), loc.region.round],
    ])
    for (const kid of loc.kids ?? []) stack.push(kid)
  }
  const sites = index.sites.map((r) => [
    placed(index, r.loc.doc, r.at),
    r.kind,
    r.type,
    r.state,
    r.round,
    r.base,
    r.dialect,
    r.alone,
    r.why ?? null,
    undefined === r.target ? null : placed(index, r.targetDoc, pointer(r.target)),
    r.uri ?? null,
    r.fragment ?? null,
    undefined === r.landing
      ? null
      : r.landing.found
        ? placed(index, r.landing.doc, pointer(r.landing.path!))
        : true === r.landing.loop
          ? 'loop'
          : 'nowhere',
    r.landing?.through ?? null,
  ])
  const mappings = index.mappings.map((r) => {
    const land = index.mappingLanding(r)
    return [
      placed(index, r.loc.doc, r.at),
      r.key,
      r.ref,
      r.round,
      r.base,
      r.via,
      r.why ?? null,
      undefined === r.target ? null : placed(index, r.targetDoc, pointer(r.target)),
      r.uri ?? null,
      r.fragment ?? null,
      land.found ? placed(index, land.doc, pointer(land.path!)) : true === land.loop ? 'loop' : 'nowhere',
      land.through ?? null,
    ]
  })
  const byAt = (a: any[], b: any[]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
  return JSON.stringify({
    rounds: index.rounds,
    dataSlots: index.dataSlots,
    locs: locs.sort(byAt),
    sites: sites.sort(byAt),
    mappings: mappings.sort(byAt),
    dialects: index.dialects(),
  })
}

// The regions a reference typed, as `at state by round`.
function regions(index: SiteIndex): string[] {
  const out: string[] = []
  const stack: Loc[] = index.docs.map((doc) => doc.root)
  while (0 < stack.length) {
    const loc = stack.pop()!
    if (undefined !== loc.region) {
      const at = placed(index, loc.doc, pointer(pathOf(loc)))
      out.push(`${at} ${loc.region.state} ${placed(index, loc.region.by.loc.doc, loc.region.by.at)} ${loc.region.round}`)
    }
    for (const kid of loc.kids ?? []) stack.push(kid)
  }
  return out.sort()
}

// A seeded generator, so that a run can be repeated.
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
}

// The same document with the members of every map in another order.
// Lists keep theirs: the order of a list is part of what it says.
function reorder(v: any, next: () => number): any {
  if (Array.isArray(v)) return v.map((x) => reorder(x, next))
  if (null == v || 'object' !== typeof v) return v
  const keys = Object.keys(v)
  for (let i = keys.length - 1; 0 < i; i--) {
    const j = Math.floor(next() * (i + 1))
    ;[keys[i], keys[j]] = [keys[j], keys[i]]
  }
  const out: any = {}
  for (const k of keys) out[k] = reorder(v[k], next)
  return out
}

const info = { title: 't', version: '1' }

const chain = (n: number) => {
  const doc: any = { openapi: '3.0.3', info, paths: { '/a': { get: { responses: { 200: { $ref: '#/x-r0/R' } } } } } }
  doc['x-r0'] = { R: { description: 'd', content: { 'application/json': { schema: { $ref: '#/x-s1/S' } } } } }
  for (let i = 1; i <= n; i++) {
    doc['x-s' + i] = { S: i < n ? { properties: { next: { $ref: `#/x-s${i + 1}/S` } } } : { type: 'string' } }
  }
  return doc
}

// The cases of the prototype E12: [name, whether one answer holds under
// every order of the members, rounds, regions, document].
const ROUNDS: [string, boolean, number, number, any][] = [
  ['typing reveals a second reference to the same target, of the same type', true, 2, 3, {
    openapi: '3.0.3', info,
    paths: { '/a': { get: { responses: { 404: { $ref: '#/x-responses/NotFound' } } } } },
    'x-responses': { NotFound: { description: 'nf', content: { 'application/json': { schema: { $ref: '#/x-schemas/Error' } } } } },
    components: { schemas: { Problem: { properties: { cause: { $ref: '#/x-schemas/Error' } } } } },
    'x-schemas': { Error: { type: 'object', properties: { code: { $ref: '#/x-schemas/Code' } } }, Code: { type: 'integer' } },
  }],
  ['typing reveals a second reference to the same target, of another type', true, 1, 2, {
    openapi: '3.0.3', info,
    paths: { '/a': { get: { responses: { 404: { $ref: '#/x-responses/NotFound' }, 500: { $ref: '#/x-shared/Thing' } } } } },
    'x-responses': { NotFound: { description: 'nf', content: { 'application/json': { schema: { $ref: '#/x-shared/Thing' } } } } },
    'x-shared': { Thing: { description: 'a response, by the first reference to it', type: 'object' } },
  }],
  ['an $id inside a region typed only by reference', true, 1, 1, {
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
  ['a region that references itself', true, 2, 2, {
    openapi: '3.0.3', info, paths: {},
    components: { schemas: { A: { $ref: '#/x-a/Node' } } },
    'x-a': { Node: { properties: { next: { $ref: '#/x-a/Node' }, other: { $ref: '#/x-a/Leaf' } } }, Leaf: { type: 'string' } },
  }],
  ['a chain of 40 regions, each typed by a reference in the one before', true, 41, 41, chain(40)],
  ['two references of one round that give one target different types', false, 1, 1, {
    openapi: '3.0.3', info, paths: {},
    components: {
      responses: { R: { $ref: '#/x-u/T' } },
      schemas: { S: { $ref: '#/x-u/T' } },
    },
    'x-u': { T: { description: 'a response or a schema', type: 'object' } },
  }],
  // A mapping value is no reference, and names a schema all the same: it
  // types what it lands on as a schema's `$ref` does.
  ['a mapping value types what it names, which has a mapping value of its own', true, 2, 2, {
    openapi: '3.0.3', info, paths: {},
    components: { schemas: { A: { discriminator: { propertyName: 'k', mapping: { b: '#/x-b/B' } } }, Leaf: { type: 'string' } } },
    'x-b': { B: { discriminator: { propertyName: 'k', mapping: { c: '#/x-c/C' } } } },
    'x-c': { C: { properties: { p: { $ref: '#/components/schemas/Leaf' } } } },
  }],
  ['a default mapping and a mapping value of one discriminator', true, 1, 2, {
    openapi: '3.2.0', info, paths: {},
    components: { schemas: { S: { discriminator: { propertyName: 'k', defaultMapping: '#/x-d/Other', mapping: { a: '#/x-m/A' } } } } },
    'x-d': { Other: { properties: { a: { $ref: '#/x-m/A' } } } },
    'x-m': { A: { type: 'string' } },
  }],
  ['a reference and a mapping value of one round that give one target different types', false, 1, 1, {
    openapi: '3.0.3', info, paths: {},
    components: {
      responses: { R: { $ref: '#/x-u/T' } },
      schemas: { S: { discriminator: { propertyName: 'k', mapping: { t: '#/x-u/T' } } } },
    },
    'x-u': { T: { description: 'a response or a schema', type: 'object' } },
  }],
]

const copy = (v: any) => JSON.parse(JSON.stringify(v))

// A dialect of each kind this package reads, and one it does not know.
const DIALECTS = [
  'http://json-schema.org/draft-04/schema#',
  'http://json-schema.org/draft-06/schema#',
  'http://json-schema.org/draft-07/schema#',
  'https://json-schema.org/draft/2019-09/schema',
  'https://json-schema.org/draft/2020-12/schema',
  'https://example.com/a-dialect',
]

// A document of regions the model does not type, nested in each other
// and typed by references, with identifiers and anchors in them: what
// the index has to carry from one round to the next.
function regionsDoc(seed: number): any {
  const next = rng(seed)
  const pick = (n: number) => Math.floor(next() * n)
  const v31 = 0 === pick(2)
  const doc: any = { openapi: v31 ? '3.1.0' : '3.0.3', info, paths: {}, components: { schemas: {}, responses: {} } }
  const count = 2 + pick(7)
  const at: string[] = []
  const holders: any[] = []
  for (let i = 0; i < count; i++) {
    // A region is under an extension of the root, or of an earlier region.
    const inside = 0 < i && 0 === pick(2) ? pick(i) : -1
    const region: any = { type: 'object', properties: {} }
    if (v31 && 0 === pick(3)) region.$id = 0 === pick(2) ? `https://example.com/r${i}` : `r${i}/`
    if (v31 && 0 === pick(3)) region.$anchor = 'a' + i
    if (0 === pick(4)) region.definitions = { D: { type: 'string' }, E: { $ref: '#/components/schemas/S0' } }
    // A region may declare its dialect, which decides whether `id` or
    // `$id` names it, what an anchor is, and whether `definitions` and a
    // list of `items` hold schemas.
    if (v31 && 0 === pick(3)) region.$schema = DIALECTS[pick(DIALECTS.length)]
    if (v31 && 0 === pick(4)) region.id = 0 === pick(2) ? `https://example.com/q${i}` : '#n' + i
    if (v31 && 0 === pick(5)) region.items = [{ $ref: '#/components/schemas/S0' }, { $recursiveRef: '#' }]
    const key = 'x-r' + i
    if (-1 === inside) {
      doc[key] = { T: region }
      at.push(`/${key}/T`)
    } else {
      holders[inside][key] = { T: region }
      at.push(`${at[inside]}/${key}/T`)
    }
    holders.push(region)
  }
  const ref = (to: number): string => {
    const r = holders[to]
    const how = pick(4)
    if (v31 && 1 === how && 'string' === typeof r.$id && r.$id.startsWith('https:')) return r.$id
    if (v31 && 2 === how && 'string' === typeof r.$anchor && undefined === r.$id) return DOC + '#' + r.$anchor
    if (3 === how && undefined !== r.definitions) return DOC + '#' + at[to] + '/definitions/D'
    return DOC + '#' + at[to]
  }
  // Each region names a few others, and a few components name regions.
  for (let i = 0; i < count; i++) {
    const n = pick(3)
    for (let j = 0; j < n; j++) holders[i].properties['p' + j] = { $ref: ref(pick(count)) }
    if (0 === pick(5)) holders[i].properties.gone = { $ref: DOC + '#' + at[pick(count)] + '/nope' }
  }
  const starts = 1 + pick(3)
  for (let j = 0; j < starts; j++) doc.components.schemas['S' + j] = { $ref: ref(pick(count)) }
  if (0 === pick(3)) doc.components.responses.R = { $ref: ref(pick(count)) }
  // A discriminator's mapping values name regions too, by the same
  // texts. One may be the name of a schema component, or name nothing.
  const discriminator = (): any => {
    const mapping: any = {}
    const n = 1 + pick(3)
    for (let j = 0; j < n; j++) {
      const how = pick(8)
      mapping['m' + j] = 0 === how ? 'S0' : 1 === how ? DOC + '#' + at[pick(count)] + '/nope' : ref(pick(count))
    }
    return { propertyName: 'kind', mapping }
  }
  for (let i = 0; i < count; i++) if (0 === pick(3)) holders[i].discriminator = discriminator()
  if (0 === pick(2)) doc.components.schemas.M = { type: 'object', discriminator: discriminator() }
  return doc
}

describe('site index', () => {
  for (const [name, oneAnswer, rounds, typed, doc] of ROUNDS) {
    test('rounds: ' + name, () => {
      const first = indexOf(copy(doc))
      assert.equal(first.rounds, rounds)
      assert.equal(regions(first).length, typed)
      const next = rng(12345)
      const answers = new Set<string>()
      for (let i = 0; i < 200; i++) {
        const variant = 0 === i ? copy(doc) : reorder(copy(doc), next)
        const index = indexOf(variant)
        answers.add(JSON.stringify(regions(index)))
        // The index that carries each round forward says what one that
        // works every round out from nothing says.
        assert.equal(answer(index), answer(indexOf(variant, { incremental: false })))
      }
      if (oneAnswer) assert.equal(answers.size, 1)
      // Two references of one round that disagree are decided by which
      // is written first: Decision 28 has the order of the document.
      else assert.equal(answers.size, 2)
    })
  }

  test('a region takes the type of the first reference to land on it, in the order of the document', () => {
    const doc = ROUNDS[5][4]
    assert.deepEqual(regions(indexOf(copy(doc))), ['/x-u/T response? /components/responses/R 1'])
    const swapped = copy(doc)
    swapped.components = { schemas: doc.components.schemas, responses: doc.components.responses }
    assert.deepEqual(regions(indexOf(swapped)), ['/x-u/T schema /components/schemas/S 1'])
  })

  test('the index carried forward equals the index worked out from nothing, on regions nested in each other', () => {
    let typedSome = 0
    let nested = 0
    let mapped = 0
    let late = 0
    for (let seed = 1; seed <= 400; seed++) {
      const doc = regionsDoc(seed)
      const index = indexOf(doc)
      if (0 < index.rounds) typedSome++
      if (regions(index).some((r) => 2 < r.split(' ')[0].split('/x-r').length)) nested++
      // A region that a mapping value typed, and a mapping value that
      // was found only once the region around it was typed.
      if (regions(index).some((r) => r.split(' ')[2].includes('/discriminator/'))) mapped++
      if (index.mappings.some((m) => 0 < m.round)) late++
      assert.equal(answer(index), answer(indexOf(doc, { incremental: false })), 'seed ' + seed)
    }
    // The generator does make what it is for.
    assert.ok(300 < typedSome, 'only ' + typedSome + ' documents had a region typed')
    assert.ok(50 < nested, 'only ' + nested + ' documents had a region typed inside another')
    assert.ok(50 < mapped, 'only ' + mapped + ' documents had a region typed by a mapping value')
    assert.ok(50 < late, 'only ' + late + ' documents had a mapping value found in a later round')
  })

  test('a mapping value is the name of a schema component where there is one, and a URI reference where there is none', () => {
    const doc = {
      openapi: '3.1.0', info, paths: {},
      components: {
        schemas: {
          Pet: {
            discriminator: {
              propertyName: 'kind',
              mapping: { cat: 'Cat', dog: '#/x-models/Dog', gone: '#/x-models/Gone', far: 'other.json#/Far', '#/x-models/Dog': 'Cat' },
              'x-note': 'no mapping value',
            },
          },
          Cat: { type: 'object' },
        },
      },
      'x-models': { Dog: { type: 'object' }, 'not-read': { discriminator: { propertyName: 'k', mapping: { a: '#/x-models/Dog' } } } },
    }
    const index = indexOf(doc)
    const rows = index.mappings.map((m) => {
      const land = index.mappingLanding(m)
      return [m.at, m.ref, m.via, undefined === m.target ? null : pointer(m.target), m.why ?? null, land.found, m.round]
    })
    assert.deepEqual(rows, [
      // The name of a component, whatever else it could be read as.
      ['/components/schemas/Pet/discriminator/mapping/cat', 'Cat', 'name', '/components/schemas/Cat', null, true, 0],
      ['/components/schemas/Pet/discriminator/mapping/dog', '#/x-models/Dog', 'uri', '/x-models/Dog', null, true, 0],
      // A pointer that names nothing, and a document the set has not.
      ['/components/schemas/Pet/discriminator/mapping/gone', '#/x-models/Gone', 'uri', '/x-models/Gone', null, false, 0],
      ['/components/schemas/Pet/discriminator/mapping/far', 'other.json#/Far', 'uri', null, 'external', false, 0],
      // The member's name is the discriminator's value, whatever it is.
      ['/components/schemas/Pet/discriminator/mapping/#~1x-models~1Dog', 'Cat', 'name', '/components/schemas/Cat', null, true, 0],
    ])
    // What a mapping value lands on is a schema, and nothing else in the
    // extension is: a mapping there is read by nothing.
    assert.deepEqual(regions(index), ['/x-models/Dog schema /components/schemas/Pet/discriminator/mapping/dog 1'])
    assert.deepEqual([...index.wanted], ['https://example.com/other.json'])
    assert.equal(answer(index), answer(indexOf(doc, { incremental: false })))
    // In 2.0 a discriminator is the name of a property, and has no
    // mapping. Under `refs: 'pointer'` a mapping value is read and types
    // nothing.
    const two = { swagger: '2.0', info, paths: {}, definitions: { Pet: { discriminator: 'kind', mapping: { a: '#/x/A' } } }, x: { A: {} } }
    assert.deepEqual(indexOf(two).mappings, [])
    const plain = indexOf(doc, { pointers: true })
    assert.equal(plain.mappings.length, 5)
    assert.deepEqual(regions(plain), [])
  })

  test('the index carried forward equals the index worked out from nothing, on generated documents', () => {
    let compared = 0
    for (const item of generate(3, 800)) {
      let raw: any
      try {
        raw = JSON.parse(item.text)
      } catch {
        continue
      }
      if (null == raw || 'object' !== typeof raw) continue
      for (const over of [{}, { slots: 'all' as const }, { extensions: new Set(['x-ext']) }]) {
        compared++
        assert.equal(answer(indexOf(raw, over)), answer(indexOf(raw, { ...over, incremental: false })), item.name)
      }
    }
    assert.ok(1500 < compared, 'only ' + compared + ' compared')
  })

  test('a base URI that a later round finds moves what was located under the earlier one', () => {
    // S types the inner region first. A reference in it types the outer
    // one, whose `$id` is then the base of `rel`, written `#/properties/q`:
    // until then that named the root's own member. X is read through
    // `rel`, so it moves with it.
    const doc = {
      openapi: '3.1.0', info, paths: {},
      properties: { q: { type: 'string' } },
      components: {
        schemas: {
          S: { $ref: DOC + '#/x-o/T/x-i/T' },
          X: { $ref: DOC + '#/x-o/T/x-i/T/properties/rel/type' },
        },
      },
      'x-o': {
        T: {
          $id: 'https://example.com/o',
          properties: { q: { type: 'integer' } },
          'x-i': { T: { properties: { up: { $ref: DOC + '#/x-o/T' }, rel: { $ref: '#/properties/q' } } } },
        },
      },
    }
    const index = indexOf(doc)
    const site = (at: string) => index.sites.find((r) => r.at === at)!
    const rel = site('/x-o/T/x-i/T/properties/rel')
    assert.equal(rel.base, 'https://example.com/o')
    assert.equal(pointer(rel.target!), '/x-o/T/properties/q')
    const x = site('/components/schemas/X')
    assert.equal(pointer(x.landing!.path!), '/x-o/T/properties/q/type')
    assert.deepEqual(x.landing!.through, ['/x-o/T/x-i/T/properties/rel'])
    assert.equal(x.landing!.node, 'integer')
    assert.equal(answer(index), answer(indexOf(doc, { incremental: false })))
  })

  test('a site that a later round types as a schema is read by the dialect in force there', () => {
    // Under `slots: 'all'` the reference in the region is a site from the
    // start, as data. Once the region is typed it is a schema's, of the
    // dialect the region declares: draft-07, whose `$ref` stands alone.
    const doc = {
      openapi: '3.1.0', info, paths: {},
      components: { schemas: { S: { $ref: '#/x-o/T' }, Z: { type: 'string' } } },
      'x-o': { T: { $schema: 'http://json-schema.org/draft-07/schema#', properties: { a: { $ref: '#/components/schemas/Z' } } } },
    }
    const index = indexOf(doc, { slots: 'all' })
    const a = index.sites.find((r) => '/x-o/T/properties/a' === r.at)!
    assert.equal(a.round, 0)
    assert.equal(a.kind, 'schema')
    assert.equal(a.state, 'schema@draft-07')
    assert.equal(a.dialect, 'http://json-schema.org/draft-07/schema#')
    assert.equal(a.alone, true)
    assert.equal(a.why, undefined)
    assert.equal(pointer(a.target!), '/components/schemas/Z')
    assert.equal(answer(index), answer(indexOf(doc, { slots: 'all', incremental: false })))
  })

  test('a region typed in a later round is read by the dialect it declares', () => {
    // `definitions` holds schemas in draft-07 and is no keyword of
    // 2020-12. The reference in it is found by where it is once the
    // region is a schema, in the round that types the region.
    const region = (dialect: string | undefined) => ({
      openapi: '3.1.0', info, paths: {},
      components: { schemas: { S: { $ref: '#/x-o/T' }, Z: { type: 'string' } } },
      'x-o': { T: { ...(undefined === dialect ? {} : { $schema: dialect }), definitions: { D: { $ref: '#/components/schemas/Z' } } } },
    })
    const old = region('http://json-schema.org/draft-07/schema#')
    const index = indexOf(old)
    const d = index.sites.find((r) => '/x-o/T/definitions/D' === r.at)!
    assert.equal(d.round, 1)
    assert.equal(d.state, 'schema@draft-07')
    assert.equal(d.alone, true)
    assert.deepEqual(index.dialects(), [
      { at: '/x-o/T/$schema', dialect: 'http://json-schema.org/draft-07/schema#', as: 'draft-07', known: true },
    ])
    assert.equal(answer(index), answer(indexOf(old, { incremental: false })))
    // Without the declaration the region is a 2020-12 schema, and what
    // `definitions` holds is not read.
    const now = indexOf(region(undefined))
    assert.equal(now.sites.find((r) => '/x-o/T/definitions/D' === r.at), undefined)
    assert.deepEqual(now.dialects(), [])
  })

  test('a location has the rules of its dialect, and is dynamic where that dialect leaves a reference to evaluation', () => {
    const D = (name: string) =>
      name.startsWith('20') ? `https://json-schema.org/draft/${name}/schema` : `http://json-schema.org/${name}/schema#`
    const schemas: any = {}
    for (const name of ['draft-04', 'draft-06', 'draft-07', '2019-09', '2020-12']) {
      schemas[name] = {
        $schema: D(name),
        properties: { r: { $recursiveRef: '#' }, d: { $dynamicRef: '#x' }, both: { $ref: '#/x', $dynamicRef: '#x', $recursiveRef: '#' } },
      }
    }
    const doc = { openapi: '3.1.0', info, paths: {}, components: { schemas }, 'x-data': { $dynamicRef: '#x' } }
    const at = (index: SiteIndex, path: (string | number)[]): Loc => {
      let loc: Loc | undefined = index.root
      for (const seg of path) loc = index.child(loc!, seg)
      return loc!
    }
    const index = indexOf(doc)
    const facts = (name: string) => {
      const p = ['components', 'schemas', name]
      return [at(index, p).rules?.name, at(index, [...p, 'properties', 'r']).dynamic, at(index, [...p, 'properties', 'd']).dynamic]
    }
    assert.deepEqual(facts('draft-04'), ['draft-04', false, false])
    assert.deepEqual(facts('draft-06'), ['draft-06', false, false])
    assert.deepEqual(facts('draft-07'), ['draft-07', false, false])
    assert.deepEqual(facts('2019-09'), ['2019-09', true, false])
    assert.deepEqual(facts('2020-12'), ['2020-12', false, true])
    // A `$ref` is the reference where a map has both, and what is not a
    // schema has no rules.
    assert.equal(at(index, ['components', 'schemas', '2020-12', 'properties', 'both']).dynamic, false)
    assert.equal(at(index, ['components', 'schemas', '2019-09', 'properties', 'both']).dynamic, false)
    assert.equal(at(index, ['x-data']).rules, undefined)
    assert.equal(at(index, ['x-data']).dynamic, false)
    assert.equal(at(index, ['components']).rules, undefined)
    // Under `refs: 'pointer'` no dialect is read and nothing is dynamic.
    const plain = indexOf(doc, { pointers: true })
    assert.equal(at(plain, ['components', 'schemas', 'draft-04']).rules?.name, '2020-12')
    assert.equal(at(plain, ['components', 'schemas', 'draft-04']).state, 'schema')
    assert.equal(at(plain, ['components', 'schemas', '2020-12', 'properties', 'd']).dynamic, false)
    assert.deepEqual(plain.dialects(), [])
  })

  test('a reference that a later round reads against another base stops what was read through it', () => {
    // X is read through `p` to a member of Z. Then the region around `p`
    // is typed, and it names itself with an `$id`: `p` is read against
    // that from then on, and names nothing there, so nothing is read
    // through it.
    const doc = {
      openapi: '3.1.0', info, paths: {},
      components: {
        schemas: {
          S: { $ref: '#/x-o/T/x-i/T' },
          Z: { type: 'object', properties: { deep: { type: 'integer' } } },
          X: { $ref: '#/x-o/T/x-i/T/properties/p/properties/deep' },
        },
      },
      'x-o': {
        T: {
          $id: 'https://other.example/t',
          'x-i': { T: { properties: { up: { $ref: DOC + '#/x-o/T' }, p: { $ref: '#/components/schemas/Z' } } } },
        },
      },
    }
    const index = indexOf(doc)
    const site = (at: string) => index.sites.find((r) => r.at === at)!
    const p = site('/x-o/T/x-i/T/properties/p')
    assert.equal(p.base, 'https://other.example/t')
    assert.equal(pointer(p.target!), '/x-o/T/components/schemas/Z')
    assert.equal(p.landing!.found, false)
    assert.equal(site('/components/schemas/X').landing!.found, false)
    assert.equal(answer(index), answer(indexOf(doc, { incremental: false })))
  })

  test('a landing found late is still typed by the earliest round to reach it', () => {
    // R is of round 0, and its pointer is read through `via`, which is a
    // site only once the region around it is typed. `n` is of round 1 and
    // lands on the same place. R types it, being of the earlier round.
    const doc = {
      openapi: '3.0.3', info, paths: {},
      components: {
        schemas: { S: { $ref: '#/x-o/T' } },
        responses: { R: { $ref: '#/x-o/T/properties/via/x-u' } },
      },
      'x-o': { T: { properties: { n: { $ref: '#/x-store/x-u' }, via: { $ref: '#/x-store' } } } },
      'x-store': { 'x-u': { description: 'a response or a schema', type: 'object' } },
    }
    const index = indexOf(doc)
    assert.deepEqual(regions(index), [
      '/x-o/T schema /components/schemas/S 1',
      '/x-store schema /x-o/T/properties/via 2',
      '/x-store/x-u response? /components/responses/R 2',
    ])
    assert.equal(answer(index), answer(indexOf(doc, { incremental: false })))
  })

  test('a long chain of regions is typed, one round for each', () => {
    const index = indexOf(chain(300))
    assert.equal(index.rounds, 301)
    assert.equal(regions(index).length, 301)
  })

  test('rounds built to undo each other end in openapi_work', () => {
    // Each region holds the next in an extension, has an `$id`, and is
    // typed by a reference from the one inside it. So each round types
    // the next region out, which changes the base URI of everything in
    // it, and all of that is read again.
    const levels = 300
    const inner = (i: number) => DOC + '#/x-top' + '/x-in'.repeat(i)
    let region: any = { $id: `https://example.com/l${levels - 1}/`, properties: { up: { $ref: inner(levels - 2) } } }
    for (let p = 0; p < 4000; p++) region.properties['p' + p] = { type: 'string' }
    for (let i = levels - 2; 0 <= i; i--) {
      const outer: any = { $id: `https://example.com/l${i}/`, properties: {}, 'x-in': region }
      if (0 < i) outer.properties.up = { $ref: inner(i - 1) }
      region = outer
    }
    const doc = { openapi: '3.1.0', info, paths: {}, components: { schemas: { S: { $ref: inner(levels - 1) } } }, 'x-top': region }
    assert.throws(() => indexOf(doc), (err: any) => 'openapi_work' === err.code)
    // A few such levels are within the bound, and are typed.
    const few = copy(doc)
    let at = few['x-top']
    for (let i = 0; i < levels - 8; i++) at = at['x-in']
    few['x-top'] = at
    few.components.schemas.S.$ref = DOC + '#/x-top' + '/x-in'.repeat(7)
    // The references inside still name the longer paths, so only the
    // innermost region is typed: the point is that it is not refused.
    assert.equal(regions(indexOf(few)).length, 1)
  })

  test('a pointer read through a reference lists the references its own steps were missing at', () => {
    const S = '#/components/schemas/'
    const doc = {
      openapi: '3.0.3', info, paths: {},
      components: {
        schemas: {
          T: { not: { $ref: S + 'T' } },
          A0: { $ref: S + 'T' },
          A1: { $ref: S + 'A0/not' },
          A2: { $ref: S + 'A1/not' },
          E: { $ref: 'other.yaml' },
          viaE: { $ref: S + 'E/x' },
        },
      },
    }
    const index = indexOf(doc)
    const land = (name: string) => index.sites.find((r) => r.at === S.slice(1) + name)!.landing!
    assert.deepEqual(land('A1').through, [S.slice(1) + 'A0'])
    // A2 is read through A1, which lands on a reference, and through
    // that: what A1 was itself read through is A1's to say.
    assert.deepEqual(land('A2').through, [S.slice(1) + 'A1', S.slice(1) + 'T/not'])
    assert.equal(pointer(land('A2').path!), S.slice(1) + 'T/not')
    // A reference into another document cannot be read through.
    assert.equal(land('viaE').found, false)
    assert.equal(land('viaE').through, undefined)
    // The root is where a pointer starts, and is never read through.
    const rooted = { openapi: '3.0.3', $ref: '#/x-a', 'x-a': { y: { type: 'string' } }, components: { schemas: { P: { $ref: '#/y' } } } }
    const p = indexOf(rooted, { slots: 'all' }).sites.find((r) => '/components/schemas/P' === r.at)!
    assert.equal(p.landing!.found, false)
  })

  test('pointers read through each other deeper than maxDepth end in openapi_depth', () => {
    const S = '#/components/schemas/'
    const chain = (reversed: boolean) => {
      const entries: [string, any][] = [['T', { not: { $ref: S + 'T' } }], ['A0', { $ref: S + 'T' }]]
      for (let i = 1; i <= 12; i++) entries.push(['A' + i, { $ref: S + 'A' + (i - 1) + '/not' }])
      return { openapi: '3.0.3', info, paths: {}, components: { schemas: Object.fromEntries(reversed ? entries.reverse() : entries) } }
    }
    // Written last to first, the first asks for the second while it is
    // being read, and so on down.
    assert.throws(() => indexOf(chain(true), { maxDepth: 8 }), (err: any) => 'openapi_depth' === err.code && S.slice(1) + 'A4' === err.at)
    assert.equal(indexOf(chain(true), { maxDepth: 20 }).sites.length, 14)
    // Written first to last, each is read before the next asks for it.
    assert.equal(indexOf(chain(false), { maxDepth: 8 }).sites.length, 14)
  })

  test('many pointers read through one long chain of references end in openapi_work', () => {
    const S = '#/components/schemas/'
    const doc = (pointers: number, links: number) => {
      const schemas: Record<string, any> = {}
      for (let j = 0; j < links; j++) schemas['Q' + j] = { $ref: S + 'Q' + (j + 1) }
      schemas['Q' + links] = { type: 'object' }
      for (let i = 0; i < pointers; i++) schemas['P' + i] = { $ref: S + 'Q0/x' + i }
      return { openapi: '3.0.3', info, paths: {}, components: { schemas } }
    }
    // Each pointer is read through every link of the chain to find that
    // nothing has its member. A few hundred of each is within the bound.
    assert.equal(indexOf(doc(200, 200), { maxDepth: 100000 }).sites.filter((r) => !r.landing!.found).length, 200)
    assert.throws(() => indexOf(doc(2000, 2000), { maxDepth: 100000 }), (err: any) => 'openapi_work' === err.code)
  })

  test('nesting past maxDepth is refused with openapi_depth, as the fold refuses it', () => {
    const deep = (n: number) => {
      let v: any = 1
      for (let i = 0; i < n; i++) v = { a: v }
      return { openapi: '3.1.0', 'x-deep': v }
    }
    assert.equal(indexOf(deep(999)).rounds, 0)
    assert.throws(() => indexOf(deep(1000)), (err: any) => 'openapi_depth' === err.code)
    assert.throws(() => indexOf(deep(50), { maxDepth: 20 }), (err: any) => 'openapi_depth' === err.code)
  })
})

// One index over a description and the documents given with it.
describe('site index, several documents', () => {
  const HERE = 'https://example.com/api/'
  const versionOf = (raw: any): IndexConfig['mv'] | undefined => {
    const v = 'string' === typeof raw?.openapi ? raw.openapi : 'string' === typeof raw?.swagger ? raw.swagger : undefined
    if (undefined === v) return undefined
    return (v.startsWith('2') ? '2.0' : v.startsWith('3.0') ? '3.0' : v.startsWith('3.1') ? '3.1' : '3.2') as IndexConfig['mv']
  }
  // The documents of a set, as `resolve` hands them to the index: each by
  // the URI it was retrieved from, with its own where it has `$self`.
  const given = (docs: Record<string, any>, entry: IndexConfig['mv']): DocInput[] =>
    Object.entries(docs).map(([name, raw]) => {
      const key = new URL(name, HERE).href
      const mv = versionOf(raw)
      const read = mv ?? entry
      return {
        key,
        uri: '3.2' === mv && 'string' === typeof raw.$self ? new URL(raw.$self, key).href : key,
        raw,
        mv: read,
        described: undefined !== mv,
        rootDialect: 'string' === typeof raw?.jsonSchemaDialect ? raw.jsonSchemaDialect : (DIALECT[read] ?? ''),
      }
    })
  const setOf = (entry: any, docs: Record<string, any>, over: Partial<IndexConfig> = {}): SiteIndex => {
    const cfg = config(entry)
    const at = HERE + 'openapi.yaml'
    return indexOf(entry, { entry: at, retrieved: at, others: given(docs, cfg.mv), ...over })
  }
  const site = (index: SiteIndex, at: string) => {
    const found = index.sites.find((r) => placed(index, r.loc.doc, r.at) === at)
    assert.ok(undefined !== found, `no site at ${at}: ${index.sites.map((r) => placed(index, r.loc.doc, r.at)).join(', ')}`)
    return found
  }
  const lands = (index: SiteIndex, at: string): string => {
    const row = site(index, at)
    const land = index.landing(row)
    return land.found ? placed(index, land.doc, pointer(land.path!)) : true === land.loop ? 'loop' : (row.why ?? 'nowhere')
  }

  const shared = {
    openapi: '3.1.0',
    info: { title: 'shared', version: '1' },
    components: {
      responses: {
        Ok: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } },
      },
      schemas: {
        Pet: { $id: 'https://example.com/schemas/pet', type: 'object', properties: { tag: { $anchor: 'tag', type: 'string' } } },
        Named: { $anchor: 'named', type: 'string' },
      },
    },
  }
  const entry = (refs: Record<string, string>) => ({
    openapi: '3.1.0',
    info: { title: 'entry', version: '1' },
    paths: {},
    components: {
      responses: Object.fromEntries(Object.entries(refs).filter(([k]) => k.startsWith('r')).map(([k, $ref]) => [k, { $ref }])),
      schemas: Object.fromEntries(Object.entries(refs).filter(([k]) => !k.startsWith('r')).map(([k, $ref]) => [k, { $ref }])),
    },
  })
  const OTHER = HERE + 'shared.yaml'

  test('a reference lands in the document that holds what it names', () => {
    const index = setOf(
      entry({
        r1: 'shared.yaml#/components/responses/Ok',
        byPointer: 'shared.yaml#/components/schemas/Named',
        byId: 'https://example.com/schemas/pet',
        byAnchor: 'shared.yaml#named',
        byIdAnchor: 'https://example.com/schemas/pet#tag',
        whole: 'shared.yaml',
        absent: 'missing.yaml#/components/schemas/X',
        noAnchor: 'shared.yaml#nothing',
        notThere: 'shared.yaml#/components/schemas/Nothing',
      }),
      { 'shared.yaml': shared },
    )
    assert.deepEqual(index.docs.map((d) => d.key), [HERE + 'openapi.yaml', OTHER])
    assert.equal(lands(index, '/components/responses/r1'), OTHER + ' /components/responses/Ok')
    assert.equal(lands(index, '/components/schemas/byPointer'), OTHER + ' /components/schemas/Named')
    assert.equal(lands(index, '/components/schemas/byId'), OTHER + ' /components/schemas/Pet')
    assert.equal(lands(index, '/components/schemas/byAnchor'), OTHER + ' /components/schemas/Named')
    assert.equal(lands(index, '/components/schemas/byIdAnchor'), OTHER + ' /components/schemas/Pet/properties/tag')
    assert.equal(lands(index, '/components/schemas/whole'), OTHER + ' ')
    // A document that was not given is another document still, and the
    // site says which.
    assert.equal(lands(index, '/components/schemas/absent'), 'external')
    assert.equal(site(index, '/components/schemas/absent').uri, HERE + 'missing.yaml')
    assert.equal(site(index, '/components/schemas/absent').fragment, '/components/schemas/X')
    assert.equal(lands(index, '/components/schemas/noAnchor'), 'no-anchor')
    assert.equal(lands(index, '/components/schemas/notThere'), 'nowhere')
    // What the landing holds is typed by the model of its own document.
    const land = index.landing(site(index, '/components/responses/r1'))
    assert.equal(land.loc!.state, 'response?')
    assert.equal(land.loc!.doc.key, OTHER)
    assert.equal(index.stateAt(land), 'response?')
  })

  test('the sites of every document are found, each read against its own base', () => {
    const index = setOf(entry({ r1: 'shared.yaml#/components/responses/Ok' }), { 'shared.yaml': shared })
    const inner = OTHER + ' /components/responses/Ok/content/application~1json/schema'
    assert.equal(site(index, inner).base, OTHER)
    assert.equal(lands(index, inner), OTHER + ' /components/schemas/Pet')
    // A fragment alone names the document it is written in.
    const back = setOf(entry({ here: '#/components/schemas/there', there: 'shared.yaml#/components/schemas/Named' }), {
      'shared.yaml': shared,
    })
    assert.equal(lands(back, '/components/schemas/here'), '/components/schemas/there')
  })

  test('a document is named by its own URI, and by the one it was retrieved from', () => {
    const self = { ...shared, openapi: '3.2.0', $self: 'https://example.com/shared' }
    const index = setOf(
      {
        ...entry({ bySelf: 'https://example.com/shared#/components/schemas/Named', byWhere: 'shared.yaml#/components/schemas/Named' }),
        openapi: '3.2.0',
      },
      { 'shared.yaml': self },
    )
    assert.equal(index.docs[1].uri, 'https://example.com/shared')
    assert.equal(lands(index, '/components/schemas/bySelf'), OTHER + ' /components/schemas/Named')
    assert.equal(lands(index, '/components/schemas/byWhere'), OTHER + ' /components/schemas/Named')
    // Its own references are read against its own URI, not the one it
    // was retrieved from.
    const moved = setOf(
      { ...entry({ in: 'https://example.com/shared#/components/schemas/Out' }), openapi: '3.2.0' },
      {
        'shared.yaml': { ...self, components: { schemas: { Out: { $ref: 'next#/components/schemas/Named' } } } },
        'https://example.com/next': { ...shared, openapi: '3.2.0' },
      },
    )
    assert.equal(lands(moved, OTHER + ' /components/schemas/Out'), 'https://example.com/next /components/schemas/Named')
  })

  test('a document with no version is typed by the references that land in it, in rounds', () => {
    const index = setOf(entry({ Pet: 'Pet.yaml', viaList: 'defs.yaml#/Owner' }), {
      'Pet.yaml': { type: 'object', properties: { owner: { $ref: 'defs.yaml#/Owner' }, self: { $ref: '#' } } },
      'defs.yaml': { Owner: { type: 'object', properties: { pets: { type: 'array', items: { $ref: 'Pet.yaml' } } } }, Other: { $ref: 'x' } },
    })
    const pet = HERE + 'Pet.yaml'
    const defs = HERE + 'defs.yaml'
    assert.deepEqual(regions(index), [
      `${pet}  schema /components/schemas/Pet 1`,
      `${defs} /Owner schema /components/schemas/viaList 1`,
    ])
    // The sites inside each are found once it is typed, and not before:
    // `Other` is in no region, and is no site.
    assert.equal(lands(index, pet + ' /properties/owner'), defs + ' /Owner')
    assert.equal(lands(index, pet + ' /properties/self'), pet + ' ')
    assert.equal(lands(index, defs + ' /Owner/properties/pets/items'), pet + ' ')
    assert.equal(index.sites.some((r) => r.loc.doc.key === defs && '/Other' === r.at), false)
    assert.equal(site(index, pet + ' /properties/owner').round, 1)
    // Under `slots: 'all'` any `$ref` map with a string is a site.
    const all = setOf(entry({ Pet: 'Pet.yaml' }), { 'defs.yaml': { Other: { $ref: 'x' } } }, { slots: 'all' })
    assert.equal(site(all, defs + ' /Other').kind, 'data')
    assert.equal(lands(all, defs + ' /Other'), 'external')
  })

  test('a chain of references that each type the next has a round for each, and a round costs what it types', () => {
    // Each schema here is typed by the reference in the one before it,
    // so the index takes a round for each. A round reads again the
    // pointers that name nothing, and it kept them among all the sites:
    // every round looked at every site, uncounted, and a chain of
    // 20,000 took five seconds where one of 40,000 now takes one. The
    // limit is loose: with the old search this chain takes far longer
    // than it allows on any machine.
    const length = 40000
    const chain: Record<string, unknown> = {}
    for (let i = 0; i < length; i++) chain['S' + i] = { type: 'object', properties: { next: { $ref: '#/S' + (i + 1) } } }
    chain['S' + length] = {}
    const started = process.hrtime.bigint()
    const index = setOf(entry({ First: 'chain.json#/S0' }), { 'chain.json': chain })
    const ms = Number(process.hrtime.bigint() - started) / 1e6
    assert.equal(index.sites.length, length + 1)
    assert.equal(site(index, HERE + 'chain.json /S' + (length - 1) + '/properties/next').round, length)
    assert.ok(ms < 12000, `${Math.round(ms)} ms`)
  })

  test('a pointer is read on through a reference into another document', () => {
    const index = setOf(
      entry({ A: 'shared.yaml#/components/schemas/Pet', deep: '#/components/schemas/A/properties/tag', gone: '#/components/schemas/A/properties/none' }),
      { 'shared.yaml': shared },
    )
    const land = index.landing(site(index, '/components/schemas/deep'))
    assert.equal(land.found, true)
    assert.equal(placed(index, land.doc, pointer(land.path!)), OTHER + ' /components/schemas/Pet/properties/tag')
    assert.deepEqual(land.through, ['/components/schemas/A'])
    assert.equal(lands(index, '/components/schemas/gone'), 'nowhere')
  })

  test('two documents that name each other are indexed once each', () => {
    const a = { ...entry({ A: 'b.yaml#/components/schemas/B' }) }
    const b = { openapi: '3.1.0', info: { title: 'b', version: '1' }, components: { schemas: { B: { $ref: 'openapi.yaml#/components/schemas/A' } } } }
    const index = setOf(a, { 'b.yaml': b })
    assert.equal(lands(index, '/components/schemas/A'), HERE + 'b.yaml /components/schemas/B')
    assert.equal(lands(index, HERE + 'b.yaml /components/schemas/B'), '/components/schemas/A')
    assert.equal(index.rounds, 0)
  })

  test('each document is read by the model of its own version', () => {
    const index = setOf(entry({ old: 'old.json#/definitions/Pet' }), {
      'old.json': {
        swagger: '2.0',
        info: { title: 'old', version: '1' },
        paths: {},
        definitions: { Pet: { type: 'object', properties: { next: { $ref: '#/definitions/Pet' } } } },
        parameters: { P: { name: 'p', in: 'query', type: 'string' } },
      },
    })
    const old = HERE + 'old.json'
    assert.equal(index.docs[1].mv, '2.0')
    assert.equal(lands(index, '/components/schemas/old'), old + ' /definitions/Pet')
    assert.equal(index.landing(site(index, '/components/schemas/old')).loc!.state, 'schema')
    assert.equal(lands(index, old + ' /definitions/Pet/properties/next'), old + ' /definitions/Pet')
    // A schema reference that lands on a 2.0 parameter conflicts with it.
    const clash = setOf(entry({ wrong: 'old.json#/parameters/P' }), { 'old.json': index.docs[1].raw })
    assert.equal(clash.conflict(site(clash, '/components/schemas/wrong')), 'parameter')
  })

  test('the index carried forward equals the index worked out from nothing, across documents', () => {
    const docs = {
      'Pet.yaml': { type: 'object', properties: { owner: { $ref: 'defs.yaml#/Owner' }, kind: { $ref: 'shared.yaml#named' } } },
      'defs.yaml': { Owner: { properties: { pets: { items: { $ref: 'Pet.yaml' } }, deep: { $ref: 'Pet.yaml#/properties/owner/properties/pets' } } } },
      'shared.yaml': shared,
    }
    const raw = entry({ r1: 'shared.yaml#/components/responses/Ok', Pet: 'Pet.yaml', far: 'defs.yaml#/Owner/properties/deep' })
    const carried = setOf(raw, docs)
    assert.ok(1 < carried.rounds, `rounds: ${carried.rounds}`)
    assert.equal(answer(carried), answer(setOf(raw, docs, { incremental: false })))
  })
})
