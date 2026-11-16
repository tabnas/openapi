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

  // What test/resolve/apidef-extra.tsv cannot say: a fixture compares
  // without member order and through JSON, which a graph does not survive.
  // tools/apidef-preset.cjs holds the same shapes, and thousands more, to
  // apidef's own resolver.
  const S = '#/components/schemas/'
  const schemasOf = (schemas: Record<string, unknown>, options: object = { compat: 'apidef' }) => {
    const src = JSON.stringify({ openapi: '3.0.0', info: { title: 't', version: '1' }, paths: {}, components: { schemas } })
    return resolve(parse(src), options).tree.components.schemas
  }

  test('compat apidef orders a site\'s members as resolving in place leaves them', () => {
    // X names a site written before it, which has been resolved by then
    // and carries its own x-ref: the new x-ref takes that place.
    const before = schemasOf({ A: { $ref: S + 'C', description: 'a' }, C: { type: 'string' }, X: { $ref: S + 'A', title: 't' } })
    assert.equal(JSON.stringify(before.X), '{"type":"string","description":"a","x-ref":"#/components/schemas/A","title":"t"}')
    // X names a site written after it, which is read through to what it
    // names and carries no x-ref yet: the x-ref comes last.
    const after = schemasOf({ X: { $ref: S + 'A', title: 't' }, A: { $ref: S + 'C', description: 'a' }, C: { type: 'string' } })
    assert.equal(JSON.stringify(after.X), '{"type":"string","description":"a","title":"t","x-ref":"#/components/schemas/A"}')
    // The target's members come first, the site's own winning in place,
    // then the ones the target lacks; an x-ref the document wrote keeps its
    // place and takes the reference.
    const laid = schemasOf({
      T: { type: 'string', description: 'theirs', 'x-ref': 'written', z: 1 },
      A: { description: 'mine', $ref: S + 'T', a: 0 },
    })
    assert.equal(JSON.stringify(laid.A), '{"type":"string","description":"mine","x-ref":"#/components/schemas/T","z":1,"a":0}')
  })

  test('compat apidef resolves a reference that closes a cycle where it stands, whatever names it first', () => {
    // A is written first and names the reference q, which closes a cycle
    // through its own container.
    const raw = { A: { $ref: S + 'C/properties/q' }, C: { properties: { q: { $ref: S + 'C' } } } }
    const { A, C: c } = schemasOf(raw)
    const q = c.properties.q
    assert.equal(q['x-ref'], S + 'C')
    assert.equal(q.properties, c.properties)
    assert.equal(q.properties.q, q)
    assert.equal(A.properties, c.properties)
    assert.equal(A['x-ref'], S + 'C/properties/q')
    // The same with C written first.
    const turned = schemasOf({ C: raw.C, A: raw.A })
    assert.equal(turned.C.properties.q.properties.q, turned.C.properties.q)
    assert.equal(turned.A.properties, turned.C.properties)
  })

  test('cycles keep never changes the raw tree, and leaves no reference as written inside a cycle', () => {
    // X is written first and names a container inside P, which holds a
    // reference back to P.
    const src = JSON.stringify({
      openapi: '3.0.0',
      components: { schemas: { X: { $ref: S + 'P/properties/t' }, P: { properties: { t: { properties: { up: { $ref: S + 'P' } } } } } } },
    })
    for (const options of [{ cycles: 'keep' as const }, { compat: 'apidef' as const }]) {
      const raw = parse(src)
      const out = resolve(raw, options)
      assert.equal(JSON.stringify(raw), src)
      const { X, P } = out.tree.components.schemas
      const up = P.properties.t.properties.up
      assert.equal(up.$ref, undefined)
      assert.equal(up.properties, P.properties)
      assert.equal(X.properties.up, up)
      assert.deepEqual(out.unresolved, [])
      assert.deepEqual(out.cuts, [])
      assert.deepEqual(out.provenance.map((p) => p.status), ['resolved', 'resolved'])
    }
  })

  test('cycles cut: a reference that reaches its own container is left as the raw map (the fold\'s defect, W10)', () => {
    // This pins a defect of @tabnas/expr's fold, not a reading. A is
    // written first and names the reference q. The fold follows q to its
    // container C, which holds q, and q is still being folded: the fold
    // gives C the map as written for it. So q stays in the tree as the
    // raw map, though it is reported resolved and nothing is cut. With C
    // written first, q is cut and A with it, which is the right answer
    // for both orders. A repair in expr turns this test red: then make
    // both orders expect the second.
    const A = { $ref: S + 'C/properties/q' }
    const C_ = { properties: { q: { $ref: S + 'C' } } }
    const run = (schemas: object) => {
      const raw = parse(JSON.stringify({ openapi: '3.0.0', components: { schemas } }))
      return { raw, out: resolve(raw) }
    }
    const first = run({ A, C: C_ })
    assert.equal(first.out.tree.components.schemas.C.properties.q, first.raw.components.schemas.C.properties.q)
    assert.deepEqual(first.out.provenance.map((p) => p.status), ['resolved', 'resolved'])
    assert.deepEqual(first.out.cuts, [])

    const second = run({ C: C_, A })
    assert.deepEqual(second.out.cuts.map((c) => c.at.slice(S.length - 1)), ['C/properties/q', 'A'])
    assert.notEqual(second.out.tree.components.schemas.C.properties.q, second.raw.components.schemas.C.properties.q)
  })

  test('cycles keep reports a site inside members that its own site dropped', () => {
    // In 3.0 the members beside a schema's $ref are ignored, so the
    // reference inside them is in no value of the tree. It is a site all
    // the same, and is reported as what it is.
    const src = JSON.stringify({
      openapi: '3.0.0',
      components: { schemas: { P: { $ref: S + 'T', properties: { x: { $ref: S + 'Missing' } } }, T: { type: 'string' } } },
    })
    for (const cycles of ['cut', 'keep'] as const) {
      const out = resolve(parse(src), { cycles })
      assert.deepEqual(C(out.tree.components.schemas.P), { type: 'string' })
      assert.deepEqual(
        out.provenance.map((p) => [p.at.slice(S.length - 1), p.status]),
        [['P', 'resolved'], ['P/properties/x', 'unresolved']],
      )
      assert.deepEqual(out.unresolved.map((u) => u.why), ['not-found'])
    }
  })

  test('cycles keep starts every pointer at the root as written, a root that is a site included', () => {
    // Under slots all a $ref in the root makes the root a site. A pointer
    // is still read from the root's own map, as under cycles cut.
    const src = JSON.stringify({
      openapi: '3.0.0',
      paths: {},
      components: { schemas: { A: { $ref: S + 'B' }, B: { type: 'string' } } },
      $ref: S + 'Nope',
    })
    for (const cycles of ['cut', 'keep'] as const) {
      const out = resolve(parse(src), { slots: 'all', cycles })
      assert.deepEqual(C(out.tree.components.schemas.A), { type: 'string' })
      assert.deepEqual(out.unresolved.map((u) => [u.at, u.why]), [['', 'not-found']])
      assert.deepEqual(out.cuts, [])
    }
    // And a root that names something inside itself holds it.
    const named = src.replace('Nope', 'B')
    for (const cycles of ['cut', 'keep'] as const) {
      const out = resolve(parse(named), { slots: 'all', cycles })
      assert.deepEqual(C(out.tree), { type: 'string' })
      assert.deepEqual(out.provenance.map((p) => p.status), ['resolved', 'resolved'])
    }
  })

  test('cycles keep reads on past a cut reference only to say that nothing is there', () => {
    // A and B name each other. The first pointer goes through A to a
    // member A has as written, and is cut with it. The second goes
    // through A to nothing.
    const src = JSON.stringify({
      openapi: '3.0.0',
      components: {
        schemas: {
          A: { $ref: S + 'B', properties: { x: { type: 'integer' } } },
          B: { $ref: S + 'A' },
          there: { $ref: S + 'A/properties/x' },
          gone: { $ref: S + 'A/properties/y' },
        },
      },
    })
    const out = resolve(parse(src), { cycles: 'keep' })
    assert.deepEqual(out.cuts.map((c) => c.at.slice(S.length - 1)), ['A', 'B', 'there'])
    assert.deepEqual(out.unresolved.map((u) => [u.at.slice(S.length - 1), u.why]), [['gone', 'not-found']])
  })

  test('cycles keep lists its reports in document order', () => {
    // Under 'cut' a target is entered at its first reference, so B comes
    // before the site written between A and it. Under 'keep' no target is
    // entered early.
    const src = JSON.stringify({
      openapi: '3.0.0',
      components: { schemas: { A: { $ref: S + 'B' }, M: { $ref: S + 'Nope' }, B: { $ref: S + 'Gone' } } },
    })
    const at = (options: object) => resolve(parse(src), options).unresolved.map((u) => u.at.slice(S.length - 1))
    assert.deepEqual(at({}), ['A', 'B', 'M'])
    assert.deepEqual(at({ cycles: 'keep' }), ['A', 'M', 'B'])
  })

  test('cycles keep follows a chain of references as deep as maxDepth allows', () => {
    const chain = (n: number) => {
      const schemas: Record<string, unknown> = { ['k' + n]: { type: 'string' } }
      for (let i = 0; i < n; i++) schemas['k' + i] = { $ref: S + 'k' + (i + 1) }
      return JSON.stringify({ openapi: '3.0.0', components: { schemas } })
    }
    const out = resolve(parse(chain(300)), { cycles: 'keep' })
    assert.deepEqual(C(out.tree.components.schemas.k0), { type: 'string' })
    assert.throws(
      () => resolve(parse(chain(300)), { cycles: 'keep', maxDepth: 100 }),
      (e: any) => 'FoldError' === e.name && 'fold_depth' === e.code && '/components/schemas/k100' === e.at,
    )
  })

  test('refs pointer reads a reference as a pointer into the document and nothing else', () => {
    const schemas = {
      T: { $anchor: 'tee', type: 'string' },
      byAnchor: { $ref: '#tee' },
      byPointer: { $ref: S + 'T' },
      encoded: { $ref: S + 'a%20b' },
      'a b': { type: 'number' },
    }
    const src = JSON.stringify({ openapi: '3.1.0', components: { schemas } })
    const uri = resolve(parse(src))
    assert.deepEqual(C(uri.tree.components.schemas.byAnchor), { $anchor: 'tee', type: 'string' })
    assert.deepEqual(C(uri.tree.components.schemas.encoded), { type: 'number' })
    const pointer = resolve(parse(src), { refs: 'pointer' })
    assert.deepEqual(C(pointer.tree.components.schemas.byPointer), { $anchor: 'tee', type: 'string' })
    assert.deepEqual(
      pointer.unresolved.map((u) => [u.at.slice(S.length - 1), u.why]),
      [['byAnchor', 'bad-fragment'], ['encoded', 'not-found']],
    )
    assert.throws(() => resolve(parse(src), { refs: 'fragment' as any }), TypeError)
  })

  test('refs pointer ends a walk at a reference left as written, where refs uri reads on', () => {
    const src = JSON.stringify({
      openapi: '3.0.0',
      components: {
        schemas: {
          // M names another document, and has a member of its own.
          M: { $ref: 'other.yaml#/M', properties: { x: { type: 'integer' } } },
          viaM: { $ref: S + 'M/properties/x' },
          // A and B name each other, and A has a member of its own.
          A: { $ref: S + 'B', properties: { x: { type: 'integer' } } },
          B: { $ref: S + 'A' },
          viaA: { $ref: S + 'A/properties/x' },
        },
      },
    })
    const short = (rows: { at: string }[]) => rows.map((r) => r.at.slice(S.length - 1))
    for (const cycles of ['cut', 'keep'] as const) {
      // A reference left as written for a reason is read through as
      // written under 'uri', and ends the walk under 'pointer'.
      const uri = resolve(parse(src), { cycles })
      assert.deepEqual(C(uri.tree.components.schemas.viaM), { type: 'integer' })
      assert.deepEqual(uri.unresolved.map((u) => [u.at.slice(S.length - 1), u.why]), [['M', 'external']])
      const pointer = resolve(parse(src), { refs: 'pointer', cycles })
      assert.deepEqual(C(pointer.tree.components.schemas.viaM), { $ref: S + 'M/properties/x' })
      assert.deepEqual(
        pointer.unresolved.map((u) => [u.at.slice(S.length - 1), u.why]),
        [['M', 'external'], ['viaM', 'not-found']],
      )
      // A walk through a reference that was cut is cut with it, under both.
      for (const out of [uri, pointer]) {
        assert.deepEqual(short(out.cuts), ['A', 'B', 'viaA'])
        assert.deepEqual(C(out.tree.components.schemas.viaA), { $ref: S + 'A/properties/x' })
      }
    }
  })

  test('refs pointer ends a walk at a reference reached through another reference\'s value', () => {
    // viaA goes through A, which resolves to E, to the member p of E,
    // which names another document, and on to a member p has as written.
    const src = JSON.stringify({
      openapi: '3.0.0',
      components: {
        schemas: {
          A: { $ref: S + 'E' },
          E: { properties: { p: { $ref: 'other.yaml#/x', properties: { z: { type: 'integer' } } } } },
          viaA: { $ref: S + 'A/properties/p/properties/z' },
        },
      },
    })
    for (const cycles of ['cut', 'keep'] as const) {
      const uri = resolve(parse(src), { cycles })
      assert.deepEqual(C(uri.tree.components.schemas.viaA), { type: 'integer' })
      const pointer = resolve(parse(src), { refs: 'pointer', cycles })
      assert.deepEqual(C(pointer.tree.components.schemas.viaA), { $ref: S + 'A/properties/p/properties/z' })
      assert.deepEqual(
        pointer.unresolved.map((u) => [u.at.slice(S.length - 1), u.why]),
        [['E/properties/p', 'external'], ['viaA', 'not-found']],
      )
    }
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
