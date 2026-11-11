/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// The resolver's surface: what the fixtures in test/resolve cannot show,
// object identity, provenance and positions, the report's counts, and the
// error a strict resolve raises.

import { describe, test } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { recordPositions } from '@tabnas/expr'

import { make, parse, resolve, ResolveError } from '..'

const C = (x: any) => JSON.parse(JSON.stringify(x))
const PETSTORE = join(__dirname, '..', '..', 'test', 'petstore')

describe('resolve', () => {
  test('never changes the raw tree', () => {
    const raw = parse(readFileSync(join(PETSTORE, 'petstore.yaml'), 'utf8'))
    const before = JSON.stringify(raw)
    resolve(raw)
    assert.equal(JSON.stringify(raw), before)
  })

  test('resolves the petstore with nothing left unresolved', () => {
    const out = resolve(parse(readFileSync(join(PETSTORE, 'petstore.yaml'), 'utf8')))
    assert.deepEqual(out.unresolved, [])
    assert.deepEqual(out.cuts, [])
    const get = out.tree.paths['/pets'].get
    assert.equal(get.parameters[0].name, 'limit')
    assert.equal(get.responses.default.description, 'An unexpected error')
    assert.ok(!JSON.stringify(out.tree).includes('$ref'))
  })

  test('every site naming one target shares one result', () => {
    const out = resolve(
      parse(
        '{"openapi":"3.1.0","paths":{"/a":{"get":{"responses":{"200":{"$ref":"#/components/responses/Ok"}}}},' +
          '"/b":{"get":{"responses":{"200":{"$ref":"#/components/responses/Ok"}}}}},' +
          '"components":{"responses":{"Ok":{"description":"ok"}}}}',
      ),
    )
    const a = out.tree.paths['/a'].get.responses['200']
    const b = out.tree.paths['/b'].get.responses['200']
    assert.equal(a, b)
    assert.equal(a, out.tree.components.responses.Ok)
  })

  test('provenance records each site, with its position when the parse recorded them', () => {
    const tn = make()
    const positions = recordPositions(tn)
    const raw = parse(
      'openapi: 3.1.0\npaths:\n  /p:\n    get:\n      responses:\n        "200":\n          $ref: "#/components/responses/Ok"\n' +
        'components:\n  responses:\n    Ok:\n      description: ok\n',
      { instance: tn },
    )
    const out = resolve(raw, { positions })
    assert.equal(out.provenance.length, 1)
    const p = out.provenance[0]
    assert.deepEqual(
      { at: p.at, ref: p.ref, kind: p.kind, type: p.type, target: p.target, status: p.status },
      {
        at: '/paths/~1p/get/responses/200',
        ref: '#/components/responses/Ok',
        kind: 'reference',
        type: 'response',
        target: '/components/responses/Ok',
        status: 'resolved',
      },
    )
    assert.equal(p.row, 7)
  })

  test('counts the $ref maps it leaves as data, and reports $dynamicRef', () => {
    const out = resolve(
      parse(
        '{"openapi":"3.1.0","x-a":{"$ref":"#/b"},"components":{"schemas":{"S":{"example":{"$ref":"#/c"},' +
          '"properties":{"t":{"$dynamicRef":"#meta"}}}}}}',
      ),
    )
    assert.equal(out.dataSlots, 2)
    assert.deepEqual(
      out.connections.filter((c) => 'dynamicRef' === c.kind).map((c) => [c.at, c.found]),
      [['/components/schemas/S/properties/t', false]],
    )
  })

  test('reads the version from the root, or as asked', () => {
    const src =
      '{"openapi":"3.1.0","components":{"responses":{"A":{"$ref":"#/components/responses/B","description":"d"},' +
      '"B":{"description":"b"}}}}'
    assert.equal(resolve(parse(src)).tree.components.responses.A.description, 'd')
    assert.equal(resolve(parse(src), { version: '3.0' }).tree.components.responses.A.description, 'b')
    const unknown = resolve(parse('{"components":{"schemas":{"A":{"$ref":"#/components/schemas/B"},"B":{"type":"string"}}}}'))
    assert.equal(unknown.version, 'unknown')
    assert.deepEqual(C(unknown.tree.components.schemas.A), { type: 'string' })
  })

  test('a member named __proto__ resolves as data and pollutes nothing', () => {
    const out = resolve(
      parse(
        '{"openapi":"3.1.0","components":{"schemas":{"__proto__":{"polluted":true},' +
          '"S":{"$ref":"#/components/schemas/__proto__","description":"d"}}}}',
      ),
    )
    assert.deepEqual(C(out.tree.components.schemas.S), { allOf: [{ polluted: true }], description: 'd' })
    assert.equal(({} as any).polluted, undefined)
  })

  const TWO =
    '{"openapi":"3.1.0","paths":{"/a":{"get":{"responses":{"200":{"$ref":"#/components/responses/Ok"}}}},' +
    '"/b":{"get":{"responses":{"200":{"$ref":"#/components/responses/Ok"}}}}},' +
    '"components":{"responses":{"Ok":{"description":"ok","headers":{"X":{"schema":{"type":"string"}}}}}}}'
  const sites = (tree: any) => [tree.paths['/a'].get.responses['200'], tree.paths['/b'].get.responses['200']]

  test('site sharing gives each site its own shallow copy, its members shared', () => {
    const tree = resolve(parse(TWO), { sharing: 'site' }).tree
    const [a, b] = sites(tree)
    const ok = tree.components.responses.Ok
    assert.notEqual(a, b)
    assert.notEqual(a, ok)
    assert.equal(a.headers, ok.headers)
    assert.equal(b.headers, ok.headers)
  })

  test('copy shares nothing, and inline-once makes a tree', () => {
    for (const sharing of ['copy', 'inline-once'] as const) {
      const tree = resolve(parse(TWO), { sharing, budget: 1e6 }).tree
      const seen = new Set<object>()
      const walk = (v: any) => {
        if (null == v || 'object' !== typeof v) return
        assert.ok(!seen.has(v), sharing + ' shares a value')
        seen.add(v)
        for (const k of Object.keys(v)) walk(v[k])
      }
      walk(tree)
    }
  })

  test('a copy budget is the compact JSON length in UTF-8 bytes', () => {
    const src = '{"openapi":"3.1.0","info":{"title":"é ✓ 😀"},"components":{"schemas":{"A":{"$ref":"#/info"}}}}'
    const exact = Buffer.byteLength(JSON.stringify(resolve(parse(src)).tree))
    assert.doesNotThrow(() => resolve(parse(src), { sharing: 'copy', budget: exact }))
    assert.throws(() => resolve(parse(src), { sharing: 'copy', budget: exact - 1 }), (e: any) => 'openapi_budget' === e.code)
  })

  test('cycles keep makes a cyclic graph, and a loop of references is still cut', () => {
    const src =
      '{"openapi":"3.1.0","components":{"schemas":{"Node":{"type":"object","properties":{"next":{"$ref":"#/components/schemas/Node"}}},' +
      '"A":{"$ref":"#/components/schemas/B"},"B":{"$ref":"#/components/schemas/A"}}}}'
    const out = resolve(parse(src), { cycles: 'keep' })
    const node = out.tree.components.schemas.Node
    assert.equal(node.properties.next, node)
    assert.deepEqual(
      out.cuts.map((c) => c.at),
      ['/components/schemas/A', '/components/schemas/B'],
    )
    assert.deepEqual(C(out.tree.components.schemas.A), { $ref: '#/components/schemas/B' })
    const site = resolve(parse(src), { cycles: 'keep', sharing: 'site' }).tree.components.schemas.Node
    assert.notEqual(site.properties.next, site)
    assert.equal(site.properties.next.properties, site.properties)
  })

  test('compat apidef keeps cycles as apidef builds them, with x-ref on each site copy', () => {
    const src =
      '{"openapi":"3.0.0","components":{"schemas":{"Node":{"type":"object","properties":{"next":{"$ref":"#/components/schemas/Node"}}}}}}'
    const node = resolve(parse(src), { compat: 'apidef' }).tree.components.schemas.Node
    const next = node.properties.next
    assert.equal(next['x-ref'], '#/components/schemas/Node')
    assert.equal(next.properties, node.properties)
    assert.equal(node['x-ref'], undefined)
  })

  test('options outside their choices are refused', () => {
    assert.throws(() => resolve({}, { sharing: 'all' as any }), TypeError)
    assert.throws(() => resolve({}, { compat: 'nope' as any }), TypeError)
    assert.throws(() => resolve({}, { extensions: 'x-a' as any }), TypeError)
    assert.throws(() => resolve({}, { sharing: 'copy', budget: 10, cycles: 'keep' }), TypeError)
    assert.throws(() => resolve({}, { sharing: 'copy' }), (e: any) => 'openapi_budget' === e.code)
  })

  test('provenance lists every site in walk order, whatever became of it', () => {
    const out = resolve(
      parse(
        '{"openapi":"3.1.0","components":{"schemas":{"A":{"$ref":"#/components/schemas/B"},"B":{"$ref":"#/nope"},' +
          '"C":{"$ref":42},"D":{"$ref":"#/components/schemas/D/x"}}}}',
      ),
    )
    assert.deepEqual(
      out.provenance.map((p) => [p.at, p.status, p.target]),
      [
        ['/components/schemas/A', 'unresolved', '/components/schemas/B'],
        ['/components/schemas/B', 'unresolved', '/nope'],
        ['/components/schemas/C', 'unresolved', null],
        ['/components/schemas/D', 'cut', '/components/schemas/D/x'],
      ],
    )
  })

  test('strict raises a ResolveError with the code, the site and the reference', () => {
    let err: any
    try {
      resolve(parse('{"openapi":"3.1.0","components":{"schemas":{"S":{"$ref":"#/nope"}}}}'), { strict: true })
    } catch (e) {
      err = e
    }
    assert.ok(err instanceof ResolveError)
    assert.equal(err.code, 'openapi_unresolved')
    assert.equal(err.at, '/components/schemas/S')
    assert.equal(err.ref, '#/nope')
    assert.match(err.message, /not-found: the reference at "\/components\/schemas\/S" \("#\/nope"\)/)
  })
})
