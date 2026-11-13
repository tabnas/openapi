/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// The apidef gate's own code, on small inline values.
//
// tools/apidef-gate.cjs runs voxgig/apidef's suite on this checkout's
// build and compares apidef's output with apidef as it was. It needs a
// clone of apidef, so it is run by hand and not here. What is run here is
// the code that decides: which of apidef's test files are descriptions,
// and whether two outputs differ. If that code stopped seeing a
// difference, the gate would report a regression as identical.
//
// The tool is plain JavaScript, loaded with require so that it stays
// outside the compilation, as the port-deps test loads its tool.

import { after, describe, test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

type Difference = { at: string; candidate?: string; base?: string } | null
type Compared = {
  label: string
  bytes: { candidate: number; base: number }
  byteIdentical: boolean
  outputIdentical: boolean
  first?: Difference
  offset?: number
  errors?: { candidate: string | null; base: string | null }
  ok?: { candidate: boolean | null; base: boolean | null }
}
type Options = {
  apidef: string | null
  patch: string | null
  ref: string | null
  base: string | null
  extra: string[]
  allowFailures: number
  jobs: number
  timeout: number
  build: boolean
  keep: boolean
}
type Gate = {
  readArgs(argv: string[]): Options
  isDescription(file: string): boolean
  core(value: unknown): unknown
  firstDifference(a: unknown, b: unknown): Difference
  compareOne(item: { label: string }, candidate: string, base: string): Compared
}

// At runtime this file is in ts/dist-test, so the repository root is two up.
const G: Gate = require(join(__dirname, '..', '..', 'tools', 'apidef-gate.cjs'))

// One run of apidef on one definition, as tools/apidef-gate/model.cjs writes it.
function output(change: (out: any) => void = () => {}): string {
  const out = {
    ok: true,
    steps: ['parse', 'guide', 'transformers', 'builders'],
    guide: {
      entity: { pet: { path: { '/pets/{id}': { op: { load: { method: 'get' } } } } } },
      def$: { paths: { '/pets/{id}': { get: { operationId: 'getPet' } } } },
    },
    apimodel: { main: { kit: { entity: { pet: { fields: [{ name: 'id', type: '`$STRING`' }] } } } } },
  }
  change(out)
  return JSON.stringify(out)
}

const item = { label: 'inline' }

describe('apidef gate: which files are descriptions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'apidef-gate-'))
  const file = (name: string, text: string): string => {
    const path = join(dir, name)
    writeFileSync(path, text)
    return path
  }
  after(() => rmSync(dir, { recursive: true, force: true }))

  test('JSON is a description by its root\'s version member', () => {
    assert.strictEqual(G.isDescription(file('a.json', '{"openapi":"3.0.3","paths":{}}')), true)
    assert.strictEqual(G.isDescription(file('b.json', '{"swagger":"2.0"}')), true)
    assert.strictEqual(G.isDescription(file('c.json', '{"graphql":{},"info":{"openapi":"3.0.3"}}')), false)
    assert.strictEqual(G.isDescription(file('d.json', '["openapi"]')), false)
    assert.strictEqual(G.isDescription(file('e.json', '{"openapi":')), false)
  })

  test('YAML is a description by a version member at the start of a line', () => {
    assert.strictEqual(G.isDescription(file('a.yaml', 'openapi: 3.0.0\ninfo:\n  title: t\n')), true)
    assert.strictEqual(G.isDescription(file('b.yml', 'info:\n  title: t\n"swagger": "2.0"\n')), true)
    assert.strictEqual(G.isDescription(file('c.yaml', 'info:\n  openapi: 3.0.0\n')), false)
    assert.strictEqual(G.isDescription(file('d.yaml', 'title: the openapi: of things\n')), false)
  })

  test('any other file is not', () => {
    assert.strictEqual(G.isDescription(file('a.graphql', 'openapi: 3.0.0\n')), false)
  })
})

describe('apidef gate: comparing two outputs', () => {
  test('the same text is identical', () => {
    const c = G.compareOne(item, output(), output())
    assert.strictEqual(c.byteIdentical, true)
    assert.strictEqual(c.outputIdentical, true)
    assert.strictEqual(c.first, undefined)
    assert.deepStrictEqual(c.ok, { candidate: true, base: true })
  })

  test('a difference in the model is a difference in apidef\'s output, named by its pointer', () => {
    const c = G.compareOne(item, output((o) => { o.apimodel.main.kit.entity.pet.fields[0].type = '`$NUMBER`' }), output())
    assert.strictEqual(c.byteIdentical, false)
    assert.strictEqual(c.outputIdentical, false)
    assert.deepStrictEqual(c.first, {
      at: '/apimodel/main/kit/entity/pet/fields/0/type',
      candidate: '"`$NUMBER`"',
      base: '"`$STRING`"',
    })
  })

  test('a difference in the guide is one too, with its pointer escaped', () => {
    const c = G.compareOne(item, output((o) => { o.guide.entity.pet.path['/pets/{id}'].op.load.method = 'post' }), output())
    assert.strictEqual(c.outputIdentical, false)
    assert.strictEqual(c.first?.at, '/guide/entity/pet/path/~1pets~1{id}/op/load/method')
  })

  test('a member only one side has is a difference', () => {
    const c = G.compareOne(item, output((o) => { delete o.apimodel.main.kit.entity.pet.fields }), output())
    assert.strictEqual(c.outputIdentical, false)
    assert.strictEqual(c.first?.at, '/apimodel/main/kit/entity/pet/fields')
    assert.strictEqual(c.first?.candidate, '(absent)')
  })

  test('the guide\'s copies of the input, under keys ending in $, are told apart from output', () => {
    const c = G.compareOne(item, output((o) => { o.guide.def$.paths['/pets/{id}'].get.operationId = 'loadPet' }), output())
    assert.strictEqual(c.byteIdentical, false)
    assert.strictEqual(c.outputIdentical, true)
    assert.strictEqual(c.first?.at, '/guide/def$/paths/~1pets~1{id}/get/operationId')
    assert.ok('number' === typeof c.offset && 0 < c.offset)
  })

  test('a run that fell short, or stopped at another step, is a difference', () => {
    assert.strictEqual(G.compareOne(item, output((o) => { o.ok = false }), output()).outputIdentical, false)
    assert.strictEqual(G.compareOne(item, output((o) => { o.steps.pop() }), output()).outputIdentical, false)
  })

  test('two runs that fail the same way compare as identical, and say that they failed', () => {
    const failed = JSON.stringify({ error: 'no servers' })
    const c = G.compareOne(item, failed, failed)
    assert.strictEqual(c.byteIdentical, true)
    assert.deepStrictEqual(c.errors, { candidate: 'no servers', base: 'no servers' })
    const one = G.compareOne(item, failed, output())
    assert.strictEqual(one.outputIdentical, false)
    assert.deepStrictEqual(one.errors, { candidate: 'no servers', base: null })
  })

  test('output that is not JSON is a difference', () => {
    const c = G.compareOne(item, '{"ok":', output())
    assert.strictEqual(c.outputIdentical, false)
    assert.strictEqual(c.first?.at, '(not JSON)')
  })

  test('sizes are in bytes', () => {
    const c = G.compareOne(item, JSON.stringify({ ok: true, guide: { name: 'é' } }), JSON.stringify({ ok: true, guide: { name: 'e' } }))
    assert.strictEqual(c.bytes.candidate, c.bytes.base + 1)
  })
})

describe('apidef gate: the pieces of the comparison', () => {
  test('core leaves out every key ending in $, at any depth, and nothing else', () => {
    assert.deepStrictEqual(
      G.core({ a: 1, b$: 2, c: [{ d$: 3, e: 4, $f: 5 }], g: { h$: { i: 6 } } }),
      { a: 1, c: [{ e: 4, $f: 5 }], g: {} },
    )
  })

  test('the first difference is null for equal values, in any type', () => {
    assert.strictEqual(G.firstDifference({ a: [1, { b: null }] }, { a: [1, { b: null }] }), null)
    assert.strictEqual(G.firstDifference('x', 'x'), null)
  })

  test('the first difference sees a type, a length and an order of members', () => {
    assert.strictEqual(G.firstDifference({ a: [1] }, { a: { 0: 1 } })?.at, '/a')
    assert.strictEqual(G.firstDifference({ a: [1, 2] }, { a: [1] })?.at, '/a/1')
    assert.strictEqual(G.firstDifference({ a: null }, { a: {} })?.at, '/a')
    const order = G.firstDifference({ m: { a: 1, b: 2 } }, { m: { b: 2, a: 1 } })
    assert.deepStrictEqual(order, { at: '/m', candidate: 'keys a,b', base: 'keys b,a' })
  })
})

describe('apidef gate: its arguments', () => {
  test('the run this repository documents reads as written', () => {
    const o = G.readArgs([
      '../apidef', '--patch', 'docs/x.diff', '--allow-failures', '1',
      '--extra', 'a.json', 'b.yaml', '--no-build', '--jobs', '2', '--timeout', '60',
    ])
    assert.strictEqual(o.apidef, resolve('../apidef'))
    assert.strictEqual(o.patch, resolve('docs/x.diff'))
    assert.strictEqual(o.allowFailures, 1)
    assert.deepStrictEqual(o.extra, [resolve('a.json'), resolve('b.yaml')])
    assert.strictEqual(o.build, false)
    assert.strictEqual(o.jobs, 2)
    assert.strictEqual(o.timeout, 60)
  })

  test('nothing is allowed to fail, and this checkout is built, unless the run says so', () => {
    const o = G.readArgs(['../apidef'])
    assert.strictEqual(o.allowFailures, 0)
    assert.strictEqual(o.build, true)
    assert.strictEqual(o.patch, null)
    assert.deepStrictEqual(o.extra, [])
    assert.strictEqual(o.keep, false)
  })
})
