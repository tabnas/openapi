/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// The preset comparison's own code, on small inline documents.
//
// tools/apidef-preset.cjs holds `resolve(raw, { compat: 'apidef' })` to
// the resolver inside voxgig/apidef, document by document. It needs a
// clone of apidef, so it is run by hand and not here. What is run here is
// the code that decides: whether two resolved graphs are equal, what kind
// of difference one is, what counts as compared, and what the run comes
// to. If that code stopped seeing a difference, the comparison would
// report a preset that had drifted as exact.
//
// apidef's resolver is stood in for by this package's own, written back
// into the tree in place as apidef's is, and then changed in one way at a
// time. The tool is plain JavaScript, loaded with require so that it stays
// outside the compilation, as the port-deps test loads its tool.

import { after, describe, test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as O from '../dist/openapi'

// At runtime this file is in ts/dist-test, so the repository root is two up.
const TOOLS = join(__dirname, '..', '..', 'tools')
const P: any = require(join(TOOLS, 'apidef-preset.cjs'))
const G: any = require(join(TOOLS, 'apidef-preset', 'graph.cjs'))
const { compareText }: any = require(join(TOOLS, 'apidef-preset', 'compare.cjs'))
const { CLASSES }: any = require(join(TOOLS, 'apidef-preset', 'classify.cjs'))
const { loadShapes }: any = require(join(TOOLS, 'apidef-preset', 'shapes.cjs'))

P.quiet()

const S = '#/components/schemas/'
const doc = (schemas: Record<string, unknown>) =>
  JSON.stringify({ openapi: '3.0.0', info: { title: 't', version: '1' }, paths: {}, components: { schemas } })

// A resolver that rewrites a tree in place, as apidef's does: the tree
// becomes what the preset gives, after `change` has had its way with it.
const standIn = (change: (tree: any) => void = () => {}) => ({
  addXRefsAndResolve: (tree: any) => {
    const out = O.resolve(tree, { compat: 'apidef' }).tree
    change(out)
    for (const k of Object.keys(tree)) delete tree[k]
    for (const k of Object.keys(out)) tree[k] = out[k]
  },
  resolvePointer: () => undefined,
})

// A reference with a member of its own, to a schema with a nested map.
const TEXT = doc({
  T: { type: 'object', properties: { p: { type: 'string' } } },
  A: { $ref: S + 'T', description: 'mine' },
})

describe('apidef-preset', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'apidef-preset-test-'))
  after(() => rmSync(tmp, { recursive: true, force: true }))

  test('two graphs are equal only with the same members, order, values and sharing', () => {
    const make = () => {
      const shared = { type: 'string' }
      const root: any = { a: { p: shared }, b: { p: shared }, list: [1, 'x', null] }
      root.loop = root
      return root
    }
    assert.equal(G.graphDiff(make(), make()), null)

    const value = make()
    value.list[1] = 'y'
    assert.deepEqual([G.graphDiff(make(), value).what, G.graphDiff(make(), value).path], ['value', '/list/1'])

    const order = make()
    const { a, ...rest } = order
    const reordered: any = { ...rest, a }
    reordered.loop = reordered
    assert.notEqual(G.graphDiff(make(), reordered), null)

    // The same content, with one object where the other has two.
    const split = make()
    split.b.p = { type: 'string' }
    assert.equal(G.graphDiff(make(), split).what, 'sharing')
    assert.equal(new G.Bisim().equal(make(), split), true)

    // A cycle closed one level further down.
    const deeper = make()
    deeper.loop = { ...deeper }
    assert.notEqual(G.graphDiff(make(), deeper), null)
  })

  test('a document is equal, or differs in content, in member order or in sharing', () => {
    assert.equal(compareText(TEXT, { A: standIn(), O }).verdict, 'equal')

    const content = compareText(TEXT, { A: standIn((t) => { t.components.schemas.A.description = 'theirs' }), O })
    assert.equal(content.verdict, 'content')
    assert.deepEqual(content.differing.map((d: any) => d.at), ['/components/schemas/A'])
    assert.ok(0 < content.classes.length)

    const order = compareText(TEXT, {
      A: standIn((t) => {
        const site = t.components.schemas.A
        const { 'x-ref': xref, ...rest } = site
        for (const k of Object.keys(site)) delete site[k]
        Object.assign(site, { 'x-ref': xref, ...rest })
      }),
      O,
    })
    assert.equal(order.verdict, 'order')
    assert.equal(order.differing[0].reordered, true)

    const sharing = compareText(TEXT, {
      A: standIn((t) => { t.components.schemas.A.properties = { p: { type: 'string' } } }),
      O,
    })
    assert.equal(sharing.verdict, 'sharing')
  })

  test('an option beside the preset is given to resolve', () => {
    const text = doc({ T: { $anchor: 'tee', type: 'string' }, A: { $ref: '#tee' } }).replace('3.0.0', '3.1.0')
    assert.equal(compareText(text, { A: standIn(), O }).verdict, 'equal')
    const uri = compareText(text, { A: standIn(), O, options: { refs: 'uri' } })
    assert.equal(uri.verdict, 'content')
    assert.deepEqual(uri.classes, ['anchor'])
  })

  test('a text parse refuses, and a resolver that throws, are told apart from a difference', () => {
    const refused = compareText('[1, 2', { A: standIn(), O })
    assert.equal(refused.failed.stage, 'parse')
    const threw = compareText(TEXT, { A: { ...standIn(), addXRefsAndResolve: () => { throw new Error('no') } }, O })
    assert.equal(threw.failed.stage, 'apidef')
    assert.equal(threw.verdict, undefined)
  })

  test('a run passes only when something was compared and nothing differs or fails', () => {
    const t = P.newTally('set')
    assert.equal(P.verdict([]).exit, 1)
    assert.deepEqual(P.verdict([t]), { exit: 1, why: ['set: nothing was compared'] })

    // A text that parse refuses reached neither resolver.
    P.count(t, { name: 'refused' }, { failed: { stage: 'parse', error: 'unexpected: no' } })
    assert.deepEqual([t.total, t.unread.length, t.failed.length, P.differing(t)], [1, 1, 0, 0])
    assert.deepEqual(P.verdict([t]), { exit: 1, why: ['set: nothing was compared'] })

    P.count(t, { name: 'same' }, { verdict: 'equal' })
    assert.deepEqual(P.verdict([t]), { exit: 0, why: [] })

    P.count(t, { name: 'other', text: '{}' }, { verdict: 'order', classes: ['xref-position'], bytes: 2 })
    assert.equal(P.differing(t), 1)
    assert.deepEqual([t.verdicts.order, t.classes['xref-position'], t.smallest['xref-position'].name], [1, 1, 'other'])
    assert.deepEqual(P.verdict([t]), { exit: 1, why: ['set: 1 differ'] })

    const slow = P.newTally('corpus')
    P.count(slow, { name: 'same' }, { verdict: 'equal' })
    P.count(slow, { name: 'big' }, { failed: { stage: 'timeout', error: 'more than 300s' } })
    assert.deepEqual(P.verdict([slow]), { exit: 1, why: ['corpus: 1 failed'] })
    assert.equal(P.verdict([slow, P.newTally('empty')]).why.length, 2)
  })

  test('a list of documents is run through both resolvers and counted', () => {
    const items = [
      { name: 'same', text: TEXT },
      { name: 'refused', text: '[1, 2' },
      { name: 'again', text: doc({ A: { type: 'string' } }) },
    ]
    const same = P.runList('hand', items, items.length, { A: standIn(), O })
    assert.deepEqual([same.total, same.equal, same.unread.length, same.failed.length], [3, 2, 1, 0])
    assert.equal(P.verdict([same]).exit, 0)

    const drifted = P.runList('hand', items, items.length, {
      A: standIn((t) => { if (t.components.schemas.A.description) t.components.schemas.A.description = 'theirs' }),
      O,
    })
    assert.deepEqual([drifted.equal, P.differing(drifted)], [1, 1])
    assert.equal(P.verdict([drifted]).exit, 1)
  })

  test('a fixture row under the preset alone is held to the other resolver', () => {
    const header = ['input', 'expected', 'unresolved', 'cuts', 'opts', 'select'].join('\t')
    const input = doc({ T: { type: 'string' }, A: { $ref: S + 'T' } })
    const row = (expected: string, opts: string) => [input, expected, '[]', '[]', opts, '["components","schemas","A"]'].join('\t')
    const right = '{"x-ref":"#/components/schemas/T","type":"string"}'
    const file = join(tmp, 'rows.tsv')
    writeFileSync(file, [
      header,
      '# Member order is not compared.',
      row(right, '{"compat":"apidef"}'),
      row('{"type":"number","x-ref":"#/components/schemas/T"}', '{"compat":"apidef"}'),
      row('{"type":"string"}', '{"compat":"apidef","xref":false}'),
      row('{"type":"string"}', ''),
    ].join('\n') + '\n')

    const t = P.runRows(file, { A: standIn(), O })
    assert.deepEqual([t.total, t.equal, t.failed.length, t.skipped.length], [2, 1, 1, 2])
    assert.equal(t.failed[0].stage, 'row')
    assert.match(t.failed[0].name, /^rows\.tsv:4$/)
    assert.equal(P.verdict([t]).exit, 1)

    const none = join(tmp, 'none.tsv')
    writeFileSync(none, [header, row('{"type":"string"}', '')].join('\n') + '\n')
    // A file with no row under the preset alone compares nothing.
    const empty = P.verdict([P.runRows(none, { A: standIn(), O })])
    assert.equal(empty.exit, 1)
    assert.match(empty.why[0], /nothing was compared$/)
  })

  test('the arguments are read as the tool documents them', () => {
    const o = P.readArgs(['/x/apidef'])
    assert.deepEqual([o.sets, o.seed, o.count, o.options, o.rows], [['hand', 'generated'], 1, 6000, {}, []])
    assert.deepEqual([o.minBytes, o.maxBytes], [0, 10e6])
    const all = P.readArgs([
      '/x/apidef', '--corpus', '/x/src', '--rows', '/x/a.tsv', '/x/b.tsv', '--options', '{"refs":"uri"}', '--seed', '7',
    ])
    assert.deepEqual(all.sets, ['hand', 'generated', 'corpus', 'rows'])
    assert.deepEqual([all.rows, all.options, all.seed], [['/x/a.tsv', '/x/b.tsv'], { refs: 'uri' }, 7])
  })

  test('the hand shapes and the classes are well formed', () => {
    const shapes = loadShapes()
    assert.ok(100 < shapes.length)
    assert.equal(new Set(shapes.map((s: any) => s.name)).size, shapes.length)
    for (const s of shapes) assert.equal(typeof s.text, 'string', s.name)

    assert.equal(new Set(CLASSES.map((c: any) => c.id)).size, CLASSES.length)
    for (const c of CLASSES) {
      for (const field of ['title', 'apidef', 'lines', 'other', 'where']) assert.equal(typeof c[field], 'string', c.id + ' ' + field)
      assert.ok(['content', 'order', 'sharing'].includes(c.kind), c.id)
      assert.equal(typeof c.test, 'function', c.id)
    }
  })

  test('the preset shows no class on the hand shapes that this package reads', () => {
    // Against the stand-in this is the preset against itself, so it holds
    // the comparison to finding nothing where there is nothing, on every
    // shape a difference was once found in.
    const shapes = loadShapes()
    const t = P.runList('hand', shapes, shapes.length, { A: standIn(), O })
    assert.deepEqual([P.differing(t), t.failed.length], [0, 0])
    assert.ok(t.unread.length < shapes.length / 10)
  })
})
