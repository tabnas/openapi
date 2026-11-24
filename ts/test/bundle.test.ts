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
const { agree } = require(join(ROOT, 'tools', 'corpus', 'bundle-agree.cjs'))
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

  test('targets written one inside another deeper than maxDepth are refused', () => {
    const fits = doubling(8, 1)
    assert.equal(bundle(fits.raw, { retrievalUri: HOME, documents: fits.documents, maxDepth: 8 }).embedded.length, 8)
    const { raw, documents } = doubling(9, 1)
    assert.throws(
      () => bundle(raw, { retrievalUri: HOME, documents, maxDepth: 8 }),
      (e: any) => e instanceof ResolveError && 'openapi_depth' === e.code && /^bundle: targets written one inside another deeper than 8 at /.test(e.message),
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
  const set = (seed: number, mappings = true) => {
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
          if (mappings) out.discriminator = { propertyName: 'kind', mapping }
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

  // A mapping value says that what it names is a schema, and the bundle
  // reads it as one. Where nothing else says so, `resolve` reads the
  // same content as data when a reference in data names it too, so the
  // two differ there, and these sets have no mapping values.
  test("and under slots: 'all', where a reference in data is one", async () => {
    for (let seed = 301; seed <= 400; seed++) {
      const { entry, documents } = set(seed, false)
      entry['x-data'] = { one: { $ref: 'a.json#/schemas/S0' }, two: { $ref: 'a.json#/schemas/S0' }, three: { $ref: '#/x-data/one' } }
      const raw = parse(JSON.stringify(entry))
      const held = await agree(O, U, raw, { retrievalUri: HOME, documents, slots: 'all' as const })
      assert.ok(held.ok, `seed ${seed}: ${held.why.slice(0, 3).join('; ')}`)
    }
  })
})
