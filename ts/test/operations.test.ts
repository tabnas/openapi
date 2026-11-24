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
