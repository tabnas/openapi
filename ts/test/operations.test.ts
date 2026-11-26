/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// The operation view, for what a row of test/resolve/operations.tsv
// cannot say: the option itself, the values a view holds under each
// shape of the tree, the walk's bounds, and that the walk agrees with
// the `connections` report's own walk of the routes.

import { describe, test } from 'node:test'
import assert from 'node:assert'
import { join } from 'node:path'

import { parse, resolve, ResolveError } from '../dist/openapi'
import { MODEL_VERSIONS, slot } from '../dist/model'
import { operationsOf } from '../dist/operations'
import { buildIndex } from '../dist/site-index'
import type { IndexConfig } from '../dist/site-index'

const { generate } = require(join(__dirname, '..', '..', 'tools', 'apidef-preset', 'generate.cjs'))

const ok = { 200: { description: 'ok' } }

// A value as JSON has it: a map of a tree has no prototype.
const C = (x: unknown) => JSON.parse(JSON.stringify(x))

const description = (rest: object) => parse(JSON.stringify({ openapi: '3.1.0', info: { title: 't', version: '1' }, ...rest }))

const shared = () =>
  description({
    servers: [{ url: 'https://example.com' }],
    security: [{ key: [] }],
    paths: {
      '/a': { $ref: '#/components/pathItems/Shared' },
      '/b': { $ref: '#/components/pathItems/Shared' },
    },
    components: {
      pathItems: {
        Shared: {
          parameters: [{ $ref: '#/components/parameters/P' }],
          get: { parameters: [{ $ref: '#/components/parameters/Q' }, { name: 'own', in: 'query' }], responses: ok },
        },
      },
      parameters: { P: { name: 'p', in: 'query' }, Q: { name: 'q', in: 'query' } },
      securitySchemes: { key: { type: 'http', scheme: 'basic' } },
    },
  })

describe('operations', () => {
  test('the view is given when it is asked for, and the ignored report always', () => {
    const raw = shared()
    const plain = resolve(raw)
    assert.equal(plain.operations, undefined)
    assert.ok(!('operations' in plain))
    assert.deepStrictEqual(plain.ignored, [])
    assert.equal(resolve(raw, { operations: false }).operations, undefined)
    assert.equal(resolve(raw, { operations: true }).operations!.length, 2)
    for (const bad of [1, 'yes', null, {}]) {
      assert.throws(() => resolve(raw, { operations: bad as any }), /operations must be true or false/)
    }
  })

  test('asking for the view changes nothing else of the result', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const raw = parse(JSON.stringify(generate(seed)))
      const { operations, ...withView } = resolve(raw, { operations: true })
      assert.ok(Array.isArray(operations))
      assert.deepStrictEqual(withView, resolve(raw), 'seed ' + seed)
    }
  })

  test('the raw tree is not changed', () => {
    const raw = shared()
    const before = JSON.stringify(raw)
    resolve(raw, { operations: true })
    assert.equal(JSON.stringify(raw), before)
  })

  test('a value is the object the resolved tree has at its place', () => {
    const out = resolve(shared(), { operations: true })
    const [a, b] = out.operations!
    assert.equal(a.at, '/paths/~1a/get')
    assert.strictEqual(a.operation, out.tree.paths['/a'].get)
    assert.strictEqual(a.parameters[0].parameter, out.tree.paths['/a'].parameters[0])
    assert.strictEqual(a.parameters[1].parameter, out.tree.paths['/a'].get.parameters[0])
    assert.strictEqual(a.servers!.value, out.tree.servers)
    assert.strictEqual(a.security.value, out.tree.security)
    // Under `sharing: 'share'` the two paths hold one Path Item, and the
    // parameter is the component itself.
    assert.strictEqual(a.operation, b.operation)
    assert.strictEqual(a.parameters[0].parameter, out.tree.components.parameters.P)
    assert.deepStrictEqual(
      a.parameters.map((p) => [p.name, p.in, p.from, p.at]),
      [
        ['p', 'query', 'pathItem', '/paths/~1a/parameters/0'],
        ['q', 'query', 'operation', '/paths/~1a/get/parameters/0'],
        ['own', 'query', 'operation', '/paths/~1a/get/parameters/1'],
      ],
    )
  })

  test("under sharing: 'site' and 'copy' a value is the site's own", () => {
    for (const options of [{ sharing: 'site' as const }, { sharing: 'copy' as const, budget: 1e6 }]) {
      const out = resolve(shared(), { operations: true, ...options })
      const [a, b] = out.operations!
      assert.strictEqual(a.operation, out.tree.paths['/a'].get)
      assert.strictEqual(b.operation, out.tree.paths['/b'].get)
      assert.strictEqual(a.parameters[0].parameter, out.tree.paths['/a'].parameters[0])
      assert.notStrictEqual(a.parameters[0].parameter, out.tree.components.parameters.P)
      assert.deepStrictEqual(C(a.parameters[0].parameter), { name: 'p', in: 'query' })
    }
  })

  test("under sharing: 'inline-once' the view says what applies, and gives the values the tree holds", () => {
    const out = resolve(shared(), { operations: true, sharing: 'inline-once' })
    const [a, b] = out.operations!
    // The first path holds the Path Item, and the second its reference
    // as written, so the tree has no operation at the second's route.
    assert.deepStrictEqual(C(out.tree.paths['/b']), { $ref: '#/components/pathItems/Shared' })
    assert.strictEqual(a.operation, out.tree.paths['/a'].get)
    assert.strictEqual(b.operation, undefined)
    assert.deepStrictEqual(b.parameters.map((p) => p.name), ['p', 'q', 'own'])
    assert.deepStrictEqual(b.parameters.map((p) => p.parameter), [undefined, undefined, undefined])
    assert.strictEqual(b.servers!.value, out.tree.servers)
  })

  test("under cycles: 'keep' a callback that comes back to its own Path Item ends there", () => {
    const raw = description({
      paths: { '/a': { $ref: '#/components/pathItems/Loop' } },
      components: {
        pathItems: { Loop: { post: { responses: ok, callbacks: { again: { '{$url}': { $ref: '#/components/pathItems/Loop' } } } } } },
      },
    })
    const out = resolve(raw, { operations: true, cycles: 'keep' })
    assert.equal(out.operations!.length, 1)
    assert.strictEqual(out.operations![0].operation, out.tree.paths['/a'].post)
    // The tree is a graph there: the callback holds the Path Item itself.
    assert.strictEqual(out.tree.paths['/a'].post.callbacks.again['{$url}'], out.tree.paths['/a'])
  })

  test('the one server the specification gives is a new value each time', () => {
    const out = resolve(description({ paths: { '/a': { get: { responses: ok }, put: { responses: ok } } } }), { operations: true })
    const [get, put] = out.operations!
    assert.deepStrictEqual(get.servers, { from: 'default', at: null, value: [{ url: '/' }] })
    assert.notStrictEqual(get.servers!.value, put.servers!.value)
    assert.deepStrictEqual(get.security, { from: 'none', at: null, value: [] })
  })

  test('a root that is no map has no operations', () => {
    for (const raw of [[], [{ paths: {} }]]) {
      const out = resolve(raw, { operations: true })
      assert.deepStrictEqual(out.operations, [])
      assert.deepStrictEqual(out.ignored, [])
    }
  })

  test('the states the walk names are in the model of every version', () => {
    // operations.ts steps from these by name.
    for (const v of MODEL_VERSIONS) {
      for (const [state, type] of [['root', 'root'], ['paths', 'paths'], ['pathItem', 'pathItem'], ['operation', 'operation'], ['parameter', 'parameter'], ['responses', 'responses']]) {
        assert.equal(slot(v, state).type, type, `${v} ${state}`)
        assert.equal(slot(v, state).kind, 'object', `${v} ${state}`)
      }
      if ('2.0' === v) continue
      for (const state of ['callback', 'mediaType', 'encoding']) assert.equal(slot(v, state).type, state, `${v} ${state}`)
    }
  })

  test('the walk reaches the operations the connections report counts routes to', () => {
    // An operationId on more than one route is an `operationIdReuse` row,
    // from the report's own walk. The view groups to the same routes.
    for (let seed = 1; seed <= 60; seed++) {
      const raw = parse(JSON.stringify(generate(seed)))
      for (const options of [{}, { compat: 'apidef' as const }, { slots: 'all' as const }]) {
        const out = resolve(raw, { operations: true, ...options })
        const byId = new Map<string, string[]>()
        for (const op of out.operations!) {
          if (undefined === op.operationId) continue
          byId.set(op.operationId, [...(byId.get(op.operationId) ?? []), op.at])
        }
        const want = out.connections.filter((c) => 'operationIdReuse' === c.kind).map((c) => [c.name, c.routes])
        const have = [...byId].filter(([, routes]) => 1 < routes.length)
        assert.deepStrictEqual(have, want, `seed ${seed} ${JSON.stringify(options)}`)
      }
    }
  })
})

describe('operations, references that the view reads through', () => {
  test('a reference that was not followed is no declaration, whatever is written beside it', () => {
    // A Reference Object's other members are not the parameter it names.
    const raw = parse(
      JSON.stringify({
        openapi: '3.0.3',
        info: { title: 't', version: '1' },
        paths: { '/a/{id}': { get: { parameters: [{ $ref: 'other.json#/p', name: 'id', in: 'path' }], responses: ok } } },
      }),
    )
    const out = resolve(raw, { operations: true, retrievalUri: 'https://example.com/api/openapi.json' })
    assert.equal(out.operations![0].partial, true)
    assert.deepStrictEqual(out.operations![0].parameters, [])
    assert.deepStrictEqual(C(out.connections.filter((c) => 'pathParameter' === c.kind)), [
      { kind: 'pathParameter', at: '/paths/~1a~1{id}/get', name: 'id', found: false, target: null, why: 'unresolved' },
    ])
  })

  test('an operation that no route reaches has what its Path Item names, as a routed one has', () => {
    const raw = description({
      paths: {
        '/a': {
          get: {
            responses: {
              200: { description: 'ok', links: { next: { operationRef: '#/components/pathItems/Spare/get', parameters: { q: 1, own: 1, none: 1 } } } },
            },
          },
        },
      },
      components: {
        pathItems: {
          Base: { parameters: [{ name: 'q', in: 'query' }] },
          Spare: { $ref: '#/components/pathItems/Base', get: { parameters: [{ name: 'own', in: 'query' }], responses: ok } },
        },
      },
    })
    const rows = resolve(raw).connections.filter((c) => 'linkParameter' === c.kind)
    assert.deepStrictEqual(
      rows.map((c) => [c.name, c.found, c.target]),
      [
        ['q', true, '/components/pathItems/Spare/parameters/0'],
        ['own', true, '/components/pathItems/Spare/get/parameters/0'],
        ['none', false, null],
      ],
    )
  })

  test('an operation is read by the version of the document it is in', () => {
    const info = { title: 't', version: '1' }
    const HOME = 'https://example.com/api/openapi.json'
    // A 2.0 operation under a 3.1 description: 2.0 has no rule to ignore
    // a header, and has consumes where 3.1 has servers.
    const old = {
      swagger: '2.0',
      info,
      paths: { '/a': { get: { consumes: ['text/plain'], parameters: [{ name: 'Authorization', in: 'header', type: 'string' }], responses: ok } } },
    }
    const newer = resolve(description({ paths: { '/a': { $ref: 'old.json#/paths/~1a' } } }), {
      operations: true,
      retrievalUri: HOME,
      documents: { 'old.json': old },
    })
    assert.deepStrictEqual(newer.ignored, [])
    const [op] = newer.operations!
    assert.deepStrictEqual(op.parameters.map((p) => p.name), ['Authorization'])
    assert.equal(op.servers, undefined)
    assert.deepStrictEqual([op.consumes!.from, op.consumes!.at], ['operation', '/paths/~1a/get/consumes'])
    assert.equal(op.produces!.from, 'none')

    // And a 3.1 operation under a 2.0 description: its header is ignored,
    // its response's is listed, and its callback is an operation.
    const modern = {
      openapi: '3.1.0',
      info,
      paths: {
        '/a': {
          get: {
            parameters: [{ name: 'Authorization', in: 'header' }],
            responses: { 200: { description: 'ok', headers: { 'Content-Type': {} } } },
            callbacks: { done: { '{$url}': { post: { responses: ok } } } },
          },
        },
      },
    }
    const older = resolve(parse(JSON.stringify({ swagger: '2.0', info, paths: { '/a': { $ref: 'new.json#/paths/~1a' } } })), {
      operations: true,
      retrievalUri: HOME,
      documents: { 'new.json': modern },
    })
    assert.deepStrictEqual(
      older.ignored.map((i) => [i.what, i.name]),
      [
        ['parameter', 'Authorization'],
        ['responseHeader', 'Content-Type'],
      ],
    )
    assert.deepStrictEqual(
      older.operations!.map((o) => [o.at, o.kind, o.parameters.length, o.servers!.from, o.consumes]),
      [
        ['/paths/~1a/get', 'path', 0, 'default', undefined],
        ['/paths/~1a/get/callbacks/done/{$url}/post', 'callback', 0, 'default', undefined],
      ],
    )
  })

  test('encodings are read as deep as they nest, and one that comes back to itself is refused', () => {
    let enc: any = { headers: { 'Content-Type': {} } }
    for (let i = 0; i < 200; i++) enc = { itemEncoding: enc }
    const deep = parse(
      JSON.stringify({
        openapi: '3.2.0',
        info: { title: 't', version: '1' },
        paths: { '/a': { post: { requestBody: { content: { 'multipart/mixed': { itemEncoding: enc } } }, responses: ok } } },
      }),
    )
    const found = resolve(deep).ignored
    assert.equal(found.length, 1)
    assert.equal(found[0].what, 'encodingHeader')
    assert.ok(found[0].at.endsWith('/itemEncoding/headers/Content-Type'))

    // Under `slots: 'all'` a reference in data is followed, and one may
    // lead an encoding back to itself.
    const at = '/paths/~1a/post/requestBody/content/multipart~1mixed/itemEncoding'
    const loop = parse(
      JSON.stringify({
        openapi: '3.2.0',
        info: { title: 't', version: '1' },
        paths: { '/a': { post: { requestBody: { content: { 'multipart/mixed': { itemEncoding: { itemEncoding: { $ref: '#' + at } } } } }, responses: ok } } },
      }),
    )
    assert.deepStrictEqual(resolve(loop).ignored, [])
    assert.throws(
      () => resolve(loop, { slots: 'all', maxDepth: 40 }),
      (e: any) => e instanceof ResolveError && 'openapi_depth' === e.code && /^resolve: encodings nested deeper than 40 at /.test(e.message),
    )
  })
})

describe('operations, the bounds of the walk', () => {
  // Callbacks that branch to one shared Path Item double the routes at
  // every level.
  const doubling = (levels: number) => {
    const pathItems: Record<string, unknown> = {}
    for (let i = 0; i < levels; i++) {
      const next = { $ref: '#/components/pathItems/L' + (i + 1) }
      pathItems['L' + i] = {
        post: { responses: {}, callbacks: i + 1 < levels ? { a: { '{$url}': next }, b: { '{$url}': next } } : {} },
      }
    }
    return { openapi: '3.1.0', paths: { '/start': { $ref: '#/components/pathItems/L0' } }, components: { pathItems } }
  }

  const config = (over: Partial<IndexConfig> = {}): IndexConfig => ({
    mv: '3.1',
    entry: 'https://example.com/doc',
    retrieved: 'https://example.com/doc',
    rootDialect: 'https://spec.openapis.org/oas/3.1/dialect/base',
    slots: 'spec',
    extensions: new Set(),
    pointers: false,
    maxDepth: 1000,
    refuse: (code, message, at) => {
      throw new ResolveError(code, message, at)
    },
    ...over,
  })

  const walk = (raw: any, over: { maxDepth?: number; tick?: () => void } = {}) => {
    const cfg = config()
    return operationsOf(raw, '3.1', buildIndex(raw, cfg), {
      merge: false,
      maxDepth: over.maxDepth ?? 1000,
      declared: new Map(),
      refuse: cfg.refuse,
      tick: over.tick,
    })
  }

  test('every route is walked, and each visit is a step of the count', () => {
    let steps = 0
    const found = walk(doubling(10), { tick: () => void steps++ })
    assert.equal(found.operations.length, 1023)
    assert.ok(1023 < steps, steps + ' steps')
  })

  test('the walk is held to the allowance of the index', () => {
    assert.throws(
      () => walk(doubling(30)),
      (e: any) =>
        e instanceof ResolveError &&
        'openapi_work' === e.code &&
        /reading the operations of this document takes more than 16 times the work of reading it once/.test(e.message) &&
        e.at.startsWith('/paths/~1start/post/callbacks/'),
    )
  })

  test('each reference followed is a visit, so a chain that many values lead into is counted', () => {
    // A chain of references, and a list of parameters that each lead
    // into its start: the hops are the list's length times the chain's.
    const chain = (length: number, entries: number) => {
      const parameters: Record<string, unknown> = {}
      for (let i = 0; i < length; i++) {
        parameters['A' + i] = i + 1 < length ? { $ref: '#/components/parameters/A' + (i + 1) } : { name: 'q', in: 'query' }
      }
      const list = Array.from({ length: entries }, () => ({ $ref: '#/components/parameters/A0' }))
      return { openapi: '3.1.0', paths: { '/a': { get: { parameters: list, responses: {} } } }, components: { parameters } }
    }
    let steps = 0
    const found = walk(chain(20, 30), { tick: () => void steps++ })
    assert.equal(found.operations[0].parameters.length, 30)
    assert.ok(20 * 30 <= steps, steps + ' steps')
    // Through `resolve`, with no option given, the allowance holds it.
    assert.throws(
      () => resolve(parse(JSON.stringify(chain(900, 6000)))),
      (e: any) =>
        e instanceof ResolveError &&
        'openapi_work' === e.code &&
        /reading the operations of this document takes more than 16 times the work of reading it once/.test(e.message),
    )
  })

  test('callbacks nested deeper than maxDepth are refused', () => {
    // One callback each, so the routes are as many as the levels.
    const chain = (levels: number) => {
      const pathItems: Record<string, unknown> = {}
      for (let i = 0; i < levels; i++) {
        pathItems['L' + i] = {
          post: { responses: {}, callbacks: i + 1 < levels ? { a: { '{$url}': { $ref: '#/components/pathItems/L' + (i + 1) } } } : {} },
        }
      }
      return { openapi: '3.1.0', paths: { '/start': { $ref: '#/components/pathItems/L0' } }, components: { pathItems } }
    }
    assert.equal(walk(chain(8), { maxDepth: 8 }).operations.length, 8)
    assert.throws(
      () => walk(chain(9), { maxDepth: 8 }),
      (e: any) => 'openapi_depth' === e.code && /callbacks nested deeper than 8/.test(e.message),
    )
    // Through `resolve` the fold meets the same nesting first, and names
    // it the same.
    assert.throws(() => resolve(chain(40), { maxDepth: 20 }), (e: any) => 'openapi_depth' === e.code)
  })
})
