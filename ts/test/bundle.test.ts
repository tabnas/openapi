/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// `bundle` and `bundleAll`, for what a case of test/bundle/ cannot say:
// the options, the bounds, the loading, and that the bundle agrees with
// its documents on sets of documents that are generated.

import { describe, test } from 'node:test'
import assert from 'node:assert'
import { join } from 'node:path'

import * as O from '../dist/openapi'
import * as U from '../dist/uri'
import { bundle, bundleAll, parse, ResolveError } from '../dist/openapi'

const ROOT = join(__dirname, '..', '..')
const { agree, checkWritten } = require(join(ROOT, 'tools', 'corpus', 'bundle-agree.cjs'))
const { generate } = require(join(ROOT, 'tools', 'apidef-preset', 'generate.cjs'))

const BASE = 'https://example.com/api/'
const HOME = BASE + 'openapi.json'
const info = { title: 't', version: '1' }
const ok = { 200: { description: 'ok' } }

// A value as JSON has it: a map of a tree has no prototype.
const C = (x: unknown) => JSON.parse(JSON.stringify(x))

const description = (rest: object, version: object = { openapi: '3.1.0' }) => parse(JSON.stringify({ ...version, info, ...rest }))

describe('bundle', () => {
  test('it takes the options that say how the documents are read, and no other', () => {
    const raw = description({ paths: {} })
    const takes = /it takes version, retrievalUri, documents, parse, maxDepth, maxSteps, onCheck, checkEveryN, slots, extensions$/
    for (const name of ['strict', 'sharing', 'cycles', 'siblings', 'targets', 'refs', 'xref', 'compat', 'budget', 'operations', 'load']) {
      assert.throws(
        () => bundle(raw, { [name]: true } as any),
        (e: any) => e instanceof TypeError && e.message.startsWith(`bundle: no option "${name}"; `) && takes.test(e.message),
        name,
      )
    }
    // One that is given as undefined is not given.
    assert.deepEqual(C(bundle(raw, { cycles: undefined } as any).tree), C(raw))
    assert.throws(() => bundle(raw, null as any), /^TypeError: bundle: options must be an object$/)
    assert.throws(() => bundle(raw, 'all' as any), /^TypeError: bundle: options must be an object$/)
    // What is wrong with one says whose it is.
    assert.throws(() => bundle(raw, { maxDepth: 0 }), /^TypeError: bundle: maxDepth must be a whole number above 0, not 0$/)
    assert.throws(() => bundle(raw, { slots: 'some' as any }), /^TypeError: bundle: slots must be one of spec, all, not "some"$/)
    assert.throws(() => bundle(raw, { documents: [] as any }), /^TypeError: bundle: documents must be a map from URI to document$/)
    assert.throws(
      () => bundle(raw, { documents: { 'x.json': {} } }),
      /^TypeError: bundle: documents names "x.json", which is relative, and no retrievalUri says what it is relative to$/,
    )
  })

  test('a description in one document is its own bundle', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const raw = parse(JSON.stringify(generate(seed)))
      const b = bundle(raw, { retrievalUri: HOME })
      assert.equal(JSON.stringify(b.tree), JSON.stringify(raw), 'seed ' + seed)
      assert.deepEqual(b.embedded, [])
      assert.deepEqual(b.dialects, [])
      assert.deepEqual(b.documents, [])
    }
  })

  test('the result says the version, and the documents that were read', () => {
    const raw = description({ paths: {}, components: { schemas: { A: { $ref: 'a.json' } } } })
    const b = bundle(raw, { retrievalUri: HOME, documents: { 'a.json': { type: 'string' }, 'sub/../unused.json': {} } })
    assert.equal(b.version, '3.1')
    assert.deepEqual(b.documents, [BASE + 'a.json', BASE + 'unused.json'])
    assert.deepEqual(Object.keys(b).sort(), ['dialects', 'documents', 'embedded', 'left', 'tree', 'version'])
  })

  test('the bundle shares nothing with what it was made of', () => {
    const raw = description({ paths: {}, components: { schemas: { A: { $ref: 'a.json' }, B: { type: 'object', properties: { p: { enum: [1, 2] } } } } } })
    const documents = { 'a.json': { type: 'object', properties: { q: { enum: ['x'] } } } }
    const before = JSON.stringify([raw, documents])
    const b = bundle(raw, { retrievalUri: HOME, documents })
    assert.notStrictEqual(b.tree, raw)
    assert.notStrictEqual(b.tree.components.schemas.B, raw.components.schemas.B)
    assert.notStrictEqual(b.tree.components.schemas.a, documents['a.json'])
    b.tree.info.title = 'changed'
    b.tree.components.schemas.B.properties.p.enum.push(3)
    b.tree.components.schemas.a.properties.q.enum.push('y')
    assert.equal(JSON.stringify([raw, documents]), before)
  })

  test('a reference that names the description by its URI is written as the pointer alone', () => {
    const raw = description({
      paths: {},
      components: {
        schemas: {
          A: { type: 'string' },
          Rel: { $ref: 'openapi.json#/components/schemas/A' },
          Abs: { $ref: 'https://EXAMPLE.com:443/api/x/../openapi.json#/components/schemas/A' },
          Whole: { $ref: 'openapi.json' },
          Back: { $ref: 'far.json#/there' },
        },
      },
    })
    const b = bundle(raw, { retrievalUri: HOME, documents: { 'far.json': { there: { $ref: 'openapi.json#/components/schemas/A' } } } })
    const s = C(b.tree.components.schemas)
    assert.deepEqual(s.Rel, { $ref: '#/components/schemas/A' })
    assert.deepEqual(s.Abs, { $ref: '#/components/schemas/A' })
    assert.deepEqual(s.Whole, { $ref: '#' })
    assert.deepEqual(s.Back, { $ref: '#/components/schemas/there' })
    assert.deepEqual(s.there, { $ref: '#/components/schemas/A' })
  })

  test('a member named __proto__ is data', () => {
    const raw = parse('{"openapi":"3.1.0","info":{"title":"t","version":"1"},"paths":{},"components":{"schemas":{"A":{"properties":{"__proto__":{"$ref":"a.json"}}}}}}')
    const b = bundle(raw, { retrievalUri: HOME, documents: { 'a.json': JSON.parse('{"properties":{"__proto__":{"type":"string"}}}') } })
    const props = b.tree.components.schemas.A.properties
    assert.deepEqual(Object.keys(props), ['__proto__'])
    assert.deepEqual(C(props.__proto__), { $ref: '#/components/schemas/a' })
    assert.deepEqual(Object.keys(b.tree.components.schemas.a.properties), ['__proto__'])
    assert.equal(Object.getPrototypeOf(b.tree.components.schemas.a), null)
  })

  test('a reference that names nothing stands, with the reason resolve gives', () => {
    const schemas = {
      NotText: { $ref: 5 },
      BadPointer: { $ref: '#/a~2' },
      NoAnchor: { $ref: '#nowhere' },
      NotFound: { $ref: '#/components/schemas/Nope' },
      External: { $ref: 'other.json#/x' },
      Loop: { $ref: '#/components/schemas/Loop/properties/p' },
    }
    const raw = description({ paths: {}, components: { schemas } })
    const b = bundle(raw, { retrievalUri: HOME })
    assert.equal(JSON.stringify(b.tree), JSON.stringify(raw))
    assert.deepEqual(
      b.left.map((l) => [l.at.replace('/components/schemas/', ''), l.ref, l.why]),
      [
        ['NotText', 5, 'not-a-string'],
        ['BadPointer', '#/a~2', 'bad-fragment'],
        ['NoAnchor', '#nowhere', 'no-anchor'],
        ['NotFound', '#/components/schemas/Nope', 'not-found'],
        ['External', 'other.json#/x', 'external'],
        ['Loop', '#/components/schemas/Loop/properties/p', 'loop'],
      ],
    )
  })

  test('a root that is no map has no place for a target', () => {
    for (const raw of ['text', 7, null, true]) assert.deepEqual(bundle(raw).tree, raw)
    const documents = { 'x.json': { a: 1 } }
    // Nothing in a list is a reference, by the object model.
    const asWritten = bundle([{ $ref: 'x.json' }], { retrievalUri: HOME, documents })
    assert.deepEqual(C(asWritten.tree), [{ $ref: 'x.json' }])
    assert.deepEqual(asWritten.embedded, [])
    // Under `slots: 'all'` it is, and its target stands in its place.
    const all = bundle([{ $ref: 'x.json' }, { $ref: 'x.json' }], { retrievalUri: HOME, documents, slots: 'all' })
    assert.deepEqual(C(all.tree), [{ a: 1 }, { $ref: '#/0' }])
    assert.deepEqual(all.embedded, [{ at: '/0', doc: BASE + 'x.json', from: '', as: 'inline' }])
  })

  test('a reference in an extension that the caller names is one', () => {
    const raw = description({ paths: {}, 'x-shared': { first: { $ref: 'data.json#/a' }, second: { $ref: 'data.json#/a' } }, 'x-other': { $ref: 'data.json#/a' } })
    const b = bundle(raw, { retrievalUri: HOME, documents: { 'data.json': { a: { n: 1 } } }, extensions: ['x-shared'] })
    assert.deepEqual(C(b.tree['x-shared']), { first: { n: 1 }, second: { $ref: '#/x-shared/first' } })
    assert.deepEqual(C(b.tree['x-other']), { $ref: 'data.json#/a' })
  })

  test('a name is the last step, or the name of the file, in the characters a component has', () => {
    const names = (uri: string, ref = uri) => {
      const raw = description({ paths: {}, components: { schemas: { A: { $ref: ref } } } })
      const b = bundle(raw, { retrievalUri: HOME, documents: { [uri]: { type: 'string', defs: { 'a b/c~d': { type: 'number' } } } } })
      return b.embedded.map((e) => e.at.replace('/components/schemas/', ''))
    }
    assert.deepEqual(names('pet.json'), ['pet'])
    assert.deepEqual(names('schemas/my%20pet.v2.yaml'), ['my_pet.v2'])
    assert.deepEqual(names('schemas/'), ['schemas'])
    assert.deepEqual(names('schemas/pet?version=2'), ['pet'])
    assert.deepEqual(names('schemas/.json'), ['bundled'])
    // A name the map has is not taken again.
    assert.deepEqual(names('A.json'), ['A_2'])
    assert.deepEqual(names('pet.json', 'pet.json#/defs/a%20b~1c~0d'), ['a_b_c_d'])
  })

  test('the pointer of a reference is written as a fragment that reads back', async () => {
    const raw = description({
      paths: {},
      components: { schemas: { Outer: { $ref: 'lib.json#/defs/Outer' }, Odd: { $ref: 'lib.json#/defs/Outer/properties/a%25b%23c%20d~1e~0f' } } },
    })
    const documents = { 'lib.json': { defs: { Outer: { properties: { 'a%b#c d/e~f': { type: 'string' } } } } } }
    const b = bundle(raw, { retrievalUri: HOME, documents })
    assert.deepEqual(C(b.tree.components.schemas.Odd), { $ref: '#/components/schemas/Outer_2/properties/a%25b%23c d~1e~0f' })
    const held = await agree(O, U, raw, { retrievalUri: HOME, documents })
    assert.ok(held.ok, held.why.join('; '))
    assert.deepEqual(held.after.unresolved, [])
  })

  test('a document given as text is read as resolve reads one', () => {
    const raw = description({ paths: { '/a': { $ref: 'a.yaml' } } })
    const b = bundle(raw, { retrievalUri: HOME, documents: { 'a.yaml': 'get:\n  responses:\n    "200": { description: ok }\n' } })
    assert.deepEqual(C(b.tree.components.pathItems.a), { get: { responses: ok } })
    // An error in a text names the document it is in.
    assert.throws(
      () => bundle(raw, { retrievalUri: HOME, documents: { 'a.yaml': 'get: *nothing\n' } }),
      (e: any) => 'yaml_undefined_alias' === e.code && e.message.includes(BASE + 'a.yaml'),
    )
    // The texts of one description are read against one limit.
    assert.throws(
      () => bundle(raw, { retrievalUri: HOME, parse: { maxBytes: 20 }, documents: { 'a.yaml': 'get: {}\n', 'b.yaml': 'summary: more than the limit has left\n' } }),
      (e: any) => e instanceof ResolveError && 'openapi_size' === e.code && e.message.startsWith('bundle: the documents given as text are more than 20 bytes together'),
    )
  })
})

describe('bundle, its bounds', () => {
  // A Path Item of 3.0 has no component. One that is named with fields
  // of its own beside the reference is written in that place, and is the
  // target's place for nobody else. Two such references in each Path
  // Item double the copies at every level.
  const doubling = (levels: number, branches: number) => {
    const documents: Record<string, unknown> = {}
    for (let i = 0; i < levels; i++) {
      const callbacks: Record<string, unknown> = {}
      if (i + 1 < levels) for (let b = 0; b < branches; b++) callbacks['c' + b] = { '{$url}': { $ref: `L${i + 1}.json`, summary: 'mine' } }
      documents[`L${i}.json`] = { post: { responses: {}, callbacks } }
    }
    const raw = description({ paths: { '/start': { $ref: 'L0.json', summary: 'mine' } } }, { openapi: '3.0.3' })
    return { raw, documents }
  }

  test('copies that multiply are held to the allowance of the index', () => {
    const small = doubling(6, 2)
    assert.equal(bundle(small.raw, { retrievalUri: HOME, documents: small.documents }).embedded.length, 63)
    const { raw, documents } = doubling(24, 2)
    assert.throws(
      () => bundle(raw, { retrievalUri: HOME, documents }),
      (e: any) =>
        e instanceof ResolveError &&
        'openapi_work' === e.code &&
        /^bundle: bundling this description takes more than 16 times the work of reading its documents once at "\/paths\/~1start\/post\/callbacks\//.test(e.message) &&
        e.at.startsWith('/paths/~1start/post/callbacks/'),
    )
  })

  test('the bundle nests no deeper than maxDepth, as no document does', () => {
    // Each target written inside the last is four deeper than it.
    const fits = doubling(4, 1)
    assert.equal(bundle(fits.raw, { retrievalUri: HOME, documents: fits.documents, maxDepth: 20 }).embedded.length, 4)
    const { raw, documents } = doubling(5, 1)
    assert.throws(
      () => bundle(raw, { retrievalUri: HOME, documents, maxDepth: 20 }),
      (e: any) => e instanceof ResolveError && 'openapi_depth' === e.code && /^bundle: the bundle nests deeper than 20 at "\/paths\/~1start\/post\/callbacks\//.test(e.message),
    )
    // With no option given it is the default that holds, or the stack
    // where that is the smaller of the two: a copy goes as deep as the
    // bundle nests, and how deep the stack goes is the machine's. Either
    // way the bundle is refused with the code, and never a RangeError.
    const deep = doubling(400, 1)
    assert.throws(
      () => bundle(deep.raw, { retrievalUri: HOME, documents: deep.documents }),
      (e: any) =>
        e instanceof ResolveError &&
        'openapi_depth' === e.code &&
        /^bundle: (the bundle nests deeper than 1000 at |the stack ran out before maxDepth \(1000\) was reached)/.test(e.message),
    )
  })

  test('references that each name the next are written one in another, to maxDepth', () => {
    // Each document is a reference to the next, and the last a Path
    // Item. One is written in the place of another, and none is deeper.
    const chain = (length: number) => {
      const documents: Record<string, unknown> = {}
      for (let i = 0; i < length; i++) documents[`R${i}.json`] = i + 1 < length ? { $ref: `R${i + 1}.json` } : { get: { responses: ok } }
      return { raw: description({ paths: { '/start': { $ref: 'R0.json' } } }, { openapi: '3.0.3' }), documents }
    }
    const fits = chain(8)
    const b = bundle(fits.raw, { retrievalUri: HOME, documents: fits.documents, maxDepth: 8 })
    assert.deepEqual(C(b.tree.paths), { '/start': { get: { responses: ok } } })
    assert.equal(b.embedded.length, 8)
    const { raw, documents } = chain(9)
    assert.throws(
      () => bundle(raw, { retrievalUri: HOME, documents, maxDepth: 8 }),
      (e: any) => e instanceof ResolveError && 'openapi_depth' === e.code && 'bundle: targets written one inside another deeper than 8 at "/paths/~1start"' === e.message,
    )
    const long = chain(500)
    assert.equal(bundle(long.raw, { retrievalUri: HOME, documents: long.documents }).embedded.length, 500)
    // Past what the stack holds, a chain is refused as one past maxDepth
    // is: with a code, whichever of the two it meets first.
    const endless = chain(5000)
    assert.throws(
      () => bundle(endless.raw, { retrievalUri: HOME, documents: endless.documents, maxDepth: 100000 }),
      (e: any) => e instanceof ResolveError && 'openapi_depth' === e.code,
    )
  })

  test('a document nested deeper than maxDepth is refused as resolve refuses it', () => {
    let deep: any = {}
    for (let i = 0; i < 12; i++) deep = { properties: { p: deep } }
    const raw = description({ paths: {}, components: { schemas: { A: { $ref: 'deep.json' } } } })
    assert.throws(
      () => bundle(raw, { retrievalUri: HOME, documents: { 'deep.json': deep }, maxDepth: 10 }),
      (e: any) => e instanceof ResolveError && 'openapi_depth' === e.code && e.message.startsWith('bundle: nesting deeper than 10'),
    )
  })

  test('the steps are counted, the copying with the reading', () => {
    const raw = description({ paths: {}, components: { schemas: { A: { $ref: 'a.json' } } } })
    const documents = { 'a.json': { type: 'object', properties: { p: { type: 'string' } } } }
    let steps = 0
    const b = bundle(raw, { retrievalUri: HOME, documents, onCheck: (n: number) => ((steps = n), true), checkEveryN: 1 })
    assert.equal(b.embedded.length, 1)
    // The index's reading of every map, and then a copy of each.
    assert.ok(16 <= steps, steps + ' steps')
    assert.throws(() => bundle(raw, { retrievalUri: HOME, documents, maxSteps: steps - 1 }), (e: any) => 'openapi_work' === e.code && e.message === `bundle: more than ${steps - 1} steps`)
    assert.equal(bundle(raw, { retrievalUri: HOME, documents, maxSteps: steps }).embedded.length, 1)
    assert.throws(
      () => bundle(raw, { retrievalUri: HOME, documents, onCheck: () => false, checkEveryN: 5 }),
      (e: any) => 'openapi_cancel' === e.code && 'bundle: stopped by onCheck after 5 steps' === e.message,
    )
  })
})

describe('bundle, what a review of it found', () => {
  const schemaAt = (ref: string) => ({
    get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: ref } } } } } },
  })

  test('nothing is put where the description has something that is no map', () => {
    const documents = { 'a.json': { Pet: { type: 'string' } } }
    const cases: [object, object, string][] = [
      [{ paths: { '/a': schemaAt('a.json#/Pet') }, components: [1] }, { openapi: '3.1.0' }, 'components'],
      [{ paths: { '/a': schemaAt('a.json#/Pet') }, components: { schemas: 'text' } }, { openapi: '3.0.3' }, 'components'],
      [
        { paths: { '/a': { get: { responses: { 200: { description: 'ok', schema: { $ref: 'a.json#/Pet' } } } } } }, definitions: 5 },
        { swagger: '2.0' },
        'definitions',
      ],
    ]
    for (const [rest, version, member] of cases) {
      const raw = description(rest, version)
      const b = bundle(raw, { retrievalUri: HOME, documents })
      // What was there is there, and the schema is where its reference was.
      assert.deepEqual(C(b.tree[member]), C((raw as any)[member]), member)
      assert.deepEqual(b.embedded.map((e) => e.as), ['inline'], member)
      assert.deepEqual(b.left, [], member)
    }
  })

  test('a name that a reference hopes for is kept clear of, whichever of the two is met first', async () => {
    const documents = { 'a.json': { Pet: { type: 'string' } } }
    const hopes = { $ref: '#/components/schemas/Pet' }
    const has = { $ref: 'a.json#/Pet' }
    // The second order finds the hope after the name was given, and
    // the bundle is written again.
    for (const schemas of [{ Hopes: hopes, Has: has }, { Has: has, Hopes: hopes }]) {
      const held = await agree(O, U, description({ paths: {}, components: { schemas } }), { retrievalUri: HOME, documents })
      assert.ok(held.ok, held.why.join('; '))
      const got = C(held.bundle.tree.components.schemas)
      assert.deepEqual(got.Has, { $ref: '#/components/schemas/Pet_2' })
      assert.deepEqual(got.Hopes, hopes)
      assert.deepEqual(got.Pet_2, { type: 'string' })
      assert.deepEqual(held.bundle.left, [{ at: '/components/schemas/Hopes', ref: '#/components/schemas/Pet', why: 'not-found' }])
    }
  })

  test('a place that a reference hopes for is not made', async () => {
    // The reference names the map of the schema components, and the
    // description has none. A new one would be what it names.
    const raw = description({ paths: { '/a': schemaAt('a.json#/Pet') }, 'x-hopes': { $ref: '#/components/schemas' } })
    const held = await agree(O, U, raw, { retrievalUri: HOME, documents: { 'a.json': { Pet: { type: 'string' } } }, slots: 'all' as const })
    assert.ok(held.ok, held.why.join('; '))
    assert.equal(held.bundle.tree.components, undefined)
    assert.deepEqual(held.bundle.embedded.map((e: any) => e.as), ['inline'])
    assert.deepEqual(held.bundle.left, [{ at: '/x-hopes', ref: '#/components/schemas', why: 'not-found' }])
  })

  test("a root that is a reference is written as what it names, under slots: 'all'", async () => {
    const raw = parse(JSON.stringify({ $ref: 'root.json', openapi: '3.1.0', info, paths: {} }))
    const documents = {
      'root.json': { openapi: '3.1.0', info, paths: {}, components: { schemas: { A: { $ref: 'a.json#/X' } } } },
      'a.json': { X: { type: 'string' } },
    }
    const held = await agree(O, U, raw, { retrievalUri: HOME, documents, slots: 'all' as const })
    assert.ok(held.ok, held.why.join('; '))
    assert.deepEqual(C(held.bundle.tree), { openapi: '3.1.0', info, paths: {}, components: { schemas: { A: { type: 'string' } } } })
  })

  test('many targets of one name are each given one', () => {
    const documents: Record<string, unknown> = {}
    const schemas: Record<string, unknown> = {}
    for (let i = 0; i < 2000; i++) {
      documents[`d${i}.json`] = { Same: { title: 'n' + i } }
      schemas['S' + i] = { $ref: `d${i}.json#/Same` }
    }
    const b = bundle(description({ paths: {}, components: { schemas } }), { retrievalUri: HOME, documents })
    const got = b.tree.components.schemas
    assert.equal(Object.keys(got).length, 4000)
    assert.deepEqual(C(got.S0), { $ref: '#/components/schemas/Same' })
    assert.deepEqual(C(got.S1999), { $ref: '#/components/schemas/Same_2000' })
    assert.deepEqual(C(got.Same_2000), { title: 'n1999' })
  })

  test('schemas that only mapping values name are brought in, and their steps are those of one run', () => {
    // Each names the next, so the index types one more in each of its
    // rounds, and the bundle is written once.
    const documents: Record<string, unknown> = {}
    const length = 5
    for (let i = 0; i < length; i++) {
      documents[`m${i}.json`] = { type: 'object', discriminator: { propertyName: 'k', mapping: { n: `m${i + 1}.json` } } }
    }
    documents[`m${length}.json`] = { type: 'object' }
    const raw = () => description({ paths: {}, components: { schemas: { P: { discriminator: { propertyName: 'k', mapping: { a: 'm0.json' } } } } } })
    const seen: number[] = []
    const b = bundle(raw(), { retrievalUri: HOME, documents, onCheck: (n: number) => (seen.push(n), true), checkEveryN: 1 })
    assert.deepEqual(Object.keys(b.tree.components.schemas), ['P', 'm0', 'm1', 'm2', 'm3', 'm4', 'm5'])
    const total = seen.length
    assert.deepEqual(seen, Array.from({ length: total }, (_, i) => i + 1))
    assert.throws(() => bundle(raw(), { retrievalUri: HOME, documents, maxSteps: total - 1 }), (e: any) => 'openapi_work' === e.code)
    assert.equal(bundle(raw(), { retrievalUri: HOME, documents, maxSteps: total }).embedded.length, length + 1)
  })
})

describe('the check of a bundle', () => {
  // tools/corpus/bundle-agree.cjs holds every bundle here to its
  // documents, so it has to fail the ones that are wrong. Each of these
  // is the bundle of one description, changed in one way.
  const entry = () =>
    description({
      paths: {},
      components: {
        schemas: {
          Has: { $ref: 'a.json#/Pet' },
          Hopes: { $ref: '#/components/schemas/Pet' },
          Animal: { discriminator: { propertyName: 'kind', mapping: { cat: 'a.json#/Cat' } }, oneOf: [{ $ref: 'a.json#/Cat' }] },
        },
      },
    })
  const documents = { 'a.json': { Pet: { type: 'object', title: 'A pet' }, Cat: { type: 'string' } } }
  const checked = (change: (b: any) => void) =>
    agree(
      {
        ...O,
        bundle: (raw: any, options: any) => {
          const b = bundle(raw, options)
          change(b)
          return b
        },
      },
      U,
      entry(),
      { retrievalUri: HOME, documents },
    )

  test('holds the bundle as it is', async () => {
    const held = await checked(() => undefined)
    assert.ok(held.ok, held.why.join('; '))
    assert.deepEqual(Object.keys(held.bundle.tree.components.schemas), ['Has', 'Hopes', 'Animal', 'Pet_2', 'Cat'])
    assert.equal(held.located, 1)
  })

  const wrong: [string, (b: any) => void, RegExp][] = [
    ['a string that no bundle writes again', (b) => (b.tree.info.title = './t'), /^info\/title: /],
    ['a member of a target that is gone', (b) => delete b.tree.components.schemas.Pet_2.title, /members /],
    [
      'a reference that named nothing, and names a target',
      (b) => {
        const schemas = b.tree.components.schemas
        schemas.Pet = schemas.Pet_2
        delete schemas.Pet_2
        schemas.Has.$ref = '#/components/schemas/Pet'
        b.embedded[0].at = '/components/schemas/Pet'
      },
      /named nothing, and names something in the bundle$/,
    ],
    [
      'a mapping value that lands on another schema',
      (b) => (b.tree.components.schemas.Animal.discriminator.mapping.cat = '#/components/schemas/Pet_2'),
      /lands on another place in the bundle$/,
    ],
    ['a mapping value that names nothing now', (b) => (b.tree.components.schemas.Animal.discriminator.mapping.cat = '#/components/schemas/Gone'), /was found, and is not found in the bundle$/],
    ['a reference that names nothing, with nothing said of it', (b) => (b.left.length = 0), /names nothing in the bundle, and the bundle does not say so$/],
  ]
  for (const [name, change, said] of wrong) {
    test('fails ' + name, async () => {
      const held = await checked(change)
      assert.equal(held.ok, false)
      assert.ok(held.why.some((line: string) => said.test(line)), held.why.join('; '))
    })
  }

  // A document of a later version than the description's, with a field
  // beside a reference that its own version read and the description's
  // does not. The bundle says so, and the check holds the bundle to the
  // documents without that field, and to all else of them.
  const later = () => description({ paths: { '/a': { get: { responses: { 200: { $ref: 'new.json#/components/responses/R' } } } } } }, { openapi: '3.0.3' })
  const newer = {
    'new.json': {
      openapi: '3.1.0',
      info,
      paths: {},
      components: { responses: { R: { $ref: '#/components/responses/S', description: 'mine' }, S: { description: 'theirs' } } },
    },
  }
  const versioned = (change: (b: any) => void) =>
    agree(
      {
        ...O,
        bundle: (raw: any, options: any) => {
          const b = bundle(raw, options)
          change(b)
          return b
        },
      },
      U,
      later(),
      { retrievalUri: HOME, documents: newer },
    )

  test('allows a field that the bundle says stands unread, and only that', async () => {
    const held = await versioned(() => undefined)
    assert.ok(held.ok, held.why.join('; '))
    assert.deepEqual(held.bundle.left, [{ at: '/components/responses/R/description', ref: 'mine', why: 'version' }])
    // With nothing said of it, the field is a difference.
    const silent = await versioned((b) => (b.left.length = 0))
    assert.equal(silent.ok, false)
    assert.ok(silent.why.some((line: string) => /description: "mine" \/ "theirs"$/.test(line)), silent.why.join('; '))
    // And another field of the same response is one still.
    const other = await versioned((b) => (b.tree.components.responses.S.headers = {}))
    assert.equal(other.ok, false)
    // So is the same field of the response that the reference names. The
    // bundle's tree has that response's own object where the reference
    // is, and what is allowed is the field beside the reference alone.
    const named = await versioned((b) => (b.tree.components.responses.S.description = 'wrong'))
    assert.equal(named.ok, false)
    assert.ok(named.why.some((line: string) => /description: "theirs" \/ "wrong"$/.test(line)), named.why.join('; '))
    // The documents are as they were given.
    assert.deepEqual(newer['new.json'].components.responses.R, { $ref: '#/components/responses/S', description: 'mine' })
  })

  test('checks a bundle that was written elsewhere, as it is given', async () => {
    const set = { entry: C(entry()), documents }
    const b = bundle(entry(), { retrievalUri: HOME, documents })
    const written = C({ tree: b.tree, embedded: b.embedded, left: b.left, dialects: b.dialects })
    const changed = C(written)
    changed.tree.components.schemas.Has.$ref = '#/components/schemas/Cat'
    const seen: number[] = []
    const results = await checkWritten(O, U, { retrievalUri: HOME, sets: [{ ...set, bundle: written }, { ...set, bundle: changed }] }, (n: number) => seen.push(n))
    assert.deepEqual(results.map((r: any) => r.ok), [true, false])
    assert.ok(0 < results[1].why.length)
    assert.deepEqual(seen, [1, 2])
  })
})

describe('bundleAll', () => {
  const files: Record<string, unknown> = {
    [BASE + 'a.json']: { type: 'object', properties: { b: { $ref: 'sub/b.yaml' } } },
    [BASE + 'sub/b.yaml']: 'type: object\nproperties:\n  c: { $ref: c.json }\n',
    [BASE + 'sub/c.json']: Buffer.from('{"type":"string"}'),
  }
  const entry = () => description({ paths: {}, components: { schemas: { A: { $ref: 'a.json' }, Gone: { $ref: 'gone.json' } } } })

  test('it loads what the description names, in rounds, and bundles that', async () => {
    const asked: string[] = []
    const load = (uri: string) => (asked.push(uri), files[uri])
    const b = await bundleAll(entry(), { retrievalUri: HOME, load })
    assert.deepEqual(asked, [BASE + 'a.json', BASE + 'gone.json', BASE + 'sub/b.yaml', BASE + 'sub/c.json'])
    assert.deepEqual(b.documents, [BASE + 'a.json', BASE + 'sub/b.yaml', BASE + 'sub/c.json'])
    assert.deepEqual(C(b.tree.components.schemas), {
      A: { $ref: '#/components/schemas/a' },
      Gone: { $ref: 'gone.json' },
      a: { type: 'object', properties: { b: { $ref: '#/components/schemas/b' } } },
      b: { type: 'object', properties: { c: { $ref: '#/components/schemas/c' } } },
      c: { type: 'string' },
    })
    assert.deepEqual(b.left, [{ at: '/components/schemas/Gone', ref: 'gone.json', why: 'external' }])
    // It is `bundle` with the documents given.
    const documents = { 'a.json': files[BASE + 'a.json'], 'sub/b.yaml': files[BASE + 'sub/b.yaml'], 'sub/c.json': files[BASE + 'sub/c.json'] }
    assert.equal(JSON.stringify(bundle(entry(), { retrievalUri: HOME, documents })), JSON.stringify(b))
    // And it agrees with what `resolveAll` makes of the same documents.
    const held = await agree(O, U, entry(), { retrievalUri: HOME, load: (uri: string) => files[uri] })
    assert.ok(held.ok, held.why.join('; '))
  })

  test('it loads what a schema names that only a mapping value names', async () => {
    const more: Record<string, unknown> = {
      [BASE + 'dog.yaml']: 'type: object\nproperties:\n  name: {$ref: "name.yaml"}\ndiscriminator:\n  propertyName: breed\n  mapping:\n    puppy: "sub/puppy.yaml#/Puppy"\n',
      [BASE + 'sub/puppy.yaml']: { Puppy: { allOf: [{ $ref: '../dog.yaml' }, { $ref: 'toy.yaml' }] }, Unused: { $ref: 'never.yaml' } },
      [BASE + 'sub/toy.yaml']: { type: 'string' },
      [BASE + 'name.yaml']: { type: 'string' },
      [BASE + 'never.yaml']: { never: 'asked for' },
    }
    const pets = () =>
      description({
        paths: {},
        components: { schemas: { Pet: { type: 'object', discriminator: { propertyName: 'kind', mapping: { dog: 'dog.yaml', gone: 'gone.yaml' } } } } },
      })
    const asked: string[] = []
    const b = await bundleAll(pets(), { retrievalUri: HOME, load: (uri: string) => (asked.push(uri), more[uri]) })
    assert.deepEqual(asked, [BASE + 'dog.yaml', BASE + 'gone.yaml', BASE + 'name.yaml', BASE + 'sub/puppy.yaml', BASE + 'sub/toy.yaml'])
    assert.deepEqual(C(b.tree.components.schemas), {
      Pet: { type: 'object', discriminator: { propertyName: 'kind', mapping: { dog: '#/components/schemas/dog', gone: 'gone.yaml' } } },
      dog: {
        type: 'object',
        properties: { name: { $ref: '#/components/schemas/name' } },
        discriminator: { propertyName: 'breed', mapping: { puppy: '#/components/schemas/Puppy' } },
      },
      name: { type: 'string' },
      Puppy: { allOf: [{ $ref: '#/components/schemas/dog' }, { $ref: '#/components/schemas/toy' }] },
      toy: { type: 'string' },
    })
    assert.deepEqual(
      b.embedded.map((e) => [e.at, e.doc, e.from]),
      [
        ['/components/schemas/dog', BASE + 'dog.yaml', ''],
        ['/components/schemas/name', BASE + 'name.yaml', ''],
        ['/components/schemas/Puppy', BASE + 'sub/puppy.yaml', '/Puppy'],
        ['/components/schemas/toy', BASE + 'sub/toy.yaml', ''],
      ],
    )
    assert.deepEqual(b.left, [])
    const held = await agree(O, U, pets(), { retrievalUri: HOME, load: (uri: string) => more[uri] })
    assert.ok(held.ok, held.why.join('; '))
  })

  test('a loader may be asynchronous, and what it throws is thrown', async () => {
    const b = await bundleAll(entry(), { retrievalUri: HOME, load: async (uri: string) => files[uri] })
    assert.equal(b.embedded.length, 3)
    await assert.rejects(
      bundleAll(entry(), {
        retrievalUri: HOME,
        load: async () => {
          throw new Error('no network here')
        },
      }),
      /no network here/,
    )
  })

  test('its own options are checked, and the loading is bounded as resolveAll bounds it', async () => {
    const load = (uri: string) => files[uri]
    await assert.rejects(bundleAll(entry(), { retrievalUri: HOME } as any), /^TypeError: bundleAll: load must be a function, not undefined$/)
    await assert.rejects(bundleAll(entry(), { retrievalUri: HOME, load, strict: true } as any), /^TypeError: bundleAll: no option "strict"; /)
    await assert.rejects(bundleAll(entry(), { retrievalUri: HOME, load, maxRounds: 0 }), /^TypeError: bundleAll: maxRounds must be a whole number above 0, not 0$/)
    await assert.rejects(
      bundleAll(entry(), { retrievalUri: HOME, load, maxDocuments: 2 }),
      (e: any) => e instanceof ResolveError && 'openapi_work' === e.code && e.message.startsWith('bundleAll: more than 2 documents to load'),
    )
    await assert.rejects(
      bundleAll(entry(), { retrievalUri: HOME, load, maxRounds: 2 }),
      (e: any) => e instanceof ResolveError && 'openapi_work' === e.code && e.message.startsWith('bundleAll: the documents name one another more than 2 rounds of loading deep'),
    )
    assert.equal((await bundleAll(entry(), { retrievalUri: HOME, load, maxRounds: 3, maxDocuments: 4 })).embedded.length, 3)
  })
})

describe('bundle, on sets of documents that are generated', () => {
  // A small generator of descriptions in several documents: schemas,
  // parameters, responses and Path Items that name one another across
  // the documents, by every form of reference, some of them naming
  // nothing. What it writes need not be a valid description. It has to
  // be something `resolve` reads, and the bundle of it has to resolve to
  // the same.
  const set = (seed: number) => {
    let state = seed >>> 0
    const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32
    const upto = (n: number) => Math.floor(next() * n)
    const pick = <T>(list: T[]): T => list[upto(list.length)]
    const chance = (p: number) => next() < p

    const version = pick(['2.0', '3.0', '3.1', '3.1', '3.2'])
    const names = ['openapi.json', 'a.json', 'sub/b.json', 'sub/deep/c.json'].slice(0, 2 + upto(3))
    // The entry keeps what it has where its version has it. Another
    // document is a fragment, or a description of the entry's version.
    const described = new Map(names.map((name, i) => [name, 0 === i || chance(0.4)]))
    const sections = (name: string): Record<string, string[]> =>
      described.get(name)
        ? '2.0' === version
          ? { schema: ['definitions'], parameter: ['parameters'], response: ['responses'], item: ['paths'] }
          : { schema: ['components', 'schemas'], parameter: ['components', 'parameters'], response: ['components', 'responses'], item: ['paths'] }
        : { schema: ['schemas'], parameter: ['parameters'], response: ['responses'], item: ['items'] }
    const COUNT = 3
    const ids = '3.1' === version || '3.2' === version

    const uriOf = (name: string) => BASE + name
    const ref = (from: string, kind: string, deeper = false): string => {
      if (chance(0.06)) return pick(['missing.json#/x', '#/nowhere', 'a.json#/schemas/None', '#nope'])
      const to = chance(0.45) ? from : pick(names)
      let path = [...sections(to)[kind], ('item' === kind ? '/i' : kind[0].toUpperCase()) + upto(COUNT)]
      if (deeper && 'schema' === kind && chance(0.2)) path = [...path, 'properties', 'p']
      const fragment = '#' + U.pointer(path)
      if (to === from && chance(0.8)) return fragment
      return (chance(0.2) ? uriOf(to) : U.relativeTo(uriOf(from), uriOf(to))) + fragment
    }

    const schema = (from: string, depth: number): any => {
      if (0 < depth && chance(0.55)) return chance(0.25) ? { $ref: ref(from, 'schema', true), description: 'beside' } : { $ref: ref(from, 'schema', true) }
      const out: any = { type: 'object' }
      if (depth < 2) {
        out.properties = { p: schema(from, depth + 1) }
        if (chance(0.5)) out.properties.q = schema(from, depth + 1)
        if (chance(0.2)) out.allOf = [schema(from, depth + 1)]
        if ('2.0' !== version && chance(0.15)) {
          const mapping = { one: ref(from, 'schema'), two: 'S' + upto(COUNT) }
          out.discriminator = { propertyName: 'kind', mapping }
        }
      }
      if (ids && chance(0.1)) out.$anchor = 'an' + upto(4)
      if (chance(0.1)) out.externalDocs = { url: pick(['docs.html', '../up.html', 'https://docs.example.com/x']) }
      return out
    }
    const body = (from: string) =>
      '2.0' === version ? { schema: schema(from, 1) } : { content: { 'application/json': { schema: schema(from, 1) } } }
    const parameter = (from: string, i: number) =>
      '2.0' === version ? { name: 'p' + i, in: 'query', type: 'string' } : { name: 'p' + i, in: 'query', schema: schema(from, 1) }
    const response = (from: string) => ({ description: 'ok', ...body(from) })
    const item = (from: string, top: boolean): any => {
      if (!top && chance(0.3)) return chance(0.3) ? { $ref: ref(from, 'item'), summary: 'mine' } : { $ref: ref(from, 'item') }
      const op: any = {
        parameters: [chance(0.5) ? { $ref: ref(from, 'parameter') } : parameter(from, 9)],
        responses: { 200: chance(0.5) ? { $ref: ref(from, 'response') } : response(from) },
      }
      if ('2.0' !== version && chance(0.15)) op.servers = [{ url: pick(['v2', '/root', 'https://api.example.com']) }]
      if ('2.0' !== version && chance(0.2)) {
        op.callbacks = { back: { '{$request.body#/url}': chance(0.6) ? { $ref: ref(from, 'item') } : { post: { responses: {} } } } }
      }
      return { get: op }
    }

    const docs: Record<string, any> = {}
    for (const name of names) {
      const doc: any = described.get(name) ? ('2.0' === version ? { swagger: '2.0', info } : { openapi: version + '.0', info }) : {}
      const at = (path: string[]) => {
        let node = doc
        for (const seg of path) node = node[seg] ??= {}
        return node
      }
      const s = sections(name)
      for (let i = 0; i < COUNT; i++) {
        at(s.schema)['S' + i] = schema(name, 0)
        at(s.parameter)['P' + i] = parameter(name, i)
        at(s.response)['R' + i] = response(name)
        at(s.item)['/i' + i] = item(name, false)
      }
      docs[name] = doc
    }
    const entry = docs['openapi.json']
    entry.paths['/top'] = item('openapi.json', true)
    const documents: Record<string, unknown> = {}
    for (const name of names.slice(1)) documents[name] = docs[name]
    return { entry, documents }
  }

  test('the bundle resolves to what the documents resolve to, and bundled again is itself', async () => {
    for (let seed = 1; seed <= 300; seed++) {
      const { entry, documents } = set(seed)
      const raw = parse(JSON.stringify(entry))
      const options = { retrievalUri: HOME, documents }
      const held = await agree(O, U, raw, options)
      assert.ok(held.ok, `seed ${seed}: ${held.why.slice(0, 3).join('; ')}`)
      const again = bundle(held.bundle.tree, { retrievalUri: HOME })
      assert.equal(JSON.stringify(again.tree), JSON.stringify(held.bundle.tree), 'seed ' + seed)
      assert.deepEqual(again.embedded, [], 'seed ' + seed)
    }
  })

  // A mapping value says that what it names is a schema, and the index
  // types it as one. So `resolve` and the bundle read such a schema
  // alike, where nothing else but a reference in data names it. These
  // sets have mapping values, and references in an extension.
  test("and under slots: 'all', where a reference in data is one", async () => {
    for (let seed = 301; seed <= 400; seed++) {
      const { entry, documents } = set(seed)
      entry['x-data'] = { one: { $ref: 'a.json#/schemas/S0' }, two: { $ref: 'a.json#/schemas/S0' }, three: { $ref: '#/x-data/one' } }
      const raw = parse(JSON.stringify(entry))
      const held = await agree(O, U, raw, { retrievalUri: HOME, documents, slots: 'all' as const })
      assert.ok(held.ok, `seed ${seed}: ${held.why.slice(0, 3).join('; ')}`)
    }
  })
})

// Hold `count` sets of a generator to the check: the bundle of each
// resolves to what the documents resolve to, with what it could not keep
// in its reports, and is its own bundle unless it lists a part whose
// type it could not keep.
const held = async (next: () => { entry: any; documents: Record<string, any> }, seed: number, count: number, more: object) => {
  for (let i = 0; i < count; i++) {
    const { entry, documents } = next()
    const options = { retrievalUri: HOME, documents, ...more }
    let got
    try {
      got = await agree(O, U, parse(JSON.stringify(entry)), options)
    } catch (e: any) {
      // A set may be past a bound, and is then refused with its code.
      assert.ok(e instanceof ResolveError && ['openapi_depth', 'openapi_work'].includes(e.code as string), `seed ${seed}, set ${i}: ${e}`)
      continue
    }
    assert.ok(got.ok, `seed ${seed}, set ${i}: ${got.why.slice(0, 3).join('; ')}`)
    if (got.bundle.left.some((l: any) => 'type' === l.why)) continue
    const again = bundle(got.bundle.tree, { retrievalUri: HOME, ...more })
    assert.equal(JSON.stringify(again.tree), JSON.stringify(got.bundle.tree), `seed ${seed}, set ${i}`)
    assert.deepEqual(again.embedded, [], `seed ${seed}, set ${i}`)
  }
}

describe('bundle, on sets that a review of it generated', () => {
  // The generator an independent review of `bundle` wrote to break it.
  // Its sets are worse than a description is: a schema named where a
  // Path Item is and a Path Item where a schema is, two schemas with one
  // identifier, references to references that name nothing, pointers
  // that are read on through references, a mapping value of every kind,
  // and whole documents named as schemas. A bundle of one still has to
  // resolve to what the documents resolve to, with what it could not
  // keep in its reports, and to be its own bundle unless it lists a part
  // whose type it could not keep.
  const DOCS = ['a.json', 'sub/b.json', 'c.json']
  const NAMES = ['X', 'Y', 'Z', 'pet', 'A']
  const sets = (seed: number) => {
    let state = seed
    const rnd = () => {
      state |= 0
      state = (state + 0x6d2b79f5) | 0
      let t = Math.imul(state ^ (state >>> 15), 1 | state)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const pick = <T>(list: T[]): T => list[Math.floor(rnd() * list.length)]
    const ref = (from: string): string => {
      const d = pick([...DOCS, 'openapi.json', ''])
      const n = pick(NAMES)
      let doc = d
      if (from.startsWith('sub/') && '' !== d && 'openapi.json' !== d) doc = d.startsWith('sub/') ? d.slice(4) : '../' + d
      if (from.startsWith('sub/') && 'openapi.json' === d) doc = '../openapi.json'
      const inner =
        'openapi.json' === d || '' === d
          ? pick(['#/components/schemas/' + n, '#/paths/~1p/get', '#/x-d/' + n])
          : pick(['#/' + n, '#/' + n + '/properties/q', ''])
      return doc + inner
    }
    const schema = (from: string, depth: number): any => {
      if (rnd() < 0.35 || 2 < depth) return { $ref: ref(from) }
      const s: any = { type: 'object', properties: { q: schema(from, depth + 1) } }
      if (rnd() < 0.2) s.properties.r = { $ref: ref(from) }
      if (rnd() < 0.1) s.$id = pick(['https://e.org/' + pick(NAMES), pick(NAMES) + '.s'])
      if (rnd() < 0.1) s.$anchor = pick(NAMES)
      if (rnd() < 0.1) s.discriminator = { propertyName: 'k', mapping: { m: ref(from) } }
      return s
    }
    const pathItem = (from: string): any => {
      const p: any = { get: { responses: { 200: { description: 'x', content: { 'a/b': { schema: schema(from, 0) } } } } } }
      if (rnd() < 0.3) {
        const named =
          rnd() < 0.5
            ? { $ref: 'openapi.json' === from ? '#/paths/~1p' : pick(DOCS.map(() => '#/' + pick(NAMES))) }
            : { $ref: ref(from).split('#')[0] + '#/' + pick(NAMES), summary: 's' }
        p.post = { callbacks: { cb: { '{$url}': named } }, responses: { 200: { description: 'y' } } }
      }
      return p
    }
    return () => {
      const version = pick(['3.0.3', '3.1.0'])
      const entry: any = {
        openapi: version,
        info,
        paths: {
          '/p': pathItem('openapi.json'),
          '/q': { $ref: ref('openapi.json').split('#')[0] + '#/' + pick(NAMES), ...(rnd() < 0.3 ? { summary: 'o' } : {}) },
        },
        components: { schemas: {} },
        'x-d': {},
      }
      for (const n of NAMES.slice(0, 3)) if (rnd() < 0.5) entry.components.schemas[n] = schema('openapi.json', 0)
      const documents: Record<string, any> = {}
      for (const d of DOCS) {
        const doc: any = {}
        for (const n of NAMES) doc[n] = rnd() < 0.6 ? schema(d, 0) : pathItem(d)
        documents[d] = doc
      }
      return { entry, documents }
    }
  }

  test('the bundle resolves to what the documents resolve to', async () => {
    await held(sets(1), 1, 600, {})
  })

  test("and under slots: 'all'", async () => {
    await held(sets(2), 2, 300, { slots: 'all' })
  })
})

describe('bundle, on sets with what the generators before never wrote', () => {
  // The review's generator, with three things more. A reference may land
  // on a value that the model reads as plain JSON, a schema's `default`
  // or `example`, and such a value may hold what reads as a reference or
  // as a schema. One document of the set is a description itself, of
  // 3.0 or 3.1 whatever the entry is, so that a schema resource of 3.1
  // comes into a description of 3.0, which has none. And a reference may
  // be where the model puts an operation or a response, where only
  // `slots: 'all'` reads the first.
  //
  // The first run of it found what the sets before could not: a schema
  // resource written into a 3.0 description as one, a reference that
  // landed on plain JSON written among the schemas, a part that a
  // reference had typed left where no reference types it, and under
  // `slots: 'all'` content with no type written where it gained one.
  const DOCS = ['a.json', 'sub/b.json', 'c.json', 'd.json']
  const NAMES = ['X', 'Y', 'Z', 'pet', 'A']
  const TAILS = ['', '', '/properties/q', '/default', '/example', '/properties/q/default', '/default/k', '/example/k']
  const sets = (seed: number) => {
    let state = seed
    const rnd = () => {
      state |= 0
      state = (state + 0x6d2b79f5) | 0
      let t = Math.imul(state ^ (state >>> 15), 1 | state)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const pick = <T>(list: T[]): T => list[Math.floor(rnd() * list.length)]
    const ref = (from: string): string => {
      const d = pick([...DOCS, 'openapi.json', ''])
      const n = pick(NAMES)
      let doc = d
      if (from.startsWith('sub/') && '' !== d && 'openapi.json' !== d) doc = d.startsWith('sub/') ? d.slice(4) : '../' + d
      if (from.startsWith('sub/') && 'openapi.json' === d) doc = '../openapi.json'
      const described = 'openapi.json' === d || 'd.json' === d || ('' === d && ('openapi.json' === from || 'd.json' === from))
      const inner = described
        ? pick(['#/components/schemas/' + n + pick(TAILS), '#/components/schemas/' + n, '#/paths/~1p/get', '#/x-d/' + n])
        : pick(['#/' + n + pick(TAILS), '#/' + n, ''])
      return doc + inner
    }
    const plain = (from: string, depth: number): any =>
      pick([
        { $ref: ref(from), note: 1 },
        { k: { $ref: ref(from) } },
        { k: schema(from, depth + 2) },
        { note: 'n', discriminator: { propertyName: 'k', mapping: { m: ref(from) } } },
      ])
    const schema = (from: string, depth: number): any => {
      if (rnd() < 0.35 || 2 < depth) return { $ref: ref(from) }
      const s: any = { type: 'object', properties: { q: schema(from, depth + 1) } }
      if (rnd() < 0.2) s.properties.r = { $ref: ref(from) }
      if (rnd() < 0.1) s.$id = pick(['https://e.org/' + pick(NAMES), pick(NAMES) + '.s'])
      if (rnd() < 0.1) s.$anchor = pick(NAMES)
      if (rnd() < 0.1) s.discriminator = { propertyName: 'k', mapping: { m: ref(from) } }
      if (rnd() < 0.2) s.default = plain(from, depth)
      if (rnd() < 0.15) s.example = plain(from, depth)
      return s
    }
    const pathItem = (from: string): any => {
      const answer = () => (rnd() < 0.15 ? { $ref: ref(from) } : { description: 'x', content: { 'a/b': { schema: schema(from, 0) } } })
      const p: any = { get: rnd() < 0.15 ? { $ref: ref(from).split('#')[0] + '#/' + pick(NAMES) } : { responses: { 200: answer() } } }
      if (rnd() < 0.3) {
        const named =
          rnd() < 0.5
            ? { $ref: 'openapi.json' === from ? '#/paths/~1p' : pick(DOCS.map(() => '#/' + pick(NAMES))) }
            : { $ref: ref(from).split('#')[0] + '#/' + pick(NAMES), summary: 's' }
        p.post = { callbacks: { cb: { '{$url}': named } }, responses: { 200: { description: 'y' } } }
      }
      return p
    }
    return () => {
      const version = pick(['3.0.3', '3.1.0'])
      const entry: any = {
        openapi: version,
        info,
        paths: {
          '/p': pathItem('openapi.json'),
          '/q': { $ref: ref('openapi.json').split('#')[0] + '#/' + pick(NAMES), ...(rnd() < 0.3 ? { summary: 'o' } : {}) },
        },
        components: { schemas: {} },
        'x-d': rnd() < 0.3 ? { $ref: ref('openapi.json') } : {},
      }
      for (const n of NAMES.slice(0, 3)) if (rnd() < 0.5) entry.components.schemas[n] = schema('openapi.json', 0)
      const documents: Record<string, any> = {}
      for (const d of DOCS) {
        if ('d.json' === d) {
          const doc: any = { openapi: pick(['3.0.3', '3.1.0']), info: { title: 'd', version: '1' }, paths: { '/p': pathItem(d) }, components: { schemas: {} } }
          for (const n of NAMES) if (rnd() < 0.7) doc.components.schemas[n] = schema(d, 0)
          documents[d] = doc
          continue
        }
        const doc: any = {}
        for (const n of NAMES) doc[n] = rnd() < 0.6 ? schema(d, 0) : pathItem(d)
        documents[d] = doc
      }
      return { entry, documents }
    }
  }

  test('the bundle resolves to what the documents resolve to', async () => {
    await held(sets(1), 1, 600, {})
  })

  test("and under slots: 'all'", async () => {
    await held(sets(2), 2, 400, { slots: 'all' })
  })
})
